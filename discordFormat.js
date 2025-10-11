// discordFormat.js
//
// Gera a mensagem do Discord exatamente como pediste:
// - Sem descrição no embed principal
// - Campos: Preço, Tamanho, Marca, Estado, Feedbacks (opcional)
// - Botão único "Comprar no Vinted"
// - Até 3 imagens (1 principal no 1º embed + 2 imagens extra em embeds seguintes)
// - Rodapé fixo: "Comunidade GRANITO • Vinted Updates"

function fmtPrice(price, currency) {
  if (!price) return null;
  // Se vier numérico/float, normaliza para string com 2 casas
  const p = typeof price === "number" ? price.toFixed(2) : String(price);
  const cur = (currency || "EUR").toUpperCase();
  const symbol = cur === "EUR" ? "€" : cur; // simples: € para EUR, caso contrário mostra o código
  // se já vier "19.99 €" não duplica
  if (/\€|EUR|USD|GBP/i.test(p)) return p;
  return `${p} ${symbol}`;
}

export function buildDiscordMessageForItem(item) {
  const {
    title,
    url,
    photos = [],
    price,
    currency,
    size,
    brand,
    condition,
    sellerFeedbackCount, // número de opiniões/feedbacks do vendedor (opcional)
  } = item || {};

  // 1) EMBED PRINCIPAL (título, campos e imagem grande)
  const mainEmbed = {
    type: "rich",
    title: title || "Novo artigo no Vinted",
    url: url || undefined,
    // descrição removida como pedido (sem texto)
    description: undefined,
    fields: [
      price ? { name: "💰 Preço", value: fmtPrice(price, currency), inline: true } : null,
      size ? { name: "📐 Tamanho", value: String(size), inline: true } : null,
      brand ? { name: "🏷️ Marca", value: String(brand), inline: true } : null,
      condition ? { name: "✨ Estado", value: String(condition), inline: true } : null,
      (typeof sellerFeedbackCount === "number")
        ? { name: "⭐ Feedbacks", value: `${sellerFeedbackCount}`, inline: true }
        : null,
    ].filter(Boolean),
    image: photos[0] ? { url: photos[0] } : undefined,
    footer: { text: "Comunidade GRANITO • Vinted Updates • Sellers Oficiais" },
  };

  // 2) IMAGENS EXTRA (até 2)
  const extraImageEmbeds = [];
  if (photos.length > 1) {
    const extras = photos.slice(1, 3); // no máximo mais 2
    for (const img of extras) {
      extraImageEmbeds.push({
        type: "image",
        image: { url: img },
      });
    }
  }

  // 3) BOTÃO ÚNICO: COMPRAR
  const components = [];
  if (url) {
    components.push({
      type: 1, // action row
      components: [
        {
          type: 2,          // button
          style: 5,         // link button
          label: "🛒 Comprar no Vinted",
          url,
        },
      ],
    });
  }

  return {
    username: "Vinted Bot",
    avatar_url: "https://cdn-icons-png.flaticon.com/512/825/825500.png",
    embeds: [mainEmbed, ...extraImageEmbeds],
    components,
  };
}

export default buildDiscordMessageForItem;
