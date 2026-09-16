import { strict as assert } from "node:assert";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  GOOGLE_PLAY_LISTING_URL,
  googlePlayBadgeUrl,
  googlePlayListingUrl,
  welcomeCreatePasswordEmail,
} from "./userEmailTemplates";
import { androidApkDownloadPageUrl, apkPublicBaseUrl } from "./androidApkInviteUrl";

/**
 * ⛔ WHY THESE TESTS READ CALL-SITE SOURCE, not just the resolver.
 *
 * The Android link once vanished from every self-service sign-up invite because
 * `setupOrchestrator` hardcoded `androidApkUrl: null` while the admin invite
 * path resolved a real URL. A resolver-only unit test passed straight through
 * that bug — the defect was a CALLER.
 *
 * 2026-09-15: the email now carries the Google Play badge, and the fix for that
 * whole class was to stop letting callers supply anything at all. So the
 * invariant these tests hold is stronger than before: neither invite path may
 * pass an Android URL into the template, and the template must resolve both the
 * listing and the badge itself.
 */

const SRC_DIR = __dirname;

/** Everything is read from the environment at call time, so no re-import games. */
function withEnv(env: Record<string, string | undefined>) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function buildInvite() {
  return welcomeCreatePasswordEmail({
    userName: "Test User",
    tenantName: "Acme",
    setupUrl: "https://app.connectcomunications.com/auth/invite/accept?token=abc",
    expiresHours: 72,
  });
}

// ─── the listing URL ─────────────────────────────────────────────────────────

test("with nothing configured, the link is the real Play listing", () => {
  const restore = withEnv({ ANDROID_PLAY_STORE_URL: undefined });
  try {
    assert.equal(googlePlayListingUrl(), GOOGLE_PLAY_LISTING_URL);
    assert.equal(
      GOOGLE_PLAY_LISTING_URL,
      "https://play.google.com/store/apps/details?id=com.connectcommunications.mobile",
      "the package id is what Play resolves — a typo here sends every new customer to a 404",
    );
  } finally {
    restore();
  }
});

test("ANDROID_PLAY_STORE_URL is the swing lever when the listing has to move", () => {
  const restore = withEnv({ ANDROID_PLAY_STORE_URL: "https://example.test/elsewhere" });
  try {
    assert.equal(googlePlayListingUrl(), "https://example.test/elsewhere");
  } finally {
    restore();
  }
});

test("a blank override is ignored, not treated as an empty link", () => {
  const restore = withEnv({ ANDROID_PLAY_STORE_URL: "   " });
  try {
    assert.equal(googlePlayListingUrl(), GOOGLE_PLAY_LISTING_URL);
  } finally {
    restore();
  }
});

// ─── the badge image ─────────────────────────────────────────────────────────

