import { db } from "@connect/db";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InboundSmsHookInput {
  /** The tenant that owns the receiving DID. */
  tenantId: string;
  /** The inbound sender's phone — E.164 when VoIP.ms normalized it, raw otherwise. */
  fromE164: string;
  /** The tenant DID that received the message. */
  toE164: string;
  /** SMS body text. */
  body: string;
  /**
   * ConnectChatMessage.id — used as the CrmTimelineEvent.linkedId for idempotency.
   * Because ConnectChatMessage rows are themselves deduped before creation, keying
   * on this unique CUID prevents duplicate SMS_RECEIVED events from both the webhook
   * and the poll paths processing the same physical message.
   */
  messageId: string;
  /** Provider-assigned message id (e.g. "voipms:12345"), stored as metadata. */
  smsProviderMessageId: string | null;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Non-blocking CRM hook: fires after an inbound SMS is persisted as a
 * ConnectChatMessage. Writes a SMS_RECEIVED CrmTimelineEvent if — and
 * only if — the sender's phone matches a CRM contact in the same tenant.
 *
 * Design constraints:
 *   - Never throws. Caller wraps with .catch(() => {}).
 *   - Never blocks the inbound webhook response.
 *   - Idempotent: keyed on linkedId = messageId.
 *   - Never creates fake events — event written only after real message persisted.
 *   - Tenant-scoped throughout.
 */
export async function crmInboundSmsHook(input: InboundSmsHookInput): Promise<void> {
  const { tenantId, fromE164, body, messageId, toE164, smsProviderMessageId } = input;
  if (!tenantId || !fromE164 || !body) return;

  // 1. CRM must be enabled for this tenant (fast indexed lookup)
  const crmSettings = await db.crmTenantSettings.findUnique({
    where: { tenantId },
    select: { enabled: true },
  });
  if (!crmSettings?.enabled) return;

  // 2. Normalize sender phone to digits-only to match ContactPhone.numberNormalized.
  //    ContactPhone uses normalisePhone() = raw.replace(/\D/g, ""), so we do the same.
  const fromDigits = fromE164.replace(/\D/g, "");
  if (fromDigits.length < 7) return;
  const last10 = fromDigits.slice(-10);

  // 3. Find a CRM contact in this tenant with a matching phone (last-10-digit suffix).
  //    Consistent with GET /crm/contacts/lookup partial-match strategy.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const phoneMatch = await (db as any).contactPhone.findFirst({
    where: {
      contact: { tenantId },
      numberNormalized: { endsWith: last10 },
    },
    select: { contactId: true },
    orderBy: { isPrimary: "desc" },
  });
  if (!phoneMatch?.contactId) return;

  // 4. Idempotency check: skip if we already wrote an SMS_RECEIVED for this message.
  const existing = await db.crmTimelineEvent.findFirst({
    where: {
      linkedId: messageId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: "SMS_RECEIVED" as any,
    },
    select: { id: true },
  });
  if (existing) return;

  // 5. Write the timeline event.
  await db.crmTimelineEvent.create({
    data: {
      tenantId,
      contactId: phoneMatch.contactId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: "SMS_RECEIVED" as any,
      title: "SMS received",
      body: body.substring(0, 500),
      linkedId: messageId,
      metadata: {
        from: fromE164,
        to: toE164,
        ...(smsProviderMessageId ? { smsProviderMessageId } : {}),
      },
    },
  });
}
