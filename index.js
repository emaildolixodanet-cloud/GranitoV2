// ======================= IMPORTS E SETUP ===========================
import puppeteer from "puppeteer";
import { buildDiscordMessageForItem } from "./discordFormat.js";

// fetch: Node 20 já tem fetch global, mas garantimos fallback
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
const MAX_NEW_PER_PROFILE = parseInt(process.env.MAX_NEW_PER_PROFILE || "3", 10);
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const WEBHOOK_STYLE = (process.env.WEBHOOK_STYLE || "hybrid").toLowerCase();
const TEST_MODE = (process.env.TEST_MODE || "false").toLowerCase() === "true";

// ======================= FUNÇÕES DE SUPORTE ===========================
function log(...args) {
  console.log(...args);
}
function short(txt, max = 120) {
  if (!txt) return "";
  const clean = txt.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "..." : clean;
}
function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000);
}

// ======================= DISCORD PAYLOADS ===========================
// Layout antigo (PerfeitoV1) — opcional
function buildLegacyPayload(item) {
  return {
    embeds: [
      {
        title: item.title || "Novo artigo",
        url: item.url,
        description: short(item.description, 250),
        fields: [
          item.price ? { name: "💰 Preço", value: `${item.price} ${item.currency || "€"}`, inline: true } : null,
          item.size ? { name: "📐 Tamanho", value: item.size, inline: true } : null,
          item.brand ? { name: "🏷️ Marca", value: item.brand, inline: true } : null,
          item.condition ? { name: "🧽 Estado", value: item.condition, inline: true } : null,
        ].filter(Boolean),
        image: item.photos?.[0] ? { url: item.photos[0] } : undefined,
        footer: { text: "Vinted Bot - Layout V1" },
      },
    ],
  };
}

// Decide o payload
function makeDiscordPayload(item) {
  if (WEBHOOK_STYLE === "v1") return buildLegacyPayload(item);
  // padrão: híbrido elegante (vem do teu discordFormat.js)
  return buildDiscordMessageForItem(item);
}

