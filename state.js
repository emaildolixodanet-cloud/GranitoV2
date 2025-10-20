import fs from "fs";

const STATE_FILE = "vinted_state.json";

export function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf8");
      const json = JSON.parse(raw);
      // garantir estrutura mínima
      return {
        posted: json.posted || {},
        lastPrune: json.lastPrune || 0
      };
    }
  } catch (e) {
    console.log("⚠️ Não foi possível ler o state, vou recriar. Motivo:", e.message);
  }
  return { posted: {}, lastPrune: 0 };
}

export function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.log("⚠️ Erro a guardar state:", e.message);
  }
}
