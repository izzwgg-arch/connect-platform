import { test, expect } from "@playwright/test";
import { signUp, makeOrg, uid, snap } from "./helpers";

test.describe("concierge", () => {
  test("ask finds a real vendor match; confirm posts an RFQ inviting it; lands on the RFQ page", async ({ page, browser }) => {
    // A vendor org with a distinctive brand word so it's findable above the
    // shared dev db's noise (mirrors the api's own concierge test approach).
    const brand = `zohar${uid()}`;
    const ctxVendor = await browser.newContext();
    const pageVendor = await ctxVendor.newPage();
    await signUp(pageVendor, { first: "Shloimy" });
    await makeOrg(pageVendor, { name: `${brand} Embroidery`, industry: "embroidery uniforms jackets monroe" });

    await signUp(page, { first: "Buyer" });
    await page.goto("/concierge");
    await page.getByTestId("concierge-input").fill(`I need a ${brand} embroidery shop for 25 jackets delivered to Monroe by October 20`);
    await page.getByTestId("concierge-ask").click();
    await expect(page.getByTestId("concierge-answer")).toBeVisible();
    await expect(page.getByTestId("concierge-match").first()).toContainText(brand);

    await page.getByTestId("concierge-action-post_rfq").click();
    await snap(page, "concierge");
    await page.getByRole("button", { name: "Yes, do it" }).click();
    await expect(page.getByText("Request posted.")).toBeVisible();
    await page.getByRole("link", { name: "open it" }).click();
    await expect(page).toHaveURL(/\/rfq\/(?!new)/);

    await ctxVendor.close();
  });
});
