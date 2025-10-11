import puppeteer from "puppeteer";
import { buildDiscordMessageForItem } from "./discordFormat.js";
import { loadState, saveState, wasPosted, markPosted, pruneOld } from "./state.js";

// Variáveis de ambiente
const PROFILES = (process.env.VINTED_PROFILE_URLS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const HOURS = Number(process.env.ONLY_NEWER_HOURS || 24);
const MAX_ITEMS_PER_PROFILE = Number(process.env.MAX_ITEMS_PER_PROFILE || 10);
const MAX_NEW_PER_PROFILE = Number(process.env.MAX_NEW_PER_PROFILE || 5);
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const TEST_MODE = String(process.env.TEST_MODE || "false").toLowerCase() === "true";

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function scrapeProfile(browser, profileUrl) {
  const page = await browser.newPage();
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  // tenta pegar cartões do feed
  const list = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("div.feed-grid__item, .web_ui__ItemCard__container")];
    return cards.map((el) => {
      const link = el.querySelector("a[href*='/items/']")?.href || "";
      const title =
        el.querySelector("h3, h2, .item-box__title, .web_ui__Text__title")?.textContent?.trim() ||
        "";
      const brand =
        el.querySelector(".item-box__brand, .web_ui__Text__subtitle")?.textContent?.trim() || "";
      const priceText =
        el.querySelector(".item-box__price, .web_ui__Text__text")?.textContent?.trim() || "";
      const imgs = [...el.querySelectorAll("img")]
        .map(i => i.getAttribute("src") || i.getAttribute("data-src") || "")
        .filter(Boolean)
        .slice(0, 3);

      return {
        url: link,
        title,
        brand,
        price: priceText.replace(/[^\d.,]/g, ""),
        currency: "EUR",
        photos: imgs,
        description: "", // descrição curta não costuma estar no feed
      };
    });
  });

  await page.close();
  return list.filter(i => i.url);
}

async function postToDiscord(item) {
  if (!WEBHOOK) {
    console.error("❌ DISCORD_WEBHOOK_URL não configurado.");
    return;
  }
  const payload = buildDiscordMessageForItem(item);

  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("Falha a enviar para Discord:", res.status, t);
  }
}

async function run() {
  if (!PROFILES.length) {
    console.error("Nenhum perfil configurado em VINTED_PROFILE_URLS.");
    return;
  }

  console.log(`🔎 A verificar ${PROFILES.length} perfis (últimas ${HOURS}h) ...`);

  // Carrega/limpa estado anti-duplicados
  const state = loadState();
  pruneOld(state, 14); // mantém 14 dias

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let totalEncontrados = 0;
  let totalPublicados = 0;
  let stateChanged = false;

  for (const profile of PROFILES) {
    console.log(`→ Perfil: ${profile}`);

    let items = [];
    try {
      items = await scrapeProfile(browser, profile);
    } catch (e) {
      console.error("Erro a extrair:", e.message);
    }

    totalEncontrados += items.length;

    // Apenas os primeiros N e elimina duplicados por estado
    const candidatos = items.slice(0, MAX_ITEMS_PER_PROFILE);
    for (const item of candidatos) {
      if (wasPosted(state, item)) continue;

      // (Opcional) aplica limite por perfil de novos enviados
      if (totalPublicados >= MAX_NEW_PER_PROFILE) break;

      if (TEST_MODE) {
        console.log("🧪 (TEST_MODE) Publicaria:", item.title, "=>", item.url);
      } else {
        await postToDiscord(item);
        await wait(1200);
      }

      markPosted(state, item);
      stateChanged = true;
      totalPublicados++;
    }
  }

  await browser.close();

  if (stateChanged) saveState(state);

  console.log(`📦 Resumo: encontrados=${totalEncontrados}, publicados=${totalPublicados}`);
}

run().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
