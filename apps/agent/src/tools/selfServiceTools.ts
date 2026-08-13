/**
 * The two self-service WRITES the trainer kept asking for, each scoped to the
 * REQUESTER'S OWN state and nothing else:
 *
 *   - mark_my_chats_read  → the caller's own read-position (lastReadAt) on
 *     their own chat threads. The same write the portal's "Mark all read"
 *     button makes; it silences THEIR badge and touches nobody's messages.
 *   - cancel_my_requests  → withdraws the caller's own still-QUEUED
 *     escalations before they are sent to the owner. A request that already
 *     went out (SENT) is history, not state — it stays.
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
