// ======================= IMPORTS E SETUP ===========================
import puppeteer from "puppeteer";
import { buildDiscordMessageForItem } from "./discordFormat.js";

// fetch (fallback para node-fetch caso necessário)
const fetchHttp = (typeof fetch !== "undefined")
  ? fetch
  : (await import("node-fetch")).default;

// ======================= CONFIG ===========================
const PROFILES = (process.env.VINTED_PROFILE_URLS || "")
  .split(",")
  .map(u => u.trim())
  .filter(Boolean);

const HOURS = parseInt(process.env.ONLY_NEWER_HOURS || "24", 10);
const MAX_ITEMS_PER_PROFILE = parseInt(process.env.MAX_ITEMS_PER_PROFILE || "20", 10);
const MAX_NEW_PER_PROFILE = Number(process.env.MAX_NEW_PER_PROFILE || 3);
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const TEST_MODE = (process.env.TEST_MODE || "false").toLowerCase() === "true";

// ======================= HELPERS ===========================
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const log = (...a) => console.log(...a);

function short(txt, max = 120) {
  if (!txt) return "";
  const clean = txt.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "..." : clean;
}

// ======================= DISCORD ===========================
async function postToDiscord(item) {
  if (!WEBHOOK) throw new Error("DISCORD_WEBHOOK_URL não configurado");
  const payload = buildDiscordMessageForItem(item);
  await fetchHttp(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ======================= UTILS DE PÁGINA ===========================
async function acceptCookies(page) {
  try {
    // OneTrust (muito comum)
    const oneTrust = '#onetrust-accept-btn-handler, button#onetrust-accept-btn-handler';
    if (await page.$(oneTrust)) {
      await page.click(oneTrust).catch(() => {});
      await sleep(300);
    }
    // Outros textos comuns (PT/EN/ES/FR)
    const candidates = [
      "button:has-text('Aceitar todos')",
      "button:has-text('Aceitar')",
      "button:has-text('Allow all')",
      "button:has-text('Accept all')",
      "button:has-text('Autoriser tout')",
      "button:has-text('Permitir todos')",
      "button.cookie-accept",
    ];
    for (const sel of candidates) {
      const found = await page.$(sel).catch(() => null);
      if (found) {
        await found.click().catch(() => {});
        await sleep(300);
        break;
      }
    }
  } catch (_) {}
}

async function autoScroll(page, maxSteps = 20) {
  let lastHeight = await page.evaluate(() => document.body.scrollHeight);
  for (let i = 0; i < maxSteps; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(500);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === lastHeight) break;
    lastHeight = newHeight;
  }
}

async function extractItemLinks(page) {
  // recolhe links que contêm /items/
  const links = await page.$$eval("a[href*='/items/']", as =>
    Array.from(new Set(as.map(a => a.href)))
  );
  return links;
}

// ======================= SCRAPER ===========================
async function scrapeProfile(browser, url) {
  const page = await browser.newPage();

  // Cabeçalhos realistas
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
  });

  // Ir ao perfil raiz
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForSelector("body", { timeout: 30000 }).catch(() => null);
  await acceptCookies(page);
  await sleep(400);
  await autoScroll(page);

  let links = await extractItemLinks(page);

  // Fallback: se não encontrou nada, tenta navegar para /items
  if (!links.length) {
    const itemsUrl = url.replace(/\/$/, "") + "/items";
    await page.goto(itemsUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForSelector("body", { timeout: 30000 }).catch(() => null);
    await acceptCookies(page);
    await sleep(400);
    await autoScroll(page);
    links = await extractItemLinks(page);
  }

  links = links.slice(0, MAX_ITEMS_PER_PROFILE);
  const scraped = [];

  for (const link of links) {
    try {
      const itemPage = await browser.newPage();
      await itemPage.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      );
      await itemPage.setExtraHTTPHeaders({ "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8" });

      await itemPage.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await itemPage.waitForSelector("body", { timeout: 30000 }).catch(() => null);
      await acceptCookies(itemPage);
      await sleep(300);

      const data = await itemPage.evaluate(() => {
        const get = (sel) => document.querySelector(sel)?.innerText?.trim() || "";

        const title =
          document.querySelector("h1")?.innerText?.trim() ||
          document.title?.trim() ||
          "Novo artigo";

        const descCandidate =
          document.querySelector("[data-testid='description'], .item-description, .u-text-break")?.innerText ||
          document.querySelector("p")?.innerText ||
          "";

        // preço
        let priceText = "";
        const priceNode =
          document.querySelector("[data-testid='item-price']") ||
          document.querySelector("[itemprop='price']") ||
          document.querySelector("meta[itemprop='price']");
        if (priceNode) {
          priceText = priceNode.content || priceNode.getAttribute("content") || priceNode.textContent || "";
          priceText = priceText.trim();
        } else {
          const priceSpan = Array.from(document.querySelectorAll("span"))
            .map(s => s.textContent?.trim() || "")
            .find(t => /^[0-9]+([.,][0-9]{1,2})?\s?(€|EUR)$/i.test(t));
          priceText = priceSpan || "";
        }

        const brand = get("a[href*='/brand/'], [data-testid='brand-name']") || "";
        const size = get("[data-testid='size'], [data-testid='item-size']") || "";
        const condition =
          get("[data-testid='item-conditions']") ||
          get("div:has(> [data-testid='item-conditions'])") ||
          "";

        const sellerName =
          document.querySelector("a[href*='/member/'] span")?.innerText?.trim() ||
          document.querySelector("a[href*='/member/']")?.innerText?.trim() ||
          "";
        const sellerUrl = document.querySelector("a[href*='/member/']")?.href || "";
        const sellerAvatar =
          document.querySelector("img[alt*='avatar'], img[alt*='Avatar'], img[class*='avatar']")?.src || "";

        const imgs = Array.from(document.querySelectorAll("img"))
          .map(i => i.src)
          .filter(src => /^https?:\/\//i.test(src));

        return {
          title,
          url: location.href,
          description: descCandidate,
          price: priceText.replace(",", "."),
          currency: /€|EUR/i.test(priceText) ? "EUR" : "",
          size,
          brand,
          condition,
          photos: imgs.slice(0, 6),
          sellerName,
          sellerUrl,
          sellerAvatar,
          createdAt: new Date().toISOString(),
        };
      });

      scraped.push(data);
      await itemPage.close();
      await sleep(150);
    } catch (e) {
      log("Erro ao extrair item:", e.message);
    }
  }

  await page.close();
  return scraped;
}

