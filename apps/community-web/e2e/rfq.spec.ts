import { test, expect } from "@playwright/test";
import { signUp, makeOrg, uid, snap } from "./helpers";

test.describe("rfq", () => {
  test("buyer posts an RFQ inviting a vendor; vendor quotes; buyer shortlists then accepts; second accept impossible; quote thread opens", async ({ page, browser }) => {
    // Vendor org must exist first so the buyer can find and invite it.
    const ctxVendor = await browser.newContext();
    const pageVendor = await ctxVendor.newPage();
    await signUp(pageVendor, { first: "Baruch" });
    const vendorOrgName = `E2E Embroidery Vendor ${uid()}`;
    await makeOrg(pageVendor, { name: vendorOrgName, industry: "Apparel & uniforms" });

    // Buyer posts an RFQ from plain text, inviting that vendor.
    await signUp(page, { first: "Chaim" });
    await page.goto("/rfq/new");
    await page.getByTestId("rfq-new-title").fill("Custom embroidered jackets");
    await page.getByTestId("rfq-new-description").fill(`Need 25 custom embroidered jackets delivered to Monroe before next month. ${uid()}`);
    await page.getByTestId("rfq-new-understand").click();
    await expect(page.getByTestId("rfq-new-extracted")).toBeVisible();
    await page.getByTestId("rfq-new-vendor-search").fill(vendorOrgName);
    await page.locator('[data-testid^="rfq-new-vendor-result-"]').first().click();
    await expect(page.getByTestId(/rfq-new-invited-/)).toBeVisible();
    await page.getByTestId("rfq-new-publish").click();
    // exclude "new" itself: /\/rfq\/[^/]+$/ alone also matches /rfq/new before
    // the post-publish redirect has actually happened, passing prematurely.
    await expect(page).toHaveURL(/\/rfq\/(?!new)[^/]+$/);
    const rfqUrl = page.url();

    // Vendor sees it in their inbox and submits a quote
    await pageVendor.goto("/rfq");
    await pageVendor.getByTestId("rfq-tab-vendor").click();
    await pageVendor.getByText("Custom embroidered jackets").first().click();
    await pageVendor.getByTestId("rfq-detail-quote").click();
    await pageVendor.getByTestId("rfq-quote-total").fill("2500");
    await pageVendor.getByTestId("rfq-quote-save").click();
    await expect(pageVendor.getByText("Submitted").first()).toBeVisible();

    // Buyer shortlists, then accepts with the confirm dialog
    await page.goto(rfqUrl);
    const quoteRow = page.locator('[data-testid^="rfq-quote-row-"]').first();
    const quoteRowId = (await quoteRow.getAttribute("data-testid"))!.replace("rfq-quote-row-", "");
    await page.getByTestId(`rfq-quote-menu-${quoteRowId}`).click();
    await page.getByTestId(`rfq-quote-shortlist-${quoteRowId}`).click();
    await expect(page.getByText("Shortlisted").first()).toBeVisible();

    await page.getByTestId(`rfq-quote-accept-${quoteRowId}`).click();
    await page.getByTestId("rfq-accept-confirm").click();
    await expect(page.getByText("Accepted").first()).toBeVisible();
    await snap(page, "rfq");

    // Second accept is impossible: the Accept control is gone once a quote is accepted
    await expect(page.getByTestId(`rfq-quote-accept-${quoteRowId}`)).toHaveCount(0);

    // Quote thread opens
    await page.getByTestId(`rfq-quote-message-${quoteRowId}`).click();
    await expect(page).toHaveURL(/\/messages\//);

    await ctxVendor.close();
  });
});
