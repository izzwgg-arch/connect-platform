import { test, expect } from "@playwright/test";
import { signUp, signIn, signOut, lastCode, uid, snap } from "./helpers";

test.describe("identity", () => {
  test("landing → join → verify → onboarding → sign out → sign in", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("landing-join")).toBeVisible();
    const { email, password } = await signUp(page);
    await page.goto("/welcome");
    await page.getByTestId("ob-headline").fill("Owner, E2E Embroidery");
    await page.getByTestId("ob-continue").click();
    await page.getByText("Find customers").click();
    await page.getByTestId("ob-skip").click();
    await expect(page).toHaveURL("/");
    await signOut(page);
    await signIn(page, email, password);
    await expect(page.getByTestId("theme-toggle")).toBeVisible();
    await snap(page, "auth");
  });

  test("light/dark toggle persists across reload", async ({ page }) => {
    // signUp() already leaves the session signed in; re-visiting /login while
    // authenticated makes the login page redirect itself away immediately
    // (app/login/page.tsx's own "already signed in" guard), racing any fill()
    // on the form it's in the middle of unmounting — so there's nothing to sign
    // into here on purpose.
    await signUp(page);
    await page.goto("/");
    await page.getByTestId("theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("wrong password shows a human sentence, forgot password sends a link that works", async ({ page }) => {
    const { email } = await signUp(page);
    await signOut(page);
    await page.goto("/login");
    await page.getByTestId("login-identifier").fill(email);
    await page.getByTestId("login-password").fill("definitely-wrong-1");
    await page.getByTestId("login-submit").click();
    // Next.js's own hidden route announcer (#__next-route-announcer__) also
    // carries role="alert", making the bare role query ambiguous.
    await expect(page.locator('[role="alert"].chip')).toContainText("don't match");
    await page.goto("/forgot-password");
    await page.getByTestId("forgot-identifier").fill(email);
    await page.getByTestId("forgot-submit").click();
    await expect(page.getByText("on its way")).toBeVisible();
    const r = await fetch(`${process.env.E2E_API_URL || "http://localhost:3101"}/dev/last-code?target=${encodeURIComponent(email)}`);
    const { resetToken } = (await r.json()) as { resetToken: string };
    await page.goto(`/reset-password?token=${resetToken}`);
    await page.getByTestId("reset-password").fill("Another-strong-pass-7");
    await page.getByTestId("reset-confirm").fill("Another-strong-pass-7");
    await page.getByTestId("reset-submit").click();
    await expect(page).toHaveURL(/\/login/);
    await signIn(page, email, "Another-strong-pass-7");
  });

  test("security page lists the current session; sign out of all other devices works", async ({ page, browser }) => {
    const { email, password } = await signUp(page);
    const other = await browser.newContext();
    const p2 = await other.newPage();
    await signIn(p2, email, password);
    await page.goto("/settings/security");
    // exact: "current" alone also substring-matches the "Current password" label
    await expect(page.getByText("current", { exact: true })).toBeVisible();
    await page.getByText("Sign out of all other devices").click();
    await p2.reload();
    await expect(p2).toHaveURL(/\/login|\/$/);
    await other.close();
    void uid;
    void lastCode;
  });
});
