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

/**
 * Phase 2 (same day): the customer panel. One aggregate answer per tenant —
 * numbers, extensions, billing posture, recent calls, past escalations.
 * ⛔ Every block is BEST-EFFORT: one failing source renders as an empty card,
 * never a 500 — a support person mid-incident needs the blocks that still
 * answer. ⛔ Field names verified against schema.prisma before writing
 * (`extNumber`/`displayName`, `autoBillingEnabled` NOT "autopayEnabled",
 * `ConnectCdr.startedAt/talkSec`, `PbxTenantInboundDid.connectTenantId`) —
 * guessed accessors are this repo's documented trap.
 */
const UNPAID_ATTENTION_STATUSES = ["FAILED", "OVERDUE"] as const;

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

  app.get("/admin/support/customers/:tenantId", async (req, reply) => {
    const user = await requireSuper(req, reply);
    if (!user) return reply;
    const params = z.object({ tenantId: z.string().min(1).max(64) }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const tenantId = params.data.tenantId;
    const tenant = await db.tenant
      .findUnique({ where: { id: tenantId }, select: { id: true, name: true, createdAt: true, pbxRemovedAt: true } })
      .catch(() => null);
    if (!tenant) return reply.code(404).send({ error: "not_found" });

    const [extensions, userCount, dids, smsNumbers, billing, invoiceAttention, invoiceOpen, recentCalls, pastEscalations] =
      await Promise.all([
        db.extension
          .findMany({
            where: { tenantId },
            orderBy: { extNumber: "asc" },
            select: { extNumber: true, displayName: true, status: true },
          })
          .catch(() => null),
        db.user.count({ where: { tenantId } }).catch(() => null),
        db.pbxTenantInboundDid
          .findMany({ where: { connectTenantId: tenantId, active: true }, select: { e164: true }, take: 20 })
          .catch(() => null),
        db.tenantSmsNumber
          .findMany({
            where: { tenantId, active: true },
            select: { phoneE164: true, isTenantDefault: true },
            take: 10,
          })
          .catch(() => null),
        db.tenantBillingSettings
          .findUnique({ where: { tenantId }, select: { autoBillingEnabled: true, billingDayOfMonth: true } })
          .catch(() => null),
        db.billingInvoice
          .count({ where: { tenantId, status: { in: [...UNPAID_ATTENTION_STATUSES] } } })
          .catch(() => null),
        db.billingInvoice.count({ where: { tenantId, status: "OPEN" } }).catch(() => null),
        db.connectCdr
          .findMany({
            where: { tenantId },
            orderBy: { startedAt: "desc" },
            take: 5,
            select: { direction: true, fromNumber: true, toNumber: true, disposition: true, talkSec: true, startedAt: true },
          })
          .catch(() => null),
        db.agentEscalation
          .findMany({
            where: { tenantId },
            orderBy: { createdAt: "desc" },
            take: 5,
            select: { id: true, requestSummary: true, createdAt: true, status: true, fixStatus: true },
          })
          .catch(() => null),
      ]);

    const activeExtensions = (extensions ?? []).filter((e: any) => e.status === "ACTIVE");
    return {
      tenant,
      counts: {
        extensions: extensions === null ? null : activeExtensions.length,
        users: userCount,
        numbers: dids === null ? null : dids.length,
        smsNumbers: smsNumbers === null ? null : smsNumbers.length,
      },
      numbers: (dids ?? []).map((d: any) => d.e164).slice(0, 10),
      smsNumbers: smsNumbers ?? [],
      extensions: activeExtensions.slice(0, 12),
      billing:
        billing === null
          ? null
          : {
              autopay: !!billing.autoBillingEnabled,
              billingDayOfMonth: billing.billingDayOfMonth ?? null,
              invoicesNeedingAttention: invoiceAttention,
              openInvoices: invoiceOpen,
            },
      recentCalls: recentCalls ?? [],
      pastEscalations: (pastEscalations ?? []).map((e: any) => ({
        id: e.id,
        reference: supportReportReference(e.id),
        requestSummary: e.requestSummary,
        createdAt: e.createdAt,
        status: e.status,
        fixStatus: e.fixStatus ?? null,
      })),
    };
  });
}
