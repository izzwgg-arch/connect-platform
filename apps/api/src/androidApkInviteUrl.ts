/**
 * Android APK distribution paths + the public download-page URL.
 *
 * ⛔ THE INVITE EMAIL NO LONGER USES ANY OF THIS. As of 2026-09-15 the welcome
 * email carries the Google Play badge instead, and it resolves its own listing
 * and badge URLs inside `userEmailTemplates.ts` (`googlePlayListingUrl()` /
 * `googlePlayBadgeUrl()`) so no caller can drop them. `getAndroidApkUrlForInviteEmail()`
 * lived here and was deleted with that change — its whole purpose was the email.
 *
 * What remains serves the sideload route (`/api/mobile/android/download` and
 * `/api/downloads/...`), which is still live: the APK is NOT withdrawn, it is
 * just no longer what the invitation offers first.
 *
 * Everything is resolved from the environment at CALL time, not at import time,
 * so the values can be exercised directly in tests.
 */
import path from "node:path";
import { canonicalApiBase } from "./publicOrigins";

export const APK_LATEST_FILENAME = "connectcomms-latest.apk";

export function apkDownloadDir(): string {
  return (process.env.APK_DOWNLOAD_DIR || "/var/lib/connect/downloads").replace(/\/+$/, "");
}

export function apkPublicBaseUrl(): string {
  const configured = String(process.env.ANDROID_APK_DOWNLOAD_URL_BASE || "").trim();
  if (configured.length > 0) return configured.replace(/\/+$/, "");
  // publicOrigins.ts owns the env chain; canonicalApiBase() already ends in /api.
  const origin = canonicalApiBase();
  return (origin.endsWith("/api") ? `${origin}/downloads` : `${origin}/api/downloads`).replace(/\/+$/, "");
}

export function androidApkDownloadPageUrl(): string {
  return `${apkPublicBaseUrl().replace(/\/downloads$/, "")}/mobile/android/download`;
}
