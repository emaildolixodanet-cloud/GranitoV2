/* Carregar dotenv de forma OPCIONAL (seguro no Actions) */
try { await import('dotenv/config'); } catch {}

/**
 * Monitor Vinted → Discord (PT-PT)
 * - Visual “cartão” com ícones
 * - Só publica itens *novos* (created_at_ts / datePublished) e nunca repete
 * - Robusto a cookies/timeouts
 */

import axios from "axios";
import puppeteer from "puppeteer";
import { loadState, saveState } from "./state.js";
import { buildEmbedsPT } from "./discordFormat.js";

const {
  DISCORD_WEBHOOK_URL,
  VINTED_PROFILE_URLS = "",
  ONLY_NEWER_HOURS = "24",
  MAX_ITEMS_PER_PROFILE = "10",
  MAX_NEW_PER_PROFILE = "5",
  TEST_MODE = "false"
} = process.env;

if (!DISCORD_WEBHOOK_URL) {
  console.error("❌ Falta DISCORD_WEBHOOK_URL no ambiente.");
  process.exit(1);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function extractItemId(url) {
  const m = url.match(/\/items\/(\d+)/);
  return m ? m[1] : null;
}

async function safeClickCookieButtons(page) {
  const selectors = [
    'button:has-text("Aceitar")',
    'button:has-text("Aceitar todos")',
    'button:has-text("Accept all")',
    '[data-testid="consent-accept"] button',
    'button[aria-label*="Aceitar"]'
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); await delay(300); return; }
    } catch {}
  }
}

async function getProfileItemLinks(page, profileUrl, max) {
  await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
  await safeClickCookieButtons(page);

  // carrega alguns cartões (scroll leve)
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 1200));
    await delay(250);
  }

  const links = await page.$$eval('a[href*="/items/"]', (as) =>
    Array.from(new Set(as.map((a) => a.href))).filter((u) => /\/items\/\d+/.test(u))
  );

  return links.slice(0, Number(max));
}

/**
 * Extrai o created_at (epoch ms) de várias formas:
 *  - JSON inline `"created_at_ts": 1712345678`
 *  - script LD+JSON com "datePublished"
 *  - meta[property=og:updated_time] como fallback (menos fiável)
 */
function extractCreatedAtMsFromHtml(html) {
  // 1) created_at_ts (segundos)
  let m = html.match(/"created_at_ts"\s*:\s*(\d{10})/);
  if (m) return Number(m[1]) * 1000;

  // 2) datePublished em LD+JSON
  m = html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
  if (m) {
    const d = Date.parse(m[1]);
    if (!isNaN(d)) return d;
  }

  // 3) og:updated_time (pior fallback)
  m = html.match(/property="og:updated_time"\s+content="(\d{10})"/i);
  if (m) return Number(m[1]) * 1000;

  return null;
}

