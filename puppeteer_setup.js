// puppeteer_setup.js
import puppeteer from "puppeteer";

/**
 * Lança um browser e cria uma page com timeouts mais tolerantes,
 * pensado para runners do GitHub Actions.
 *
 * @returns {Promise<{browser: import('puppeteer').Browser, page: import('puppeteer').Page}>}
 */
export async function openPageWithDefaults() {
  const browser = await puppeteer.launch({
    // Estes flags evitam problemas em ambientes CI
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-features=site-per-process"
    ],
    headless: true
  });

  const page = await browser.newPage();

  // Mais tolerância (60s) — evita “Navigation timeout of 30000 ms exceeded”
  page.setDefaultNavigationTimeout(60_000);
  page.setDefaultTimeout(60_000);

  // Viewport “full HD” e user agent estável ajudam o Vinted a carregar corretamente
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  );

  return { browser, page };
}

/**
 * Navegação segura com retry/backoff:
 * - 3 tentativas
 * - espera incremental entre tentativas
 * - usa networkidle2 para garantir que a página acalmou
 */
export async function gotoSafe(page, url, options = {}) {
  const maxTries = 3;
  let lastErr;

  for (let i = 1; i <= maxTries; i++) {
    try {
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 60_000,
        ...options
      });
      return; // sucesso
    } catch (err) {
      lastErr = err;
      // pequeno backoff (2s, 4s)
      if (i < maxTries) {
        await new Promise(r => setTimeout(r, 2000 * i));
      }
    }
  }

  // Se chegou aqui, falhou mesmo
  throw lastErr;
}
