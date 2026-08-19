/**
 * The self-service tools the trainer kept asking for, each scoped to the
 * REQUESTER'S OWN state and nothing else — two writes and one read:
 *
 *   - mark_my_chats_read  → the caller's own read-position (lastReadAt) on
 *     their own chat threads. The same write the portal's "Mark all read"
 *     button makes; it silences THEIR badge and touches nobody's messages.
 *   - cancel_my_requests  → withdraws the caller's own still-QUEUED
 *     escalations before they are sent to the owner. A request that already
 *     went out (SENT) is history, not state — it stays.
 *
 *   - my_requests         → READ-ONLY: lists those same requests and where
 *     each one got to. Added 2026-08-19 because "any pending request?" had no
 *     tool behind it and was answered from the conversation dossier instead.
 *
 * ⛔ These are the ONLY writes in the agent's tool surface outside the
 * password-confirmed provisioning flow, and they must stay this narrow: both
 * update rows selected by ctx.clientUserId + ctx.tenantId, both are no-ops on
 * other people's data by construction, and neither touches the PBX, billing,
 * or anything a caller could weaponise. A new "small write" belongs behind the
 * password confirm unless it is this same self-only shape.
 */
import type { ToolContext, ToolSpec } from "./toolRegistry";

export interface SelfServiceToolDeps {
  prisma: any;
}

export function buildSelfServiceTools(deps: SelfServiceToolDeps): ToolSpec[] {
  return [
    {
      // ⛔ There was a way to CANCEL requests and no way to LIST them, so
      // "any pending request?" (Ezra, 2026-08-18) was answered from the
      // conversation dossier — it recited requests from two weeks earlier and
      // said it could not confirm their status. A question about the record
      // must be answered FROM the record.
      name: "my_requests",
      description:
        "The customer's OWN requests to the Connect team from this account, newest first, with what each one asked for and where it got to (waiting to send / sent to the team / cancelled / could not send). Use for 'any pending requests?', 'did my request go through?', 'what did I ask for?'. Read-only. Reports the plain-English status — never claim a request was actioned, only that it reached the team.",
      minRole: "customer",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many recent requests to return. Default 10, max 25." },
        },
        additionalProperties: false,
      },
      run: async (args, ctx: ToolContext) => {
        if (!ctx.clientUserId) {
          return { ok: false, error: "no_user", message: "This needs a signed-in account — I can only list YOUR requests." };
        }
        const take = Math.min(Math.max(Math.trunc(Number(args.limit) || 10), 1), 25);
        const rows = await deps.prisma.agentEscalation.findMany({
          where: { tenantId: ctx.tenantId, clientUserId: ctx.clientUserId },
          orderBy: { createdAt: "desc" },
          take,
          select: { id: true, createdAt: true, status: true, requestSummary: true, proposedFix: true },
        });
        // Statuses are internal words; the customer gets plain English. FAILED
        // is deliberately NOT "failed" to them — the dispatcher retries it, so
        // from their side it is still on its way.
        const say: Record<string, string> = {
          QUEUED: "waiting to be sent to the team",
          FAILED: "still being sent to the team",
          SENT: "sent to the team",
          CANCELLED: "cancelled by you",
        };
        return {
          ok: true,
          total: rows.length,
          pending: rows.filter((r: any) => r.status === "QUEUED" || r.status === "FAILED").length,
          requests: rows.map((r: any) => ({
            askedAt: r.createdAt,
            asked: String(r.requestSummary ?? "").slice(0, 300),
            status: say[String(r.status)] ?? String(r.status).toLowerCase(),
            proposedFix: r.proposedFix ? String(r.proposedFix).slice(0, 300) : null,
          })),
        };
      },
    },
    {
      name: "mark_my_chats_read",
      description:
        "Mark ALL of the customer's own chat conversations as read — the same thing the portal's 'Mark all read' button does. Clears their unread badge only; nobody else's view changes and no message is altered. Use when they ask to mark their messages or chats read. This cannot mark things UNREAD — for that, point them at the thread's own menu in the app.",
      minRole: "customer",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: async (_args, ctx: ToolContext) => {
        if (!ctx.clientUserId) {
          return { ok: false, error: "no_user", message: "This needs a signed-in account — I can only mark YOUR chats read." };
        }
        const r = await deps.prisma.connectChatParticipant.updateMany({
          where: { userId: ctx.clientUserId, leftAt: null, thread: { tenantId: ctx.tenantId } },
          data: { lastReadAt: new Date() },
        });
        return { ok: true, threadsMarkedRead: r.count };
      },
    },
    {
      name: "cancel_my_requests",
      description:
        "Withdraw the customer's own pending requests to the admin/human team that have NOT yet been sent. Use when they say 'cancel my requests' or 'never mind what I asked the admin'. Requests that already reached the owner cannot be recalled — the result says how many were cancelled and how many had already gone out.",
      minRole: "customer",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: async (_args, ctx: ToolContext) => {
        if (!ctx.clientUserId) {
          return { ok: false, error: "no_user", message: "This needs a signed-in account — I can only cancel YOUR requests." };
        }
        const [cancelled, alreadySent] = await Promise.all([
          // FAILED is included on purpose: the dispatcher retries FAILED rows,
          // so from the customer's side a failed-but-retrying request is still
          // pending. Only SENT is past the point of no return.
          deps.prisma.agentEscalation.updateMany({
            where: { tenantId: ctx.tenantId, clientUserId: ctx.clientUserId, status: { in: ["QUEUED", "FAILED"] } },
            data: { status: "CANCELLED" },
          }),
          deps.prisma.agentEscalation.count({
            where: { tenantId: ctx.tenantId, clientUserId: ctx.clientUserId, status: "SENT" },
          }),
        ]);
        return { ok: true, cancelled: cancelled.count, alreadySentToOwner: alreadySent };
      },
    },
  ];
}
