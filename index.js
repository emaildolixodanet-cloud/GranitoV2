// index.js — versão completa (PT-PT, ESM)

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';
import { buildDiscordPayload, makeCollage3 } from './discordFormat.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------------------------
// Configuração via variáveis
// ----------------------------
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK_URL) {
  console.error('❌ DISCORD_WEBHOOK_URL não definida.');
  process.exit(1);
}

const PROFILE_LIST =
  (process.env.VINTED_PROFILE_URLS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

if (PROFILE_LIST.length === 0) {
  console.error('❌ VINTED_PROFILE_URLS está vazio.');
  process.exit(1);
}

const ONLY_NEWER_HOURS = Number(process.env.ONLY_NEWER_HOURS || 24);
const MAX_ITEMS_PER_PROFILE = Number(process.env.MAX_ITEMS_PER_PROFILE || 10);
const MAX_NEW_PER_PROFILE = Number(process.env.MAX_NEW_PER_PROFILE || 5);
const TEST_MODE = String(process.env.TEST_MODE || 'false').toLowerCase() === 'true';

// ----------------------------
// Estado (para evitar duplicados)
// ----------------------------
const STATE_FILE = path.join(__dirname, 'vinted_state.json');

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { posted: {}, lastPrune: 0 };
  }
}

async function writeState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// limpeza ocasional (mantém mapa pequeno)
function pruneState(state) {
  const now = Date.now();
  if (now - (state.lastPrune || 0) < 1000 * 60 * 60) return state; // 1h
  const keepSince = now - ONLY_NEWER_HOURS * 60 * 60 * 1000;
  const next = { posted: {}, lastPrune: now };
  for (const [k, v] of Object.entries(state.posted || {})) {
    if ((v?.ts || 0) >= keepSince) next.posted[k] = v;
  }
  return next;
}

// ----------------------------
// Utilitários
// ----------------------------
const sleep = ms => new Promise(res => setTimeout(res, ms));

function pickText(el, ...selectors) {
  for (const sel of selectors) {
    const n = el.querySelector(sel);
    if (n && n.textContent?.trim()) return n.textContent.trim();
  }
  return null;
}

function euro(x) {
  return x?.replace(',', '.').replace(/[^\d.]/g, '');
}

// ----------------------------
// Publicação no Discord
// ----------------------------
async function publicarNoDiscord(item) {
  const payload = buildDiscordPayload(item, { usarColagem: true });

  let colagem = null;
  try {
    colagem = await makeCollage3(item.images || []);
  } catch (err) {
    console.error('⚠️ Erro ao criar colagem:', err?.message);
  }

  if (TEST_MODE) {
    console.log('🧪 TEST_MODE ativo — não vou enviar para o Discord.');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (colagem) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    form.append('files[0]', colagem.buffer, {
      filename: colagem.filename,
      contentType: 'image/png'
    });
    await axios.post(WEBHOOK_URL, form, { headers: form.getHeaders() });
  } else {
    await axios.post(WEBHOOK_URL, payload);
  }
}

