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
import { createHash } from "node:crypto";
import { supportReportReference, resolvePersonDisplayName } from "@connect/shared";

/**
 * Best-effort audit row with REAL tamper evidence — `AgentAuditLog.hash` is a
 * required sha256 of the row body (same convention as investigationRoute.ts;
 * a stubbed hash silently turns an audit trail into a log). Never throws:
 * losing an audit row must not fail a support action, but the create must be
 * SHAPED correctly or every row is lost silently.
 */
async function supportAudit(
  db: any,
  row: { actor: string; event: string; tenantId: string; conversationId?: string; payload?: Record<string, unknown> },
): Promise<void> {
  try {
    await db.agentAuditLog.create({
      data: {
        ...row,
        hash: createHash("sha256").update(JSON.stringify(row)).digest("hex"),
      },
    });
  } catch {
    /* best-effort */
  }
}

type Gate = (req: any, reply: any) => Promise<unknown | null>;

export interface SupportConsoleDeps {
  app: {
    get: (path: string, handler: (req: any, reply: any) => Promise<unknown>) => unknown;
    post: (path: string, handler: (req: any, reply: any) => Promise<unknown>) => unknown;
  };
  db: any;
  requireSuper: Gate;
  /**
   * Phase 3: replying from the desk. ⛔ This is deliberately the INJECTED
   * `sendConnectChatSmsMessage` from connectChatRoutes.ts — the ONE send
   * implementation (participant join, canSendSmsUser, provider dispatch,
   * pushes). This module never grows its own sender; a source test pins it.
   */
  sendSms?: (input: {
    deps: { smsQueue: unknown };
    user: any;
    tenantId: string;
    threadId: string;
    body: string;
  }) => Promise<{ ok: boolean; status?: number; error?: string; message?: any }>;
  smsQueue?: unknown;
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

/**
 * Phase 3 (same day): the cross-company inbox. Every company's chat/SMS
 * threads in one list, a read-only transcript, and reply-by-the-company's-own-
 * number for SMS threads. ⛔ Sender names go through the shared
 * `resolvePersonDisplayName` (extension name first — the platform naming rule);
 * inbound messages are labelled by the thread's external number, never a
 * guessed contact name.
 */
const THREADS_DEFAULT_TAKE = 30;
const THREADS_MAX_TAKE = 100;
const TRANSCRIPT_TAKE = 60;

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

  // ───────────────────────── Phase 3: the inbox ─────────────────────────

