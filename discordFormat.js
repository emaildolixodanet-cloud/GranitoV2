// Formatação do embed em PT-PT, com rodapé pedido
export function buildEmbedsPT(item, detectedAtIso) {
  const {
    title,
    url,
    priceText,
    priceConvertedText,
    brand,
    size,
    condition,
    images = [],
    seller,
    favourites,
    views,
    rating,
    reviews
  } = item;

  const fields = [];

  if (brand) fields.push({ name: "Marca", value: brand, inline: true });
  if (size) fields.push({ name: "Tamanho", value: size, inline: true });
  if (condition) fields.push({ name: "Estado", value: condition, inline: true });

  if (favourites != null) fields.push({ name: "Favoritos", value: String(favourites), inline: true });
  if (views != null) fields.push({ name: "Visualizações", value: String(views), inline: true });

  if (rating != null) fields.push({ name: "Rating do vendedor", value: `${rating.toFixed(1)} ★`, inline: true });
  if (reviews != null) fields.push({ name: "N.º de avaliações", value: String(reviews), inline: true });

  // Preço
  const priceLine = [priceText, priceConvertedText].filter(Boolean).join("  |  ");

  const baseEmbed = {
    title: title || "Novo item no Vinted",
    url,
    description: priceLine || undefined,
    color: 0x2b90d9,
    fields,
    timestamp: detectedAtIso,
    author: seller ? { name: seller } : undefined,
    footer: { text: "GRANITO - Seller Oficial da Comunidade" }
  };

  const embeds = [baseEmbed];

  // até 3 imagens (1 principal + 2 adicionais). Discord permite 1 imagem por embed
  const imgs = images.slice(0, 3);
  if (imgs[0]) embeds[0].image = { url: imgs[0] };
  if (imgs[1]) embeds.push({ image: { url: imgs[1] } });
  if (imgs[2]) embeds.push({ image: { url: imgs[2] } });

  return embeds;
}
