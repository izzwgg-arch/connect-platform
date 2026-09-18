import { expect, type Page } from "@playwright/test";

export const API = process.env.E2E_API_URL || "http://localhost:3101";

export function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export async function lastCode(target: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${API}/dev/last-code?target=${encodeURIComponent(target)}`);
    const b = (await r.json()) as { code?: string };
    if (b.code) return b.code;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`no code for ${target}`);
}

/** Signs up through the real UI, verifies via the dev mailbox, lands on onboarding. */
export async function signUp(page: Page, opts: { first?: string; last?: string } = {}) {
  const email = `e2e-${uid()}@example.test`;
  const password = "E2e-strong-pass-42";
  await page.goto("/join");
  await page.getByTestId("join-first").fill(opts.first ?? "E2E");
  await page.getByTestId("join-last").fill(opts.last ?? `User${uid().slice(-4)}`);
  await page.getByTestId("join-email").fill(email);
  await page.getByTestId("join-password").fill(password);
  await page.getByTestId("join-tos").check();
  await page.getByTestId("join-submit").click();
  await expect(page).toHaveURL(/\/welcome/);
  // verify email from Settings later; the API gate needs it for posting/messaging
  const code = await lastCode(email);
  await page.goto("/settings");
  await page.getByTestId("verify-email").click();
  await page.getByTestId("verify-code").fill(await lastCode(email).catch(() => code));
  await page.getByTestId("verify-confirm").click();
  await expect(page.getByText("Email verified")).toBeVisible();
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
