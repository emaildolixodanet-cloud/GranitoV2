// index.js — Vinted -> Discord (Node + Puppeteer) 100% corrigido

import fetch from "node-fetch";
import puppeteer from "puppeteer";

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.error("Falta o DISCORD_WEBHOOK_URL (secret)!");
  process.exit(1);
}

const PROFILE_URLS = (process.env.VINTED_PROFILE_URLS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (!PROFILE_URLS.length) {
  console.error("Falta a variável VINTED_PROFILE_URLS (listagem de perfis, separada por vírgulas).");
  process.exit(1);
}

// parâmetros
const ONLY_NEWER_HOURS   = parseInt(process.env.ONLY_NEWER_HOURS || "24", 10);
const MAX_ITEMS_PER_PROF = parseInt(process.env.MAX_ITEMS_PER_PROFILE || "30", 10);
const MAX_NEW_PER_PROF   = parseInt(process.env.MAX_NEW_PER_PROFILE || "3", 10);

// util
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now  = () => new Date();

// discord helpers
async function sendDiscord(content) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      typeof content === "string" ? { content } : content
    )
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.warn("Falha no webhook:", res.status, t);
  }
}

function buildEmbedFromItem(item) {
  const title  = item.title || item.brand_title || "Novo artigo";
  const url    = item.url || item.permalink || item.web_url || "";
  const price  = item.price || (item.price_numeric ? `${item.price_numeric} €` : "");
  const size   = item.size || item.size_title || "";
  const cond   = item.condition || item.condition_title || "";
  const brand  = item.brand || item.brand_title || "";

  const img1 = item.photos?.[0]?.url || item.photo?.url || item.image_url || null;
  const img2 = item.photos?.[1]?.url || null;

  const lines = [];
  if (brand) lines.push(`**Marca**: ${brand}`);
  if (size)  lines.push(`**Tamanho**: ${size}`);
  if (cond)  lines.push(`**Condição**: ${cond}`);
  if (price) lines.push(`**Preço**: ${price}`);

  return {
    username: "Vinted Bot",
    embeds: [
      {
        title,
        url,
        description: lines.join("\n") || "Personaliza aqui",
        color: 0x2f3136,
        image: img1 ? { url: img1 } : undefined,
        footer: { text: "Personaliza aqui" }
      },
      ...(img2 ? [{
        description: "—",
        image: { url: img2 },
        color: 0x2f3136
      }] : [])
    ]
  };
}

// --------- tentativas de leitura de items ----------

