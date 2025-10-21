// discordFormat.js
//
// Visual em PT-PT, inspirado no cartão “rico” da 2.ª imagem.
// Mostra: título com link, autor (vendedor), linhas com ícones
// (Publicado, Marca, Tamanho, Estado, Preço, Feedbacks) e
// um pequeno mosaico de imagens (1 principal + até 3 extra).

const COLOR = 0x2b8a3e; // verde discreto
const BRAND_COLOR = 0x25a18e;

const EMOJIS = {
  published: "🕒",
  brand: "🏷️",
  size: "📏",
  condition: "🧼",
  price: "💰",
  feedbacks: "⭐",
};

function fixText(t) {
  if (!t) return "";
  const s = String(t).trim();
  if (/criar conta/i.test(s) || /iniciar sessão/i.test(s)) return "";
  return s.replace(/\s+/g, " ");
}

function timeAgoPT(fromIso) {
  if (!fromIso) return "agora";
  const from = new Date(fromIso).getTime();
  if (!Number.isFinite(from)) return "agora";
  const diff = Date.now() - from;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "agora";
  if (mins < 60) return `${mins} min atrás`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h atrás`;
  const days = Math.floor(hrs / 24);
  return `${days} dia${days > 1 ? "s" : ""} atrás`;
}

function moneyPT({ priceText = "", priceConvertedText = "" }) {
  if (!priceText && !priceConvertedText) return "";
  if (priceText && priceConvertedText && priceConvertedText !== priceText) {
    return `${priceText}  •  ≈ ${priceConvertedText}`;
  }
  return priceText || priceConvertedText || "";
}

/**
 * item:
 *  - url, title, images[]
 *  - brand, size, condition
 *  - priceText, priceConvertedText
 *  - seller, favourites, views
 *  - rating, reviews
 *  - publishedAtIso (opcional)
 */
export function buildEmbedsPT(item, detectedAtIso) {
  const seller = fixText(item.seller) || "—";
  const title = fixText(item.title) || "Anúncio Vinted";
  const url = item.url;
  const mainImg = (item.images && item.images[0]) || null;
  const extra = (item.images || []).slice(1, 4); // até 3 extra para “mosaico”

  const linhas = [];

  // Publicado (se tivermos a data de publicação; senão, mostramos detetado)
  const publicado = timeAgoPT(item.publishedAtIso || detectedAtIso);
  linhas.push(`${EMOJIS.published} **Publicado**: ${publicado}`);

  if (item.brand) linhas.push(`${EMOJIS.brand} **Marca**: ${fixText(item.brand)}`);
  if (item.size) linhas.push(`${EMOJIS.size} **Tamanho**: ${fixText(item.size)}`);
  if (item.condition) linhas.push(`${EMOJIS.condition} **Estado**: ${fixText(item.condition)}`);

  const precoStr = moneyPT(item);
  if (precoStr) linhas.push(`${EMOJIS.price} **Preço**: ${precoStr}`);

  // Feedbacks (rating + nº avaliações) – se existir
  if (item.rating != null || item.reviews != null) {
    const estrelas = item.rating != null ? `${Number(item.rating).toFixed(1)} / 5` : "—";
    const n = item.reviews != null ? ` (${item.reviews})` : "";
    linhas.push(`${EMOJIS.feedbacks} **Feedbacks**: ${estrelas}${n}`);
  }

  // Linha final com favoritos/visualizações, se existirem
  const tailBits = [];
  if (Number.isFinite(item.favourites)) tailBits.push(`❤ ${item.favourites}`);
  if (Number.isFinite(item.views)) tailBits.push(`👁️ ${item.views}`);
  if (tailBits.length) linhas.push(tailBits.join("   •   "));

  // EMBED principal
  const mainEmbed = {
    type: "rich",
    color: COLOR,
    author: {
      name: seller,
    },
    title: title,
    url,
    description: linhas.join("\n"),
    timestamp: new Date().toISOString(),
    footer: {
      text: "GRANITO • Monitor Vinted (PT)",
    },
  };
  if (mainImg) mainEmbed.image = { url: mainImg };

  // EMBED thumbnail opcional com logotipo/1.ª extra
  const embeds = [mainEmbed];

  // Extra: até 3 imagens adicionais para simular o “mosaico”
  for (const img of extra) {
    embeds.push({
      type: "image",
      color: BRAND_COLOR,
      image: { url: img },
    });
  }

  return embeds;
}
