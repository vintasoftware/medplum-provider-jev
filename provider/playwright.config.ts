import { defineConfig, devices } from '@playwright/test';

// End-to-end tests for the guided demo against the Medplum project set up by
// `npm run setup`, using the Medplum CLI login. See "End-to-end tests" in the root README.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: '../artifacts/e2e',
  globalSetup: './e2e/global-setup.ts',
  // Each test seeds its own synthetic patient; one worker keeps recordings in a stable order.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { outputFolder: '../artifacts/e2e-report', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:3001',
    viewport: { width: 1440, height: 900 },
    video: { mode: 'on', size: { width: 1440, height: 900 } },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3001',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
