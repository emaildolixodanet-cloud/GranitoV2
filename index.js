// index.js – Vinted -> Discord (com fallback DOM) [corrigido: location is not defined]

import fetch from 'node-fetch';
import puppeteer from 'puppeteer';

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const PROFILE_URLS =
  (process.env.VINTED_PROFILE_URLS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const ONLY_NEWER_HOURS = Number(process.env.ONLY_NEWER_HOURS || '24');     // janela de tempo
const MAX_ITEMS_PER_PROFILE = Number(process.env.MAX_ITEMS_PER_PROFILE || '30');
const MAX_NEW_PER_PROFILE = Number(process.env.MAX_NEW_PER_PROFILE || '3');

// -------------------------------------------------------
// Util
// -------------------------------------------------------

function hoursAgoDate(hours) {
  const d = new Date();
  d.setHours(d.getHours() - hours);
  return d;
}

function agoString(dt) {
  const diff = Date.now() - dt.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

async function postDiscord(contentOrEmbed) {
  try {
    const payload = typeof contentOrEmbed === 'string'
      ? { content: contentOrEmbed }
      : { embeds: [contentOrEmbed] };

    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.warn('Discord webhook falhou:', res.status, t?.slice(0, 200));
    }
  } catch (err) {
    console.warn('Discord webhook erro:', err.message);
  }
}

function itemEmbed(item) {
  const {
    title = 'Novo artigo',
    url,
    price = '',
    size = '',
    condition = '',
    photo1 = '',
    photo2 = '',
    createdAt
  } = item;

  const fields = [];
  if (price) fields.push({ name: 'Preço', value: price, inline: true });
  if (size) fields.push({ name: 'Tamanho', value: size, inline: true });
  if (condition) fields.push({ name: 'Condição', value: condition, inline: true });
  if (createdAt) fields.push({ name: 'Publicado', value: `${agoString(createdAt)} atrás`, inline: true });

  const embed = {
    title: title?.slice(0, 240),
    url,
    color: 0x2B7FFF,
    fields
  };

  // 2 imagens (se houverem)
  const images = [photo1, photo2].filter(Boolean);
  if (images.length > 0) {
    embed.thumbnail = { url: images[0] };
    if (images[1]) {
      embed.image = { url: images[1] };
    }
  }

  return embed;
}

// -------------------------------------------------------
// API tentativas (404/401 ocorre muito na Vinted sem token)
// -------------------------------------------------------

async function fetchProfileItemsAPI(profileId, perPage = 30) {
  const urls = [
    `https://www.vinted.pt/api/v2/items?user_id=${profileId}&order=newest_first&per_page=${perPage}`,
    `https://www.vinted.pt/api/v2/catalog/items?user_id=${profileId}&order=newest_first&per_page=${perPage}`
  ];

  for (const u of urls) {
    try {
      const r = await fetch(u, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Referer': `https://www.vinted.pt/member/${profileId}`,
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
        }
      });

      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        console.log(`API falhou: ${u} HTTP ${r.status} => ${txt.slice(0, 160)}`);
        continue;
      }

      const json = await r.json();
      const arr = json?.items || json?.catalog_items || [];
      if (Array.isArray(arr) && arr.length) {
        return arr.map(x => ({
          id: x.id,
          title: x.title || x.description || 'Novo artigo',
          url: `https://www.vinted.pt/items/${x.id}`,
          price: x?.price_with_currency || (x?.price ? `${x.price} €` : ''),
          createdAt: x?.created_at ? new Date(x.created_at) : null,
          size: (x?.size_title || x?.size) ?? '',
          condition: x?.status || x?.condition || '',
          photo1: x?.photo?.url || x?.photos?.[0]?.url || '',
          photo2: x?.photos?.[1]?.url || ''
        }));
      }
    } catch (err) {
      console.log('API erro:', err.message);
    }
  }

  return [];
}

// -------------------------------------------------------
// DOM fallback (CORREÇÃO: construir URLs dentro do evaluate)
// -------------------------------------------------------

