/**
 * Multi-factor authentication — the decisions, with every side effect injected.
 *
 * Phase 11 of the 2026-08 security brief. TOTP first; the store shape and the
 * `method` field on results are deliberately not TOTP-specific so a passkey /
 * WebAuthn factor can be added beside it later without re-cutting the login
 * flow.
 *
 * ── The contract `/auth/login` follows (server.ts) ────────────────────────────
 *
 *   password wrong ............ 401 { error: "invalid_credentials" }  (unchanged,
 *                               and it never says whether MFA is on — the check
 *                               below runs only AFTER the password matched)
 *   password right, no MFA ... 200 { token, portalPermissionSet? }    (unchanged)
 *   password right, required role, not enrolled, grace mode
 *                           ... 200 { token, portalPermissionSet?, mfaEnrollmentRequired: true }
 *   password right, MFA on ... 200 { mfaChallengeRequired: true, preAuthToken,
 *                                    expiresInSeconds, methods, error: "mfa_required" }
 *                               — NO session token. `error` is there ONLY so a
 *                               client written before MFA (mobile: `!json.token`
 *                               → throw json.error) shows "mfa_required" instead
 *                               of "LOGIN_FAILED".
 *   POST /auth/mfa/challenge { preAuthToken, code }
 *                           ... 200 exactly the normal login body, or
 *                               401 { error: "invalid_code" } / 401 { error: "preauth_invalid" }
 *                               / 429 { error: "RATE_LIMITED" }
 *
 * ── Rules ─────────────────────────────────────────────────────────────────────
 *
 * ⛔ The TOTP secret is encrypted at rest with the same AES-256-GCM /
 *    CREDENTIALS_MASTER_KEY envelope as every other credential (`@connect/security`
 *    encryptJson) — the caller injects encrypt/decrypt so this file has no key.
 * ⛔ Nothing here logs, audits or returns a secret, a code or a recovery code
 *    except the ONE response that shows recovery codes at enrolment/regeneration.
 * ⛔ A TOTP code is single-use: `lastUsedCounter` is persisted on every success
 *    and `verifyTotp` refuses anything at or below it (replay).
 * ⛔ A recovery code is single-use: consumed with an atomic "update where usedAt
 *    is null", so two concurrent attempts cannot both spend it.
 * ⛔ Every code check goes through ONE throttle instance (its own store, not the
 *    password throttle's), keyed by user id + source: five wrong codes and the
 *    account is throttled for ten minutes. Same dimensions as `/auth/login`.
 * ⛔ Enrolment is only ever completed by the person themself, with a code from
 *    the app they just scanned — an admin cannot enrol someone. An admin
 *    (SUPER_ADMIN only) can DISABLE another user's MFA, audited with both ids.
 */

import { createLoginThrottle, normalizeSourceKey, type LoginThrottleDecision } from "../loginThrottle";
import { decideMfaLoginGate, isMfaRequiredForRole, type MfaLoginGate } from "./mfaPolicy";
import { mintPreAuthToken, verifyPreAuthToken } from "./preAuthToken";
import {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_HASH_ROUNDS,
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  recoveryCodeMatches,
} from "./recoveryCodes";
import {
  buildOtpauthUri,
  formatSecretForDisplay,
  generateTotpSecret,
  looksLikeTotpCode,
  verifyTotp,
} from "./totp";

// ─── Store contract ──────────────────────────────────────────────────────────

export type MfaUserRow = {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  status?: string | null;
};

export type MfaRow = {
  id: string;
  userId: string;
  totpSecretEncrypted: string;
  enabledAt: Date | null;
  lastUsedCounter: number | null;
};

export interface MfaStore {
  getUser(userId: string): Promise<MfaUserRow | null>;
  getMfa(userId: string): Promise<MfaRow | null>;
  /** Create or overwrite the PENDING (not yet enabled) row for a user. */
  upsertPending(userId: string, totpSecretEncrypted: string): Promise<MfaRow>;
  markEnabled(mfaId: string, enabledAt: Date, lastUsedCounter: number): Promise<void>;
  setLastUsedCounter(mfaId: string, counter: number): Promise<void>;
  /** Drop every existing code for this row and store these hashes. */
  replaceRecoveryCodes(mfaId: string, codeHashes: string[]): Promise<void>;
  listUnusedRecoveryCodes(mfaId: string): Promise<Array<{ id: string; codeHash: string }>>;
  countUnusedRecoveryCodes(mfaId: string): Promise<number>;
  /** Atomic single-use claim; true iff THIS call spent it. */
  consumeRecoveryCode(codeId: string, usedAt: Date): Promise<boolean>;
  deleteMfa(userId: string): Promise<void>;
}

