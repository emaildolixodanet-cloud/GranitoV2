// Gera payload com 1 embed principal + até 2 imagens extra (total 3 imagens)
export function buildDiscordMessageForItem(item) {
  const photos = Array.isArray(item.photos) ? item.photos.filter(Boolean) : [];
  const mainImg = photos[0];
  const extra = photos.slice(1, 3); // até 2 imagens adicionais

  const fields = [];

  if (item.price) {
    fields.push({
      name: "💰 Preço",
      value: `${item.price} ${item.currency || "€"}`,
      inline: true,
    });
  }
  if (item.brand) {
    fields.push({
      name: "🏷️ Marca",
      value: item.brand,
      inline: true,
    });
  }
  if (item.size) {
    fields.push({
      name: "📐 Tamanho",
      value: item.size,
      inline: true,
    });
  }
  if (item.condition) {
    fields.push({
      name: "💎 Estado",
      value: item.condition,
      inline: true,
    });
  }

  const mainEmbed = {
    author: item.sellerName
      ? {
          name: item.sellerName,
          url: item.sellerUrl || undefined,
          icon_url: item.sellerAvatar || undefined,
        }
      : undefined,
    title: item.title || "Novo artigo",
    url: item.url,
    description: item.description ? item.description.toString().slice(0, 600) : "",
    color: 0x2b2d31,
    fields,
    image: mainImg ? { url: mainImg } : undefined,
    footer: {
      text:
        "Vinted • Clique no título para abrir" +
        (item.createdAt ? ` • ${new Date(item.createdAt).toLocaleString("pt-PT")}` : ""),
    },
  };

  const galleryEmbeds = extra.map((url) => ({
    url: item.url,
    image: { url },
    color: 0x2b2d31,
  }));

  return {
    embeds: [mainEmbed, ...galleryEmbeds],
  };
}
