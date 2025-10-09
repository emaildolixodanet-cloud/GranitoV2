import puppeteer from "puppeteer";
import axios from "axios";
import dayjs from "dayjs";

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL?.trim();
const PROFILES = (process.env.VINTED_PROFILE_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
const ONLY_NEWER_HOURS = parseInt(process.env.ONLY_NEWER_HOURS || "24", 10);
const MAX_PER_PROFILE = parseInt(process.env.MAX_ITEMS_PER_PROFILE || "20", 10);

if (!WEBHOOK) throw new Error("Falta DISCORD_WEBHOOK_URL");
if (!PROFILES.length) throw new Error("Falta VINTED_PROFILE_URLS");

function priceStr(item) {
  const cur = item.currency || item.price_currency || "€";
  let num = item.price_numeric;
  if (num == null && item.price) {
    const m = String(item.price).replace(",", ".").match(/[0-9]+(?:\.[0-9]+)?/);
    if (m) num = parseFloat(m[0]);
  }
  return num != null ? `${num.toFixed(2).replace(".", ",")} ${cur}` : String(item.price ?? "—");
}

function pickImages(item, n = 3) {
  const photos = item.photos || [];
  const out = [];
  for (const p of photos) {
    const u = p.full_size_url || p.url || (p.thumbnails && p.thumbnails[p.thumbnails.length - 1]?.url);
    if (u) out.push(u);
    if (out.length >= n) break;
  }
  return out;
}

function itemIsRecent(item) {
  const ts = item.created_at_ts ? dayjs.unix(Number(item.created_at_ts)) : (item.created_at ? dayjs(item.created_at) : null);
  if (!ts) return true;
  return ts.isAfter(dayjs().subtract(ONLY_NEWER_HOURS, "hour"));
}

async function fetchItemsFromProfile(page, profileUrl) {
  await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 60000 });

  let apiResponse;
  try {
    apiResponse = await page.waitForResponse(
      res => {
        const url = res.url();
        return res.request().method() === "GET" &&
               url.includes("/api/v2/catalog/items") &&
               res.status() === 200;
      },
      { timeout: 15000 }
    );
  } catch {
    const userIdMatch = profileUrl.match(/\/member\/(\d+)/);
    if (!userIdMatch) return [];
    const userId = userIdMatch[1];

    try {
      const json = await page.evaluate(async (uid) => {
        const url = `/api/v2/catalog/items?user_id=${uid}&order=newest_first&per_page=50&page=1&localize=false`;
        const r = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
        if (!r.ok) return null;
        return await r.json();
      }, userId);

      const items = json?.items || [];
      return items;
    } catch {
      return [];
    }
  }

  const body = await apiResponse.json().catch(() => null);
  return body?.items || [];
}

async function sendToDiscord(item) {
  const url = item.url || (item.path ? `https://www.vinted.pt${item.path}` : `https://www.vinted.pt/items/${item.id}`);
  const brand = item.brand_title || item.brand?.title || "—";
  const size = item.size_title || item.size?.title || "—";
  const cond = item.condition_title || item.status || item.condition || "—";
  const price = priceStr(item);
  const imgs = pickImages(item, 3);

  const embeds = [
    {
      title: item.title || "Novo artigo",
      url,
      fields: [
        { name: "Brand", value: String(brand), inline: true },
        { name: "Size",  value: String(size),  inline: true },
        { name: "Status", value: String(cond), inline: true },
        { name: "Price", value: price, inline: true }
      ]
    },
    ...imgs.map(u => ({ image: { url: u } }))
  ].slice(0, 4);

  await axios.post(WEBHOOK, { content: "Personaliza aqui", embeds }, { timeout: 30000 });
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--lang=pt-PT,pt"
    ]
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  let totalFound = 0, totalPosted = 0;
  for (const profile of PROFILES) {
    try {
      const items = await fetchItemsFromProfile(page, profile);
      const limited = items.slice(0, MAX_PER_PROFILE);
      totalFound += limited.length;

      for (const it of limited) {
        if (!itemIsRecent(it)) continue;
        try {
          await sendToDiscord(it);
          totalPosted++;
          await new Promise(r => setTimeout(r, 700));
        } catch (e) {
          console.log("Falha a publicar:", it.id, String(e).slice(0, 200));
        }
      }
    } catch (e) {
      console.log("Falha no perfil:", profile, String(e).slice(0, 200));
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`Resumo: encontrados=${totalFound}, publicados=${totalPosted}`);
  await browser.close();
})();