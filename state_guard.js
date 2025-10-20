// state_guard.js
// Guarda simples para evitar republicar anúncios já enviados nas últimas X horas.
// Usa apenas o ficheiro vinted_state.json que já tens no runner.

import fs from "fs/promises";

const STATE_FILE = "vinted_state.json";

/**
 * Carrega o estado (se existir). Caso contrário devolve estrutura base.
 */
async function carregarEstado() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const json = JSON.parse(raw);
    return json && typeof json === "object" ? json : { posted: {}, lastPrune: 0 };
  } catch {
    return { posted: {}, lastPrune: 0 };
  }
}

/**
 * Guarda estado.
 */
async function guardarEstado(state) {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Ignora silenciosamente no runner
  }
}

/**
 * @param {string|number} itemId
 * @param {number} janelaHoras — evita repetir dentro destas horas
 * @returns {Promise<boolean>} — true se já foi publicado nesta janela
 */
export async function jaPublicado(itemId, janelaHoras) {
  const state = await carregarEstado();
  const now = Date.now();
  const entrada = state.posted[`item:${itemId}`];

  // Limpeza ocasional (1x/6h)
  if (!state.lastPrune || now - state.lastPrune > 6 * 3600 * 1000) {
    for (const k of Object.keys(state.posted)) {
      const ts = state.posted[k]?.ts || 0;
      if (now - ts > 7 * 24 * 3600 * 1000) delete state.posted[k];
    }
    state.lastPrune = now;
    await guardarEstado(state);
  }

  if (!entrada) return false;

  const janelaMs = Math.max(1, Number(janelaHoras)) * 3600 * 1000;
  return now - (entrada.ts || 0) < janelaMs;
}

/**
 * Marca como publicado agora.
 */
export async function marcaPublicado(itemId, url = "") {
  const state = await carregarEstado();
  state.posted[`item:${itemId}`] = { ts: Date.now(), url };
  await guardarEstado(state);
}
