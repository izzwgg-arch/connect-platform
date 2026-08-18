/**
 * MFA routes. Thin: every decision lives in `mfaService.ts` (pure, tested with
 * a fake store); this file wires Prisma, the credential envelope, the audit
 * helper and the session minter in, and maps results to HTTP.
 *
 * Route map — ALL under the ordinary JWT hook except the one marked PUBLIC:
 *
 *   GET  /auth/mfa/status                       — enabled? required? codes left?
 *   POST /auth/mfa/totp/setup                   — start: secret + otpauth URI (shown once)
 *   POST /auth/mfa/totp/verify   { code }       — confirm first code → enabled + recovery codes (shown once)
 *   POST /auth/mfa/challenge     { preAuthToken, code }   ⛔ PUBLIC (JWT bypass list) —
 *                                                 second half of login; answers the normal login body
 *   POST /auth/mfa/disable       { code }       — self, needs a current code
 *   POST /auth/mfa/recovery-codes/regenerate { code } — needs a current TOTP code
 *   POST /admin/users/:id/mfa/disable { reason? } — SUPER_ADMIN only, audited
 *
 * ⛔ `/auth/mfa/challenge` is the ONLY route here that skips the JWT hook, and
 * it authenticates the pre-auth token itself. Nothing else under /auth/mfa/ may
 * be added to `jwtPublicRouteBypass.ts`. `mfa.test.ts` pins that.
 *
 * ⛔ Every code check is throttled inside the service (five wrong codes → ten
 * minutes), and every throttled answer is a 429 with Retry-After, never a 401 —
 * so a person can tell "wrong code" from "slow down".
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { decryptJson, encryptJson, hasCredentialsMasterKey } from "@connect/security";
import { clientIpFromForwardedFor } from "../loginThrottle";
import {
  beginTotpEnrollment,
  completeMfaChallenge,
  confirmTotpEnrollment,
  disableMfaByAdmin,
  disableMfaSelf,
  getMfaStatus,
  regenerateRecoveryCodes,
  type MfaAudit,
  type MfaDeps,
  type MfaRow,
  type MfaStore,
  type MfaUserRow,
} from "./mfaService";

type JwtUser = { sub: string; tenantId: string; email: string; role: string };
const getUser = (req: any): JwtUser => req.user as JwtUser;

/**
 * The Prisma-backed store. `db.userMfa` / `db.userMfaRecoveryCode` are the
 * generated accessors for the two models added in
 * `20260818120000_user_mfa_totp` — model `UserMfa` → `userMfa`.
 */
