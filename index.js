// ESM
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer";

const STATE_FILE = path.resolve("vinted_state.json");

// ───────────── Estado ─────────────
async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const s = JSON.parse(raw || "{}");
    return { posted: s.posted || {}, lastPrune: s.lastPrune || 0 };
  } catch {
    return { posted: {}, lastPrune: 0 };
  }
}
async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
function normalizeKey(url) {
  const m = String(url).match(/\/items\/(\d+)/);
  return m ? `item:${m[1]}` : url;
}

// ───────────── Scraper ─────────────
async function scrapeProfile(browser, profileUrl, maxItems) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);

  const url = profileUrl.includes("?")
    ? `${profileUrl}&order=newest_first`
    : `${profileUrl}?order=newest_first`;

  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Espera por items. Fallback rápido caso nada apareça
  const itemSelector = 'a[href*="/items/"]';
  try {
    await page.waitForSelector(itemSelector, { timeout: 15000 });
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (typeof page.waitForNetworkIdle === "function") {
    try {
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 });
    } catch {}
  }

  const items = await page.evaluate(() => {
    const anchors = [...document.querySelectorAll('a[href*="/items/"]')]
      .filter((a) => /\/items\/\d+/.test(a.getAttribute("href") || ""));
    const map = new Map();
    for (const a of anchors) {
      const href = a.href;
      if (map.has(href)) continue;

      const root = a.closest("article,li,div") || a;
      const title =
        root.querySelector('[data-testid*="title"],[class*="title"],[title]')?.textContent?.trim() ||
        a.getAttribute("title") ||
        "Artigo no Vinted";

      // tentativas para apanhar preço/descrição/imagem
      const price =
        root.querySelector('[data-testid*="price"],[class*="price"]')?.textContent?.trim() ||
        null;

      const image =
        root.querySelector("img")?.src ||
        root.querySelector('img[loading="lazy"]')?.src ||
        null;

      map.set(href, { url: href, title, price, image });
    }
    return Array.from(map.values());
  });

  await page.close();
  return items.slice(0, maxItems);
}

// ───────────── Discord (1 mensagem por item) ─────────────
async function postEmbed(webhookUrl, embedPayload, { username, avatar_url } = {}) {
  const body = {
    username,
    avatar_url,
    allowed_mentions: { parse: [] },
    ...embedPayload,
  };

  // Retry básico com backoff e suporte a Retry-After
  let attempts = 0;
  while (attempts < 4) {
    attempts++;
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.ok) return true;

    if (res.status === 429) {
      // tenta ler Retry-After (segundos) ou espera 2s
      const ra = Number(res.headers.get("retry-after") || 0);
      await new Promise((r) => setTimeout(r, Math.max(2000, ra * 1000)));
      continue;
    }

    // Para debug mais claro
    const txt = await res.text().catch(() => "");
    throw new Error(`Webhook falhou: ${res.status} ${res.statusText} ${txt}`);
  }
  throw new Error("Webhook falhou após várias tentativas (429).");
}

function buildEmbedForItem(it, profileLabel = "Vinted") {
  const fields = [];
  if (it.price) fields.push({ name: "Preço", value: `\`${it.price}\``, inline: true });

  return {
    content: "", // evitar duplicar texto; só embed
    embeds: [
      {
        title: it.title?.slice(0, 240) || "Novo artigo",
        url: it.url,
        description: "🧱 Novo artigo adicionado",
        thumbnail: it.image ? { url: it.image } : undefined,
        fields,
        footer: { text: profileLabel },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// ───────────── MAIN ─────────────
(async () => {
  const {
    DISCORD_WEBHOOK_URL,
    VINTED_PROFILE_URLS = "",
    ONLY_NEWER_HOURS = "24",
    MAX_ITEMS_PER_PROFILE = "10",
    MAX_NEW_PER_PROFILE = "5",
    TEST_MODE = "false",
    WEBHOOK_USERNAME = "Granito V2",
    WEBHOOK_AVATAR_URL = "", // opcional
  } = process.env;

  if (!DISCORD_WEBHOOK_URL) {
    console.error("❌ Falta DISCORD_WEBHOOK_URL");
    process.exit(1);
  }

  const profiles = VINTED_PROFILE_URLS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!profiles.length) {
    console.error("❌ Falta VINTED_PROFILE_URLS");
    process.exit(1);
  }

  const onlyNewerMs = Number(ONLY_NEWER_HOURS) * 3600 * 1000;
  const maxItems = Number(MAX_ITEMS_PER_PROFILE);
  const maxNew = Number(MAX_NEW_PER_PROFILE);
  const isTest = String(TEST_MODE).toLowerCase() === "true";

  const state = await loadState();
  const now = Date.now();

  // limpeza periódica (3 dias) mantendo 15 dias de histórico
  if (now - (state.lastPrune || 0) > 3 * 24 * 3600 * 1000) {
    const keep = {};
    for (const [k, v] of Object.entries(state.posted)) {
      if (now - (v?.ts || 0) <= 15 * 24 * 3600 * 1000) keep[k] = v;
    }
    state.posted = keep;
    state.lastPrune = now;
  }

  console.log(`🔎 A verificar ${profiles.length} perfis (últimas ${ONLY_NEWER_HOURS}h) ...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const candidates = [];

  try {
    for (const profile of profiles) {
      console.log(`→ Perfil: ${profile}`);
      let items = [];
      try {
        items = await scrapeProfile(browser, profile, maxItems);
      } catch (e) {
        console.error(`⚠️ Erro a scrapar ${profile}: ${e.message}`);
        continue;
      }

      const fresh = [];
      for (const it of items) {
        const key = normalizeKey(it.url);
        if (state.posted[key]) continue; // já publicado no passado

        // como não lemos timestamp do Vinted, aplicamos janela pela descoberta
        const within = Date.now() >= now - onlyNewerMs;
        if (!within) continue;

        fresh.push(it);
        if (fresh.length >= maxNew) break;
      }
      candidates.push(...fresh);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`📦 Resumo: encontrados=${candidates.length}, a_publicar=${candidates.length}`);

  if (!candidates.length) {
    await saveState(state);
    return;
  }

  let postedCount = 0;

  for (const it of candidates) {
    const key = normalizeKey(it.url);

    const embed = buildEmbedForItem(it);
    if (!isTest) {
      try {
        await postEmbed(
          DISCORD_WEBHOOK_URL,
          embed,
          { username: WEBHOOK_USERNAME, avatar_url: WEBHOOK_AVATAR_URL }
        );
        // só marca como postado se correu bem
        state.posted[key] = { ts: Date.now(), url: it.url };
        postedCount++;
        console.log(`✅ Publicado: ${it.url}`);
        // Respeitar ligeiramente rate limits
        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        console.error(`❌ Erro ao publicar ${it.url}: ${err.message}`);
      }
    } else {
      console.log(`🧪 TEST_MODE → (simulado) ${it.url}`);
    }
  }

  console.log(`🧾 Publicados com sucesso: ${postedCount}/${candidates.length}`);
  await saveState(state);
})();
