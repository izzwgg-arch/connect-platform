import { test, expect, type Page } from "@playwright/test";
import { signUp, snap } from "./helpers";

async function ownUsername(page: Page): Promise<string> {
  const href = await page.locator('a[href^="/people/"]').first().getAttribute("href");
  return href!.replace("/people/", "");
}

test.describe("network", () => {
  test("A requests B via the profile Connect button; B accepts from /network; both see each other in /connections", async ({ page, browser }) => {
    await signUp(page, { first: "Ayala" });
    const usernameA = await ownUsername(page);

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { first: "Batya" });
    const usernameB = await ownUsername(pageB);

    // A visits B's profile and sends a connection request
    await page.goto(`/people/${usernameB}`);
    await page.getByTestId("profile-connect").click();
    await expect(page.getByTestId("profile-connect-pending")).toBeVisible();

    // B sees the invitation on /network and accepts it
    await pageB.goto("/network");
    const row = pageB.locator(`[data-testid="network-invitations"] :text("Ayala")`).first();
    await expect(row).toBeVisible();
    await pageB.locator('[data-testid^="network-accept-"]').first().click();

    // Both now see each other in /connections
    await page.goto("/connections");
    await expect(page.getByText("Batya")).toBeVisible();
    await snap(page, "network");

    await pageB.goto("/connections");
    await expect(pageB.getByText("Ayala")).toBeVisible();

    await ctxB.close();
  });

  test("relationship tag can be set from /connections", async ({ page, browser }) => {
    await signUp(page, { first: "Chana" });
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { first: "Devora" });
    const usernameB = await ownUsername(pageB);

    await page.goto(`/people/${usernameB}`);
    await page.getByTestId("profile-connect").click();

    await pageB.goto("/network");
    await pageB.locator('[data-testid^="network-accept-"]').first().click();

    await page.goto("/connections");
    // relationship/note/remove/block live behind the row's "More" menu
    await page.getByRole("button", { name: /^More for/ }).first().click();
    await page.locator('[data-testid^="connections-relationship-"]').first().click();
    await page.getByTestId("relationship-kind-VENDOR").check();
    await page.getByTestId("relationship-save").click();
    // "Vendor" also substring-matches the "Vendors · 0" filter chip
    await expect(page.getByText("Vendor", { exact: true })).toBeVisible();

    await ctxB.close();
  });

  test("block hides the profile behind a 404-style page", async ({ page, browser }) => {
    await signUp(page, { first: "Esther" });
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { first: "Faiga" });
    const usernameB = await ownUsername(pageB);

    await page.goto(`/people/${usernameB}`);
    await page.getByTestId("profile-connect").click();
    await pageB.goto("/network");
    await pageB.locator('[data-testid^="network-accept-"]').first().click();

    const usernameA = await ownUsername(page);
    await page.goto("/connections");
    await page.getByRole("button", { name: /^More for/ }).first().click();
    await page.locator('[data-testid^="connections-block-"]').first().click();
    // wait for the block to actually land (async onClick, no navigation of its
    // own) before checking it from B's side, or this races the API call.
    await expect(page.getByText("Blocked.")).toBeVisible();

    await pageB.goto(`/people/${usernameA}`);
    await expect(pageB.getByText("Profile not found")).toBeVisible();

    await ctxB.close();
  });
});
