/**
 * "Give Yehuda permission to change the phone menus" — the APPLY half.
 *
 * The agent (`apps/agent/src/tools/permissionGrant.ts`) can only PREPARE: it
 * writes a DRAFT AgentAction and tells the owner a password prompt is coming.
 * Nothing is granted until this endpoint runs.
 *
 * ⛔ THE ONE RULE THIS FILE EXISTS TO ENFORCE: the agent's say-so is never
 * sufficient. Everything the draft asserts — who, which permission, which
 * company — is re-derived and re-authorised here from server-side state:
 *
 *   · the actor's role is read from the JWT, never the draft;
 *   · authority comes from `getGrantablePermissions()`, the SAME rule the
 *     portal's role editor uses — an actor can never hand out a permission they
 *     do not themselves hold;
 *   · the chat deny-list is re-checked here, not trusted from the agent;
 *   · the params are re-hashed and matched against the stored `paramsHash`, so
 *     an approval for one grant can never be spent on another;
 *   · the approval is single-use, claimed atomically, so two clicks (or two
 *     tabs, or a replay) grant once and only once;
 *   · the password is compared against the ACTOR'S OWN hash, and the attempt is
 *     rate-limited and audited — otherwise this is a password oracle.
 *
 * A prompt-injected agent that drafts something outrageous therefore achieves
 * nothing: the draft is a request, and every gate that matters is on this side.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@connect/db";
import {
  GRANT_CAPABILITY_ID,
  NEVER_GRANTABLE_BY_CHAT,
  CHAT_GRANTABLE_PERMISSIONS,
  resolveChatGrantablePermission,
  chatGrantRoleName,
  isPortalPermissionKey,
  type PortalPermissionKey,
} from "@connect/shared";
import { permissionParamsHash } from "@connect/shared/chatPermissionGrantHash";
import {
  getGrantablePermissions,
  isTenantAdminOrAbove,
  resolveTargetTenantId,
} from "./customRoleRoutes";

/** How long a prepared grant stays offerable before the owner must ask again. */
export const GRANT_DRAFT_TTL_MS = 30 * 60 * 1000;
/** Password attempts per actor. Low on purpose — this is a password check. */
const PASSWORD_ATTEMPT_MAX = 5;
const PASSWORD_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export interface GrantActor {
  sub: string;
  tenantId: string;
  role: string;
  email?: string;
}

