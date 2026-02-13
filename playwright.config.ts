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
const hasAuth = !!appConfig.auth;

export default defineConfig({
  testDir: '.',
  timeout: 10000,
  use: {
    baseURL,
    headless: false, // Set to true for CI
    trace: 'on-first-retry',
  },
  projects: [
    ...(hasAuth ? [{
      name: 'setup',
      testMatch: /auth-setup\.ts/,
      use: { headless: true },
    }] : []),
    {
      name: 'chromium',
      use: {
        browserName: 'chromium' as const,
        ...(hasAuth ? { storageState: './.auth-state.json' } : {}),
      },
      ...(hasAuth ? { dependencies: ['setup'] } : {}),
    },
  ],
});
