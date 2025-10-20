/**
 * Formatação dos embeds do Discord — visual limpo, PT-PT
 * Sem cabeçalhos desnecessários. Um único embed rico.
 */

export function buildEmbedsPT(item, detectedAtIso) {
  const fields = [];

  if (item.priceText) fields.push({ name: "Preço", value: item.priceText, inline: true });
  if (item.brand)     fields.push({ name: "Marca", value: item.brand, inline: true });
  if (item.size)      fields.push({ name: "Tamanho", value: item.size, inline: true });
  if (item.condition) fields.push({ name: "Estado", value: item.condition, inline: true });
  if (item.seller)    fields.push({ name: "Vendedor", value: item.seller, inline: true });

  const stats = [];
  if (Number.isFinite(item.favourites)) stats.push(`❤️ ${item.favourites}`);
  if (Number.isFinite(item.views))      stats.push(`👁️ ${item.views}`);
  if (Number.isFinite(item.rating)) {
    const stars = "⭐".repeat(Math.max(1, Math.min(5, Math.round(item.rating))));
    const r = item.reviews ? ` (${item.reviews})` : "";
    stats.push(`${stars}${r}`);
  }
  if (stats.length) fields.push({ name: "Popularidade", value: stats.join("   "), inline: false });

  // imagem principal e thumbnail
  const images = Array.isArray(item.images) ? item.images.filter(Boolean) : [];
  const image = images[0] || null;
  const thumb = images[1] || images[0] || null;

  const detected = new Date(detectedAtIso);
  const dd = String(detected.getDate()).padStart(2, "0");
  const mm = String(detected.getMonth() + 1).padStart(2, "0");
  const yyyy = detected.getFullYear();
  const hh = String(detected.getHours()).padStart(2, "0");
  const min = String(detected.getMinutes()).padStart(2, "0");
  const footerText = `Vinted • Detetado às ${hh}:${min} de ${dd}/${mm}/${yyyy}`;

  // cor: verde-água (teal)
  const color = 0x00b3a4;

  const embed = {
    title: item.title || "Novo artigo",
    url: item.url,
    description: "", // manter limpo
    color,
    fields,
    footer: { text: footerText },
    timestamp: detectedAtIso
  };

  if (thumb) embed.thumbnail = { url: thumb };
  if (image) embed.image = { url: image };

  return [embed];
}
