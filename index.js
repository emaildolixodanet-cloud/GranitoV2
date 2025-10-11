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

// ======================= FUNÇÕES AUXILIARES ===========================
function log(...args) {
  console.log(...args);
}

function short(txt, max = 120) {
  if (!txt) return "";
  const clean = txt.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "..." : clean;
}

// ======================= DISCORD POST ===========================
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

        const brand = get("dt:contains('Marca') + dd") || "";
        const size = get("dt:contains('Tamanho') + dd") || "";
        const condition = get("dt:contains('Estado') + dd") || "";

        return {
          title,
          url: window.location.href,
          description,
          price,
          brand,
          size,
          condition,
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

// ======================= EXECUÇÃO ===========================
run().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
