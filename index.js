import fs from "fs/promises";
import puppeteer from "puppeteer";
import { buildDiscordMessageForItem } from "./discordFormat.js";

const fetchHttp = (typeof fetch !== "undefined")
  ? fetch
  : (await import("node-fetch")).default;

const PROFILES = (process.env.VINTED_PROFILE_URLS || "")
  .split(",").map(u => u.trim()).filter(Boolean);

const HOURS = parseInt(process.env.ONLY_NEWER_HOURS || "24", 10);
const MAX_ITEMS_PER_PROFILE = parseInt(process.env.MAX_ITEMS_PER_PROFILE || "20", 10);
const MAX_NEW_PER_PROFILE = parseInt(process.env.MAX_NEW_PER_PROFILE || "5", 10);
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const STATE_PATH = "vinted_state.json";

const log = (...a) => console.log(...a);

/* ======== DEDUPE ROBUSTO POR ID ======== */
function extractItemId(u) {
  try {
    const url = new URL(u);
    const m = url.pathname.match(/\/items\/(\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}
function canonicalKey(u) {
  const id = extractItemId(u);
  return id ? `item:${id}` : (new URL(u)).origin + (new URL(u)).pathname; // fallback
}
/* ======================================= */

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const s = JSON.parse(raw);
    return { posted: s.posted || {}, lastPrune: s.lastPrune || 0 };
  } catch {
    return { posted: {}, lastPrune: 0 };
  }
}
async function saveState(state) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}
function pruneState(state, days = 14) {
  const now = Date.now();
  if (now - (state.lastPrune || 0) < 6 * 3600 * 1000) return;
  const cutoff = now - days * 24 * 3600 * 1000;
  for (const [k, v] of Object.entries(state.posted)) {
    if (!v?.ts || v.ts < cutoff) delete state.posted[k];
  }
  state.lastPrune = now;
}

const short = (t, m = 250) => {
  if (!t) return "";
  const c = t.replace(/\s+/g, " ").trim();
  return c.length > m ? c.slice(0, m) + "..." : c;
};
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);

function parseRelativePt(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/há\s+um(a)?\s+min/.test(t)) return new Date(Date.now() - 1 * 60 * 1000);
  if (/há\s+um(a)?\s+hora/.test(t)) return new Date(Date.now() - 1 * 3600 * 1000);
  if (/há\s+um(a)?\s+dia/.test(t)) return new Date(Date.now() - 24 * 3600 * 1000);
  let m;
  if ((m = t.match(/há\s+(\d+)\s+min/)))   return new Date(Date.now() - parseInt(m[1], 10) * 60 * 1000);
  if ((m = t.match(/há\s+(\d+)\s+hora/)))  return new Date(Date.now() - parseInt(m[1], 10) * 3600 * 1000);
  if ((m = t.match(/há\s+(\d+)\s+dia/)))   return new Date(Date.now() - parseInt(m[1], 10) * 24 * 3600 * 1000);
  return null;
}

async function postToDiscord(item) {
  if (!WEBHOOK) throw new Error("DISCORD_WEBHOOK_URL não configurado");
  const payload = buildDiscordMessageForItem(item);
  await fetchHttp(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function autoScroll(page, steps = 10, stepPx = 1200, delayMs = 300) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(y => window.scrollBy(0, y), stepPx);
    if (page.waitForTimeout) await page.waitForTimeout(delayMs);
    else await new Promise(r => setTimeout(r, delayMs));
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}
async function ensureAtLeastOneItemLink(page, timeoutMs = 10000) {
  try { await page.waitForSelector('a[href*="/items/"]', { timeout: timeoutMs }); } catch {}
}

async function scrapeProfile(browser, url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("body", { timeout: 30000 }).catch(() => null);
  await autoScroll(page, 12, 1400, 200);
  await ensureAtLeastOneItemLink(page);

  const rawLinks = await page.$$eval('a[href*="/items/"]', (links) =>
    links.map((a) => a.href)
  );

  // normalizar: remover dupes por ID
  const byId = new Map();
  for (const href of rawLinks) {
    const id = extractItemId(href);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, href);
  }
  const links = Array.from(byId.values()).slice(0, MAX_ITEMS_PER_PROFILE);

  const out = [];
  for (const link of links) {
    try {
      const it = await scrapeItem(browser, link);
      if (it) out.push(it);
    } catch (e) {
      log("  • Erro a extrair item:", e.message);
    }
  }
  await page.close();
  return out;
}

