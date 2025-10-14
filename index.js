// index.js (ESM)
import fs from "fs/promises";
import path from "path";
import puppeteer from "puppeteer";
import { buildDiscordPayload, postToDiscord } from "./discordFormat.js";

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const PROFILE_URLS = (process.env.VINTED_PROFILE_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ONLY_NEWER_HOURS = Number(process.env.ONLY_NEWER_HOURS || 24);
const MAX_ITEMS_PER_PROFILE = Number(process.env.MAX_ITEMS_PER_PROFILE || 10);
const MAX_NEW_PER_PROFILE = Number(process.env.MAX_NEW_PER_PROFILE || 5);
const TEST_MODE = String(process.env.TEST_MODE || "false").toLowerCase() === "true";

const STATE_FILE = path.resolve("vinted_state.json");

// --------- Estado (para evitar reposts)
async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { posted: {}, lastPrune: 0 };
  }
}
async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}
function markPosted(state, itemId, url) {
  state.posted[`item:${itemId}`] = { ts: Date.now(), url };
}
function alreadyPosted(state, itemId) {
  return !!state.posted[`item:${itemId}`];
}
function pruneState(state) {
  const now = Date.now();
  if (now - (state.lastPrune || 0) < 24 * 3600 * 1000) return;
  const keepMs = 30 * 24 * 3600 * 1000; // 30 dias
  for (const [k, v] of Object.entries(state.posted || {})) {
    if (!v?.ts || now - v.ts > keepMs) delete state.posted[k];
  }
  state.lastPrune = now;
}

// --------- Helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toISO = (d) => (d instanceof Date ? d : new Date(d)).toISOString();

