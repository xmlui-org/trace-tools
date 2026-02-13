import { test } from '@playwright/test';

test('debug-tree2', async ({ page }) => {
  await Promise.all([
    page.waitForResponse(r => r.url().includes('ListShares')),
    page.goto('./'),
  ]);
  await page.waitForTimeout(1000);

  // The treeitem has a toggle wrapper with a chevron SVG. Try clicking that.
  const docsItem = page.getByRole('treeitem', { name: 'Documents' });

  // Click the expand toggle (the chevron/arrow part)
  await docsItem.locator('[class*="toggleWrapper"]').click();
  await page.waitForTimeout(2000);

  // Check tree items again
  const treeItems = await page.evaluate(() => {
    const items = document.querySelectorAll('[role="treeitem"]');
    return Array.from(items).map(el => ({
      text: (el as HTMLElement).innerText?.trim()?.slice(0, 50),
      ariaExpanded: el.getAttribute('aria-expanded'),
      ariaLabel: el.getAttribute('aria-label'),
    }));
  });
  console.log('TREE ITEMS:', JSON.stringify(treeItems, null, 2));
});
