// ======================= IMPORTS E SETUP ===========================
import puppeteer from "puppeteer";
import { buildDiscordMessageForItem } from "./discordFormat.js";

// fetch: Node 20 tem fetch global; fallback para node-fetch se necessário
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
// se a var vier vazia, cai por defeito em 3
const MAX_NEW_PER_PROFILE = Number(process.env.MAX_NEW_PER_PROFILE || 3);
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const TEST_MODE = (process.env.TEST_MODE || "false").toLowerCase() === "true";

// ======================= HELPERS ===========================
function log(...args) { console.log(...args); }

function short(txt, max = 120) {
  if (!txt) return "";
  const clean = txt.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "..." : clean;
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 3600 * 1000);
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// ======================= DISCORD ===========================
async function postToDiscord(item) {
  if (!WEBHOOK) throw new Error("DISCORD_WEBHOOK_URL não configurado");

  const payload = buildDiscordMessageForItem(item);

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

  // espera leve para garantir DOM
  await page.waitForSelector("body", { timeout: 30000 }).catch(() => null);
  await sleep(400);

  // recolhe links de items no perfil
  const itemLinks = await page.$$eval("a[href*='/items/']", (links) =>
    Array.from(new Set(links.map(a => a.href)))
  );

  const links = itemLinks.slice(0, MAX_ITEMS_PER_PROFILE);
  const scraped = [];

  for (const link of links) {
    try {
      const itemPage = await browser.newPage();
      await itemPage.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 });
      await itemPage.waitForSelector("body", { timeout: 30000 }).catch(() => null);
      await sleep(300);

      const data = await itemPage.evaluate(() => {
        const get = (sel) => document.querySelector(sel)?.innerText?.trim() || "";

        const title =
          document.querySelector("h1")?.innerText?.trim() ||
          document.title?.trim() ||
          "Novo artigo";

        const descCandidate =
          document.querySelector("[data-testid='description'], .item-description, .u-text-break")?.innerText ||
          document.querySelector("p")?.innerText ||
          "";

        // preço: testar vários seletores comuns
        let priceText = "";
        const priceNode =
          document.querySelector("[data-testid='item-price']") ||
          document.querySelector("[itemprop='price']") ||
          document.querySelector("meta[itemprop='price']");
        if (priceNode) {
          priceText = priceNode.content || priceNode.getAttribute("content") || priceNode.textContent || "";
          priceText = priceText.trim();
        } else {
          // fallback bruto
          const priceSpan = Array.from(document.querySelectorAll("span"))
            .map(s => s.textContent?.trim() || "")
            .find(t => /^[0-9]+([.,][0-9]{1,2})?\s?(€|EUR)$/i.test(t));
          priceText = priceSpan || "";
        }

        // marca / tamanho / estado (heurística simples)
        const brand = get("a[href*='/brand/'], [data-testid='brand-name']") || "";
        const size = get("[data-testid='size'], [data-testid='item-size']") || "";
        const condition =
          get("[data-testid='item-conditions']") ||
          get("div:has(> [data-testid='item-conditions'])") ||
          "";

        // seller info
        const sellerName =
          document.querySelector("a[href*='/member/'] span")?.innerText?.trim() ||
          document.querySelector("a[href*='/member/']")?.innerText?.trim() ||
          "";

        const sellerUrl = document.querySelector("a[href*='/member/']")?.href || "";
        const sellerAvatar =
          document.querySelector("img[alt*='avatar'], img[alt*='Avatar'], img[class*='avatar']")?.src || "";

        // fotos (mantemos só https)
        const imgs = Array.from(document.querySelectorAll("img"))
          .map(i => i.src)
          .filter(src => /^https?:\/\//i.test(src));

        return {
          title,
          url: location.href,
          description: descCandidate,
          price: priceText.replace(",", "."),
          currency: /€|EUR/i.test(priceText) ? "EUR" : "",
          size,
          brand,
          condition,
          photos: imgs.slice(0, 6), // colhemos até 6, a formatação vai usar 3
          sellerName,
          sellerUrl,
          sellerAvatar,
          createdAt: new Date().toISOString(),
        };
      });

      scraped.push(data);
      await itemPage.close();
      await sleep(150);
    } catch (e) {
      log("Erro ao extrair item:", e.message);
    }
  }

  await page.close();
  return scraped;
}

// =================== TESTE MANUAL (apenas visual) ===================
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
      "https://images.vinted.net/thumbs/f800x800/01_demo1.jpg",
      "https://images.vinted.net/thumbs/f800x800/02_demo2.jpg",
      "https://images.vinted.net/thumbs/f800x800/03_demo3.jpg",
    ],
    sellerName: "medp1",
    sellerUrl: "https://www.vinted.pt/member/medp1",
    sellerAvatar: "https://cdn-icons-png.flaticon.com/512/194/194938.png",
    createdAt: new Date().toISOString(),
  };

  console.log("🧪 TESTE: a publicar item de demonstração no Discord...");
  await postToDiscord(itemTeste);
  console.log("✅ Teste enviado para o Discord com sucesso!");
  process.exit(0);
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
        await sleep(800);
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