async function fetchProfileItemsByDOM(page, profileUrl, recentSince) {
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Extraímos tudo DENTRO do evaluate (location/document existem lá).
  const links = await page.evaluate(() => {
    const aEls = Array.from(document.querySelectorAll('a[href*="/items/"]'));
    const map = new Map();

    for (const a of aEls) {
      const href = a.getAttribute('href') || '';
      const match = href.match(/\/items\/(\d+)/);
      if (!match) continue;
      const id = match[1];

      // resolver absoluto dentro do browser
      const abs = new URL(href, document.location.origin).href;
      // Imagens (até 2)
      const imgs = Array.from(a.querySelectorAll('img')).map(img => img.src).filter(Boolean);
      map.set(id, {
        id,
        url: abs,
        title: (a.textContent || 'Novo artigo').trim(),
        photo1: imgs[0] || '',
        photo2: imgs[1] || ''
      });
    }
    return Array.from(map.values());
  });

  // tentar apanhar mais metadados abrindo páginas dos items (limitado)
  const results = [];
  for (const l of links.slice(0, MAX_ITEMS_PER_PROFILE)) {
    try {
      const p = await page.browser().newPage();
      await p.goto(l.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

      const meta = await p.evaluate(() => {
        const txt = sel => (document.querySelector(sel)?.textContent || '').trim();

        // Vinted tem muitos layouts; tentar campos genéricos
        const title =
          txt('h1') ||
          txt('[data-testid="item-title"]') ||
          txt('[class*="ItemDetails"] h1') ||
          'Novo artigo';

        const price =
          txt('[data-testid="item-price"]') ||
          txt('[class*="price"]') ||
          '';

        const size =
          txt('[data-testid="item-attributes"] [class*="size"]') ||
          txt('[class*="Size"]') || '';

        const condition =
          txt('[data-testid="item-attributes"] [class*="condition"]') ||
          txt('[class*="Condition"]') || '';

        // procurar timestamps (nem sempre visível)
        let createdAt = null;
        const timeEl = document.querySelector('time[datetime]');
        if (timeEl?.getAttribute('datetime')) {
          const d = new Date(timeEl.getAttribute('datetime'));
          if (!Number.isNaN(d.getTime())) createdAt = d;
        }
        return { title, price, size, condition, createdAt };
      });

      await p.close();

      // filtrar por tempo se conseguirmos o createdAt
      if (meta.createdAt && recentSince && meta.createdAt < recentSince) {
        continue;
      }

      results.push({
        ...l,
        title: meta.title || l.title,
        price: meta.price || '',
        size: meta.size || '',
        condition: meta.condition || '',
        createdAt: meta.createdAt || null
      });
    } catch {
      results.push(l); // pelo menos o link e imagens
    }
  }

  return results;
}

// -------------------------------------------------------
// RUN
// -------------------------------------------------------

(async () => {
  if (!WEBHOOK) {
    console.log('Falta DISCORD_WEBHOOK_URL');
    return;
  }
  if (!PROFILE_URLS.length) {
    console.log('Falta VINTED_PROFILE_URLS');
    return;
  }

  await postDiscord('✅ Bot ativo! Conexão com o Discord verificada com sucesso 🚀');

  const recentSince = hoursAgoDate(ONLY_NEWER_HOURS);
  console.log(`🔎 A verificar ${PROFILE_URLS.length} perfis (últimas ${ONLY_NEWER_HOURS}h) ...`);

  let totalFound = 0;
  let totalPosted = 0;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
  const page = await browser.newPage();

  try {
    for (const profileUrl of PROFILE_URLS) {
      const idMatch = profileUrl.match(/\/member\/(\d+)/);
      const profileId = idMatch?.[1] || '';
      console.log(`→ Perfil: ${profileUrl}`);

      // 1) tentar API
      let items = [];
      if (profileId) {
        items = await fetchProfileItemsAPI(profileId, Math.min(MAX_ITEMS_PER_PROFILE, 50));
      }

      // 2) fallback DOM se API vazia
      if (!items.length) {
        const byDom = await fetchProfileItemsByDOM(page, profileUrl, recentSince);
        // Normalizar campos faltantes via DOM
        items = byDom.map(x => ({
          ...x,
          price: x.price || '',
          size: x.size || '',
          condition: x.condition || '',
          createdAt: x.createdAt || null
        }));
      }

      // filtrar por tempo se possível
      let candidates = items;
      if (recentSince) {
        candidates = items.filter(it => !it.createdAt || it.createdAt >= recentSince);
      }

      console.log(`   • Links via DOM no perfil: ${items.length}`);
      console.log(`   • Candidatos (após filtro de tempo): ${candidates.length}`);

      totalFound += candidates.length;

      // publicar no Discord (máximo por perfil)
      for (const item of candidates.slice(0, MAX_NEW_PER_PROFILE)) {
        await postDiscord(itemEmbed(item));
        totalPosted++;
      }
    }
  } catch (err) {
    console.error('Erro geral:', err);
    await postDiscord(`⚠️ Erro geral: \`${(err && err.message) || String(err)}\``);
  } finally {
    await browser.close();
  }

  // resumo
  console.log(`📦 Resumo: encontrados=${totalFound}, publicados=${totalPosted}`);
  if (totalPosted === 0) {
    await postDiscord('ℹ️ Sem novos artigos nas últimas 24h.');
  }
})();
