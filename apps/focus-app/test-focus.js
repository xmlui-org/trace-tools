const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Users/jonudell/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    headless: true
  });
  const page = await browser.newPage();

  page.on("console", msg => console.log(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", err => console.log("PAGE ERROR:", err.message));
  page.on("response", resp => {
    if (resp.status() >= 400) console.log(`HTTP ${resp.status()}: ${resp.url()}`);
  });

  await page.goto("http://localhost:8091");
  await page.waitForTimeout(5000);

  const state = await page.evaluate(() => {
    return {
      xsLogs: Array.isArray(window._xsLogs) ? window._xsLogs.length : typeof window._xsLogs,
      title: document.title,
      bodyLen: document.body.innerHTML.length,
      bodySnippet: document.body.innerHTML.substring(0, 300),
      roles: [...new Set([...document.querySelectorAll("[role]")].map(e => e.getAttribute("role")))]
    };
  });
  console.log("State:", JSON.stringify(state, null, 2));

  await browser.close();
})();
