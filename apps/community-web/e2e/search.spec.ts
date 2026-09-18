import { test, expect } from "@playwright/test";
import { signUp, uid, snap } from "./helpers";

test.describe("search", () => {
  test("top-bar search navigates to /search with the query", async ({ page }) => {
    await signUp(page);
    const q = `tailor ${uid()}`;
    await page.getByLabel("Search").fill(q);
    await page.getByLabel("Search").press("Enter");
    await expect(page).toHaveURL(/\/search\?q=/);
    expect(new URL(page.url()).searchParams.get("q")).toBe(q);
    await expect(page.getByTestId("search-main-input")).toBeVisible();
    await snap(page, "search");
  });

  test("type tabs filter the results", async ({ page }) => {
    await signUp(page);
    await page.goto("/search?q=e2e");
    await page.getByTestId("search-tab-people").click();
    await expect(page).toHaveURL(/type=people/);
    await page.getByTestId("search-tab-all").click();
    await expect(page).not.toHaveURL(/type=people/);
  });

  test("a 3+ word query shows the natural-language interpretation card", async ({ page }) => {
    await signUp(page);
    await page.goto("/search?q=embroidery%20shop%20in%20Lakewood");
    await expect(page.getByTestId("search-interpretation")).toBeVisible();
    await expect(page.getByTestId("search-interpretation")).toContainText("Understood as:");
  });

  test("a search can be saved and appears in saved/recent", async ({ page }) => {
    await signUp(page);
    const q = `plumber ${uid()}`;
    await page.goto(`/search?q=${encodeURIComponent(q)}`);
    await page.getByTestId("search-save").click();
    await expect(page.getByTestId("search-saved-recent")).toContainText(q);
  });
});
