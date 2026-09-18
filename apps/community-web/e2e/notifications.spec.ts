import { test, expect, type Page } from "@playwright/test";
import { signUp, snap } from "./helpers";

async function ownUsername(page: Page): Promise<string> {
  const href = await page.locator('a[href^="/people/"]').first().getAttribute("href");
  return href!.replace("/people/", "");
}

test.describe("notifications", () => {
  test("a connection request produces a notification with an inline Accept; mark all read", async ({ page, browser }) => {
    await signUp(page, { first: "Yuta" });
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { first: "Zissy" });
    const usernameB = await ownUsername(pageB);

    await page.goto(`/people/${usernameB}`);
    await page.getByTestId("profile-connect").click();

    await pageB.goto("/notifications");
    const item = pageB.locator('[data-testid^="notifications-item-"]').first();
    await expect(item).toBeVisible();
    await expect(item).toContainText("New connection request");
    await item.locator('[data-testid^="notifications-accept-"]').click();
    await expect(pageB.locator('[data-testid^="notifications-accept-"]')).toHaveCount(0);

    // mark all read
    await pageB.getByTestId("notifications-markallread").click();
    await expect(pageB.locator(".notif-row.unread")).toHaveCount(0);
    await snap(pageB, "notifications");

    await ctxB.close();
  });

  test("notification preferences matrix can be saved", async ({ page }) => {
    await signUp(page, { first: "Alte" });
    await page.goto("/settings/notifications");
    const firstRow = page.locator('[data-testid^="notifsettings-row-"]').first();
    const rowKind = (await firstRow.getAttribute("data-testid"))!.replace("notifsettings-row-", "");
    await page.getByTestId(`push-${rowKind}`).click();
    await page.getByTestId("notifsettings-save").click();
    await expect(page.getByText(/saved/i)).toBeVisible();
  });
});
