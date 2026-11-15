import { defineConfig, devices } from "@playwright/test";

// Tests run against `wrangler dev`, so _headers (CSP) and 404 handling match production.
// Not 8787, so it can run next to coreyjones-dev's dev server.
const PORT = 8797;
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: `npx wrangler dev --port ${PORT} --ip 127.0.0.1 --log-level warn`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    { name: "phone", use: { ...devices["iPhone 15"], browserName: "chromium" } },
  ],
});
