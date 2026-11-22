// Regression suite. See docs/regression-test-plan.md.
//   npx playwright test --project=hermetic            the whole suite against the stand-in Supabase (no network)
//   npx playwright test --project=hermetic --grep @p1 core money workflows only
// The staging projects appear only when STAGING_URL is set (the staging workflow sets it).
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT || 8767);
const STAGING = process.env.STAGING_URL;

export default defineConfig({
  testDir: 'tests/regression',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list'], ['html', { open: 'never' }]],
  use: { ...devices['Pixel 7'], trace: 'retain-on-failure' },
  projects: [
    { name: 'hermetic', retries: 0, use: { baseURL: `http://localhost:${PORT}/`, mode: 'hermetic' } },
    ...(STAGING ? [
      { name: 'staging', retries: 1, use: { baseURL: STAGING, mode: 'staging' } },
      // The production app that phones are still running, against the upgraded staging database.
      { name: 'staging-prev', retries: 1, testDir: 'prev-tests/tests/regression', use: { baseURL: new URL('prev/', STAGING).href, mode: 'staging' } },
    ] : []),
  ],
  webServer: {
    command: `python3 -m http.server ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
