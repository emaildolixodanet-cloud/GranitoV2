// publisher_bridge.js
// Ponte pronta a usar no teu fluxo atual: recebe um array de itens "crus"
// (vindos do teu scraper) e publica no Discord usando o visual PT-PT,
// ignorando itens antigos conforme as horas configuradas.

import { construirPayloadPT } from "./item_embed_pt.js";
import { enviarWebhook } from "./discord_webhook.js";
import { jaPublicado, marcaPublicado } from "./state_guard.js";

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const ONLY_NEWER_HOURS = Number(process.env.ONLY_NEWER_HOURS || 24);

/**
 * Publica uma lista de itens em sequência (resiliente a falhas).
 * @param {Array<object>} itens
 * @param {object} [opts]
 * @param {boolean} [opts.testMode=false]
 */
export async function publicarItensPT(itens, opts = {}) {
  if (!WEBHOOK_URL) {
    console.log("⚠️  DISCORD_WEBHOOK_URL não definido — nada será enviado.");
    return { enviados: 0, ignorados: itens?.length || 0 };
  }

  const testMode = !!opts.testMode || String(process.env.TEST_MODE).toLowerCase() === "true";
  let enviados = 0, ignorados = 0;

  for (const item of itens || []) {
    const id = item?.id ?? item?.item_id ?? item?.url ?? Math.random().toString(36).slice(2);
    const url = item?.url || "";
    const createdAt = item?.createdAt || item?.created_at || item?.timestamp || null;

    // Filtro de "apenas mais recentes"
    if (createdAt) {
      const ageMs = Date.now() - new Date(createdAt).getTime();
      if (ageMs > ONLY_NEWER_HOURS * 3600 * 1000) {
        ignorados++; 
        continue;
      }
    }

    if (await jaPublicado(id, ONLY_NEWER_HOURS)) {
      ignorados++; 
      continue;
    }

    const payload = await construirPayloadPT(item, { incluirImagens: true });

    try {
      if (testMode) {
        console.log("🧪 [TEST_MODE] Simulação de envio:", payload.embeds?.[0]?.title || "(sem título)");
      } else {
        await enviarWebhook(WEBHOOK_URL, payload);
      }
      await marcaPublicado(id, url);
      enviados++;
    } catch (err) {
      console.log("⚠️  Falha ao enviar para o Discord:", err?.message || err);
    }
  }

  console.log(`📦 Resumo publicação: enviados=${enviados}, ignorados=${ignorados}`);
  return { enviados, ignorados };
}