// =================== TESTE MANUAL (visual) ===================
if (TEST_MODE) {
  const itemTeste = {
    title: "Camisola Branca Mulher Ralph Lauren Tamanho XL",
    url: "https://www.vinted.pt/items/123456789-camisola-ralph-lauren-xl",
    description:
      "Camisola Polo Ralph Lauren em malha branca, padrão entrançado e logo bordado azul-marinho no peito. Tecido de alta qualidade — ideal para um look casual elegante.",
    price: "40.00",
    currency: "EUR",
    size: "XL / 42 / 14",
    brand: "Ralph Lauren",
    condition: "Muito bom",
    photos: [
      "https://images.vinted.net/thumbs/f800x800/01_demo1.jpg",
      "https://images.vinted.net/thumbs/f800x800/02_demo2.jpg",
      "https://images.vinted.net/thumbs/f800x800/03_demo3.jpg",
    ],
    sellerName: "medp1",
    sellerUrl: "https://www.vinted.pt/member/medp1",
    sellerAvatar: "https://cdn-icons-png.flaticon.com/512/194/194938.png",
    createdAt: new Date().toISOString(),
  };

  console.log("🧪 TESTE: a publicar item de demonstração no Discord...");
  await postToDiscord(itemTeste);
  console.log("✅ Teste enviado para o Discord com sucesso!");
  process.exit(0);
}

// ======================= RUN ===========================
async function run() {
  if (!PROFILES.length) {
    console.error("Nenhum perfil configurado!");
    return;
  }

  log(`🔎 A verificar ${PROFILES.length} perfis (últimas ${HOURS}h) ...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let totalEncontrados = 0;
  let totalPublicados = 0;

  for (const profile of PROFILES) {
    log(`→ Perfil: ${profile}`);
    try {
      const items = await scrapeProfile(browser, profile);
      totalEncontrados += items.length;

      const novos = items.slice(0, MAX_NEW_PER_PROFILE);
      for (const item of novos) {
        await postToDiscord(item);
        totalPublicados++;
        await sleep(800);
      }
    } catch (err) {
      log("Erro geral:", err.message);
    }
  }

  await browser.close();
  log(`📦 Resumo: encontrados=${totalEncontrados}, publicados=${totalPublicados}`);
}

run().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