// ----------------------------
// Scrape de um item do Vinted
// ----------------------------
async function scrapeItemPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(600); // dar tempo a scripts/imagens

  const data = await page.evaluate(() => {
    const getByLabel = (label) => {
      // tenta encontrar pares "label: valor"
      const rows = Array.from(document.querySelectorAll('dt,div,span')).filter(n => n.textContent);
      for (const node of rows) {
        const t = node.textContent.trim().toLowerCase();
        if (t === label.toLowerCase()) {
          // valor próximo
          const v1 = node.nextElementSibling?.textContent?.trim();
          if (v1) return v1;
        }
      }
      // fallback por data-testid comuns
      const map = {
        'marca': ['[data-testid="item-brand"]'],
        'tamanho': ['[data-testid="item-size"]', '[data-testid="size-link"]'],
        'estado': ['[data-testid="item-condition"]', 'span:has(svg[aria-label*="condi"])']
      };
      for (const sel of map[label.toLowerCase()] || []) {
        const n = document.querySelector(sel);
        if (n?.textContent?.trim()) return n.textContent.trim();
      }
      return null;
    };

    const title =
      document.querySelector('h1')?.textContent?.trim() ||
      document.querySelector('[data-testid="ItemTitle"]')?.textContent?.trim() ||
      'Artigo no Vinted';

    const priceText =
      document.querySelector('[data-testid="item-price"]')?.textContent?.trim() ||
      document.querySelector('data[itemprop="price"]')?.getAttribute('content') ||
      (document.querySelector('meta[itemprop="price"]')?.getAttribute('content') ?
        document.querySelector('meta[itemprop="price"]').getAttribute('content') + ' €' : null);

    const brand = getByLabel('Marca');
    const size = getByLabel('Tamanho') || getByLabel('Tamanho / Número');
    const condition = getByLabel('Estado');

    // imagens (apenas src válidos)
    const imgs = Array.from(document.querySelectorAll('img'))
      .map(i => i.getAttribute('src') || i.getAttribute('data-src') || '')
      .filter(u => u.startsWith('http'))
      // evitar thumbnails muito pequenos
      .filter(u => !u.includes('placeholder'));

    // vendedor
    const sellerName =
      document.querySelector('[data-testid="member-username"]')?.textContent?.trim() ||
      document.querySelector('a[href*="/member/"] h3')?.textContent?.trim() ||
      document.querySelector('a[href*="/member/"] span')?.textContent?.trim() || null;

    // rating & nº avaliações
    let sellerRating = null, sellerReviews = null;
    const ratingEl = document.querySelector('[data-testid="member-rating"]');
    if (ratingEl) {
      const txt = ratingEl.textContent.trim();
      const m = txt.match(/([\d.,]+)/);
      sellerRating = m ? m[1].replace(',', '.') : null;
    }
    const reviewsEl = document.querySelector('[data-testid="member-reviews-count"]') || document.querySelector('a[href*="reviews"]');
    if (reviewsEl) {
      const m = reviewsEl.textContent.replace(/\D+/g, '');
      if (m) sellerReviews = Number(m);
    }

    // favoritos & visualizações (podem não estar disponíveis publicamente)
    let favorites = null, views = null;
    const favNode = Array.from(document.querySelectorAll('*')).find(n => /favoritos?/i.test(n.textContent||''));
    if (favNode) {
      const m = favNode.textContent.replace(/\D+/g, '');
      if (m) favorites = Number(m);
    }
    const viewNode = Array.from(document.querySelectorAll('*')).find(n => /visualiza(ç|c)ões?/i.test(n.textContent||''));
    if (viewNode) {
      const m = viewNode.textContent.replace(/\D+/g, '');
      if (m) views = Number(m);
    }

    return {
      title, priceText, brand, size, condition,
      images: imgs.slice(0, 6),
      sellerName, sellerRating, sellerReviews,
      favorites, views
    };
  });

  // marca timestamp de deteção no nosso lado
  data.url = url;
  data.detectedAtISO = new Date().toISOString();
  return data;
}

// ----------------------------
// Scrape de uma página de perfil (lista de items)
// ----------------------------
async function scrapeProfile(browser, profileUrl) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  console.log(`→ Perfil: ${profileUrl}`);
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await sleep(1000);

  // recolhe links para itens
  const itemLinks = await page.evaluate(() => {
    const as = Array.from(document.querySelectorAll('a[href*="/items/"]'));
    const urls = [...new Set(as.map(a => a.href.split('?')[0]))];
    return urls;
  });

  const limited = itemLinks.slice(0, MAX_ITEMS_PER_PROFILE);
  const results = [];

  // abre cada item numa nova página para extrair detalhes
  for (const href of limited) {
    try {
      const p = await browser.newPage();
      p.setDefaultTimeout(30000);
      const item = await scrapeItemPage(p, href);
      await p.close();
      results.push(item);
      // respeitar o rate-limit
      await sleep(400);
    } catch (e) {
      console.log(`⚠️ Erro a scrapar ${href}: ${e.message}`);
    }
  }

  await page.close();
  return results;
}

// ----------------------------
// Main
// ----------------------------
(async () => {
  console.log(`🔎 A verificar ${PROFILE_LIST.length} perfis (últimas ${ONLY_NEWER_HOURS}h) ...`);

  let state = await readState();
  state = pruneState(state);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  let encontrados = 0;
  let a_publicar = 0;

  try {
    for (const profileUrl of PROFILE_LIST) {
      const items = await scrapeProfile(browser, profileUrl);
      encontrados += items.length;

      // filtra por "novos" (pela nossa deteção e por ainda não publicados)
      const novos = [];
      for (const it of items) {
        const key = `item:${(it.url || '').split('/items/')[1] || it.url}`;
        const jáFoi = state.posted[key];
        if (jáFoi) continue;

        // janela temporal (deteção)
        const sinceMs = ONLY_NEWER_HOURS * 60 * 60 * 1000;
        const detected = new Date(it.detectedAtISO).getTime();
        if (Date.now() - detected <= sinceMs) {
          novos.push({ it, key });
          if (novos.length >= MAX_NEW_PER_PROFILE) break;
        }
      }

      for (const { it, key } of novos) {
        try {
          await publicarNoDiscord(it);
          a_publicar++;
          // marca como publicado
          state.posted[key] = { ts: Date.now(), url: it.url };
          // pequena pausa entre posts
          await sleep(500);
        } catch (err) {
          console.log('❌ Erro ao publicar no Discord:', err?.response?.status, err?.response?.data || err.message);
        }
      }
    }
  } finally {
    await browser.close();
    await writeState(state);
  }

  console.log(`📦 Resumo: encontrados=${encontrados}, a_publicar=${a_publicar}`);
})().catch(err => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});
