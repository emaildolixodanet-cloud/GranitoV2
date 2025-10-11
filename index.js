// ======================= IMPORTS E SETUP ===========================
import puppeteer from "puppeteer";
import { buildDiscordMessageForItem } from "./discordFormat.js";

// fetch: Node 20 já tem fetch global, mas garantimos fallback
const fetchHttp = (typeof fetch !== "undefined")
  ? fetch
  : (await import("node-fetch")).default;

// ======================= CONFIG ===========================
const PROFILES = (process.env.VINTED_PROFILE_URLS || "")
  .split(",")
  .map(u => u.trim())
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

  // Espera o carregamento
  await page.waitForSelector("body", { timeout: 30000 }).catch(() => null);

  // Recolhe links dos artigos
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
        const price = get("data-testid='item-price'") || "";
        const imgs = Array.from(document.querySelectorAll("img"))
          .map((i) => i.src)
          .filter((src) => src.includes("https"));
        return {
          title,
          url: location.href,
          description,
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

// ======================= RUN ===========================
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

run().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
