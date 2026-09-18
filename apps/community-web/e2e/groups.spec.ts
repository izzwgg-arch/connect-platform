import { test, expect } from "@playwright/test";
import { signUp, uid, snap } from "./helpers";

test.describe("groups", () => {
  test("create a group; a second user joins; a member posts in the group feed", async ({ page, browser }) => {
    await signUp(page, { first: "Elka" });
    const name = `E2E Sewing Circle ${uid()}`;

    await page.goto("/groups");
    await page.getByTestId("groups-create").click();
    await page.getByTestId("groups-new-name").fill(name);
    await page.getByTestId("groups-new-description").fill("A group for E2E sewing enthusiasts.");
    await page.getByTestId("groups-new-submit").click();
    // creating a group just adds it to the /groups list in place (no redirect)
    await expect(page.getByText(`${name} is live.`)).toBeVisible();
    const link = page.locator('[data-testid^="groups-row-"] a', { hasText: name });
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    await page.goto(href!);
    const url = page.url();

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { first: "Feige" });
    await pageB.goto(url);
    await pageB.getByTestId("group-join").click();
    await expect(pageB.getByTestId("group-leave")).toBeVisible();

    const body = `Excited to be here! ${uid()}`;
    await pageB.getByTestId("group-feed-composer").fill(body);
    await pageB.getByTestId("group-feed-post").click();
    await expect(pageB.getByText(body)).toBeVisible();

    // The creator, still on the group, sees the new post too
    await page.reload();
    await expect(page.getByText(body)).toBeVisible();
    await snap(page, "groups");

    await ctxB.close();
  });
});
