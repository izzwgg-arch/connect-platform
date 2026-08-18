/**
 * Who must have MFA, and what happens to them when they do not yet.
 *
 * ⛔ GRACE MODE IS THE DEFAULT AND THE ONLY MODE THAT HAS BEEN TURNED ON.
 * An unenrolled user in a required role still signs in normally; the login
 * response merely carries `mfaEnrollmentRequired: true` so the portal can
 * prompt them. Hard enforcement (`MFA_ENFORCEMENT=required`) refuses their
 * login outright with `403 mfa_enrollment_required` — and since enrolling
 * needs a session, that flip is only safe AFTER every person in a required
 * role has enrolled. Flip it while Izzy's SUPER_ADMIN account is unenrolled
 * and he is locked out of his own platform with no way back short of an env
 * change. That is the one outcome this file exists to prevent, so:
 *
 *   - unknown / blank / misspelt values of MFA_ENFORCEMENT mean GRACE;
 *   - only the exact string `required` (case-insensitive, trimmed) is hard;
 *   - `mfa.test.ts` pins that the default is grace.
 *
 * ⛔ Nothing here reads NODE_ENV (the api container sets none — CLAUDE.md).
 * ⛔ Read at call time, never memoised at module load, so tests can set env.
 */

export const DEFAULT_MFA_REQUIRED_ROLES = ["SUPER_ADMIN"] as const;

export type MfaEnforcementMode = "grace" | "required";

/** Roles that must carry MFA. `MFA_REQUIRED_ROLES` is a comma list; blank = default. */
export function mfaRequiredRoles(): string[] {
  const raw = String(process.env.MFA_REQUIRED_ROLES ?? "").trim();
  if (!raw) return [...DEFAULT_MFA_REQUIRED_ROLES];
  const roles = raw
    .split(",")
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean);
  return roles.length ? roles : [...DEFAULT_MFA_REQUIRED_ROLES];
}

export function isMfaRequiredForRole(role: string | null | undefined): boolean {
  const r = String(role ?? "").trim().toUpperCase();
  if (!r) return false;
  return mfaRequiredRoles().includes(r);
}

/** `grace` unless the env says exactly `required`. Anything else is grace. */
export function mfaEnforcementMode(): MfaEnforcementMode {
  const raw = String(process.env.MFA_ENFORCEMENT ?? "").trim().toLowerCase();
  return raw === "required" ? "required" : "grace";
}

export type MfaLoginGate =
  /** Not enrolled, not required — the login response is exactly what it always was. */
  | { kind: "none" }
  /** Enrolled — hand back a pre-auth token, not a session. */
  | { kind: "challenge" }
  /** Required role, not enrolled, grace mode — sign in, but flag it. */
  | { kind: "enroll_grace" }
  /** Required role, not enrolled, hard mode — refuse. */
  | { kind: "enroll_required" };

/**
 * The single decision `/auth/login` makes after the password checks out.
 * Pure: it is handed whether the user is enrolled, and their role.
 */
export function decideMfaLoginGate(input: { role: string | null | undefined; mfaEnabled: boolean }): MfaLoginGate {
  if (input.mfaEnabled) return { kind: "challenge" };
  if (!isMfaRequiredForRole(input.role)) return { kind: "none" };
  return mfaEnforcementMode() === "required" ? { kind: "enroll_required" } : { kind: "enroll_grace" };
}
