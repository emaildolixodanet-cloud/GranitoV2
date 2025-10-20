// item_embed_pt.js
// Construção do EMBED em PT-PT para o Discord (estilo “bot bonito”)

const HEX = { blue: 0x2b6cb0, green: 0x2f855a, red: 0xc53030, gray: 0x4a5568 };

const fmt = {
  money(v) {
    if (v == null) return "—";
    const num = typeof v === "string" ? parseFloat(v.replace(",", ".").replace(/[^\d.]/g, "")) : Number(v);
    if (!isFinite(num)) return String(v);
    return new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(num);
  },
  str(v) {
    if (v == null) return "—";
    return String(v).toString().trim();
  },
  // aceita timestamp (ms/s) ou ISO
  dateRel(ts) {
    try {
      let d = ts;
      if (typeof ts === "number") {
        if (ts < 10_000_000_000) d = new Date(ts * 1000);
        else d = new Date(ts);
      } else {
        d = new Date(ts);
      }
      if (isNaN(d)) return "—";
      const diffMs = Date.now() - d.getTime();
      const diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 60) return `${diffMin} min atrás`;
      const diffH = Math.floor(diffMin / 60);
      if (diffH < 24) return `${diffH} h atrás`;
      const diffD = Math.floor(diffH / 24);
      return `${diffD} dia${diffD === 1 ? "" : "s"} atrás`;
    } catch {
      return "—";
    }
  },
  truncate(text, max = 300) {
    const s = fmt.str(text);
    return s.length > max ? s.slice(0, max - 1) + "… " : s;
  }
};

/**
 * Normaliza um objeto item vindo do teu scraper.
 * Aceita chaves comuns do Vinted e faz fallback seguro.
 */
function normalize(item) {
  // tenta apanhar URL e ID
  const url = item?.url || item?.permalink || (item?.id ? `https://www.vinted.pt/items/${item.id}` : undefined);

  // título/descrição
  const title = item?.title || item?.name || "Artigo no Vinted";
  const description = item?.description || item?.desc || "";

  // preço
  const price =
    item?.price ||
    item?.price_num ||
    item?.price_value ||
    (item?.price_eur ? `${item.price_eur} €` : undefined);

  // imagens (usa primeira grande)
  const photos = Array.isArray(item?.photos) ? item.photos : (item?.image ? [item.image] : []);
  const imageUrl =
    item?.image_large ||
    item?.photo_hd ||
    photos?.[0] ||
    item?.photo ||
    item?.cover_photo ||
    undefined;

  // vendedor / localização
  const seller =
    item?.seller?.username ||
    item?.seller_name ||
    item?.user?.login ||
    item?.member_name ||
    "—";

  const city = item?.city || item?.location || item?.seller?.city || "—";

  // metadados
  const size = item?.size || item?.size_title || item?.size_label || "—";
  const brand = item?.brand || item?.brand_title || item?.brand_name || "—";
  const condition = item?.condition || item?.status || item?.state || "—";
  const category = item?.category || item?.catalog || item?.category_name || "—";

  const likes = item?.favorites || item?.favourites || item?.likes || 0;
  const views = item?.views || 0;

  // data
  const createdAt = item?.created_at || item?.created || item?.upload_time || item?.published || item?.date;

  return {
    id: item?.id ?? null,
    url,
    title,
    description,
    price,
    photos,
    imageUrl,
    seller,
    city,
    size,
    brand,
    condition,
    category,
    likes: Number(likes) || 0,
    views: Number(views) || 0,
    createdAt
  };
}

/**
 * Cria um payload de webhook com 1 embed, PT-PT, seguro.
 * @param {object} rawItem Objeto do scraper
 * @param {object} opts { username, avatar_url }
 */
export function buildItemEmbedPT(rawItem, opts = {}) {
  const it = normalize(rawItem);

  const fields = [
    { name: "Preço", value: fmt.money(it.price), inline: true },
    { name: "Tamanho", value: fmt.str(it.size), inline: true },
    { name: "Estado", value: fmt.str(it.condition), inline: true },
    { name: "Marca", value: fmt.str(it.brand), inline: true },
    { name: "Categoria", value: fmt.str(it.category), inline: true },
    { name: "Localização", value: fmt.str(it.city), inline: true },
    { name: "Vendedor", value: fmt.str(it.seller), inline: true },
    { name: "Favoritos", value: String(it.likes), inline: true },
    { name: "Visualizações", value: String(it.views), inline: true }
  ];

  const embed = {
    title: fmt.str(it.title),
    url: it.url,
    description: fmt.truncate(it.description || "—", 350),
    color: HEX.blue,
    author: {
      name: "GRANITO • Seller Oficial da Comunidade",
    },
    thumbnail: it.photos?.[1] ? { url: it.photos[1] } : undefined,
    image: it.imageUrl ? { url: it.imageUrl } : undefined,
    fields,
    footer: {
      text: `Publicado: ${fmt.dateRel(it.createdAt)} • Proteção ao comprador incluída`
    },
    timestamp: new Date().toISOString()
  };

  return {
    username: opts.username || "Granito Vinted",
    avatar_url: opts.avatar_url || undefined,
    content: null,
    embeds: [embed]
  };
}
