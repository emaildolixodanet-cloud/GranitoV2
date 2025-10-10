// index.js — Vinted → Discord com Puppeteer e Fallback DOM
// 1) tenta API dentro do browser (cookies válidos)
// 2) se vier vazio, faz scraping do DOM do perfil

import puppeteer from "puppeteer";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const RAW_URLS = process.env.VINTED_PROFILE_URLS || "";
const ONLY_NEWER_HOURS = Number(process.env.ONLY_NEWER_HOURS || 24);
const MAX_ITEMS_PER_PROFILE = Number(process.env.MAX_ITEMS_PER_PROFILE || 20);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cutoffIso = (h) => { const d = new Date(); d.setHours(d.getHours() - h); return d.toISOString(); };
const sinceIso = cutoffIso(ONLY_NEWER_HOURS);

function extractUserId(url) { const m = url.match(/\/member[s]?\/(\d+)/i); return m ? m[1] : null; }
function hhmm(date) { return new Date(date).toISOString().replace("T"," ").slice(0,16); }

function normalizeItem(raw) {
  const photos = raw?.photos?.map(p => ({ url: p.url || p.full_size_url || p.thumb_url })) || [];
  const price =
    raw?.price_with_currency ||
    (raw?.price?.amount ? `${raw.price.amount} ${raw.price.currency || ""}`.trim() : "—");
  return {
    id: raw?.id,
    title: raw?.title || "Item",
    price,
    size: raw?.size_title || "—",
    condition: raw?.status || raw?.condition || "—",
    created_at: raw?.created_at || null,
    photos,
  };
}

async function sendToDiscord(item) {
  const images = (item?.photos || []).slice(0, 2).map(p => p.url).filter(Boolean);
  const embed = {
    title: item.title || "Item",
    url: `https://www.vinted.pt/items/${item.id}`,
    thumbnail: images[0] ? { url: images[0] } : undefined,
    image: images[1] ? { url: images[1] } : undefined,
    fields: [
      { name: "Preço", value: item.price || "—", inline: true },
      { name: "Tamanho", value: item.size || "—", inline: true },
      { name: "Condição", value: item.condition || "—", inline: true },
    ],
    footer: { text: `Personaliza aqui • ${hhmm(new Date())}` },
  };

  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "Vinted Bot", embeds: [embed] }),
  });

  if (!res.ok) console.error("❌ Discord webhook:", res.status, await res.text());
  else console.log(`✅ Publicado: ${item.title}`);
}

// ---------- API (no contexto da página) ----------
async function fetchViaApi(page, userId, perPage) {
  const urls = [
    `https://www.vinted.pt/api/v2/items?user_id=${userId}&order=newest_first&per_page=${perPage}`,
    `https://www.vinted.pt/api/v2/items?user_id=${userId}&per_page=${perPage}`,
  ];

  for (const apiUrl of urls) {
    const r = await page.evaluate(async (u) => {
      try {
        const res = await fetch(u, { credentials: "include" });
        const status = res.status;
        const ok = res.ok;
        const txt = await res.text();
        let json = null; try { json = JSON.parse(txt); } catch {}
        return { ok, status, json, snippet: txt.slice(0, 200) };
      } catch (e) {
        return { ok: false, status: 0, json: null, snippet: String(e) };
      }
    }, apiUrl);

    if (r.ok && r.json?.items?.length) {
      const items = r.json.items.map(normalizeItem);
      console.log(`   • Itens via API (@${userId}): ${items.length}`);
      return items;
    } else {
      console.log(`   • API vazia/erro (@${userId}) [${r.status}] => ${r.snippet}`);
    }
    await sleep(400);
  }
  return [];
}

// ---------- Fallback DOM ----------
function uniqueById(arr) {
  const seen = new Set();
  return arr.filter((x) => { if (!x.id || seen.has(x.id)) return false; seen.add(x.id); return true; });
}

async function fetchViaDom(page, maxCount) {
  // recolhe links /items/ e info básica (título, preço, imagem) da grelha
  const items = await page.evaluate((limit) => {
    const out = [];
    const anchors = Array.from(document.querySelectorAll('a[href*="/items/"]'));
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/items\/(\d+)/);
      if (!m) continue;
      const id = m[1];

      // tenta apanhar imagem e textos próximos
      const img = a.querySelector("img");
      const title = (img?.alt || a.title || a.textContent || "Item").trim();

      // tentativa de preço em elementos próximos
      let price = "—";
      const priceNode =
        a.parentElement?.querySelector('[data-testid*="price"], [class*="price"], span:has(> svg)') ||
        a.querySelector('[data-testid*="price"], [class*="price"]');
      if (priceNode) price = priceNode.textContent.trim();

      out.push({
        id,
        title,
        price,
        size: "—",
        condition: "—",
        created_at: null,
        photos: img?.src ? [{ url: img.src }] : [],
      });

      if (out.length >= limit) break;
    }
    return out;
  }, maxCount);

  const clean = uniqueById(items);
  console.log(`   • Itens via DOM: ${clean.length}`);
  return clean;
}

// ---------- MAIN ----------
async function main() {
  if (!WEBHOOK || !RAW_URLS) {
    console.error("❌ Falta DISCORD_WEBHOOK_URL ou VINTED_PROFILE_URLS");
    process.exit(1);
  }

  const urls = RAW_URLS.split(",").map(s => s.trim()).filter(Boolean);
  console.log(`🔎 A verificar ${urls.length} perfis desde ${hhmm(sinceIso)}...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=pt-PT,pt"]
  });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8" });

  let totalFound = 0;
  let totalPosted = 0;

  for (const url of urls) {
    const uid = extractUserId(url);
    if (!uid) { console.warn(`⚠️ Sem user_id em: ${url}`); continue; }

    console.log(`→ Perfil ${uid} | ${url}`);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(800);
    } catch (e) {
      console.warn(`⚠️ Falha ao abrir perfil ${uid}:`, e.message);
    }

    // 1) tenta API
    let items = await fetchViaApi(page, uid, Math.min(MAX_ITEMS_PER_PROFILE, 50));

    // 2) fallback DOM se vier 0
    if (!items.length) {
      items = await fetchViaDom(page, Math.min(MAX_ITEMS_PER_PROFILE, 50));
    }

    // filtro temporal (se item não tiver created_at, deixamos passar)
    const recent = items.filter(i => {
      if (!i.created_at) return true;
      try { return new Date(i.created_at) >= new Date(sinceIso); }
      catch { return true; }
    });

    console.log(`   • Recentes (após filtro): ${recent.length}`);
    totalFound += recent.length;

    for (const it of recent) {
      await sendToDiscord(it);
      totalPosted++;
      await sleep(600);
    }
  }

  await browser.close();
  console.log(`📦 Resumo: encontrados=${totalFound}, publicados=${totalPosted}`);
}

main().catch(e => { console.error("❌ Erro fatal:", e); process.exit(1); });
