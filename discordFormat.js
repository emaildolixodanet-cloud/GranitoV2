// discordFormat.js — versão PT-PT
import sharp from "sharp";
import axios from "axios";

/**
 * Faz download de uma imagem e devolve o Buffer.
 */
async function fetchImageBuffer(url) {
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

/**
 * Cria uma colagem (1 imagem grande + 2 pequenas à direita)
 * para simular o layout visual do Vinted no Discord.
 */
export async function makeCollage3(images = []) {
  const escolhidas = images.slice(0, 3);
  if (escolhidas.length === 0) return null;

  const LARGURA = 768; // 512 + 256
  const ALTURA = 512;

  const base = sharp({
    create: { width: LARGURA, height: ALTURA, channels: 3, background: "#2b2d31" }
  }).png();

  const composições = [];

  // imagem principal à esquerda
  if (escolhidas[0]) {
    const buf1 = await fetchImageBuffer(escolhidas[0]);
    const img1 = await sharp(buf1).resize(512, 512, { fit: "cover" }).toBuffer();
    composições.push({ input: img1, left: 0, top: 0 });
  }

  // imagem secundária (topo direita)
  if (escolhidas[1]) {
    const buf2 = await fetchImageBuffer(escolhidas[1]);
    const img2 = await sharp(buf2).resize(256, 256, { fit: "cover" }).toBuffer();
    composições.push({ input: img2, left: 512, top: 0 });
  }

  // imagem terciária (base direita)
  if (escolhidas[2]) {
    const buf3 = await fetchImageBuffer(escolhidas[2]);
    const img3 = await sharp(buf3).resize(256, 256, { fit: "cover" }).toBuffer();
    composições.push({ input: img3, left: 512, top: 256 });
  }

  const buffer = await base.composite(composições).png().toBuffer();
  return { buffer, filename: "colagem.png" };
}

/**
 * Constrói o embed completo do Discord.
 * Totalmente em português de Portugal.
 */
export function buildDiscordPayload(item, opts = {}) {
  const {
    title,
    url,
    priceText,
    brand,
    size,
    condition,
    favorites,
    views,
    sellerName,
    sellerRating,
    sellerReviews,
    detectedAtISO,
    images = []
  } = item;

  const cor = 0x2b8a3e; // verde Vinted / GRANITO

  const campos = [
    { name: "📅 Publicado", value: `<t:${Math.floor(new Date(detectedAtISO).getTime()/1000)}:R>`, inline: true },
    { name: "🏷️ Marca", value: brand || "—", inline: true },
    { name: "📏 Tamanho", value: size || "—", inline: true },
    { name: "💰 Preço", value: priceText || "—", inline: true },
    { name: "⭐ Avaliações", value: `${sellerRating ?? "—"} ★ (${sellerReviews ?? 0})`, inline: true },
    { name: "💎 Estado", value: condition || "—", inline: true },
    { name: "❤️ Favoritos", value: String(favorites ?? "—"), inline: true },
    { name: "👀 Visualizações", value: String(views ?? "—"), inline: true }
  ];

  const embed = {
    color: cor,
    title: title?.trim() || "Novo artigo no Vinted",
    url,
    fields: campos,
    author: sellerName ? { name: sellerName } : undefined,
    footer: { text: "GRANITO — Seller Oficial da Comunidade" },
    timestamp: detectedAtISO || new Date().toISOString()
  };

  // imagem grande (colagem ou foto principal)
  const usarColagem = opts.usarColagem !== false;
  if (usarColagem && images.length > 0) {
    embed.image = { url: "attachment://colagem.png" };
  } else if (images[0]) {
    embed.image = { url: images[0] };
  }

  return { embeds: [embed] };
}
