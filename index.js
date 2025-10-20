/* Carregar dotenv de forma OPCIONAL (não rebenta no GitHub Actions) */
try { await import('dotenv/config'); } catch {}

/**
 * Monitor Vinted → Publicar no Discord
 * - Totalmente em PT-PT
 * - Robusto contra timeouts (goto com retry)
 * - Não usa waits “mágicos” quebradiços
 */

import fs from "fs";
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
  TEST_MODE = "false",
} = process.env;

if (!DISCORD_WEBHOOK_URL) {
  console.error("❌ Falta DISCORD_WEBHOOK_URL no ambiente.");
  process.exit(1);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ir para URL com retry e timeouts mais folgados */
async function gotoWithRetry(page, url, { tries = 2, timeout = 60000, waitUntil = "domcontentloaded" } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      await page.goto(url, { timeout, waitUntil });
      return;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        await delay(2000);
        continue;
      }
    }
  }
  throw lastErr;
}

/** Tenta aceitar cookies em vários idiomas/variantes */
async function tryAcceptCookies(page) {
  const candidates = [
    'button[aria-label*="Aceitar"]',
    'button:has-text("Aceitar todos")',
    'button:has-text("Concordo")',
    'button:has-text("Accept all")',
    'button:has-text("Allow all")',
    '[data-testid="privacy-accept"] button',
  ];
  for (const sel of candidates) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click({ delay: 10 }); await delay(300); return; }
    } catch {}
  }
}

/** Recolhe links de itens de um perfil */
async function getProfileItemLinks(page, profileUrl, max) {
  await gotoWithRetry(page, profileUrl, { tries: 2, timeout: 60000, waitUntil: "domcontentloaded" });
  await tryAcceptCookies(page);

  // Dar um “nudge” de scroll para renderizações preguiçosas
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await delay(300);

  // Esperar até existirem anchors de items (sem bloquear eternamente)
  try { await page.waitForSelector('a[href*="/items/"]', { timeout: 5000 }); } catch {}

  const links = await page.$$eval('a[href*="/items/"]', (as) =>
    Array.from(new Set(as.map((a) => a.href))).filter((u) => /\/items\/\d+/.test(u))
  );

  return links.slice(0, Number(max));
}

/** Scraping de uma página de item */
async function scrapeItem(page, itemUrl) {
  await gotoWithRetry(page, itemUrl, { tries: 2, timeout: 60000, waitUntil: "domcontentloaded" });

  const data = await page.evaluate(() => {
    const selText = (sel) => document.querySelector(sel)?.textContent?.trim() || "";

    // Título
    const title = selText("h1");

    // Preço via meta OG
    const price = document.querySelector('meta[property="product:price:amount"]')?.content || "";
    const currency = document.querySelector('meta[property="product:price:currency"]')?.content || "";

    // Imagens (galeria + og:image)
    const imgs = Array.from(document.querySelectorAll("img"))
      .map((i) => i.getAttribute("src") || i.getAttribute("data-src") || "")
      .filter((u) => u && /^https?:\/\//.test(u));
    const og = document.querySelector('meta[property="og:image"]')?.content;
    if (og && imgs.indexOf(og) === -1) imgs.unshift(og);

    // Campos (Marca/Tamanho/Estado) – detecta por <dt>/<dd>
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

    // Vendedor
    const seller =
      document.querySelector('a[href*="/member/"] span')?.textContent?.trim() ||
      document.querySelector('a[href*="/member/"]')?.textContent?.trim() ||
      "";

    // Heurísticas: favoritos / visualizações
    const favMatch = document.body.innerText.match(/Favoritos?\s*\(?(\d+)\)?/i);
    const viewsMatch = document.body.innerText.match(/Visualiza(?:ç|c)ões?\s*\(?(\d+)\)?/i);

    // Classificação (quando aparece)
    const ratingMatch =
      document.body.innerText.match(/([\d,\.]+)\s*de\s*5\s*estrelas/i) ||
      document.body.innerText.match(/([\d,\.]+)\s*★/);
    const reviewsMatch = document.body.innerText.match(/(\d+)\s+avalia(?:ç|c)ões/i);

    return {
      title,
      price,
      currency,
      images: imgs.slice(0, 6),
      brand,
      size,
      condition,
      seller,
      favourites: favMatch ? Number(favMatch[1]) : null,
      views: viewsMatch ? Number(viewsMatch[1]) : null,
      rating: ratingMatch ? Number(String(ratingMatch[1]).replace(",", ".")) : null,
      reviews: reviewsMatch ? Number(reviewsMatch[1]) : null,
    };
  });

  const priceText = data.price && data.currency ? `${data.price} ${data.currency}` : "";

  return {
    ...data,
    url: itemUrl,
    priceText,
    priceConvertedText: "",
  };
}

/** Controla duplicados/antigos via state */
function shouldPost(itemUrl, state, onlyNewerHours) {
  const id = (itemUrl.match(/\/items\/(\d+)/) || [])[1] || itemUrl;
  const key = `item:${id}`;
  const rec = state.posted[key];
  if (!rec) return { ok: true, key };
  const ageMs = Date.now() - Number(rec.ts || 0);
  return { ok: ageMs > onlyNewerHours * 3600 * 1000, key };
}
function markPosted(key, url, state) { state.posted[key] = { ts: Date.now(), url }; }

async function postToDiscord(webhookUrl, embeds) {
  await axios.post(webhookUrl, { embeds }, {
    headers: { "Content-Type": "application/json" },
    timeout: 20000,
    maxBodyLength: 10 * 1024 * 1024,
  });
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
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-features=site-per-process",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(60000);
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
    await page.setViewport({ width: 1200, height: 900 });

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
        const { ok, key } = shouldPost(link, state, onlyNewerHours);
        if (!ok) continue;
        if (newCount >= maxNewPerProfile) break;

        try {
          const item = await scrapeItem(page, link);
          const detectedAtIso = new Date().toISOString();
          const embeds = buildEmbedsPT(item, detectedAtIso);

          if (isTest) {
            console.log(`(TEST_MODE) Publicaria: ${item.title} -> ${item.url}`);
          } else {
            await postToDiscord(DISCORD_WEBHOOK_URL, embeds);
          }

          markPosted(key, link, state);
          newCount += 1;
          totalToPost += 1;
          await delay(800);
        } catch (e) {
          console.log(`⚠️ Erro a scrapar ${link}: ${e.message}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  // Limpeza do state (30 dias)
  if (Date.now() - (state.lastPrune || 0) > 3 * 24 * 3600 * 1000) {
    const before = Object.keys(state.posted).length;
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const k of Object.keys(state.posted)) {
      if (Number(state.posted[k]?.ts || 0) < cutoff) delete state.posted[k];
    }
    const after = Object.keys(state.posted).length;
    state.lastPrune = Date.now();
    console.log(`🧹 Prune: ${before} → ${after}`);
  }

  saveState(state);
  console.log(`📦 Resumo: encontrados=${totalFound}, a_publicar=${totalToPost}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
