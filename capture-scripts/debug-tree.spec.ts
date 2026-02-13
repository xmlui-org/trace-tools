import { test } from '@playwright/test';

test('debug-tree', async ({ page }) => {
  await Promise.all([
    page.waitForResponse(r => r.url().includes('ListShares')),
    page.goto('./'),
  ]);
  await page.waitForTimeout(1000);

  // Check if Documents treeitem is expandable and expand it
  const docsItem = page.getByRole('treeitem', { name: 'Documents' });
  const isExpanded = await docsItem.getAttribute('aria-expanded');
  console.log('Documents aria-expanded:', isExpanded);

  // Try expanding by clicking the expand toggle
  // First, find what's inside the treeitem
  const treeItemHtml = await docsItem.evaluate(el => el.outerHTML.slice(0, 500));
  console.log('Documents treeitem HTML:', treeItemHtml);

  // Click the Documents treeitem to expand
  await docsItem.click();
  await page.waitForTimeout(2000);

  // Check tree items again after expanding
  const treeItems = await page.evaluate(() => {
    const items = document.querySelectorAll('[role="treeitem"]');
    return Array.from(items).map(el => ({
      text: (el as HTMLElement).innerText?.trim()?.slice(0, 50),
      ariaExpanded: el.getAttribute('aria-expanded'),
      ariaLabel: el.getAttribute('aria-label'),
    }));
  });
  console.log('TREE ITEMS AFTER EXPAND:', JSON.stringify(treeItems, null, 2));
});
