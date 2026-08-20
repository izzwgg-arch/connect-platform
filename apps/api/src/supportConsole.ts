/**
 * The Support Console API — Phase 1, the escalation desk (2026-08-20).
 *
 * The first screens ever to READ `AgentEscalation`. The rows are rich already —
 * the full research report (ISSUE / FINDINGS / PROPOSED FIX / APPROVAL), the
 * proposed fix, and the fix-by-text state machine — but until today the only
 * consumer was the dispatcher that texts the owner's phone.
 *
 * ⛔ SUPER_ADMIN ONLY for now (Izzy, 2026-08-20: "for now do just super admin,
 * and I will create it later"). Two layers, the pbx-console pattern exactly:
 * every handler calls the injected `requireSuper` gate, AND the
 * `/admin/support` prefix sits in PORTAL_API_PERMISSION_RULES under
 * `can_manage_global_settings` so the route is never silently outside the
 * global permission gate (the /admin/wake-health class). ⛔ Deliberately NO new
 * grantable permission key yet — a key that a non-super could tick while every
 * handler still refuses them is a visible door that doesn't open. The
 * per-feature keys ship with the multi-agent phase, when they actually gate.
 *
 * ⛔ APPROVING A FIX DOES NOT HAPPEN HERE. The desk hands the portal the DRAFT
 * action id and the portal calls the EXISTING
 * `POST /admin/agent-confirmations/:actionId/apply` (password, bcrypt) — one
 * apply path, never two. That route already lets a SUPER_ADMIN approve an
 * action in the customer's tenant: `applyConfirmedAction` feeds the ACTION's
 * own tenantId into `resolveTargetTenantId` (agentConfirmations.ts), which for
 * SUPER_ADMIN resolves to exactly that tenant. A test in supportConsole.test.ts
 * pins that this module registers no POST at all.
 *
 * ⛔ `fixCodeHash` NEVER leaves the server. It is the single-use approval
 * credential's hash; even the hash is nobody's business outside the api. Both
 * routes build their responses field-by-field (no `...row` spread) so a new
 * schema column is invisible here until someone decides it should be shown —
 * and a test asserts the string "fixCodeHash" appears in no response.
 */
import { z } from "zod";
import { supportReportReference } from "@connect/shared";

type Gate = (req: any, reply: any) => Promise<unknown | null>;

export interface SupportConsoleDeps {
  app: {
    get: (path: string, handler: (req: any, reply: any) => Promise<unknown>) => unknown;
  };
  db: any;
  requireSuper: Gate;
}

const LIST_DEFAULT_TAKE = 50;
const LIST_MAX_TAKE = 200;
const CONVERSATION_TAIL = 30;

/** The list-row shape — everything the queue needs, nothing secret. */
export function escalationListRow(row: any) {
  return {
    id: row.id,
    reference: supportReportReference(row.id),
    createdAt: row.createdAt,
    tenantId: row.tenantId,
    tenantName: row.tenantName,
    userName: row.userName,
    userEmail: row.userEmail ?? null,
    requestSummary: row.requestSummary,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError ?? null,
    smsSentAt: row.smsSentAt ?? null,
    emailQueuedAt: row.emailQueuedAt ?? null,
    researchDegraded: !!row.researchDegraded,
    fixStatus: row.fixStatus ?? null,
    hasFixAction: !!row.fixActionId,
    hasConversation: !!row.conversationId,
  };
}

const listQuerySchema = z.object({
  status: z.enum(["all", "queued", "sent", "failed", "cancelled"]).optional(),
  tenantId: z.string().min(1).max(64).optional(),
  take: z.coerce.number().int().min(1).max(LIST_MAX_TAKE).optional(),
  /** Cursor: return rows strictly older than this ISO timestamp. */
  before: z.string().datetime({ offset: true }).optional(),
});

export function registerSupportConsoleRoutes(deps: SupportConsoleDeps): void {
  const { app, db, requireSuper } = deps;

  app.get("/admin/support/escalations", async (req, reply) => {
    const user = await requireSuper(req, reply);
    if (!user) return reply;
    const q = listQuerySchema.safeParse(req.query ?? {});
    if (!q.success) {
      return reply.code(400).send({ error: "bad_query", message: "Those list filters don't parse." });
    }
    const where: Record<string, unknown> = {};
    if (q.data.status && q.data.status !== "all") where.status = q.data.status.toUpperCase();
    if (q.data.tenantId) where.tenantId = q.data.tenantId;
    if (q.data.before) where.createdAt = { lt: new Date(q.data.before) };
    const rows = await db.agentEscalation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: q.data.take ?? LIST_DEFAULT_TAKE,
    });
    return {
      escalations: rows.map(escalationListRow),
      counts: {
        returned: rows.length,
        // "Fix ready" = the agent prepared a one-click fix that nobody has
        // spent yet — the rows a support person should look at first.
        fixReady: rows.filter((r: any) => r.fixStatus === "offered").length,
      },
    };
  });

  app.get("/admin/support/escalations/:id", async (req, reply) => {
    const user = await requireSuper(req, reply);
    if (!user) return reply;
    const params = z.object({ id: z.string().min(1).max(64) }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const row = await db.agentEscalation.findUnique({ where: { id: params.data.id } });
    if (!row) return reply.code(404).send({ error: "not_found" });

    // The DRAFT action behind "Approve the fix", when the agent prepared one.
    // Best-effort: a missing/failed lookup renders the escalation without the
    // button rather than 500ing the whole detail.
    let fixAction: unknown = null;
    if (row.fixActionId) {
      fixAction = await db.agentAction
        .findUnique({
          where: { id: row.fixActionId },
          select: {
            id: true,
            status: true,
            summary: true,
            capabilityId: true,
            createdAt: true,
            approvalConsumedAt: true,
          },
        })
        .catch(() => null);
    }

    // The conversation tail, so the report is read in context. Also
    // best-effort — the report stands on its own.
    let messages: unknown[] = [];
    if (row.conversationId) {
      const tail = await db.agentMessage
        .findMany({
          where: { conversationId: row.conversationId },
          orderBy: { createdAt: "desc" },
          take: CONVERSATION_TAIL,
          select: { role: true, content: true, contentEn: true, createdAt: true, model: true },
        })
        .catch(() => []);
      messages = tail.reverse();
    }

    return {
      escalation: {
        ...escalationListRow(row),
        conversationId: row.conversationId ?? null,
        smsBody: row.smsBody,
        report: row.report,
        proposedFix: row.proposedFix,
        fixActionId: row.fixActionId ?? null,
        fixCodeExpiresAt: row.fixCodeExpiresAt ?? null,
        fixCodeUsedAt: row.fixCodeUsedAt ?? null,
        fixApprovedFrom: row.fixApprovedFrom ?? null,
        fixResult: row.fixResult ?? null,
        fixAttempts: row.fixAttempts ?? 0,
      },
      fixAction,
      messages,
    };
  });
}
