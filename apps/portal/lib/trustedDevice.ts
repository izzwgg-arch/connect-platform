/**
 * "Remember this device" for the per-tenant sign-in code (2FA-by-code,
 * 2026-08-19). The api hands back an opaque token once, when the person ticks
 * the box after entering their code; the browser keeps it here and sends it
 * with the NEXT sign-in so the code is skipped for 90 days. It is a
 * skip-the-code token and nothing more — it is never a session, and the api
 * stores only its hash, so a copied localStorage entry lets nobody sign in
 * without that person's password. Dropped locally the moment it expires.
 */
const KEY = "cc-trusted-device";

export type TrustedDeviceRecord = { token: string; expiresAt: string };

export function readTrustedDeviceToken(nowMs: number = Date.now()): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as Partial<TrustedDeviceRecord>;
    const token = String(rec?.token || "");
    const exp = Date.parse(String(rec?.expiresAt || ""));
    if (!token || !Number.isFinite(exp) || exp <= nowMs) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export function writeTrustedDeviceToken(token: string, expiresAt: string): void {
  if (typeof window === "undefined") return;
  try {
    const rec: TrustedDeviceRecord = { token, expiresAt };
    window.localStorage.setItem(KEY, JSON.stringify(rec));
  } catch {
    /* storage full or blocked — the person is simply asked for a code next time */
  }
}

export function clearTrustedDeviceToken(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(KEY); } catch { /* ignore */ }
}