async function scrapeItem(page, itemUrl) {
  await page.goto(itemUrl, { waitUntil: "domcontentloaded" });

  const html = await page.content();
  const createdAt = extractCreatedAtMsFromHtml(html);

  const data = await page.evaluate(() => {
    const selText = (sel) => document.querySelector(sel)?.textContent?.trim() || "";
    const title = selText("h1");

    // preço por meta OG
    const price = document.querySelector('meta[property="product:price:amount"]')?.content || "";
    const currency = document.querySelector('meta[property="product:price:currency"]')?.content || "";

    // imagens (src/data-src)
    const imgs = Array.from(document.querySelectorAll("img"))
      .map((i) => i.getAttribute("src") || i.getAttribute("data-src") || "")
      .filter((u) => u && /^https?:\/\//.test(u));
    const og = document.querySelector('meta[property="og:image"]')?.content;
    if (og && !imgs.includes(og)) imgs.unshift(og);

    const readFromDl = (label) => {
      const dts = Array.from(document.querySelectorAll("dt"));
      const dt = dts.find((x) => x.textContent?.trim().toLowerCase().includes(label.toLowerCase()));
      if (!dt) return "";
      const dd = dt.nextElementSibling;
      return dd ? dd.textContent.trim() : "";
    };

    const brand = readFromDl("marca") || readFromDl("brand");
    const size = readFromDl("tamanho") || readFromDl("size");
    const condition = readFromDl("estado") || readFromDl("condition");

    const seller =
      document.querySelector('a[href*="/member/"] span')?.textContent?.trim() ||
      document.querySelector('a[href*="/member/"]')?.textContent?.trim() || "";

    return { title, price, currency, images: imgs.slice(0, 6), brand, size, condition, seller };
  });

  return {
    ...data,
    url: itemUrl,
    id: extractItemId(itemUrl),
    createdAt,
    priceText: data.price && data.currency ? `${data.price} ${data.currency}` : ""
  };
}

function shouldPost(item, state, onlyNewerHours) {
  // só novos: precisa de createdAt e estar dentro da janela
  if (!item.createdAt) return { ok: false, reason: "sem-createdAt" };
  const freshCut = Date.now() - onlyNewerHours * 3600 * 1000;
  if (item.createdAt < freshCut) return { ok: false, reason: "antigo" };

  const key = item.id ? `item:${item.id}` : item.url;
  if (state.posted[key]) return { ok: false, reason: "ja-postado" };
  return { ok: true, key };
}

async function postToDiscord(webhookUrl, embeds) {
  await axios.post(webhookUrl, { embeds }, { headers: { "Content-Type": "application/json" }, timeout: 20000 });
}

async function main() {
  const profiles = VINTED_PROFILE_URLS.split(",").map((s) => s.trim()).filter(Boolean);
  const onlyNewerHours = Number(ONLY_NEWER_HOURS);
  const maxPerProfile = Number(MAX_ITEMS_PER_PROFILE);
  const maxNewPerProfile = Number(MAX_NEW_PER_PROFILE);
  const isTest = String(TEST_MODE).toLowerCase() === "true";

  console.log(`🔎 A verificar ${profiles.length} perfis (últimas ${onlyNewerHours}h) ...`);

  const state = loadState();
  let totalFound = 0;
  let totalToPost = 0;

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(60000);

    for (const profileUrl of profiles) {
      console.log(`→ Perfil: ${profileUrl}`);
      let links = [];
      try {
        links = await getProfileItemLinks(page, profileUrl, maxPerProfile);
      } catch (e) {
        console.log(`⚠️ Erro a obter links do perfil: ${e.message}`);
        continue;
      }

      totalFound += links.length;

      let newCount = 0;
      for (const link of links) {
        if (newCount >= maxNewPerProfile) break;

        try {
          const item = await scrapeItem(page, link);

          const gate = shouldPost(item, state, onlyNewerHours);
          if (!gate.ok) continue;

          const embeds = buildEmbedsPT(item, new Date().toISOString());

          if (isTest) {
            console.log(`(TEST_MODE) Publicaria: ${item.title} -> ${item.url}`);
          } else {
            await postToDiscord(DISCORD_WEBHOOK_URL, embeds);
            await delay(900); // ligeira pausa anti rate-limit
          }

          state.posted[gate.key] = { ts: Date.now(), url: item.url };
          newCount += 1;
          totalToPost += 1;
        } catch (e) {
          console.log(`⚠️ Erro a scrapar ${link}: ${e.message}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  // prune de registos com mais de 30 dias (a cada ~3 dias)
  if (Date.now() - (state.lastPrune || 0) > 3 * 24 * 3600 * 1000) {
    const before = Object.keys(state.posted).length;
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const k of Object.keys(state.posted)) {
      if (Number(state.posted[k]?.ts || 0) < cutoff) delete state.posted[k];
    }
    state.lastPrune = Date.now();
    console.log(`🧹 Prune: ${before} → ${Object.keys(state.posted).length}`);
  }

  saveState(state);
  console.log(`📦 Resumo: encontrados=${totalFound}, publicados=${totalToPost}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
