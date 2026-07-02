import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import {
  canSendSmsUser,
  findOrCreateConnectChatSmsThread,
  sendConnectChatSmsMessage,
  type ConnectChatRoutesDeps,
  type JwtUser,
} from "../connectChatRoutes";
import { isConnectChatMessageMine } from "../connectChatMessageMine";
import { crmRoleBypassesContactRestriction, isAdminRole, loadCrmUserAccessRole, requireCrmAccess } from "./guard";
import { assertCrmContactAllowed } from "./crmContactAccess";
import { canonicalSmsPhone } from "@connect/shared";

/** True when CRM outbound SMS can be sent (provider credentials + from number). */
export async function isCrmOutboundSmsConfigured(tenantId: string): Promise<boolean> {
  const [config, smsNumber] = await Promise.all([
    db.globalVoipMsConfig.findUnique({ where: { id: "default" }, select: { credentialsEncrypted: true } }),
    db.tenantSmsNumber.findFirst({ where: { tenantId, active: true }, select: { id: true } }),
  ]);
  return Boolean(config?.credentialsEncrypted && smsNumber);
}

// ── Route schema ──────────────────────────────────────────────────────────────

const sendSmsBodySchema = z.object({
  message: z.string().min(1).max(1600),
  templateId: z.string().min(1).optional(),
  // Optional: caller passes the numberRaw/numberNormalized of the desired phone
  // when the contact has multiple numbers. Defaults to primary.
  phone: z.string().optional(),
});

const readSmsQuerySchema = z.object({
  phone: z.string().optional(),
});

const createSmsTemplateBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  bodyText: z.string().trim().min(1).max(1600),
  isFavorite: z.boolean().optional(),
});

function formatSmsTemplate(row: any) {
  return {
    id: row.id,
    name: row.name,
    bodyText: row.bodyText,
    isFavorite: Boolean(row.isFavorite),
    usageCount: row.usageCount ?? 0,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

function isSmsTemplateStoreError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = String((error as { message?: string } | null)?.message ?? "");
  return code === "P2021" || code === "P2022" || message.includes("CrmSmsTemplate") || message.includes("crmSmsTemplate");
}

function sendSmsTemplateStoreError(reply: FastifyReply) {
  return reply.code(503).send({
    error: "sms_templates_unavailable",
    message: "SMS templates are temporarily unavailable.",
  });
}

async function canArchiveSmsTemplate(
  user: { sub: string; tenantId: string; role?: string },
  template: { createdByUserId?: string | null },
): Promise<boolean> {
  if (isAdminRole(user.role)) return true;
  if (template.createdByUserId === user.sub) return true;
  const crmRole = await loadCrmUserAccessRole(user.tenantId, user.sub);
  return crmRoleBypassesContactRestriction(crmRole);
}

function selectContactDisplayName(contact: { displayName: string; company?: string | null }): string {
  return [contact.displayName, contact.company].filter(Boolean).join(" · ") || contact.displayName;
}

async function resolveContactSmsTarget(input: {
  contactId: string;
  tenantId: string;
  requestedPhone?: string;
  requireLiveContact: boolean;
}) {
  const contact = await db.contact.findFirst({
    where: {
      id: input.contactId,
      tenantId: input.tenantId,
      ...(input.requireLiveContact ? { active: true, archivedAt: null } : {}),
    },
    include: {
      phones: { orderBy: { isPrimary: "desc" } },
      crmMeta: { select: { doNotSms: true } },
    },
  });
  if (!contact) return { error: "contact_not_found" as const, status: 404 };

  const phones = contact.phones ?? [];
  if (phones.length === 0) {
    return { error: "no_phone" as const, status: 400, detail: "Contact has no phone number" };
  }

  const requestedPhone = input.requestedPhone?.trim();
  const targetPhone = requestedPhone
    ? phones.find((p) => p.numberRaw === requestedPhone || p.numberNormalized === requestedPhone)
    : phones[0];
  if (!targetPhone) {
    return { error: "phone_not_found" as const, status: 400, detail: "Selected phone not found on contact" };
  }

  const toPhone = targetPhone.numberNormalized || targetPhone.numberRaw;
  const normalized = canonicalSmsPhone(toPhone);
  if (!normalized.ok) {
    return { error: "no_phone" as const, status: 400, detail: "Contact phone number could not be resolved" };
  }

  return { contact, targetPhone, toPhone: normalized.e164 };
}

async function findExistingSmsThreadForPhone(tenantId: string, externalPhone: string) {
  const normalized = canonicalSmsPhone(externalPhone);
  if (!normalized.ok) return null;
  return db.connectChatThread.findFirst({
    where: { tenantId, type: "SMS", externalSmsE164: normalized.e164, active: true },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true, tenantSmsE164: true, externalSmsE164: true },
  });
}

