import { test, expect } from "@playwright/test";
import { signUp, makeOrg, lastMailLink, uid, snap } from "./helpers";

test.describe("company", () => {
  test("create a company; edit its page; invite a member by email; they accept from the mailbox link; the page shows people; a second user follows it", async ({ page, browser }) => {
    const { email: ownerEmail } = await signUp(page, { first: "Ruchel" });
    void ownerEmail;
    const { slug } = await makeOrg(page, { name: `E2E Tailors ${uid()}`, industry: "Apparel" });
    await expect(page).toHaveURL(new RegExp(`/companies/${slug}`));

    // Invite a member by email (Members tab, the default)
    await page.goto("/company/admin");
    const inviteeEmail = `e2e-invitee-${uid()}@example.test`;
    await page.getByTestId("company-admin-invite-open").click();
    await page.getByTestId("company-admin-invite-email").fill(inviteeEmail);
    await page.getByTestId("company-admin-invite-send").click();

    // Edit the company page (Page settings tab)
    await page.getByTestId("company-admin-tab-page").click();
    await page.getByTestId("company-admin-domain").fill(`e2e-${uid()}.example.test`);
    await page.getByTestId("company-admin-page-save").click();
    await expect(page.getByText("Page settings saved.")).toBeVisible();

    // They accept from the invite email's link
    const link = await lastMailLink(inviteeEmail, /https?:\/\/[^\s"']*\/company\/invite\?token=[A-Za-z0-9_-]+/);

    const ctxInvitee = await browser.newContext();
    const pageInvitee = await ctxInvitee.newPage();
    await signUp(pageInvitee, { first: "Sury" });
    await pageInvitee.goto(link.replace(/^https?:\/\/[^/]+/, ""));
    await expect(pageInvitee.getByTestId("company-invite-card")).toBeVisible();

    // The company page shows people (owner is a member)
    await page.goto(`/companies/${slug}`);
    await page.getByTestId(`company-tab-people`).click();
    await expect(page.getByText("Ruchel").first()).toBeVisible();
    await snap(page, "company");

    // A second, unrelated user follows the company
    const ctxFollower = await browser.newContext();
    const pageFollower = await ctxFollower.newPage();
    await signUp(pageFollower, { first: "Tzivia" });
    await pageFollower.goto(`/companies/${slug}`);
    await expect(pageFollower.getByTestId("company-follow")).toHaveText("Follow");
    await pageFollower.getByTestId("company-follow").click();
    await expect(pageFollower.getByTestId("company-follow")).toHaveText("Following");

    await ctxInvitee.close();
    await ctxFollower.close();
  });
});
