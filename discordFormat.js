// discordFormat.js
export function buildDiscordMessageForItem(item) {
  const safe = (v, dash = "—") => (v && String(v).trim()) ? String(v).trim() : dash;

  const main = {
    title: safe(item.title, "Novo artigo na Vinted"),
    url: item.url,
    // pedido: sem descrição de texto
    fields: [
      { name: "💰 Preço",   value: safe(item.price ? `${item.price} ${item.currency || ""}`.trim() : ""), inline: true },
      { name: "📐 Tamanho", value: safe(item.size),                                             inline: true },
      { name: "🏷️ Marca",  value: safe(item.brand),                                            inline: true },
      { name: "✨ Estado",  value: safe(item.condition) },
    ],
    // 1ª imagem dentro da mesma box
    image: item.photos?.[0] ? { url: item.photos[0] } : undefined,
    // 2ª imagem como thumbnail
    thumbnail: item.photos?.[1] ? { url: item.photos[1] } : undefined,
    footer: {
      text: "Comunidade GRANITO • Vinted Updates • Sellers Oficiais",
    },
    timestamp: item.createdAt || new Date().toISOString(),
  };

  // embeds extra com imagens 3 e 4 (se houver)
  const extraImageEmbeds = (item.photos || [])
    .slice(2, 4)
    .map((url) => ({ image: { url }, color: 3092790 }));

  const components = [
    {
      type: 1, // action row
      components: [
        {
          type: 2, style: 5, // LINK BUTTON
          label: "Comprar",
          url: item.url,
        },
      ],
    },
  ];

  return {
    username: "Bot Vinted",
    embeds: [main, ...extraImageEmbeds],
    components,
    // opcional: avatar do bot
    // avatar_url: "https://i.imgur.com/your-bot-icon.png",
  };
}
