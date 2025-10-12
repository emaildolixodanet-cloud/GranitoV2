// index.js
/* eslint-disable no-console */
import fs from "fs";
import path from "path";
import process from "process";
import puppeteer from "puppeteer";

// ---------- ENV ----------
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const PROFILE_URLS = (process.env.VINTED_PROFILE_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ONLY_NEWER_HOURS = Number(process.env.ONLY_NEWER_HOURS || 24); // filtra por idade relativa
const MAX_ITEMS_PER_PROFILE = Number(process.env.MAX_ITEMS_PER_PROFILE || 10); // scan superficial por perfil
const MAX_NEW_PER_PROFILE = Number(process.env.MAX_NEW_PER_PROFILE || 5); // limite de posts por perfil/run
const TEST_MODE = String(process.env.TEST_MODE || "false").toLowerCase() === "true";

// ---------- STATE ----------
const STATE_FILE = path.resolve("vinted_state.json");
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const obj = JSON.parse(raw);
    // normalizar estrutura mínima
    obj.posted ||= {};
    obj.lastPrune ||= 0;
    return obj;
  } catch (e) {
    return { posted: {}, lastPrune: 0 };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// prunes registos > 14 dias para manter leve
function pruneState(state, now = Date.now()) {
  const TWO_WEEKS = 14 * 24 * 3600 * 1000;
  if (now - (state.lastPrune || 0) < 6 * 3600 * 1000) return; // só de 6h em 6h
  let removed = 0;
  for (const [k, v] of Object.entries(state.posted)) {
    if (v?.ts && now - v.ts > TWO_WEEKS) {
      delete state.posted[k];
      removed++;
    }
  }
  state.lastPrune = now;
  if (removed) console.log(`🧹 Limpou ${removed} entradas antigas do estado.`);
}

// ---------- UTILS ----------
function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function uniqueBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

function extractItemIdFromUrl(url) {
  // Ex.: https://www.vinted.pt/items/7276353124-camisola...
  const m = String(url).match(/\/items\/(\d+)/);
  return m ? m[1] : null;
}

function postedKeyFor(item) {
  if (item.id) return `item:${item.id}`;
  return item.url; // fallback muito raro
}

// "há 35 min", "há 1 hora", "há 2 horas", "há 3 dias"
function parsePortugueseRelative(str) {
  if (!str) return null;
  const s = str.toLowerCase().trim();

  // Números
  const num = (re) => {
    const m = s.match(re);
    if (!m) return null;
    return Number(m[1]);
  };

  // minutos
  let n =
    num(/há\s+(\d+)\s*min/) ||
    num(/há\s+(\d+)\s*mins?/) ||
    num(/(\d+)\s*min\s*atrás/) ||
    null;
  if (n != null) return n * 60 * 1000;

  // horas
  n =
    num(/há\s+(\d+)\s*h/) ||
    num(/há\s+(\d+)\s*horas?/) ||
    num(/(\d+)\s*h\s*atrás/) ||
    null;
  if (n != null) return n * 3600 * 1000;

  // dias
  n = num(/há\s+(\d+)\s*dias?/) || num(/(\d+)\s*dias?\s*atrás/);
  if (n != null) return n * 24 * 3600 * 1000;

  // "há 1 dia" explícito
  if (/há\s*1\s*dia/.test(s)) return 24 * 3600 * 1000;

  // fallback
  return null;
}

function withinHours(msAgo, hours) {
  if (msAgo == null) return true; // se não conseguir ler, não filtra
  return msAgo <= hours * 3600 * 1000;
}

function formatPrice(eurosString) {
  // Normalizar ex: "19,99 €" -> "19,99 €"; aceitar "€19.99"
  let s = (eurosString || "").trim();
  if (!s) return null;
  // já vem com "€"? então usa
  if (/[€]/.test(s)) return s;
  // senão acrescenta
  return `${s} €`;
}

function asDiscordTimestamp(date) {
  // Discord formatação relativa: <t:unix:R>
  const unix = Math.floor(date.getTime() / 1000);
  return `<t:${unix}:R>`;
}

// ---------- DISCORD ----------
async function sendToDiscord({ item, footerBrand = "Comunidade GRANITO . Vinted Updates" }) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn("⚠️ DISCORD_WEBHOOK_URL não definido — a ignorar envio.");
    return;
  }

  const title = item.title || "Novo artigo no Vinted";
  const url = item.url;
  const price = item.price || "—";
  const size = item.size || "—";
  const brand = item.brand || "—";
  const condition = item.condition || "—";
  const postedRel = item.postedRel || null; // string "há X"
  const sellerFeedbacks = item.sellerFeedbacks ?? null;

  // imagens: principal + extra
  const img1 = item.images?.[0] || null;
  const img2 = item.images?.[1] || null;

  const fields = [
    { name: "💰 Preço", value: price, inline: true },
    { name: "📐 Tamanho", value: size, inline: true },
    { name: "🏷️ Marca", value: brand, inline: true },
    { name: "✨ Estado", value: condition, inline: true },
  ];

  if (sellerFeedbacks != null) {
    fields.push({ name: "⭐ Opiniões do vendedor", value: String(sellerFeedbacks), inline: true });
  }
  if (postedRel) {
    fields.push({ name: "⏱️ Publicado", value: postedRel, inline: true });
  }

  // Footer: "Clara Oliveira • Vinted • Bot • 11/10/2025 13:15 - Comunidade GRANITO . Vinted  Updates"
  const now = new Date();
  const pt = new Intl.DateTimeFormat("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);

  const footerText = `Clara Oliveira • Vinted • Bot • ${pt} - ${footerBrand}`;

  const embed = {
    type: "rich",
    title: `👕 ${title}`,
    url,
    fields,
    footer: { text: footerText },
  };

  // meter imagem principal como image e a extra como thumbnail (duas imagens no mesmo embed)
  if (img1) embed.image = { url: img1 };
  if (img2) embed.thumbnail = { url: img2 };

  const components = [
    {
      type: 1, // action row
      components: [
        {
          type: 2, // button
          style: 5, // link button
          label: "Comprar",
          url,
        },
      ],
    },
  ];

  const payload = {
    content: "", // sem texto solto
    embeds: [embed],
    components,
  };

  if (TEST_MODE) {
    console.log("🧪 TEST_MODE ativo — Payload Discord:");
    console.dir(payload, { depth: 5 });
    return;
  }

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Falha no webhook Discord: ${res.status} ${res.statusText} ${t}`);
  }
}

// ---------- SCRAPER ----------
async function scrapeProfile(browser, profileUrl) {
  // devolve uma lista superficial de {id,url} do perfil
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60_000);
  page.setDefaultTimeout(30_000);
  const results = [];
  try {
    await page.goto(profileUrl, { waitUntil: "networkidle2" });
    await delay(1500);

    // procurar links para /items/<id>
    const links = await page.$$eval('a[href*="/items/"]', (as) =>
      as.map((a) => a.href).filter((u) => /\/items\/\d+/.test(u))
    );

    const uniq = Array.from(new Set(links)).slice(0, MAX_ITEMS_PER_PROFILE);
    for (const url of uniq) {
      const id = (url.match(/\/items\/(\d+)/) || [])[1] || null;
      if (!id) continue;
      results.push({ id, url });
    }
  } catch (e) {
    console.warn(`⚠️ Falha a ler perfil ${profileUrl}:`, e.message);
  } finally {
    await page.close().catch(() => {});
  }
  return uniqueBy(results, (x) => x.id);
}

async function scrapeItem(browser, itemUrl) {
  // visita a página do item e extrai os campos necessários
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60_000);
  page.setDefaultTimeout(30_000);

  const item = {
    id: extractItemIdFromUrl(itemUrl),
    url: itemUrl,
    title: null,
    price: null,
    size: null,
    brand: null,
    condition: null,
    postedRel: null, // "há X min"
    images: [],
    sellerFeedbacks: null,
  };

  try {
    await page.goto(itemUrl, { waitUntil: "networkidle2" });
    await delay(1500);

    // Título
    try {
      item.title =
        (await page.$eval("h1", (el) => el.textContent?.trim())) ||
        (await page.$eval('[data-testid*="title"]', (el) => el.textContent?.trim()));
    } catch {}

    // Preço (vários seletores de fallback)
    try {
      item.price =
        (await page.$eval('[data-testid*="price"]', (el) => el.textContent?.trim())) ||
        (await page.$eval('div:has(span:contains("€"))', (el) => el.textContent?.trim()));
      item.price = formatPrice(item.price);
    } catch {}

    // Detalhes (marca, tamanho, estado) – usar labels comuns
    const getDetailByLabel = async (labels) => {
      const text = await page.evaluate((ls) => {
        const norm = (s) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
        const lbls = ls.map(norm);
        const all = Array.from(document.querySelectorAll("*")).slice(0, 2000);
        for (const el of all) {
          const t = (el.textContent || "").trim();
          const tn = norm(t);
          // procurar um container "Label: Valor"
          for (const l of lbls) {
            if (tn.startsWith(l + ":")) {
              return t.split(":").slice(1).join(":").trim();
            }
          }
        }
        return null;
      }, labels);
      return text;
    };

    // Tentativas por seletores específicos de ficha técnica
    async function trySpecRow(labelVariants) {
      return await page.evaluate((labels) => {
        const norm = (s) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
        const lbls = labels.map(norm);
        // tabelas/dl/linhas de detalhes
        const rows = document.querySelectorAll("tr, li, div, dt, dd, span");
        for (const r of rows) {
          const txt = (r.textContent || "").trim();
          const n = norm(txt);
          for (const l of lbls) {
            // "Marca", "Tamanho", "Estado"
            if (n.includes(l)) {
              // tenta apanhar valor depois de ":"
              const parts = txt.split(":");
              if (parts.length > 1) return parts.slice(1).join(":").trim();
            }
          }
        }
        return null;
      }, labelVariants);
    }

    item.brand =
      (await trySpecRow(["Marca", "Brand"])) || (await getDetailByLabel(["Marca", "Brand"]));

    item.size =
      (await trySpecRow(["Tamanho", "Size"])) || (await getDetailByLabel(["Tamanho", "Size"]));

    item.condition =
      (await trySpecRow(["Estado", "Condition"])) ||
      (await getDetailByLabel(["Estado", "Condition"]));

    // “há X …” (tempo relativo)
    try {
      const rel = await page.evaluate(() => {
        const cand = Array.from(document.querySelectorAll("*"))
          .map((el) => (el.textContent || "").trim())
          .filter((t) => /há\s+\d+/.test(t.toLowerCase()) || /min\s*atrás|h\s*atrás|dias\s*atrás/.test(t.toLowerCase()))
          .sort((a, b) => a.length - b.length);
        return cand[0] || null;
      });
      item.postedRel = rel ? rel.replace(/\s+/g, " ") : null;
    } catch {}

    // imagens
    try {
      const imgs = await page.$$eval("img", (els) =>
        els
          .map((img) => img.src || img.getAttribute("src") || "")
          .filter((u) => /^https?:/.test(u) && !u.includes("placeholder"))
      );
      // ordenar por resolução desc (heurística simples)
      const uniq = Array.from(new Set(imgs));
      // filtrar só as do item (heurística: tem "/images/" e não é avatar)
      const productish = uniq.filter((u) => /\/images?\//.test(u) || /\/items?\//.test(u));
      item.images = productish.slice(0, 2); // principal + 1 extra
    } catch {}

    // nº de feedbacks do vendedor
    try {
      const fbText = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("*"));
        const pts = all
          .map((el) => (el.textContent || "").trim())
          .filter(Boolean);
        // procurar “opiniões”, “avaliações”, “feedback”
        const hit =
          pts.find((t) => /opini(ões|oes)/i.test(t) && /\d+/.test(t)) ||
          pts.find((t) => /avali(a|á)ções/i.test(t) && /\d+/.test(t)) ||
          pts.find((t) => /feedback/i.test(t) && /\d+/.test(t));
        return hit || null;
      });
      if (fbText) {
        const m = fbText.match(/(\d[\d\.]*)/);
        if (m) item.sellerFeedbacks = Number(m[1].replace(/\./g, ""));
      }
    } catch {}
  } catch (e) {
    console.warn(`⚠️ Falha a ler item ${itemUrl}:`, e.message);
  } finally {
    await page.close().catch(() => {});
  }
  return item;
}

// ---------- MAIN ----------
(async () => {
  if (!PROFILE_URLS.length) {
    console.error("❌ VINTED_PROFILE_URLS está vazio.");
    process.exit(1);
  }
  const state = loadState();
  pruneState(state);

  console.log(
    `🔎 A verificar ${PROFILE_URLS.length} perfis (últimas ${ONLY_NEWER_HOURS}h) ...`
  );

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let totalFound = 0;
  let totalPosted = 0;

  try {
    for (const profileUrl of PROFILE_URLS) {
      console.log(`→ Perfil: ${profileUrl}`);

      const shallow = await scrapeProfile(browser, profileUrl);
      // limitar superficial
      const candidates = shallow.slice(0, MAX_ITEMS_PER_PROFILE);
      totalFound += candidates.length;

      const toPost = [];
      for (const c of candidates) {
        const key = postedKeyFor(c);
        if (state.posted[key]) {
          // já publicado anteriormente — salta
          continue;
        }
        // carregar detalhes do item
        const full = await scrapeItem(browser, c.url);

        // aplicar janela de “apenas recentes”
        let passTime = true;
        if (ONLY_NEWER_HOURS > 0 && full.postedRel) {
          const msAgo = parsePortugueseRelative(full.postedRel);
          passTime = withinHours(msAgo, ONLY_NEWER_HOURS);
        }

        if (!passTime) continue;
        toPost.push(full);

        // respeitar limite de novos por perfil
        if (toPost.length >= MAX_NEW_PER_PROFILE) break;
      }

      // publicar
      for (const item of toPost) {
        try {
          await sendToDiscord({ item });
          const key = postedKeyFor(item);
          state.posted[key] = { ts: Date.now(), url: item.url };
          totalPosted++;
          // pequeno intervalo para não “bombardear”
          await delay(800);
        } catch (e) {
          console.error("❌ Erro ao publicar no Discord:", e.message);
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
    saveState(state);
  }

  console.log(`📦 Resumo: encontrados=${totalFound}, publicados=${totalPosted}`);
})();
