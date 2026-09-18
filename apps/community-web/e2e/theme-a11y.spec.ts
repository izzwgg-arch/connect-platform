import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signUp, makeOrg, uid, snap } from "./helpers";

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("lc.theme", t);
    } catch {
      /* ignore */
    }
  }, theme);
}

const PUBLIC_PAGES = ["/", "/login"];

test.describe("theme & accessibility", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`public pages render in ${theme} without console errors`, async ({ page }) => {
      await setTheme(page, theme);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      for (const url of PUBLIC_PAGES) {
        await page.goto(url);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      }
      expect(errors, errors.join("\n")).toEqual([]);
    });

    test(`signed-in pages render in ${theme} without console errors`, async ({ page }) => {
      await setTheme(page, theme);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await signUp(page);
      await makeOrg(page, { name: `E2E Theme Co ${uid()}` });
      for (const url of ["/", "/me/profile", "/messages", "/rfq", "/jobs", "/settings"]) {
        await page.goto(url);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      }
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }

  const A11Y_PAGES: Array<{ name: string; signedIn: boolean; path: string }> = [
    { name: "landing", signedIn: false, path: "/" },
    { name: "login", signedIn: false, path: "/login" },
    { name: "feed", signedIn: true, path: "/" },
    { name: "profile", signedIn: true, path: "/me/profile" },
    { name: "company", signedIn: true, path: "/company" },
    { name: "messages", signedIn: true, path: "/messages" },
    { name: "rfq", signedIn: true, path: "/rfq" },
    { name: "jobs", signedIn: true, path: "/jobs" },
    { name: "settings", signedIn: true, path: "/settings" },
  ];

  for (const p of A11Y_PAGES) {
    test(`axe: ${p.name} has no serious/critical violations`, async ({ page }) => {
      if (p.signedIn) await signUp(page);
      await page.goto(p.path);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      const summary = serious.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s)`).join("\n");
      expect(serious, summary).toEqual([]);
    });
  }

  test("keyboard: Tab reaches the primary action on login", async ({ page }) => {
    await page.goto("/login");
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    let reached = false;
    for (let i = 0; i < 25 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.getByTestId("login-submit").evaluate((el) => el === document.activeElement).catch(() => false);
    }
    expect(reached).toBeTruthy();
  });

  test("keyboard: Tab reaches the composer on the feed", async ({ page }) => {
    await signUp(page);
    await page.goto("/");
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.getByTestId("feed-composer-body").evaluate((el) => el === document.activeElement).catch(() => false);
    }
    expect(reached).toBeTruthy();
    await snap(page, "theme-a11y");
  });
});
