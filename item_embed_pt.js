// item_embed_pt.js
// Constrói o embed em Português de Portugal inspirado no visual do outro bot.
// 100% independente: recebe um "item" (objeto com campos comuns) e devolve
// { username, avatar_url, embeds, files? } pronto para enviar via webhook.

import fs from "fs/promises";

/**
 * Espera um objeto item com pelo menos:
 * {
 *   id: string|number,
 *   url: string,                 // link do anúncio
 *   titulo: string,              // título do anúncio
 *   preco: number|string,        // preço em número (euros) ou string "15 €"
 *   tamanho: string|null,        // por ex: "L"
 *   marca: string|null,          // por ex: "Ralph Lauren"
 *   estado: string|null,         // por ex: "Muito bom"
 *   local: string|null,          // por ex: "Porto"
 *   vendedor: { nome, url }|null,
 *   fotos: string[]              // urls absolutas das imagens (0..n)
 * }
 *
 * @param {object} item
 * @param {object} [opts]
 * @param {boolean} [opts.incluirImagens=true] — se true, anexa 1ª imagem como ficheiro
 * @returns {Promise<{username:string, avatar_url?:string, embeds:any[], files?:any[]}>}
 */
export async function construirPayloadPT(item, opts = {}) {
  const {
    incluirImagens = true
  } = opts;

  // Normalizações leves e 100% seguras
  const safe = (v) => (v ?? "").toString().trim();
  const numToPreco = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return `${v.toFixed(2)} €`;
    if (typeof v === "string") return v;
    return "—";
  };

  const titulo = safe(item.titulo) || "Anúncio Vinted";
  const url = safe(item.url) || (item.id ? `https://www.vinted.pt/items/${item.id}` : "");
  const preco = numToPreco(item.preco);
  const tamanho = safe(item.tamanho) || "—";
  const marca = safe(item.marca) || "—";
  const estado = safe(item.estado) || "—";
  const local = safe(item.local) || "—";
  const vendedorNome = safe(item?.vendedor?.nome) || "—";
  const vendedorUrl = safe(item?.vendedor?.url) || "";

  // Pequena linha de “autor”
  const author = {
    name: "GRANITO – Seller Oficial da Comunidade",
  };

  // Campos do embed (em PT-PT)
  const fields = [
    { name: "Preço", value: preco, inline: true },
    { name: "Tamanho", value: tamanho, inline: true },
    { name: "Marca", value: marca, inline: true },
    { name: "Estado", value: estado, inline: true },
    { name: "Local", value: local, inline: true },
  ];

  if (vendedorUrl || vendedorNome !== "—") {
    fields.push({
      name: "Vendedor",
      value: vendedorUrl ? `[${vendedorNome}](${vendedorUrl})` : vendedorNome,
      inline: true,
    });
  }

  // Primeira imagem (se existir)
  const primeiraFoto = Array.isArray(item.fotos) && item.fotos.length > 0 ? item.fotos[0] : null;

  // Footer simples
  const footer = { text: "Criar conta | Iniciar sessão" };

  const embed = {
    title: titulo,
    url,
    author,
    description: "", // opcional
    fields,
    footer,
    timestamp: new Date().toISOString(),
  };

  const payload = {
    username: "GRANITO • Bot de Vendas",
    embeds: [embed],
  };

  // Opcionalmente anexamos a 1ª imagem de forma compatível com webhooks
  // (como ficheiro), o que força o Discord a mostrar a imagem grande.
  if (incluirImagens && primeiraFoto && primeiraFoto.startsWith("http")) {
    try {
      // Para máxima compatibilidade do runner, não fazemos download nós próprios.
      // Em vez disso, usamos a imagem no embed (sem anexar ficheiro).
      // Isto evita falhas por timeouts/redes no runner.
      embed.image = { url: primeiraFoto };
    } catch {
      // Fallback silencioso: ignora anexos se algo falhar.
    }
  }

  return payload;
}
