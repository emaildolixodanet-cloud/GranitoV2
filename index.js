// ======================= IMPORTS E SETUP ===========================
import fs from "fs/promises";
import puppeteer from "puppeteer";
import { buildDiscordMessageForItem } from "./discordFormat.js";

const fetchHttp = (typeof fetch !== "undefined")
  ? fetch
  : (await import("node-fetch")).default;

// ======================= CONFIG ===========================
const PROFILES = (process.env.VINTED_PROFILE_URLS || "")
  .split(",").map(u => u.trim()).filter(Boolean);

const HOURS = parseInt(process.env.ONLY_NEWER_HOURS || "24", 10);
const MAX_ITEMS_PER_PROFILE = parseInt(process.env.MAX_ITEMS_PER_PROFILE || "20", 10);
const MAX_NEW_PER_PROFILE = parseInt(process.env.MAX_NEW_PER_PROFILE || "5", 10);
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const STATE_PATH = "vinted_state.json";

// ======================= STATE (ANTI-DUPLICAÇÃO) ===================
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

// ======================= HELPERS ===========================
const log = (...a) => console.log(...a);
const short = (t, m = 250) => {
  if (!t) return "";
  const c = t.replace(/\s+/g, " ").trim();
  return c.length > m ? c.slice(0, m) + "..." : c;
};
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);

// “há 35 minutos”, “há 5 dias”, “há 1 hora”
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

// ======================= PUPPETEER UTILS ===========================
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

// ======================= SCRAPERS ===========================
function pickFromSrcset(srcset) {
  if (!srcset) return null;
  // pega o último URL (normalmente o maior)
  const parts = srcset.split(",").map(s => s.trim().split(" ")[0]).filter(Boolean);
  return parts[parts.length - 1] || parts[0] || null;
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
  const links = [...new Set(rawLinks)].slice(0, MAX_ITEMS_PER_PROFILE);

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

    // Título
    const title = textOf("h1") || document.title || "";

    // Descrição (backup, não vamos mostrar por enquanto)
    const description = "";

    // ===== PREÇO SUPER ROBUSTO =====
    let price = "";
    let currency = "";

    // 1) meta tags (mais confiável)
    const metaAmount = getMeta("product:price:amount") || getMeta("og:price:amount");
    const metaCurrency = getMeta("product:price:currency") || getMeta("og:price:currency");
    if (metaAmount) {
      price = metaAmount.trim();
      currency = (metaCurrency || "EUR").trim();
    } else {
      // 2) número + símbolo (variações)
      const sidebarText = (sidebar.innerText || "").replace(/\s+/g, " ");
      let m =
        sidebarText.match(/[€£$]\s*\d[\d.,]*/) ||
        sidebarText.match(/\b\d[\d.,]*\s*(€|EUR|GBP|USD)\b/i);
      if (m) {
        const s = m[0];
        if (/^[€£$]/.test(s)) {
          currency = s[0] === "€" ? "EUR" : (s[0] === "£" ? "GBP" : "USD");
          price = s.replace(/[€£$\s]/g, "");
        } else {
          const parts = s.trim().split(/\s+/);
          price = parts[0];
          const cur = parts[1].toUpperCase();
          currency = cur === "€" ? "EUR" : cur;
        }
      }
    }

    // ===== MARCA / TAMANHO / ESTADO / "Carregado há …" =====
    const findLabeled = (label) => {
      const root = sidebar;
      // tenta linhas onde o label aparece e o valor vem a seguir
      const rows = Array.from(root.querySelectorAll("div,li,dt,section"));
      const target = rows.find(el => el.textContent.trim().toLowerCase().startsWith(label.toLowerCase()));
      if (!target) return "";
      const a = target.querySelector("a");
      if (a?.textContent) return a.textContent.trim();
      // procura o nó exacto do label e lê o irmão
      const labEl = Array.from(target.querySelectorAll("span,div,dt")).find(
        el => el.textContent.trim().toLowerCase() === label.toLowerCase()
      );
      if (labEl?.nextElementSibling?.textContent)
        return labEl.nextElementSibling.textContent.trim();
      // fallback: remove label do texto
      return target.textContent.replace(new RegExp("^" + label, "i"), "").trim();
    };

    let brand = findLabeled("Marca").replace(/Menu da marca/gi, "").split("\n")[0].trim();
    const size = findLabeled("Tamanho");
    const condition = findLabeled("Estado");
    const loadedAgo = findLabeled("Carregado");

    // ===== FEEDBACKS (opiniões do vendedor) =====
    // procura por algo tipo "Feedbacks (12)" / "Opiniões (3)" no texto do sidebar/body
    let feedbacks = null;
    const fbMatch =
      bodyText.match(/(Feedbacks|Opiniões|Avaliações)\s*\((\d+)\)/i) ||
      bodyText.match(/⭐\s*\((\d+)\)/i);
    if (fbMatch) {
      feedbacks = parseInt(fbMatch[2] || fbMatch[1], 10);
      if (Number.isNaN(feedbacks)) feedbacks = null;
    }

    // ===== FOTOS (tenta srcset + og:image) =====
    const urls = new Set();

    // meta og:image
    const ogImage = getMeta("og:image");
    if (ogImage) urls.add(ogImage);

    // imagens da galeria
    document.querySelectorAll("img").forEach(img => {
      const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset");
      if (srcset) {
        const candidate = srcset.split(",").map(s => s.trim().split(" ")[0]).filter(Boolean).pop();
        if (candidate && /^https?:\/\//i.test(candidate)) urls.add(candidate);
      }
      const src = img.getAttribute("src") || img.getAttribute("data-src");
      if (src && /^https?:\/\//i.test(src)) urls.add(src);
    });

    return {
      title,
      url: location.href,
      description,
      price: price ? price.replace(/\s/g, "") : "",
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

// ======================= MAIN ===========================
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

      // createdAt a partir de “Carregado há …”
      for (const it of items) {
        const dt = parseRelativePt(it.loadedAgo);
        it.createdAt = dt ? dt.toISOString() : new Date().toISOString();
      }

      // filtro tempo + anti-duplicação
      const candidatos = items
        .filter(it => new Date(it.createdAt) >= cutoff)
        .filter(it => !state.posted[it.url]);

      const toPost = candidatos.slice(0, MAX_NEW_PER_PROFILE);

      for (const item of toPost) {
        await postToDiscord({
          ...item,
          description: short(item.description, 280),
          photos: (item.photos || []).slice(0, 3), // 1 + 2 thumbs
        });

        state.posted[item.url] = { ts: Date.now() };
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
