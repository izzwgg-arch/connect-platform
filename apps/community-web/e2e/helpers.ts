import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

export const API = process.env.E2E_API_URL || "http://localhost:3101";

export function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * /dev/last-code just returns "the most recent code found", with no cursor —
 * so right after triggering a *new* send, a naive poll can return the stale
 * code from an earlier send (e.g. registration's own auto-sent code) before
 * the fresh one is written, and confirming with it 400s (only the latest
 * code per purpose is valid). Pass `notEqualTo` the pre-send code so the poll
 * waits for a genuinely new one instead of racing.
 */
export async function lastCode(target: string, opts: { notEqualTo?: string } = {}): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${API}/dev/last-code?target=${encodeURIComponent(target)}`);
    const b = (await r.json()) as { code?: string };
    if (b.code && b.code !== opts.notEqualTo) return b.code;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`no (new) code for ${target}`);
}

/** Signs up through the real UI, verifies via the dev mailbox, lands on onboarding. */
export async function signUp(page: Page, opts: { first?: string; last?: string; phone?: string } = {}) {
  const email = `e2e-${uid()}@example.test`;
  const password = "E2e-strong-pass-42";
  await page.goto("/join");
  await page.getByTestId("join-first").fill(opts.first ?? "E2E");
  await page.getByTestId("join-last").fill(opts.last ?? `User${uid().slice(-4)}`);
  await page.getByTestId("join-email").fill(email);
  if (opts.phone) await page.getByTestId("join-phone").fill(opts.phone);
  await page.getByTestId("join-password").fill(password);
  await page.getByTestId("join-tos").check();
  await page.getByTestId("join-submit").click();
  await expect(page).toHaveURL(/\/welcome/);
  // verify email from Settings later; the API gate needs it for posting/messaging.
  // Registration itself auto-sends a code, so clicking verify-email issues a
  // second one that supersedes it — wait for that new one, not the old one.
  const preCode = await lastCode(email).catch(() => undefined);
  await page.goto("/settings");
  await page.getByTestId("verify-email").click();
  await page.getByTestId("verify-code").fill(await lastCode(email, { notEqualTo: preCode }));
  await page.getByTestId("verify-confirm").click();
  // "Email verified" also matches the toast text, ambiguous with the status chip
  // (getByText does substring matching) — wait for the pending-code UI to close instead.
  await expect(page.getByTestId("verify-code")).toBeHidden();
  return { email, password };
}

export async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByTestId("login-identifier").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page).not.toHaveURL(/\/login/);
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByTestId("landing-signin")).toBeVisible();
}

/** Creates an organization through the real UI from /company/new; returns its slug. */
export async function makeOrg(page: Page, opts: { name?: string; industry?: string } = {}) {
  const name = opts.name ?? `E2E Co ${uid()}`;
  await page.goto("/company/new");
  await page.getByTestId("company-new-name").fill(name);
  if (opts.industry) await page.getByTestId("company-new-industry").fill(opts.industry);
  await page.getByTestId("company-new-submit").click();
  await expect(page).toHaveURL(/\/companies\//);
  const slug = new URL(page.url()).pathname.replace(/^\/companies\//, "");
  return { name, slug };
}

/**
 * Reads the dev mailbox (COMMUNITY_TEST_HOOKS route, no real email sent) and
 * returns the first regex match found in the most recent message's body sent
 * to `target`. Used for links a 6-digit /dev/last-code code can't cover, e.g.
 * a company-invite accept link or a password-reset URL's full querystring.
 */
export async function lastMailLink(target: string, pattern: RegExp): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${API}/dev/mailbox?to=${encodeURIComponent(target)}`);
    const b = (await r.json()) as { mail: Array<{ text: string; createdAt: string }> };
    for (const m of b.mail) {
      const found = m.text.match(pattern);
      if (found) return found[0];
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`no mail matching ${pattern} for ${target}`);
}

/**
 * Grants (or changes) platform staff on an already-signed-up test person, by
 * writing the StaffGrant row directly — there is no UI/API path to grant
 * staff, so this is a fixture concern like the harness's own grantStaff().
 */
export function staff(email: string, role: "ADMIN" | "MODERATOR" = "ADMIN") {
  execFileSync(process.execPath, [path.join(__dirname, "tools/grant-staff.mjs"), email, role], { stdio: "pipe" });
}

/**
 * Saves one screenshot of the current page per theme to e2e/screenshots/, so a
 * human lead can eyeball each spec's real UI without running it. Viewport is
 * pinned to a commit-sized 1280x800 regardless of the project's own device
 * emulation, and both files come from the SAME page state (just re-themed),
 * not two different points in the flow.
 */
export async function snap(page: Page, specName: string) {
  const dir = "e2e/screenshots";
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((t) => {
      try {
        window.localStorage.setItem("lc.theme", t);
      } catch {
        /* ignore */
      }
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.waitForTimeout(150); // let the theme's CSS repaint settle
    await page.screenshot({ path: `${dir}/${specName}-${theme}.png`, type: "jpeg", quality: 70 });
  }
}

/** Sidebar nav testid, matching AppShell's `nav-${href.replace(/\//g,"-")||"home"}`. */
export function navTestId(href: string) {
  return `nav-${href.replace(/\//g, "-") || "home"}`;
}

/**
 * Clicks a sidebar destination. Device-independent: on a narrow viewport the
 * sidebar is off-canvas behind the hamburger (#hamburger); on desktop it is
 * always visible, so the hamburger click is skipped.
 */
export async function nav(page: Page, href: string) {
  const hamburger = page.locator("#hamburger");
  if (await hamburger.isVisible().catch(() => false)) await hamburger.click();
  await page.getByTestId(navTestId(href)).click();
}
