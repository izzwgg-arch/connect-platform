import crypto from "node:crypto";
import { db } from "@connect/db";
import { canonicalSmsPhone } from "@connect/shared";
import type { WaInboundMessageEvent } from "@connect/shared/src/whatsappTypes";

export function normalizeWhatsAppE164(input: string): string {
  const raw = String(input || "").trim().replace(/^whatsapp:/i, "");
  const n = canonicalSmsPhone(raw);
  return n.ok ? n.e164 : raw;
}

export function buildDedupeKey(tenantId: string, accountKey: string, contactE164: string): string {
  return `wa:${tenantId}:${accountKey}:${contactE164}`;
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function buildFallbackExternalMessageId(ev: WaInboundMessageEvent): string {
  const provider = ev.provider;
  const tenantId = ev.tenantId;
  const accountRef = ev.accountRef || "";
  const from = normalizeWhatsAppE164(ev.from || "");
  const to = normalizeWhatsAppE164(ev.to || "");
  const ts = new Date(ev.timestamp || Date.now()).toISOString();
  const bodyNorm = String(ev.bodyText || "").replace(/\s+/g, " ").trim().toLowerCase();
  const bodyHash = sha256Hex(bodyNorm);
  const basis = `${provider}|${tenantId}|${accountRef}|${from}|${to}|${ts}|${bodyHash}`;
  return `fallback:${sha256Hex(basis)}`;
}

function accountKeyFromEvent(ev: WaInboundMessageEvent): string {
  // Meta: use phoneNumberId; Twilio: prefer 'to' e164, else accountRef
  if (ev.provider === "WHATSAPP_TWILIO") {
    const to = normalizeWhatsAppE164(ev.to || "");
    return to || ev.accountRef || "twilio:unknown";
  }
  return ev.accountRef || "meta:unknown";
}

async function upsertTenantWideParticipants(threadId: string, tenantId: string): Promise<void> {
  const users = await db.user.findMany({ where: { tenantId } });
  for (const u of users) {
    await db.connectChatParticipant.upsert({
      where: { threadId_participantKey: { threadId, participantKey: `u:${u.id}` } },
      create: { threadId, participantKey: `u:${u.id}`, userId: u.id, role: "MEMBER" },
      update: { leftAt: null },
    });
  }
}

export async function projectInboundToConnectChat(ev: WaInboundMessageEvent): Promise<void> {
  const enabled = String(process.env.WHATSAPP_PROJECT_TO_CONNECT_CHAT_ENABLED || "false").toLowerCase() === "true";
  if (!enabled) {
    console.info(JSON.stringify({ event: "WA_PROJECT_SKIPPED", reason: "flag_disabled" }));
    return;
  }

  const contact = normalizeWhatsAppE164(ev.from || "");
  const acctKey = accountKeyFromEvent(ev);
  const dedupeKey = buildDedupeKey(ev.tenantId, acctKey, contact);

  // Resolve or create thread first (by unique dedupeKey)
  let thread = await db.connectChatThread.findUnique({ where: { dedupeKey } });
  if (!thread) {
    thread = await db.connectChatThread.create({
      data: {
        tenantId: ev.tenantId,
        // Temporary until generated Prisma client includes WhatsApp chat fields from schema commit ee78362...
        type: "WHATSAPP" as any,
        title: `WA ${contact}`,
        dedupeKey,
        lastMessageAt: new Date(),
      },
    });
    await upsertTenantWideParticipants(thread.id, ev.tenantId);
  }

  const externalProvider = ev.provider;
  const externalMessageId = ev.externalMessageId && ev.externalMessageId.trim() ? ev.externalMessageId.trim() : buildFallbackExternalMessageId(ev);

  const existing = await db.connectChatMessage.findFirst({
    // Temporary until generated Prisma client includes WhatsApp chat fields from schema commit ee78362...
    where: ({ tenantId: ev.tenantId, externalProvider, externalMessageId } as unknown) as any,
    select: { id: true },
  });
  if (existing) {
    console.info(JSON.stringify({ event: "WA_PROJECT_DEDUPED", messageId: existing.id, dedupeKey }));
    return;
  }

  const isText = !!String(ev.bodyText || "").trim();
  const body = isText ? String(ev.bodyText).slice(0, 4096) : "[whatsapp media]";

  const created = await db.connectChatMessage.create({
    // Temporary until generated Prisma client includes WhatsApp chat fields from schema commit ee78362...
    data: ({
      tenantId: ev.tenantId,
      threadId: thread.id,
      direction: "INBOUND",
      type: isText ? "TEXT" : "FILE",
      body,
      providerStatus: "INBOUND",
      providerMetadata: ev.providerPayloadRedacted as any,
      externalProvider,
      externalMessageId,
    } as unknown) as any,
  });

  // Advance lastMessageAt conservatively
  const eventTs = new Date(ev.timestamp || Date.now());
  const newLastAt = eventTs.getTime() ? eventTs : created.createdAt;
  if (!thread.lastMessageAt || newLastAt > thread.lastMessageAt) {
    await db.connectChatThread.update({ where: { id: thread.id }, data: { lastMessageAt: newLastAt, updatedAt: new Date() } });
  }

  console.info(JSON.stringify({ event: "WA_PROJECT_CREATED", threadId: thread.id, messageId: created.id }));
}
