import { createHmac } from "node:crypto";
import { test, expect } from "@playwright/test";
import { signUp, signIn, signOut, snap } from "./helpers";

/** Minimal RFC 4648 base32 decoder (no padding) — enough for a TOTP secret. */
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/, "").toUpperCase();
  let bits = "";
  for (const c of clean) {
    const val = alphabet.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP, 30s step, 6 digits, SHA-1 — the same defaults every authenticator app uses. */
function totp(secretBase32: string, at: number = Date.now()): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(at / 1000 / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

test.describe("settings", () => {
  test("TOTP: enable via the QR secret, login then requires the code, disable", async ({ page }) => {
    const { email, password } = await signUp(page);
    await page.goto("/settings/security");
    await page.getByTestId("mfa-toggle").click();
    const secretText = await page.locator("p.mono").filter({ hasText: "Or type the key:" }).innerText();
    const secret = secretText.replace("Or type the key:", "").trim();
    expect(secret.length).toBeGreaterThan(10);

    await page.getByTestId("mfa-code").fill(totp(secret));
    await page.getByTestId("mfa-enable").click();
    await expect(page.getByText("Two-step verification is on.")).toBeVisible();

    // signing in now requires the TOTP code
    await signOut(page);
    await page.goto("/login");
    await page.getByTestId("login-identifier").fill(email);
    await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-totp")).toBeVisible();
    await page.getByTestId("login-totp").fill(totp(secret));
    await page.getByTestId("login-submit").click();
    await expect(page).not.toHaveURL(/\/login/);

    // disable it again
    await page.goto("/settings/security");
    await page.getByTestId("mfa-toggle").click();
    await page.getByTestId("mfa-off").fill(totp(secret));
    await page.getByTestId("mfa-disable-confirm").click();
    await expect(page.getByText("Two-step verification is off.")).toBeVisible();

    // a plain sign-in no longer asks for a code
    await signOut(page);
    await signIn(page, email, password);
    await expect(page).not.toHaveURL(/\/login/);
    await page.goto("/settings/security");
    await snap(page, "settings");
  });

  test("export downloads a JSON file", async ({ page }) => {
    await signUp(page);
    await page.goto("/settings/data");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-data").click()]);
    expect(download.suggestedFilename()).toMatch(/\.json$/);
  });

  test("delete account opens a confirm dialog", async ({ page }) => {
    await signUp(page);
    await page.goto("/settings/data");
    await page.getByTestId("delete-account").click();
    await expect(page.getByTestId("delete-confirm")).toBeVisible();
  });
});
