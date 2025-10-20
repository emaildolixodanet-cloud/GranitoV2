// webhook_visual_pt.js
// Visual limpo, inspirado no bot que enviaste, tudo em PT-PT e seguro para GH Actions.
// Uso: await sendItemToWebhook(process.env.DISCORD_WEBHOOK_URL, item)
// Requisitos: Node 18+ (GH runners usam Node 20). Não precisa de axios/discord.js.

const MAX_TITLE = 256;
const MAX_DESC = 4096;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;

function clamp(str, max) {
  if (str == null) return "";
  str = String(str).trim();
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function fmtCurrencyEUR(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  // Força PT-PT com € à direita
  return new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(Number(v));
}

function ago(tsMs) {
  if (!tsMs) return "—";
  const diff = Date.now() - Number(tsMs);
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d} dia${d>1?"s":""} atrás`;
  if (h >= 1) return `${h} hora${h>1?"s":""} atrás`;
  if (m >= 1) return `${m} minuto${m>1?"s":""} atrás`;
  return `agora`;
}

function stars(rating) {
  if (!rating && rating !== 0) return "—";
  const r = Math.max(0, Math.min(5, Number(rating)));
  const full = "★".repeat(Math.floor(r));
  const empty = "☆".repeat(5 - Math.floor(r));
  return `${full}${empty} (${r.toFixed(1)}/5)`;
}

/**
 * Constrói o payload do Discord Webhook (sem posts “soltos”).
 * Estrutura esperada do item (adapta ao teu scraper):
 * {
 *   url, title, priceEur, size, brand, condition, location,
 *   sellerName, sellerUrl, sellerRating, sellerSales,
 *   createdAtMs, photos: [url1, url2, ...], shipping: "PT, Ponto Pickup, Correios"
 * }
 */
function buildEmbedFromItem(item) {
  const title = clamp(item.title || "Artigo no Vinted", MAX_TITLE);
  const imageUrl =
    Array.isArray(item.photos) && item.photos.length ? String(item.photos[0]) : null;

  const fields = [];

  // Coluna 1
  fields.push({
    name: clamp("Preço", MAX_FIELD_NAME),
    value: clamp(fmtCurrencyEUR(item.priceEur), MAX_FIELD_VALUE),
    inline: true
  });
  fields.push({
    name: clamp("Tamanho", MAX_FIELD_NAME),
    value: clamp(item.size || "—", MAX_FIELD_VALUE),
    inline: true
  });
  fields.push({
    name: clamp("Estado", MAX_FIELD_NAME),
    value: clamp(item.condition || "—", MAX_FIELD_VALUE),
    inline: true
  });

  // Coluna 2
  fields.push({
    name: clamp("Marca", MAX_FIELD_NAME),
    value: clamp(item.brand || "—", MAX_FIELD_VALUE),
    inline: true
  });
  fields.push({
    name: clamp("Envio", MAX_FIELD_NAME),
    value: clamp(item.shipping || "Consultar no anúncio", MAX_FIELD_VALUE),
    inline: true
  });
  fields.push({
    name: clamp("Localização", MAX_FIELD_NAME),
    value: clamp(item.location || "—", MAX_FIELD_VALUE),
    inline: true
  });

  const vendedor =
    item.sellerName
      ? `[${item.sellerName}](${item.sellerUrl || "#"})`
      : "—";

  const descLines = [
    `**Vendedor:** ${vendedor}${item.sellerRating != null ? ` • ${stars(item.sellerRating)}` : ""}${item.sellerSales != null ? ` • ${item.sellerSales} venda${Number(item.sellerSales)==1?"":"s"}`:""}`,
    item.brand ? `**Marca:** ${clamp(item.brand, 100)}` : null,
    item.size ? `**Tamanho:** ${clamp(item.size, 50)}` : null
  ].filter(Boolean);

  const description = clamp(descLines.join("\n"), MAX_DESC);

  const embed = {
    title,
    url: item.url || undefined,
    description,
    color: 0x5865F2, // tom Discord (seguro, consistente)
    timestamp: new Date().toISOString(),
    footer: {
      text: `Vinted • Publicado ${ago(item.createdAtMs)}`
    },
    author: item.shopName
      ? { name: clamp(item.shopName, 128) }
      : undefined,
    fields,
    image: imageUrl ? { url: imageUrl } : undefined
  };

  // Botões (Ação principal para abrir no Vinted)
  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5, // LINK
          label: "Abrir no Vinted",
          url: item.url || "https://www.vinted.pt/"
        }
      ]
    }
  ];

  return { embeds: [embed], components };
}

/**
 * Envia o item para um webhook do Discord.
 */
async function sendItemToWebhook(webhookUrl, item, options = {}) {
  if (!webhookUrl) throw new Error("DISCORD_WEBHOOK_URL em falta");
  const username =
    options.username || "GRANITO — Seller Oficial da Comunidade";
  const avatar_url =
    options.avatar_url || undefined; // podes pôr um URL de avatar se quiseres

  const payload = {
    username,
    avatar_url,
    // conteúdo vazio para NÃO gerar preview automático do link
    content: "",
    ...buildEmbedFromItem(item)
  };

  // Node 18+ tem fetch nativo
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Falha ao enviar webhook (${res.status}): ${text}`);
  }
}

// --------- Exportações ---------
module.exports = {
  buildEmbedFromItem,
  sendItemToWebhook
};