export function prismaMfaStore(client: any = db): MfaStore {
  const toRow = (r: any): MfaRow => ({
    id: r.id,
    userId: r.userId,
    totpSecretEncrypted: r.totpSecretEncrypted,
    enabledAt: r.enabledAt ?? null,
    lastUsedCounter: r.lastUsedCounter ?? null,
  });
  return {
    async getUser(userId) {
      const u = await client.user.findUnique({
        where: { id: userId },
        select: { id: true, tenantId: true, email: true, role: true, status: true },
      });
      return u ? ({ id: u.id, tenantId: u.tenantId, email: u.email, role: String(u.role), status: u.status ? String(u.status) : null } as MfaUserRow) : null;
    },
    async getMfa(userId) {
      const r = await client.userMfa.findUnique({ where: { userId } });
      return r ? toRow(r) : null;
    },
    async upsertPending(userId, totpSecretEncrypted) {
      const r = await client.userMfa.upsert({
        where: { userId },
        create: { userId, totpSecretEncrypted, enabledAt: null, lastUsedCounter: null },
        update: { totpSecretEncrypted, enabledAt: null, lastUsedCounter: null },
      });
      // A re-run of setup discards any codes a previous, never-confirmed run left.
      await client.userMfaRecoveryCode.deleteMany({ where: { userMfaId: r.id } });
      return toRow(r);
    },
    async markEnabled(mfaId, enabledAt, lastUsedCounter) {
      await client.userMfa.update({ where: { id: mfaId }, data: { enabledAt, lastUsedCounter } });
    },
    async setLastUsedCounter(mfaId, counter) {
      await client.userMfa.update({ where: { id: mfaId }, data: { lastUsedCounter: counter } });
    },
    async replaceRecoveryCodes(mfaId, codeHashes) {
      await client.$transaction([
        client.userMfaRecoveryCode.deleteMany({ where: { userMfaId: mfaId } }),
        client.userMfaRecoveryCode.createMany({ data: codeHashes.map((codeHash) => ({ userMfaId: mfaId, codeHash })) }),
      ]);
    },
    async listUnusedRecoveryCodes(mfaId) {
      const rows = await client.userMfaRecoveryCode.findMany({
        where: { userMfaId: mfaId, usedAt: null },
        select: { id: true, codeHash: true },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((r: any) => ({ id: r.id, codeHash: r.codeHash }));
    },
    async countUnusedRecoveryCodes(mfaId) {
      return client.userMfaRecoveryCode.count({ where: { userMfaId: mfaId, usedAt: null } });
    },
    async consumeRecoveryCode(codeId, usedAt) {
      const res = await client.userMfaRecoveryCode.updateMany({ where: { id: codeId, usedAt: null }, data: { usedAt } });
      return res.count === 1;
    },
    async deleteMfa(userId) {
      // Cascade removes the recovery codes.
      await client.userMfa.deleteMany({ where: { userId } });
    },
  };
}

export type MfaRouteDeps = {
  audit: MfaAudit;
  /**
   * Mint the SAME login response `/auth/login` returns for a user who has no
   * MFA — `{ token, portalPermissionSet? }`. Injected so there is exactly one
   * place the session claim shape lives (server.ts `issueLoginSession`).
   */
  issueSession: (userId: string) => Promise<Record<string, unknown>>;
  /** Overrides for tests. */
  service?: Partial<MfaDeps>;
  /** Whether the envelope key exists (default: CREDENTIALS_MASTER_KEY is set). Tests inject. */
  cryptoReady?: () => boolean;
};

export function buildMfaDeps(routeDeps: MfaRouteDeps): MfaDeps {
  return {
    store: prismaMfaStore(),
    encrypt: (plain) => encryptJson({ s: plain }),
    decrypt: (encoded) => String(decryptJson<{ s: string }>(encoded)?.s ?? ""),
    audit: routeDeps.audit,
    issuer: process.env.MFA_ISSUER?.trim() || "Loopcom",
    ...(routeDeps.service ?? {}),
  };
}

export async function registerMfaRoutes(app: FastifyInstance, routeDeps: MfaRouteDeps): Promise<void> {
  const deps = buildMfaDeps(routeDeps);
  // Secret material may only be handled when the envelope key exists.
  const credentialCryptoReady = routeDeps.cryptoReady ?? hasCredentialsMasterKey;
  const sourceIp = (req: any) => clientIpFromForwardedFor(req.headers?.["x-forwarded-for"]);
  const codeBody = z.object({ code: z.union([z.string(), z.number()]).transform((v) => String(v)) });

  app.get("/auth/mfa/status", async (req: any) => {
    const user = getUser(req);
    return getMfaStatus(deps, { id: user.sub, role: user.role });
  });

  app.post("/auth/mfa/totp/setup", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!credentialCryptoReady()) {
      return reply.status(503).send({
        error: "mfa_unavailable",
        message: "This server can't store a two-step secret securely yet (CREDENTIALS_MASTER_KEY isn't set). Nothing was changed.",
      });
    }
    const res = await beginTotpEnrollment(deps, user.sub);
    if (!res.ok) {
      const status = res.error === "already_enabled" ? 409 : 404;
      return reply.status(status).send({
        error: res.error,
        message: res.error === "already_enabled"
          ? "Two-step verification is already turned on for this account. Turn it off first to set it up again."
          : "Account not found.",
      });
    }
    return {
      secretBase32: res.secretBase32,
      manualKey: res.manualKey,
      otpauthUri: res.otpauthUri,
      issuer: res.issuer,
      account: res.account,
      digits: 6,
      periodSeconds: 30,
    };
  });

  app.post("/auth/mfa/totp/verify", async (req: any, reply: any) => {
    const user = getUser(req);
    const parsed = codeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", message: "Enter the 6-digit code from your authenticator app." });
    if (!credentialCryptoReady()) return reply.status(503).send({ error: "mfa_unavailable" });
    const res = await confirmTotpEnrollment(deps, { userId: user.sub, code: parsed.data.code, sourceIp: sourceIp(req) });
    if (!res.ok) {
      if (res.status === 429) reply.header("Retry-After", String(res.retryAfterSeconds ?? 600));
      return reply.status(res.status).send({
        error: res.error,
        message:
          res.error === "invalid_code" ? "That code didn't match. Codes change every 30 seconds — try the current one."
          : res.error === "no_pending_enrollment" ? "Start the setup again to get a new QR code."
          : res.error === "already_enabled" ? "Two-step verification is already on."
          : "Too many wrong codes. Wait a few minutes and try again.",
      });
    }
    return { enabled: true, enabledAt: res.enabledAt.toISOString(), recoveryCodes: res.recoveryCodes };
  });

  // ⛔ PUBLIC — on the JWT bypass list. Authenticates the pre-auth token itself.
  app.post("/auth/mfa/challenge", async (req: any, reply: any) => {
    const parsed = z.object({
      preAuthToken: z.string().min(20),
      code: z.union([z.string(), z.number()]).transform((v) => String(v)),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const res = await completeMfaChallenge(deps, {
      preAuthToken: parsed.data.preAuthToken,
      code: parsed.data.code,
      sourceIp: sourceIp(req),
    });
    if (!res.ok) {
      if (res.status === 429) {
        reply.header("Retry-After", String(res.retryAfterSeconds ?? 600));
        return reply.status(429).send({ error: "RATE_LIMITED" });
      }
      return reply.status(401).send({ error: res.error });
    }
    const body = await routeDeps.issueSession(res.user.id);
    return {
      ...body,
      mfaMethod: res.method,
      ...(res.method === "recovery_code" && typeof res.recoveryCodesRemaining === "number"
        ? { recoveryCodesRemaining: res.recoveryCodesRemaining }
        : {}),
    };
  });

  app.post("/auth/mfa/disable", async (req: any, reply: any) => {
    const user = getUser(req);
    const parsed = codeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", message: "Enter a current code to turn two-step verification off." });
    const res = await disableMfaSelf(deps, { userId: user.sub, code: parsed.data.code, sourceIp: sourceIp(req) });
    if (!res.ok) {
      if (res.status === 429) reply.header("Retry-After", String(res.retryAfterSeconds ?? 600));
      return reply.status(res.status).send({
        error: res.error,
        message: res.error === "invalid_code" ? "That code didn't match." : res.error === "not_enabled" ? "Two-step verification isn't on." : "Too many wrong codes. Wait a few minutes.",
      });
    }
    return { ok: true, enabled: false };
  });

  app.post("/auth/mfa/recovery-codes/regenerate", async (req: any, reply: any) => {
    const user = getUser(req);
    const parsed = codeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", message: "Enter the 6-digit code from your authenticator app." });
    const res = await regenerateRecoveryCodes(deps, { userId: user.sub, code: parsed.data.code, sourceIp: sourceIp(req) });
    if (!res.ok) {
      if (res.status === 429) reply.header("Retry-After", String(res.retryAfterSeconds ?? 600));
      return reply.status(res.status).send({
        error: res.error,
        message: res.error === "invalid_code" ? "That code didn't match. Use the current 6-digit code from your app (not a recovery code)." : res.error === "not_enabled" ? "Two-step verification isn't on." : "Too many wrong codes. Wait a few minutes.",
      });
    }
    return { recoveryCodes: res.recoveryCodes };
  });

  // SUPER_ADMIN resets a person who lost both their phone and their codes.
  // Under the /admin/users prefix so the portal-permission gate
  // (`can_view_admin_users`) runs too; the role check is on top of it.
  app.post("/admin/users/:id/mfa/disable", async (req: any, reply: any) => {
    const actor = getUser(req);
    if (String(actor?.role) !== "SUPER_ADMIN") return reply.status(403).send({ error: "forbidden" });
    const targetUserId = String(req.params?.id || "").trim();
    if (!targetUserId) return reply.status(400).send({ error: "invalid_request" });
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null;
    const res = await disableMfaByAdmin(deps, {
      actor: { id: actor.sub, tenantId: actor.tenantId, email: actor.email, role: actor.role },
      targetUserId,
      reason,
    });
    if (!res.ok) return reply.status(res.status).send({ error: res.error });
    return { ok: true, wasEnabled: res.wasEnabled };
  });
}