export type MfaAudit = (params: {
  tenantId: string;
  action: string;
  entityType: string;
  entityId: string;
  actorUserId?: string;
  targetUserId?: string | null;
  metadata?: Record<string, unknown> | null;
}) => Promise<void>;

export type MfaDeps = {
  store: MfaStore;
  encrypt: (plain: string) => string;
  decrypt: (encoded: string) => string;
  audit: MfaAudit;
  now?: () => number;
  /** bcrypt cost for recovery codes; tests lower it. */
  recoveryHashRounds?: number;
  /** Shown in the authenticator app. */
  issuer?: string;
  /** Test hook — defaults to the module's own instance. */
  throttle?: ReturnType<typeof createLoginThrottle>;
};

// ─── Throttle ────────────────────────────────────────────────────────────────

/**
 * Five wrong codes in ten minutes → the account waits ten minutes. A 6-digit
 * space is a million; at five guesses per ten minutes per source it is not
 * brute-forceable inside the code's 90 s of validity, and a person who fumbles
 * a code three times is not punished.
 */
export const MFA_CHALLENGE_THROTTLE_CONFIG = {
  accountFailureLimit: 5,
  accountWindowMs: 10 * 60 * 1000,
  sourceFailureLimit: 25,
  sourceWindowMs: 10 * 60 * 1000,
  sourceDistinctAccountLimit: 6,
  blockMs: 15 * 60 * 1000,
} as const;

const defaultThrottle = createLoginThrottle(MFA_CHALLENGE_THROTTLE_CONFIG);

/** Test hook. */
export function resetMfaChallengeThrottle(): void {
  defaultThrottle.reset();
}

function throttleOf(deps: MfaDeps) {
  return deps.throttle ?? defaultThrottle;
}

const now = (deps: MfaDeps) => (deps.now ? deps.now() : Date.now());

// ─── Login-time decision ─────────────────────────────────────────────────────

export type LoginMfaOutcome =
  | { kind: "none" }
  | { kind: "enroll_grace" }
  | { kind: "enroll_required" }
  | { kind: "challenge"; preAuthToken: string; expiresInSeconds: number; methods: string[] };

/**
 * Called by `/auth/login` AFTER the password matched. Reads the user's MFA row
 * and returns what the login response must become. Never throws on a store
 * failure: a broken MFA table must not lock the platform out, so a read error
 * degrades to the pre-MFA behaviour (`none`) and is logged by the caller.
 */
export async function decideLoginMfa(
  deps: MfaDeps,
  user: { id: string; role: string },
): Promise<LoginMfaOutcome> {
  let enabled = false;
  try {
    const row = await deps.store.getMfa(user.id);
    enabled = Boolean(row?.enabledAt);
  } catch {
    enabled = false;
  }
  const gate: MfaLoginGate = decideMfaLoginGate({ role: user.role, mfaEnabled: enabled });
  if (gate.kind !== "challenge") return gate;
  const minted = mintPreAuthToken(user.id, now(deps));
  return { kind: "challenge", preAuthToken: minted.token, expiresInSeconds: minted.expiresInSeconds, methods: ["totp", "recovery_code"] };
}

// ─── Enrolment ───────────────────────────────────────────────────────────────

export type BeginEnrollmentResult =
  | { ok: true; secretBase32: string; manualKey: string; otpauthUri: string; issuer: string; account: string }
  | { ok: false; error: "already_enabled" | "user_not_found" };

export async function beginTotpEnrollment(deps: MfaDeps, userId: string): Promise<BeginEnrollmentResult> {
  const user = await deps.store.getUser(userId);
  if (!user) return { ok: false, error: "user_not_found" };
  const existing = await deps.store.getMfa(userId);
  if (existing?.enabledAt) return { ok: false, error: "already_enabled" };
  const secretBase32 = generateTotpSecret();
  await deps.store.upsertPending(userId, deps.encrypt(secretBase32));
  const issuer = deps.issuer || "Loopcom";
  return {
    ok: true,
    secretBase32,
    manualKey: formatSecretForDisplay(secretBase32),
    otpauthUri: buildOtpauthUri({ issuer, account: user.email, secretBase32 }),
    issuer,
    account: user.email,
  };
}

