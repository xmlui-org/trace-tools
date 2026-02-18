import { test } from '@playwright/test';

test('new-folder-invalid-name', async ({ page }) => {
  const apiResponses: { url: string; status: number; body: string }[] = [];
  const consoleLogs: string[] = [];
  page.on('console', msg => {
    if (msg.text().includes('NewFolderModal')) consoleLogs.push(msg.text());
  });

  // Intercept all responses to capture API errors
  page.on('response', async response => {
    if (response.url().includes('CreateFile') || response.url().includes('CreateFolder')) {
      try {
        const body = await response.text();
        apiResponses.push({ url: response.url(), status: response.status(), body });
      } catch (_) {}
    }
  });

  // Startup — wait for app to fully load
  await Promise.all([
    page.waitForResponse(r => r.url().includes('ListShares') || r.url().includes('ListFolder')),
    page.goto('./'),
  ]);

  // Open New → New Folder dialog
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click();

  // Enter invalid folder name — target textbox inside the modal dialog
  await page.getByRole('dialog').getByRole('textbox').fill('://$');

  // Register response listener BEFORE clicking Create (avoid race condition)
  const createResponsePromise = page.waitForResponse(
    r => r.url().includes('CreateFile') || r.url().includes('CreateFolder'),
    { timeout: 5000 }
  ).catch(() => null);

  await page.getByRole('button', { name: 'Create', exact: true }).click();

  const response = await createResponsePromise;

  await page.waitForTimeout(1000); // let toasts/errors settle

  // Capture any visible toast/error text
  const visibleText = await page.evaluate(() => {
    const toasts = Array.from(document.querySelectorAll('[role="alert"], [class*="toast"], [class*="Toast"]'));
    return toasts.map(el => (el as HTMLElement).innerText).filter(Boolean);
  });

  // Report results
  console.log('\n══════════════════════════════════════');
  console.log('  TEST: new-folder-invalid-name ://$');
  console.log('══════════════════════════════════════');

  if (response) {
    console.log('\nAPI CALL MADE:');
    console.log('  URL:    ', response.url());
    console.log('  Status: ', response.status(), response.statusText());
    console.log('  Body:   ', await response.text().catch(() => '(unreadable)'));
  } else {
    console.log('\nNO API CALL — client-side validation blocked submission');
  }

  if (apiResponses.length > 0) {
    console.log('\nALL CAPTURED API RESPONSES:');
    apiResponses.forEach(r => {
      console.log(`  [${r.status}] ${r.url}`);
      console.log(`  Body: ${r.body}`);
    });
  }

  if (visibleText.length > 0) {
    console.log('\nVISIBLE TOASTS/ERRORS:');
    visibleText.forEach(t => console.log(' ', t));
  } else {
    console.log('\nNo visible toast/error messages detected');
  }

  if (consoleLogs.length > 0) {
    console.log('\nBROWSER CONSOLE (NewFolderModal):');
    consoleLogs.forEach(l => console.log(' ', l));
  }

  console.log('══════════════════════════════════════\n');
});
