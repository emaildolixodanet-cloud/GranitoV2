// state.js — persistência anti-duplicados entre execuções via artifact
import fs from "fs";

export const STATE_PATH = "./vinted_state.json";

// Carrega estado do disco (se não existir, cria um default)
export function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      return { posted: {}, lastPrune: Date.now() };
    }
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data.posted) data.posted = {};
    return data;
  } catch {
    return { posted: {}, lastPrune: Date.now() };
  }
}

// Salva estado no disco
export function saveState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("Falha a gravar estado:", e.message);
  }
}

// Gera um ID estável para o item (usa URL; se existir itemId, melhor ainda)
export function itemId(item) {
  // captura o /items/123456789 da URL, se existir
  const m = item.url?.match(/\/items\/(\d+)/);
  if (m) return m[1];
  return item.url || item.title || String(Math.random());
}

// Já foi publicado?
export function wasPosted(state, item) {
  const id = itemId(item);
  return Boolean(state.posted[id]);
}

// Marca como publicado agora
export function markPosted(state, item) {
  const id = itemId(item);
  state.posted[id] = Date.now();
}

// Limpa IDs antigos (ex.: manter 14 dias)
export function pruneOld(state, keepDays = 14) {
  const maxAge = keepDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [id, ts] of Object.entries(state.posted)) {
    if (!ts || now - ts > maxAge) {
      delete state.posted[id];
    }
  }
  state.lastPrune = now;
}
