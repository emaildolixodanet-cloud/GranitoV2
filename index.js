import puppeteer from "puppeteer";
import fs from "fs";
import { buildDiscordMessageForItem } from "./discordFormat.js";
import { loadState, saveState, wasPosted, markPosted, pruneOld } from "./state.js";
import fetch from "node-fetch";

// Variáveis de ambiente
const VINTED_PROFILE_URLS = process.env.VINTED_PROFILE_URLS?.split(",") || [];
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ONLY_NEWER_HOURS = Number(process.env.ONLY_NEWER_HOURS || 24);
const MAX_ITEMS_PER_PROFILE = Number(process.env.MAX_ITEMS_PER_PROFILE || 10);
const MAX_NEW_PER_PROFILE = Number(process.env.MAX_NEW_PER_PROFILE || 5);
const TEST_MODE = String(process.env.TEST_MODE || "false").toLowerCase() === "true";

async function scrapeProfileItems(browser, profileUrl) {
  const page = await browser.newPage();
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  const items = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("div.feed-grid__item")];
    return cards.map((el) => {
      const titleEl = el.querySelector("h3, h2, .item-box__title");
      const priceEl = el.querySelector(".item-box__price, .web_ui__Text__text");
      const brandEl = el.querySelector(".item-box__brand, .web_ui__Text__subtitle");
      const linkEl = el.querySelector("a[href*='/items/']");
      const imgEls = [...el.querySelectorAll("img")].map((i) => i.src).slice(0, 3);

      return {
        title: titleEl?.textContent?.trim(),
        price: priceEl?.textContent?.trim().replace(/[^\d,.]/g, ""),
        currency: "EUR",
        brand: brandEl?.textContent?.trim(),
        url: linkEl?.href || "",
        photos: imgEls,
        sellerName: document.querySelector(".profile__title")?.textContent?.trim() || "",
        description: el.querySelector(".web_ui__Text__body")?.textContent?.trim() || "",
      };
    });
  });

  await page.close();
  return items.filter((i) => i.url);
}

async function postToDiscord(item) {
  if (!DISCORD_WEBHOOK_URL) {
    console.error("❌ Nenhum webhook configurado.");
    return;
  }

  const payload = buildDiscordMessageForItem(item);

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error("Erro ao enviar para Discord:", await res.text());
    }
  } catch (err) {
    console.error("Erro no envio Discord:", err);
  }
}

async function run() {
  console.log(`🔎 A verificar ${VINTED_PROFILE_URLS.length} perfis (últimas ${ONLY_NEWER_HOURS}h) ...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  // --- MEMÓRIA ENTRE EXECUÇÕES ---
  const state = loadState();
  pruneOld(state, 14); // mantém IDs até 14 dias
  let stateChanged = false;

  let totalEncontrados = 0;
  let totalPublicados = 0;

  for (const profileUrl of VINTED_PROFILE_URLS) {
    console.log(`→ Perfil: ${profileUrl}`);
    let items = [];

    try {
      items = await scrapeProfileItems(browser, profileUrl);
    } catch (err) {
      console.error("Erro geral:", err.message);
    }

    totalEncontrados += items.length;
    const novos = items.slice(0, MAX_ITEMS_PER_PROFILE);

    for (const item of novos) {
      if (wasPosted(state, item)) {
        continue; // já publicado noutra run
      }

      if (!TEST_MODE) {
        await postToDiscord(item);
        await new Promise((r) => setTimeout(r, 1500));
      } else {
        console.log("🧪 (TEST_MODE) Publicaria:", item.title);
      }

      markPosted(state, item);
      stateChanged = true;
      totalPublicados++;
    }
  }

  if (stateChanged) {
    saveState(state);
  }

  await browser.close();
  console.log(`📦 Resumo: encontrados=${totalEncontrados}, publicados=${totalPublicados}`);
}

run().catch((err) => {
  console.error("❌ Erro fatal:", err);
});
