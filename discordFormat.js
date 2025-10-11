// discordFormat.js (ESM)  -----------------------------
const BRAND_BLUE = 0x2b7fff;

function stars(rating = 0, count = 0) {
  const full = Math.round(Math.max(0, Math.min(5, rating)));
  return `${'★'.repeat(full)}${'☆'.repeat(5 - full)} (${count})`;
}

function short(text, max = 220) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

function relative(t) {
  try {
    const d = t instanceof Date ? t : new Date(t);
    if (isNaN(d)) return '—';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return `${Math.floor(diff)}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  } catch { return '—'; }
}

function buildItemMainEmbed(item) {
  const priceLine = item.price
    ? `${item.price} ${item.currency || 'EUR'}`
    : '—';

  const fields = [
    { name: '📅 Published', value: relative(item.createdAt), inline: true },
    { name: '🏷️ Brand',     value: item.brand || '—',         inline: true },
    { name: '📐 Size',      value: item.size || '—',          inline: true },
    { name: '💰 Price',     value: priceLine,                 inline: true },
    { name: '⭐ Feedbacks', value: stars(item.rating, item.ratingCount), inline: true },
    { name: '💎 Status',    value: item.condition || '—',     inline: true },
  ];

  return {
    title: `🧥 ${item.title || 'Artigo Vinted'}`,
    url: item.url,
    color: BRAND_BLUE,
    author: item.sellerName
      ? {
          name: item.sellerName,
          url: item.sellerUrl || item.url,
          icon_url: item.sellerAvatar || undefined,
        }
      : undefined,
    description: short(item.description)
      ? `> ${short(item.description)}`
      : undefined,
    fields,
    thumbnail: item.photos?.[0] ? { url: item.photos[0] } : undefined,
    image:     item.photos?.[1] ? { url: item.photos[1] } : undefined,
    footer: {
      text: 'Vinted • clique no título para abrir',
      icon_url:
        'https://seeklogo.com/images/v/vinted-logo-0C1DBB4C36-seeklogo.com.png',
    },
    timestamp: item.createdAt ? new Date(item.createdAt).toISOString() : undefined,
  };
}

function buildGalleryEmbeds(item, maxExtras = 2) {
  const extra = (item.photos || []).slice(2, 2 + maxExtras);
  return extra.map((url) => ({
    color: BRAND_BLUE,
    image: { url },
  }));
}

function buildActionButtons(item) {
  const detailsUrl   = item.url;
  const buyUrl       = item.url;
  const negotiateUrl = item.url;
  const autobuyUrl   = item.url;

  return [
    {
      type: 1, // action row
      components: [
        { type: 2, style: 5, label: '📄 Details',   url: detailsUrl },
        { type: 2, style: 5, label: '🛒 Buy',       url: buyUrl },
        { type: 2, style: 5, label: '🤝 Negotiate', url: negotiateUrl },
        { type: 2, style: 5, label: '✅ Autobuy',   url: autobuyUrl },
      ],
    },
  ];
}

export function buildDiscordMessageForItem(item) {
  const main = buildItemMainEmbed(item);
  const gallery = buildGalleryEmbeds(item);
  const components = buildActionButtons(item);
  return {
    embeds: [main, ...gallery],
    components,
  };
}
