import { test, expect } from '@playwright/test';
import * as fs from 'fs';

test('paste-conflict-keep-both', async ({ page }) => {
  test.setTimeout(60000);

  try {
    // Startup
    await Promise.all([
      page.waitForResponse(r => r.url().includes('ListShares')),
      page.goto('./'),
    ]);

    // Select test.xlsx, then Ctrl+click foo to add it to selection
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'test.xlsx', exact: true }) }).click();
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'foo', exact: true }) }).click({ modifiers: ['Control'] });

    // Right-click on the selection and copy both items
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'foo', exact: true }) }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).click();

    // Expand "Documents" in the tree to see pastebox
    const docsItem = page.getByRole('treeitem', { name: 'Documents' });
    await docsItem.waitFor();
    await docsItem.locator('[class*="toggleWrapper"]').click();
    await page.waitForTimeout(500);

    // Verify pastebox is in the tree (from fixtures)
    const pasteboxTreeItem = page.getByRole('treeitem', { name: 'pastebox', exact: true });
    await pasteboxTreeItem.waitFor();

    // --- First paste (no conflicts) via tree context menu ---
    // Right-click pastebox in tree: navigates into it AND opens context menu
    const navResponse = page.waitForResponse(r => r.url().includes('ListFolder'));
    await pasteboxTreeItem.click({ button: 'right' });
    await navResponse;
    await page.getByRole('menuitem', { name: 'Paste', exact: true }).click();

    // Confirm paste dialog — click "Copy"
    // Register response waiters BEFORE clicking to avoid race conditions
    const copyFileResponse1 = page.waitForResponse(r => r.url().includes('CopyFile'));
    const copyFolderResponse1 = page.waitForResponse(r => r.url().includes('CopyFolder'));
    await page.getByRole('button', { name: 'Copy', exact: true }).click();

    // Wait for both copy operations to complete
    await Promise.all([copyFileResponse1, copyFolderResponse1]);

    // Wait for folder list refresh
    await page.waitForResponse(r => r.url().includes('ListFolder'));

    // Verify both items appeared in the file table
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'test.xlsx', exact: true }) }).waitFor();
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'foo', exact: true }) }).waitFor();

    // Expand pastebox in tree to see children
    await pasteboxTreeItem.locator('[class*="toggleWrapper"]').click();
    await page.waitForTimeout(500);

    // Verify foo appeared in the tree as a child of pastebox (level 3)
    const fooInPastebox = page.locator('[role="treeitem"][aria-level="3"][aria-label="foo"]');
    await fooInPastebox.waitFor();

    // --- Second paste (conflicts) via file table context menu ---
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'test.xlsx', exact: true }) }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Paste', exact: true }).click();

    // Confirm paste dialog — click "Copy"
    await page.getByRole('button', { name: 'Copy', exact: true }).click();

    // First conflict: "test.xlsx" already exists — Skip (close the confirm dialog, not the progress dialog)
    // The confirm dialog is the topmost dialog — use last() to target it
    await page.getByRole('button', { name: 'Keep both', exact: true }).waitFor();
    // Close the confirm dialog via its X button (last dialog's close button)
    await page.locator('[role="dialog"]').last().locator('button[aria-label="Close"]').click();
    await page.waitForTimeout(500);

    // Second conflict: "foo" already exists — Keep both
    await page.getByRole('button', { name: 'Keep both', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Keep both', exact: true }).click();

    // Verify toast: "Pasted 1 item(s), 1 skipped."
    await expect(page.getByText(/Pasted.*skipped/)).toBeVisible({ timeout: 10000 });

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
