// ======================= IMPORTS E SETUP ===========================
import fs from "fs/promises";
import puppeteer from "puppeteer";
import { buildDiscordMessageForItem } from "./discordFormat.js";

// fetch (fallback)
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

// “há 35 minutos”, “há 5 dias”, “há 1 hora”, “há uma hora”
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
    const sidebar = document.querySelector('[data-testid="sidebar"]') || document;
    const textOf = (sel, root = document) => root.querySelector(sel)?.textContent?.trim() || "";

    // Título
    const title = textOf("h1") || document.title || "";

    // Descrição (backup)
    let description = "";
    const descNode = sidebar.querySelector("p, div[data-testid='item-description']");
    if (descNode) description = descNode.textContent.trim();

    // Painel de texto inteiro para regex
    const sidebarText = (sidebar.innerText || "")
      .replace(/\s+/g, " ")
      .replace(/[,](\d{3})\b/g, ".$1"); // normaliza “1,000” -> “1.000” (por segurança)

    // ===== PREÇO ROBUSTO =====
    let price = "";
    let currency = "";

    // 1) € 51,00   |  £ 20.00  |  $ 15.50
    let m = sidebarText.match(/[€£$]\s*\d[\d.,]*/);
    if (m) {
      currency = m[0][0] === "€" ? "EUR" : (m[0][0] === "£" ? "GBP" : "USD");
      price = m[0].replace(/[€£$\s]/g, "").trim();
    } else {
      // 2) 51,00 €   |  51 EUR
      m = sidebarText.match(/\b\d[\d.,]*\s*(€|EUR|GBP|USD)\b/i);
      if (m) {
        const parts = m[0].trim().split(/\s+/);
        price = parts[0];
        const cur = parts[1].toUpperCase();
        currency = cur === "€" ? "EUR" : cur;
      }
    }

    // Fotos
    const photos = Array.from(document.querySelectorAll("img"))
      .map(i => i.getAttribute("src") || i.getAttribute("data-src") || "")
      .filter(u => u && /^https?:\/\//i.test(u));

    // Campo utilitário para pares "Label -> Valor"
    const getLabeledValue = (label) => {
      const row = Array.from(sidebar.querySelectorAll("div,li,dt,section")).find(el =>
        el.textContent.trim().toLowerCase().startsWith(label.toLowerCase())
      );
      if (!row) return "";

      // prioridade: links (marca costuma ser link)
      const a = row.querySelector("a");
      if (a && a.textContent) return a.textContent.trim();

      // senão, encontra o nó do label e lê o irmão
      const labEl = Array.from(row.querySelectorAll("span,div,dt")).find(
        el => el.textContent.trim().toLowerCase() === label.toLowerCase()
      );
      if (labEl?.nextElementSibling?.textContent) {
        return labEl.nextElementSibling.textContent.trim();
      }

      // fallback: remove o label do texto
      return row.textContent.replace(new RegExp("^" + label, "i"), "").trim();
    };

    // Marca (limpa “Menu da marca”)
    let brand = getLabeledValue("Marca")
      .replace(/Menu da marca/gi, "")
      .split("\n")[0]
      .trim();

    // Tamanho / Estado / “Carregado há …”
    const size = getLabeledValue("Tamanho");
    const condition = getLabeledValue("Estado");
    const loadedAgo = getLabeledValue("Carregado"); // ex: "há 35 minutos"

    return {
      title,
      url: location.href,
      description,
      price, currency,
      brand, size, condition,
      loadedAgo,
      photos: Array.from(new Set(photos)).slice(0, 6),
    };
  });

  await page.close();

  // Normalização extra do preço (substitui vírgula por ponto só para consistência; mantém original para visual)
  if (data && data.price) {
    data.price = data.price.replace(/\s/g, "");
  }

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
          photos: (item.photos || []).slice(0, 3), // 1 thumb no principal + 2 thumbs extra
        });

        // marca como publicado
        state.posted[item.url] = { ts: Date.now() };
        await saveState(state);

        totalPublicados++;
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      log("Erro geral:", err.message);
    }
  }

  await browser.close();
  await saveState(state);
  log(`📦 Resumo: encontrados=${totalEncontrados}, publicados=${totalPublicados}`);
}
