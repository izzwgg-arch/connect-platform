import { test, expect } from "@playwright/test";
import { signUp, uid, snap } from "./helpers";

test.describe("messages", () => {
  test("stranger message becomes a request; recipient accepts; reply; reaction; read receipt", async ({ page, browser }) => {
    await signUp(page, { first: "Miriam" });
    const usernameA = (await page.locator('a[href^="/people/"]').first().getAttribute("href"))!.replace("/people/", "");

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { first: "Nechama" });

    // A messages B, a stranger — this becomes a message REQUEST for B
    await page.goto(`/people/${await ((await pageB.locator('a[href^="/people/"]').first().getAttribute("href")))!.replace("/people/", "")}`);
    const firstMsg = `Hi, are you available for a quote? ${uid()}`;
    await page.getByTestId("profile-message").click();
    await expect(page).toHaveURL(/\/messages\//);
    await page.getByTestId("messages-input").fill(firstMsg);
    await page.getByTestId("messages-send").click();
    await expect(page.getByTestId(/messages-bubble-/).first()).toBeVisible();

    // B sees it in Requests and accepts
    await pageB.goto("/messages?tab=requests");
    await pageB.getByTestId("messages-tab-requests").click();
    const threadRowB = pageB.locator('[data-testid^="messages-thread-"]').first();
    await expect(threadRowB).toBeVisible();
    await threadRowB.click();
    await expect(pageB.getByText(firstMsg)).toBeVisible();
    await pageB.getByTestId("messages-accept-request").click();

    // B replies
    const reply = `Yes, what do you need? ${uid()}`;
    await pageB.getByTestId("messages-input").fill(reply);
    await pageB.getByTestId("messages-send").click();
    // Exactly one bubble per message: the sender's own realtime echo must never duplicate it.
    await expect(page.locator('[data-testid^="messages-bubble-"]', { hasText: firstMsg })).toHaveCount(1);
    await expect(pageB.locator('[data-testid^="messages-bubble-"]', { hasText: reply })).toBeVisible();

    // A sees the reply and reacts to it. Bubble locators, not getByText: on phones the
    // thread-list pane is in the DOM but hidden, and its preview carries the same text.
    await page.reload();
    await expect(page.locator('[data-testid^="messages-bubble-"]', { hasText: reply })).toBeVisible();
    const replyBubble = page.locator('[data-testid^="messages-bubble-"]', { hasText: reply }).first();
    const replyId = (await replyBubble.getAttribute("data-testid"))!.replace("messages-bubble-", "");
    await page.getByTestId(`messages-react-${replyId}-👍`).click();
    await expect(page.getByTestId(`messages-rx-${replyId}-👍`)).toBeVisible();

    // Read receipt: B reads A's first message; A should see "Seen" on it once refreshed
    await page.reload();
    await expect(page.getByTestId("messages-seen")).toBeVisible();
    await snap(page, "messages");

    await ctxB.close();
  });

  test("mobile shows a single pane: the thread list OR the open thread, never both", async ({ page, browser, isMobile }) => {
    test.skip(!isMobile, "single-pane layout is a mobile-only behavior");
    await signUp(page, { first: "Osnat" });
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { first: "Perel" });
    const usernameB = (await pageB.locator('a[href^="/people/"]').first().getAttribute("href"))!.replace("/people/", "");

    await page.goto(`/people/${usernameB}`);
    await page.getByTestId("profile-message").click();
    await page.getByTestId("messages-input").fill("Hello from mobile");
    await page.getByTestId("messages-send").click();

    // On mobile, the shell shows only the open thread (has-thread class); the
    // list is not simultaneously visible.
    await expect(page.getByTestId("messages-shell")).toHaveClass(/has-thread/);
    await page.getByTestId("messages-back").click();
    await expect(page.getByTestId("messages-shell")).not.toHaveClass(/has-thread/);

    await ctxB.close();
  });
});
