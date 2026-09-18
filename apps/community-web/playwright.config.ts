import { defineConfig, devices } from "@playwright/test";

/**
 * Real-browser E2E against the running local stack (api :3101 with
 * COMMUNITY_TEST_HOOKS=1, web :3100). No mocks: the flows read verification
 * codes from the dev mailbox route exactly like a person would.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0, // flaky is a bug
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-android", use: { ...devices["Pixel 7"] } },
    { name: "mobile-iphone", use: { ...devices["iPhone 14"] } },
  ],
});
