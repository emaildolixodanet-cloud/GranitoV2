// ======================= IMPORTS E SETUP ===========================
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";
import buildDiscordMessageForItem from "./discordFormat.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// fetch: Node 20 já tem fetch global, mas garantimos fallback
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
const TEST_MODE = String(process.env.TEST_MODE || "false").toLowerCase() === "true";

const STATE_FILE = path.join(__dirname, "vinted_state.json");

// ======================= AUX ===========================
function log(...args) {
  console.log(...args);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ensureStateFile() {
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ posted: {}, lastPrune: 0 }, null, 2));
  }
}
function loadState() {
  ensureStateFile();
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { posted: {}, lastPrune: 0 };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function extractItemIdFromUrl(url) {
  // Ex.: https://www.vinted.pt/items/123456789-nome-do-artigo
  const m = url.match(/\/items\/(\d+)/);
  return m ? m[1] : url; // fallback: usa url inteira
}

async function postToDiscord(item) {
  if (!WEBHOOK) throw new Error("DISCORD_WEBHOOK_URL não configurado");
  const payload = buildDiscordMessageForItem(item);
  const res = await fetchHttp(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Falha no Webhook (${res.status}): ${txt.slice(0, 200)}`);
  }
}

// ======================= SCRAPER ===========================
async function scrapeProfile(browser, profileUrl) {
  const page = await browser.newPage();
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Aguarda o body e algum carregamento
  await page.waitForSelector("body", { timeout: 30000 }).catch(() => null);

  // Captura links para /items/
  const itemLinks = await page.$$eval("a[href*='/items/']", (links) =>
    links.map((a) => a.href)
  ).catch(() => []);

  const uniqueLinks = [...new Set(itemLinks)].slice(0, MAX_ITEMS_PER_PROFILE);
  await page.close();

  const results = [];
  for (const link of uniqueLinks) {
    try {
      const itemPage = await browser.newPage();
      await itemPage.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 });

      // Tentamos extrair dados estruturados e do DOM
      const data = await itemPage.evaluate(() => {
        const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || "";

        // Título
        let title = document.querySelector("h1")?.textContent?.trim()
          || document.title.replace(/\s*\|\s*Vinted.*$/i, "").trim();

        // Preço (tentativas por data-testid, atributos e fallback)
        let price = "";
        const priceNode =
          document.querySelector("[data-testid='item-price']") ||
          document.querySelector("data[item-price]") ||
          document.querySelector("meta[itemprop='price']") ||
          document.querySelector("span[class*='price']");

        if (priceNode) {
          price = (priceNode.getAttribute?.("content") || priceNode.textContent || "").trim();
        }

        // Tamanho / Marca / Estado (depende do layout da Vinted; fazemos tentativas genéricas)
        let size = "";
        let brand = "";
        let condition = "";

        // Tenta apanhar pares label: value
        document.querySelectorAll("div, li").forEach((el) => {
          const t = el.textContent?.toLowerCase() || "";
          if (!size && /tamanho|tam/i.test(t)) size = el.textContent.trim();
          if (!brand && /marca/i.test(t)) brand = el.textContent.trim();
          if (!condition && /(estado|condiç)/i.test(t)) condition = el.textContent.trim();
        });

        // Fotos (prioriza imagens grandes / CDN)
        const imgs = Array.from(document.querySelectorAll("img"))
          .map((i) => i.src || i.getAttribute("data-src") || "")
          .filter((src) => src && /^https?:\/\//i.test(src));
        // Ordena por "maior" (heurística: as de thumbnails às vezes terminam com tamanhos pequenos)
        const uniqueImgs = Array.from(new Set(imgs));

        // Feedbacks do vendedor (quando visível no perfil do item)
        let sellerFeedbackCount = null;
        const feedbackCandidate = Array.from(document.querySelectorAll("a, span, div"))
          .map((el) => el.textContent?.trim() || "")
          .find((t) => /\b(opini(ões|ao)|feedback|avalia(ç|c)ões?)\b/i.test(t) && /\d+/.test(t));
        if (feedbackCandidate) {
          const n = feedbackCandidate.match(/\d+/);
          if (n) sellerFeedbackCount = parseInt(n[0], 10);
        }

        return {
          title: title || "Artigo Vinted",
          url: location.href,
          price: price || "",
          currency: "EUR",
          size,
          brand,
          condition,
          photos: uniqueImgs.slice(0, 3),
          sellerFeedbackCount: Number.isFinite(sellerFeedbackCount)
            ? sellerFeedbackCount
            : undefined,
        };
      });

      await itemPage.close();
      results.push({ ...data, id: extractItemIdFromUrl(link) });
      // Pequena pausa entre itens
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      log("Erro ao extrair item:", e.message);
    }
  }

  return results;
}

// ======================= TESTE MANUAL (TEST_MODE) ===================
async function runTestOnce() {
  const demo = {
    id: "demo-123",
    title: "👗 Vestido comprido floral ZARA",
    url: "https://www.vinted.pt/items/123456789-vestido-zara-floral",
    price: "19.99",
    currency: "EUR",
    size: "M",
    brand: "Zara",
    condition: "Como novo",
    sellerFeedbackCount: 128,
    photos: [
      "https://images.vinted.net/thumbs/f800x800/01_demo_img1.jpg",
      "https://images.vinted.net/thumbs/f800x800/01_demo_img2.jpg",
      "https://images.vinted.net/thumbs/f800x800/01_demo_img3.jpg",
    ],
  };
  log("🧪 TESTE: a publicar item de demonstração no Discord...");
  await postToDiscord(demo);
  log("✅ Teste enviado!");
}

// ======================= EXECUÇÃO NORMAL ===========================
async function run() {
  if (TEST_MODE) {
    await runTestOnce();
    return;
  }

  if (!PROFILES.length) {
    console.error("Nenhum perfil configurado em VINTED_PROFILE_URLS!");
    return;
  }
  if (!WEBHOOK) {
    console.error("DISCORD_WEBHOOK_URL não configurado!");
    return;
  }

  const state = loadState();
  let totalEncontrados = 0;
  let totalPublicados = 0;

  log(`🔎 A verificar ${PROFILES.length} perfis (últimas ${HOURS}h) ...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  for (const profile of PROFILES) {
    log(`→ Perfil: ${profile}`);
    try {
      const items = await scrapeProfile(browser, profile);
      totalEncontrados += items.length;

      // Filtra apenas os ainda não publicados
      const novos = items.filter((it) => !state.posted[it.id]).slice(0, MAX_NEW_PER_PROFILE);

      for (const item of novos) {
        try {
          await postToDiscord(item);
          state.posted[item.id] = Date.now();
          totalPublicados++;
          await sleep(1000); // curto delay para não spammar o Discord
        } catch (e) {
          log("Falha ao publicar no Discord:", e.message);
        }
      }
    } catch (err) {
      log("Erro geral:", err.message);
    }
  }

  await browser.close();

  // Pequena manutenção: limpa IDs antigos do mapa (ex: mais de 30 dias)
  const THIRTY_DAYS = 30 * 24 * 3600 * 1000;
  const now = Date.now();
  if (!state.lastPrune || now - state.lastPrune > 24 * 3600 * 1000) {
    for (const [id, ts] of Object.entries(state.posted)) {
      if (now - ts > THIRTY_DAYS) delete state.posted[id];
    }
    state.lastPrune = now;
  }

  saveState(state);
  log(`📦 Resumo: encontrados=${totalEncontrados}, publicados=${totalPublicados}`);
}

// ======================= START ===========================
run().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
