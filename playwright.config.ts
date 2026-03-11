import { defineConfig } from '@playwright/test';
import * as fs from 'fs';

// Load app config if present (check parent dir first, then local)
const parentConfigPath = '../app-config.json';
const localConfigPath = './app-config.json';
const appConfigPath = fs.existsSync(parentConfigPath) ? parentConfigPath : localConfigPath;
const appConfig = fs.existsSync(appConfigPath)
  ? JSON.parse(fs.readFileSync(appConfigPath, 'utf8'))
  : {};

const baseURL = process.env.BASE_URL || appConfig.baseURL || 'http://localhost:5173';
const storageStatePath = './.auth-state.json';
const pregenAuth = fs.existsSync(storageStatePath);
const hasAuth = !!appConfig.auth || pregenAuth;

export default defineConfig({
  testDir: '.',
  timeout: 60000,
  use: {
    baseURL,
    headless: !!process.env.CI || process.env.PLAYWRIGHT_HEADLESS === 'on', // headed by default; use --headless flag or set CI=1
    trace: 'on-first-retry',
    viewport: { width: 1440, height: 900 },
    ...(process.env.PLAYWRIGHT_VIDEO === 'on' ? { video: 'on' } : {}),
  },
  projects: [
    ...(hasAuth && !pregenAuth ? [{
      name: 'setup',
      testMatch: /auth-setup\.ts/,
      use: { headless: true },
    }] : []),
    {
      name: 'chromium',
      use: {
        browserName: 'chromium' as const,
        ...(hasAuth ? { storageState: storageStatePath } : {}),
      },
      ...(hasAuth && !pregenAuth ? { dependencies: ['setup'] } : {}),
    },
  ],
});
