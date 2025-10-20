/* Carregar dotenv de forma OPCIONAL (não rebenta no GitHub Actions) */
try { await import('dotenv/config'); } catch {}

/**
 * Monitor Vinted → Publicar no Discord
 * - Totalmente em PT-PT
 * - Sem usar page.waitForTimeout (incompatível com Puppeteer 22+)
 * - Heurística para ignorar anúncios antigos (quando conseguimos obter a data)
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
  TEST_MODE = "false"
} = process.env;

if (!DISCORD_WEBHOOK_URL) {
  console.error("❌ Falta DISCORD_WEBHOOK_URL no ambiente.");
  process.exit(1);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getProfileItemLinks(page, profileUrl, max) {
  await page.goto(profileUrl, { waitUntil: "networkidle0" });

  // tenta aceitar cookies (texto pode variar por idioma)
  try {
    const selectors = [
      'button:has-text("Aceitar todos")',
      'button:has-text("Aceitar")',
      'button:has-text("Accept all")',
      '[data-testid="consent-banner-accept"] button'
    ];
    for (const s of selectors) {
      const btn = await page.$(s);
      if (btn) {
        await btn.click().catch(() => {});
        break;
      }
    }
  } catch {}

  // recolhe links para páginas de item
  const links = await page.$$eval('a[href*="/items/"]', (as) =>
    Array.from(new Set(as.map((a) => a.href)))
      .filter((u) => /\/items\/\d+/.test(u))
  );
  return links.slice(0, Number(max));
}

function parseRelativeTimePT(text) {
  // Exemplos: "há 3 minutos", "há 2 horas", "há 1 dia"
  const m = text.toLowerCase().match(/há\s+(\d+)\s+(minuto|minutos|hora|horas|dia|dias)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  let ms = 0;
  if (unit.startsWith("minuto")) ms = n * 60 * 1000;
  else if (unit.startsWith("hora")) ms = n * 3600 * 1000;
  else if (unit.startsWith("dia")) ms = n * 24 * 3600 * 1000;
  return Date.now() - ms;
}

async function scrapeItem(page, itemUrl) {
  await page.goto(itemUrl, { waitUntil: "networkidle0" });

  const data = await page.evaluate(() => {
    const selText = (sel) => document.querySelector(sel)?.textContent?.trim() || "";

    // Título
    const title = selText("h1");

    // Preço via meta OG
    const price = document.querySelector('meta[property="product:price:amount"]')?.content || "";
    const currency = document.querySelector('meta[property="product:price:currency"]')?.content || "";

    // Imagens (galeria + og:image)
    const imgs = Array.from(document.querySelectorAll('img'))
      .map((i) => i.getAttribute("src") || i.getAttribute("data-src") || "")
      .filter((u) => u && /^https?:\/\//.test(u));
    const og = document.querySelector('meta[property="og:image"]')?.content;
    if (og && imgs.indexOf(og) === -1) imgs.unshift(og);

    // Campos tipo tabela (Marca/Tamanho/Estado)
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

    // Vendedor (username)
    const seller =
      document.querySelector('a[href*="/member/"] span')?.textContent?.trim() ||
      document.querySelector('a[href*="/member/"]')?.textContent?.trim() ||
      "";

    // Favoritos / Visualizações (nem sempre exposto – heurísticas)
    const favMatch = document.body.innerText.match(/Favoritos?\s*\(?(\d+)\)?/i);
    const viewsMatch = document.body.innerText.match(/Visualiza(?:ç|c)ões?\s*\(?(\d+)\)?/i);

    // Rating e nº avaliações (quando existe)
    const ratingMatch = document.body.innerText.match(/([\d,\.]+)\s*de\s*5\s*estrelas/i) || document.body.innerText.match(/([\d,\.]+)\s*★/);
    const reviewsMatch = document.body.innerText.match(/(\d+)\s+avalia(?:ç|c)ões/i);

    // Tentativas de data de publicação/atualização
    let publishedISO =
      document.querySelector('meta[property="article:published_time"]')?.content ||
      document.querySelector('time[datetime]')?.getAttribute('datetime') ||
      "";

    // Também tentar apanhar "há X minutos/horas/dias"
    let relativeText = "";
    const candidates = Array.from(document.querySelectorAll("time, span, div"))
      .map((el) => el.textContent?.trim() || "")
      .filter(Boolean);
    for (const t of candidates) {
      if (/há\s+\d+\s+(minuto|minutos|hora|horas|dia|dias)/i.test(t)) {
        relativeText = t;
        break;
      }
    }

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
      publishedISO,
      relativeText
    };
  });

  // Converter preço em string "123 EUR" se existir
  const priceText = data.price && data.currency ? `${data.price} ${data.currency}` : "";

  // Heurística de data/hora do anúncio
  let postedAtTs = null;
  if (data.publishedISO) {
    const ts = Date.parse(data.publishedISO);
    if (!Number.isNaN(ts)) postedAtTs = ts;
  }
  if (!postedAtTs && data.relativeText) {
    const ts = parseRelativeTimePT(data.relativeText);
    if (ts) postedAtTs = ts;
  }

  // Resultado do item
  const item = {
    ...data,
    url: itemUrl,
    priceText,
    priceConvertedText: "", // placeholder para manter layout consistente
    postedAtTs // pode ser null se não for possível detectar
  };

  return item;
}

function shouldPostByState(itemUrl, state, onlyNewerHours) {
  const key = `item:${(itemUrl.match(/\/items\/(\d+)/) || [])[1] || itemUrl}`;
  const rec = state.posted[key];
  if (!rec) return { ok: true, key };
  const ageMs = Date.now() - Number(rec.ts || 0);
  return { ok: ageMs > onlyNewerHours * 3600 * 1000, key };
}

function shouldPostByAge(item, onlyNewerHours) {
  if (!item?.postedAtTs) return true; // se não sabemos a idade, não bloqueamos por aqui
  const maxAgeMs = Number(onlyNewerHours) * 3600 * 1000;
  return (Date.now() - item.postedAtTs) <= maxAgeMs;
}

function markPosted(key, url, state) {
  state.posted[key] = { ts: Date.now(), url };
}

async function postToDiscord(webhookUrl, embeds) {
  await axios.post(
    webhookUrl,
    { embeds },
    { headers: { "Content-Type": "application/json" }, timeout: 20000 }
  );
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
        // 1) filtro pelo estado já publicado (cooldown por horas)
        const { ok, key } = shouldPostByState(link, state, onlyNewerHours);
        if (!ok) continue;
        if (newCount >= maxNewPerProfile) break;

        try {
          // 2) scrap do item
          const item = await scrapeItem(page, link);

          // 3) filtro pela idade real do anúncio (se conseguirmos detectá-la)
          if (!shouldPostByAge(item, onlyNewerHours)) {
            // marcar como visto para não repetir este item neste ciclo
            markPosted(key, link, state);
            continue;
          }

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

          // pequena pausa entre posts para evitar rate limit
          await delay(1000);
        } catch (e) {
          console.log(`⚠️ Erro a scrapar ${link}: ${e.message}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  // limpeza leve do state (a cada ~3 dias)
  if (Date.now() - (state.lastPrune || 0) > 3 * 24 * 3600 * 1000) {
    const before = Object.keys(state.posted).length;
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000; // 30 dias
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
