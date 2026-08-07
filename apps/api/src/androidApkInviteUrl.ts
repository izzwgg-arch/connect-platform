/**
 * Android APK distribution paths + the download-page URL used in invite emails.
 *
 * These live here (rather than inside server.ts) because TWO invite paths queue
 * the welcome/create-password email and both must carry the same Android link:
 *   - the admin "invite user / resend invite" path in server.ts
 *   - the onboarding sign-up path in onboarding/setupOrchestrator.ts
 * A copy in only one of them is exactly how the link went missing for every
 * self-service sign-up while admin invites still had it.
 *
 * Everything is resolved from the environment at CALL time, not at import time,
 * so the values can be exercised directly in tests.
 */
import { promises as fsp } from "fs";
import path from "node:path";

export const APK_LATEST_FILENAME = "connectcomms-latest.apk";

export function apkDownloadDir(): string {
  return (process.env.APK_DOWNLOAD_DIR || "/var/lib/connect/downloads").replace(/\/+$/, "");
}

export function apkPublicBaseUrl(): string {
  const configured = String(process.env.ANDROID_APK_DOWNLOAD_URL_BASE || "").trim();
  if (configured.length > 0) return configured.replace(/\/+$/, "");
  const origin = String(
    process.env.API_PUBLIC_URL
    || process.env.PUBLIC_API_URL
    || process.env.PUBLIC_API_BASE_URL
    || process.env.PORTAL_PUBLIC_URL
    || process.env.APP_PUBLIC_URL
    || "https://app.connectcomunications.com"
  ).replace(/\/+$/, "");
  return (origin.endsWith("/api") ? `${origin}/downloads` : `${origin}/api/downloads`).replace(/\/+$/, "");
}

export function androidApkDownloadPageUrl(): string {
  return `${apkPublicBaseUrl().replace(/\/downloads$/, "")}/mobile/android/download`;
}

/**
 * URL shown in user invite / welcome emails for the Android app.
 * - ANDROID_APK_DOWNLOAD_PAGE_URL: optional override (Play Store, landing page, etc.).
 * - Otherwise: same HTML download page as /mobile/android/download, but only if
 *   connectcomms-latest.apk exists under APK_DOWNLOAD_DIR (avoids broken links).
 */
export async function getAndroidApkUrlForInviteEmail(): Promise<string | null> {
  const pageOverride = String(process.env.ANDROID_APK_DOWNLOAD_PAGE_URL || "").trim();
  if (pageOverride.length > 0) return pageOverride;
  try {
    const latestPath = path.join(apkDownloadDir(), APK_LATEST_FILENAME);
    const st = await fsp.stat(latestPath);
    if (!st.isFile() || st.size < 1024) return null;
    return androidApkDownloadPageUrl();
  } catch {
    return null;
  }
}
