// Vinted → Discord (detalhes por item, com 2 imagens mínimo)
// - tenta API; se falhar, varre o perfil
// - abre a página de cada item para garantir preço/tamanho/condição + imagens
// - respeita filtro temporal (ONLY_NEWER_HOURS) e limite por perfil (MAX_NEW_PER_PROFILE)

import puppeteer from "puppeteer";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const RAW_URLS = process.env.VINTED_PROFILE_URLS || "";
const ONLY_NEWER_HOURS = Number(process.env.ONLY_NEWER_HOURS || 24);
const MAX_ITEMS_PER_PROFILE = Number(process.env.MAX_ITEMS_PER_PROFILE || 30);
const MAX_NEW_PER_PROFILE = Number(process.env.MAX_NEW_PER_PROFILE || 3);
const DELAY_BETWEEN_FETCH_MS = Number(process.env.DELAY_BETWEEN_FETCH_MS || 800);
const DELAY_BETWEEN_POST_MS = Number(process.env.DELAY_BETWEEN_POST_MS || 700);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cutoffIso = (h) => { const d = new Date(); d.setHours(d.getHours() - h); return d.toISOString(); };
const SINCE_ISO = cutoffIso(ONLY_NEWER_HOURS);

const hhmm = (d) => new Date(d).toISOString().replace("T"," ").slice(0,16);
const uniq = (a) => Array.from(new Set(a));

function extractUserId(url) {
  const m = url.match(/\/member[s]?\/(\d+)/i);
  return m ? m[1] : null;
}

function normalizeFromApi(raw) {
  const photos = raw?.photos?.map(p => p?.url || p?.full_size_url || p?.thumb_url).filter(Boolean) || [];
  const price =
    raw?.price_with_currency ||
    (raw?.price?.amount ? `${raw.price.amount} ${raw.price.currency || ""}`.trim() : "—");

  return {
    id: String(raw?.id || ""),
    url: raw?.url || (raw?.id ? `https://www.vinted.pt/items/${raw.id}` : null),
    title: raw?.title || "Item",
    created_at: raw?.created_at || null,
    price,
    size: raw?.size_title || "—",
    condition: raw?.status || raw?.condition || "—",
    photos,
  };
}

async function sendToDiscord(item) {
  // Thumbnail + Image = 2 imagens (mínimo pedido)
  const images = uniq(item.photos || []).filter(Boolean);
  const embed = {
    title: item.title || "Item",
    url: item.url || (item.id ? `https://www.vinted.pt/items/${item.id}` : undefined),
    color: 0x00b894,
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
  if (!res.ok) {
    console.error("❌ Discord webhook:", res.status, await res.text());
  } else {
    console.log(`✅ Publicado: ${item.title}`);
  }
}

async function tryApiInPage(page, userId, perPage) {
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
      const items = r.json.items.map(normalizeFromApi);
      console.log(`   • Itens via API (@${userId}): ${items.length}`);
      return items;
    } else {
      console.log(`   • API vazia/erro (@${userId}) [${r.status}] => ${r.snippet}`);
    }
    await sleep(300);
  }
  return [];
}

async function listItemLinksFromProfile(page, limit) {
  // apanha links /items/ presentes na grelha do perfil
  const links = await page.evaluate((lim) => {
    const out = [];
    const anchors = Array.from(document.querySelectorAll('a[href*="/items/"]'));
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/items\/(\d+)/);
      if (!m) continue;
      const abs = href.startsWith("http") ? href : new URL(href, location.origin).href;
      out.push(abs);
      if (out.length >= lim) break;
    }
    return out;
  }, limit);
  return uniq(links);
}