async function postToDiscord(item) {
  if (!WEBHOOK) throw new Error("DISCORD_WEBHOOK_URL não configurado");
  const payload = makeDiscordPayload(item);
  await fetchHttp(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ======================= COLETORES / SCRAPER ===========================

// fecha cookies se existirem (heurstico)
async function tryAcceptCookies(page) {
  try {
    await page.evaluate(() => {
      const btn =
        [...document.querySelectorAll("button, [role='button']")]
          .find(b => /accept|agree|aceitar|ok|j'?accepte|consent/i.test(b?.textContent || ""));
      btn?.click();
    });
    await page.waitForTimeout(400);
  } catch { /* ignore */ }
}

// scroll progressivo
async function progressiveScroll(page, rounds = 10, delay = 900) {
  let lastH = 0;
  for (let i = 0; i < rounds; i++) {
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
    await page.waitForTimeout(delay);
    const h = await page.evaluate("document.body.scrollHeight");
    if (h === lastH) break;
    lastH = h;
  }
}

// recolhe links de itens numa página de perfil
async function collectItemLinks(page, max = 50) {
  const links = await page.evaluate(() => {
    const toAbs = (href) => new URL(href, location.origin).href;
    // muitos perfis têm anchors relativo → garantir absoluto
    const anchors = [...document.querySelectorAll('a[href*="/items/"]')];
    const raw = anchors.map(a => toAbs(a.getAttribute("href")));
    return [...new Set(raw)];
  });
  return links.slice(0, max);
}

// extrai dados de um item
async function extractItem(itemPage) {
  return await itemPage.evaluate(() => {
    const pick = (sel) => document.querySelector(sel)?.textContent?.trim() || "";

    const title =
      document.querySelector("h1")?.textContent?.trim() ||
      document.title || "Item Vinted";

    // Descrição (tentativa em vários locais)
    const description =
      document.querySelector('[data-testid="item-description"]')?.textContent?.trim() ||
      document.querySelector("article")?.textContent?.trim() ||
      document.querySelector('[class*="Description"]')?.textContent?.trim() ||
      "";

    // Preço + Moeda
    const priceEl =
      document.querySelector('[data-testid="item-price"]') ||
      document.querySelector('[data-testid="price"]') ||
      document.querySelector('[class*="price"], .item__price');

    const priceText = priceEl?.textContent?.trim() || "";
    const priceMatch = priceText.match(/[\d.,]+/);
    const price = priceMatch ? priceMatch[0].replace(",", ".") : "";
    const currency = priceText.replace(/[\d.,\s]/g, "").trim() || "EUR";

    // Tamanho / Marca
    const size =
      document.querySelector('[data-testid="item-size"]')?.textContent?.trim() ||
      document.querySelector('a[href*="/catalog/sizes/"]')?.textContent?.trim() ||
      "";

    const brand =
      document.querySelector('a[href*="/catalog/brands/"]')?.textContent?.trim() ||
      document.querySelector('[data-testid="item-brand"]')?.textContent?.trim() ||
      "";

    // Condição heurística
    const condition =
      ([...document.querySelectorAll("div, span")]
        .map(el => el.textContent?.trim() || "")
        .find(t => /novo|muito bom|bom|aceit|new|very good|good/i.test(t))) || "";

    // Fotos (apenas candidatas legítimas)
    const photos = [...document.querySelectorAll("img")]
      .map(i => i.src)
      .filter(u => /^https?:/.test(u) && /(vinted|images|thumbs|cdn)/i.test(u))
      .slice(0, 3);

    return {
      title,
      url: location.href,
      description,
      price,
      currency,
      size,
      brand,
      condition,
      photos
    };
  });
}

// Abre o perfil, rola, recolhe links e extrai dados de cada item
async function scrapeProfile(browser, profileUrl) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
  );
  await page.setViewport({ width: 1280, height: 1000 });

  await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 90000 })
    .catch(() => page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 90000 }));

  await page.waitForSelector("body", { timeout: 30000 }).catch(() => null);

  await tryAcceptCookies(page);
  await progressiveScroll(page, 12, 900);

  const itemLinks = await collectItemLinks(page, MAX_ITEMS_PER_PROFILE);
  log(`   • Links via DOM no perfil: ${itemLinks.length}`);

  const items = [];

  for (const link of itemLinks) {
    try {
      const itemPage = await browser.newPage();
      await itemPage.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
      );
      await itemPage.setViewport({ width: 1280, height: 1000 });

      await itemPage.goto(link, { waitUntil: "networkidle2", timeout: 90000 })
        .catch(() => itemPage.goto(link, { waitUntil: "domcontentloaded", timeout: 90000 }));

      await itemPage.waitForSelector("body", { timeout: 30000 }).catch(() => null);

      const data = await extractItem(itemPage);

      // (Opcional) Filtro por data — aqui a Vinted não expõe sempre a data; se precisares, adiciona heurística.
      // Por agora, não filtramos por HOURS (para garantir entregas).

      items.push(data);
      await itemPage.close();
    } catch (err) {
      log("   • Erro ao extrair item:", err.message);
    }
  }

  await page.close();
  return items;
}

// ======================= TESTE MANUAL DE PUBLICAÇÃO ===================
async function runTestOnce() {
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
      "https://images.vinted.net/thumbs/f800x800/01_0021b_Vinted_Item1.jpg",
      "https://images.vinted.net/thumbs/f800x800/02_0021b_Vinted_Item2.jpg",
      "https://images.vinted.net/thumbs/f800x800/03_0021b_Vinted_Item3.jpg",
    ],
    sellerName: "medp1",
    sellerUrl: "https://www.vinted.pt/member/medp1",
    sellerAvatar: "https://cdn-icons-png.flaticon.com/512/194/194938.png",
    createdAt: new Date().toISOString(),
  };

  console.log("🧪 TESTE: a publicar item de demonstração no Discord...");
  await postToDiscord(itemTeste);
  console.log("✅ Teste enviado para o Discord com sucesso!");
}

// ======================= RUN ===========================
async function run() {
  if (!PROFILES.length) {
    console.error("Nenhum perfil configurado! Defina VINTED_PROFILE_URLS.");
    return;
  }

  // Test mode publica e termina
  if (TEST_MODE) {
    await runTestOnce();
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

      const novos = items.slice(0, Math.max(1, MAX_NEW_PER_PROFILE || 3));
      for (const item of novos) {
        await postToDiscord(item);
        totalPublicados++;
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      log("Erro geral:", err.message);
    }
  }

  await browser.close();
  log(`📦 Resumo: encontrados=${totalEncontrados}, publicados=${totalPublicados}`);
}

// Execução
run().catch(err => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
