// index.js
// Vinted → Discord (Puppeteer). Mostra preço, 2 imagens (image + thumbnail),
// seller + feedbacks, sem duplicar (usa chave item:<ID>), e respeita limites.
// Bate 1 webhook por item para evitar "embeds": ["0"] / payloads inválidos.

const puppeteer = require("puppeteer");

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.error("Falta DISCORD_WEBHOOK_URL");
  process.exit(1);
}

const PROFILE_URLS = (process.env.VINTED_PROFILE_URLS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const ONLY_NEWER_HOURS = Number(process.env.ONLY_NEWER_HOURS || 24);
const MAX_ITEMS_PER_PROFILE = Number(process.env.MAX_ITEMS_PER_PROFILE || 10);
// Se quiseres sem limite por perfil: deixa vazio/0 em vars
const MAX_NEW_PER_PROFILE = process.env.MAX_NEW_PER_PROFILE
  ? Number(process.env.MAX_NEW_PER_PROFILE)
  : 5;

const TEST_MODE = String(process.env.TEST_MODE || "false").toLowerCase() === "true";
const POSTED_TTL_HOURS = Number(process.env.POSTED_TTL_HOURS || 0); // 0 = sem republicação
const DEBUG_SKIPS = String(process.env.DEBUG_SKIPS || (TEST_MODE ? "true" : "false")).toLowerCase() === "true";

const fs = require("fs/promises");
const path = "vinted_state.json";

function nowTs() { return Date.now(); }

// Carregar estado
async function loadState() {
  try {
    const txt = await fs.readFile(path, "utf8");
    const obj = JSON.parse(txt);
    if (!obj.posted) obj.posted = {};
    if (!obj.lastPrune) obj.lastPrune = 0;
    return obj;
  } catch {
    return { posted: {}, lastPrune: 0 };
  }
}

async function saveState(state) {
  await fs.writeFile(path, JSON.stringify(state, null, 2));
}

// Normaliza state: só chaves "item:<id>" (remove antigas por URL)
function pruneStateKeys(state) {
  const before = Object.keys(state.posted).length;
  for (const key of Object.keys(state.posted)) {
    if (!/^item:\d+$/.test(key)) {
      delete state.posted[key];
    }
  }
  const after = Object.keys(state.posted).length;
  if (DEBUG_SKIPS && before !== after) {
    console.log(`ℹ️ Limpeza de chaves antigas no state: ${before}→${after}`);
  }
}

// Expira entradas antigas se definido POSTED_TTL_HOURS
function expirePosted(state) {
  if (!POSTED_TTL_HOURS) return;
  const cutoff = nowTs() - POSTED_TTL_HOURS * 3600_000;
  for (const [k, v] of Object.entries(state.posted)) {
    if ((v?.ts || 0) < cutoff) delete state.posted[k];
  }
  state.lastPrune = nowTs();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ──────────────────────────────────────────────────────────────────────────────
// Helpers de parsing

function parsePriceText(txt) {
  if (!txt) return null;
  // Remove espaços finos, quebra de linha, etc.
  txt = txt.replace(/\s+/g, " ").trim();
  // Aceita "€ 19,99", "19,99 €", "19.99 €", etc.
  const m = txt.match(/(\d{1,3}(?:[.\s]\d{3})*|\d+)([.,]\d{2})?\s*€|€\s*(\d{1,3}(?:[.\s]\d{3})*|\d+)([.,]\d{2})?/i);
  if (!m) return null;
  const numText = (m[1] && (m[1] + (m[2] || ""))) || (m[3] && (m[3] + (m[4] || ""))) || null;
  if (!numText) return null;
  // Normaliza 1.234,56 -> 1234.56
  const normalized = numText.replace(/\./g, "").replace(/\s/g, "").replace(",", ".");
  const value = Number(normalized);
  if (!isFinite(value)) return null;
  // Apresentação PT: €12,34
  const pretty = `€${value.toFixed(2).replace(".", ",")}`;
  return { value, pretty };
}

function textOrNull(el) {
  return el ? (el.innerText || el.textContent || "").trim() : null;
}

function safeTruncate(str, max) {
  if (!str) return "";
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

function parseRelativePt(text) {
  if (!text) return null;
  // exemplos: "há 35 minutos", "há 1 hora", "há 2 dias"
  const m = text.match(/há\s+(\d+)\s+(minuto|minutos|hora|horas|dia|dias)/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    let ms = 0;
    if (unit.startsWith("minuto")) ms = n * 60_000;
    else if (unit.startsWith("hora")) ms = n * 3_600_000;
    else if (unit.startsWith("dia")) ms = n * 86_400_000;
    return new Date(Date.now() - ms);
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Scrapers

async function scrapeItem(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Espera parcial para lazy content
  await page.waitForTimeout(500);

  const data = await page.evaluate(() => {
    function q(sel) { return document.querySelector(sel); }
    function qa(sel) { return Array.from(document.querySelectorAll(sel)); }

    const url = location.href;
    const idMatch = url.match(/\/items\/(\d+)/);
    const id = idMatch ? idMatch[1] : null;

    // Título
    const title =
      (q('h1')?.innerText || q('meta[property="og:title"]')?.getAttribute("content") || "").trim();

    // Preço (múltiplos fallbacks)
    const priceCandidates = [
      '[data-testid="price"]',
      '[data-test-id="price"]',
      '[itemprop="price"]',
      'meta[property="product:price:amount"]',
      'div[class*="price"]',
      'span[class*="price"]',
      'p[class*="price"]',
      'div[data-testid*="Price"]',
    ];

    let priceText = null;
    for (const sel of priceCandidates) {
      const el = q(sel);
      if (!el) continue;
      if (el.tagName.toLowerCase() === "meta") {
        const v = el.getAttribute("content");
        if (v) { priceText = v + " €"; break; }
      } else if (el.getAttribute("content")) {
        priceText = el.getAttribute("content") + " €";
        break;
      } else {
        const t = (el.innerText || el.textContent || "").trim();
        if (t) { priceText = t; break; }
      }
    }

    // Imagens: pega 1ª como image, 2ª como thumbnail (se existir)
    const imageCandidates = [
      'img[alt][src*="images"]',
      'img[src*="/thumbs/"], img[srcset]',
      'meta[property="og:image"]',
    ];
    let images = [];
    // preferir og:image primeiro, depois imgs
    const og = q('meta[property="og:image"]')?.getAttribute("content");
    if (og) images.push(og);
    qa('img').forEach(img => {
      const s = img.getAttribute("src") || "";
      const ss = img.getAttribute("srcset") || "";
      const pick = s || ss.split(" ").shift();
      if (pick && /^https?:\/\//.test(pick) && !images.includes(pick)) images.push(pick);
    });
    images = images.slice(0, 4);

    // Campos (tamanho, marca, condição) – procurar por labels comuns
    const detailsText = qa('*').map(n => n.innerText || "").join("\n");
    function findAfter(label) {
      const re = new RegExp(`${label}\\s*[:\\-]?\\s*(.+)`, "i");
      const m = detailsText.match(re);
      return m ? m[1].split("\n")[0].trim() : null;
    }
    let size = findAfter("Tamanho") || findAfter("Tamanhos") || null;
    let brand = findAfter("Marca") || null;
    let condition = findAfter("Estado") || findAfter("Condição") || null;

    // Seller + feedbacks
    // Heurística: link de perfil e bloco de avaliação
    let sellerName = null, sellerUrl = null, feedbackCount = null, feedbackScore = null;
    const sellerLink = qa('a[href*="/member/"]').find(a => (a.innerText || "").trim().length > 0);
    if (sellerLink) {
      sellerName = sellerLink.innerText.trim();
      sellerUrl = sellerLink.href;
    }
    // tenta apanhar "Avaliações (123)" ou "Feedback (4,9 / 200)"
    const fbText = detailsText.match(/Avalia(?:ções|ção)\s*\(?(\d+)\)?/i);
    if (fbText) feedbackCount = fbText[1];
    const scoreText = detailsText.match(/(\d(?:[.,]\d)?)\s*\/\s*5/i);
    if (scoreText) feedbackScore = scoreText[1].replace(",", ".");

    // Data/relativo: procurar "há X minutos/horas/dias"
    const timeTextMatch = detailsText.match(/há\s+\d+\s+(?:minuto|minutos|hora|horas|dia|dias)/i);
    const timeText = timeTextMatch ? timeTextMatch[0] : null;

    return {
      id, url, title, priceText, images,
      size, brand, condition,
      sellerName, sellerUrl, feedbackCount, feedbackScore,
      relativeTimeText: timeText
    };
  });

  // Parse preço
  const priceParsed = parsePriceText(data.priceText);
  // Sem preço → skip (queremos sempre mostrar preço)
  if (!priceParsed) {
    if (DEBUG_SKIPS) console.log(`skip (sem preço): ${data.url}`);
    return { ...data, skipReason: "no_price" };
  }

  // Converte tempo relativo (se existir)
  let createdAt = null;
  if (data.relativeTimeText) {
    createdAt = parseRelativePt(data.relativeTimeText);
  }
  // Falhamos relativo? aceita mesmo assim (a janela de 24h será verificada por createdAt se presente)

  // Garante 2 imagens (image + thumbnail). Se só houver 1, usa a mesma nos dois slots.
  const img1 = data.images?.[0] || null;
  const img2 = data.images?.[1] || data.images?.[0] || null;

  return {
    ...data,
    price: priceParsed.pretty,
    createdAt,
    img1,
    img2,
  };
}

async function scrapeProfile(page, profileUrl, maxItems) {
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(700);

  // apanha links de items no perfil
  const itemLinks = await page.evaluate((maxItems) => {
    const as = Array.from(document.querySelectorAll('a[href*="/items/"]'))
      .map(a => a.href)
      .filter((v, i, arr) => /^https?:\/\/.+\/items\/\d+/.test(v) && arr.indexOf(v) === i);
    return as.slice(0, maxItems);
  }, maxItems);

  const results = [];
  for (const href of itemLinks) {
    try {
      const item = await scrapeItem(page, href);
      results.push(item);
    } catch (e) {
      console.log(`erro a ler item: ${href} → ${e.message}`);
    }
    // pequena pausa para não stressar
    await sleep(250);
  }
  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// Discord

async function sendDiscordEmbed(item) {
  // 1 embed por item. Respeitar limites.
  const title = safeTruncate(item.title, 200); // < 256
  const descriptionParts = [];
  if (item.size) descriptionParts.push(`**Tamanho:** ${item.size}`);
  if (item.brand) descriptionParts.push(`**Marca:** ${item.brand}`);
  if (item.condition) descriptionParts.push(`**Condição:** ${item.condition}`);
  const description = safeTruncate(descriptionParts.join(" · "), 1000);

  let sellerLine = "";
  if (item.sellerName) {
    const name = safeTruncate(item.sellerName, 100);
    const link = item.sellerUrl ? `([perfil](${item.sellerUrl}))` : "";
    sellerLine += `**Vendedor:** ${name} ${link}`.trim();
  }
  if (item.feedbackCount) {
    sellerLine += sellerLine ? " · " : "";
    sellerLine += `${item.feedbackCount} avaliações`;
  }
  if (item.feedbackScore) {
    sellerLine += sellerLine ? " · " : "";
    sellerLine += `${item.feedbackScore}/5`;
  }

  const footer = item.createdAt
    ? `Publicado ${item.relativeTimeText}`
    : `Perfil Vinted`;

  const embed = {
    title: `${title} — ${item.price}`,
    url: item.url,
    description: description || undefined,
    color: 0x2f855a, // verde suave
    fields: sellerLine ? [{ name: "Vendedor", value: sellerLine }] : undefined,
    image: item.img1 ? { url: item.img1 } : undefined,       // imagem grande
    thumbnail: item.img2 ? { url: item.img2 } : undefined,   // segunda imagem
    footer: { text: footer }
  };

  // Payload deve ter ou content ou embeds; aqui usamos embeds
  const payload = { embeds: [embed] };

  if (TEST_MODE) {
    console.log(`(TEST_MODE) → ${item.url}`);
    return { ok: true, test: true };
  }

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Falha no webhook Discord: ${res.status} ${res.statusText} ${txt}`);
  }
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────────
// Main

(async () => {
  const state = await loadState();
  pruneStateKeys(state);
  expirePosted(state);
  await saveState(state);

  if (!PROFILE_URLS.length) {
    console.log("Sem perfis configurados (VINTED_PROFILE_URLS).");
    process.exit(0);
  }

  console.log(`🔎 A verificar ${PROFILE_URLS.length} perfis (últimas ${ONLY_NEWER_HOURS}h) ...`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  let totalFound = 0;
  let totalPublished = 0;

  const cutoff = new Date(Date.now() - ONLY_NEWER_HOURS * 3600_000);

  for (const profile of PROFILE_URLS) {
    console.log(`→ Perfil: ${profile}`);
    let publishedThisProfile = 0;

    const items = await scrapeProfile(page, profile, MAX_ITEMS_PER_PROFILE);
    totalFound += items.length;

    // Ordena por createdAt desc (mais recente primeiro) se existir, senão mantém ordem
    items.sort((a, b) => {
      const ta = a.createdAt ? a.createdAt.getTime() : 0;
      const tb = b.createdAt ? b.createdAt.getTime() : 0;
      return tb - ta;
    });

    for (const it of items) {
      // Razões de skip
      if (it.skipReason === "no_price") {
        if (DEBUG_SKIPS) console.log(`  • skip: sem preço → ${it.url}`);
        continue;
      }
      if (!it.id) {
        if (DEBUG_SKIPS) console.log(`  • skip: sem ID → ${it.url}`);
        continue;
      }
      const key = `item:${it.id}`;

      // Janela temporal
      if (it.createdAt && it.createdAt < cutoff) {
        if (DEBUG_SKIPS) console.log(`  • skip: fora de janela (${it.relativeTimeText}) → ${it.url}`);
        continue;
      }

      // Anti-duplicação
      if (state.posted[key]) {
        if (DEBUG_SKIPS) console.log(`  • skip: já publicado → ${it.url}`);
        continue;
      }

      // Limite por perfil
      if (MAX_NEW_PER_PROFILE && publishedThisProfile >= MAX_NEW_PER_PROFILE) {
        if (DEBUG_SKIPS) console.log(`  • limite por perfil atingido (${MAX_NEW_PER_PROFILE})`);
        break;
      }

      // Enviar para Discord
      try {
        const r = await sendDiscordEmbed(it);
        if (r.ok) {
          state.posted[key] = { ts: nowTs(), url: it.url };
          await saveState(state);
          totalPublished += 1;
          publishedThisProfile += 1;
        }
      } catch (e) {
        console.error(`❌ Erro ao publicar no Discord: ${e.message}`);
        // Não marca como publicado em caso de erro
      }

      // evitar rate limit
      await sleep(500);
    }
  }

  await browser.close();

  console.log(`📦 Resumo: encontrados=${totalFound}, publicados=${totalPublished}`);
})().catch(async (e) => {
  console.error("Falha geral:", e);
  process.exit(1);
});
