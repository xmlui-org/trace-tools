import { defineConfig } from '@playwright/test';
import * as fs from 'fs';

// Load app config if present
const appConfigPath = './app-config.json';
const appConfig = fs.existsSync(appConfigPath)
  ? JSON.parse(fs.readFileSync(appConfigPath, 'utf8'))
  : {};

const baseURL = process.env.BASE_URL || appConfig.baseURL || 'http://localhost:5173';
const hasAuth = !!appConfig.auth;

export default defineConfig({
  testDir: '.',
  timeout: 30000,
  use: {
    baseURL,
    headless: false, // Set to true for CI
    trace: 'on-first-retry',
  },
  projects: [
    ...(hasAuth ? [{
      name: 'setup',
      testMatch: /auth-setup\.ts/,
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
