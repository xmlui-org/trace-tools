import { test } from '@playwright/test';

test('debug-ui', async ({ page }) => {
  await Promise.all([
    page.waitForResponse(r => r.url().includes('ListShares')),
    page.goto('./'),
  ]);
  await page.waitForTimeout(2000);

  // Dump tree items
  const treeItems = await page.evaluate(() => {
    const items = document.querySelectorAll('[role="treeitem"]');
    return Array.from(items).map(el => ({
      role: el.getAttribute('role'),
      text: (el as HTMLElement).innerText?.trim()?.slice(0, 80),
      ariaLabel: el.getAttribute('aria-label'),
    }));
  });
  console.log('TREE ITEMS:', JSON.stringify(treeItems, null, 2));

  // Dump all links (breadcrumbs are SafeLink)
  const links = await page.evaluate(() => {
    const items = document.querySelectorAll('[role="link"], a');
    return Array.from(items).slice(0, 20).map(el => ({
      role: el.getAttribute('role'),
      text: (el as HTMLElement).innerText?.trim()?.slice(0, 80),
      href: el.getAttribute('href'),
      testId: el.getAttribute('data-testid'),
    }));
  });
  console.log('LINKS:', JSON.stringify(links, null, 2));

  // Dump table rows
  const rows = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('table tbody tr')).map(r =>
      (r as HTMLElement).innerText?.split('\t')[0]?.trim()
    );
  });
  console.log('TABLE ROWS:', rows);
});