export interface GrantApplyDeps {
  /** Prisma client, or anything with the same shape (tests pass a fake). */
  db: any;
  /** bcrypt.compare, injected so tests don't pay for real hashing. */
  comparePassword(plain: string, hash: string): Promise<boolean>;
  /** THE authority rule — `getGrantablePermissions` from customRoleRoutes. */
  grantablePermissions(
    actorRole: string,
    actorUserId: string,
    actorTenantId: string,
  ): Promise<Set<PortalPermissionKey>>;
  /** Returns false when the caller has spent their attempts. */
  rateLimit(key: string, max: number, windowMs: number): boolean;
  /** Audit sink. Must never throw into the caller. */
  audit(entry: {
    tenantId: string;
    action: string;
    entityType: string;
    entityId: string;
    actorUserId?: string;
    targetUserId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  now?(): Date;
}

export type GrantApplyResult =
  | {
      ok: true;
      status: 200;
      permission: PortalPermissionKey;
      permissionPlain: string;
      targetEmail: string;
      targetUserId: string;
      roleName: string;
      /** True when the person already had it — applied, but nothing changed. */
      alreadyHeld: boolean;
      message: string;
    }
  | { ok: false; status: number; error: string; message: string };

function fail(status: number, error: string, message: string): GrantApplyResult {
  return { ok: false, status, error, message };
}

/** Never throws — an audit failure must not decide whether a grant applies. */
async function safeAudit(deps: GrantApplyDeps, entry: Parameters<GrantApplyDeps["audit"]>[0]) {
  try {
    await deps.audit(entry);
  } catch {
    /* the grant decision stands on its own */
  }
}

/** Thrown inside the transaction when another request claimed the approval first. */
const CLAIM_LOST = "agent_grant_claim_lost";

/**
 * Apply exactly one prepared permission grant. Pure of Fastify on purpose: the
 * route below is a thin wrapper, and every stress case is driven against this.
 */
export async function applyAgentPermissionGrant(
  deps: GrantApplyDeps,
  input: { actor: GrantActor; actionId: string; password: string },
): Promise<GrantApplyResult> {
  const now = deps.now?.() ?? new Date();
  const { actor } = input;

  // 1 ─ Role gate. Read from the verified JWT; the draft has no say in this.
  if (!isTenantAdminOrAbove(actor.role)) {
    return fail(403, "forbidden", "You need to be an account admin to change someone's permissions.");
  }

  // 2 ─ Load the draft. Anything that isn't a live, unspent, in-scope permission
  // grant answers the same "not found" — a distinct error per reason would let
  // someone probe for other people's action ids.
  const action = await deps.db.agentAction.findUnique({ where: { id: input.actionId } });
  const notFound = fail(404, "grant_not_found", "That confirmation is no longer available. Ask again in the chat and confirm the new one.");
  if (!action || action.capabilityId !== GRANT_CAPABILITY_ID) return notFound;

  // SUPER_ADMIN may cross tenants; TENANT_ADMIN's own tenant always wins. Same
  // helper the role editor uses, so the two can't diverge.
  const scopeTenantId = resolveTargetTenantId(actor.role, actor.tenantId, action.tenantId);
  if (!action.tenantId || action.tenantId !== scopeTenantId) return notFound;

  if (action.approvalConsumedAt) {
    return fail(409, "already_used", "That confirmation was already used. Ask in the chat again if you need another change.");
  }
  if (action.status !== "DRAFT") {
    return fail(409, "already_decided", "That request has already been dealt with.");
  }
  if (action.createdAt && now.getTime() - new Date(action.createdAt).getTime() > GRANT_DRAFT_TTL_MS) {
    return fail(409, "expired", "That confirmation has expired. Ask again in the chat and confirm the new one.");
  }

  // 3 ─ Re-hash the STORED params. A mismatch means the row was edited after it
  // was prepared: the summary the owner is reading no longer describes the
  // change that would be applied. Refuse loudly and record it.
  const params = (action.params ?? {}) as Record<string, unknown>;
  const targetUserId = typeof params.targetUserId === "string" ? params.targetUserId : "";
  const permissionRaw = typeof params.permission === "string" ? params.permission : "";
  if (!targetUserId || !permissionRaw || !action.paramsHash) return notFound;

  const expectedHash = permissionParamsHash(action.tenantId, targetUserId, permissionRaw);
  if (expectedHash !== action.paramsHash) {
    await safeAudit(deps, {
      tenantId: action.tenantId,
      action: "AGENT_GRANT_PARAMS_TAMPERED",
      entityType: "AgentAction",
      entityId: action.id,
      actorUserId: actor.sub,
      targetUserId,
      metadata: { permission: permissionRaw },
    });
    return fail(409, "params_tampered", "This request doesn't match what was approved, so nothing was changed. Please ask again in the chat.");
  }

  // 4/5 ─ The permission itself, checked three ways, none of them the agent's
  // word: it must be a real key, it must be one chat is allowed to hand out,
  // and it must be one THIS actor personally holds.
  if (!isPortalPermissionKey(permissionRaw)) return notFound;
  const permission = permissionRaw as PortalPermissionKey;

  if (NEVER_GRANTABLE_BY_CHAT.has(permission) || !resolveChatGrantablePermission(permission)) {
    await safeAudit(deps, {
      tenantId: action.tenantId,
      action: "AGENT_GRANT_REFUSED_NOT_BY_CHAT",
      entityType: "AgentAction",
      entityId: action.id,
      actorUserId: actor.sub,
      targetUserId,
      metadata: { permission },
    });
    return fail(403, "not_grantable_by_chat", "That permission has to be changed in the portal, not by chat.");
  }

  const grantable = await deps.grantablePermissions(actor.role, actor.sub, actor.tenantId);
  if (!grantable.has(permission)) {
    await safeAudit(deps, {
      tenantId: action.tenantId,
      action: "AGENT_GRANT_REFUSED_NOT_YOURS",
      entityType: "AgentAction",
      entityId: action.id,
      actorUserId: actor.sub,
      targetUserId,
      metadata: { permission },
    });
    return fail(403, "not_yours_to_grant", "You can't hand out a permission you don't have yourself.");
  }

  // 6 ─ Password. Rate-limited BEFORE the compare and counted on every attempt,
  // so this can't be walked through guess by guess.
  if (!deps.rateLimit(`agent-grant-apply:${actor.sub}`, PASSWORD_ATTEMPT_MAX, PASSWORD_ATTEMPT_WINDOW_MS)) {
    await safeAudit(deps, {
      tenantId: action.tenantId,
      action: "AGENT_GRANT_RATE_LIMITED",
      entityType: "AgentAction",
      entityId: action.id,
      actorUserId: actor.sub,
      metadata: { permission },
    });
    return fail(429, "rate_limited", "Too many tries. Wait a few minutes and try again.");
  }

  const actorUser = await deps.db.user.findUnique({
    where: { id: actor.sub },
    select: { id: true, passwordHash: true, status: true },
  });
  if (!actorUser?.passwordHash || actorUser.status === "DISABLED") {
    return fail(403, "forbidden", "Your account can't confirm this change.");
  }
  if (!(await deps.comparePassword(input.password, actorUser.passwordHash))) {
    await safeAudit(deps, {
      tenantId: action.tenantId,
      action: "AGENT_GRANT_PASSWORD_FAILED",
      entityType: "AgentAction",
      entityId: action.id,
      actorUserId: actor.sub,
      targetUserId,
      metadata: { permission },
    });
    return fail(401, "invalid_password", "That password didn't match. Nothing was changed.");
  }

  // 7/8 ─ Apply. The approval is claimed FIRST inside the transaction, so a
  // second request racing this one finds nothing left to claim and the whole
  // grant rolls back rather than applying twice.
  let outcome: { targetEmail: string; roleName: string; alreadyHeld: boolean };
  const runGrant = () =>
    deps.db.$transaction(async (tx: any) => {
      // The draft is minutes old — the person may have been deleted, disabled,
      // or moved to another company since. Re-read them now.
      const target = await tx.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, email: true, tenantId: true, status: true },
      });
      if (!target || target.tenantId !== action.tenantId || target.status === "DISABLED") {
        throw new Error("target_unavailable");
      }

      const claimed = await tx.agentAction.updateMany({
        where: { id: action.id, status: "DRAFT", approvalConsumedAt: null },
        data: {
          status: "EXECUTED",
          approvedBy: actor.sub,
          executedAt: now,
          approvalConsumedAt: now,
        },
      });
      if (claimed.count !== 1) throw new Error(CLAIM_LOST);

      // One visible, revocable role per recipient — not a permission sprinkled
      // somewhere nobody will ever find it again.
      const roleName = chatGrantRoleName(target.email, target.id);
      const role = await tx.customRole.upsert({
        where: { tenantId_name: { tenantId: action.tenantId, name: roleName } },
        create: {
          tenantId: action.tenantId,
          name: roleName,
          description: "Permissions granted through the assistant chat. Safe to edit or delete here.",
          active: true,
          // Deliberately empty: the add-step below is the ONE place a permission
          // enters the role, so "did they already have this?" is answered the
          // same way whether the role is brand new or years old.
          permissions: [],
          createdByUserId: actor.sub,
          updatedByUserId: actor.sub,
        },
        update: { active: true, updatedByUserId: actor.sub },
        select: { id: true, permissions: true },
      });

      const existing = Array.isArray(role.permissions)
        ? role.permissions.map((p: unknown) => String(p)).filter(isPortalPermissionKey)
        : [];
      const alreadyHeld = existing.includes(permission);
      if (!alreadyHeld) {
        await tx.customRole.update({
          where: { id: role.id },
          data: { permissions: [...existing, permission], updatedByUserId: actor.sub },
        });
      }

      await tx.userCustomRole.upsert({
        where: { userId_customRoleId: { userId: target.id, customRoleId: role.id } },
        create: {
          tenantId: action.tenantId,
          userId: target.id,
          customRoleId: role.id,
          assignedByUserId: actor.sub,
        },
        update: {},
      });

      return { targetEmail: target.email as string, roleName, alreadyHeld };
    });

  try {
    outcome = await runGrant();
  } catch (first) {
    // Two grants for the SAME person, confirmed at the same moment, can both
    // try to create that person's role. One loses on the unique index; its
    // whole transaction rolled back, so simply doing it again now finds the
    // role and succeeds. Only this collision is retried — a lost claim or a
    // vanished target must NOT be.
    const firstMsg = String((first as Error)?.message ?? first);
    const isUniqueCollision =
      (first as { code?: string })?.code === "P2002" || firstMsg.includes("Unique constraint");
    if (!isUniqueCollision) {
      return grantFailure(deps, first, { action, actor, permission, targetUserId });
    }
    try {
      outcome = await runGrant();
    } catch (second) {
      return grantFailure(deps, second, { action, actor, permission, targetUserId });
    }
  }

  const plain = resolveChatGrantablePermission(permission)?.plain ?? permission;
  await safeAudit(deps, {
    tenantId: action.tenantId,
    action: "AGENT_GRANT_APPLIED",
    entityType: "AgentAction",
    entityId: action.id,
    actorUserId: actor.sub,
    targetUserId,
    metadata: { permission, roleName: outcome.roleName, alreadyHeld: outcome.alreadyHeld },
  });

  return {
    ok: true,
    status: 200,
    permission,
    permissionPlain: plain,
    targetEmail: outcome.targetEmail,
    targetUserId,
    roleName: outcome.roleName,
    alreadyHeld: outcome.alreadyHeld,
    message: outcome.alreadyHeld
      ? `${outcome.targetEmail} could already ${plain}, so nothing changed.`
      : `Done — ${outcome.targetEmail} can now ${plain}. You can undo this any time under Roles, in "${outcome.roleName}".`,
  };
}

