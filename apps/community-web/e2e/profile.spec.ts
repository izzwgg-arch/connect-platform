import { test, expect, type Page } from "@playwright/test";
import { signUp, uid, API, snap } from "./helpers";

async function accessToken(page: Page): Promise<string | null> {
  return page.evaluate(() => window.localStorage.getItem("lc.access"));
}

async function ownUsername(page: Page): Promise<string> {
  const href = await page.locator('a[href^="/people/"]').first().getAttribute("href");
  return href!.replace("/people/", "");
}

test.describe("profile", () => {
  test("edit headline saves and shows on the public profile", async ({ page }) => {
    await signUp(page);
    const headline = `Owner, E2E Shop ${uid()}`;
    await page.goto("/me/profile");
    await page.getByTestId("profile-editor-headline").fill(headline);
    await page.getByTestId("profile-editor-save").click();
    await expect(page.getByText("Profile saved.")).toBeVisible();

    const username = await ownUsername(page);
    await page.goto(`/people/${username}`);
    // The headline appears twice: once in a compact sub-header, once as the
    // main "about" paragraph — either is proof enough, so just take the first.
    await expect(page.getByText(headline).first()).toBeVisible();
    await snap(page, "profile");
  });

  test("privacy: phone set PRIVATE hides it from another person; PUBLIC shows it", async ({ page, browser }) => {
    const phone = `+1845${Math.floor(1000000 + Math.random() * 8999999)}`;
    await signUp(page, { phone });
    const username = await ownUsername(page);

    // Baseline: make the phone level explicit PUBLIC so a stranger can see it —
    // the field defaults to CONNECTIONS, which a stranger already can't see, so
    // the PRIVATE assertion alone wouldn't prove anything without this contrast.
    await page.goto("/settings/privacy");
    await page.getByTestId("privacy-level-phone-public").check();
    await page.getByTestId("privacy-save").click();

    const other = await browser.newContext();
    const p2 = await other.newPage();
    await signUp(p2);
    const token = await accessToken(p2);
    const authHeaders = token ? { authorization: `Bearer ${token}` } : {};

    const whenPublic = await p2.request.get(`${API}/public/people/${username}`, { headers: authHeaders });
    expect((await whenPublic.json()).profile.phone).toBeTruthy();

    // Flip to PRIVATE
    await page.goto("/settings/privacy");
    await page.getByTestId("privacy-level-phone-private").check();
    await page.getByTestId("privacy-save").click();

    const whenPrivate = await p2.request.get(`${API}/public/people/${username}`, { headers: authHeaders });
    expect((await whenPrivate.json()).profile.phone).toBeFalsy();

    // The call CTA additionally requires both sides to have a linked Loopcom tenant
    // (canCallPerson in policy/graph.ts) — community-only test accounts never have
    // one, so profile-call is correctly absent in both states either way; the API
    // assertions above are what actually prove the PRIVATE toggle works.
    await p2.goto(`/people/${username}`);
    await expect(p2.getByTestId("profile-call")).toHaveCount(0);

    await other.close();
  });

  test("avatar upload with a generated PNG shows on the profile", async ({ page }) => {
    await signUp(page);
    await page.goto("/me/profile");
    const png1x1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await page.getByTestId("profile-editor-avatar-input").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: png1x1 });
    await expect(page.locator(".profile-avatar-upload img").first()).toBeVisible();
  });
});
