import fs from "fs";

const STATE_FILE = "vinted_state.json";

export function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") throw new Error("invalid");
    if (!obj.posted) obj.posted = {};
    return obj;
  } catch {
    return { posted: {}, lastPrune: 0 };
  }
}

export function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("⚠️ Não foi possível guardar state:", e.message);
  }
}