/** Turns a failed apply transaction into the right refusal, and records it. */
async function grantFailure(
  deps: GrantApplyDeps,
  err: unknown,
  ctx: { action: any; actor: GrantActor; permission: PortalPermissionKey; targetUserId: string },
): Promise<GrantApplyResult> {
  const { action, actor, permission, targetUserId } = ctx;
  const msg = String((err as Error)?.message ?? err);
  if (msg.includes(CLAIM_LOST)) {
    return fail(409, "already_used", "That confirmation was already used. Nothing was changed twice.");
  }
  if (msg.includes("target_unavailable")) {
    return fail(409, "target_unavailable", "That person is no longer on this account, so nothing was changed.");
  }
  await safeAudit(deps, {
    tenantId: action.tenantId,
    action: "AGENT_GRANT_APPLY_FAILED",
    entityType: "AgentAction",
    entityId: action.id,
    actorUserId: actor.sub,
    targetUserId,
    metadata: { permission, error: msg.slice(0, 300) },
  });
  return fail(500, "apply_failed", "Something went wrong applying that change. Nothing was changed — please try again.");
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function getUser(req: any): GrantActor {
  return req.user as GrantActor;
}

export interface RegisterAgentGrantRoutesDeps {
  rateLimit: GrantApplyDeps["rateLimit"];
  audit: GrantApplyDeps["audit"];
}

export async function registerAgentGrantRoutes(
  app: FastifyInstance,
  deps: RegisterAgentGrantRoutesDeps,
) {
  const applyDeps: GrantApplyDeps = {
    db,
    comparePassword: (plain, hash) => bcrypt.compare(plain, hash),
    grantablePermissions: getGrantablePermissions,
    rateLimit: deps.rateLimit,
    audit: deps.audit,
  };

  /**
   * What the portal polls for: grants THIS person prepared in chat and hasn't
   * confirmed yet. Scoped to the requester — an admin is never shown someone
   * else's half-finished request to rubber-stamp.
   */
  app.get("/admin/agent-grants/pending", async (req, reply) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) return reply.code(403).send({ error: "forbidden" });
    const rows = await db.agentAction.findMany({
      where: {
        tenantId: actor.tenantId,
        capabilityId: GRANT_CAPABILITY_ID,
        status: "DRAFT",
        approvalConsumedAt: null,
        requestedBy: actor.sub,
        createdAt: { gte: new Date(Date.now() - GRANT_DRAFT_TTL_MS) },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, summary: true, params: true, createdAt: true },
    });
    return {
      grants: rows.map((r) => {
        const p = (r.params ?? {}) as Record<string, unknown>;
        const key = typeof p.permission === "string" ? p.permission : "";
        return {
          id: r.id,
          summary: r.summary,
          permission: key,
          permissionPlain: resolveChatGrantablePermission(key)?.plain ?? key,
          targetEmail: typeof p.targetEmail === "string" ? p.targetEmail : "",
          createdAt: r.createdAt,
        };
      }),
    };
  });

  /**
   * Apply one prepared grant. ⛔ The password arrives HERE and nowhere else —
   * never at `/agent-api/*`, so it never passes through a language model, a
   * conversation transcript, or the agent's audit log.
   */
  app.post("/admin/agent-grants/:actionId/apply", async (req, reply) => {
    const actor = getUser(req);
    const params = z.object({ actionId: z.string().min(1).max(64) }).safeParse(req.params);
    const body = z.object({ password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: "grant_not_found" });
    if (!body.success) {
      return reply.code(400).send({ error: "password_required", message: "Enter your account password to confirm." });
    }

    const result = await applyAgentPermissionGrant(applyDeps, {
      actor,
      actionId: params.data.actionId,
      password: body.data.password,
    });
    if (!result.ok) {
      return reply.code(result.status).send({ error: result.error, message: result.message });
    }
    return reply.code(200).send({
      ok: true,
      permission: result.permission,
      permissionPlain: result.permissionPlain,
      targetEmail: result.targetEmail,
      roleName: result.roleName,
      alreadyHeld: result.alreadyHeld,
      message: result.message,
    });
  });

  /** "No, don't." Retires the draft so it stops being offered. No password: a
   *  cancellation can only ever make the account less permissive. */
  app.post("/admin/agent-grants/:actionId/dismiss", async (req, reply) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) return reply.code(403).send({ error: "forbidden" });
    const params = z.object({ actionId: z.string().min(1).max(64) }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "grant_not_found" });
    const done = await db.agentAction.updateMany({
      where: {
        id: params.data.actionId,
        tenantId: actor.tenantId,
        capabilityId: GRANT_CAPABILITY_ID,
        status: "DRAFT",
        approvalConsumedAt: null,
        requestedBy: actor.sub,
      },
      data: { status: "DENIED", deniedReason: "dismissed_by_requester" },
    });
    return { ok: true, dismissed: done.count };
  });
}

/** Exported for the tests: the plain-English label the dialog falls back to. */
export const GRANT_PERMISSION_LABELS = CHAT_GRANTABLE_PERMISSIONS;
