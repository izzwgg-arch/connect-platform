/**
 * Pure auth policy helpers — no React, no native modules — so they're cheap
 * to unit test (src/auth/policy.test.ts) and reused by AuthProvider and the
 * lock-screen gate.
 */

/** Should the app show the biometric lock screen right now? */
export function needsBiometricGate(opts: {
  settingEnabled: boolean;
  hasHardware: boolean;
  isEnrolled: boolean;
  isSignedIn: boolean;
}): boolean {
  return opts.isSignedIn && opts.settingEnabled && opts.hasHardware && opts.isEnrolled;
}

/**
 * A short grace period after a successful unlock (foregrounding the app
 * again quickly, e.g. switching to take a photo, shouldn't re-prompt).
 */
export function withinUnlockGrace(lastUnlockAt: number | null, now: number, graceMs = 30_000): boolean {
  if (lastUnlockAt == null) return false;
  return now - lastUnlockAt < graceMs;
}

/**
 * Token storage rule, documented once and enforced by test: the access token
 * is never a candidate for persistent storage — only the refresh token is.
 * Kept as a pure predicate so the rule can be asserted without touching
 * SecureStore.
 */
export function isPersistableToken(kind: "access" | "refresh"): boolean {
  return kind === "refresh";
}
