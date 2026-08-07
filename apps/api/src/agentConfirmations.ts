/**
 * "The assistant asked, I said yes, and it happened." — the one place that
 * turns a thing the agent PREPARED into a thing that is actually true.
 *
 * ⛔ THE RULE THIS FILE EXISTS TO ENFORCE: the agent's say-so is never
 * sufficient. The agent writes a DRAFT `AgentAction` and nothing more.
 * Everything that matters is re-derived here, server-side, from the actor's
 * JWT and the stored params:
 *
 *   · the actor's role comes from the token, never the draft;
 *   · the params are re-hashed and matched against the stored `paramsHash`, so
 *     an approval for one thing can never be spent on another;
 *   · the capability re-authorises independently — a prompt-injected agent must
 *     achieve nothing but a REQUEST;
 *   · the approval is single-use, claimed atomically, so two clicks (or two
 *     tabs, or a replay) act once;
 *   · the password is checked against the ACTOR'S OWN hash, rate-limited and
 *     audited, because otherwise this is a password oracle.
 *
 * Capabilities plug in through `ConfirmCapability`. Adding one must never mean
 * restating a gate — if you find yourself re-checking a password or re-writing
 * the claim, you are in the wrong file.
 *
 * ⛔ TRANSACTIONAL vs NOT is a real distinction, not a style choice:
 *   · `transactional: true`  — the work is pure DB. Claim and work share one
 *     transaction, so a failure rolls the approval back and the customer can
 *     simply try again.
 *   · `transactional: false` — the work calls the PBX, or buys a number from
 *     VoIP.ms. Those cannot be rolled back, so the approval is claimed FIRST
 *     (status EXECUTING) and the outcome recorded after. A failure there leaves
 *     the approval spent on purpose: we must never re-run half a purchase.
 */
import type { PortalPermissionKey } from "@connect/shared";

export const CONFIRM_DRAFT_TTL_MS = 30 * 60 * 1000;
const PASSWORD_ATTEMPT_MAX = 5;
const PASSWORD_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/** Thrown inside the claim transaction when another request got there first. */
export const CLAIM_LOST = "agent_confirm_claim_lost";

export interface ConfirmActor {
  sub: string;
  tenantId: string;
  role: string;
  email?: string;
}

export interface ConfirmRefusal {
  status: number;
  error: string;
  message: string;
}

