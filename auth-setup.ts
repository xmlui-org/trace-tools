import { test as setup } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const configPath = path.join(__dirname, 'app-config.json');
const storageStatePath = path.join(__dirname, '.auth-state.json');

setup('authenticate', async ({ page }) => {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  if (!config.auth) {
    // No auth needed — skip
    return;
  }

  await page.goto('./');

  for (const field of config.auth.fields) {
    const method = field.method || 'fill';
    let locator;
    if (field.locator === 'getByLabel') {
      locator = page.getByLabel(field.name);
    } else if (field.locator === 'getByPlaceholder') {
      locator = page.getByPlaceholder(field.name);
    } else if (field.locator === 'getByTestId') {
      locator = page.getByTestId(field.name);
    } else {
      locator = page.getByLabel(field.name);
    }

    await locator.click();
    if (method === 'pressSequentially') {
      await locator.pressSequentially(field.value);
    } else {
      await locator.fill(field.value);
    }
  }

  const submit = config.auth.submit;
  await page.getByRole(submit.role, { name: submit.name }).click();

  if (config.auth.waitFor?.url) {
    await page.waitForResponse(r => r.url().includes(config.auth.waitFor.url));
  }

  await page.context().storageState({ path: storageStatePath });
});
