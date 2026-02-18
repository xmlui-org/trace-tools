import { test } from '@playwright/test';
import * as fs from 'fs';

test('rename-folder-roundtrip', async ({ page }) => {
  try {
    // Startup: wait for initial data load
    await Promise.all([
      page.waitForResponse(r => r.url().includes('ListShares')),
      page.goto('./'),
    ]);

    // Expand "Documents" in the tree (click the toggle arrow)
    const docsItem = page.getByRole('treeitem', { name: 'Documents' });
    await docsItem.waitFor();
    await docsItem.locator('[class*="toggleWrapper"]').click();
    await page.waitForTimeout(500);

    // Expand "foo" in the tree to reveal "bar"
    const fooTreeItem = page.getByRole('treeitem', { name: 'foo', exact: true });
    await fooTreeItem.waitFor();
    await fooTreeItem.locator('[class*="toggleWrapper"]').click();
    await page.waitForTimeout(500);

    // Verify "bar" is visible inside "foo" in the tree (we don't navigate into bar)
    await page.getByRole('treeitem', { name: 'bar', exact: true }).waitFor();

    // Click "Up one level" to go back to Documents root
    const upResponse = page.waitForResponse(r => r.url().includes('ListFolder'));
    await page.getByRole('button', { name: 'Up one level', exact: true }).click();
    await upResponse;

    // Verify foo is visible in the file table
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'foo', exact: true }) }).waitFor();

    // --- First rename: via file TABLE context menu (foo → foo1) ---

    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'foo', exact: true }) }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'New name' }).fill('foo1');
    const renameResponse1 = page.waitForResponse(r => r.url().includes('MoveFolder'));
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await renameResponse1;

    // Verify "foo1" appeared in the table
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'foo1', exact: true }) }).waitFor();

    // Verify the tree updated: "foo1" visible with "bar" still inside
    await page.getByRole('treeitem', { name: 'foo1', exact: true }).waitFor();
    await page.getByRole('treeitem', { name: 'bar', exact: true }).waitFor();

    // --- Second rename: via TREE context menu (foo1 → foo) ---
    // Right-clicking a treeitem also navigates into it, so we end up inside foo1.
    // The tree's contextMenu handler fires after a delay(300).

    const navResponse = page.waitForResponse(r => r.url().includes('ListFolder'));
    await page.getByRole('treeitem', { name: 'foo1', exact: true }).click({ button: 'right' });
    await navResponse;
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'New name' }).fill('foo');
    const renameResponse2 = page.waitForResponse(r => r.url().includes('MoveFolder'));
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await renameResponse2;
    // After rename, app refreshes the current folder listing
    await page.waitForResponse(r => r.url().includes('ListFolder'));

    // We navigated into foo (now renamed back), so table shows its contents (bar, hello.txt)
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'bar', exact: true }) }).waitFor();

    // Verify the tree restored: "foo" with "bar" still inside
    await page.getByRole('treeitem', { name: 'foo', exact: true }).waitFor();
    await page.getByRole('treeitem', { name: 'bar', exact: true }).waitFor();

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
