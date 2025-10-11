// discordFormat.js
export function buildDiscordMessageForItem(item) {
  const safe = (v, dash = "—") => (v && String(v).trim()) ? String(v).trim() : dash;

  // mostrar preço exatamente como veio (mantendo vírgulas), mas garante a moeda
  let priceText = "";
  if (item.priceText) {
    priceText = item.priceText;
  } else if (item.price) {
    const p = String(item.price).replace(/\./g, ","); // preferir vírgula pt
    priceText = item.currency ? `${p} ${item.currency}` : p;
  }

  const fields = [
    { name: "💰 Preço",   value: safe(priceText), inline: true },
    { name: "📐 Tamanho", value: safe(item.size), inline: true },
    { name: "🏷️ Marca",  value: safe(item.brand), inline: true },
    { name: "✨ Estado",  value: safe(item.condition) },
  ];

  if (typeof item.feedbacks === "number") {
    fields.push({ name: "⭐ Opiniões", value: `${item.feedbacks}`, inline: true });
  }

  const main = {
    title: safe(item.title, "Novo artigo na Vinted"),
    url: item.url,
    fields,
    thumbnail: item.photos?.[0] ? { url: item.photos[0] } : undefined,
    footer: { text: "Comunidade GRANITO • Vinted Updates • Sellers Oficiais" },
    timestamp: item.createdAt || new Date().toISOString(),
  };

  // 2 thumbs pequenos adicionais
  const extraThumbs = (item.photos || [])
    .slice(1, 3)
    .map((url) => ({
      url: item.url,
      thumbnail: { url },
      color: 3092790,
      footer: { text: " " },
    }));

  const components = [
    {
      type: 1,
      components: [
        { type: 2, style: 5, label: "Comprar", url: item.url },
      ],
    },
  ];

  return { username: "Bot Vinted", embeds: [main, ...extraThumbs], components };
}
