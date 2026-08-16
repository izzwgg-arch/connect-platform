/**
 * The routes behind "the assistant asked, I said yes."
 *
 * The agent can only ever PREPARE: it writes a DRAFT `AgentAction` and tells
 * the customer a password prompt is coming. These routes are the only way a
 * draft becomes real, and every gate lives in `agentConfirmations.ts` — one
 * copy, shared by every capability, so adding a capability can never mean
 * restating a security rule.
 *
 * ⛔ The password arrives HERE and nowhere else. It must never be sent to
 * `/agent-api/*` — anything the agent receives passes through a language model,
 * a conversation transcript and an audit log.
 *
 * Capabilities live in `agentProvisioning/`. Registering a new one is the whole
 * job; the routes below do not change.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@connect/db";
import {
  applyConfirmedAction,
  listPendingConfirmations,
  buildCapabilityRegistry,
  CONFIRM_DRAFT_TTL_MS,
  type ConfirmDeps,
  type ConfirmActor,
  type ConfirmResult,
  type PendingConfirmationView,
} from "./agentConfirmations";
import { FIX_CODE_TTL_MS } from "./agentFixPolicy";
import { refreshTenantFactsDoc } from "./agentTenantFacts";
import { permissionGrantCapability } from "./agentProvisioning/permissionGrantCapability";
import { addExtensionCapability } from "./agentProvisioning/addExtensionCapability";
import { enableSmsCapability } from "./agentProvisioning/enableSmsCapability";
import { addPhoneNumberCapability } from "./agentProvisioning/addPhoneNumberCapability";
import { defaultBillingDeps } from "./agentProvisioning/billingReconcile";
import {
  getGrantablePermissions,
  isTenantAdminOrAbove,
  resolveTargetTenantId,
} from "./customRoleRoutes";

/** Kept under the old name — several callers and tests refer to it. */
export const GRANT_DRAFT_TTL_MS = CONFIRM_DRAFT_TTL_MS;

export const confirmCapabilityRegistry = buildCapabilityRegistry([
  permissionGrantCapability,
  addExtensionCapability,
  enableSmsCapability,
  addPhoneNumberCapability,
]);

/** The approval hash the agent wrote, recomputed here. */
function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export type { ConfirmActor as GrantActor, ConfirmDeps as GrantApplyDeps } from "./agentConfirmations";

/**
 * Apply one confirmed action. Exported (rather than inlined in the route) so
 * every stress case can be driven against the real ordering and atomicity,
 * which a route-level test cannot see.
 */
export function applyAgentPermissionGrant(
  deps: ConfirmDeps,
  input: { actor: ConfirmActor; actionId: string; password: string },
): Promise<ConfirmResult> {
  return applyConfirmedAction(deps, confirmCapabilityRegistry, {
    ...input,
    isTenantAdminOrAbove,
    resolveTenantId: resolveTargetTenantId,
    hash,
  });
}

/**
 * Apply one action approved by TEXT rather than by password ("Fix it!").
 *
 * ⛔ The caller (`agentFixByText.ts`) must already have proven the sender and
 * atomically claimed the one-time code. This wrapper exists so that fact is
 * stated in exactly one place and so the SMS path cannot drift away from the
 * password path: both go through `applyConfirmedAction` and therefore through
 * the same role gate, tenant scoping, params-hash check, capability
 * authorisation, atomic claim and audit.
 *
 * The deps bag is assembled lazily by `agentFixDeps`, which server.ts sets at
 * boot — the same one the routes use, so a capability behaves identically
 * whether it was approved on screen or by phone.
 */
export function applyAgentFixAction(input: {
  actor: ConfirmActor;
  actionId: string;
  verifiedFrom: string;
}): Promise<ConfirmResult> {
  const deps = agentFixDeps;
  if (!deps) {
    return Promise.resolve({
      ok: false,
      status: 503,
      error: "fix_by_text_unavailable",
      message: "Approval by text is not wired up on this server.",
    } as ConfirmResult);
  }
  return applyConfirmedAction(deps, confirmCapabilityRegistry, {
    actor: input.actor,
    actionId: input.actionId,
    credential: { kind: "one_time_code", channel: "sms", verifiedFrom: input.verifiedFrom },
    // The draft must stay approvable for as long as the code does, or an
    // overnight escalation answers "expired" the moment the owner replies.
    maxAgeMs: FIX_CODE_TTL_MS,
    isTenantAdminOrAbove,
    resolveTenantId: resolveTargetTenantId,
    hash,
  });
}

/**
 * The deps the SMS path executes with. Set once at boot from the same bag the
 * routes use. Null until then, and the fix path refuses rather than guessing —
 * a half-wired dependency is how a capability silently behaves differently
 * depending on who approved it.
 */
let agentFixDeps: ConfirmDeps | null = null;
export function setAgentFixDeps(deps: ConfirmDeps): void {
  agentFixDeps = deps;
}