async function scrapeItem(browser, link) {
  const page = await browser.newPage();
  await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("body", { timeout: 30000 }).catch(() => null);
  await autoScroll(page, 2, 800, 150);

  const data = await page.evaluate(() => {
    const getMeta = (prop) =>
      document.querySelector(`meta[property="${prop}"]`)?.getAttribute("content") ||
      document.querySelector(`meta[name="${prop}"]`)?.getAttribute("content") ||
      "";

    const sidebar = document.querySelector('[data-testid="sidebar"]') || document;
    const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ");

    const textOf = (sel, root = document) => root.querySelector(sel)?.textContent?.trim() || "";
    const title = textOf("h1") || document.title || "";

    // --- PREÇO muito robusto (JSON-LD → scripts → meta → UI) ---
    let price = "", priceText = "", currency = "";

    try {
      const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map(s => s.textContent)
        .filter(Boolean)
        .map(t => { try { return JSON.parse(t); } catch { return null; } })
        .filter(Boolean);
      for (const blob of ld) {
        const arr = Array.isArray(blob) ? blob : [blob];
        for (const obj of arr) {
          if (obj?.['@type'] === 'Product') {
            const offers = Array.isArray(obj.offers) ? obj.offers : (obj.offers ? [obj.offers] : []);
            const off = offers.find(o => o.price);
            if (off?.price) {
              price = String(off.price);
              currency = (off.priceCurrency || "EUR").toUpperCase();
              priceText = off.priceCurrency ? `${off.price} ${off.priceCurrency}` : String(off.price);
              break;
            }
          }
        }
      }
    } catch {}

    if (!price) {
      const scripts = Array.from(document.querySelectorAll("script"))
        .map(s => s.textContent || "")
        .filter(t => /price/i.test(t) && t.length < 2_000_000);
      for (const t of scripts) {
        let m = t.match(/"price"\s*:\s*"?(?<p>[\d.,]+)"?/i);
        if (m?.groups?.p) {
          price = m.groups.p;
          const c = t.match(/"currency"\s*:\s*"(?<c>[A-Z]{3})"/i)?.groups?.c;
          currency = (c || "EUR").toUpperCase();
          break;
        }
      }
    }

    if (!price) {
      const metaAmount = getMeta("product:price:amount") || getMeta("og:price:amount");
      const metaCurrency = getMeta("product:price:currency") || getMeta("og:price:currency");
      if (metaAmount) {
        price = metaAmount.trim();
        currency = (metaCurrency || "EUR").trim().toUpperCase();
      }
    }

    if (!price) {
      const sideTxt = (sidebar.innerText || "").replace(/\s+/g, " ");
      let m = sideTxt.match(/[€£$]\s*\d[\d.,]*/) ||
              sideTxt.match(/\b\d[\d.,]*\s*(€|EUR|GBP|USD)\b/i);
      if (!m) {
        const btnTxt = Array.from(document.querySelectorAll("button, a"))
          .map(el => el.textContent?.replace(/\s+/g, " ").trim() || "")
          .filter(Boolean)
          .join(" | ");
        m = btnTxt.match(/[€£$]\s*\d[\d.,]*/) ||
            btnTxt.match(/\b\d[\d.,]*\s*(€|EUR|GBP|USD)\b/i);
      }
      if (m) {
        const s = m[0];
        priceText = s;
        if (/^[€£$]/.test(s)) {
          currency = s[0] === "€" ? "EUR" : (s[0] === "£" ? "GBP" : "USD");
          price = s.replace(/[€£$\s]/g, "");
        } else {
          const parts = s.trim().split(/\s+/);
          price = parts[0];
          const cur = (parts[1] || "").toUpperCase();
          currency = cur === "€" ? "EUR" : cur;
        }
      }
    }

    const findRowValue = (label) => {
      const root = sidebar;
      const rows = Array.from(root.querySelectorAll("div,li,dt,section"));
      const target = rows.find(el => el.textContent.trim().toLowerCase().startsWith(label.toLowerCase()));
      if (!target) return "";
      const firstLink = target.querySelector("a");
      if (firstLink?.textContent) return firstLink.textContent.trim();
      const labEl = Array.from(target.querySelectorAll("span,div,dt")).find(
        el => el.textContent.trim().toLowerCase() === label.toLowerCase()
      );
      if (labEl?.nextElementSibling?.textContent)
        return labEl.nextElementSibling.textContent.trim();
      return target.textContent.replace(new RegExp("^" + label, "i"), "").trim();
    };

    let brand = findRowValue("Marca")
      .replace(/Menu da marca/gi, "")
      .split(/›|>/)[0]
      .split("\n")[0]
      .trim();

    const size = findRowValue("Tamanho");
    const condition = findRowValue("Estado");
    const loadedAgo = findRowValue("Carregado");

    let feedbacks = null;
    const fbMatch =
      bodyText.match(/(Feedbacks|Opiniões|Avaliações)\s*\((\d+)\)/i) ||
      bodyText.match(/⭐\s*\((\d+)\)/i);
    if (fbMatch) {
      feedbacks = parseInt(fbMatch[2] || fbMatch[1], 10);
      if (Number.isNaN(feedbacks)) feedbacks = null;
    }

    const urls = new Set();
    const ogImage = getMeta("og:image");
    if (ogImage) urls.add(ogImage);
    document.querySelectorAll("img").forEach(img => {
      const ss = img.getAttribute("srcset") || img.getAttribute("data-srcset");
      if (ss) {
        const candidate = ss.split(",").map(s => s.trim().split(" ")[0]).filter(Boolean).pop();
        if (candidate && /^https?:\/\//i.test(candidate)) urls.add(candidate);
      }
      const src = img.getAttribute("src") || img.getAttribute("data-src");
      if (src && /^https?:\/\//i.test(src)) urls.add(src);
    });

    const priceNorm = price ? price.replace(/\s/g, "") : "";
    const priceTextFinal = (priceText || (priceNorm
      ? ((currency === "EUR" ? "€ " : "") + priceNorm.replace(/\./g, ","))
      : "")).trim();

    return {
      title,
      url: location.href,
      description: "",
      price: priceNorm,
      priceText: priceTextFinal,
      currency,
      brand,
      size,
      condition,
      loadedAgo,
      feedbacks,
      photos: Array.from(urls).slice(0, 6),
    };
  });

  await page.close();
  return data;
}

run().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});

async function run() {
  if (!PROFILES.length) {
    console.error("Nenhum perfil configurado!");
    return;
  }

  const state = await loadState();
  pruneState(state);

  const cutoff = hoursAgo(HOURS);
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

      for (const it of items) {
        const dt = parseRelativePt(it.loadedAgo);
        it.createdAt = dt ? dt.toISOString() : new Date().toISOString();

        // chave canónica por ID
        it.key = canonicalKey(it.url);
      }

      const candidatos = items
        .filter(it => new Date(it.createdAt) >= cutoff)
        .filter(it => it.key && !state.posted[it.key]);  // DEDUPE

      const toPost = candidatos.slice(0, MAX_NEW_PER_PROFILE);

      for (const item of toPost) {
        await postToDiscord({
          ...item,
          description: short(item.description, 280),
          photos: (item.photos || []).slice(0, 3), // 1 + 2 thumbs pequenos
        });

        state.posted[item.key] = { ts: Date.now(), url: item.url };
        await saveState(state);

        totalPublicados++;
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (err) {
      log("Erro geral:", err.message);
    }
  }

  await browser.close();
  await saveState(state);
  log(`📦 Resumo: encontrados=${totalEncontrados}, publicados=${totalPublicados}`);
}
