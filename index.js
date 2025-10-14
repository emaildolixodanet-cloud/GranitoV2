import puppeteer from "puppeteer";
import fs from "fs/promises";
import fetch from "node-fetch";

// ---------- Config via ENV ----------
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.error("❌ Falta DISCORD_WEBHOOK_URL nos Secrets.");
  process.exit(1);
}

const PROFILE_URLS = (process.env.VINTED_PROFILE_URLS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (PROFILE_URLS.length === 0) {
  console.error("❌ VINTED_PROFILE_URLS vazio. Defina em Repository Variables.");
  process.exit(1);
}

const ONLY_NEWER_HOURS = Number(process.env.ONLY_NEWER_HOURS || 24);
const MAX_ITEMS_PER_PROFILE = Number(process.env.MAX_ITEMS_PER_PROFILE || 10);
const MAX_NEW_PER_PROFILE = Number(process.env.MAX_NEW_PER_PROFILE || 5);
const TEST_MODE = String(process.env.TEST_MODE || "false").toLowerCase() === "true";

const STATE_FILE = "vinted_state.json";
const NOW = Date.now();
const cutoffMs = NOW - ONLY_NEWER_HOURS * 60 * 60 * 1000;

// ---------- Utils ----------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { posted: {}, lastPrune: 0 };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function sanitizeText(s) {
  if (!s && s !== 0) return undefined;
  const t = String(s).trim();
  return t.length ? t : undefined;
}

function toDiscordEmbed(item) {
  const title = sanitizeText(item.title) || "Novo artigo no Vinted";
  const url = sanitizeText(item.url);
  const price = sanitizeText(item.price);
  const size = sanitizeText(item.size);
  const brand = sanitizeText(item.brand);
  const user = sanitizeText(item.seller);

  const descriptionParts = [];
  if (brand) descriptionParts.push(`**Marca:** ${brand}`);
  if (size) descriptionParts.push(`**Tamanho:** ${size}`);
  if (price) descriptionParts.push(`**Preço:** ${price}`);
  const description = descriptionParts.join(" · ");

  // Nunca enviar campos vazios ao Discord
  const embed = {
    title,
    url,
    description: sanitizeText(description),
    thumbnail: item.photo ? { url: item.photo } : undefined,
    footer: user ? { text: `Vendedor: ${user}` } : undefined,
    timestamp: new Date(item.ts).toISOString(),
    color: 0x2a9d8f // verde teal
  };

  // limpar undefineds
  Object.keys(embed).forEach((k) => embed[k] === undefined && delete embed[k]);
  return embed;
}

async function postToDiscord(items) {
  if (!items.length) return { ok: true, posted: 0 };

  // Discord: max 10 embeds por payload – enviamos em lotes de até 10
  const chunks = [];
  for (let i = 0; i < items.length; i += 10) {
    chunks.push(items.slice(i, i + 10));
  }

  let posted = 0;
  for (const chunk of chunks) {
    const embeds = chunk.map(toDiscordEmbed).filter(e => e && typeof e === "object");
    if (!embeds.length) continue;

    const payload = { embeds };
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`❌ Falha no webhook Discord: ${res.status} ${res.statusText} ${body}`);
      // Não abortar o job por 1 lote falhado
      continue;
    }
    posted += embeds.length;
    await sleep(1200); // pequena pausa para não bater rate limit
  }
  return { ok: true, posted };
}

