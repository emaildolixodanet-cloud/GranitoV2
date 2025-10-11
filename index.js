// ======================= IMPORTS E SETUP ===========================
import fs from "fs/promises";
import puppeteer from "puppeteer";
import { buildDiscordMessageForItem } from "./discordFormat.js";

// fetch: Node 20 tem fetch global; fallback para node-fetch se não houver
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
const WEBHOOK_STYLE = (process.env.WEBHOOK_STYLE || "hybrid").toLowerCase();

const STATE_PATH = "vinted_state.json";

// ======================= ESTADO (ANTI-DUPLICAÇÃO) ===========================
async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const st = JSON.parse(raw);
    if (!st.posted) st.posted = {};
    if (!st.lastPrune) st.lastPrune = 0;
    return st;
  } catch {
    return { posted: {}, lastPrune: 0 };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// remove marcas antigas do mapa (default 14 dias)
function pruneState(state, days = 14) {
  const now = Date.now();
  if (now - (state.lastPrune || 0) < 6 * 3600 * 1000) return; // só a cada 6h
  const cutoff = now - days * 24 * 3600 * 1000;
  for (const [k, v] of Object.entries(state.posted)) {
    if (!v?.ts || v.ts < cutoff) delete state.posted[k];
  }
  state.lastPrune = now;
}

// ======================= HELPERS ===========================
function log(...args) {
  console.log(...args);
}

function short(txt, max = 250) {
  if (!txt) return "";
  const clean = txt.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "..." : clean;
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000);
}

// "há 35 minutos", "há 5 dias", "há 1 hora", "há uma hora", etc.
function parseRelativePt(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  // valores "um/uma"
  if (/há\s+um(a)?\s+min/.test(t)) return new Date(Date.now() - 1 * 60 * 1000);
  if (/há\s+um(a)?\s+hora/.test(t)) return new Date(Date.now() - 1 * 3600 * 1000);
  if (/há\s+um(a)?\s+dia/.test(t)) return new Date(Date.now() - 24 * 3600 * 1000);

  let m;
  if ((m = t.match(/há\s+(\d+)\s+min/))) {
    const n = parseInt(m[1], 10);
    return new Date(Date.now() - n * 60 * 1000);
  }
  if ((m = t.match(/há\s+(\d+)\s+hora/))) {
    const n = parseInt(m[1], 10);
    return new Date(Date.now() - n * 3600 * 1000);
  }
  if ((m = t.match(/há\s+(\d+)\s+dia/))) {
    const n = parseInt(m[1], 10);
    return new Date(Date.now() - n * 24 * 3600 * 1000);
  }
  return null;
}

async function postToDiscord(item) {
  if (!WEBHOOK) throw new Error("DISCORD_WEBHOOK_URL não configurado");
  const payload = WEBHOOK_STYLE === "v1"
    ? {
        embeds: [
          {
            title: item.title || "Novo artigo",
            url: item.url,
            description: short(item.description, 250),
            fields: [
              item.price ? { name: "💰 Preço", value: `${item.price} ${item.currency || ""}`.trim(), inline: true } : null,
              item.size ? { name: "📐 Tamanho", value: item.size, inline: true } : null,
              item.brand ? { name: "🏷️ Marca", value: item.brand, inline: true } : null,
            ].filter(Boolean),
            image: item.photos?.[0] ? { url: item.photos[0] } : undefined,
            footer: { text: "Vinted Bot - Layout V1" },
          },
        ],
      }
    : buildDiscordMessageForItem(item);

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
    await page.waitForTimeout ? page.waitForTimeout(delayMs) : new Promise(r => setTimeout(r, delayMs));
  }
  // volta ao topo para garantir que selectores estáveis rendem
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function ensureAtLeastOneItemLink(page, timeoutMs = 10000) {
  try {
    await page.waitForSelector('a[href*="/items/"]', { timeout: timeoutMs });
  } catch {
    // segue em frente — alguns perfis podem estar vazios
  }
}

// ======================= SCRAPER ===========================
async function scrapeProfile(browser, url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("body", { timeout: 30000 }).catch(() => null);

  // força o carregamento de mais cards
  await autoScroll(page, 12, 1400, 200);
  await ensureAtLeastOneItemLink(page);

  // recolhe links dos artigos
  const rawLinks = await page.$$eval('a[href*="/items/"]', (links) =>
    links.map((a) => a.href)
  );
  const uniqueItems = [...new Set(rawLinks)].slice(0, MAX_ITEMS_PER_PROFILE);

  const scraped = [];
  for (const link of uniqueItems) {
    try {
      const it = await scrapeItem(browser, link);
      if (it) scraped.push(it);
    } catch (e) {
      log("  • Erro a extrair item:", e.message);
    }
  }

  await page.close();
  return scraped;
}

