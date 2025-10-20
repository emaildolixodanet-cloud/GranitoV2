// discord_webhook.js
// Envio robusto para webhook (JSON) com retry/backoff

import axios from "axios";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Envia payload para webhook do Discord (JSON apenas).
 * @param {string} webhookUrl
 * @param {object} payload { username, avatar_url, content, embeds: [...] }
 */
export async function sendDiscord(webhookUrl, payload) {
  if (!webhookUrl) throw new Error("DISCORD_WEBHOOK_URL em falta.");
  const tries = 3;
  let last;

  for (let i = 1; i <= tries; i++) {
    try {
      const res = await axios.post(webhookUrl, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 20_000,
        maxRedirects: 0,
        validateStatus: s => s >= 200 && s < 300
      });
      return res?.data ?? true;
    } catch (e) {
      last = e;
      if (i < tries) await sleep(1500 * i);
    }
  }
  throw last;
}
