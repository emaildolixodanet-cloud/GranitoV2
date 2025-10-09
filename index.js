// index.js — Vinted → Discord (fetch nativo Node 20+)

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const RAW_URLS = process.env.VINTED_PROFILE_URLS || "";
const ONLY_NEWER_HOURS = Number(process.env.ONLY_NEWER_HOURS || 24);
const MAX_ITEMS_PER_PROFILE = Number(process.env.MAX_ITEMS_PER_PROFILE || 20);

// ------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractUserId(url) {
  const m = url.match(/\/member[s]?\/(\d+)/i);
  return m ? m[1] : null;
}

function hhmm(date) {
  return new Date(date).toISOString().replace("T", " ").slice(0, 16);
}

function cutoffIso(hours) {
  const d = new Date();
  d.setHours(d.getHours() - hours);
  return d.toISOString();
}

const defaultHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
  Referer: "https://www.vinted.pt/",
  "X-Requested-With": "XMLHttpRequest",
};

// ------------------------------------------------------

async function sendToDiscord(item) {
  const images = (item?.photos || [])
    .slice(0, 2)
    .map((p) => p.url)
    .filter(Boolean);

  const embed = {
    title: item.title || "Item",
    url: `https://www.vinted.pt/items/${item.id}`,
    thumbnail: images[0] ? { url: images[0] } : undefined,
    image: images[1] ? { url: images[1] } : undefined,
    fields: [
      { name: "Preço", value: item.price || "—", inline: true },
      { name: "Tamanho", value: item.size || "—", inline: true },
      { name: "Condição", value: item.condition || "—", inline: true },
    ],
    footer: { text: `Última verificação • ${hhmm(new Date())}` },
  };

  const payload = { username: "Vinted Bot", embeds: [embed] };

  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error("❌ Discord webhook falhou:", res.status, await res.text());
  } else {
    console.log(`✅ Publicado: ${item.title}`);
  }
}

// ------------------------------------------------------

async function fetchItemsByUserId(userId, perPage = 20) {
  const urlsToTry = [
    `https://www.vinted.pt/api/v2/items?user_id=${userId}&order=newest_first&per_page=${perPage}`,
    `https://www.vinted.pt/api/v2/items?user_id=${userId}&per_page=${perPage}`,
  ];

  for (const apiUrl of urlsToTry) {
    try {
      const res = await fetch(apiUrl, { headers: defaultHeaders });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.items?.length) {
        return data.items.map((i) => ({
          id: i.id,
          title: i.title,
          price: i.price_with_currency || "—",
          size: i.size_title || "—",
          condition: i.status || "—",
          created_at: i.created_at,
          photos:
            i.photos?.map((p) => ({ url: p.url || p.full_size_url })) || [],
        }));
      }
    } catch (e) {
      console.warn("⚠️ Erro no fetch:", e.message);
    }
    await sleep(500);
  }

  return [];
}

// ------------------------------------------------------

async function main() {
  if (!WEBHOOK || !RAW_URLS) {
    console.error("❌ Faltam variáveis: DISCORD_WEBHOOK_URL ou VINTED_PROFILE_URLS");
    process.exit(1);
  }

  const profileUrls = RAW_URLS.split(",").map((s) => s.trim()).filter(Boolean);
  const sinceIso = cutoffIso(ONLY_NEWER_HOURS);

  console.log(`🔎 A verificar ${profileUrls.length} perfis desde ${hhmm(sinceIso)}...`);

  let totalFound = 0;
  let totalPosted = 0;

  for (const url of profileUrls) {
    const uid = extractUserId(url);
    if (!uid) continue;

    const items = await fetchItemsByUserId(uid, Math.min(MAX_ITEMS_PER_PROFILE, 50));
    const recent = items.filter((i) => {
      if (!i.created_at) return true;
      return new Date(i.created_at) >= new Date(sinceIso);
    });

    totalFound += recent.length;

    for (const item of recent) {
      await sendToDiscord(item);
      totalPosted++;
      await sleep(600);
    }
  }

  console.log(`📦 Resumo: encontrados=${totalFound}, publicados=${totalPosted}`);
}

main().catch((e) => console.error("❌ Erro fatal:", e));
