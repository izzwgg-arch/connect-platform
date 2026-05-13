import { db } from "@connect/db";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InboundSmsHookInput {
  tenantId: string;
  fromE164: string;
  toE164: string;
  body: string;
  messageId: string;
  smsProviderMessageId: string | null;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Non-blocking CRM hook for the VoIP.ms inbound poll path (worker).
 *
 * Identical logic to apps/api/src/crm/inboundSmsHook.ts. Kept here because
 * the worker and API are separate services and cannot share TypeScript source
 * across app boundaries. The provider send logic stays in @connect/integrations.
 *
 * Constraints:
 *   - Never throws. Caller uses .catch(() => {}).
 *   - Idempotent: keyed on linkedId = messageId (ConnectChatMessage.id).
 *   - Writes SMS_RECEIVED only after the real message is already persisted.
 *   - Tenant-scoped throughout.
 */
export async function crmInboundSmsHook(input: InboundSmsHookInput): Promise<void> {
  const { tenantId, fromE164, body, messageId, toE164, smsProviderMessageId } = input;
  if (!tenantId || !fromE164 || !body) return;

  const crmSettings = await db.crmTenantSettings.findUnique({
    where: { tenantId },
    select: { enabled: true },
  });
  if (!crmSettings?.enabled) return;

  const fromDigits = fromE164.replace(/\D/g, "");
  if (fromDigits.length < 7) return;
  const last10 = fromDigits.slice(-10);

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

  const existing = await db.crmTimelineEvent.findFirst({
    where: {
      linkedId: messageId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: "SMS_RECEIVED" as any,
    },
    select: { id: true },
  });
  if (existing) return;

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
