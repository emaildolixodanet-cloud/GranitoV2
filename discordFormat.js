// discordFormat.js
export function buildDiscordMessageForItem(item) {
  const safe = (v, dash = "—") => (v && String(v).trim()) ? String(v).trim() : dash;

  const main = {
    title: safe(item.title, "Novo artigo na Vinted"),
    url: item.url,
    fields: [
      { name: "💰 Preço",   value: safe(item.price ? `${item.price} ${item.currency || ""}`.trim() : ""), inline: true },
      { name: "📐 Tamanho", value: safe(item.size),                                             inline: true },
      { name: "🏷️ Marca",  value: safe(item.brand),                                            inline: true },
      { name: "✨ Estado",  value: safe(item.condition) },
    ],
    // apenas thumbnail (pequeno) no embed principal
    thumbnail: item.photos?.[0] ? { url: item.photos[0] } : undefined,
    footer: {
      text: "Comunidade GRANITO • Vinted Updates • Sellers Oficiais",
    },
    timestamp: item.createdAt || new Date().toISOString(),
  };

  // 2 thumbs adicionais (sem imagem grande)
  const extraThumbs = (item.photos || [])
    .slice(1, 3)
    .map((url) => ({
      url: item.url,
      thumbnail: { url },
      color: 3092790,
      footer: { text: " " }, // evita footer do Discord ocupar espaço
    }));

  const components = [
    {
      type: 1, // action row
      components: [
        { type: 2, style: 5, label: "Comprar", url: item.url }, // botão link
      ],
    },
  ];

  return {
    username: "Bot Vinted",
    embeds: [main, ...extraThumbs],
    components,
  };
}
