import { test } from '@playwright/test';
import * as fs from 'fs';

test('delete-nonempty-folder', async ({ page }) => {
  try {
    // Startup
    await Promise.all([
      page.waitForResponse(r => r.url().includes('ListShares')),
      page.goto('./'),
    ]);

    // Create tempfolder
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click();
    await page.getByRole('textbox').fill('tempfolder');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForResponse(r => r.url().includes('CreateFile'));
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'tempfolder', exact: true }) }).waitFor();

    // Navigate into tempfolder
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'tempfolder', exact: true }) }).dblclick();
    await page.waitForResponse(r => r.url().includes('ListFolder'));

    // Create a subfolder inside tempfolder to make it non-empty
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click();
    await page.getByRole('textbox').fill('inner');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForResponse(r => r.url().includes('CreateFile'));
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'inner', exact: true }) }).waitFor();

    // Navigate back to root via breadcrumb
    await page.getByRole('link', { name: 'Documents', exact: true }).click();
    await page.waitForResponse(r => r.url().includes('ListFolder'));
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'tempfolder', exact: true }) }).waitFor();

    // Delete tempfolder (non-empty)
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'tempfolder', exact: true }) }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();

    // First delete confirmation
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    // 417 response triggers "not empty" confirm dialog — click Yes
    await page.getByRole('button', { name: 'Yes', exact: true }).click();
    await page.waitForResponse(r => r.url().includes('DeleteFolder'));

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
