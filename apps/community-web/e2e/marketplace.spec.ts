import { test, expect } from "@playwright/test";
import { signUp, makeOrg, uid, snap } from "./helpers";

test.describe("marketplace", () => {
  test("post a listing; browse it; a second user messages the seller", async ({ page, browser }) => {
    await signUp(page, { first: "Freidy" });
    await makeOrg(page, { name: `E2E Notions Shop ${uid()}` });

    const title = `E2E Custom Buttons ${uid()}`;
    await page.goto("/marketplace/new");
    await page.getByTestId("marketplace-new-type").selectOption("PRODUCT");
    await page.getByTestId("marketplace-new-title").fill(title);
    await page.getByTestId("marketplace-new-description").fill("Custom engraved buttons, bulk pricing available.");
    await page.getByTestId("marketplace-new-submit").click();
    // exclude "new": a bare /\/marketplace\// also matches /marketplace/new too early.
    await expect(page).toHaveURL(/\/marketplace\/(?!new)/);
    const listingUrl = page.url();

    // Browse it from the marketplace grid
    await page.goto("/marketplace");
    await page.getByTestId("marketplace-search-input").fill(title);
    await page.getByTestId("marketplace-search-submit").click();
    await expect(page.getByText(title)).toBeVisible();

    // A second user opens the listing and messages the seller
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { first: "Gitty" });
    await pageB.goto(listingUrl);
    await expect(pageB.getByTestId("marketplace-detail")).toBeVisible();
    await pageB.getByTestId("marketplace-detail-message").click();
    const note = `Can you do 200 units? ${uid()}`;
    await pageB.getByTestId("marketplace-detail-message-body").fill(note);
    await pageB.getByTestId("marketplace-detail-message-send").click();
    await expect(pageB.getByText("Message sent.")).toBeVisible();
    await snap(page, "marketplace");

    await ctxB.close();
  });
});