// ---------- Scraper ----------
async function scrapeProfile(page, profileUrl) {
  // Nota: este seletor e parsing são “genéricos”. Se o teu HTML do Vinted
  // mudou, ajusta os seletores abaixo.
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(1500);

  // tentar carregar mais items (scroll simples)
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1000);
  }

  const items = await page.evaluate(() => {
    const list = [];
    // Ajusta este seletor ao layout atual do Vinted
    const cards = document.querySelectorAll('a[href*="/items/"]');

    cards.forEach((a) => {
      const url = a.href;
      const title =
        a.getAttribute("title") ||
        a.querySelector("[data-testid='item-title']")?.textContent ||
        a.querySelector("h3,h2")?.textContent ||
        "";
      const price =
        a.querySelector("[data-testid='item-price']")?.textContent ||
        a.querySelector(".price")?.textContent ||
        "";
      const size =
        a.querySelector("[data-testid='item-size']")?.textContent ||
        a.querySelector(".size")?.textContent ||
        "";
      const brand =
        a.querySelector("[data-testid='item-brand']")?.textContent ||
        a.querySelector(".brand")?.textContent ||
        "";
      const img =
        a.querySelector("img")?.src ||
        a.querySelector("img")?.getAttribute("data-src") ||
        "";

      if (!url.includes("/items/")) return;

      list.push({
        url,
        title: title?.trim(),
        price: price?.trim(),
        size: size?.trim(),
        brand: brand?.trim(),
        photo: img || null
      });
    });

    // remover duplicados por URL
    const seen = new Set();
    return list.filter((i) => {
      if (seen.has(i.url)) return false;
      seen.add(i.url);
      return true;
    });
  });

  // anexar info extra
  const enriched = items.slice(0, MAX_ITEMS_PER_PROFILE).map((i) => ({
    ...i,
    seller: profileUrl.replace(/^https?:\/\//, "").split("/")[1] || "vendedor",
    ts: Date.now() // sem API oficial, usamos “agora” (o filtro temporal é à hora da run)
  }));

  return enriched;
}

// ---------- Main ----------
(async () => {
  const state = await loadState();
  let found = 0;
  let toPublish = [];

  console.log(`🔎 A verificar ${PROFILE_URLS.length} perfis (últimas ${ONLY_NEWER_HOURS}h) ...`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    for (const url of PROFILE_URLS) {
      console.log(`→ Perfil: ${url}`);
      const page = await browser.newPage();

      try {
        const items = await scrapeProfile(page, url);
        found += items.length;

        // filtro temporal + já publicados
        const fresh = items
          .filter((i) => i.ts >= cutoffMs)
          .filter((i) => {
            const key = state.posted[i.url] ? i.url : `item:${(i.url.match(/\/items\/(\d+)/) || [])[1] || i.url}`;
            return !state.posted[key];
          })
          .slice(0, MAX_NEW_PER_PROFILE);

        // registar para publicar
        toPublish.push(...fresh);
      } catch (err) {
        console.warn(`⚠️ Erro a scrapar ${url}: ${err.message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // limitar total a publicar por run (opcional – aqui não limitamos globalmente)
  const willPublish = TEST_MODE ? [] : toPublish;

  // publicar no Discord
  const result = await postToDiscord(willPublish);

  // atualizar estado
  const nowTs = Date.now();
  for (const it of willPublish) {
    // guardar por URL e também por id normalizado (evita reposts se URL mudar com slug)
    const idMatch = it.url.match(/\/items\/(\d+)/);
    const keyById = idMatch ? `item:${idMatch[1]}` : null;

    state.posted[it.url] = { ts: nowTs, url: it.url };
    if (keyById) state.posted[keyById] = { ts: nowTs, url: it.url };
  }

  // pruning ocasional do mapa posted (mantém últimos 7 dias)
  if (!state.lastPrune || nowTs - state.lastPrune > 24 * 60 * 60 * 1000) {
    const sevenDaysAgo = nowTs - 7 * 24 * 60 * 60 * 1000;
    for (const [k, v] of Object.entries(state.posted)) {
      if (!v?.ts || v.ts < sevenDaysAgo) delete state.posted[k];
    }
    state.lastPrune = nowTs;
  }

  await saveState(state);

  console.log(`📦 Resumo: encontrados=${found}, a_publicar=${willPublish.length}`);
  if (TEST_MODE) {
    console.log("🧪 TEST_MODE=TRUE → não publicou no Discord.");
  }
})();