export type ConfirmEnrollmentResult =
  | { ok: true; recoveryCodes: string[]; enabledAt: Date }
  | { ok: false; status: 400 | 401 | 409 | 429; error: "no_pending_enrollment" | "already_enabled" | "invalid_code" | "RATE_LIMITED"; retryAfterSeconds?: number };

export async function confirmTotpEnrollment(
  deps: MfaDeps,
  input: { userId: string; code: unknown; sourceIp?: string | null },
): Promise<ConfirmEnrollmentResult> {
  const row = await deps.store.getMfa(input.userId);
  if (!row) return { ok: false, status: 400, error: "no_pending_enrollment" };
  if (row.enabledAt) return { ok: false, status: 409, error: "already_enabled" };

  const throttled = throttleOf(deps).evaluate(input.userId, input.sourceIp, now(deps));
  if (throttled.action !== "allow") return { ok: false, status: 429, error: "RATE_LIMITED", retryAfterSeconds: throttled.retryAfterSeconds };

  const secret = deps.decrypt(row.totpSecretEncrypted);
  const verified = verifyTotp({ secretBase32: secret, code: input.code, nowMs: now(deps), lastUsedCounter: null });
  if (!verified.ok) {
    throttleOf(deps).recordFailure(input.userId, input.sourceIp, now(deps));
    return { ok: false, status: 401, error: "invalid_code" };
  }
  throttleOf(deps).recordSuccess(input.userId);

  const enabledAt = new Date(now(deps));
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const hashes = await Promise.all(codes.map((c) => hashRecoveryCode(c, deps.recoveryHashRounds ?? RECOVERY_CODE_HASH_ROUNDS)));
  await deps.store.markEnabled(row.id, enabledAt, verified.counter);
  await deps.store.replaceRecoveryCodes(row.id, hashes);

  const user = await deps.store.getUser(input.userId);
  if (user) {
    await deps.audit({
      tenantId: user.tenantId,
      action: "MFA_TOTP_ENROLLED",
      entityType: "User",
      entityId: user.id,
      actorUserId: user.id,
      targetUserId: user.id,
      metadata: { method: "totp", recoveryCodesIssued: codes.length },
    }).catch(() => undefined);
  }
  return { ok: true, recoveryCodes: codes, enabledAt };
}

// ─── Second-factor verification (shared by challenge / disable / regenerate) ──

export type SecondFactorResult =
  | { ok: true; method: "totp" | "recovery_code"; recoveryCodesRemaining?: number }
  | { ok: false; reason: "invalid_code" | "RATE_LIMITED"; retryAfterSeconds?: number };

/**
 * One code, two possible shapes: six digits = TOTP, ten letters/digits =
 * recovery code. Both throttled through the same instance keyed by user id.
 * On a TOTP success the counter is persisted (replay guard); on a recovery
 * success the code is spent atomically and the use is audited.
 */
export async function verifySecondFactor(
  deps: MfaDeps,
  input: { user: MfaUserRow; mfa: MfaRow; code: unknown; sourceIp?: string | null; allowRecovery?: boolean },
): Promise<SecondFactorResult> {
  const t = throttleOf(deps);
  const decision: LoginThrottleDecision = t.evaluate(input.user.id, input.sourceIp, now(deps));
  if (decision.action !== "allow") return { ok: false, reason: "RATE_LIMITED", retryAfterSeconds: decision.retryAfterSeconds };

  const fail = (): SecondFactorResult => {
    t.recordFailure(input.user.id, input.sourceIp, now(deps));
    return { ok: false, reason: "invalid_code" };
  };

  if (looksLikeTotpCode(input.code)) {
    const secret = deps.decrypt(input.mfa.totpSecretEncrypted);
    const verified = verifyTotp({
      secretBase32: secret,
      code: input.code,
      nowMs: now(deps),
      lastUsedCounter: input.mfa.lastUsedCounter,
    });
    if (!verified.ok) return fail();
    await deps.store.setLastUsedCounter(input.mfa.id, verified.counter);
    t.recordSuccess(input.user.id);
    return { ok: true, method: "totp" };
  }

  if ((input.allowRecovery ?? true) && looksLikeRecoveryCode(input.code)) {
    const unused = await deps.store.listUnusedRecoveryCodes(input.mfa.id);
    for (const candidate of unused) {
      if (await recoveryCodeMatches(String(input.code), candidate.codeHash)) {
        const spent = await deps.store.consumeRecoveryCode(candidate.id, new Date(now(deps)));
        if (!spent) return fail(); // lost the race to a concurrent use — that code is gone
        t.recordSuccess(input.user.id);
        const remaining = await deps.store.countUnusedRecoveryCodes(input.mfa.id).catch(() => -1);
        await deps.audit({
          tenantId: input.user.tenantId,
          action: "MFA_RECOVERY_CODE_USED",
          entityType: "User",
          entityId: input.user.id,
          actorUserId: input.user.id,
          targetUserId: input.user.id,
          metadata: { recoveryCodesRemaining: remaining },
        }).catch(() => undefined);
        return { ok: true, method: "recovery_code", recoveryCodesRemaining: remaining };
      }
    }
    return fail();
  }

  return fail();
}

