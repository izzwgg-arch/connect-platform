import { test, expect, type Locator } from "@playwright/test";
import { signUp, uid, snap } from "./helpers";

/** PostCard's edit/delete/hide/mute/report controls live inside the "Post options" menu, which only renders its items once opened. */
async function openPostMenu(card: Locator) {
  // exact match: "Post options" is a substring of the "Repost options" menu too
  await card.getByRole("button", { name: "Post options", exact: true }).click();
}

test.describe("feed", () => {
  test("compose a text post; appears in Latest; second user reacts + comments; author edits and deletes; hide", async ({ page, browser }) => {
    await signUp(page, { first: "Golda" });
    const body = `E2E feed post ${uid()}`;

    await page.goto("/");
    await page.getByTestId("feed-composer-body").fill(body);
    await page.getByTestId("feed-composer-submit").click();
    await expect(page.getByText(body)).toBeVisible();
    await snap(page, "feed");

    // Switch to Latest to guarantee a deterministic, freshest-first ordering
    await page.getByTestId("feed-mode-latest").click();
    const card = page.locator(`.card.post:has-text("${body}")`).first();
    await expect(card).toBeVisible();
    const testId = await card.getAttribute("data-testid"); // "feed-post-<id>"
    expect(testId).toBeTruthy();

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { first: "Hinda" });
    await pageB.goto("/");
    await pageB.getByTestId("feed-mode-latest").click();
    const cardB = pageB.locator(`[data-testid="${testId}"]`);
    await expect(cardB).toBeVisible();
    await cardB.getByTestId(`${testId}-react`).click();
    await expect(cardB.getByTestId(`${testId}-react`)).toHaveClass(/on/);

    await cardB.getByTestId(`${testId}-comment`).click();
    const commentText = `Nice one ${uid()}`;
    await cardB.getByTestId(`${testId}-comment-input`).fill(commentText);
    await cardB.getByTestId(`${testId}-comment-submit`).click();
    await expect(cardB.getByText(commentText)).toBeVisible();

    // Author sees the comment too and edits, then deletes the post
    await page.reload();
    await page.getByTestId("feed-mode-latest").click();
    const cardAuthor = page.locator(`[data-testid="${testId}"]`);
    await expect(cardAuthor).toBeVisible();

    const editedBody = `${body} (edited)`;
    await openPostMenu(cardAuthor);
    await cardAuthor.getByTestId(`${testId}-edit`).click();
    await cardAuthor.getByTestId(`${testId}-edit-body`).fill(editedBody);
    await cardAuthor.getByTestId(`${testId}-edit-save`).click();
    await expect(page.getByText(editedBody)).toBeVisible();

    await openPostMenu(cardAuthor);
    await cardAuthor.getByTestId(`${testId}-delete`).click();
    await cardAuthor.getByTestId(`${testId}-delete-confirm`).click();
    await expect(page.locator(`[data-testid="${testId}"]`)).toHaveCount(0);

    await ctxB.close();
  });

  test("compose a poll; a second user votes", async ({ page, browser }) => {
    await signUp(page, { first: "Ita" });
    const question = `Best day for the sale? ${uid()}`;

    await page.goto("/");
    await page.getByTestId("feed-composer-toggle-poll").click();
    await page.getByTestId("feed-composer-poll-question").fill(question);
    await page.getByTestId("feed-composer-poll-option-0").fill("Sunday");
    await page.getByTestId("feed-composer-poll-option-1").fill("Monday");
    await page.getByTestId("feed-composer-submit").click();
    await expect(page.getByText(question)).toBeVisible();

    await page.getByTestId("feed-mode-latest").click();
    const card = page.locator(`.card.post:has-text("${question}")`).first();
    const testId = await card.getAttribute("data-testid");

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { first: "Yocheved" });
    await pageB.goto("/");
    await pageB.getByTestId("feed-mode-latest").click();
    const cardB = pageB.locator(`[data-testid="${testId}"]`);
    await cardB.getByText("Sunday").click();
    await expect(cardB.getByText(/1 vote/)).toBeVisible();

    await ctxB.close();
  });

  test("hide removes a post from the viewer's own feed", async ({ page, browser }) => {
    await signUp(page, { first: "Kayla" });
    const body = `E2E hide-me post ${uid()}`;
    await page.goto("/");
    await page.getByTestId("feed-composer-body").fill(body);
    await page.getByTestId("feed-composer-submit").click();
    await page.getByTestId("feed-mode-latest").click();
    const card = page.locator(`.card.post:has-text("${body}")`).first();
    const testId = await card.getAttribute("data-testid");

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { first: "Leah" });
    await pageB.goto("/");
    await pageB.getByTestId("feed-mode-latest").click();
    const cardB = pageB.locator(`[data-testid="${testId}"]`);
    await expect(cardB).toBeVisible();
    await openPostMenu(cardB);
    await cardB.getByTestId(`${testId}-hide`).click();
    await expect(pageB.locator(`[data-testid="${testId}"]`)).toHaveCount(0);

    // The author still sees their own post
    await page.reload();
    await page.getByTestId("feed-mode-latest").click();
    await expect(page.locator(`[data-testid="${testId}"]`)).toBeVisible();

    await ctxB.close();
  });
});
