// ======================= DISCORD EMBED FORMAT (FINAL LIVE VERSION) ===========================
export function buildDiscordMessageForItem(item) {
  // Cria o primeiro embed principal (texto e imagem)
  const mainEmbed = {
    author: {
      name: item.sellerName || "Vinted Seller",
      url: item.sellerUrl || "",
      icon_url: item.sellerAvatar || "https://cdn-icons-png.flaticon.com/512/194/194938.png",
    },
    title: item.title || "Novo artigo",
    url: item.url,
    description: item.description
      ? `${item.description.slice(0, 250)}${item.description.length > 250 ? "..." : ""}`
      : "_Sem descrição._",
    color: 0x2F3136,
    fields: [
      item.price ? { name: "💰 Preço", value: `${item.price} ${item.currency || "€"}`, inline: true } : null,
      item.brand ? { name: "🏷️ Marca", value: item.brand, inline: true } : null,
      item.size ? { name: "📐 Tamanho", value: item.size, inline: true } : null,
      item.condition ? { name: "💎 Estado", value: item.condition, inline: true } : null,
    ].filter(Boolean),
    footer: { text: "🧩 Vinted • Clique no título para abrir" },
    timestamp: new Date(),
  };

  // Adiciona a imagem principal (a primeira)
  if (item.photos?.[0]) {
    mainEmbed.image = { url: item.photos[0] };
  }

  // Cria até 2 embeds adicionais para mostrar as outras fotos
  const imageEmbeds = [];
  if (item.photos && item.photos.length > 1) {
    for (let i = 1; i < Math.min(item.photos.length, 3); i++) {
      imageEmbeds.push({
        url: item.url,
        image: { url: item.photos[i] },
        color: 0x2F3136,
      });
    }
  }

  // Botões de ação
  const buttons = {
    type: 1,
    components: [
      {
        type: 2,
        label: "🔍 Ver artigo",
        style: 5,
        url: item.url,
      },
      {
        type: 2,
        label: "💬 Negociar",
        style: 5,
        url: item.url,
      },
      {
        type: 2,
        label: "🛒 Comprar",
        style: 5,
        url: item.url,
      },
    ],
  };

  // Monta o payload final com embeds e botões
  return {
    embeds: [mainEmbed, ...imageEmbeds],
    components: [buttons],
  };
}
