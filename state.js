import fs from "fs";

const STATE_FILE = "vinted_state.json";

export function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { posted: {}, lastPrune: 0 };
    }
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { posted: {}, lastPrune: 0 };
  }
}

export function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