test("the badge is an absolute https URL — a relative path cannot load in email", () => {
  const restore = withEnv({ PORTAL_PUBLIC_URL: undefined, PUBLIC_PORTAL_URL: undefined });
  try {
    const url = googlePlayBadgeUrl();
    assert.match(url, /^https:\/\//, "must be absolute");
    assert.match(url, /\/brand\/google-play\/get-it-on-google-play\.png$/);
  } finally {
    restore();
  }
});

test("the badge url follows the deployment's public origin", () => {
  const restore = withEnv({ PUBLIC_PORTAL_URL: "https://portal.example.com/" });
  try {
    assert.equal(
      googlePlayBadgeUrl(),
      "https://portal.example.com/brand/google-play/get-it-on-google-play.png",
    );
  } finally {
    restore();
  }
});

test("the badge file we link to actually exists in the portal's public dir", async () => {
  // ⛔ An email image 404s silently — nobody finds out until a customer says the
  // invite "has a broken picture". Prove the file is on disk at the path the URL
  // promises, and that it is the real asset rather than a placeholder.
  const asset = path.join(
    SRC_DIR,
    "..",
    "..",
    "..",
    "apps",
    "portal",
    "public",
    "brand",
    "google-play",
    "get-it-on-google-play.png",
  );
  const stat = await fsp.stat(asset);
  assert.ok(stat.isFile(), "the badge must be a real file");
  assert.ok(stat.size > 1024, `the badge looks like a placeholder (${stat.size} bytes)`);
  const header = await fsp.open(asset, "r").then(async (fh) => {
    const buf = Buffer.alloc(8);
    await fh.read(buf, 0, 8, 0);
    await fh.close();
    return buf;
  });
  assert.ok(header.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "must be a PNG");
});

// ─── what the email actually renders ─────────────────────────────────────────

test("the invite renders the badge, linked to Play, in HTML and plain text", () => {
  const restore = withEnv({ ANDROID_PLAY_STORE_URL: undefined });
  try {
    const built = buildInvite();
    assert.ok(built.html.includes(`href="${GOOGLE_PLAY_LISTING_URL}"`), "badge must link to the listing");
    assert.ok(built.html.includes(googlePlayBadgeUrl()), "badge image must be in the HTML");
    assert.ok(built.html.includes('alt="Get it on Google Play"'), "blocked images must still name the store");
    assert.ok(built.text.includes(GOOGLE_PLAY_LISTING_URL), "plain-text body must carry the listing link");
  } finally {
    restore();
  }
});

test("Outlook gets width/height ATTRIBUTES on the badge, or it draws it at 646px", () => {
  const { html } = buildInvite();
  const img = (html.match(/<img[^>]+alt="Get it on Google Play"[^>]*>/) || [])[0];
  assert.ok(img, "badge image tag not found");
  assert.match(img, /width="180"/);
  assert.match(img, /height="70"/);
});

test("the Android block is ALWAYS present — it can no longer be switched off by a caller", () => {
  const { html, text } = buildInvite();
  assert.ok(html.includes("Loopcom Mobile (Android)"), "Android heading missing");
  assert.ok(text.includes("Loopcom Mobile (Android):"), "Android heading missing from plain text");
});

test("the APK wording is gone — it would be wrong next to a Play badge", () => {
  const built = buildInvite();
  for (const part of [built.html, built.text]) {
    assert.ok(!/allow installs from this source/i.test(part), "sideload warning still present");
    assert.ok(!/\bAPK\b/.test(part), "APK still mentioned");
    assert.ok(!part.includes("Download Loopcom for Android"), "old download button still present");
  }
});

// ─── the call sites, which are where this broke last time ────────────────────

test("NEITHER invite path passes an Android URL into the template any more", async () => {
  const callSites = ["server.ts", "onboarding/setupOrchestrator.ts"];
  for (const relative of callSites) {
    const source = await fsp.readFile(path.join(SRC_DIR, relative), "utf8");
    assert.ok(
      source.includes("welcomeCreatePasswordEmail("),
      `${relative} should still queue the welcome/create-password email`,
    );
    assert.ok(
      !/androidApkUrl\s*:/.test(source),
      `${relative} must not pass androidApkUrl — the template resolves the Play link itself now`,
    );
    assert.ok(
      !source.includes("getAndroidApkUrlForInviteEmail"),
      `${relative} must not resolve an APK link for the invite email any more`,
    );
  }
});

test("the template resolves BOTH Play URLs itself, so no caller can drop them", async () => {
  const source = await fsp.readFile(path.join(SRC_DIR, "userEmailTemplates.ts"), "utf8");
  assert.ok(source.includes("googlePlayListingUrl()"), "template must resolve the listing URL itself");
  assert.ok(source.includes("googlePlayBadgeUrl()"), "template must resolve the badge URL itself");
  // ⛔ The prose comment recording WHY it went away is deliberately allowed to
  // keep saying `androidApkUrl` — what must not come back is the input field or
  // any read of it, which is the caller-supplied value that once went missing.
  assert.ok(
    !/androidApkUrl\s*\?*\s*:/.test(source),
    "androidApkUrl must not be an input of the invite template again",
  );
  assert.ok(
    !/input\.androidApkUrl/.test(source),
    "the invite template must not read a caller-supplied Android URL",
  );
});

// ─── the APK route is NOT withdrawn ──────────────────────────────────────────

test("the sideload download page still resolves — the APK is not withdrawn, just not offered first", () => {
  const restore = withEnv({
    ANDROID_APK_DOWNLOAD_URL_BASE: "https://app.connectcomunications.com/api/downloads",
  });
  try {
    assert.equal(apkPublicBaseUrl(), "https://app.connectcomunications.com/api/downloads");
    assert.equal(
      androidApkDownloadPageUrl(),
      "https://app.connectcomunications.com/api/mobile/android/download",
    );
  } finally {
    restore();
  }
});
