import { test, expect, type Page } from "@playwright/test";
import { signUp, staff, uid, snap } from "./helpers";

async function ownUsername(page: Page): Promise<string> {
  const href = await page.locator('a[href^="/people/"]').first().getAttribute("href");
  return href!.replace("/people/", "");
}

test.describe("admin", () => {
  test("moderator restricts outreach on a reported user; the restriction shows on their next connect attempt", async ({ page, browser }) => {
    const ctxReporter = await browser.newContext();
    const pageReporter = await ctxReporter.newPage();
    const { email: reporterEmail } = await signUp(pageReporter, { first: "Reporter" });
    void reporterEmail;

    const targetLast = `Restrictee${uid()}`;
    const ctxTarget = await browser.newContext();
    const pageTarget = await ctxTarget.newPage();
    await signUp(pageTarget, { first: "Target", last: targetLast });
    const usernameTarget = await ownUsername(pageTarget);

    const { email: modEmail } = await signUp(page, { first: "Modera" });
    staff(modEmail, "MODERATOR");

    // Reporter messages the target, then reports them from the thread info panel.
    await pageReporter.goto(`/people/${usernameTarget}`);
    await pageReporter.getByTestId("profile-message").click();
    await pageReporter.getByTestId("messages-input").fill(`Hi there ${uid()}`);
    await pageReporter.getByTestId("messages-send").click();
    // Desktop always shows the info pane; mobile needs "Conversation actions >
    // Conversation info" to open it as a dialog first. ThreadInfo is rendered
    // twice either way (MessagesShell.tsx keeps a persistent pane AND a mobile
    // dialog copy, both with the same testids), so scope to whichever copy is
    // actually interactable rather than assuming which one that is.
    if (!(await pageReporter.getByTestId("messages-info-report").first().isVisible().catch(() => false))) {
      await pageReporter.getByRole("button", { name: "Conversation actions" }).click();
      await pageReporter.getByTestId("messages-conv-info").click();
    }
    await pageReporter.getByTestId("messages-info-report").first().click();
    await pageReporter.getByTestId("messages-report-submit").first().click();
    await expect(pageReporter.getByText("Thanks — we'll take a look.")).toBeVisible();

    // Moderator (this session, now with staff granted) opens the admin console.
    await page.goto("/admin/moderation");
    await expect(page.getByRole("heading", { name: /moderation/i })).toBeVisible();
    // scope to the row naming our own target (the queue can carry older,
    // still-open cases from other test runs); the row's <tr> isn't itself
    // clickable, only the nested case-title link is.
    const row = page.locator('[data-testid^="moderation-row-"]', { hasText: targetLast });
    await expect(row).toBeVisible();
    await row.getByRole("link").click();

    const sentence = "You can't send new connection requests for 7 days.";
    await page.getByTestId("moderation-action-restrict_outreach").click();
    await page.getByTestId("moderation-note").fill("Reported for unwanted outreach.");
    await page.getByTestId("moderation-user-message").fill(sentence);
    await page.getByTestId("moderation-days").fill("7");
    await page.getByTestId("moderation-action-submit").click();
    await expect(page.getByText(/actioned|restricted/i)).toBeVisible();
    await snap(page, "admin");

    // The restricted target tries to connect with someone new and sees the sentence.
    const ctxStranger = await browser.newContext();
    const pageStranger = await ctxStranger.newPage();
    await signUp(pageStranger, { first: "Stranger" });
    const usernameStranger = await ownUsername(pageStranger);

    await pageTarget.goto(`/people/${usernameStranger}`);
    await pageTarget.getByTestId("profile-connect").click();
    await expect(pageTarget.getByText(sentence)).toBeVisible();

    await ctxReporter.close();
    await ctxTarget.close();
    await ctxStranger.close();
  });
});
