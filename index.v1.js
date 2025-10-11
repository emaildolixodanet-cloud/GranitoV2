
// index.js – Vinted -> Discord (DOM robusto, cookies, scroll, seção "items")

import fetch from 'node-fetch';
import puppeteer from 'puppeteer';

// ---- helper para substituir page.waitForTimeout ----
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const PROFILE_URLS =
  (process.env.VINTED_PROFILE_URLS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const ONLY_NEWER_HOURS = Number(process.env.ONLY_NEWER_HOURS || '24');     // janela de tempo
const MAX_ITEMS_PER_PROFILE = Number(process.env.MAX_ITEMS_PER_PROFILE || '30');
const MAX_NEW_PER_PROFILE = Number(process.env.MAX_NEW_PER_PROFILE || '3');

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

  const images = [photo1, photo2].filter(Boolean);
  if (images.length > 0) {
    embed.thumbnail = { url: images[0] };
    if (images[1]) embed.image = { url: images[1] };
  }
  return embed;
}

// ---------------------- DOM helpers ----------------------

async function autoScroll(page, maxSteps = 12, step = 1200, delay = 400) {
  for (let i = 0; i < maxSteps; i++) {
    await page.evaluate((s) => window.scrollBy(0, s), step);
    await sleep(delay);
  }
}

async function acceptCookiesIfAny(page) {
  try {
    await page.evaluate(() => {
      const texts = ['Aceitar tudo', 'Aceitar', 'Accept all', 'Tout accepter'];
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const btn = buttons.find(b => texts.some(t => (b.textContent || '').trim().includes(t)));
      btn?.click();
    });
    await sleep(800);
  } catch {}
}

// ---------------------- DOM scraper principal ----------------------

async function fetchProfileItemsByDOM(page, profileUrl, recentSince) {
  // tentar forçar “ITEMS” na página do perfil.
  let target = profileUrl;
  const m = profileUrl.match(/\/member\/(\d+)/);
  if (m?.[1]) {
    const id = m[1];
    target = `https://www.vinted.pt/member/${id}?section=items&order=newest_first`;
  }

  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await acceptCookiesIfAny(page);

  // aguardar que a página carregue alguma coisa
  await sleep(1500);

  // scroll para forçar carregamento
  await autoScroll(page, 10, 1400, 350);

  // tentar esperar por qualquer link /items/
  await page.waitForSelector('a[href*="/items/"]', { timeout: 8000 }).catch(() => {});

  const links = await page.evaluate(() => {
    const aEls = Array.from(document.querySelectorAll('a[href*="/items/"]'));
    const map = new Map();

    for (const a of aEls) {
      const href = a.getAttribute('href') || '';
      const match = href.match(/\/items\/(\d+)/);
      if (!match) continue;
      const id = match[1];

      const abs = new URL(href, document.location.origin).href;

      // apanhar até 2 imagens (considerar lazy load)
      const imgs = Array
        .from(a.querySelectorAll('img'))
        .map(img => img.currentSrc || img.src || img.getAttribute('data-src') || '')
        .filter(Boolean);

      const title = (a.getAttribute('title') || a.textContent || 'Novo artigo').trim();
      map.set(id, {
        id,
        url: abs,
        title,
        photo1: imgs[0] || '',
        photo2: imgs[1] || ''
      });
    }
    return Array.from(map.values());
  });

  // enriquecer alguns items abrindo 3-6 para tentar preço/tamanho/etc
  const subset = links.slice(0, Math.min(6, MAX_ITEMS_PER_PROFILE));
  const results = [];

  for (const l of subset) {
    try {
      const p = await page.browser().newPage();
      await p.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      );
      await p.setExtraHTTPHeaders({ 'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8' });
      await p.goto(l.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await acceptCookiesIfAny(p);
      await sleep(800);

      const meta = await p.evaluate(() => {
        const get = sel => (document.querySelector(sel)?.textContent || '').trim();
        const title =
          get('h1') ||
          get('[data-testid="item-title"]') ||
          get('[class*="ItemDetails"] h1') ||
          'Novo artigo';

        const price =
          get('[data-testid="item-price"]') ||
          get('[class*="price"]') || '';

        const size =
          get('[data-testid="item-attributes"] [class*="size"]') ||
          get('[class*="Size"]') || '';

        const condition =
          get('[data-testid="item-attributes"] [class*="condition"]') ||
          get('[class*="Condition"]') || '';

        let createdAt = null;
        const timeEl = document.querySelector('time[datetime]');
        if (timeEl?.getAttribute('datetime')) {
          const d = new Date(timeEl.getAttribute('datetime'));
          if (!Number.isNaN(d.getTime())) createdAt = d;
        }
        return { title, price, size, condition, createdAt };
      });

      await p.close();

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
      results.push(l);
    }
  }

  // se abrimos apenas parte, junta resto sem meta (para não perder links)
  if (links.length > results.length) {
    for (const extra of links.slice(results.length, Math.min(links.length, MAX_ITEMS_PER_PROFILE))) {
      results.push(extra);
    }
  }

  return results;
}

// ------------------------------------------------------- RUN -------------------------------------------------------

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
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu'
    ]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8' });

  try {
    for (const profileUrl of PROFILE_URLS) {
      console.log(`→ Perfil: ${profileUrl}`);

      const items = await fetchProfileItemsByDOM(page, profileUrl, recentSince);

      const candidates = items.filter(it => !it.createdAt || it.createdAt >= recentSince);

      console.log(`   • Links via DOM no perfil: ${items.length}`);
      console.log(`   • Candidatos (após filtro de tempo): ${candidates.length}`);

      totalFound += candidates.length;

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

  console.log(`📦 Resumo: encontrados=${totalFound}, publicados=${totalPosted}`);
  if (totalPosted === 0) {
    await postDiscord('ℹ️ Sem novos artigos nas últimas 24h.');
  }
})();