function extractItemIdFromUrl(u) {
  try {
    const m = String(u).match(/\/items\/(\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function hoursAgoToMs(h) {
  return Date.now() - h * 3600 * 1000;
}

// --------- Scraping
async function collectItemLinksFromProfile(page, profileUrl, limit = 10) {
  await page.goto(profileUrl, { waitUntil: "networkidle2" });
  // algum scroll para carregar mais cartões
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await sleep(400);
  }

  const links = await page.evaluate(() => {
    const as = Array.from(document.querySelectorAll('a[href*="/items/"]'));
    const uniq = new Set();
    const out = [];
    for (const a of as) {
      const href = a.getAttribute("href");
      if (!href) continue;
      let url = href.startsWith("http") ? href : `https://www.vinted.pt${href}`;
      if (!uniq.has(url)) {
        uniq.add(url);
        out.push(url);
      }
    }
    return out;
  });

  return links.slice(0, limit);
}

async function scrapeItem(page, url) {
  await page.goto(url, { waitUntil: "networkidle2" });

  const data = await page.evaluate(() => {
    const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
    const og = (p) => document.querySelector(`meta[property="${p}"]`)?.getAttribute("content") || null;

    // open graph
    const ogTitle = og("og:title");
    const ogImage = og("og:image");

    // título
    const title = getText("h1") || ogTitle;

    // tentar apanhar preço e moeda em vários formatos
    let priceLabel = null;
    const priceNode = document.querySelector('[data-testid="item-price"]') || document.querySelector('div:has(span[class*="Price"]) span');
    if (priceNode) priceLabel = priceNode.textContent.trim();

    // tentativas para ler atributos listados
    const findByLabel = (labelText) => {
      const rows = Array.from(document.querySelectorAll("div,li,dt,span")).filter((el) => {
        const t = (el.textContent || "").trim().toLowerCase();
        return t === labelText.toLowerCase();
      });
      if (!rows.length) return null;
      const el = rows[0];
      // procurar o próximo irmão com valor
      const val =
        el.nextElementSibling?.textContent?.trim() ||
        el.parentElement?.querySelector("dd,span,strong")?.textContent?.trim() ||
        null;
      return val;
    };

    const brand = findByLabel("marca") || findByLabel("brand");
    const size = findByLabel("tamanho") || findByLabel("size");
    const condition = findByLabel("estado") || findByLabel("condição") || findByLabel("condition");

    // vendedor
    const sellerName =
      document.querySelector('a[href*="/member/"] span, [data-testid="user-name"]')?.textContent?.trim() ||
      document.querySelector('a[href*="/member/"]')?.textContent?.trim() ||
      null;

    // métricas
    const favorites = (() => {
      const n = document.querySelector('[data-testid="favorite-count"], [data-testid="favourites-count"]');
      if (!n) return null;
      const m = (n.textContent || "").match(/\d+/);
      return m ? Number(m[0]) : null;
    })();

    const views = (() => {
      const n = document.querySelector('[data-testid="view-count"], [data-testid="views-count"]');
      if (!n) return null;
      const m = (n.textContent || "").match(/\d+/);
      return m ? Number(m[0]) : null;
    })();

    // rating + nº reviews (se houver)
    let sellerRating = null;
    let sellerReviews = null;
    const ratingNode = document.querySelector('[data-testid="user-rating"], [data-testid="feedback-score"]');
    if (ratingNode) {
      const t = ratingNode.textContent.trim();
      const m = t.match(/(\d+[.,]?\d*)/);
      if (m) sellerRating = Number(m[1].replace(",", "."));
      const r = t.match(/(\d+)\s*(avalia|review)/i);
      if (r) sellerReviews = Number(r[1]);
    }

    // imagens
    const imgs = Array.from(document.querySelectorAll("img[src]"))
      .map((img) => img.getAttribute("src"))
      .filter((u) => u && /https?:/.test(u) && !u.includes("placeholder"))
      .filter((u, i, arr) => arr.indexOf(u) === i);

    // meter a principal do OG em primeiro se existir
    if (ogImage && !imgs.includes(ogImage)) imgs.unshift(ogImage);

    return {
      title,
      priceLabel,
      brand,
      size,
      condition,
      sellerName,
      sellerRating,
      sellerReviews,
      favorites,
      views,
      images: imgs.slice(0, 6),
    };
  });

  const id = extractItemIdFromUrl(url);
  const detectedAtISO = toISO(new Date());
  return { ...data, id, url, detectedAtISO };
}

async function run() {
  if (!WEBHOOK_URL) {
    console.error("❌ DISCORD_WEBHOOK_URL não definido.");
    process.exit(1);
  }
  if (!PROFILE_URLS.length) {
    console.error("❌ VINTED_PROFILE_URLS vazio.");
    process.exit(1);
  }

  const state = await loadState();
  pruneState(state);

  console.log(`🔎 A verificar ${PROFILE_URLS.length} perfis (últimas ${ONLY_NEWER_HOURS}h) ...`);

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: "new",
  });

  let totalFound = 0;
  let toPost = 0;

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
    );

    const cutoff = hoursAgoToMs(ONLY_NEWER_HOURS);

    for (const profile of PROFILE_URLS) {
      console.log(`→ Perfil: ${profile}`);

      let links = [];
      try {
        links = await collectItemLinksFromProfile(page, profile, MAX_ITEMS_PER_PROFILE);
      } catch (e) {
        console.log(`⚠️ Erro a scrapar ${profile}: ${e.message}`);
        continue;
      }

      // Normalizar/filtrar por ID único
      const itemsUnique = [];
      const seen = new Set();
      for (const u of links) {
        const id = extractItemIdFromUrl(u);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        itemsUnique.push({ id, url: u });
      }

      // já temos uma estimativa de "novos": evita mais que MAX_NEW_PER_PROFILE
      let postedFromThis = 0;

      for (const it of itemsUnique) {
        totalFound++;

        if (alreadyPosted(state, it.id)) continue;

        // Scrape detalhado:
        let full;
        try {
          full = await scrapeItem(page, it.url);
        } catch (e) {
          console.log(`⚠️ Erro no item ${it.url}: ${e.message}`);
          continue;
        }

        // Não dá para saber a data real de publicação de forma estável -> usamos cutoff via estado:
        // Apenas publicamos se nunca foi enviado e respeitamos limite de novos por perfil.
        if (postedFromThis >= MAX_NEW_PER_PROFILE) continue;

        // Publicar
        const payload = buildDiscordPayload(full);
        toPost++;

        if (!TEST_MODE) {
          try {
            await postToDiscord(WEBHOOK_URL, payload);
            markPosted(state, full.id, full.url);
            postedFromThis++;
            await saveState(state);
            // pausa pequena entre posts
            await sleep(600);
          } catch (e) {
            console.log(`❌ Erro ao publicar no Discord: ${e.message}`);
          }
        } else {
          console.log("TEST_MODE=on → não publica. Payload:", JSON.stringify(payload).slice(0, 300) + "...");
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`📦 Resumo: encontrados=${totalFound}, a_publicar=${toPost}`);
  await saveState(state);
}

run().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
