const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Users/jonudell/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    headless: true
  });
  const page = await browser.newPage();

  // Capture ALL console messages from ALL frames
  page.on("console", msg => console.log(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", err => console.log("PAGE ERROR:", err.message));

  // Intercept network to see 404s
  page.on("response", resp => {
    if (resp.status() >= 400) {
      console.log(`HTTP ${resp.status()}: ${resp.url()}`);
    }
  });

  await page.goto("http://localhost:8090");
  await page.waitForTimeout(3000);

  // Click cog
  await page.locator('[data-icon-name="cog"]').first().click();
  await page.waitForTimeout(3000);

  const frame = page.frames().find(f => f.url().includes("xs-diff"));
  if (frame) {
    console.log("--- iframe found ---");

    // Check if the diff container exists
    const domState = await frame.evaluate(() => {
      return {
        diffEl: document.getElementById("diff") !== null,
        testEl: document.getElementById("test") !== null,
        viewPretty: document.getElementById("viewPretty") !== null,
        searchInput: document.getElementById("searchInput") !== null,
        allIds: [...document.querySelectorAll("[id]")].map(el => el.id).slice(0, 30)
      };
    });
    console.log("DOM state:", JSON.stringify(domState, null, 2));

    // Check if the module script ran at all - look for variables it should have defined
    const moduleState = await frame.evaluate(() => {
      // The module script defines functions like render, getAllEntries etc.
      // But since they're module-scoped we can't access them from evaluate
      // Instead check for side effects - event listeners on buttons, etc.
      const testBtn = document.getElementById("test");
      // Try to check if the "click" listener was added by checking if test button works
      // Actually, let's check if the module-level import worked by checking for globals
      return {
        hasXmluiParser: typeof window.XmluiSource !== "undefined",
        testBtnExists: testBtn !== null,
        // Check if the clear button works (module adds addEventListener to "clear")
        clearBtn: document.getElementById("clear") !== null
      };
    });
    console.log("Module state:", JSON.stringify(moduleState));

    // Try clicking Test and check console output
    console.log("--- Clicking Test ---");
    const testBtn = frame.locator("#test");
    const testExists = await testBtn.count();
    console.log("Test button count:", testExists);
    if (testExists > 0) {
      await testBtn.click();
      await page.waitForTimeout(2000);

      const diffContent = await frame.evaluate(() => {
        const diff = document.getElementById("diff");
        return diff ? { html: diff.innerHTML.substring(0, 300), children: diff.children.length } : "no diff el";
      });
      console.log("Diff after Test:", JSON.stringify(diffContent));
    }
  }

  await browser.close();
})();
