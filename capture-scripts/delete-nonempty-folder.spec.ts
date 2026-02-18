import { test, expect } from '@playwright/test';
import * as fs from 'fs';

test('delete-nonempty-folder', async ({ page }) => {
  try {
    // Startup
    await Promise.all([
      page.waitForResponse(r => r.url().includes('ListShares')),
      page.goto('./'),
    ]);

    // Expand "Documents" in the tree so we can observe folder changes
    const docsItem = page.getByRole('treeitem', { name: 'Documents' });
    await docsItem.waitFor();
    await docsItem.locator('[class*="toggleWrapper"]').click();
    await page.waitForTimeout(500);

    // Create tempfolder
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('tempfolder');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForResponse(r => r.url().includes('CreateFile'));
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'tempfolder', exact: true }) }).waitFor();

    // Verify tempfolder appeared in the tree
    const tempfolderTreeItem = page.getByRole('treeitem', { name: 'tempfolder', exact: true });
    await tempfolderTreeItem.waitFor();

    // Navigate into tempfolder
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'tempfolder', exact: true }) }).dblclick();
    await page.waitForResponse(r => r.url().includes('ListFolder'));

    // Create a subfolder inside tempfolder to make it non-empty
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New Folder', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('inner');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForResponse(r => r.url().includes('CreateFile'));
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'inner', exact: true }) }).waitFor();

    // Expand tempfolder in the tree to reveal "inner"
    await tempfolderTreeItem.locator('[class*="toggleWrapper"]').click();
    await page.waitForTimeout(500);

    // Verify "inner" is visible in the tree inside tempfolder
    await page.getByRole('treeitem', { name: 'inner', exact: true }).waitFor();

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

    // Wait for the folder list to refresh after deletion
    await page.waitForResponse(r => r.url().includes('ListFolder'));

    // Verify tempfolder disappeared from the file table
    await expect(page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'tempfolder', exact: true }) })).toBeHidden({ timeout: 5000 });

    // Verify tempfolder disappeared from the tree
    await expect(tempfolderTreeItem).toBeHidden();

    // Verify "inner" also disappeared from the tree
    await expect(page.getByRole('treeitem', { name: 'inner', exact: true })).toBeHidden();

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