// 1) API pública (com fallback de idioma/país)
async function fetchProfileItemsAPI(profileId, perPage = 50) {
  const base = "https://www.vinted.pt"; // força PT
  const tries = [
    `${base}/api/v2/items?user_id=${profileId}&order=newest_first&per_page=${perPage}`,
    `${base}/api/v2/catalog/items?user_id=${profileId}&order=newest_first&per_page=${perPage}`,
  ];
  for (const url of tries) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "pt-PT,pt;q=0.9",
          "Cache-Control": "no-cache",
        },
        redirect: "follow"
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} => ${txt.slice(0, 200)}`);
      }
      const data = await res.json();
      const arr  = data?.items || data?.catalog_items || data?.data || [];
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (err) {
      console.warn("API falhou:", url, err.message);
    }
  }
  return [];
}

// 2) DOM do perfil do utilizador
async function fetchProfileItemsByDOM(browser, profileUrl, maxCount = 50) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "pt-PT,pt;q=0.9"
    });

    await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("a[href*='/items/']", { timeout: 10000 }).catch(() => {});

    // scroll leve
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 3; i++) {
        window.scrollBy(0, document.body.scrollHeight);
        await sleep(400);
      }
    });

    const links = await page.$$eval("a[href*='/items/']", as =>
      [...new Set(as.map(a => a.href))].slice(0, 200)
    );

    const items = [];
    for (const href of links) {
      if (items.length >= maxCount) break;

      // dados básicos diretamente do cartão (quando disponíveis)
      const cardSel = `a[href='${href.replace(location.origin, "")}']`;
      const baseInfo = await page.$eval(cardSel, el => {
        const root = el.closest("[data-testid]") || el.parentElement;
        if (!root) return {};
        const q = s => root.querySelector(s)?.textContent?.trim() || "";
        const img = root.querySelector("img")?.src || "";
        return {
          url: el.href,
          title: q("[data-testid*='title'], [title]") || el.title || "",
          price: q("[data-testid*='price'], [class*='price']"),
          size:  q("[data-testid*='size'], [class*='size']"),
          condition: q("[data-testid*='condition']"),
          image_url: img
        };
      }).catch(() => ({ url: href }));

      items.push(baseInfo);
    }
    return items;
  } finally {
    await page.close().catch(() => {});
  }
}

// parse data/hora abrindo página do item (sem waitForTimeout)
async function isItemRecentByDOM(browser, itemUrl) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-PT,pt;q=0.9" });

    await page.goto(itemUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await sleep(700);

    // 1) ISO via <time datetime="...">
    let iso = await page.$eval("time[datetime]", el => el.getAttribute("datetime")).catch(() => null);

    // 2) fallback “Publicado há …”
    let rawPublished = null;
    if (!iso) {
      rawPublished = await page.$eval("body", el => el.innerText).then(txt => {
        const m = txt.match(/Publicado(?:\s+em|\s+há)\s*([^\n]+)/i);
        return m ? m[0] : null;
      }).catch(() => null);
    }

    let publishedAt = null;
    if (iso) {
      publishedAt = new Date(iso);
    } else if (rawPublished) {
      const m = rawPublished.match(/há\s*(\d+)\s*(minuto|minutos|hora|horas|dia|dias)/i);
      if (m) {
        const n = parseInt(m[1], 10);
        const unit = m[2].toLowerCase();
        const delta =
          unit.startsWith("minuto") ? n * 60e3 :
          unit.startsWith("hora")   ? n * 3600e3 :
                                      n * 86400e3;
        publishedAt = new Date(Date.now() - delta);
      }
    }

    const minDate = new Date(Date.now() - ONLY_NEWER_HOURS * 3600e3);
    const ok = !!publishedAt && publishedAt >= minDate;
    return { ok, publishedAt, raw: iso || rawPublished || "" };
  } finally {
    await page.close().catch(() => {});
  }
}

// ------------ run principal --------------

async function run() {
  await sendDiscord("✅ Bot ativo! Conexão com o Discord verificada com sucesso 🚀");

  const minDate = new Date(Date.now() - ONLY_NEWER_HOURS * 3600e3);
  console.log(`🔎 A verificar ${PROFILE_URLS.length} perfis (últimas ${ONLY_NEWER_HOURS}h) ...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    defaultViewport: { width: 1280, height: 1200 }
  });

  let totalFound = 0;
  let totalPosted = 0;

  try {
    for (const profile of PROFILE_URLS) {
      const profileId = (profile.match(/member\/(\d+)/) || [])[1] || "";
      console.log(`\n→ Perfil: ${profile}`);
      let items = [];

      // tentar API primeiro
      if (profileId) {
        items = await fetchProfileItemsAPI(profileId, Math.min(MAX_ITEMS_PER_PROF, 50));
      }

      // fallback DOM
      if (!items?.length) {
        const domItems = await fetchProfileItemsByDOM(browser, profile, MAX_ITEMS_PER_PROF);
        items = domItems;
      }

      console.log(`   • Itens captados (pré-filtro): ${items.length}`);

      // enriquecer com links/urls
      items = items.map(x => ({
        ...x,
        url: x.url || x.web_url || x.permalink || x.path ? `https://www.vinted.pt${x.path}` : x.url
      })).filter(x => !!x.url);

      // ordenar por mais recentes (quando vier de API já está)
      // aqui só asseguramos não exceder o limite
      items = items.slice(0, MAX_ITEMS_PER_PROF);

      // filtrar por tempo (até MAX_NEW_PER_PROF)
      const newOnes = [];
      for (const it of items) {
        if (newOnes.length >= MAX_NEW_PER_PROF) break;

        // se já veio com created_at/updated_at da API
        let publishedAt = null;
        const createdIso = it.created_at || it.created || it.updated_at || null;
        if (createdIso) {
          const d = new Date(createdIso);
          if (!isNaN(d)) publishedAt = d;
        }

        if (!publishedAt) {
          // tentar via DOM abrindo a página do item
          const chk = await isItemRecentByDOM(browser, it.url);
          if (chk.ok) {
            newOnes.push(it);
          }
        } else {
          if (publishedAt >= minDate) newOnes.push(it);
        }
      }

      console.log(`   • Novos (após filtro de ${ONLY_NEWER_HOURS}h): ${newOnes.length}`);
      totalFound += newOnes.length;

      // enviar cada um para o Discord
      for (const it of newOnes) {
        // garantir 2 imagens se houver
        if (!it.photos || it.photos.length < 2) {
          // tenta descobrir uma segunda imagem abrindo a página (opcional)
          // aqui mantemos simples; o embed aceita 1 ou 2 se existir
        }
        const payload = buildEmbedFromItem(it);
        await sendDiscord(payload);
        totalPosted++;
        // para não explodir o rate-limit do webhook
        await sleep(800);
      }
    }
  } catch (err) {
    console.error("Erro geral:", err);
    await sendDiscord(`⚠️ Erro geral: \`${String(err.message || err)}\``);
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\n📦 Resumo: encontrados=${totalFound}, publicados=${totalPosted}`);
  if (!totalPosted) {
    await sendDiscord(`ℹ️ Sem novos artigos nas últimas ${ONLY_NEWER_HOURS}h.`);
  } else {
    await sendDiscord(`✅ Publicados ${totalPosted} artigo(s) novo(s).`);
  }
}

// start
run().catch(e => {
  console.error("FATAL:", e);
});
