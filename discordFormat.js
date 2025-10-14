// discordFormat.js (ESM)
import fetch from "node-fetch";

/** Util: corta strings para não rebentar limites do Discord */
const cut = (s, n) => (s ? String(s).slice(0, n) : "");

/**
 * Constrói um payload bonito com:
 *  - Título, URL, preço
 *  - Marca, Tamanho, Estado
 *  - Favoritos, Visualizações
 *  - Rating e Nº avaliações
 *  - 3 imagens (1 no embed principal + 2 embeds só-imagem)
 *  - timestamp e vendedor no footer
 */
export function buildDiscordPayload(item) {
  const {
    title,
    url,
    priceLabel,
    brand,
    size,
    condition,
    sellerName,
    sellerRating, // número tipo 4.8
    sellerReviews, // inteiro
    favorites, // inteiro
    views, // inteiro
    images = [], // array de urls
    detectedAtISO // string ISO
  } = item;

  const mainImage = images[0] || null;
  const extra1 = images[1] || null;
  const extra2 = images[2] || null;

  const fields = [];

  if (priceLabel) fields.push({ name: "💶 Preço", value: cut(priceLabel, 256), inline: true });
  if (brand) fields.push({ name: "🏷️ Marca", value: cut(brand, 256), inline: true });
  if (size) fields.push({ name: "📏 Tamanho", value: cut(size, 256), inline: true });
  if (condition) fields.push({ name: "✨ Estado", value: cut(condition, 256), inline: true });

  if (favorites != null) fields.push({ name: "❤️ Favoritos", value: String(favorites), inline: true });
  if (views != null) fields.push({ name: "👀 Visualizações", value: String(views), inline: true });

  const ratingParts = [];
  if (sellerRating != null) ratingParts.push(`★ ${Number(sellerRating).toFixed(1)}`);
  if (sellerReviews != null) ratingParts.push(`${sellerReviews} avaliações`);
  if (ratingParts.length) fields.push({ name: "⭐ Rating do vendedor", value: ratingParts.join(" • "), inline: true });

  const embedMain = {
    title: cut(title || "Item Vinted", 256),
    url: url || undefined,
    description: undefined, // opcional
    color: 0x2b8a3e, // verde
    timestamp: detectedAtISO || new Date().toISOString(),
    fields: fields.slice(0, 25),
    footer: {
      text: sellerName ? cut(`Vendedor: ${sellerName}`, 2048) : "Vinted",
    },
  };

  if (mainImage) {
    // imagem grande; thumbnail também ajuda
    embedMain.image = { url: mainImage };
    embedMain.thumbnail = { url: mainImage };
  }

  const embeds = [embedMain];

  // até mais 2 imagens extra (cada embed pode ter 1 image)
  if (extra1) embeds.push({ image: { url: extra1 }, color: 0x2b8a3e });
  if (extra2) embeds.push({ image: { url: extra2 }, color: 0x2b8a3e });

  return { embeds };
}

/** Envia o payload para o webhook */
export async function postToDiscord(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Falha no webhook Discord: ${res.status} ${res.statusText} ${text}`);
  }
}