export function listPendingGrants(dbLike: any, actor: ConfirmActor): Promise<PendingConfirmationView[]>;
export function listPendingGrants(deps: ConfirmDeps, actor: ConfirmActor): Promise<PendingConfirmationView[]>;
export function listPendingGrants(dbOrDeps: any, actor: ConfirmActor): Promise<PendingConfirmationView[]> {
  // Accepts either a bare prisma-like client or a full deps bag, so callers
  // that only need the read do not have to assemble password/rate-limit deps.
  const deps: ConfirmDeps = dbOrDeps?.db
    ? dbOrDeps
    : ({
        db: dbOrDeps,
        comparePassword: async () => false,
        grantablePermissions: getGrantablePermissions,
        rateLimit: () => true,
        audit: async () => {},
      } as ConfirmDeps);
  return listPendingConfirmations(deps, confirmCapabilityRegistry, {
    actor,
    resolveTenantId: resolveTargetTenantId,
    hash,
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function getUser(req: any): ConfirmActor {
  return req.user as ConfirmActor;
}

export interface RegisterAgentGrantRoutesDeps {
  rateLimit: ConfirmDeps["rateLimit"];
  audit: ConfirmDeps["audit"];
  /** Replays a real route in-process as the confirming admin. */
  injectAsService: NonNullable<ConfirmDeps["injectAsService"]>;
  enableSmsOnDid: NonNullable<ConfirmDeps["enableSmsOnDid"]>;
}

export async function registerAgentGrantRoutes(
  app: FastifyInstance,
  deps: RegisterAgentGrantRoutesDeps,
) {
  const confirmDeps: ConfirmDeps = {
    db,
    comparePassword: (plain, hashed) => bcrypt.compare(plain, hashed),
    grantablePermissions: getGrantablePermissions,
    rateLimit: deps.rateLimit,
    audit: deps.audit,
    injectAsService: deps.injectAsService,
    enableSmsOnDid: deps.enableSmsOnDid,
    // The ONE place the real invoice engine is wired into the capabilities.
    billing: defaultBillingDeps,
    // Every change the assistant makes lands in that company's knowledge
    // document straight away, so the NEXT conversation already knows about it.
    // Fire-and-forget by design (see ConfirmDeps.onActionApplied).
    onActionApplied: ({ tenantId }) => {
      void refreshTenantFactsDoc(tenantId).catch(() => {});
    },
  };
  // The "Fix it!" sweep executes with the SAME bag, so a capability cannot
  // behave one way on screen and another way over text.
  //
  // ⛔ Logged at boot ON PURPOSE. If this wiring were ever missed, every texted
  // approval would answer "not wired up on this server" — a reply the owner
  // still RECEIVES, so the feature would look alive while fixing nothing. That
  // is this codebase's most repeated failure shape (the worker's dead FCM
  // sender, the empty knowledge base, the trainer that taught nothing), and one
  // grep-able line is what makes it provable instead of inferred:
  //     docker exec app-api-1 ... | grep AGENT_FIX_BY_TEXT_ARMED
  setAgentFixDeps(confirmDeps);
  app.log.info(
    { capabilities: confirmCapabilityRegistry.ids(), marker: "AGENT_FIX_BY_TEXT_ARMED" },
    "AGENT_FIX_BY_TEXT_ARMED — approval by text can execute these capabilities",
  );

  const pending = async (req: any, reply: any) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) return reply.code(403).send({ error: "forbidden" });
    return {
      grants: await listPendingConfirmations(confirmDeps, confirmCapabilityRegistry, {
        actor,
        resolveTenantId: resolveTargetTenantId,
        hash,
      }),
    };
  };

  const apply = async (req: any, reply: any) => {
    const actor = getUser(req);
    const params = z.object({ actionId: z.string().min(1).max(64) }).safeParse(req.params);
    const body = z.object({ password: z.string().min(1).max(200) }).safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: "confirmation_not_found" });
    if (!body.success) {
      return reply.code(400).send({ error: "password_required", message: "Enter your account password to confirm." });
    }
    const result = await applyConfirmedAction(confirmDeps, confirmCapabilityRegistry, {
      actor,
      actionId: params.data.actionId,
      password: body.data.password,
      isTenantAdminOrAbove,
      resolveTenantId: resolveTargetTenantId,
      hash,
    });
    if (!result.ok) return reply.code(result.status).send({ error: result.error, message: result.message });
    return reply.code(200).send({ ok: true, message: result.message, ...(result.details ?? {}) });
  };

  /** "No, don't." No password: cancelling can only make the account less. */
  const dismiss = async (req: any, reply: any) => {
    const actor = getUser(req);
    if (!isTenantAdminOrAbove(actor.role)) return reply.code(403).send({ error: "forbidden" });
    const params = z.object({ actionId: z.string().min(1).max(64) }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "confirmation_not_found" });
    const done = await db.agentAction.updateMany({
      where: {
        id: params.data.actionId,
        tenantId: actor.tenantId,
        capabilityId: { in: confirmCapabilityRegistry.ids() },
        status: "DRAFT",
        approvalConsumedAt: null,
        requestedBy: actor.sub,
      },
      data: { status: "DENIED", deniedReason: "dismissed_by_requester" },
    });
    return { ok: true, dismissed: done.count };
  };

  // The current names.
  app.get("/admin/agent-confirmations/pending", pending);
  app.post("/admin/agent-confirmations/:actionId/apply", apply);
  app.post("/admin/agent-confirmations/:actionId/dismiss", dismiss);

  // The names the already-deployed portal build calls. Kept so a portal that
  // has not been redeployed yet keeps working — remove once every build in the
  // wild uses the names above.
  app.get("/admin/agent-grants/pending", pending);
  app.post("/admin/agent-grants/:actionId/apply", apply);
  app.post("/admin/agent-grants/:actionId/dismiss", dismiss);
}