async function listThreadMessagesForCrmPanel(tenantId: string, threadId: string) {
  const rows = await db.connectChatMessage.findMany({
    where: { tenantId, threadId, deletedForEveryoneAt: null },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: {
      id: true,
      threadId: true,
      senderUserId: true,
      direction: true,
      type: true,
      body: true,
      createdAt: true,
      deliveryStatus: true,
      deliveryError: true,
    },
  });
  return rows.map((m) => ({
    id: m.id,
    threadId: m.threadId,
    senderId: m.senderUserId || "",
    body: m.body,
    sentAt: m.createdAt.toISOString(),
    mine: isConnectChatMessageMine(m, "SMS", ""),
    direction: m.direction,
    type: m.type,
    deliveryStatus: m.deliveryStatus,
    deliveryError: m.deliveryError,
  }));
}

// ── Route registrar ───────────────────────────────────────────────────────────

export async function registerCrmSmsRoutes(app: FastifyInstance, deps?: Pick<ConnectChatRoutesDeps, "smsQueue">) {
  app.get("/crm/sms/templates", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;

    let rows: any[];
    try {
      rows = await (db as any).crmSmsTemplate.findMany({
        where: {
          tenantId: user.tenantId,
          isArchived: false,
          OR: [
            { visibility: "SHARED" },
            { visibility: "PRIVATE", createdByUserId: user.sub },
          ],
        },
        orderBy: [{ isFavorite: "desc" }, { updatedAt: "desc" }],
        take: 200,
      });
    } catch (error) {
      if (isSmsTemplateStoreError(error)) return sendSmsTemplateStoreError(reply);
      throw error;
    }

    return { templates: rows.map(formatSmsTemplate) };
  });

  app.post("/crm/sms/templates", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;

    const parsed = createSmsTemplateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }

    let row: any;
    try {
      row = await (db as any).crmSmsTemplate.create({
        data: {
          tenantId: user.tenantId,
          createdByUserId: user.sub,
          name: parsed.data.name,
          bodyText: parsed.data.bodyText,
          isFavorite: parsed.data.isFavorite ?? false,
        },
      });
    } catch (error) {
      if (isSmsTemplateStoreError(error)) return sendSmsTemplateStoreError(reply);
      throw error;
    }
    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        action: "CRM_SMS_TEMPLATE_CREATED",
        entityType: "CrmSmsTemplate",
        entityId: row.id,
        actorUserId: user.sub,
      },
    }).catch(() => undefined);

    return { template: formatSmsTemplate(row) };
  });

  app.delete("/crm/sms/templates/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };

    let existing: { id: string; createdByUserId?: string | null } | null;
    try {
      existing = await (db as any).crmSmsTemplate.findFirst({
        where: { id, tenantId: user.tenantId, isArchived: false },
        select: { id: true, createdByUserId: true },
      });
    } catch (error) {
      if (isSmsTemplateStoreError(error)) return sendSmsTemplateStoreError(reply);
      throw error;
    }
    if (!existing) return reply.code(404).send({ error: "template_not_found" });
    if (!(await canArchiveSmsTemplate(user, existing))) return reply.code(403).send({ error: "forbidden" });

    try {
      await (db as any).crmSmsTemplate.update({
        where: { id },
        data: { isArchived: true },
      });
    } catch (error) {
      if (isSmsTemplateStoreError(error)) return sendSmsTemplateStoreError(reply);
      throw error;
    }
    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        action: "CRM_SMS_TEMPLATE_ARCHIVED",
        entityType: "CrmSmsTemplate",
        entityId: id,
        actorUserId: user.sub,
      },
    }).catch(() => undefined);

    return { ok: true };
  });

  app.get("/crm/contacts/:id/sms", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;

    const { id: contactId } = req.params as { id: string };
    if (!(await assertCrmContactAllowed(user, contactId, reply))) return;

    const parsed = readSmsQuerySchema.safeParse(req.query || {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_query", detail: parsed.error.format() });
    }

    const resolved = await resolveContactSmsTarget({
      contactId,
      tenantId: user.tenantId,
      requestedPhone: parsed.data.phone,
      requireLiveContact: false,
    });
    if ("error" in resolved) {
      return reply.code(resolved.status ?? 400).send({ error: resolved.error, detail: resolved.detail });
    }

    const [thread, outboundConfigured] = await Promise.all([
      findExistingSmsThreadForPhone(user.tenantId, resolved.toPhone),
      isCrmOutboundSmsConfigured(user.tenantId),
    ]);
    const messages = thread ? await listThreadMessagesForCrmPanel(user.tenantId, thread.id) : [];
    return {
      contactId,
      outboundConfigured,
      thread: thread
        ? {
            id: thread.id,
            tenantSmsE164: thread.tenantSmsE164,
            externalSmsE164: thread.externalSmsE164,
            crmSms: true,
            crmContactId: resolved.contact.id,
            crmContactName: selectContactDisplayName(resolved.contact),
          }
        : null,
      messages,
    };
  });

  /**
   * POST /crm/contacts/:id/sms
   *
   * Sends one SMS to a CRM contact by creating/reusing the regular Connect Chat
   * SMS thread and queueing the normal Connect Chat SMS message.
   *
   * Blocked if:
   *   - contact not found in tenant          → 404
   *   - CrmContactMeta.doNotSms is true      → 400 do_not_sms
   *   - no phone on contact                  → 400 no_phone
   *   - SMS not configured for tenant        → 503 VOIPMS_NOT_CONFIGURED
   */
  app.post("/crm/contacts/:id/sms", async (req, reply) => {
    if (!deps?.smsQueue) {
      return reply.code(503).send({ error: "sms_queue_unavailable" });
    }

    const user = await requireCrmAccess(req, reply);
    if (!user) return;

    const { id: contactId } = req.params as { id: string };
    if (!(await assertCrmContactAllowed(user, contactId, reply))) return;
    const chatUser = user as JwtUser;
    if (!(await canSendSmsUser(chatUser))) return reply.code(403).send({ error: "FORBIDDEN" });

    const parsed = sendSmsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    }
    const { message, phone: requestedPhone, templateId } = parsed.data;

    let selectedTemplate: { id: string } | null = null;
    if (templateId) {
      try {
        selectedTemplate = await (db as any).crmSmsTemplate.findFirst({
          where: {
            id: templateId,
            tenantId: user.tenantId,
            isArchived: false,
            OR: [
              { visibility: "SHARED" },
              { visibility: "PRIVATE", createdByUserId: user.sub },
            ],
          },
          select: { id: true },
        });
      } catch (error) {
        if (isSmsTemplateStoreError(error)) return sendSmsTemplateStoreError(reply);
        throw error;
      }
    }
    if (templateId && !selectedTemplate) {
      return reply.code(404).send({ error: "template_not_found", detail: "Selected SMS template is no longer available" });
    }

    const resolved = await resolveContactSmsTarget({
      contactId,
      tenantId: user.tenantId,
      requestedPhone,
      requireLiveContact: true,
    });
    if ("error" in resolved) {
      return reply.code(resolved.status ?? 400).send({ error: resolved.error, detail: resolved.detail });
    }

    // ── Check opt-out ──────────────────────────────────────────────────────────
    if (resolved.contact.crmMeta?.doNotSms) {
      return reply.code(400).send({
        error: "do_not_sms",
        detail: "This contact has opted out of SMS messages",
      });
    }

    const threadResult = await findOrCreateConnectChatSmsThread({
      tenantId: user.tenantId,
      userId: user.sub,
      externalPhone: resolved.toPhone,
      title: `CRM SMS ${selectContactDisplayName(resolved.contact)}`,
    });
    if (threadResult.ok === false) {
      return reply.code(threadResult.status).send({ error: threadResult.error, detail: threadResult.message });
    }

    const sendResult = await sendConnectChatSmsMessage({
      deps,
      user: chatUser,
      tenantId: user.tenantId,
      threadId: threadResult.threadId,
      body: message,
      type: "TEXT",
    });
    if (sendResult.ok === false) {
      return reply.code(sendResult.status).send({ error: sendResult.error, detail: sendResult.message });
    }

    // Timeline mirroring remains a convenience feed, not the SMS source of truth.
    await db.crmTimelineEvent.create({
      data: {
        tenantId: user.tenantId,
        contactId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: "SMS_SENT" as any,
        title: "SMS sent",
        body: message.substring(0, 500),
        metadata: {
          to: resolved.toPhone,
          from: threadResult.fromNumber,
          threadId: threadResult.threadId,
          connectChatMessageId: sendResult.messageId,
          ...(selectedTemplate ? { smsTemplateId: selectedTemplate.id } : {}),
        },
        linkedId: sendResult.messageId,
        createdByUserId: user.sub,
      },
    });

    if (selectedTemplate) {
      await (db as any).crmSmsTemplate.update({
        where: { id: selectedTemplate.id },
        data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
      }).catch(() => undefined);
    }

    return {
      ok: true,
      threadId: threadResult.threadId,
      messageId: sendResult.messageId,
      to: resolved.toPhone,
      from: threadResult.fromNumber,
      deliveryStatus: sendResult.deliveryStatus,
    };
  });
}
