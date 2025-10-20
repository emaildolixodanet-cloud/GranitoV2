// discord_webhook.js
// Envio robusto de payloads (webhook) com backoff, sem dependências perigosas.

import https from "https";
import { URL } from "url";

/**
 * Envia um payload JSON para um Webhook Discord.
 * @param {string} webhookUrl
 * @param {object} body
 * @param {number} [tentativas=3]
 */
export function enviarWebhook(webhookUrl, body, tentativas = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(webhookUrl);
    const data = Buffer.from(JSON.stringify(body), "utf8");

    const opts = {
      method: "POST",
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": data.length,
        "User-Agent": "GranitoBot/1.0",
      },
      timeout: 15000,
    };

    const req = https.request(opts, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const txt = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, status: res.statusCode, body: txt });
        } else if (res.statusCode === 429 && tentativas > 0) {
          // Rate limit
          const retryAfter = Number(res.headers["retry-after"] || 1);
          setTimeout(() => {
            enviarWebhook(webhookUrl, body, tentativas - 1).then(resolve).catch(reject);
          }, Math.min(retryAfter * 1000, 5000));
        } else {
          reject(new Error(`Discord respondeu ${res.statusCode}: ${txt}`));
        }
      });
    });

    req.on("error", (err) => {
      if (tentativas > 0) {
        setTimeout(() => {
          enviarWebhook(webhookUrl, body, tentativas - 1).then(resolve).catch(reject);
        }, 1000);
      } else {
        reject(err);
      }
    });

    req.on("timeout", () => {
      req.destroy(new Error("Timeout no pedido de webhook"));
    });

    req.write(data);
    req.end();
  });
}
