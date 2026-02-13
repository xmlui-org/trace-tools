import { test } from '@playwright/test';

test('debug-breadcrumb', async ({ page }) => {
  await Promise.all([
    page.waitForResponse(r => r.url().includes('ListShares')),
    page.goto('./'),
  ]);

  // Navigate into foo
  await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'foo', exact: true }) }).dblclick();
  await page.waitForResponse(r => r.url().includes('ListFolder'));
  await page.waitForTimeout(1000);

  // Navigate into bar
  await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'bar', exact: true }) }).dblclick();
  await page.waitForResponse(r => r.url().includes('ListFolder'));
  await page.waitForTimeout(1000);

  // Dump breadcrumb area
  const breadcrumbs = await page.evaluate(() => {
    const links = document.querySelectorAll('a, [role="link"]');
    return Array.from(links).map(el => ({
      text: (el as HTMLElement).innerText?.trim(),
      testId: el.getAttribute('data-testid'),
      href: el.getAttribute('href'),
    }));
  });
  console.log('BREADCRUMBS:', JSON.stringify(breadcrumbs, null, 2));

  // Also try by text
  const texts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('*'))
      .filter(el => (el as HTMLElement).innerText?.includes('Documents'))
      .slice(0, 5)
      .map(el => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        text: (el as HTMLElement).innerText?.trim()?.slice(0, 50),
        testId: el.getAttribute('data-testid'),
      }));
  });
  console.log('DOCUMENTS ELEMENTS:', JSON.stringify(texts, null, 2));
});
