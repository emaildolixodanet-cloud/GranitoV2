/**
 * Formatação dos embeds em PT-PT, visual limpo e consistente.
 * – Título clicável
 * – Preço em destaque
 * – Campos compactos (Marca/Tamanho/Estado)
 * – Rodapé e timestamp
 */

export function buildEmbedsPT(item, detectedAtIso) {
  const {
    title = "Sem título",
    url,
    priceText = "",
    priceConvertedText = "",
    images = [],
    brand = "",
    size = "",
    condition = "",
    seller = "",
    favourites,
    views,
    rating,
    reviews,
  } = item;

  const fields = [];

  if (brand) fields.push({ name: "Marca", value: brand, inline: true });
  if (size) fields.push({ name: "Tamanho", value: size, inline: true });
  if (condition) fields.push({ name: "Estado", value: condition, inline: true });

  const stats = [];
  if (typeof favourites === "number") stats.push(`❤ ${favourites}`);
  if (typeof views === "number") stats.push(`👁 ${views}`);
  if (typeof rating === "number") {
    const r = reviews ? `${rating.toFixed(1)}★ · ${reviews}` : `${rating.toFixed(1)}★`;
    stats.push(r);
  }

  const descLines = [];
  if (seller) descLines.push(`**Vendedor:** ${seller}`);
  if (stats.length) descLines.push(stats.join("  •  "));
  if (priceConvertedText) descLines.push(`≈ ${priceConvertedText}`);

  // Imagem principal
  const image = images?.[0];

  const embed = {
    title,
    url,
    description: descLines.join("\n"),
    color: 0x00b894, // verde suave
    fields,
    thumbnail: image ? { url: image } : undefined,
    footer: { text: "GRANITO • Monitor Vinted (PT)" },
    timestamp: detectedAtIso,
  };

  // Preço destacado no topo, se existir
  if (priceText) {
    embed.author = { name: priceText };
  }

  return [embed];
}
