/**
 * Determines whether a Connect Chat message renders on the viewer's own side
 * of a conversation ("mine" / right-aligned bubble) vs. the other party's side.
 *
 * This file intentionally has ZERO imports (no `@connect/db`, no Fastify) so it
 * can be unit-tested in isolation with real function calls instead of source
 * text matching, and so the rule is defined exactly once for every endpoint
 * that renders chat messages (main Chat, CRM SMS panel, any future consumer).
 *
 * ── Why SMS must be keyed off `direction`, never `senderUserId` ─────────────
 * SMS threads are two-sided (tenant vs. external customer), not per-user: any
 * OUTBOUND row belongs to "our" side regardless of which staff member sent it.
 * Worse, `ConnectChatMessage.senderUserId` has `onDelete: SetNull` in the
 * Prisma schema — every time a staff account is deleted (normal offboarding),
 * ALL of that person's historical outbound SMS silently lose `senderUserId`
 * while `direction` stays "OUTBOUND". Incident 2026-07-02: production chat
 * rendered every SMS message as incoming because the read path used
 * `senderUserId === viewer` for "mine". `direction` can never go missing or
 * change after the fact, so it is the only sustainable signal for SMS.
 *
 * Internal threads (DM / GROUP / TENANT_GROUP) ARE per-user conversations —
 * every participant needs their own perspective on the same INTERNAL-direction
 * rows — so those stay keyed off `senderUserId`.
 */

export interface ConnectChatMineInput {
  senderUserId: string | null | undefined;
  direction: string;
}

export function isConnectChatMessageMine(
  message: ConnectChatMineInput,
  threadType: string | null | undefined,
  viewerUserId: string,
): boolean {
  if (threadType === "SMS") return message.direction === "OUTBOUND";
  return !!viewerUserId && message.senderUserId === viewerUserId;
}
