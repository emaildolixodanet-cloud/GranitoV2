/**
 * Constrói embeds estilo “cartão” (PT-PT) inspirado no exemplo pretendido.
 * - 1º embed: título + linha de ícones/valores + mini-galeria (primeira imagem como image)
 * - Embeds seguintes: restantes imagens (1 por embed) para efeito de grelha
 */

const ICONS = {
  published: "🕘",
  brand: "🏷️",
  size: "📏",
  condition: "🧼",
  price: "💶",
  feedbacks: "⭐"
};

function timeAgoPT(tsMs, nowMs = Date.now()) {
  if (!tsMs) return "—";
  let diff = Math.max(0, nowMs - tsMs);
  const s = Math.floor(diff / 1000);
  if (s < 30) return "agora";
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} minuto${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h} hora${h === 1 ? "" : "s"}`;
  const d = Math.floor(h / 24);
  return `há ${d} dia${d === 1 ? "" : "s"}`;
}

export function buildEmbedsPT(item, detectedAtIso) {
  const when = item.createdAt ? timeAgoPT(item.createdAt) : "—";

  const line1 =
    `**${ICONS.published} Publicado:** ${when}   ` +
    `**${ICONS.brand} Marca:** ${item.brand || "—"}   ` +
    `**${ICONS.size} Tamanho:** ${item.size || "—"}   ` +
    `**${ICONS.condition} Estado:** ${item.condition || "—"}   ` +
    `**${ICONS.price} Preço:** ${item.priceText || "—"}`;

  const main = {
    title: item.title || "Item Vinted",
    url: item.url,
    color: 0x1d9bf0, // azul discreto
    author: item.seller
      ? { name: item.seller }
      : undefined,
    description: line1,
    image: item.images?.length ? { url: item.images[0] } : undefined,
    footer: {
      text: "GRANITO • Monitor Vinted (PT)"
    },
    timestamp: detectedAtIso
  };

  const gallery = (item.images || [])
    .slice(1, 4) // mais 3 imagens
    .map((u) => ({
      url: item.url,
      image: { url: u },
      color: 0x263238
    }));

  return [main, ...gallery];
}