async function fetchItemDetail(page, itemUrl) {
  // abre página do item e extrai título, preço, tamanho, condição e fotos
  try {
    await page.goto(itemUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(400);

    const data = await page.evaluate(() => {
      const pickText = (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.textContent || "").trim() : null;
      };

      // titulo
      const title =
        pickText('[data-testid="item-title"]') ||
        pickText('h1') ||
        document.title?.replace(/ - Vinted.*$/,'') ||
        "Item";

      // preço
      const price =
        pickText('[data-testid="item-price"]') ||
        pickText('[class*="price"]') ||
        "—";

      // tabela de detalhes (Tamanho/Condição)
      let size = "—";
      let condition = "—";
      const rows = Array.from(document.querySelectorAll('dl, table, [data-testid*="details"]')).slice(0,3);
      for (const root of rows) {
        const txt = (root.textContent || "").toLowerCase();
        if (txt.includes("tamanho") && size === "—") {
          const m = txt.match(/tamanho\s*([\w\-\s\/]+)/i);
          if (m && m[1]) size = m[1].trim();
        }
        if ((txt.includes("estado") || txt.includes("condição")) && condition === "—") {
          const m = txt.match(/(estado|condi[cç][aã]o)\s*([\w\-\s]+)/i);
          if (m && m[2]) condition = m[2].trim();
        }
      }

      // fotos
      const imgs = Array.from(document.querySelectorAll('img'))
        .map((img) => img.getAttribute("src") || "")
        .filter((u) => u && /https?:\/\//.test(u));
      const photos = Array.from(new Set(imgs)).slice(0, 5); // guardamos várias, usamos 2

      // id pelo URL (fallback)
      const m = location.pathname.match(/\/items\/(\d+)/);
      const id = m ? m[1] : null;

      return { id, title, price, size, condition, photos };
    });

    // compõe estrutura final
    return {
      ...data,
      id: String(data.id || itemUrl.match(/\/items\/(\d+)/)?.[1] || ""),
      url: itemUrl,
      created_at: null, // sem data na página; vamos depender da API para filtrar tempo
    };
  } catch (e) {
    console.warn("⚠️ Falha ao extrair", itemUrl, e.message);
    return null;
  }
}

function applyRecencyFilter(items) {
  // PRODUÇÃO: só com created_at válido e dentro da janela
  if (ONLY_NEWER_HOURS === 0) return items; // modo teste
  return items.filter(i => {
    if (!i.created_at) return false; // sem data? não publica para evitar flood
    try { return new Date(i.created_at) >= new Date(SINCE_ISO); }
    catch { return false; }
  });
}

function sortByRecencyThenId(items) {
  return items.sort((a, b) => {
    const da = a.created_at ? new Date(a.created_at).getTime() : 0;
    const db = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (db !== da) return db - da;
    const ia = Number(a.id || 0), ib = Number(b.id || 0);
    return ib - ia;
  });
}

async function main() {
  if (!WEBHOOK || !RAW_URLS) {
    console.error("❌ Falta DISCORD_WEBHOOK_URL ou VINTED_PROFILE_URLS");
    process.exit(1);
  }

  const urls = RAW_URLS.split(",").map(s => s.trim()).filter(Boolean);
  console.log(`🔎 A verificar ${urls.length} perfis desde ${hhmm(SINCE_ISO)}...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--lang=pt-PT,pt;q=0.9,en;q=0.8",
      "--window-size=1200,900",
    ],
    defaultViewport: { width: 1200, height: 900 },
  });

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8" });

  let totalFound = 0;
  let totalPosted = 0;

  for (const profileUrl of urls) {
    const uid = extractUserId(profileUrl);
    if (!uid) { console.warn(`⚠️ Sem user_id em: ${profileUrl}`); continue; }

    console.log(`\n→ Perfil ${uid} | ${profileUrl}`);
    try {
      await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(DELAY_BETWEEN_FETCH_MS);
    } catch (e) {
      console.warn(`⚠️ Falha ao abrir perfil ${uid}:`, e.message);
    }

    // 1) tenta API
    let items = await tryApiInPage(page, uid, Math.min(MAX_ITEMS_PER_PROFILE, 50));

    // 2) fallback: recolhe links na grelha do perfil
    if (!items.length) {
      const links = await listItemLinksFromProfile(page, Math.min(MAX_ITEMS_PER_PROFILE, 30));
      console.log(`   • Links via DOM no perfil: ${links.length}`);

      // para cada link, abrir a página do item e extrair tudo
      const itemPage = await browser.newPage();
      await itemPage.setExtraHTTPHeaders({ "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8" });

      const detailed = [];
      for (const href of links) {
        const det = await fetchItemDetail(itemPage, href);
        if (det) detailed.push(det);
        await sleep(300);
      }
      await itemPage.close();

      items = detailed;
    }

    // filtro temporal (só publica com data válida em produção)
    let filtered = applyRecencyFilter(items);
    console.log(`   • Candidatos (após filtro de tempo): ${filtered.length}`);

    // ordenar e limitar quantos novos por perfil
    filtered = sortByRecencyThenId(filtered).slice(0, Math.max(1, MAX_NEW_PER_PROFILE));

    // para cada item, se vier da API mas com campos fracos, enriquecemos abrindo a página do item
    const enrichPage = await browser.newPage();
    await enrichPage.setExtraHTTPHeaders({ "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8" });

    const toPublish = [];
    for (const it of filtered) {
      // se faltar preço/tamanho/condição ou tivermos < 2 fotos, enriquecemos
      const needEnrich =
        !it.price || it.price === "—" || !it.size || it.size === "—" ||
        !it.condition || it.condition === "—" ||
        !it.photos || it.photos.length < 2;

      if (needEnrich && it.url) {
        const det = await fetchItemDetail(enrichPage, it.url);
        if (det) {
          it.title = det.title || it.title;
          it.price = det.price || it.price;
          it.size = det.size || it.size;
          it.condition = det.condition || it.condition;
          // garante pelo menos 2 imagens
          const imgs = uniq([...(it.photos || []), ...(det.photos || [])]);
          it.photos = imgs;
        }
        await sleep(250);
      }

      // ainda sem 2 imagens? tenta duplicar a primeira para preencher embed
      if (!it.photos || it.photos.length < 2) {
        if (it.photos?.length === 1) it.photos.push(it.photos[0]);
      }

      toPublish.push(it);
    }
    await enrichPage.close();

    totalFound += toPublish.length;

    for (const it of toPublish) {
      await sendToDiscord(it);
      totalPosted++;
      await sleep(DELAY_BETWEEN_POST_MS);
    }
  }

  await browser.close();
  console.log(`\n📦 Resumo: encontrados=${totalFound}, publicados=${totalPosted}`);
}

main().catch(e => { console.error("❌ Erro fatal:", e); process.exit(1); });
