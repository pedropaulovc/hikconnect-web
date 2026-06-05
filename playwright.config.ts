import { defineConfig, devices } from '@playwright/test';

// Mock mode (default): Playwright boots a local Next dev server and tests against
// it. Prod mode: set E2E_BASE_URL to a deployed preview/prod URL and skip the
// local server. `E2E_DEPENDENCIES_MODE` is reserved for future external-dependency
// stubbing; the current app has no external runtime deps.
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const useDeployedTarget = Boolean(process.env.E2E_BASE_URL);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(useDeployedTarget
    ? {}
    : {
        webServer: {
          command: 'npm run dev',
          url: 'http://localhost:3000',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
});
