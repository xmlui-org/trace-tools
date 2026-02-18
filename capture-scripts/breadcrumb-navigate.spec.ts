import { test, expect } from '@playwright/test';
import * as fs from 'fs';

test('breadcrumb-navigate', async ({ page }) => {
  try {
    // Startup: wait for initial data load
    await Promise.all([
      page.waitForResponse(r => r.url().includes('ListShares')),
      page.goto('./'),
    ]);

    // Double-click "foo" to navigate into it
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'foo', exact: true }) }).dblclick();
    await page.waitForResponse(r => r.url().includes('ListFolder'));

    // Verify breadcrumbs include folder "foo"
    await expect(page.getByRole('link', { name: 'Documents', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'foo', exact: true })).toBeVisible();

    // Verify we see foo's contents (bar/ and hello.txt)
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'bar', exact: true }) }).waitFor();

    // Double-click "bar" to go deeper
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'bar', exact: true }) }).dblclick();
    await page.waitForResponse(r => r.url().includes('ListFolder'));

    // Verify breadcrumbs include nested folders "foo / bar"
    await expect(page.getByRole('link', { name: 'foo', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'bar', exact: true })).toBeVisible();

    // Click "Documents" breadcrumb link to go back to root
    await page.getByRole('link', { name: 'Documents' }).click();
    await page.waitForResponse(r => r.url().includes('ListFolder'));

    // Verify folder breadcrumbs are not shown at drive root
    await expect(page.getByRole('link', { name: 'foo', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'bar', exact: true })).toHaveCount(0);

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