  app.get("/admin/support/threads", async (req, reply) => {
    const user = await requireSuper(req, reply);
    if (!user) return reply;
    const q = z
      .object({
        type: z.enum(["all", "sms", "dm", "group", "tenant_group"]).optional(),
        take: z.coerce.number().int().min(1).max(THREADS_MAX_TAKE).optional(),
      })
      .safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "bad_query" });
    const where: Record<string, unknown> = { active: true };
    if (q.data.type && q.data.type !== "all") where.type = q.data.type.toUpperCase();
    const threads = await db.connectChatThread.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      take: q.data.take ?? THREADS_DEFAULT_TAKE,
      select: {
        id: true,
        tenantId: true,
        type: true,
        title: true,
        tenantSmsE164: true,
        externalSmsE164: true,
        smsInboxOwnerUserId: true,
        lastMessageAt: true,
      },
    });
    const tenantIds = [...new Set(threads.map((t: any) => t.tenantId))];
    const tenants = await db.tenant
      .findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
      .catch(() => []);
    const tenantName = new Map(tenants.map((t: any) => [t.id, t.name]));
    // One findFirst per thread — bounded by the take cap, and honest ordering
    // beats a clever unsupported group-by.
    const lasts = await Promise.all(
      threads.map((t: any) =>
        db.connectChatMessage
          .findFirst({
            where: { threadId: t.id, deletedForEveryoneAt: null },
            orderBy: { createdAt: "desc" },
            select: { direction: true, type: true, body: true, createdAt: true },
          })
          .catch(() => null),
      ),
    );
    return {
      threads: threads.map((t: any, i: number) => ({
        id: t.id,
        tenantId: t.tenantId,
        tenantName: tenantName.get(t.tenantId) ?? t.tenantId,
        type: t.type,
        title: t.title ?? null,
        tenantSmsE164: t.tenantSmsE164 ?? null,
        externalSmsE164: t.externalSmsE164 ?? null,
        sharedInbox: t.smsInboxOwnerUserId === "",
        lastMessageAt: t.lastMessageAt,
        last: lasts[i]
          ? {
              direction: lasts[i].direction,
              type: lasts[i].type,
              preview: String(lasts[i].body ?? "").slice(0, 120),
              at: lasts[i].createdAt,
            }
          : null,
      })),
    };
  });

  app.get("/admin/support/threads/:id", async (req, reply) => {
    const user = await requireSuper(req, reply);
    if (!user) return reply;
    const params = z.object({ id: z.string().min(1).max(64) }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const thread = await db.connectChatThread.findUnique({
      where: { id: params.data.id },
      select: {
        id: true,
        tenantId: true,
        type: true,
        title: true,
        tenantSmsE164: true,
        externalSmsE164: true,
        smsInboxOwnerUserId: true,
        lastMessageAt: true,
      },
    });
    if (!thread) return reply.code(404).send({ error: "not_found" });
    const tenant = await db.tenant
      .findUnique({ where: { id: thread.tenantId }, select: { name: true } })
      .catch(() => null);
    const tail = await db.connectChatMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: "desc" },
      take: TRANSCRIPT_TAKE,
      select: {
        id: true,
        direction: true,
        type: true,
        body: true,
        senderUserId: true,
        createdAt: true,
        deliveryStatus: true,
        deliveryError: true,
        deletedForEveryoneAt: true,
      },
    });
    const messages = tail.reverse();
    // Sender names by the platform rule: extension name first.
    const senderIds = [...new Set(messages.map((m: any) => m.senderUserId).filter(Boolean))] as string[];
    const [senders, senderExts] = await Promise.all([
      senderIds.length
        ? db.user
            .findMany({
              where: { id: { in: senderIds } },
              select: { id: true, firstName: true, lastName: true, email: true },
            })
            .catch(() => [])
        : [],
      senderIds.length
        ? db.extension
            .findMany({
              where: { ownerUserId: { in: senderIds } },
              select: { ownerUserId: true, displayName: true },
            })
            .catch(() => [])
        : [],
    ]);
    const extName = new Map<string, string>(senderExts.map((e: any) => [e.ownerUserId, e.displayName]));
    const senderName = new Map<string, string>(
      senders.map((u: any) => [
        u.id,
        resolvePersonDisplayName({
          extensionDisplayName: extName.get(u.id) ?? null,
          firstName: u.firstName,
          lastName: u.lastName,
          email: u.email,
        }),
      ]),
    );
    return {
      thread: {
        id: thread.id,
        tenantId: thread.tenantId,
        tenantName: tenant?.name ?? thread.tenantId,
        type: thread.type,
        title: thread.title ?? null,
        tenantSmsE164: thread.tenantSmsE164 ?? null,
        externalSmsE164: thread.externalSmsE164 ?? null,
        sharedInbox: thread.smsInboxOwnerUserId === "",
      },
      messages: messages.map((m: any) => ({
        id: m.id,
        direction: m.direction,
        type: m.type,
        body: m.deletedForEveryoneAt ? "" : String(m.body ?? ""),
        deleted: !!m.deletedForEveryoneAt,
        senderName: m.senderUserId ? senderName.get(m.senderUserId) ?? null : null,
        createdAt: m.createdAt,
        deliveryStatus: m.deliveryStatus ?? null,
        deliveryError: m.deliveryError ?? null,
      })),
    };
  });

  // ─────────────────── Phase 4: assistant conversations + take-over ───────────────────
  //
  // ⛔ The take-over contract, all three legs: (1) these routes flip
  // AgentConversation.humanTakeoverAt/By and write staff messages (role
  // "staff") straight into AgentMessage — same database the agent reads;
  // (2) the agent ENGINE refuses to answer while the flag is set
  // (engine.handleMessage's take-over branch — deployed as an agent REBUILD,
  // not an api deploy); (3) the customer's widget polls /agent-api/chat/
  // messages, which reports the flag, so staff replies appear live. A staff
  // message REQUIRES an active take-over — a person talking while the
  // assistant also answers is two voices in one mouth.

  app.get("/admin/support/conversations", async (req, reply) => {
    const user = await requireSuper(req, reply);
    if (!user) return reply;
    const q = z
      .object({ take: z.coerce.number().int().min(1).max(THREADS_MAX_TAKE).optional() })
      .safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "bad_query" });
    const convs = await db.agentConversation.findMany({
      orderBy: { startedAt: "desc" },
      take: q.data.take ?? THREADS_DEFAULT_TAKE,
      select: {
        id: true,
        tenantId: true,
        clientUserId: true,
        role: true,
        status: true,
        language: true,
        startedAt: true,
        humanTakeoverAt: true,
        humanTakeoverBy: true,
      },
    });
    const tenantIds = [...new Set(convs.map((c: any) => c.tenantId))];
    const userIds = [...new Set(convs.map((c: any) => c.clientUserId).filter(Boolean))] as string[];
    const [tenants, users, lasts] = await Promise.all([
      tenantIds.length
        ? db.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }).catch(() => [])
        : [],
      userIds.length
        ? db.user
            .findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true, email: true } })
            .catch(() => [])
        : [],
      Promise.all(
        convs.map((c: any) =>
          db.agentMessage
            .findFirst({
              where: { conversationId: c.id },
              orderBy: { createdAt: "desc" },
              select: { role: true, content: true, createdAt: true },
            })
            .catch(() => null),
        ),
      ),
    ]);
    const tenantName = new Map<string, string>(tenants.map((t: any) => [t.id, t.name]));
    const userName = new Map<string, string>(
      users.map((u: any) => [u.id, resolvePersonDisplayName({ firstName: u.firstName, lastName: u.lastName, email: u.email })]),
    );
    return {
      conversations: convs.map((c: any, i: number) => ({
        id: c.id,
        tenantId: c.tenantId,
        tenantName: tenantName.get(c.tenantId) ?? c.tenantId,
        userName: c.clientUserId ? userName.get(c.clientUserId) ?? null : null,
        status: c.status,
        language: c.language ?? null,
        startedAt: c.startedAt,
        takenOver: !!c.humanTakeoverAt,
        last: lasts[i]
          ? { role: lasts[i].role, preview: String(lasts[i].content ?? "").slice(0, 120), at: lasts[i].createdAt }
          : null,
      })),
    };
  });

  app.get("/admin/support/conversations/:id", async (req, reply) => {
    const user = await requireSuper(req, reply);
    if (!user) return reply;
    const params = z.object({ id: z.string().min(1).max(64) }).safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    const conv = await db.agentConversation.findUnique({
      where: { id: params.data.id },
      select: {
        id: true,
        tenantId: true,
        clientUserId: true,
        status: true,
        language: true,
        startedAt: true,
        humanTakeoverAt: true,
        humanTakeoverBy: true,
      },
    });
    if (!conv) return reply.code(404).send({ error: "not_found" });
    const [tenant, clientUser, messages] = await Promise.all([
      db.tenant.findUnique({ where: { id: conv.tenantId }, select: { name: true } }).catch(() => null),
      conv.clientUserId
        ? db.user
            .findUnique({ where: { id: conv.clientUserId }, select: { firstName: true, lastName: true, email: true } })
            .catch(() => null)
        : null,
      db.agentMessage
        .findMany({
          where: { conversationId: conv.id },
          orderBy: { createdAt: "asc" },
          take: 120,
          select: { id: true, role: true, content: true, contentEn: true, createdAt: true, model: true },
        })
        .catch(() => []),
    ]);
    return {
      conversation: {
        id: conv.id,
        tenantId: conv.tenantId,
        tenantName: tenant?.name ?? conv.tenantId,
        userName: clientUser ? resolvePersonDisplayName(clientUser) : null,
        status: conv.status,
        language: conv.language ?? null,
        startedAt: conv.startedAt,
        takenOver: !!conv.humanTakeoverAt,
        takenOverAt: conv.humanTakeoverAt ?? null,
      },
      messages,
    };
  });

  app.post("/admin/support/conversations/:id/takeover", async (req, reply) => {
    const user: any = await requireSuper(req, reply);
    if (!user) return reply;
    const params = z.object({ id: z.string().min(1).max(64) }).safeParse(req.params);
    const body = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    const conv = await db.agentConversation.findUnique({
      where: { id: params.data.id },
      select: { id: true, tenantId: true, humanTakeoverAt: true },
    });
    if (!conv) return reply.code(404).send({ error: "not_found" });
    await db.agentConversation.update({
      where: { id: conv.id },
      data: body.data.on
        ? { humanTakeoverAt: new Date(), humanTakeoverBy: String(user.sub ?? "") }
        : { humanTakeoverAt: null, humanTakeoverBy: null },
    });
    // The moment matters either way — tell the customer in the transcript, so
    // the change of voice is never silent.
    await db.agentMessage
      .create({
        data: {
          conversationId: conv.id,
          role: "staff",
          content: body.data.on
            ? "You're now talking with a person from Loopcom support."
            : "The assistant is back — a person from Loopcom support has stepped out.",
          model: "takeover",
        },
      })
      .catch(() => null);
    await supportAudit(db, {
      actor: "support-desk",
      event: body.data.on ? "support.takeover_on" : "support.takeover_off",
      tenantId: conv.tenantId,
      conversationId: conv.id,
      payload: { by: String(user.sub ?? "") },
    });
    return { ok: true, takenOver: body.data.on };
  });

  app.post("/admin/support/conversations/:id/message", async (req, reply) => {
    const user: any = await requireSuper(req, reply);
    if (!user) return reply;
    const params = z.object({ id: z.string().min(1).max(64) }).safeParse(req.params);
    const body = z.object({ body: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    if (!body.success) {
      return reply.code(400).send({ error: "bad_body", message: "Write a message first — up to 2,000 characters." });
    }
    const conv = await db.agentConversation.findUnique({
      where: { id: params.data.id },
      select: { id: true, tenantId: true, humanTakeoverAt: true },
    });
    if (!conv) return reply.code(404).send({ error: "not_found" });
    if (!conv.humanTakeoverAt) {
      return reply.code(409).send({
        error: "not_taken_over",
        message: "Take the conversation over first — otherwise the assistant and a person would both be answering.",
      });
    }
    const msg = await db.agentMessage.create({
      data: { conversationId: conv.id, role: "staff", content: body.data.body, model: "human" },
      select: { id: true, createdAt: true },
    });
    await supportAudit(db, {
      actor: "support-desk",
      event: "support.staff_message",
      tenantId: conv.tenantId,
      conversationId: conv.id,
      payload: { by: String(user.sub ?? ""), chars: body.data.body.length },
    });
    return { ok: true, id: msg.id };
  });

  app.post("/admin/support/threads/:id/reply", async (req, reply) => {
    const user = await requireSuper(req, reply);
    if (!user) return reply;
    if (!deps.sendSms) {
      return reply.code(503).send({ error: "reply_unavailable", message: "Replying is not wired up on this server." });
    }
    const params = z.object({ id: z.string().min(1).max(64) }).safeParse(req.params);
    const body = z.object({ body: z.string().min(1).max(1000) }).safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: "not_found" });
    if (!body.success) {
      return reply.code(400).send({ error: "bad_body", message: "Write a message first — up to 1,000 characters." });
    }
    const thread = await db.connectChatThread.findUnique({
      where: { id: params.data.id },
      select: { id: true, tenantId: true, type: true },
    });
    if (!thread) return reply.code(404).send({ error: "not_found" });
    if (thread.type !== "SMS") {
      return reply
        .code(400)
        .send({ error: "not_sms_thread", message: "Only SMS threads can be replied to from the desk today." });
    }
    // ⛔ tenantId comes from the THREAD, never the caller — the reply goes out
    // from that company's own number, whichever company it is.
    const out = await deps.sendSms({
      deps: { smsQueue: deps.smsQueue },
      user,
      tenantId: thread.tenantId,
      threadId: thread.id,
      body: body.data.body,
    });
    if (!out.ok) {
      return reply
        .code(out.status ?? 500)
        .send({ error: out.error ?? "send_failed", message: "The reply didn't send. " + (out.error ?? "") });
    }
    return { ok: true, message: out.message ?? null };
  });
}
