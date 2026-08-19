/**
 * The ONE place the mobile app knows the platform's public hostname.
 *
 * ⛔ 2026-08-19: the platform is served on both `app.connectcomunications.com`
 * and `app.loopcom.net` and is migrating to Loopcom. This literal was in SIX
 * places (client.ts, realtime.ts, NotificationsContext ×2, DiagnosticsScreen,
 * a health probe in jssip.ts). A Loopcom build changes ONE constant here — or
 * sets EXPO_PUBLIC_API_BASE_URL at build time, which every reader honours first.
 * ⛔ Changing this constant does nothing to installed apps; it ships with the
 * next APK / TestFlight build (Izzy's call to publish).
 */
export const DEFAULT_PUBLIC_ORIGIN = "https://app.connectcomunications.com";
export const DEFAULT_API_BASE = `${DEFAULT_PUBLIC_ORIGIN}/api`;
export const DEFAULT_TELEPHONY_WS_URL = `${DEFAULT_PUBLIC_ORIGIN.replace(/^https:/, "wss:")}/ws/telephony`;

/** The API base the app actually uses: build-time env first, then the default. */
export function resolveApiBase(): string {
  return (process.env.EXPO_PUBLIC_API_BASE_URL || DEFAULT_API_BASE).replace(/\/+$/, "");
}