async function scrapeItem(browser, link) {
  const page = await browser.newPage();
  await page.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("body", { timeout: 30000 }).catch(() => null);

  // dá um pequeno scroll para forçar imagens e painel
  await autoScroll(page, 2, 800, 150);

  const data = await page.evaluate(() => {
    const selText = (sel) => document.querySelector(sel)?.textContent?.trim() || "";

    // título/descrição
    const title = selText("h1") || document.title || "";
    // descrição típica dentro do painel da direita (parágrafo principal)
    let description = "";
    const rightPanel = document.querySelector('[data-testid="sidebar"]') || document.querySelector("aside") || document;
    // tenta um parágrafo maior
    const descCand = rightPanel.querySelector("p, div[data-testid='item-description']");
    if (descCand) description = descCand.textContent.trim();

    // preço
    let price = "";
    let currency = "";
    const priceNode = document.querySelector("[data-testid='item-price'], [data-testid='price'], [class*='price'] span");
    if (priceNode) {
      const tx = priceNode.textContent.trim();
      // ex: "€ 40,00" ou "40,00 €"
      const m = tx.match(/([\d.,]+)\s*([A-Z€]+)/i) || tx.match(/([€])\s*([\d.,]+)/i);
      if (m) {
        if (m[2] && m[1].includes(",")) { // "€ 40,00"
          price = m[2] ? m[2] : m[1];
          currency = m[2] ? m[1] : "EUR";
        } else if (m[1] && m[2]) { // "40,00 €"
          price = m[1]; currency = m[2];
        } else {
          price = tx;
        }
      } else {
        price = tx;
      }
    }

    // fotos (unicas, https)
    const imgs = Array.from(document.querySelectorAll("img"))
      .map(i => i.getAttribute("src") || i.getAttribute("data-src") || "")
      .filter(u => u && /^https?:\/\//i.test(u));

    // leitura de campos rotulados (Marca, Tamanho, Estado, Carregado)
    const grabField = (label) => {
      // procura um span ou div cujo texto seja exatamente o label
      const candidates = Array.from(document.querySelectorAll("span,div,dt")).filter(
        el => el.textContent.trim() === label
      );
      for (const labEl of candidates) {
        // valor normalmente está no irmão seguinte
        const vEl = labEl.nextElementSibling;
        if (vEl && vEl.textContent) return vEl.textContent.trim();
        // fallback: remove o label do texto do pai
        const parent = labEl.parentElement;
        if (parent) {
          const t = parent.textContent.replace(label, "").trim();
          if (t) return t;
        }
      }
      // fallback por contains
      const any = Array.from(document.querySelectorAll("div,li")).find(el =>
        el.textContent.trim().startsWith(label + " ")
      );
      if (any) return any.textContent.replace(label, "").trim();
      return "";
    };

    const brand = grabField("Marca");
    const size = grabField("Tamanho");
    const condition = grabField("Estado");
    const loadedAgo = grabField("Carregado"); // e.g. "há 35 minutos"

    return {
      title,
      url: location.href,
      description,
      price,
      currency,
      brand,
      size,
      condition,
      loadedAgo,           // texto relativo
      photos: Array.from(new Set(imgs)).slice(0, 6),
    };
  });

  await page.close();
  return data;
}

// ======================= MAIN ===========================
run().catch(async (err) => {
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

  log(`🔎 A verificar ${PROFILES.length} perfis (últimas ${HOURS}h) ...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const cutoff = hoursAgo(HOURS);
  let totalEncontrados = 0;
  let totalPublicados = 0;

  for (const profile of PROFILES) {
    log(`→ Perfil: ${profile}`);

    try {
      const items = await scrapeProfile(browser, profile);
      totalEncontrados += items.length;

      // normaliza createdAt a partir de "Carregado há ..."
      for (const it of items) {
        const dt = parseRelativePt(it.loadedAgo);
        it.createdAt = dt ? dt.toISOString() : new Date().toISOString();
      }

      // filtra por tempo e anti-duplicação (por URL)
      const candidatos = items
        .filter(it => new Date(it.createdAt) >= cutoff)
        .filter(it => !state.posted[it.url]);

      // limita por perfil
      const toPost = candidatos.slice(0, MAX_NEW_PER_PROFILE);

      for (const item of toPost) {
        await postToDiscord({
          ...item,
          // trims finais
          description: short(item.description, 280),
          photos: (item.photos || []).slice(0, 3), // 1 principal + 2 extra
        });
        totalPublicados++;

        // marca como publicado imediatamente (reduz risco de duplicação entre runs paralelas)
        state.posted[item.url] = { ts: Date.now() };
        await saveState(state);

        // rate limit de segurança
        await new Promise(r => setTimeout(r, 1200));
      }
    } catch (err) {
      log("Erro geral:", err.message);
    }
  }

  await browser.close();
  await saveState(state);
  log(`📦 Resumo: encontrados=${totalEncontrados}, publicados=${totalPublicados}`);
}
