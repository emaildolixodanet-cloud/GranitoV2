// ESM READY
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer";

const STATE_FILE = path.resolve("vinted_state.json");

// ───────────── Utils estado ─────────────
async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const state = JSON.parse(raw || "{}");
    state.posted = state.posted || {};
    state.lastPrune = state.lastPrune || 0;
    return state;
  } catch {
    return { posted: {}, lastPrune: 0 };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function normalizeKey(url) {
  // extrai o ID numérico do item da URL, ex: .../items/7194468874-...
  const m = String(url).match(/\/items\/(\d+)/);
  if (m) return `item:${m[1]}`;
  return url; // fallback
}

// ───────────── Scraper ─────────────
async function scrapeProfile(browser, profileUrl, onlyNewerHours, maxItems) {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);

  const url = profileUrl.includes("?")
    ? `${profileUrl}&order=newest_first`
    : `${profileUrl}?order=newest_first`;

  await page.goto(url, { waitUntil: "networkidle2" });

  // tenta apanhar cartões (selectors variam no Vinted)
  await page.waitForTimeout(2000); // pequeno delay para render
  const items = await page.evaluate(() => {
    const anchors = [
      ...document.querySelectorAll('a[href*="/items/"]')
    ].filter((a) => /\/items\/\d+/.test(a.getAttribute("href") || ""));

    // deduplicar por href absoluto
    const map = new Map();
    for (const a of anchors) {
      const href = a.href;
      if (!map.has(href)) {
        // tenta apanhar info útil ao redor
        const root = a.closest("div") || a;
        const title =
          root.querySelector('[data-testid*="title"], [class*="title"], [title]')?.textContent?.trim() ||
          a.getAttribute("title") ||
          "Novo artigo no Vinted";
        const price =
          root.querySelector('[data-testid*="price"], [class*="price"]')?.textContent?.trim() ||
          null;
        const img =
          root.querySelector("img")?.src ||
          root.querySelector('img[loading="lazy"]')?.src ||
          null;
        map.set(href, { url: href, title, price, image: img });
      }
    }
    return Array.from(map.values());
  });

  await page.close();

  // limitar itens iniciais
  const limited = items.slice(0, maxItems);

  // Filtro temporal (aproximação: assumimos listagem por ordem e usamos hora atual)
  // Como o Vinted não expõe sempre timestamps, usamos a janela de "novidades" via execução frequente.
  // O controlo real de duplicados fica no estado (não repete nada que já foi postado).
  const now = Date.now();
  const cutoff = now - Number(onlyNewerHours) * 3600 * 1000;

  return limited.map((i) => ({ ...i, discoveredAt: now, cutoff }));
}

// ───────────── Discord ─────────────
async function postToDiscord(webhookUrl, batch) {
  if (!Array.isArray(batch) || batch.length === 0) return;

  // Discord limita 10 embeds por mensagem → partimos em blocos de 10
  const chunks = [];
  for (let i = 0; i < batch.length; i += 10) {
    chunks.push(batch.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    const embeds = chunk.map((it) => {
      const fields = [];
      if (it.price) {
        fields.push({ name: "Preço", value: `\`${it.price}\``, inline: true });
      }
      return {
        title: it.title?.slice(0, 240) || "Novo artigo",
        url: it.url,
        description: "🧱 Artigo encontrado no Vinted",
        thumbnail: it.image ? { url: it.image } : undefined,
        fields
      };
    });

    const payload = {
      // IMPORTANTE: garantir sempre content (mesmo com embeds)
      content: `🧱 **Novidades no Vinted** (${chunk.length} item${chunk.length > 1 ? "s" : ""})`,
      embeds: embeds.length ? embeds : undefined
    };

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Falha no webhook Discord: ${res.status} ${res.statusText} ${text}`
      );
    }
  }
}

// ───────────── MAIN ─────────────
(async () => {
  const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
  const VINTED_PROFILE_URLS =
    (process.env.VINTED_PROFILE_URLS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) || [];
  const ONLY_NEWER_HOURS = Number(process.env.ONLY_NEWER_HOURS || "24");
  const MAX_ITEMS_PER_PROFILE = Number(process.env.MAX_ITEMS_PER_PROFILE || "10");
  const MAX_NEW_PER_PROFILE = Number(process.env.MAX_NEW_PER_PROFILE || "5");
  const TEST_MODE = String(process.env.TEST_MODE || "false").toLowerCase() === "true";

  if (!DISCORD_WEBHOOK_URL) {
    console.error("❌ Falta DISCORD_WEBHOOK_URL");
    process.exit(1);
  }
  if (!VINTED_PROFILE_URLS.length) {
    console.error("❌ Falta VINTED_PROFILE_URLS");
    process.exit(1);
  }

  const state = await loadState();
  const now = Date.now();

  // limpeza do estado a cada ~3 dias
  if (now - (state.lastPrune || 0) > 3 * 24 * 3600 * 1000) {
    const keep = {};
    for (const [k, v] of Object.entries(state.posted)) {
      if (now - (v?.ts || 0) <= 15 * 24 * 3600 * 1000) keep[k] = v;
    }
    state.posted = keep;
    state.lastPrune = now;
  }

  console.log(`🔎 A verificar ${VINTED_PROFILE_URLS.length} perfis (últimas ${ONLY_NEWER_HOURS}h) ...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const toPublish = [];

  try {
    for (const profile of VINTED_PROFILE_URLS) {
      console.log(`→ Perfil: ${profile}`);

      let items = [];
      try {
        items = await scrapeProfile(browser, profile, ONLY_NEWER_HOURS, MAX_ITEMS_PER_PROFILE);
      } catch (e) {
        console.error(`⚠️ Erro a scrapar ${profile}: ${e.message}`);
        continue;
      }

      // filtrar por não publicados + respeitar janela temporal via estado
      const fresh = [];
      for (const it of items) {
        const key = normalizeKey(it.url);
        if (state.posted[key]) continue; // já publicado

        // janela de "novidade" aproximada (se necessário no futuro, pode-se ler o "listed X ago")
        const withinWindow = it.discoveredAt >= (now - ONLY_NEWER_HOURS * 3600 * 1000);
        if (!withinWindow) continue;

        fresh.push(it);
        if (fresh.length >= MAX_NEW_PER_PROFILE) break;
      }

      toPublish.push(...fresh);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`📦 Resumo: encontrados=${toPublish.length ? toPublish.length : 0}, a_publicar=${toPublish.length}`);

  if (!toPublish.length) {
    await saveState(state);
    return;
  }

  if (!TEST_MODE) {
    try {
      await postToDiscord(DISCORD_WEBHOOK_URL, toPublish);
    } catch (err) {
      console.error(`❌ Erro ao publicar no Discord: ${err.message}`);
      // mesmo com erro, marcamos o que tentámos para evitar spam se o payload foi parcialmente aceite
    }
  } else {
    console.log("🧪 TEST_MODE=on → não envio para Discord.");
  }

  // marcar como publicados
  for (const it of toPublish) {
    const key = normalizeKey(it.url);
    state.posted[key] = { ts: now, url: it.url };
  }

  await saveState(state);
})();