export interface ConfirmDeps {
  db: any;
  comparePassword(plain: string, hash: string): Promise<boolean>;
  grantablePermissions(
    actorRole: string,
    actorUserId: string,
    actorTenantId: string,
  ): Promise<Set<PortalPermissionKey>>;
  rateLimit(key: string, max: number, windowMs: number): boolean;
  audit(entry: {
    tenantId: string;
    action: string;
    entityType: string;
    entityId: string;
    actorUserId?: string;
    targetUserId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  /** Drives a real route in-process as a service principal (provisioning). */
  injectAsService?(
    method: "POST" | "GET",
    url: string,
    actor: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; body: any }>;
  /** Turns SMS on for a DID at the carrier. Best-effort by design. */
  enableSmsOnDid?(did: string): Promise<{ ok: boolean; detail: string }>;
  /**
   * Reads and re-checks the money. Injected rather than imported so the
   * capabilities can be tested without standing up the whole invoice engine —
   * and so there is exactly one place the real engine is wired in.
   */
  billing?: {
    snapshot(tenantId: string): Promise<any>;
    priceOf(snapshot: any, kind: string): { unitCents: number; charged: boolean; note: string };
    reconcile(input: {
      tenantId: string;
      kind: string;
      before: any;
      quotedUnitCents: number;
      actorUserId?: string | null;
    }): Promise<{ monthlyTotalCents: number; deltaCents: number; repairedManualOverride: boolean; warning: string | null }>;
    format(cents: number): string;
  };
  now?(): Date;
}

export interface CapabilityContext<P> {
  actor: ConfirmActor;
  /** The company the action belongs to — from the draft, never the actor. */
  tenantId: string;
  params: P;
  action: any;
}

export interface ConfirmDescription {
  /** The sentence the owner reads. Rebuilt from params — never stored prose. */
  summary: string;
  /** "$30.00 a month" — shown under the summary. Null when nothing is charged. */
  priceLine: string | null;
}

export interface ConfirmCapability<P = any> {
  id: string;
  /** Validate the stored params. Returning null means "not a usable draft". */
  parseParams(raw: unknown): P | null;
  /** MUST match, byte for byte, what the agent hashed when it prepared. */
  hashInput(tenantId: string, params: P): string;
  /** null = allowed. Runs before the password is even looked at. */
  authorize(deps: ConfirmDeps, ctx: CapabilityContext<P>): Promise<ConfirmRefusal | null>;
  /** null = do not offer this draft at all. */
  describe(deps: ConfirmDeps, ctx: Omit<CapabilityContext<P>, "action">): Promise<ConfirmDescription | null>;
  transactional: boolean;
  /** `tx` is the transaction client for transactional capabilities only. */
  execute(
    deps: ConfirmDeps,
    ctx: CapabilityContext<P>,
    tx: any,
  ): Promise<{ message: string; details?: Record<string, unknown> }>;
}

export type ConfirmResult =
  | { ok: true; status: 200; message: string; details?: Record<string, unknown> }
  | ({ ok: false } & ConfirmRefusal);

function fail(status: number, error: string, message: string): ConfirmResult {
  return { ok: false, status, error, message };
}

/** Never throws — an audit failure must not decide whether an action happens. */
async function safeAudit(deps: ConfirmDeps, entry: Parameters<ConfirmDeps["audit"]>[0]) {
  try {
    await deps.audit(entry);
  } catch {
    /* the decision stands on its own */
  }
}

export interface CapabilityRegistry {
  get(capabilityId: string): ConfirmCapability | undefined;
  ids(): string[];
}

export function buildCapabilityRegistry(list: ConfirmCapability[]): CapabilityRegistry {
  const byId = new Map(list.map((c) => [c.id, c]));
  return { get: (id) => byId.get(id), ids: () => [...byId.keys()] };
}

/**
 * The shared "not found" answer. Anything that isn't a live, unspent, in-scope
 * draft gets exactly this — a distinct error per reason would let someone probe
 * for other people's action ids.
 */
const NOT_FOUND_MESSAGE =
  "That confirmation is no longer available. Ask again in the chat and confirm the new one.";

/**
 * Load a draft and re-verify everything that does not need the password. Shared
 * by the apply path and the pending list, so the dialog can never be offered
 * something the apply path would refuse.
 */
export async function loadVerifiedDraft(
  deps: ConfirmDeps,
  registry: CapabilityRegistry,
  input: {
    actor: ConfirmActor;
    action: any;
    /** SUPER_ADMIN may act cross-tenant; everyone else is pinned to their own. */
    resolveTenantId(actorRole: string, actorTenantId: string, actionTenantId: string): string;
    hash(input: string): string;
    now: Date;
  },
): Promise<
  | { ok: true; capability: ConfirmCapability; params: any; tenantId: string }
  | { ok: false; refusal: ConfirmRefusal }
> {
  const { action, actor } = input;
  const notFound = { ok: false as const, refusal: { status: 404, error: "confirmation_not_found", message: NOT_FOUND_MESSAGE } };
  if (!action) return notFound;

  const capability = registry.get(action.capabilityId);
  if (!capability) return notFound;

  const scopeTenantId = input.resolveTenantId(actor.role, actor.tenantId, action.tenantId);
  if (!action.tenantId || action.tenantId !== scopeTenantId) return notFound;

  if (action.approvalConsumedAt) {
    return {
      ok: false,
      refusal: {
        status: 409,
        error: "already_used",
        message: "That confirmation was already used. Ask in the chat again if you need another change.",
      },
    };
  }
  if (action.status !== "DRAFT") {
    return { ok: false, refusal: { status: 409, error: "already_decided", message: "That request has already been dealt with." } };
  }
  if (action.createdAt && input.now.getTime() - new Date(action.createdAt).getTime() > CONFIRM_DRAFT_TTL_MS) {
    return {
      ok: false,
      refusal: {
        status: 409,
        error: "expired",
        message: "That confirmation has expired. Ask again in the chat and confirm the new one.",
      },
    };
  }

  const params = capability.parseParams(action.params);
  if (!params || !action.paramsHash) return notFound;

  // The params were edited after the owner was shown the summary: the sentence
  // they are reading no longer describes what would happen.
  if (input.hash(capability.hashInput(action.tenantId, params)) !== action.paramsHash) {
    await safeAudit(deps, {
      tenantId: action.tenantId,
      action: "AGENT_CONFIRM_PARAMS_TAMPERED",
      entityType: "AgentAction",
      entityId: action.id,
      actorUserId: actor.sub,
      metadata: { capabilityId: action.capabilityId },
    });
    return {
      ok: false,
      refusal: {
        status: 409,
        error: "params_tampered",
        message: "This request doesn't match what was approved, so nothing was changed. Please ask again in the chat.",
      },
    };
  }

  return { ok: true, capability, params, tenantId: action.tenantId };
}

/**
 * Apply exactly one confirmed action. Fastify-free on purpose: what has to be
 * proven is the ORDER of the gates and the atomicity of the claim, and neither
 * is visible from a route-level test.
 */
export async function applyConfirmedAction(
  deps: ConfirmDeps,
  registry: CapabilityRegistry,
  input: {
    actor: ConfirmActor;
    actionId: string;
    password: string;
    isTenantAdminOrAbove(role: string): boolean;
    resolveTenantId(actorRole: string, actorTenantId: string, actionTenantId: string): string;
    hash(input: string): string;
  },
): Promise<ConfirmResult> {
  const now = deps.now?.() ?? new Date();
  const { actor } = input;

  // 1 ─ Role gate, from the verified JWT.
  if (!input.isTenantAdminOrAbove(actor.role)) {
    return fail(403, "forbidden", "You need to be an account admin to confirm this.");
  }

  // 2/3 ─ Load, scope, freshness, and the params hash.
  const action = await deps.db.agentAction.findUnique({ where: { id: input.actionId } });
  const loaded = await loadVerifiedDraft(deps, registry, {
    actor,
    action,
    resolveTenantId: input.resolveTenantId,
    hash: input.hash,
    now,
  });
  if (!loaded.ok) return { ok: false, ...loaded.refusal };
  const { capability, params, tenantId } = loaded;
  const ctx: CapabilityContext<any> = { actor, tenantId, params, action };

  // 4/5 ─ The capability's own authority check. Never the agent's word.
  const refusal = await capability.authorize(deps, ctx);
  if (refusal) {
    await safeAudit(deps, {
      tenantId,
      action: "AGENT_CONFIRM_REFUSED",
      entityType: "AgentAction",
      entityId: action.id,
      actorUserId: actor.sub,
      metadata: { capabilityId: capability.id, reason: refusal.error },
    });
    return { ok: false, ...refusal };
  }

  // 6 ─ Password. Rate-limited BEFORE the compare and counted on every attempt,
  // so this cannot be walked through guess by guess.
  if (!deps.rateLimit(`agent-confirm-apply:${actor.sub}`, PASSWORD_ATTEMPT_MAX, PASSWORD_ATTEMPT_WINDOW_MS)) {
    await safeAudit(deps, {
      tenantId,
      action: "AGENT_CONFIRM_RATE_LIMITED",
      entityType: "AgentAction",
      entityId: action.id,
      actorUserId: actor.sub,
      metadata: { capabilityId: capability.id },
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
      tenantId,
      action: "AGENT_CONFIRM_PASSWORD_FAILED",
      entityType: "AgentAction",
      entityId: action.id,
      actorUserId: actor.sub,
      metadata: { capabilityId: capability.id },
    });
    return fail(401, "invalid_password", "That password didn't match. Nothing was changed.");
  }

  // 7/8 ─ Claim, then do the work.
  return capability.transactional
    ? applyTransactional(deps, capability, ctx, now)
    : applyExternal(deps, capability, ctx, now);
}

/** Claim and work share one transaction: a failure rolls the approval back. */
async function applyTransactional(
  deps: ConfirmDeps,
  capability: ConfirmCapability,
  ctx: CapabilityContext<any>,
  now: Date,
): Promise<ConfirmResult> {
  const run = () =>
    deps.db.$transaction(async (tx: any) => {
      const claimed = await claim(tx, ctx, now, "EXECUTED");
      if (!claimed) throw new Error(CLAIM_LOST);
      return capability.execute(deps, ctx, tx);
    });

  try {
    const out = await run();
    await recordApplied(deps, capability, ctx);
    return { ok: true, status: 200, message: out.message, details: out.details };
  } catch (first) {
    // Two confirmations touching the same row can collide on a unique index.
    // The loser's transaction rolled back entirely, so doing it again succeeds.
    // Only that collision is retried — a lost claim never is.
    const msg = String((first as Error)?.message ?? first);
    const collision = (first as { code?: string })?.code === "P2002" || msg.includes("Unique constraint");
    if (collision) {
      try {
        const out = await run();
        await recordApplied(deps, capability, ctx);
        return { ok: true, status: 200, message: out.message, details: out.details };
      } catch (second) {
        return failureToResult(deps, capability, ctx, second);
      }
    }
    return failureToResult(deps, capability, ctx, first);
  }
}

/**
 * The work reaches outside the database — the PBX, VoIP.ms, an email queue.
 * The approval is claimed FIRST and stays spent even on failure: re-running a
 * half-finished purchase is worse than not finishing it.
 */
async function applyExternal(
  deps: ConfirmDeps,
  capability: ConfirmCapability,
  ctx: CapabilityContext<any>,
  now: Date,
): Promise<ConfirmResult> {
  const claimed = await claim(deps.db, ctx, now, "EXECUTING");
  if (!claimed) {
    return fail(409, "already_used", "That confirmation was already used. Nothing was done twice.");
  }
  try {
    const out = await capability.execute(deps, ctx, null);
    await deps.db.agentAction
      .update({
        where: { id: ctx.action.id },
        data: { status: "EXECUTED", executedAt: now, resultSnapshot: (out.details ?? {}) as any },
      })
      .catch(() => undefined);
    await recordApplied(deps, capability, ctx);
    return { ok: true, status: 200, message: out.message, details: out.details };
  } catch (err) {
    const detail = String((err as Error)?.message ?? err).slice(0, 500);
    await deps.db.agentAction
      .update({ where: { id: ctx.action.id }, data: { status: "FAILED", errorDetail: detail } })
      .catch(() => undefined);
    await safeAudit(deps, {
      tenantId: ctx.tenantId,
      action: "AGENT_CONFIRM_APPLY_FAILED",
      entityType: "AgentAction",
      entityId: ctx.action.id,
      actorUserId: ctx.actor.sub,
      metadata: { capabilityId: capability.id, error: detail },
    });
    // ⛔ A capability that refused with its own message MUST keep it. Out here
    // the work is half-done by definition — "the extension exists but the
    // welcome email didn't go, finish it under Users" is the whole value of the
    // message, and a generic "something went wrong" hides a half-built state
    // that someone has to go and clean up.
    const tagged = (err as { confirmRefusal?: ConfirmRefusal })?.confirmRefusal;
    if (tagged) return { ok: false, ...tagged };
    return fail(
      500,
      "apply_failed",
      "Something went wrong part-way through. Nothing further was changed — please ask again in the chat so someone can check it.",
    );
  }
}

/** The atomic single-use claim. This is what makes two clicks act once. */
async function claim(client: any, ctx: CapabilityContext<any>, now: Date, status: "EXECUTED" | "EXECUTING") {
  const res = await client.agentAction.updateMany({
    where: { id: ctx.action.id, status: "DRAFT", approvalConsumedAt: null },
    data: {
      status,
      approvedBy: ctx.actor.sub,
      approvalConsumedAt: now,
      ...(status === "EXECUTED" ? { executedAt: now } : {}),
    },
  });
  return res.count === 1;
}

async function recordApplied(deps: ConfirmDeps, capability: ConfirmCapability, ctx: CapabilityContext<any>) {
  await safeAudit(deps, {
    tenantId: ctx.tenantId,
    action: "AGENT_CONFIRM_APPLIED",
    entityType: "AgentAction",
    entityId: ctx.action.id,
    actorUserId: ctx.actor.sub,
    metadata: { capabilityId: capability.id },
  });
}

async function failureToResult(
  deps: ConfirmDeps,
  capability: ConfirmCapability,
  ctx: CapabilityContext<any>,
  err: unknown,
): Promise<ConfirmResult> {
  const msg = String((err as Error)?.message ?? err);
  if (msg.includes(CLAIM_LOST)) {
    return fail(409, "already_used", "That confirmation was already used. Nothing was changed twice.");
  }
  // Capabilities raise their own refusals by throwing a tagged error.
  const tagged = (err as { confirmRefusal?: ConfirmRefusal })?.confirmRefusal;
  if (tagged) return { ok: false, ...tagged };
  await safeAudit(deps, {
    tenantId: ctx.tenantId,
    action: "AGENT_CONFIRM_APPLY_FAILED",
    entityType: "AgentAction",
    entityId: ctx.action.id,
    actorUserId: ctx.actor.sub,
    metadata: { capabilityId: capability.id, error: msg.slice(0, 300) },
  });
  return fail(500, "apply_failed", "Something went wrong applying that change. Nothing was changed — please try again.");
}

/** Capabilities throw this to refuse with a specific message mid-execute. */
export function refuse(status: number, error: string, message: string): Error {
  const e = new Error(`${error}: ${message}`) as Error & { confirmRefusal: ConfirmRefusal };
  e.confirmRefusal = { status, error, message };
  return e;
}

export interface PendingConfirmationView {
  id: string;
  capabilityId: string;
  summary: string;
  priceLine: string | null;
  createdAt: Date;
}

/**
 * Everything THIS person asked for in chat and hasn't confirmed yet.
 *
 * ⛔ The stored `summary` is deliberately never returned. The approval hash
 * binds the params, not that sentence — so the sentence is rebuilt from the
 * verified params the apply step will act on. What the owner reads is what
 * happens.
 */
export async function listPendingConfirmations(
  deps: ConfirmDeps,
  registry: CapabilityRegistry,
  input: {
    actor: ConfirmActor;
    resolveTenantId(actorRole: string, actorTenantId: string, actionTenantId: string): string;
    hash(input: string): string;
  },
): Promise<PendingConfirmationView[]> {
  const now = deps.now?.() ?? new Date();
  const rows = await deps.db.agentAction.findMany({
    where: {
      tenantId: input.actor.tenantId,
      capabilityId: { in: registry.ids() },
      status: "DRAFT",
      approvalConsumedAt: null,
      // Scoped to the requester — nobody is handed someone else's
      // half-finished request to rubber-stamp.
      requestedBy: input.actor.sub,
      createdAt: { gte: new Date(now.getTime() - CONFIRM_DRAFT_TTL_MS) },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  const out: PendingConfirmationView[] = [];
  for (const action of rows) {
    const loaded = await loadVerifiedDraft(deps, registry, {
      actor: input.actor,
      action,
      resolveTenantId: input.resolveTenantId,
      hash: input.hash,
      now,
    });
    if (!loaded.ok) continue;
    // Anything the apply path would refuse is never offered in the first place.
    if (await loaded.capability.authorize(deps, { actor: input.actor, tenantId: loaded.tenantId, params: loaded.params, action })) {
      continue;
    }
    const described = await loaded.capability
      .describe(deps, { actor: input.actor, tenantId: loaded.tenantId, params: loaded.params })
      .catch(() => null);
    if (!described) continue;
    out.push({
      id: action.id,
      capabilityId: action.capabilityId,
      summary: described.summary,
      priceLine: described.priceLine,
      createdAt: action.createdAt,
    });
  }
  return out;
}