// ─── Challenge (the second half of login) ────────────────────────────────────

export type ChallengeResult =
  | { ok: true; user: MfaUserRow; method: "totp" | "recovery_code"; recoveryCodesRemaining?: number }
  | { ok: false; status: 401 | 429; error: "preauth_invalid" | "invalid_code" | "RATE_LIMITED"; retryAfterSeconds?: number };

export async function completeMfaChallenge(
  deps: MfaDeps,
  input: { preAuthToken: unknown; code: unknown; sourceIp?: string | null },
): Promise<ChallengeResult> {
  const pre = verifyPreAuthToken(input.preAuthToken, now(deps));
  if (!pre.ok) return { ok: false, status: 401, error: "preauth_invalid" };
  const user = await deps.store.getUser(pre.claims.sub);
  if (!user || String(user.status || "ACTIVE") === "DISABLED") return { ok: false, status: 401, error: "preauth_invalid" };
  const mfa = await deps.store.getMfa(user.id);
  // MFA switched off between password and code (admin reset) — the pre-auth
  // token is meaningless now; make them sign in again from the start.
  if (!mfa?.enabledAt) return { ok: false, status: 401, error: "preauth_invalid" };
  const verified = await verifySecondFactor(deps, { user, mfa, code: input.code, sourceIp: input.sourceIp });
  if (!verified.ok) {
    if (verified.reason === "RATE_LIMITED") return { ok: false, status: 429, error: "RATE_LIMITED", retryAfterSeconds: verified.retryAfterSeconds };
    return { ok: false, status: 401, error: "invalid_code" };
  }
  return { ok: true, user, method: verified.method, recoveryCodesRemaining: verified.recoveryCodesRemaining };
}

// ─── Status / disable / regenerate ───────────────────────────────────────────

export type MfaStatus = {
  enabled: boolean;
  enabledAt: string | null;
  /** A setup was started (secret issued) but never confirmed with a code. */
  pendingSetup: boolean;
  recoveryCodesRemaining: number;
  /** This person's role is on MFA_REQUIRED_ROLES. */
  required: boolean;
  /** required && !enabled — what the portal prompts on. */
  enrollmentRequired: boolean;
  methods: string[];
};

export async function getMfaStatus(deps: MfaDeps, user: { id: string; role: string }): Promise<MfaStatus> {
  const row = await deps.store.getMfa(user.id);
  const enabled = Boolean(row?.enabledAt);
  const required = isMfaRequiredForRole(user.role);
  return {
    enabled,
    enabledAt: row?.enabledAt ? row.enabledAt.toISOString() : null,
    pendingSetup: Boolean(row && !row.enabledAt),
    recoveryCodesRemaining: row?.enabledAt ? await deps.store.countUnusedRecoveryCodes(row.id) : 0,
    required,
    enrollmentRequired: required && !enabled,
    methods: enabled ? ["totp", "recovery_code"] : [],
  };
}

export type CodeGatedResult<T> =
  | ({ ok: true } & T)
  | { ok: false; status: 400 | 401 | 429; error: "not_enabled" | "invalid_code" | "RATE_LIMITED" | "user_not_found"; retryAfterSeconds?: number };

