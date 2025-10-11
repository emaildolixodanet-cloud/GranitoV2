name: Vinted → Discord (Node + Puppeteer)

on:
  schedule:
    - cron: "*/30 * * * *"     # corre a cada 30 minutos (UTC)
  workflow_dispatch:            # permite correr manualmente

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install deps
        run: npm ci || npm i

      - name: Run bot
        env:
          # ---- obrigatórios ----
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}

          # ---- do repositório (Settings → Variables) ----
          VINTED_PROFILE_URLS:   ${{ vars.VINTED_PROFILE_URLS }}
          ONLY_NEWER_HOURS:      ${{ vars.ONLY_NEWER_HOURS }}
          MAX_ITEMS_PER_PROFILE: ${{ vars.MAX_ITEMS_PER_PROFILE }}
          MAX_NEW_PER_PROFILE:   ${{ vars.MAX_NEW_PER_PROFILE }}
          TEST_MODE:             ${{ vars.TEST_MODE }}   # "true" para enviar o card de teste
          WEBHOOK_STYLE:         ${{ vars.WEBHOOK_STYLE }} # opcional: "hybrid" (default) ou "v1"
        run: node index.js
