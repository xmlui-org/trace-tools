import { test } from '@playwright/test';
import * as fs from 'fs';

test('folder-tree-navigate', async ({ page }) => {
  try {
    // Startup: wait for initial data load
    await Promise.all([
      page.waitForResponse(r => r.url().includes('ListShares')),
      page.goto('./'),
    ]);

    // Double-click "foo" in the file table to navigate into it
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'foo', exact: true }) }).dblclick();
    await page.waitForResponse(r => r.url().includes('ListFolder'));

    // Verify we see foo's contents
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'hello.txt', exact: true }) }).waitFor();

    // Click "Documents" in the folder tree to navigate back to root
    await page.getByRole('treeitem', { name: 'Documents' }).click();
    await page.waitForResponse(r => r.url().includes('ListFolder'));

    // Verify we're back at root
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'test.xlsx', exact: true }) }).waitFor();

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
