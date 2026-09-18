import { test, expect } from "@playwright/test";
import { signUp, uid, snap } from "./helpers";

test.describe("opportunities", () => {
  test("post an opportunity via the dynamic form; a second user shows interest and a thread opens", async ({ page, browser }) => {
    await signUp(page, { first: "Chaya" });
    const title = `E2E Bulk Fabric Deal ${uid()}`;

    await page.goto("/opportunities/new");
    await page.getByTestId("opportunities-new-title").fill(title);
    await page.getByTestId("opportunities-new-description").fill("Looking for buyers on a bulk fabric lot, first come first served.");
    await page.getByTestId("opportunities-new-location").fill("Brooklyn, NY");
    // the default "Customers" type has its own required dynamic fields
    await page.getByTestId("opportunities-new-field-industry").fill("Textiles");
    await page.getByTestId("opportunities-new-field-dealSize").fill("5000");
    await page.getByTestId("opportunities-new-submit").click();
    // exclude "new": a bare /\/opportunities\// also matches /opportunities/new too early.
    await expect(page).toHaveURL(/\/opportunities\/(?!new)/);
    const url = page.url();

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { first: "Dina" });
    await pageB.goto(url);
    await pageB.getByTestId("opportunities-detail-interested").click();
    await pageB.getByTestId("opportunities-detail-interest-send").click();
    await expect(pageB.getByText("They'll see you're interested.")).toBeVisible();

    // Poster sees the interest and opens the thread
    await page.goto(url);
    await expect(page.getByTestId("opportunities-detail-interests")).toContainText("Dina");
    await snap(page, "opportunities");
    await page.locator('[data-testid^="opportunities-detail-message-"]').first().click();
    await expect(page).toHaveURL(/\/messages\//);

    await ctxB.close();
  });
});