/** Self-service disable — needs a current TOTP code (a recovery code is accepted too: it is the lost-phone path). */
export async function disableMfaSelf(
  deps: MfaDeps,
  input: { userId: string; code: unknown; sourceIp?: string | null },
): Promise<CodeGatedResult<{}>> {
  const user = await deps.store.getUser(input.userId);
  if (!user) return { ok: false, status: 400, error: "user_not_found" };
  const mfa = await deps.store.getMfa(input.userId);
  if (!mfa?.enabledAt) return { ok: false, status: 400, error: "not_enabled" };
  const verified = await verifySecondFactor(deps, { user, mfa, code: input.code, sourceIp: input.sourceIp });
  if (!verified.ok) {
    if (verified.reason === "RATE_LIMITED") return { ok: false, status: 429, error: "RATE_LIMITED", retryAfterSeconds: verified.retryAfterSeconds };
    return { ok: false, status: 401, error: "invalid_code" };
  }
  await deps.store.deleteMfa(input.userId);
  await deps.audit({
    tenantId: user.tenantId,
    action: "MFA_DISABLED",
    entityType: "User",
    entityId: user.id,
    actorUserId: user.id,
    targetUserId: user.id,
    metadata: { by: "self", verifiedWith: verified.method },
  }).catch(() => undefined);
  return { ok: true };
}

/**
 * SUPER_ADMIN resets another person's MFA (lost phone AND lost recovery codes).
 * ⛔ The caller has already checked the role; this records who did it to whom.
 * Deliberately not tenant-scoped: SUPER_ADMIN is the platform operator, and the
 * audit row carries both ids.
 */
export async function disableMfaByAdmin(
  deps: MfaDeps,
  input: { actor: MfaUserRow; targetUserId: string; reason?: string | null },
): Promise<{ ok: true; wasEnabled: boolean } | { ok: false; status: 403 | 404; error: "forbidden" | "user_not_found" }> {
  if (String(input.actor.role) !== "SUPER_ADMIN") return { ok: false, status: 403, error: "forbidden" };
  const target = await deps.store.getUser(input.targetUserId);
  if (!target) return { ok: false, status: 404, error: "user_not_found" };
  const mfa = await deps.store.getMfa(target.id);
  const wasEnabled = Boolean(mfa?.enabledAt);
  if (mfa) await deps.store.deleteMfa(target.id);
  await deps.audit({
    tenantId: target.tenantId,
    action: "MFA_DISABLED_BY_ADMIN",
    entityType: "User",
    entityId: target.id,
    actorUserId: input.actor.id,
    targetUserId: target.id,
    metadata: { by: "admin", actorEmail: input.actor.email, wasEnabled, reason: input.reason || null },
  }).catch(() => undefined);
  return { ok: true, wasEnabled };
}

/** Fresh recovery codes; every old one is invalidated. Needs a current TOTP code. */
export async function regenerateRecoveryCodes(
  deps: MfaDeps,
  input: { userId: string; code: unknown; sourceIp?: string | null },
): Promise<CodeGatedResult<{ recoveryCodes: string[] }>> {
  const user = await deps.store.getUser(input.userId);
  if (!user) return { ok: false, status: 400, error: "user_not_found" };
  const mfa = await deps.store.getMfa(input.userId);
  if (!mfa?.enabledAt) return { ok: false, status: 400, error: "not_enabled" };
  // TOTP only — spending a recovery code to mint new recovery codes would let a
  // single leaked code become ten.
  const verified = await verifySecondFactor(deps, { user, mfa, code: input.code, sourceIp: input.sourceIp, allowRecovery: false });
  if (!verified.ok) {
    if (verified.reason === "RATE_LIMITED") return { ok: false, status: 429, error: "RATE_LIMITED", retryAfterSeconds: verified.retryAfterSeconds };
    return { ok: false, status: 401, error: "invalid_code" };
  }
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const hashes = await Promise.all(codes.map((c) => hashRecoveryCode(c, deps.recoveryHashRounds ?? RECOVERY_CODE_HASH_ROUNDS)));
  await deps.store.replaceRecoveryCodes(mfa.id, hashes);
  await deps.audit({
    tenantId: user.tenantId,
    action: "MFA_RECOVERY_CODES_REGENERATED",
    entityType: "User",
    entityId: user.id,
    actorUserId: user.id,
    targetUserId: user.id,
    metadata: { recoveryCodesIssued: codes.length },
  }).catch(() => undefined);
  return { ok: true, recoveryCodes: codes };
}

/** Exported so the routes file and tests can build the exact source key the throttle uses. */
export { normalizeSourceKey };
