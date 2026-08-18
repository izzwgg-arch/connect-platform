import { strict as assert } from "node:assert";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { welcomeCreatePasswordEmail } from "./userEmailTemplates";

/**
 * The Android download link vanished from every self-service sign-up invite
 * because setupOrchestrator hardcoded `androidApkUrl: null` while the admin
 * invite path resolved a real URL. These tests cover the resolver AND assert
 * that both invite call sites actually feed it into the template.
 */

import { getAndroidApkUrlForInviteEmail } from "./androidApkInviteUrl";

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

test("an explicit page override wins outright", async () => {
  const restore = withEnv({
    ANDROID_APK_DOWNLOAD_PAGE_URL: "https://play.google.com/store/apps/details?id=x",
    APK_DOWNLOAD_DIR: "/definitely/not/here",
  });
  try {
    assert.equal(await getAndroidApkUrlForInviteEmail(), "https://play.google.com/store/apps/details?id=x");
  } finally {
    restore();
  }
});

test("no published APK means no link at all (never a broken one)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "apk-none-"));
  const restore = withEnv({
    ANDROID_APK_DOWNLOAD_PAGE_URL: undefined,
    APK_DOWNLOAD_DIR: dir,
  });
  try {
    assert.equal(await getAndroidApkUrlForInviteEmail(), null);
  } finally {
    restore();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("a published APK yields the download PAGE url, not the raw file", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "apk-yes-"));
  await fsp.writeFile(path.join(dir, "connectcomms-latest.apk"), Buffer.alloc(4096, 1));
  const restore = withEnv({
    ANDROID_APK_DOWNLOAD_PAGE_URL: undefined,
    APK_DOWNLOAD_DIR: dir,
    ANDROID_APK_DOWNLOAD_URL_BASE: "https://app.connectcomunications.com/api/downloads",
  });
  try {
    assert.equal(
      await getAndroidApkUrlForInviteEmail(),
      "https://app.connectcomunications.com/api/mobile/android/download",
    );
  } finally {
    restore();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("a truncated/placeholder APK is treated as not published", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "apk-tiny-"));
  await fsp.writeFile(path.join(dir, "connectcomms-latest.apk"), "stub");
  const restore = withEnv({
    ANDROID_APK_DOWNLOAD_PAGE_URL: undefined,
    APK_DOWNLOAD_DIR: dir,
  });
  try {
    assert.equal(await getAndroidApkUrlForInviteEmail(), null);
  } finally {
    restore();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("the invite template renders the link in both HTML and plain text", () => {
  const url = "https://app.connectcomunications.com/api/mobile/android/download";
  const built = welcomeCreatePasswordEmail({
    userName: "Test User",
    tenantName: "Acme",
    setupUrl: "https://app.connectcomunications.com/auth/invite/accept?token=abc",
    expiresHours: 72,
    androidApkUrl: url,
  });
  assert.ok(built.html.includes(url), "HTML body must carry the download link");
  // Wording follows the Loopcom rebrand (70dda3a9) — the shipped button reads
  // "Download Loopcom for Android"; this assertion had been left on the old text.
  assert.ok(built.html.includes("Download Loopcom for Android"), "HTML body must carry the button label");
  assert.ok(built.text.includes(url), "plain-text body must carry the download link");
});

test("BOTH invite paths feed a resolved URL into the template — neither hardcodes null", async () => {
  const callSites = ["server.ts", "onboarding/setupOrchestrator.ts"];
  for (const relative of callSites) {
    const source = await fsp.readFile(path.join(SRC_DIR, relative), "utf8");
    assert.ok(
      source.includes("welcomeCreatePasswordEmail("),
      `${relative} should still queue the welcome/create-password email`,
    );
    assert.ok(
      source.includes("getAndroidApkUrlForInviteEmail"),
      `${relative} must resolve the Android link via the shared helper`,
    );
    assert.ok(
      !/androidApkUrl:\s*null/.test(source),
      `${relative} must not hardcode androidApkUrl: null — that silently drops the APK link`,
    );
  }
});
