import { test, expect } from "@playwright/test";
import { signUp, makeOrg, uid, snap } from "./helpers";

test.describe("jobs", () => {
  test("employer creates a job; candidate searches and applies with sections; employer moves the stage; candidate sees status", async ({ page, browser }) => {
    await signUp(page, { first: "Dovid" });
    await makeOrg(page, { name: `E2E Hiring Co ${uid()}` });

    const title = `E2E Seamstress ${uid()}`;
    await page.goto("/jobs/new");
    await page.getByTestId("jobs-new-title").fill(title);
    await page.getByTestId("jobs-new-description").fill("Sewing custom garments, full time, on-site in Monroe.");
    await page.getByTestId("jobs-new-location").fill("Monroe, NY");
    await page.getByTestId("jobs-new-status").selectOption("OPEN");
    await page.getByTestId("jobs-new-submit").click();
    // posting a job redirects to the hiring pipeline, not a /jobs/:id page
    await expect(page).toHaveURL(/\/company\/hiring\?job=/);

    const ctxCandidate = await browser.newContext();
    const pageCandidate = await ctxCandidate.newPage();
    await signUp(pageCandidate, { first: "Esther" });
    await pageCandidate.goto("/jobs");
    await pageCandidate.getByTestId("jobs-search-q").fill(title);
    await pageCandidate.getByTestId("jobs-search-submit").click();
    await expect(pageCandidate.getByText(title).first()).toBeVisible();
    await pageCandidate.getByText(title).first().click();
    await pageCandidate.getByTestId("jobs-apply").click();
    await pageCandidate.getByTestId("jobs-apply-section-headline").check();
    await pageCandidate.getByTestId("jobs-apply-section-experience").check();
    await pageCandidate.getByTestId("jobs-apply-submit").click();
    await expect(pageCandidate.getByText(/applied/i)).toBeVisible();

    // Employer moves the applicant to the next stage
    await page.goto("/company/hiring");
    await page.locator('[data-testid^="hiring-job-"]', { hasText: title }).click();
    const applicantRow = page.locator('div.li[data-testid^="hiring-applicant-"]').first();
    await expect(applicantRow).toBeVisible();
    await applicantRow.locator('[data-testid^="hiring-applicant-stage-"]').selectOption("REVIEWED");

    // Candidate sees the updated status in their applications list
    await pageCandidate.goto("/me/applications");
    await expect(pageCandidate.getByText("Reviewed", { exact: true })).toBeVisible();
    await snap(pageCandidate, "jobs");

    await ctxCandidate.close();
  });
});
