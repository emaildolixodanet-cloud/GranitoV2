// state_guard.js
// Filtro de anúncios antigos + anti-repost persistente.

import fs from "fs";

const STATE_PATH = process.env.STATE_FILE || "vinted_state.json";
const HOURS_NEW = Number(process.env.ONLY_NEWER_HOURS || 24);
const HOURS_REPOST = Number(process.env.ALLOW_REPOST_AFTER_HOURS || 72);

function now() { return Date.now(); }
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { posted: {}, lastPrune: 0 };
  }
}
function saveState(st) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
}

function getItemId(item) {
  if (item?.id) return String(item.id);
  const m = (item?.url || "").match(/items\/(\d+)/);
  return m?.[1] || null;
}

function toMs(t) {
  if (!t) return null;
  if (typeof t === "number") return t < 10_000_000_000 ? t * 1000 : t;
  const d = new Date(t);
  return isNaN(d) ? null : d.getTime();
}

/**
 * Decide se devemos publicar um item.
 * Regras:
 *  - Se tiver data de criação e for mais antigo do que ONLY_NEWER_HOURS => não publica
 *  - Se já foi publicado e ainda não passou ALLOW_REPOST_AFTER_HOURS => não publica
 *  - Caso não haja data nenhuma: publica só se nunca foi publicado
 */
export function shouldPost(item, state = loadState()) {
  const id = getItemId(item);
  const createdMs = toMs(item?.created_at || item?.created || item?.upload_time || item?.published || item?.date);

  const limitNewMs = now() - HOURS_NEW * 3600_000;
  if (createdMs && createdMs < limitNewMs) {
    return { ok: false, reason: "antigo" };
  }

  const key = id ? `item:${id}` : (item?.url || null);
  if (!key) return { ok: false, reason: "sem-id" };

  const rec = state.posted[key];
  if (rec && rec.ts && rec.ts > (now() - HOURS_REPOST * 3600_000)) {
    return { ok: false, reason: "repost" };
  }

  return { ok: true, reason: "novo", key };
}

export function markPosted(key, url, state = loadState()) {
  state.posted[key] = { ts: now(), url: url || null };
  // limpeza a cada 7 dias
  if (!state.lastPrune || (now() - state.lastPrune) > 7 * 24 * 3600_000) {
    const cutoff = now() - 30 * 24 * 3600_000;
    for (const k of Object.keys(state.posted)) {
      if (!state.posted[k]?.ts || state.posted[k].ts < cutoff) delete state.posted[k];
    }
    state.lastPrune = now();
  }
  saveState(state);
}
