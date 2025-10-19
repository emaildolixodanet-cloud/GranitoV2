// webhook_vinted_pt.js
// ESM (type: "module"). Node >= 18 (usa fetch global).
// Envia um embed bonito em PT-PT para um webhook do Discord, copiando o estilo do bot de referência de forma segura.

const FOOTER_TEXT = "GRANITO - Seller Oficial da Comunidade";

/**
 * @typedef {Object} VintedSeller
 * @property {string=} username        // Nome do vendedor
 * @property {number=} rating          // Média (ex.: 4.8)
 * @property {number=} reviewsCount    // Nº de avaliações
 * @property {string=} avatarUrl       // (opcional) ícone para o author
 */

/**
 * @typedef {Object} VintedStats
 * @property {number=} favorites  // Favoritos
 * @property {number=} views      // Visualizações
 */

/**
 * @typedef {Object} VintedItem
 * @property {string} title               // Título do item
 * @property {string} url                 // URL do item
 * @property {string=} priceText          // Preço com moeda (ex.: "€25")
 * @property {string=} brand              // Marca
 * @property {string=} size               // Tamanho
 * @property {string=} condition          // Estado/Condição (ex.: "Muito bom")
 * @property {string[]=} images           // Lista de URLs de imagem (usamos até 3)
 * @property {string|number|Date=} detectedAt // Data/hora da nossa deteção
 * @property {VintedSeller=} seller       // Info do vendedor
 * @property {VintedStats=} stats         // Favoritos / Visualizações
 */

/**
 * Envia um item para o Discord com visual PT-PT.
 * @param {VintedItem} item
 * @param {string=} webhookUrl  // se não vier, usa process.env.DISCORD_WEBHOOK_URL
 */
export async function sendVintedItemToDiscord(item, webhookUrl = process.env.DISCORD_WEBHOOK_URL) {
  if (!webhookUrl) {
    throw new Error("DISCORD_WEBHOOK_URL em falta. Define no .env ou passa como argumento.");
  }
  if (!item || !item.title || !item.url) {
    throw new Error("Item inválido: 'title' e 'url' são obrigatórios.");
  }

  // Normalizações seguras
  const images = Array.isArray(item.images) ? item.images.filter(Boolean) : [];
  const mainImage = images[0] || null;
  const extraImages = images.slice(1, 3); // no máx. 2 imagens adicionais (total 3)

  const ts = item.detectedAt
    ? new Date(item.detectedAt).toISOString()
    : new Date().toISOString();

  // Campos dinâmicos (só entram se existirem)
  const fields = [];

  if (item.priceText) {
    fields.push({
      name: "Preço",
      value: item.priceText,
      inline: true,
    });
  }

  if (item.brand) {
    fields.push({
      name: "Marca",
      value: item.brand,
      inline: true,
    });
  }

  if (item.size) {
    fields.push({
      name: "Tamanho",
      value: item.size,
      inline: true,
    });
  }

  if (item.condition) {
    fields.push({
      name: "Estado",
      value: item.condition,
      inline: true,
    });
  }

  // Linha separadora apenas se houver campos acima e stats abaixo
  const hasTopFields = fields.length > 0;

  // Favoritos / Visualizações
  const favs = item.stats?.favorites;
  const views = item.stats?.views;

  if (typeof favs === "number") {
    fields.push({
      name: "Favoritos",
      value: String(favs),
      inline: true,
    });
  }

  if (typeof views === "number") {
    fields.push({
      name: "Visualizações",
      value: String(views),
      inline: true,
    });
  }

  // Rating do vendedor e Nº de avaliações
  const rating = item.seller?.rating;
  const reviews = item.seller?.reviewsCount;

  if (typeof rating === "number") {
    const stars = renderStars(rating);
    fields.push({
      name: "Classificação do vendedor",
      value: `${stars} ${rating.toFixed(1)} ★`,
      inline: true,
    });
  }

  if (typeof reviews === "number") {
    fields.push({
      name: "Nº de avaliações",
      value: String(reviews),
      inline: true,
    });
  }

  // Pequena descrição (opcional). Se quiseres, podes incluir resumo aqui.
  const descriptionLines = [];
  if (hasTopFields && (typeof favs === "number" || typeof views === "number")) {
    descriptionLines.push("—");
  }
  // Podes acrescentar linhas à descrição, se necessário.
  const description = descriptionLines.join("\n").trim() || undefined;

  // Author (mostra o vendedor no topo)
  const author = item.seller?.username
    ? {
        name: `Vendedor: ${item.seller.username}`,
        url: item.url, // clicar no author abre o item (podes trocar pela página do vendedor se tiveres)
        icon_url: item.seller.avatarUrl || undefined,
      }
    : undefined;

  // Thumbnail: se tiveres uma 2ª imagem, podes usar como thumbnail; senão usa a 1ª como imagem principal
  const thumbnailUrl = mainImage ? mainImage : undefined;

  // Embed principal (conteúdo + imagem/thumbnail)
  const mainEmbed = {
    title: item.title,
    url: item.url,
    description,
    color: 0x2b6cb0, // azul elegante; ajusta se quiseres
    timestamp: ts,
    footer: {
      text: FOOTER_TEXT,
    },
    author, // opcional
    fields,
  };

  // Temos duas opções visuais:
  // A) Usar thumbnail no embed principal (mais compacto)
  // B) Usar imagem grande (embed.image)
  //
  // Vamos usar B) para o 1º embed e depois meter 2 embeds adicionais só com imagem.
  if (mainImage) {
    mainEmbed.image = { url: mainImage };
  }

  // Embeds adicionais só com imagem (até 2 para total de 3)
  const imageEmbeds = extraImages.map((url) => ({
    image: { url },
    color: 0x2b6cb0,
    footer: { text: FOOTER_TEXT },
    timestamp: ts,
  }));

  const payload = {
    content: "", // sem texto “solto”
    embeds: [mainEmbed, ...imageEmbeds],
    // username / avatar_url (opcionais) — se quiseres personalizar o “bot”:
    // username: "GRANITO",
    // avatar_url: "https://…/logo.png"
  };

  // Envio seguro
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`Falha ao enviar para Discord (${res.status}): ${body}`);
  }
}

/**
 * Renderiza estrelas (simbolos) para a classificação média
 * Ex.: 4.3 -> "★★★★☆"
 */
function renderStars(avg) {
  const full = Math.floor(avg);
  const half = avg - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return "★".repeat(full) + (half ? "½" : "") + "☆".repeat(empty);
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "<sem corpo>";
  }
}

// ---------------------------------------------------------
// Exemplo de uso (podes apagar):
// Executa `node webhook_vinted_pt.js` para um teste rápido
// Necessário: DISCORD_WEBHOOK_URL definido no ambiente
// ---------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const demoItem = {
    title: "Camisola malha mulher Ralph Lauren (L) bege",
    url: "https://www.vinted.pt/items/123456789",
    priceText: "€25",
    brand: "Ralph Lauren",
    size: "L",
    condition: "Muito bom",
    images: [
      "https://i.imgur.com/XXXXXXXX.jpg",
      "https://i.imgur.com/YYYYYYYY.jpg",
      "https://i.imgur.com/ZZZZZZZZ.jpg",
    ],
    detectedAt: new Date(),
    seller: {
      username: "loja_da_maria",
      rating: 4.8,
      reviewsCount: 152,
      // avatarUrl: "https://…"
    },
    stats: {
      favorites: 7,
      views: 123,
    },
  };

  sendVintedItemToDiscord(demoItem)
    .then(() => console.log("Embed de teste enviado."))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
