// Teste simples de envio ao Discord
import fetch from "node-fetch";

const webhook = process.env.DISCORD_WEBHOOK_URL;

if (!webhook) {
  console.error("❌ Nenhum webhook definido!");
  process.exit(1);
}

const mensagem = {
  content: "✅ Bot ativo! Conexão com o Discord verificada com sucesso 🚀",
  username: "Vinted Bot",
  avatar_url: "https://cdn-icons-png.flaticon.com/512/5968/5968705.png"
};

fetch(webhook, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(mensagem)
})
  .then(res => {
    if (res.ok) console.log("Mensagem enviada com sucesso ✅");
    else console.error("Falha ao enviar mensagem ❌", res.status);
  })
  .catch(err => console.error("Erro:", err));
