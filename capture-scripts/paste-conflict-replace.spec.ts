import { test } from '@playwright/test';
import * as fs from 'fs';

test('paste-conflict-replace', async ({ page }) => {
  try {
    // Startup
    await Promise.all([
      page.waitForResponse(r => r.url().includes('ListShares')),
      page.goto('./'),
    ]);

    // Copy test.xlsx
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'test.xlsx', exact: true }) }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();

    // Navigate into foo
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'foo', exact: true }) }).dblclick();
    await page.waitForResponse(r => r.url().includes('ListFolder'));

    // First paste — no conflict
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'hello.txt', exact: true }) }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Paste', exact: true }).click();
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await page.waitForResponse(r => r.url().includes('CopyFile'));
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'test.xlsx', exact: true }) }).waitFor();

    // Second paste — triggers 409 conflict
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'hello.txt', exact: true }) }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Paste', exact: true }).click();
    await page.getByRole('button', { name: 'Copy', exact: true }).click();

    // Conflict dialog appears — click Replace
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    await page.waitForResponse(r => r.url().includes('CopyFile'));

    // Clean up: delete test.xlsx from foo to restore state
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'test.xlsx', exact: true }) }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForResponse(r => r.url().includes('DeleteFile'));

  } finally {
    try {
      await page.waitForTimeout(500);
      const logs = await page.evaluate(() => (window as any)._xsLogs || []);
      const traceFile = process.env.TRACE_OUTPUT || 'captured-trace.json';
      fs.writeFileSync(traceFile, JSON.stringify(logs, null, 2));
      console.log(`Trace captured to ${traceFile} (${logs.length} events)`);
    } catch (e) {
      console.log('Could not capture trace');
    }
  }
});
