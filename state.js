// state.js
import fs from "fs";
import path from "path";

const STATE_PATH = path.resolve(".github/vinted_state.json");

// estrutura: { posted: { "<id>": 1733910060, ... } }  // timestamp unix
const DEFAULT_STATE = { posted: {} };

function ensureStateFile() {
  if (!fs.existsSync(path.dirname(STATE_PATH))) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  }
  if (!fs.existsSync(STATE_PATH)) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(DEFAULT_STATE, null, 2));
  }
}

export function loadState() {
  try {
    ensureStateFile();
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const json = JSON.parse(raw || "{}");
    return { ...DEFAULT_STATE, ...json };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state) {
  ensureStateFile();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ID estável do item (usa o número do /items/ ou, em último caso, a URL)
export function extractItemId(item) {
  if (!item) return null;
  if (item.id) return String(item.id);
  if (item.url) {
    const m = item.url.match(/\/items\/(\d+)/);
    if (m) return m[1];
    return item.url;
  }
  return null;
}

export function wasPosted(state, item) {
  const id = extractItemId(item);
  if (!id) return false;
  return Boolean(state.posted[id]);
}

export function markPosted(state, item) {
  const id = extractItemId(item);
  if (!id) return;
  state.posted[id] = Math.floor(Date.now() / 1000);
}

// limpeza opcional: remove IDs com mais de X dias para o ficheiro não crescer para sempre
export function pruneOld(state, days = 14) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 3600;
  for (const [id, ts] of Object.entries(state.posted)) {
    if (ts < cutoff) delete state.posted[id];
  }
}
