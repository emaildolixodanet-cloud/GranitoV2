import puppeteer from "puppeteer";

// ====== ENV ======
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL?.trim();
const URLS_RAW = process.env.VINTED_PROFILE_URLS || "";
const ONLY_NEWER_HOURS = Number(process.env.ONLY_NEWER_HOURS || "24");
const MAX_ITEMS_PER_PROFILE = Number(process.env.MAX_ITEMS_PER_PROFILE || "30");
const MAX_NEW_PER_PROFILE = Number(process.env.MAX_NEW_PER_PROFILE || "3");

if (!WEBHOOK) {
  console.error("❌ Falta DISCORD_WEBHOOK_URL");
  process.exit(1);
}

const PROFILE_URLS = URLS_RAW.split(/\r?\n|,|;/).map(s => s.trim()).filter(Boolean);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- Checar se item é recente (por DOM) ----------
async function isItemRecentByDOM(browser, itemUrl) {
  const page = await browser.newPage();
  try {
    await page.goto(itemUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(700);

    // 1) tentar ISO via <time datetime="...">
    let iso = await page.$eval("time[datetime]", el => el.getAttribute("datetime")).catch(() => null);

    // 2) tentar “Publicado há …”
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

// ---------- Extrair detalhes ----------
async function extractItemDetails(page) {
  const title =
    (await page.$eval('[data-testid="product-title"]', el => el.textContent.trim()).catch(() => null)) ||
    (await page.$eval("h1", el => el.textContent.trim()).catch(() => null)) ||
    "Sem título";

  const rawPrice =
    (await page.$eval('[data-testid="price"]', el => el.textContent.trim()).catch(() => null)) ||
    (await page.$eval('[itemprop="price"]', el => el.textContent.trim()).catch(() => null)) ||
    "";
  let price = rawPrice.replace(/\s+/g, " ").trim();
  price = price.replace(/(\d),(\d{2})\b/, "$1.$2");

  const details = await page.$$eval("div, li, tr", nodes => {
    const map = {};
    for (const n of nodes) {
      const txt = (n.innerText || "").toLowerCase();
      if (!txt) continue;
      if (!map.size && /tamanho/.test(txt)) {
        const m = txt.match(/tamanho[\s:]+(.+)/i);
        if (m) map.size = m[1].trim();
      }
      if (!map.condition && /(condi[cç][aã]o|estado)/.test(txt)) {
        const m = txt.match(/(?:condi[cç][aã]o|estado)[\s:]+(.+)/i);
        if (m) map.condition = m[1].trim();
      }
      if (!map.brand && /marca/.test(txt)) {
        const m = txt.match(/marca[\s:]+(.+)/i);
        if (m) map.brand = m[1].trim();
      }
    }
    return map;
  }).catch(() => ({}));

  const seller =
    (await page.$eval('[data-testid="seller-display-name"]', el => el.textContent.trim()).catch(() => null)) ||
    (await page.$eval('a[href*="/member/"]', el => el.textContent.trim()).catch(() => null)) ||
    "";

  const images = await page.$$eval("img", imgs => {
    const urls = [];
    for (const im of imgs) {
      const src = im.currentSrc || im.src;
      if (!src) continue;
      if (/data\:image|avatar|favicon|sprite|svg/i.test(src)) continue;
      urls.push(src);
      if (urls.length >= 5) break;
    }
    return urls;
  }).catch(() => []);

  const postedAtText =
    (await page.$eval("time[datetime]", el => el.getAttribute("datetime")).catch(() => null)) || "";

  return {
    title,
    price,
    size: details.size || "",
    condition: details.condition || "",
    brand: details.brand || "",
    seller,
    images: images.slice(0, 3),
    postedAtText
  };
}

// ---------- Postar no Discord ----------
async function postToDiscord(itemUrl, info) {
  const colorHex = (process.env.EMBED_COLOR || "2ecc71").replace("#", "");
  const color = parseInt(colorHex, 16);

  const fields = [];
  if (info.price)     fields.push({ name: "💰 Preço",    value: info.price,     inline: true });
  if (info.size)      fields.push({ name: "📏 Tamanho",  value: info.size,      inline: true });
  if (info.condition) fields.push({ name: "🔧 Condição", value: info.condition, inline: true });
  if (info.brand)     fields.push({ name: "🏷️ Marca",   value: info.brand,     inline: true });
  if (info.seller)    fields.push({ name: "👤 Vendedor", value: info.seller,    inline: true });

  const titlePrefix = process.env.EMBED_TITLE_PREFIX || "🧥";
  const title = `${titlePrefix} ${info.title}`;

  const embeds = [{
    title,
    url: itemUrl,
    color,
    description: "Personaliza aqui",
    fields,
    footer: info.postedAtText ? { text: `Publicado em ${info.postedAtText}` } : undefined
  }];

  info.images.slice(0, 2).forEach(src => {
    embeds.push({ color, image: { url: src } });
  });

  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds })
  });

  if (!res.ok) {
    console.warn("⚠️ Falha ao publicar:", res.status, await res.text().catch(() => ""));
  }
}

// ---------- Main ----------
async function run() {
  console.log(`🔎 A verificar ${PROFILE_URLS.length} perfis (últimas ${ONLY_NEWER_HOURS}h) ...`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: 1280, height: 900 }
  });

  try {
    let totalFound = 0;
    let totalPosted = 0;

    for (const profileUrl of PROFILE_URLS) {
      console.log(`\n→ Perfil: ${profileUrl}`);

      const page = await browser.newPage();
      await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(1200);

      const itemLinks = await page.$$eval('a[href*="/items/"]', as => {
        const set = new Set();
        for (const a of as) {
          const u = (a.href || "").split("?")[0];
          if (u && /\/items\//.test(u)) set.add(u);
        }
        return Array.from(set);
      }).catch(() => []);

      console.log(`   • Links via DOM no perfil: ${itemLinks.length}`);
      await page.close();

      const toCheck = itemLinks.slice(0, Math.min(MAX_ITEMS_PER_PROFILE, itemLinks.length));
      const fresh = [];

      for (const url of toCheck) {
        const { ok, publishedAt, raw } = await isItemRecentByDOM(browser, url);
        if (!ok) {
          console.log(`   • Antigo/sem data (${raw || "—"}) → SKIP`);
          continue;
        }
        console.log(`   • OK recente: ${publishedAt?.toISOString()}`);

        const tab = await browser.newPage();
        await tab.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        const info = await extractItemDetails(tab);
        fresh.push({ url, info, postedAt: publishedAt || new Date() });
        await tab.close();
        await sleep(600);
      }

      fresh.sort((a, b) => b.postedAt - a.postedAt);
      const toPost = fresh.slice(0, MAX_NEW_PER_PROFILE);
      totalFound += fresh.length;

      for (const it of toPost) {
        await postToDiscord(it.url, it.info);
        totalPosted++;
        await sleep(600);
      }
    }

    console.log(`\n📦 Resumo: encontrados=${totalFound}, publicados=${totalPosted}`);
  } catch (err) {
    console.error("Erro geral:", err);
  } finally {
    await browser.close().catch(() => {});
  }
}

run();
