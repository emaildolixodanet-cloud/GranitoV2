// ======================= IMPORTS E SETUP ===========================
import puppeteer from "puppeteer";
import { buildDiscordMessageForItem } from "./discordFormat.js";

const fetchHttp = (typeof fetch !== "undefined")
  ? fetch
  : (await import("node-fetch")).default;

// ======================= CONFIG ===========================
const PROFILES = (process.env.VINTED_PROFILE_URLS || "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

const HOURS = parseInt(process.env.ONLY_NEWER_HOURS || "24", 10);
const MAX_ITEMS_PER_PROFILE = parseInt(process.env.MAX_ITEMS_PER_PROFILE || "20", 10);
const MAX_NEW_PER_PROFILE = parseInt(process.env.MAX_NEW_PER_PROFILE || "3", 10);
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

// ======================= FUNÇÕES DE SUPORTE ===========================
function log(...args) {
  console.log(...args);
}

function short(txt, max = 120) {
  if (!txt) return "";
  const clean = txt.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "..." : clean;
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000);
}

// ======================= DISCORD PAYLOADS ===========================

// ---- Layout antigo (PerfeitoV1) ----
function buildLegacyPayload(item) {
  return {
    embeds: [
      {
        title: item.title || "Novo artigo",
        url: item.url,
        description: short(item.description, 250),
        fields: [
          item.price ? { name: "💰 Preço", value: `${item.price} ${item.currency || "€"}`, inline: true } : null,
          item.size ? { name: "📐 Tamanho", value: item.size, inline: true } : null,
          item.brand ? { name: "🏷️ Marca", value: item.brand, inline: true } : null,
        ].filter(Boolean),
        image: item.photos?.[0] ? { url: item.photos[0] } : undefined,
        footer: { text: "Vinted Bot - Layout V1" },
      },
    ],
  };
}

// ---- Novo layout híbrido ----
async function postToDiscord(item) {
  if (!WEBHOOK) throw new Error("DISCORD_WEBHOOK_URL não configurado");

  const style = (process.env.WEBHOOK_STYLE || "hybrid").toLowerCase();
  const payload = style === "v1"
    ? buildLegacyPayload(item)
    : buildDiscordMessageForItem(item);

  await fetchHttp(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ======================= SCRAPER ===========================
async function scrapeProfile(browser, url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("body", { timeout: 30000 }).catch(() => null);

  const items = await page.$$eval("a[href*='/items/']", (links) =>
    links.map((a) => a.href)
  );

  const uniqueItems = [...new Set(items)].slice(0, MAX_ITEMS_PER_PROFILE);

  const scraped = [];
  for (const link of uniqueItems) {
    try {
      const itemPage = await browser.newPage();
      await itemPage.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 });

      const data = await itemPage.evaluate(() => {
        const get = (sel) => document.querySelector(sel)?.innerText?.trim() || "";
        const title = get("h1") || document.title;
        const description = get("p") || "";
        const price = document.querySelector("[data-testid='item-price']")?.innerText || "";
        const imgs = Array.from(document.querySelectorAll("img"))
          .map((i) => i.src)
          .filter((src) => src.includes("https"));
        return {
          title,
          url: window.location.href,
          description,
          price,
          photos: imgs.slice(0, 4),
        };
      });

      scraped.push(data);
      await itemPage.close();
    } catch (e) {
      log("Erro ao extrair item:", e.message);
    }
  }

  await page.close();
  return scraped;
}

// ======================= RUN PRINCIPAL ===========================
async function run() {
  if (!PROFILES.length) {
    console.error("Nenhum perfil configurado!");
    return;
  }

  log(`🔎 A verificar ${PROFILES.length} perfis (últimas ${HOURS}h) ...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let totalEncontrados = 0;
  let totalPublicados = 0;

  for (const profile of PROFILES) {
    log(`→ Perfil: ${profile}`);
    try {
      const items = await scrapeProfile(browser, profile);
      totalEncontrados += items.length;

      const novos = items.slice(0, MAX_NEW_PER_PROFILE);
      for (const item of novos) {
        await postToDiscord(item);
        totalPublicados++;
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err) {
      log("Erro geral:", err.message);
    }
  }

  await browser.close();
  log(`📦 Resumo: encontrados=${totalEncontrados}, publicados=${totalPublicados}`);
}

// ======================= TESTE MANUAL FORÇADO ===========================
(async () => {
  const TEST_MODE = true; // força sempre o modo de teste

  if (TEST_MODE) {
    const itemTeste = {
      title: "Camisola Branca Mulher Ralph Lauren Tamanho XL",
      url: "https://www.vinted.pt/items/123456789-camisola-ralph-lauren-xl",
      description:
        "Camisola Polo Ralph Lauren em malha branca, padrão entrançado e logo bordado azul-marinho no peito. Tecido de alta qualidade — ideal para um look casual elegante.",
      price: "40.00",
      currency: "EUR",
      size: "XL / 42 / 14",
      brand: "Ralph Lauren",
      condition: "Muito bom",
      photos: [
        "https://images.vinted.net/thumbs/f800x800/01_0021b_Vinted_Item1.jpg",
        "https://images.vinted.net/thumbs/f800x800/02_0021b_Vinted_Item2.jpg",
        "https://images.vinted.net/thumbs/f800x800/03_0021b_Vinted_Item3.jpg",
      ],
      sellerName: "medp1",
      sellerUrl: "https://www.vinted.pt/member/medp1",
      sellerAvatar: "https://cdn-icons-png.flaticon.com/512/194/194938.png",
      createdAt: new Date().toISOString(),
    };

    console.log("🧪 TESTE FORÇADO: a publicar item de demonstração no Discord...");
    await postToDiscord(itemTeste);
    console.log("✅ Teste enviado para o Discord com sucesso!");
    process.exit(0);
  } else {
    await run().catch((err) => {
      console.error("Erro fatal:", err);
      process.exit(1);
    });
  }
})();
