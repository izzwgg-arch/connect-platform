import { defineConfig, devices } from "@playwright/test";

/**
 * Real-browser E2E against the running local stack (api :3101 with
 * COMMUNITY_TEST_HOOKS=1, web :3100). No mocks: the flows read verification
 * codes from the dev mailbox route exactly like a person would.
 */
export default defineConfig({
  testDir: "./e2e",
  // This sandbox's `next dev` serves an SSR page in 3-6s even when already
  // compiled (measured directly with curl) — generous timeouts here account
  // for that real, observed latency, not for flakiness. Retries stay at 0.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0, // flaky is a bug
  fullyParallel: false,
  // Default multi-worker parallelism (4 workers here) overwhelms this single
  // `next dev` + api pair — tests that pass in 15-30s alone timed out at 1.5-2.5m
  // when 4 ran at once, and previously-passing specs failed outright. One worker
  // matches what this sandboxed dev server can actually sustain.
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-android", use: { ...devices["Pixel 7"] } },
    { name: "mobile-iphone", use: { ...devices["iPhone 14"] } },
  ],
});
