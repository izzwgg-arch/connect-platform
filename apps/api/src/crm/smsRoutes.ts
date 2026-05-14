import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import {
  TwilioSmsProvider,
  VoipMsSmsProvider,
  type SmsProvider,
  type TwilioCredentials,
  type VoipMsCredentials,
} from "@connect/integrations";
import { decryptJson } from "@connect/security";
import { requireCrmAccess } from "./guard";

// ── SMS provider helper ────────────────────────────────────────────────────────
//
// Mirrors the pattern in apps/api/src/billing/routes.ts resolveTenantSmsProvider.
// We keep it co-located here rather than importing from billing to avoid coupling
// two unrelated domains. The actual send logic stays in @connect/integrations.

type SmsProviderCtx = {
  provider: SmsProvider;
  fromNumber: string;
  providerName: string;
};

async function resolveCrmSmsProvider(tenantId: string): Promise<SmsProviderCtx | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tenant = await (db as any).tenant.findUnique({
    where: { id: tenantId },
    select: {
      smsPrimaryProvider: true,
      defaultSmsFromNumber: { select: { phoneNumber: true } },
    },
  });
  if (!tenant) return null;

  const providerName: string = tenant.smsPrimaryProvider || "TWILIO";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const credential = await (db as any).providerCredential.findUnique({
    where: { tenantId_provider: { tenantId, provider: providerName } },
  });
  if (!credential || !credential.isEnabled) return null;

  let smsProvider: SmsProviderCtx["provider"];
  try {
    if (providerName === "TWILIO") {
      const creds = decryptJson<TwilioCredentials>(credential.credentialsEncrypted);
      if (!creds.accountSid || !creds.authToken) return null;
      smsProvider = new TwilioSmsProvider(creds, false);
    } else {
      const creds = decryptJson<VoipMsCredentials>(credential.credentialsEncrypted);
      if (!creds.username || !creds.password || !creds.fromNumber) return null;
      smsProvider = new VoipMsSmsProvider(creds, false);
    }
  } catch {
    return null;
  }

  let fromNumber: string | null = tenant.defaultSmsFromNumber?.phoneNumber ?? null;
  if (!fromNumber) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyNum = await (db as any).phoneNumber.findFirst({
      where: { tenantId, status: "ACTIVE" },
      select: { phoneNumber: true },
      orderBy: { createdAt: "asc" },
    });
    fromNumber = anyNum?.phoneNumber ?? null;
  }
  if (!fromNumber) return null;

  return { provider: smsProvider, fromNumber, providerName };
}

/** True when CRM outbound SMS can be sent (provider credentials + from number). */
export async function isCrmOutboundSmsConfigured(tenantId: string): Promise<boolean> {
  return (await resolveCrmSmsProvider(tenantId)) != null;
}

// ── Route schema ──────────────────────────────────────────────────────────────

const sendSmsBodySchema = z.object({
  message: z.string().min(1).max(1600),
  // Optional: caller passes the numberRaw/numberNormalized of the desired phone
  // when the contact has multiple numbers. Defaults to primary.
  phone: z.string().optional(),
});

// ── Route registrar ───────────────────────────────────────────────────────────

export async function registerCrmSmsRoutes(app: FastifyInstance) {
  /**
   * POST /crm/contacts/:id/sms
   *
   * Sends a real SMS to a CRM contact using the tenant's configured provider
   * (Twilio or VoIP.ms). Writes an SMS_SENT CrmTimelineEvent ONLY on success.
   *
   * Blocked if:
   *   - contact not found in tenant          → 404
   *   - CrmContactMeta.doNotSms is true      → 400 do_not_sms
   *   - no phone on contact                  → 400 no_phone
   *   - SMS not configured for tenant        → 503 sms_not_configured
   *   - provider throws / returns error      → 502 sms_send_failed
   */
  app.post("/crm/contacts/:id/sms", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;

    const { id: contactId } = req.params as { id: string };

    const parsed = sendSmsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }
    const { message, phone: requestedPhone } = parsed.data;

    // ── Verify contact ─────────────────────────────────────────────────────────
    const contact = await db.contact.findFirst({
      where: { id: contactId, tenantId: user.tenantId },
      include: {
        phones: { orderBy: { isPrimary: "desc" } },
        crmMeta: { select: { doNotSms: true } },
      },
    });
    if (!contact) {
      return reply.code(404).send({ error: "contact_not_found" });
    }

    // ── Check opt-out ──────────────────────────────────────────────────────────
    if (contact.crmMeta?.doNotSms) {
      return reply.code(400).send({
        error: "do_not_sms",
        detail: "This contact has opted out of SMS messages",
      });
    }

    // ── Resolve target phone ───────────────────────────────────────────────────
    const phones = contact.phones ?? [];
    if (phones.length === 0) {
      return reply.code(400).send({ error: "no_phone", detail: "Contact has no phone number" });
    }

    let targetPhone: (typeof phones)[0];
    if (requestedPhone) {
      const found = phones.find(
        (p) => p.numberRaw === requestedPhone || p.numberNormalized === requestedPhone,
      );
      if (!found) {
        return reply.code(400).send({ error: "phone_not_found", detail: "Selected phone not found on contact" });
      }
      targetPhone = found;
    } else {
      targetPhone = phones[0]; // primary first (ordered by isPrimary desc)
    }

    const toPhone = targetPhone.numberNormalized || targetPhone.numberRaw;
    if (!toPhone) {
      return reply.code(400).send({ error: "no_phone", detail: "Contact phone number could not be resolved" });
    }

    // ── Resolve SMS provider ───────────────────────────────────────────────────
    const smsCtx = await resolveCrmSmsProvider(user.tenantId);
    if (!smsCtx) {
      return reply.code(503).send({
        error: "sms_not_configured",
        detail: "SMS is not configured or no SMS-capable number is available for this tenant",
      });
    }

    // ── Send ───────────────────────────────────────────────────────────────────
    // Provider errors throw — we only write the timeline event on confirmed success.
    let providerMessageId: string | null = null;
    try {
      const result = await smsCtx.provider.sendMessage({
        tenantId: user.tenantId,
        to: toPhone,
        from: smsCtx.fromNumber,
        body: message,
      });
      providerMessageId = result?.providerMessageId ?? null;
    } catch (err: unknown) {
      return reply.code(502).send({
        error: "sms_send_failed",
        detail: (err as Error)?.message ?? "SMS provider returned an error",
      });
    }

    // ── Write timeline event ───────────────────────────────────────────────────
    await db.crmTimelineEvent.create({
      data: {
        tenantId: user.tenantId,
        contactId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: "SMS_SENT" as any,
        title: "SMS sent",
        body: message.substring(0, 500),
        metadata: {
          to: toPhone,
          from: smsCtx.fromNumber,
          provider: smsCtx.providerName,
          ...(providerMessageId ? { providerMessageId } : {}),
        },
        createdByUserId: user.sub,
      },
    });

    return {
      ok: true,
      to: toPhone,
      from: smsCtx.fromNumber,
      provider: smsCtx.providerName,
      providerMessageId,
    };
  });
}
