import { strict as assert } from "node:assert";
import test from "node:test";

import { brandLogoUrl, welcomeCreatePasswordEmail } from "./userEmailTemplates";

const BASE = {
  userName: "Izzy Weiss",
  userFirstName: "Izzy",
  tenantName: "Trust Bookkeepings",
  extensionNumber: "102",
  setupUrl: "https://app.connectcomunications.com/auth/invite/accept?token=abc",
  expiresHours: 48,
};

function build(extra: Partial<typeof BASE> & { androidApkUrl?: string | null } = {}) {
  return welcomeCreatePasswordEmail({ ...BASE, ...extra } as never);
}

// ─── the logo ────────────────────────────────────────────────────────────────

test("logo is an absolute https URL — a relative path or data: URI cannot load in email", () => {
  const url = brandLogoUrl();
  assert.match(url, /^https:\/\//, "must be absolute");
  assert.match(url, /\/brand\/loopcom\/loopcom-wordmark-email-336\.png$/);
});

test("logo url honours the deployment's public origin", () => {
  const prev = process.env.PORTAL_PUBLIC_URL;
  process.env.PORTAL_PUBLIC_URL = "https://portal.example.com/";
  try {
    assert.equal(brandLogoUrl(), "https://portal.example.com/brand/loopcom/loopcom-wordmark-email-336.png");
  } finally {
    if (prev === undefined) delete process.env.PORTAL_PUBLIC_URL;
    else process.env.PORTAL_PUBLIC_URL = prev;
  }
});

test("logo carries alt text, so a blocked image still names the brand", () => {
  const { html } = build();
  assert.match(html, /<img[^>]+alt="Loopcom"/);
  // width/height attributes, not just CSS — Outlook needs the attributes
  assert.match(html, /<img[^>]+width="168"[^>]*>/);
  assert.match(html, /<img[^>]+height="30"[^>]*>/);
});

// ─── Outlook ─────────────────────────────────────────────────────────────────

test("Outlook gets a fixed-width table, since it does not support max-width", () => {
  const { html } = build();
  assert.match(html, /<!--\[if mso\]><table[^>]*width="600"/);
  assert.match(html, /<!--\[if mso\]><\/td><\/tr><\/table><!\[endif\]-->/);
});

test("every gradient sits on a solid bgcolor, so Outlook degrades to flat colour", () => {
  const { html } = build({ androidApkUrl: "https://app.connectcomunications.com/api/mobile/android/download" });
  const gradientTags = html.match(/<[^>]*linear-gradient[^>]*>/g) || [];
  assert.ok(gradientTags.length > 0, "expected at least one gradient");
  for (const tag of gradientTags) {
    assert.match(tag, /bgcolor="#[0-9a-fA-F]{6}"/, `gradient tag without a bgcolor fallback: ${tag}`);
  }
});

// ─── mobile ──────────────────────────────────────────────────────────────────

test("mobile media query is present and is an enhancement, not the layout", () => {
  const { html } = build();
  assert.match(html, /@media only screen and \(max-width:620px\)/);
  // the card is fluid without the media query ever running
  assert.match(html, /class="lc-card"[^>]*style="[^"]*width:100%/);
});

// ─── content preserved ───────────────────────────────────────────────────────

test("every line of the original copy survives the redesign", () => {
  const { html, subject } = build();
  assert.equal(subject, "Welcome to Loopcom — Create Your Password");
  for (const fragment of [
    // esc() escapes & < > " only, so apostrophes stay literal
    "You're Invited",
    "Welcome to Trust Bookkeepings",
    "Hi Izzy,",
    "You've been invited to join",
    "Your account is ready. Create a password to get started",
    "Organization",
    "Extension",
    "Create Your Password",
    "This one-time link expires in",
    "48",
    "request a new invite from your administrator",
    "If you were not expecting this invite",
    "No account will be created without your action",
    // 2026-08-24: the footer names the tenant now instead of "your organization".
    "This email was sent on behalf of Trust Bookkeepings",
  ]) {
    assert.ok(
      html.includes(fragment) || html.includes(fragment.replace(/'/g, "&#39;")),
      `missing from redesigned email: ${fragment}`,
    );
  }
});

test("the Android block is present when there is an APK, and absent when there is not", () => {
  const withApk = build({ androidApkUrl: "https://app.connectcomunications.com/api/mobile/android/download" }).html;
  assert.ok(withApk.includes("Loopcom Mobile (Android)"), "Android heading missing");
  assert.ok(withApk.includes("Download Loopcom for Android"), "Android button missing");
  assert.ok(
    withApk.includes("Android may ask you to allow installs from this source the first time"),
    "Android install note missing",
  );

  const withoutApk = build({ androidApkUrl: null }).html;
  assert.ok(!withoutApk.includes("Download Loopcom for Android"));
});

test("copyright reads Loopcom — lowercase c, matching the iOS app name", () => {
  const { html } = build();
  assert.match(html, /&copy; \d{4} Loopcom/);
  assert.ok(!/LoopCom/.test(html), "brand name must not appear as LoopCom in customer-facing text");
  assert.ok(!/\d{4} Connect Communications &middot; All rights reserved/.test(html));
});

test("the invite email no longer says Connect Communications anywhere", () => {
  const built = build({ androidApkUrl: "https://app.connectcomunications.com/api/mobile/android/download" });
  for (const part of [built.html, built.text, built.subject]) {
    assert.ok(!part.includes("Connect Communications"), "Connect Communications still present");
  }
});

test("the plain-text part is untouched — text-only clients see exactly what they did before", () => {
  const { text } = build({ androidApkUrl: "https://app.connectcomunications.com/api/mobile/android/download" });
  assert.ok(text.startsWith("Welcome to Loopcom"));
  assert.ok(text.includes("Hi Izzy,"));
  assert.ok(text.includes(BASE.setupUrl));
  assert.ok(text.includes("This one-time link expires in 48 hours."));
  assert.ok(text.includes("Loopcom Mobile (Android):"));
  assert.ok(text.includes("If you were not expecting this invite, you can safely ignore this email."));
});

// ─── both queueing paths ─────────────────────────────────────────────────────

test("BOTH invite paths call the same template — neither can drift onto an old design", async () => {
  // ⛔ __dirname, not import.meta: this package is CommonJS and import.meta is a
  // TS1343 error here.
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  for (const file of ["server.ts", "onboarding/setupOrchestrator.ts"]) {
    const source = await readFile(path.join(__dirname, file), "utf8");
    assert.ok(
      source.includes("welcomeCreatePasswordEmail("),
      `${file} no longer builds the invite email through welcomeCreatePasswordEmail`,
    );
  }
});
