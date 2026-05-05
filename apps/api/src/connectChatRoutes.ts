/**
 * Connect unified chat: internal threads + VoIP.ms SMS.
 * Registered from server.ts — keeps PBX/voice code isolated.
 */

import * as crypto from "node:crypto";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import { z } from "zod";
import { db } from "@connect/db";
import { decryptJson, encryptJson, hasCredentialsMasterKey } from "@connect/security";
import { buildVoipMsSmsWebhookCallbackUrl, canonicalSmsPhone } from "@connect/shared";
import {
  buildChatAttachmentIdSignedDownloadUrl,
  buildChatSignedDownloadUrl,
  verifyChatAttachmentIdSignedDownload,
  verifyChatDbSignedDownload,
  verifyChatSignedDownload,
} from "@connect/shared/chatSignedUrl";
import { validateVoipMsCredentials, VoipMsSmsProvider } from "@connect/integrations";
import {
  assertStorageKeyForThread,
  isAllowedChatMime,
  maxBytesForThread,
  readChatAttachment,
  statChatAttachment,
  writeChatAttachmentFile,
} from "./chatAttachmentStorage";
import { fetchVoipMsMmsToChatFile } from "../../../packages/shared/src/voipMsInboundMms";
type JwtUser = { sub: string; tenantId: string; email: string; role: string };

function staff(user: JwtUser): string {
  return String(user.role || "USER");
}

function isSuper(user: JwtUser): boolean {
  return staff(user) === "SUPER_ADMIN";
}

function isTenantAdmin(user: JwtUser): boolean {
  return ["SUPER_ADMIN", "ADMIN"].includes(staff(user));
}

function canSendSmsRole(user: JwtUser): boolean {
  return ["SUPER_ADMIN", "ADMIN", "MESSAGING", "USER"].includes(staff(user));
}

function requireCrypto(reply: any): boolean {
  if (!hasCredentialsMasterKey()) {
    reply.status(503).send({ error: "CREDENTIAL_CRYPTO_UNAVAILABLE" });
    return false;
  }
  return true;
}

/** Effective Connect tenant for chat/SMS (honours super-admin x-tenant-context UUID). */
export function effectiveChatTenantId(req: any, user: JwtUser): string {
  if (isSuper(user)) {
    const ctx = String(req.headers["x-tenant-context"] || "").trim();
    if (ctx && !ctx.startsWith("vpbx:")) return ctx;
  }
  return user.tenantId;
}

async function getOrCreateGlobalVoipConfig() {
  const row = await db.globalVoipMsConfig.upsert({
    where: { id: "default" },
    create: { id: "default" },
    update: {},
  });
  return row;
}

type VoipMsStoredCreds = { username: string; password: string; apiBaseUrl?: string };
type ChatAttachmentInput = { storageKey: string; mimeType: string; sizeBytes: number; fileName: string };
type ChatDirectoryExtension = { id: string; extNumber: string; displayName: string; ownerUserId: string | null };

async function loadVoipMsCreds(): Promise<VoipMsStoredCreds | null> {
  const row = await db.globalVoipMsConfig.findUnique({ where: { id: "default" } });
  if (!row?.credentialsEncrypted) return null;
  try {
    return decryptJson<VoipMsStoredCreds>(row.credentialsEncrypted);
  } catch {
    return null;
  }
}

async function voipMsApiCall(method: string, extra: Record<string, string> = {}): Promise<any> {
  const row = await getOrCreateGlobalVoipConfig();
  const creds = await loadVoipMsCreds();
  if (!creds?.username || !creds?.password) throw new Error("VOIPMS_NOT_CONFIGURED");
  const base = (row.apiBaseUrl || creds.apiBaseUrl || "https://voip.ms/api/v1/rest.php").replace(/\/$/, "");
  const url = new URL(base);
  url.searchParams.set("api_username", creds.username);
  url.searchParams.set("api_password", creds.password);
  url.searchParams.set("method", method);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { method: "GET" });
  const json: any = await res.json().catch(() => ({}));
  return json;
}

function normalizeDidRow(raw: any): { did: string; e164: string; sms: boolean; mms: boolean; smsExplicit: boolean } | null {
  // Extract the DID number string from any of the field names VoIP.ms uses.
  const did = String(raw?.did ?? raw?.description ?? raw?.number ?? "").trim();
  if (!did) return null;
  const n = canonicalSmsPhone(did);
  if (!n.ok) return null;

  // Detect SMS capability across every field variant VoIP.ms has ever returned.
  // smsenabled="1"  — SMS routing is configured on this DID.
  // sms_available="1" — the DID hardware supports SMS (may not be configured yet).
  // sms_capable / smscapable — additional variants seen in reseller responses.
  // We treat ANY positive indicator as "SMS capable".
  const smsExplicit =
    raw?.smsenabled === "1" ||
    raw?.smsenabled === 1 ||
    raw?.sms_enabled === "1" ||
    raw?.sms === true ||
    raw?.sms === "1" ||
    String(raw?.sms ?? "").toLowerCase() === "yes" ||
    raw?.sms_available === "1" ||
    raw?.sms_available === 1 ||
    raw?.smsavailable === "1" ||
    raw?.smsavailable === 1 ||
    raw?.sms_capable === "1" ||
    raw?.sms_capable === 1 ||
    raw?.smscapable === "1" ||
    raw?.smscapable === 1;

  // If the API response has NO SMS field at all (field simply absent), we default
  // sms = true: VoIP.ms US/CA DIDs are SMS-capable unless explicitly restricted.
  const hasSmsField =
    raw?.smsenabled !== undefined ||
    raw?.sms_enabled !== undefined ||
    raw?.sms !== undefined ||
    raw?.sms_available !== undefined ||
    raw?.smsavailable !== undefined ||
    raw?.sms_capable !== undefined ||
    raw?.smscapable !== undefined;

  const sms = smsExplicit || !hasSmsField;

  const mms =
    raw?.mms === true ||
    raw?.mms === "1" ||
    raw?.mmsenabled === "1" ||
    raw?.mmsenabled === 1 ||
    raw?.mms_enabled === "1" ||
    raw?.mms_available === "1" ||
    raw?.mms_available === 1 ||
    String(raw?.mms ?? "").toLowerCase() === "yes";

  return { did, e164: n.e164, sms, mms, smsExplicit };
}

function smsDedupeKey(tenantId: string, tenantE164: string, externalE164: string, inboxOwnerUserId: string): string {
  return `sms:${tenantId}:${tenantE164}:${externalE164}:${inboxOwnerUserId || ""}`;
}

async function ensureDefaultTenantGroup(tenantId: string, tenantName: string) {
  const dk = `tg:${tenantId}`;
  let thread = await db.connectChatThread.findUnique({ where: { dedupeKey: dk } });
  if (!thread) {
    thread = await db.connectChatThread.create({
      data: {
        tenantId,
        type: "TENANT_GROUP",
        title: `${tenantName} — Tenant Group Chat`,
        dedupeKey: dk,
        isDefaultTenantGroup: true,
        lastMessageAt: new Date(),
      },
    });
  }
  const users = await db.user.findMany({ where: { tenantId }, select: { id: true } });
  for (const u of users) {
    const pk = `u:${u.id}`;
    await db.connectChatParticipant.upsert({
      where: { threadId_participantKey: { threadId: thread.id, participantKey: pk } },
      create: { threadId: thread.id, participantKey: pk, userId: u.id, role: "MEMBER" },
      update: { leftAt: null },
    });
  }
  return thread;
}

type ChatPushPayload =
  | { type: "dm_message"; conversationId: string; messageId: string; senderUserId: string; tenantId: string; senderName?: string | null; preview?: string | null; timestamp: string }
  | { type: "sms_message"; conversationId: string; messageId: string; phoneNumber: string; tenantId: string; preview?: string | null; timestamp: string };

export type ConnectChatRoutesDeps = {
  smsQueue: Queue;
  sendPushToUserDevices?: (input: { tenantId: string; userId: string; payload: ChatPushPayload; excludeDeviceId?: string | null }) => Promise<unknown>;
};

function publicChatDownloadBase(): string {
  const raw = process.env.PUBLIC_API_BASE_URL || process.env.API_PUBLIC_URL || process.env.PORTAL_PUBLIC_URL || "https://app.connectcomunications.com/api";
  return raw.replace(/\/+$/, "");
}

function pushPreview(body: string, fallback = "Sent an attachment"): string {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function extractInboundMmsUrls(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const s = String(v ?? "").trim();
    if (/^https?:\/\//i.test(s)) out.push(s);
  };
  const pushCommaUrls = (v: unknown) => {
    const s = String(v ?? "").trim();
    if (!s) return;
    for (const part of s.split(",")) push(part.trim());
  };
  const arr = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) push(x);
  };
  pushCommaUrls(payload.media);
  pushCommaUrls(payload.files);
  pushCommaUrls(payload.MEDIA);
  push(payload.media_url);
  push(payload.mediaurl);
  push(payload.MediaUrl);
  arr(payload.media_urls);
  arr(payload.attachments);
  for (let i = 1; i <= 6; i += 1) {
    push((payload as Record<string, unknown>)[`media${i}`]);
    push((payload as Record<string, unknown>)[`Media${i}`]);
    push((payload as Record<string, unknown>)[`col_media${i}`]);
    push((payload as Record<string, unknown>)[`Col_Media${i}`]);
  }
  return [...new Set(out)];
}

function inferAttachmentMessageType(attachments: Array<{ mimeType: string }>): "IMAGE" | "VIDEO" | "AUDIO" | "FILE" {
  const m = String(attachments[0]?.mimeType || "").toLowerCase();
  if (m.startsWith("image/")) return "IMAGE";
  if (m.startsWith("video/")) return "VIDEO";
  if (m.startsWith("audio/")) return "AUDIO";
  return "FILE";
}

function cleanAttachmentContentType(contentType?: string | null): string | null {
  const mime = String(contentType || "").split(";")[0].split(",")[0].trim().toLowerCase();
  return mime && isAllowedChatMime(mime) ? mime : null;
}

function inlineAttachmentDisposition(fileName?: string | null): string {
  const safeName = String(fileName || "attachment").replace(/["\r\n]/g, "").slice(0, 180) || "attachment";
  return `inline; filename="${safeName}"`;
}

/** RN multipart uploads often report application/octet-stream; infer from filename so MMS/UI type is correct. */
function inferMimeFromFilename(filename: string, reportedMime: string): string {
  const cur = String(reportedMime || "").toLowerCase().split(";")[0].trim();
  if (cur && cur !== "application/octet-stream") return cur;
  const ext = path.extname(String(filename || "")).toLowerCase();
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".csv": "text/csv",
  };
  return map[ext] || cur || "application/octet-stream";
}

function metadataObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function displayUserName(user: { email: string }): string {
  return user.email.split("@")[0] || user.email;
}

function threadKindLabel(type: string): string {
  if (type === "TENANT_GROUP") return "Tenant Group";
  if (type === "GROUP") return "Group";
  if (type === "DM") return "DM";
  if (type === "SMS") return "SMS";
  return "Chat";
}

function isMessageUnreadForUser(message: { senderUserId: string | null; createdAt: Date }, userId: string, lastReadAt?: Date | null): boolean {
  if (message.senderUserId === userId) return false;
  if (!lastReadAt) return true;
  return message.createdAt.getTime() > lastReadAt.getTime();
}

async function persistMessageAttachments(
  tenantId: string,
  threadId: string,
  messageId: string,
  rows: Array<{ storageKey: string; mimeType: string; sizeBytes: number; fileName: string }>,
): Promise<void> {
  for (const row of rows) {
    assertStorageKeyForThread(row.storageKey, tenantId, threadId);
    const st = await statChatAttachment(row.storageKey);
    if (!st) throw new Error("ATTACHMENT_NOT_FOUND");
    if (st.sizeBytes !== row.sizeBytes) throw new Error("SIZE_MISMATCH");
    await db.connectChatMessageAttachment.create({
      data: {
        messageId,
        tenantId,
        fileName: row.fileName,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        storageKey: row.storageKey,
        scanStatus: "pending",
      },
    });
  }
}

/** Persist VoIP.ms MMS URLs as normal chat attachments so mobile/web render voice/video reliably. */
async function mirrorVoipMsInboundMmsRows(input: {
  tenantId: string;
  threadId: string;
  messageId: string;
  urls: string[];
  log?: { warn?: (obj: object, msg?: string) => void };
}): Promise<void> {
  const urls = input.urls.filter((u) => /^https?:\/\//i.test(String(u || "").trim())).slice(0, 3);
  if (!urls.length) return;
  const existing = await db.connectChatMessageAttachment.count({ where: { messageId: input.messageId } });
  if (existing > 0) return;
  for (const url of urls) {
    const written = await fetchVoipMsMmsToChatFile({
      tenantId: input.tenantId,
      threadId: input.threadId,
      sourceUrl: url,
      isSmsThread: true,
    });
    if (!written) {
      input.log?.warn?.(
        { event: "voipms_inbound_mms_mirror_failed", messageId: input.messageId, urlPrefix: url.slice(0, 96) },
        "chat: inbound MMS mirror failed",
      );
      continue;
    }
    await db.connectChatMessageAttachment.create({
      data: {
        messageId: input.messageId,
        tenantId: input.tenantId,
        fileName: written.fileName,
        mimeType: written.mimeType,
        sizeBytes: written.sizeBytes,
        storageKey: written.storageKey,
        scanStatus: "pending",
      },
    });
  }
}

async function resolveOutboundSmsNumber(
  tenantId: string,
  userId: string,
  extensionId: string | null,
): Promise<{ row: { id: string; phoneE164: string } } | { error: string }> {
  if (extensionId) {
    const byExt = await db.tenantSmsNumber.findFirst({
      where: { tenantId, active: true, assignedExtensionId: extensionId },
      select: { id: true, phoneE164: true },
    });
    if (byExt) return { row: byExt };
  }
  const byUser = await db.tenantSmsNumber.findFirst({
    where: { tenantId, active: true, assignedUserId: userId },
    select: { id: true, phoneE164: true },
  });
  if (byUser) return { row: byUser };
  const tenantDefault = await db.tenantSmsNumber.findFirst({
    where: { tenantId, active: true, isTenantDefault: true },
    select: { id: true, phoneE164: true },
  });
  if (tenantDefault) return { row: tenantDefault };
  const any = await db.tenantSmsNumber.findFirst({
    where: { tenantId, active: true, assignedUserId: null, assignedExtensionId: null },
    select: { id: true, phoneE164: true },
    orderBy: { createdAt: "asc" },
  });
  if (any) return { row: any };
  return { error: "No SMS number assigned for this tenant or extension." };
}

async function resolveSmsInboxOwnerUserId(input: {
  tenantId: string;
  assignedUserId?: string | null;
  assignedExtensionId?: string | null;
}): Promise<string> {
  if (input.assignedUserId) return input.assignedUserId;
  if (!input.assignedExtensionId) return "";
  const extension = await db.extension.findFirst({
    where: { id: input.assignedExtensionId, tenantId: input.tenantId },
    select: { ownerUserId: true },
  });
  return extension?.ownerUserId || "";
}

async function upsertSmsThreadParticipants(input: {
  threadId: string;
  tenantId: string;
  inboxOwnerUserId: string;
  assignedExtensionId?: string | null;
}): Promise<void> {
  const users = input.inboxOwnerUserId
    ? await db.user.findMany({ where: { id: input.inboxOwnerUserId, tenantId: input.tenantId } })
    : await db.user.findMany({ where: { tenantId: input.tenantId } });
  for (const u of users) {
    await db.connectChatParticipant.upsert({
      where: { threadId_participantKey: { threadId: input.threadId, participantKey: `u:${u.id}` } },
      create: { threadId: input.threadId, participantKey: `u:${u.id}`, userId: u.id, role: "MEMBER" },
      update: { leftAt: null },
    });
  }
  if (input.assignedExtensionId) {
    await db.connectChatParticipant.upsert({
      where: { threadId_participantKey: { threadId: input.threadId, participantKey: `e:${input.assignedExtensionId}` } },
      create: {
        threadId: input.threadId,
        participantKey: `e:${input.assignedExtensionId}`,
        extensionId: input.assignedExtensionId,
        role: "MEMBER",
      },
      update: { leftAt: null },
    });
  }
}

export function registerConnectChatRoutes(app: FastifyInstance, deps: ConnectChatRoutesDeps): void {
  // Self-heal once at boot: if VoIP.ms credentials are configured but the
  // legacy `smsEnabled`/`mmsEnabled` flags are still false (default from the
  // initial schema), flip them on so the portal reflects reality. Send paths
  // no longer rely on these flags — this is purely cosmetic for the admin UI.
  void (async () => {
    try {
      const row = await db.globalVoipMsConfig.findUnique({ where: { id: "default" } });
      if (row?.credentialsEncrypted && (!row.smsEnabled || !row.mmsEnabled)) {
        await db.globalVoipMsConfig.update({
          where: { id: "default" },
          data: { smsEnabled: true, mmsEnabled: true, updatedAt: new Date() },
        });
      }
    } catch {
      // Non-fatal — ignore.
    }
  })();

  // Signed-URL download for chat bytes (VoIP.ms MMS media1..3, thumbnails). No JWT.
  app.get("/chat/attachments/download/*", async (req, reply) => {
    const wildcardPath = (req.params as any)["*"] as string | undefined;
    const storageKey = decodeURIComponent(String(wildcardPath || ""));
    if (!storageKey) return reply.code(400).send({ error: "missing_key" });
    const q = req.query as { exp?: string; sig?: string };
    let attachment: { id: string; sizeBytes: number; mimeType: string; fileName: string } | null = null;
    let verified = verifyChatSignedDownload(storageKey, q.exp, q.sig);
    if (!verified.ok && verified.reason === "invalid") {
      attachment = await db.connectChatMessageAttachment.findFirst({
        where: { storageKey },
        select: { id: true, sizeBytes: true, mimeType: true, fileName: true },
      });
      if (attachment) {
        verified = verifyChatDbSignedDownload(attachment.id, storageKey, attachment.sizeBytes, q.exp, q.sig);
      }
    }
    if (!verified.ok) return reply.code(401).send({ error: "bad_signature", reason: "reason" in verified ? verified.reason : "invalid" });
    try {
      if (!attachment) {
        attachment = await db.connectChatMessageAttachment.findFirst({
          where: { storageKey },
          select: { id: true, sizeBytes: true, mimeType: true, fileName: true },
        });
      }
      const stored = await readChatAttachment(storageKey);
      if (!stored) return reply.code(404).send({ error: "not_found" });
      if (stored.sizeBytes) reply.header("content-length", stored.sizeBytes);
      reply.header("content-type", cleanAttachmentContentType(attachment?.mimeType) || cleanAttachmentContentType(stored.contentType) || "application/octet-stream");
      if (attachment?.fileName) reply.header("content-disposition", inlineAttachmentDisposition(attachment.fileName));
      return reply.send(stored.body);
    } catch {
      return reply.code(400).send({ error: "invalid_key" });
    }
  });

  const handleAttachmentIdDownload = async (req: any, reply: any) => {
    const { attachmentId } = req.params as { attachmentId: string };
    const q = req.query as { e?: string; s?: string };
    const verified = verifyChatAttachmentIdSignedDownload(attachmentId, q.e, q.s);
    if (!verified.ok) return reply.code(401).send({ error: "bad_signature", reason: "reason" in verified ? verified.reason : "invalid" });
    const attachment = await db.connectChatMessageAttachment.findUnique({
      where: { id: attachmentId },
      select: { storageKey: true, mimeType: true, sizeBytes: true, fileName: true },
    });
    if (!attachment) return reply.code(404).send({ error: "not_found" });
    try {
      const stored = await readChatAttachment(attachment.storageKey);
      if (!stored) return reply.code(404).send({ error: "not_found" });
      if (stored.sizeBytes) reply.header("content-length", stored.sizeBytes);
      reply.header("content-type", cleanAttachmentContentType(attachment.mimeType) || cleanAttachmentContentType(stored.contentType) || "application/octet-stream");
      reply.header("content-disposition", inlineAttachmentDisposition(attachment.fileName));
      return reply.send(stored.body);
    } catch {
      return reply.code(400).send({ error: "invalid_key" });
    }
  };
  app.get("/chat/a/:attachmentId", handleAttachmentIdDownload);
  app.get("/chat/a/:attachmentId/:fileName", handleAttachmentIdDownload);

  // ── Chat threads (JWT) ─────────────────────────────────────────────────────
  app.get("/chat/threads", async (req, reply) => {
    const user = req.user as JwtUser;
    const tenantId = effectiveChatTenantId(req, user);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    if (!tenant) return reply.status(404).send({ error: "TENANT_NOT_FOUND" });

    await ensureDefaultTenantGroup(tenantId, tenant.name);

    const parts = await db.connectChatParticipant.findMany({
      where: {
        userId: user.sub,
        leftAt: null,
        thread: { tenantId, active: true },
      },
      include: {
        thread: {
          include: {
            messages: {
              where: { deletedForEveryoneAt: null },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { id: true, body: true, createdAt: true, type: true, senderUserId: true, deliveryStatus: true, deliveryError: true },
            },
            participants: {
              where: { leftAt: null },
              include: {
                user: { select: { id: true, email: true } },
                extension: { select: { id: true, extNumber: true, displayName: true } },
              },
            },
          },
        },
      },
      orderBy: { thread: { lastMessageAt: "desc" } },
    });

    const threads = await Promise.all(parts.map(async (p) => {
      const t = p.thread;
      const last = t.messages[0];
      const unread = await db.connectChatMessage.count({
        where: {
          threadId: t.id,
          deletedForEveryoneAt: null,
          senderUserId: { not: user.sub },
          createdAt: p.lastReadAt ? { gt: p.lastReadAt } : undefined,
        },
      });
      let participantName = t.title || "Chat";
      let participantExtension = "";
      if (t.type === "SMS") {
        participantName = t.externalSmsE164 || "SMS";
        participantExtension = t.tenantSmsE164 || "";
      } else if (t.type === "TENANT_GROUP") {
        participantName = t.title || "Tenant Group";
      } else if (t.type === "DM") {
        const peer = t.participants.find((row) => row.userId && row.userId !== user.sub);
        if (peer?.user) participantName = displayUserName(peer.user);
        if (peer?.extension) participantExtension = peer.extension.extNumber;
      } else if (t.type === "GROUP") {
        participantName = t.title || "Group Chat";
      }
      return {
        id: t.id,
        type: t.type,
        title: t.title,
        isDefaultTenantGroup: t.isDefaultTenantGroup,
        participantName,
        participantExtension,
        lastMessage: last?.body || (last?.type && last.type !== "TEXT" ? `[${String(last.type).toLowerCase()}]` : ""),
        lastAt: (last?.createdAt || t.lastMessageAt).toISOString(),
        unread,
        tenantSmsE164: t.tenantSmsE164,
        externalSmsE164: t.externalSmsE164,
        deliveryStatus: last?.deliveryStatus || null,
        deliveryError: last?.deliveryError || null,
      };
    }));
    threads.sort((a, b) => {
      if (a.isDefaultTenantGroup !== b.isDefaultTenantGroup) return a.isDefaultTenantGroup ? -1 : 1;
      return new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime();
    });

    return { threads };
  });

  app.get("/chat/directory", async (req, reply) => {
    const user = req.user as JwtUser;
    const tenantId = effectiveChatTenantId(req, user);
    const users = await db.user.findMany({
      where: { tenantId },
      select: { id: true, email: true, role: true },
      orderBy: { email: "asc" },
      take: 500,
    });
    const extensions = await db.extension.findMany({
      where: { tenantId, status: "ACTIVE" },
      select: { id: true, extNumber: true, displayName: true, ownerUserId: true },
      orderBy: { extNumber: "asc" },
      take: 500,
    });
    const byOwner = new Map<string, ChatDirectoryExtension>(
      (extensions as ChatDirectoryExtension[]).filter((e) => e.ownerUserId).map((e) => [e.ownerUserId!, e]),
    );
    return {
      users: users.map((u) => {
        const ext = byOwner.get(u.id);
        return {
          id: u.id,
          name: displayUserName(u),
          email: u.email,
          role: u.role,
          extensionId: ext?.id || null,
          extensionNumber: ext?.extNumber || null,
          extensionName: ext?.displayName || null,
          self: u.id === user.sub,
        };
      }),
      extensions: extensions.map((e) => ({
        id: e.id,
        extNumber: e.extNumber,
        displayName: e.displayName,
        ownerUserId: e.ownerUserId,
      })),
    };
  });

  app.post("/chat/threads", async (req, reply) => {
    const user = req.user as JwtUser;
    const tenantId = effectiveChatTenantId(req, user);
    const body = z
      .object({
        type: z.enum(["dm", "sms", "group"]),
        peerUserId: z.string().optional(),
        peerUserIds: z.array(z.string()).max(100).optional(),
        extensionIds: z.array(z.string()).max(100).optional(),
        externalPhone: z.string().optional(),
        title: z.string().optional(),
      })
      .parse(req.body || {});

    if (body.type === "dm") {
      if (!body.peerUserId) return reply.status(400).send({ error: "peerUserId required" });
      const peer = await db.user.findFirst({
        where: { id: body.peerUserId, tenantId },
        select: { id: true, email: true },
      });
      if (!peer) return reply.status(404).send({ error: "PEER_NOT_FOUND" });
      const a = user.sub;
      const b = peer.id;
      const [x, y] = a < b ? [a, b] : [b, a];
      const dk = `dm:${tenantId}:${x}:${y}`;
      let thread = await db.connectChatThread.findUnique({ where: { dedupeKey: dk } });
      if (!thread) {
        thread = await db.connectChatThread.create({
          data: {
            tenantId,
            type: "DM",
            title: body.title || `DM: ${peer.email}`,
            dedupeKey: dk,
            createdByUserId: user.sub,
            lastMessageAt: new Date(),
          },
        });
        for (const [uid, pk] of [
          [user.sub, `u:${user.sub}`],
          [peer.id, `u:${peer.id}`],
        ] as const) {
          await db.connectChatParticipant.create({
            data: { threadId: thread.id, participantKey: pk, userId: uid, role: "MEMBER" },
          });
        }
      }
      return { threadId: thread.id };
    }

    if (body.type === "group") {
      const peerIds = [...new Set([...(body.peerUserIds || []), ...(body.peerUserId ? [body.peerUserId] : [])])].filter((id) => id !== user.sub);
      const extensionIds = [...new Set(body.extensionIds || [])];
      if (peerIds.length === 0 && extensionIds.length === 0) {
        return reply.status(400).send({ error: "participants required" });
      }
      const peers = peerIds.length
        ? await db.user.findMany({ where: { id: { in: peerIds }, tenantId }, select: { id: true, email: true } })
        : [];
      if (peers.length !== peerIds.length) return reply.status(404).send({ error: "PEER_NOT_FOUND" });
      const extensions = extensionIds.length
        ? await db.extension.findMany({ where: { id: { in: extensionIds }, tenantId, status: "ACTIVE" }, select: { id: true, extNumber: true } })
        : [];
      if (extensions.length !== extensionIds.length) return reply.status(404).send({ error: "EXTENSION_NOT_FOUND" });

      const title = (body.title || "").trim() || `Group: ${peers.slice(0, 3).map(displayUserName).join(", ") || "Extensions"}`;
      const thread = await db.connectChatThread.create({
        data: {
          tenantId,
          type: "GROUP",
          title: title.slice(0, 120),
          dedupeKey: `group:${tenantId}:${crypto.randomUUID()}`,
          createdByUserId: user.sub,
          lastMessageAt: new Date(),
        },
      });
      await db.connectChatParticipant.create({
        data: { threadId: thread.id, participantKey: `u:${user.sub}`, userId: user.sub, role: "OWNER" },
      });
      for (const peer of peers) {
        await db.connectChatParticipant.upsert({
          where: { threadId_participantKey: { threadId: thread.id, participantKey: `u:${peer.id}` } },
          create: { threadId: thread.id, participantKey: `u:${peer.id}`, userId: peer.id, role: "MEMBER" },
          update: { leftAt: null },
        });
      }
      for (const ext of extensions) {
        await db.connectChatParticipant.upsert({
          where: { threadId_participantKey: { threadId: thread.id, participantKey: `e:${ext.id}` } },
          create: { threadId: thread.id, participantKey: `e:${ext.id}`, extensionId: ext.id, role: "MEMBER" },
          update: { leftAt: null },
        });
      }
      return { threadId: thread.id };
    }

    if (body.type === "sms") {
      if (!canSendSmsRole(user)) return reply.status(403).send({ error: "FORBIDDEN" });
      if (!body.externalPhone) return reply.status(400).send({ error: "externalPhone required" });
      const extNorm = canonicalSmsPhone(body.externalPhone);
      if (!extNorm.ok) return reply.status(400).send({ error: "INVALID_PHONE", detail: "error" in extNorm ? extNorm.error : "invalid phone" });

      const extLink = await db.extension.findFirst({
        where: { tenantId, ownerUserId: user.sub, status: "ACTIVE" },
        select: { id: true },
      });
      const fromPick = await resolveOutboundSmsNumber(tenantId, user.sub, extLink?.id ?? null);
      if ("error" in fromPick) return reply.status(400).send({ error: "NO_SMS_NUMBER", message: fromPick.error });

      const assign = await db.tenantSmsNumber.findFirst({
        where: { id: fromPick.row.id, tenantId },
        select: { assignedUserId: true, assignedExtensionId: true },
      });
      const resolvedInboxOwner = await resolveSmsInboxOwnerUserId({
        tenantId,
        assignedUserId: assign?.assignedUserId || null,
        assignedExtensionId: assign?.assignedExtensionId || null,
      });
      const inboxScope = resolvedInboxOwner === user.sub ? user.sub : "";

      const dk = smsDedupeKey(tenantId, fromPick.row.phoneE164, extNorm.e164, inboxScope);
      let thread = await db.connectChatThread.findUnique({ where: { dedupeKey: dk } });
      if (!thread) {
        thread = await db.connectChatThread.create({
          data: {
            tenantId,
            type: "SMS",
            title: `SMS ${extNorm.e164}`,
            dedupeKey: dk,
            tenantSmsE164: fromPick.row.phoneE164,
            tenantSmsRaw: body.externalPhone,
            externalSmsE164: extNorm.e164,
            externalSmsRaw: body.externalPhone,
            smsInboxOwnerUserId: inboxScope,
            createdByUserId: user.sub,
            lastMessageAt: new Date(),
          },
        });
        await db.connectChatParticipant.create({
          data: { threadId: thread.id, participantKey: `u:${user.sub}`, userId: user.sub, role: "OWNER" },
        });
        if (assign?.assignedExtensionId) {
          await db.connectChatParticipant.upsert({
            where: { threadId_participantKey: { threadId: thread.id, participantKey: `e:${assign.assignedExtensionId}` } },
            create: {
              threadId: thread.id,
              participantKey: `e:${assign.assignedExtensionId}`,
              extensionId: assign.assignedExtensionId,
              role: "MEMBER",
            },
            update: { leftAt: null },
          });
        }
      }
      return { threadId: thread.id, normalizedTo: extNorm.e164, fromNumber: fromPick.row.phoneE164 };
    }

    return reply.status(400).send({ error: "UNSUPPORTED_TYPE" });
  });

  app.post("/chat/threads/:threadId/attachments/upload", async (req, reply) => {
    const user = req.user as JwtUser;
    const { threadId } = req.params as { threadId: string };
    const tenantId = effectiveChatTenantId(req, user);
    const part = await db.connectChatParticipant.findFirst({
      where: { threadId, userId: user.sub, leftAt: null, thread: { tenantId } },
      include: { thread: true },
    });
    if (!part) return reply.status(404).send({ error: "THREAD_NOT_FOUND" });
    if (!(req as any).isMultipart?.()) return reply.status(400).send({ error: "multipart_required" });

    let fileBuf: Buffer | null = null;
    let originalFilename = "file";
    let mimeType = "application/octet-stream";
    try {
      const parts = (req as any).parts();
      for await (const p of parts) {
        if (p.type === "file" && p.fieldname === "file") {
          originalFilename = String(p.filename || originalFilename);
          mimeType = String(p.mimetype || mimeType);
          fileBuf = await p.toBuffer();
          break;
        }
      }
    } catch (err: any) {
      return reply.status(400).send({ error: "multipart_parse_failed", detail: err?.message });
    }
    if (!fileBuf || fileBuf.length === 0) return reply.status(400).send({ error: "file_required" });
    mimeType = inferMimeFromFilename(originalFilename, mimeType);
    if (!isAllowedChatMime(mimeType)) return reply.status(400).send({ error: "MIME_NOT_ALLOWED" });

    const maxB = maxBytesForThread(part.thread.type === "SMS");
    try {
      const written = await writeChatAttachmentFile({
        tenantKey: tenantId,
        threadId,
        originalFilename,
        buffer: fileBuf,
        mimeType,
        maxBytes: maxB,
      });
      return { ok: true, ...written };
    } catch (e: any) {
      const m = String(e?.message || e);
      if (m === "mime_not_allowed") {
        req.log?.warn?.({ event: "chat_attachment_validation_failed", reason: "mime_not_allowed", tenantId, threadId, mimeType });
        return reply.status(400).send({ error: "MIME_NOT_ALLOWED" });
      }
      if (m === "file_too_large") {
        req.log?.warn?.({ event: "chat_attachment_validation_failed", reason: "file_too_large", tenantId, threadId, sizeBytes: fileBuf?.length ?? 0, limitBytes: maxB });
        return reply.status(400).send({ error: "FILE_TOO_LARGE" });
      }
      throw e;
    }
  });

  app.get("/chat/threads/:threadId/messages", async (req, reply) => {
    const user = req.user as JwtUser;
    const { threadId } = req.params as { threadId: string };
    const tenantId = effectiveChatTenantId(req, user);
    const part = await db.connectChatParticipant.findFirst({
      where: { threadId, userId: user.sub, leftAt: null, thread: { tenantId } },
    });
    if (!part) return reply.status(404).send({ error: "THREAD_NOT_FOUND" });
    const [rowsRaw, threadRow] = await Promise.all([
      db.connectChatMessage.findMany({
        where: { threadId },
        orderBy: { createdAt: "asc" },
        take: 200,
        include: {
          reactions: true,
          senderUser: { select: { email: true } },
          attachments: { orderBy: { createdAt: "asc" } },
          replyTo: { select: { id: true, body: true, type: true, senderUser: { select: { email: true } } } },
        },
      }),
      db.connectChatThread.findUnique({ where: { id: threadId }, select: { type: true, externalSmsE164: true } }),
    ]);
    const readParts = await db.connectChatParticipant.findMany({
      where: { threadId, leftAt: null, userId: { not: null } },
      include: { user: { select: { id: true, email: true } } },
    });
    const rows = rowsRaw.filter((m) => {
      const deletedFor = Array.isArray(m.deletedForUserIds) ? m.deletedForUserIds as unknown[] : [];
      return !deletedFor.includes(user.sub);
    });
    const base = publicChatDownloadBase();
    const messages = rows.map((m) => {
      const meta = metadataObject(m.metadata);
      const mmsUrls = Array.isArray(meta?.mms?.urls) ? meta!.mms!.urls! : [];
      const deletedForEveryone = Boolean(m.deletedForEveryoneAt);
      return {
        id: m.id,
        threadId: m.threadId,
        senderId: m.senderUserId || "",
        senderName: m.senderUser?.email?.split("@")[0] || (threadRow?.type === "SMS" && !m.senderUserId ? threadRow.externalSmsE164 || "SMS" : "System"),
        body: deletedForEveryone ? "" : m.body,
        sentAt: m.createdAt.toISOString(),
        mine: m.senderUserId === user.sub,
        type: m.type,
        editedAt: m.editedAt?.toISOString() || null,
        deletedForEveryoneAt: m.deletedForEveryoneAt?.toISOString() || null,
        deliveryStatus: m.deliveryStatus,
        deliveryError: m.deliveryError,
        reactions: m.reactions,
        mmsUrls,
        location: meta.location || null,
        replyTo: m.replyTo
          ? {
              id: m.replyTo.id,
              body: m.replyTo.body,
              type: m.replyTo.type,
              senderName: m.replyTo.senderUser?.email?.split("@")[0] || "System",
            }
          : null,
        readBy: readParts
          .filter((p) => p.userId !== m.senderUserId && p.lastReadAt && p.lastReadAt.getTime() >= m.createdAt.getTime())
          .map((p) => ({ userId: p.userId || "", name: p.user?.email?.split("@")[0] || "User", readAt: p.lastReadAt!.toISOString() })),
        attachments: (m.attachments || []).map((a) => ({
          id: a.id,
          fileName: a.fileName,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          scanStatus: a.scanStatus,
          downloadUrl: base ? buildChatSignedDownloadUrl(base, a.storageKey, 900) : null,
        })),
      };
    });
    return { messages };
  });

  app.post("/chat/threads/:threadId/read", async (req, reply) => {
    const user = req.user as JwtUser;
    const { threadId } = req.params as { threadId: string };
    const tenantId = effectiveChatTenantId(req, user);
    const part = await db.connectChatParticipant.findFirst({
      where: { threadId, userId: user.sub, leftAt: null, thread: { tenantId } },
      select: { id: true },
    });
    if (!part) return reply.status(404).send({ error: "THREAD_NOT_FOUND" });
    const now = new Date();
    await db.connectChatParticipant.update({ where: { id: part.id }, data: { lastReadAt: now } });
    return { ok: true, lastReadAt: now.toISOString() };
  });

  app.post("/chat/threads/:threadId/typing", async (req, reply) => {
    const user = req.user as JwtUser;
    const { threadId } = req.params as { threadId: string };
    const tenantId = effectiveChatTenantId(req, user);
    const input = z.object({ typing: z.boolean().default(true) }).parse(req.body || {});
    const part = await db.connectChatParticipant.findFirst({
      where: { threadId, userId: user.sub, leftAt: null, thread: { tenantId } },
      select: { id: true },
    });
    if (!part) return reply.status(404).send({ error: "THREAD_NOT_FOUND" });
    const until = input.typing ? new Date(Date.now() + 5000) : null;
    await db.connectChatParticipant.update({ where: { id: part.id }, data: { typingUntil: until } });
    return { ok: true, typingUntil: until?.toISOString() || null };
  });

  app.get("/chat/threads/:threadId/typing", async (req, reply) => {
    const user = req.user as JwtUser;
    const { threadId } = req.params as { threadId: string };
    const tenantId = effectiveChatTenantId(req, user);
    const part = await db.connectChatParticipant.findFirst({
      where: { threadId, userId: user.sub, leftAt: null, thread: { tenantId } },
      select: { id: true },
    });
    if (!part) return reply.status(404).send({ error: "THREAD_NOT_FOUND" });
    const rows = await db.connectChatParticipant.findMany({
      where: {
        threadId,
        leftAt: null,
        userId: { not: user.sub },
        typingUntil: { gt: new Date() },
      },
      include: { user: { select: { id: true, email: true } } },
      take: 5,
    });
    return {
      users: rows.map((p) => ({
        userId: p.userId,
        name: p.user?.email?.split("@")[0] || "User",
        typingUntil: p.typingUntil?.toISOString() || null,
      })),
    };
  });

  app.post("/chat/threads/:threadId/messages", async (req, reply) => {
    const user = req.user as JwtUser;
    const { threadId } = req.params as { threadId: string };
    const tenantId = effectiveChatTenantId(req, user);
    const part = await db.connectChatParticipant.findFirst({
      where: { threadId, userId: user.sub, leftAt: null, thread: { tenantId } },
    });
    if (!part) return reply.status(404).send({ error: "THREAD_NOT_FOUND" });

    const attachmentSchema = z.object({
      storageKey: z.string().min(3).max(512),
      mimeType: z.string().min(1).max(128),
      sizeBytes: z.number().int().positive().max(60_000_000),
      fileName: z.string().min(1).max(256),
    });

    const input = z
      .object({
        body: z.string().max(16000).default(""),
        type: z.enum(["TEXT", "VOICE_NOTE", "IMAGE", "VIDEO", "AUDIO", "FILE", "LOCATION"]).optional(),
        replyToMessageId: z.string().optional(),
        location: z.object({
          lat: z.number(),
          lng: z.number(),
          label: z.string().max(500).optional(),
          address: z.string().max(1000).optional(),
        }).optional(),
        attachments: z.array(attachmentSchema).max(3).optional(),
      })
      .parse(req.body || {});

    const thread = await db.connectChatThread.findFirst({ where: { id: threadId, tenantId } });
    if (!thread) return reply.status(404).send({ error: "THREAD_NOT_FOUND" });
    if (input.replyToMessageId) {
      const replyTo = await db.connectChatMessage.findFirst({
        where: { id: input.replyToMessageId, threadId, tenantId },
        select: { id: true },
      });
      if (!replyTo) return reply.status(400).send({ error: "INVALID_REPLY_TO" });
    }

    if (thread.type === "SMS") {
      if (!canSendSmsRole(user)) return reply.status(403).send({ error: "FORBIDDEN" });
      const ext = thread.externalSmsE164;
      const tenantDid = thread.tenantSmsE164;
      if (!ext || !tenantDid) return reply.status(400).send({ error: "SMS_THREAD_INCOMPLETE" });

      const creds = await loadVoipMsCreds();
      if (!creds) return reply.status(503).send({ error: "VOIPMS_NOT_CONFIGURED" });
      const cfg = await getOrCreateGlobalVoipConfig();
      // Treat connected VoIP.ms credentials + an assigned tenant DID as
      // authority that SMS is available. The legacy `smsEnabled` boolean
      // remains as an admin override; only honour it when explicitly false.
      // Same for MMS — handled later via the per-number `mmsCapable` check.

      const atts = (input.attachments || []) as ChatAttachmentInput[];
      let smsLinkFallback = false;
      if (atts.length > 0) {
        const smsRow = await db.tenantSmsNumber.findFirst({ where: { phoneE164: tenantDid, tenantId } });
        const mmsOk = cfg.mmsEnabled && smsRow?.mmsCapable;
        // Only fall back before enqueue when the DID cannot send MMS at all.
        // Audio/voice notes must reach the worker so it can convert to a
        // carrier-friendly m4a and attempt true VoIP.ms MMS first.
        if (!mmsOk) {
          if (!publicChatDownloadBase()) {
            return reply.status(400).send({ error: "MEDIA_LINK_BASE_UNAVAILABLE", message: "Set PUBLIC_API_BASE_URL or PORTAL_PUBLIC_URL to send secure media links by SMS." });
          }
          smsLinkFallback = true;
        }
      }

      const msgType =
        smsLinkFallback ? "TEXT" : atts.length > 0 ? inferAttachmentMessageType(atts) : ((input.type as any) || "TEXT");

      const msg = await db.connectChatMessage.create({
        data: {
          tenantId,
          threadId,
          senderUserId: user.sub,
          direction: "OUTBOUND",
          type: msgType,
          body: input.body,
          replyToMessageId: input.replyToMessageId,
          metadata: input.location ? { location: input.location } : smsLinkFallback ? { smsLinkFallback: true } : undefined,
          deliveryStatus: "queued",
          deliveryError: null,
        },
      });
      try {
        if (atts.length) await persistMessageAttachments(tenantId, threadId, msg.id, atts);
      } catch (e: any) {
        const code = String(e?.message || e);
        await db.connectChatMessage.delete({ where: { id: msg.id } }).catch(() => {});
        if (code === "ATTACHMENT_NOT_FOUND" || code === "INVALID_STORAGE_KEY" || code === "SIZE_MISMATCH") {
          return reply.status(400).send({ error: code });
        }
        throw e;
      }
      if (smsLinkFallback && atts.length) {
        const base = publicChatDownloadBase();
        const persistedAttachments = await db.connectChatMessageAttachment.findMany({
          where: { messageId: msg.id, tenantId },
          select: { id: true, fileName: true },
          orderBy: { createdAt: "asc" },
        });
        const links = persistedAttachments.map((a) => buildChatAttachmentIdSignedDownloadUrl(base, a.id, 86400, a.fileName));
        const fallbackBody = [input.body.trim(), ...links.map((link) => `Media: ${link}`)].filter(Boolean).join("\n");
        await db.connectChatMessage.update({
          where: { id: msg.id },
          data: {
            body: fallbackBody,
            metadata: { ...(input.location ? { location: input.location } : {}), smsLinkFallback: true, smsMediaLinks: links },
          },
        });
      }

      await db.connectChatThread.update({
        where: { id: threadId },
        data: { lastMessageAt: new Date(), updatedAt: new Date() },
      });

      await deps.smsQueue.add(
        "send",
        { kind: "CONNECT_CHAT" as const, connectChatMessageId: msg.id, tenantId },
        { removeOnComplete: true, attempts: 12, backoff: { type: "exponential", delay: 5000 } },
      );

      return { ok: true, messageId: msg.id, deliveryStatus: "queued" };
    }

    const internalAttachments = (input.attachments || []) as ChatAttachmentInput[];
    const msgType =
      internalAttachments.length > 0
        ? inferAttachmentMessageType(internalAttachments)
        : ((input.type as any) || "TEXT");

    const msg = await db.connectChatMessage.create({
      data: {
        tenantId,
        threadId,
        senderUserId: user.sub,
        direction: "INTERNAL",
        type: msgType,
        body: input.body,
        replyToMessageId: input.replyToMessageId,
        metadata: input.location ? { location: input.location } : undefined,
        deliveryStatus: "sent",
      },
    });
    try {
      if (internalAttachments.length) await persistMessageAttachments(tenantId, threadId, msg.id, internalAttachments);
    } catch (e: any) {
      const code = String(e?.message || e);
      await db.connectChatMessage.delete({ where: { id: msg.id } }).catch(() => {});
      if (code === "ATTACHMENT_NOT_FOUND" || code === "INVALID_STORAGE_KEY" || code === "SIZE_MISMATCH") {
        return reply.status(400).send({ error: code });
      }
      throw e;
    }
    await db.connectChatThread.update({
      where: { id: threadId },
      data: { lastMessageAt: new Date(), updatedAt: new Date() },
    });
    if (deps.sendPushToUserDevices) {
      const sender = await db.user.findUnique({ where: { id: user.sub }, select: { displayName: true, email: true } });
      const recipients = await db.connectChatParticipant.findMany({
        where: {
          threadId,
          leftAt: null,
          muted: false,
          userId: { not: null },
          NOT: { userId: user.sub },
        },
        select: { userId: true },
      });
      await Promise.all(recipients.map((recipient) =>
        recipient.userId
          ? deps.sendPushToUserDevices!({
              tenantId,
              userId: recipient.userId,
              payload: {
                type: "dm_message",
                conversationId: threadId,
                messageId: msg.id,
                senderUserId: user.sub,
                tenantId,
                senderName: sender?.displayName || sender?.email || "New message",
                preview: pushPreview(input.body, internalAttachments.length ? "Sent an attachment" : "Sent a message"),
                timestamp: new Date().toISOString(),
              },
            }).catch((err: any) => app.log.warn({ err: err?.message, threadId, messageId: msg.id }, "chat-push: dm failed"))
          : Promise.resolve(),
      ));
    }
    return { ok: true, messageId: msg.id };
  });

  app.post("/chat/threads/:threadId/messages/:messageId/reactions", async (req, reply) => {
    const user = req.user as JwtUser;
    const { threadId, messageId } = req.params as { threadId: string; messageId: string };
    const tenantId = effectiveChatTenantId(req, user);
    const part = await db.connectChatParticipant.findFirst({
      where: { threadId, userId: user.sub, leftAt: null, thread: { tenantId } },
    });
    if (!part) return reply.status(404).send({ error: "THREAD_NOT_FOUND" });
    const { emoji } = z.object({ emoji: z.string().min(1).max(32) }).parse(req.body || {});
    const message = await db.connectChatMessage.findFirst({ where: { id: messageId, threadId, tenantId }, select: { id: true } });
    if (!message) return reply.status(404).send({ error: "MESSAGE_NOT_FOUND" });
    await db.connectChatMessageReaction.deleteMany({ where: { messageId, userId: user.sub, emoji: { not: emoji } } });
    const n = await db.connectChatMessageReaction.count({ where: { messageId, userId: user.sub, emoji } });
    if (n > 0) {
      await db.connectChatMessageReaction.updateMany({
        where: { messageId, userId: user.sub, emoji },
        data: { updatedAt: new Date() },
      });
    } else {
      await db.connectChatMessageReaction.create({ data: { messageId, userId: user.sub, emoji } });
    }
    return { ok: true };
  });

  app.delete("/chat/threads/:threadId/messages/:messageId/reactions/:emoji", async (req, reply) => {
    const user = req.user as JwtUser;
    const { threadId, messageId, emoji } = req.params as { threadId: string; messageId: string; emoji: string };
    const tenantId = effectiveChatTenantId(req, user);
    const part = await db.connectChatParticipant.findFirst({
      where: { threadId, userId: user.sub, leftAt: null, thread: { tenantId } },
    });
    if (!part) return reply.status(404).send({ error: "THREAD_NOT_FOUND" });
    const dec = decodeURIComponent(emoji);
    await db.connectChatMessageReaction.deleteMany({ where: { messageId, userId: user.sub, emoji: dec } });
    return { ok: true };
  });

  app.delete("/chat/threads/:threadId/messages/:messageId", async (req, reply) => {
    const user = req.user as JwtUser;
    const { threadId, messageId } = req.params as { threadId: string; messageId: string };
    const tenantId = effectiveChatTenantId(req, user);
    const mode = z.object({ mode: z.enum(["me", "everyone"]).default("me") }).parse(req.query || {}).mode;
    const part = await db.connectChatParticipant.findFirst({
      where: { threadId, userId: user.sub, leftAt: null, thread: { tenantId } },
    });
    if (!part) return reply.status(404).send({ error: "THREAD_NOT_FOUND" });
    const msg = await db.connectChatMessage.findFirst({ where: { id: messageId, threadId, tenantId } });
    if (!msg) return reply.status(404).send({ error: "MESSAGE_NOT_FOUND" });

    if (mode === "everyone") {
      if (msg.senderUserId !== user.sub && !isTenantAdmin(user)) return reply.status(403).send({ error: "FORBIDDEN" });
      await db.connectChatMessage.update({
        where: { id: messageId },
        data: { deletedForEveryoneAt: new Date(), body: "", updatedAt: new Date() },
      });
      return { ok: true, mode };
    }

    const current = Array.isArray(msg.deletedForUserIds) ? msg.deletedForUserIds as unknown[] : [];
    const next = [...new Set([...current.map(String), user.sub])];
    await db.connectChatMessage.update({
      where: { id: messageId },
      data: { deletedForUserIds: next, updatedAt: new Date() },
    });
    return { ok: true, mode };
  });

  app.patch("/chat/threads/:threadId/messages/:messageId", async (req, reply) => {
    const user = req.user as JwtUser;
    const { threadId, messageId } = req.params as { threadId: string; messageId: string };
    const tenantId = effectiveChatTenantId(req, user);
    const msg = await db.connectChatMessage.findFirst({
      where: { id: messageId, threadId, tenantId, senderUserId: user.sub, deletedForEveryoneAt: null },
    });
    if (!msg) return reply.status(404).send({ error: "NOT_FOUND" });
    if (msg.type !== "TEXT") return reply.status(400).send({ error: "CANNOT_EDIT_TYPE" });
    const { body } = z.object({ body: z.string().min(1).max(16000) }).parse(req.body || {});
    await db.connectChatMessage.update({
      where: { id: messageId },
      data: { body, editedAt: new Date(), updatedAt: new Date() },
    });
    return { ok: true };
  });

  // ── VoIP.ms admin (Apps) ────────────────────────────────────────────────────
  app.get("/admin/apps/voip-ms/overview", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!isSuper(user) && !isTenantAdmin(user)) return reply.status(403).send({ error: "FORBIDDEN" });
    if (!requireCrypto(reply)) return;
    const cfg = await getOrCreateGlobalVoipConfig();
    const creds = await loadVoipMsCreds();
    const baseUrl = process.env.PUBLIC_API_BASE_URL || process.env.PORTAL_PUBLIC_URL || "";
    const webhookUrl = baseUrl
      ? buildVoipMsSmsWebhookCallbackUrl(baseUrl)
      : "(set PUBLIC_API_BASE_URL for full URL — must be the HTTPS origin VoIP.ms can reach)";
    return {
      hasCredentials: !!(creds?.username && creds?.password),
      usernameHint: creds?.username ? `${creds.username.slice(0, 3)}…` : null,
      smsEnabled: cfg.smsEnabled,
      mmsEnabled: cfg.mmsEnabled,
      lastHealthOk: cfg.lastHealthOk,
      lastHealthAt: cfg.lastHealthAt?.toISOString() || null,
      lastHealthMessage: cfg.lastHealthMessage,
      lastDidsSyncAt: cfg.lastDidsSyncAt?.toISOString() || null,
      webhookUrl,
      webhookUrlNote:
        "Paste this entire URL into VoIP.ms → DID → SMS/MMS URL callback. Keep the {FROM}, {TO}, … placeholders exactly — VoIP.ms fills them on each inbound message (per VoIP.ms SMS-MMS wiki).",
    };
  });

  app.put("/admin/apps/voip-ms/credentials", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!isSuper(user)) return reply.status(403).send({ error: "FORBIDDEN" });
    if (!requireCrypto(reply)) return;
    const body = z
      .object({
        username: z.string().min(1),
        password: z.string().min(1),
        apiBaseUrl: z.string().url().optional(),
        webhookSecret: z.string().optional(),
      })
      .parse(req.body || {});

    const enc = encryptJson({ username: body.username, password: body.password, apiBaseUrl: body.apiBaseUrl });
    const wh = body.webhookSecret ? encryptJson({ secret: body.webhookSecret }) : null;
    await db.globalVoipMsConfig.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        credentialsEncrypted: enc,
        apiBaseUrl: body.apiBaseUrl || null,
        webhookSecretEncrypted: wh,
        smsEnabled: true,
        mmsEnabled: true,
      },
      update: {
        credentialsEncrypted: enc,
        apiBaseUrl: body.apiBaseUrl || null,
        ...(wh ? { webhookSecretEncrypted: wh } : {}),
        smsEnabled: true,
        mmsEnabled: true,
        updatedAt: new Date(),
      },
    });
    return { ok: true };
  });

  app.post("/admin/apps/voip-ms/flags", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!isSuper(user)) return reply.status(403).send({ error: "FORBIDDEN" });
    const body = z.object({ smsEnabled: z.boolean().optional(), mmsEnabled: z.boolean().optional() }).parse(req.body || {});
    await db.globalVoipMsConfig.update({
      where: { id: "default" },
      data: {
        ...(body.smsEnabled !== undefined ? { smsEnabled: body.smsEnabled } : {}),
        ...(body.mmsEnabled !== undefined ? { mmsEnabled: body.mmsEnabled } : {}),
        updatedAt: new Date(),
      },
    });
    return { ok: true };
  });

  app.post("/admin/apps/voip-ms/test", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!isSuper(user)) return reply.status(403).send({ error: "FORBIDDEN" });
    if (!requireCrypto(reply)) return;
    const creds = await loadVoipMsCreds();
    if (!creds) return reply.status(400).send({ error: "NOT_CONFIGURED" });
    const cfg = await getOrCreateGlobalVoipConfig();
    const probe = await validateVoipMsCredentials({
      username: creds.username,
      password: creds.password,
      fromNumber: "+15555550100",
      apiBaseUrl: cfg.apiBaseUrl || creds.apiBaseUrl,
    });
    const now = new Date();
    await db.globalVoipMsConfig.update({
      where: { id: "default" },
      data: {
        lastHealthAt: now,
        lastHealthOk: probe.ok,
        lastHealthMessage: probe.ok ? "ok" : (probe as { message: string }).message,
        ...(probe.ok ? { smsEnabled: true, mmsEnabled: true } : {}),
        updatedAt: now,
      },
    });
    return probe.ok ? { ok: true } : reply.status(400).send({ ok: false, message: (probe as { message: string }).message });
  });

  app.post("/admin/apps/voip-ms/sync-numbers", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!isSuper(user)) return reply.status(403).send({ error: "FORBIDDEN" });
    if (!requireCrypto(reply)) return;

    // ── Step 1: Fetch all DIDs from VoIP.ms ──────────────────────────────────
    // VoIP.ms returns all owned DIDs in a single getDIDsInfo call (no pagination
    // for owned DIDs). We log the raw response for ops visibility.
    const json = await voipMsApiCall("getDIDsInfo");
    console.log("[VOIPMS_SYNC] getDIDsInfo raw status:", json?.status, "keys:", Object.keys(json || {}).join(","));

    if (String(json.status || "").toLowerCase() !== "success") {
      console.error("[VOIPMS_SYNC] API returned non-success:", JSON.stringify(json).slice(0, 500));
      return reply.status(502).send({ error: "VOIPMS_SYNC_FAILED", detail: json });
    }

    // VoIP.ms wraps the list under "dids" or "did" depending on API version.
    const rawList: any[] = Array.isArray(json.dids)
      ? json.dids
      : Array.isArray(json.did)
        ? json.did
        : [];

    console.log(`[VOIPMS_SYNC] Raw DID count from API: ${rawList.length}`);

    // Log every DID's fields so we can see exactly what VoIP.ms is returning,
    // including which fields carry SMS capability info.
    rawList.forEach((raw, i) => {
      const fields = Object.entries(raw || {})
        .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
        .join(" | ");
      console.log(`[VOIPMS_SYNC] DID[${i}] ${fields}`);
    });

    // ── Step 2: Normalize + upsert ALL DIDs ──────────────────────────────────
    // CRITICAL: We import EVERY DID from VoIP.ms and let smsCapable be derived
    // from the API response. We do NOT skip DIDs based on sms capability —
    // smsenabled="0" means "SMS routing not yet configured", NOT "DID is SMS
    // incapable". Skipping those was causing SMS-ready numbers to go missing.
    let upserted = 0;
    let skippedInvalidNumber = 0;
    const smsCapableCount = { yes: 0, unclear: 0 };
    const upsertedNumbers: string[] = [];
    const skippedNumbers: string[] = [];

    for (const raw of rawList) {
      const row = normalizeDidRow(raw);
      if (!row) {
        skippedInvalidNumber++;
        const didStr = String(raw?.did ?? raw?.number ?? raw?.description ?? "(unknown)");
        console.warn(`[VOIPMS_SYNC] Skipped (could not normalize to E.164): did=${didStr} raw=${JSON.stringify(raw).slice(0, 200)}`);
        skippedNumbers.push(didStr);
        continue;
      }

      if (row.smsExplicit) smsCapableCount.yes++;
      else smsCapableCount.unclear++;

      await db.tenantSmsNumber.upsert({
        where: { phoneE164: row.e164 },
        create: {
          phoneE164: row.e164,
          phoneRaw: row.did,
          voipmsDid: String(raw?.did ?? ""),
          smsCapable: row.sms,
          mmsCapable: row.mms,
          lastSyncedAt: new Date(),
        },
        update: {
          phoneRaw: row.did,
          voipmsDid: String(raw?.did ?? ""),
          smsCapable: row.sms,
          mmsCapable: row.mms,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      upserted++;
      upsertedNumbers.push(row.e164);
    }

    console.log(`[VOIPMS_SYNC] Complete: total=${rawList.length} upserted=${upserted} skipped_invalid=${skippedInvalidNumber} sms_explicit=${smsCapableCount.yes} sms_unclear=${smsCapableCount.unclear}`);
    if (upsertedNumbers.length > 0) {
      console.log(`[VOIPMS_SYNC] Upserted numbers: ${upsertedNumbers.join(", ")}`);
    }

    await db.globalVoipMsConfig.update({
      where: { id: "default" },
      data: { lastDidsSyncAt: new Date(), smsEnabled: true, mmsEnabled: true, updatedAt: new Date() },
    });

    return {
      ok: true,
      upserted,
      total: rawList.length,
      skippedInvalidNumber,
      smsCapableExplicit: smsCapableCount.yes,
      smsCapableUnclear: smsCapableCount.unclear,
    };
  });

  // ── Debug endpoint: compare VoIP.ms API vs DB ──────────────────────────────
  // Shows raw API count, stored DB count, and which numbers are missing from DB.
  // Super-admin only. Calls the live VoIP.ms API.
  app.get("/admin/apps/voip-ms/debug-dids", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!isSuper(user)) return reply.status(403).send({ error: "FORBIDDEN" });
    if (!requireCrypto(reply)) return;

    const json = await voipMsApiCall("getDIDsInfo").catch((e: any) => ({ status: "error", _err: String(e?.message || e) }));
    const apiStatus = String(json?.status || "");
    const rawList: any[] = String(json?.status || "").toLowerCase() === "success"
      ? (Array.isArray(json.dids) ? json.dids : Array.isArray(json.did) ? json.did : [])
      : [];

    const apiDids: Array<{ raw: string; e164: string | null; sms: boolean; mms: boolean; parseError?: string }> = rawList.map((raw) => {
      const row = normalizeDidRow(raw);
      if (!row) {
        const rawDid = String(raw?.did ?? raw?.number ?? raw?.description ?? "");
        const tried = canonicalSmsPhone(rawDid);
        const parseError = tried.ok ? "unknown parse error" : tried.error;
        return { raw: rawDid, e164: null, sms: false, mms: false, parseError };
      }
      return { raw: row.did, e164: row.e164, sms: row.sms, mms: row.mms };
    });

    const dbRows = await db.tenantSmsNumber.findMany({
      select: { phoneE164: true, phoneRaw: true, smsCapable: true, mmsCapable: true, tenantId: true, active: true },
    });
    const dbE164Set = new Set(dbRows.map((r) => r.phoneE164));
    const apiE164Set = new Set(apiDids.filter((d) => d.e164).map((d) => d.e164 as string));

    const missingFromDb = apiDids.filter((d) => d.e164 && !dbE164Set.has(d.e164));
    const inDbNotInApi = dbRows.filter((r) => !apiE164Set.has(r.phoneE164));

    return {
      apiStatus,
      apiRawCount: rawList.length,
      apiParsedCount: apiDids.filter((d) => d.e164).length,
      apiParseFailCount: apiDids.filter((d) => !d.e164).length,
      dbCount: dbRows.length,
      missingFromDb,
      inDbNotInApi: inDbNotInApi.map((r) => ({ phoneE164: r.phoneE164, phoneRaw: r.phoneRaw, active: r.active })),
      apiDids,
      dbSummary: dbRows.map((r) => ({ phoneE164: r.phoneE164, smsCapable: r.smsCapable, mmsCapable: r.mmsCapable, tenantId: r.tenantId, active: r.active })),
    };
  });

  app.get("/admin/apps/voip-ms/numbers", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!isSuper(user) && !isTenantAdmin(user)) return reply.status(403).send({ error: "FORBIDDEN" });
    const tenantId = effectiveChatTenantId(req, user);
    // Super admins always see the full number inventory regardless of any
    // x-tenant-context header the portal may send. Filtering by tenant context
    // for super admins was hiding numbers assigned to other tenants.
    const where = isSuper(user) ? {} : { tenantId };
    const rows = await db.tenantSmsNumber.findMany({
      where,
      orderBy: { phoneE164: "asc" },
      take: 500,
      include: {
        tenant: { select: { name: true } },
        assignedUser: { select: { email: true } },
        assignedExtension: { select: { extNumber: true } },
      },
    });
    return {
      numbers: rows.map((r) => ({
        id: r.id,
        phoneE164: r.phoneE164,
        phoneRaw: r.phoneRaw,
        tenantId: r.tenantId,
        tenantName: r.tenant?.name || null,
        smsCapable: r.smsCapable,
        mmsCapable: r.mmsCapable,
        isTenantDefault: r.isTenantDefault,
        active: r.active,
        assignedUserId: r.assignedUserId,
        assignedUserEmail: r.assignedUser?.email || null,
        assignedExtensionId: r.assignedExtensionId,
        assignedExtensionNumber: r.assignedExtension?.extNumber || null,
      })),
    };
  });

  app.patch("/admin/apps/voip-ms/numbers/:id", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!isSuper(user) && !isTenantAdmin(user)) return reply.status(403).send({ error: "FORBIDDEN" });
    const effTenant = effectiveChatTenantId(req, user);
    const { id } = req.params as { id: string };
    const body = z
      .object({
        tenantId: z.string().nullable().optional(),
        assignedUserId: z.string().nullable().optional(),
        assignedExtensionId: z.string().nullable().optional(),
        isTenantDefault: z.boolean().optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body || {});

    const row = await db.tenantSmsNumber.findUnique({ where: { id } });
    if (!row) return reply.status(404).send({ error: "NOT_FOUND" });

    if (!isSuper(user)) {
      if (body.tenantId !== undefined && body.tenantId !== effTenant) {
        return reply.status(403).send({ error: "CANNOT_MOVE_NUMBER" });
      }
      if (row.tenantId && row.tenantId !== effTenant) {
        return reply.status(403).send({ error: "NOT_YOUR_TENANT" });
      }
    }

    if (body.isTenantDefault && body.tenantId) {
      await db.tenantSmsNumber.updateMany({
        where: { tenantId: body.tenantId, isTenantDefault: true },
        data: { isTenantDefault: false },
      });
    }

    await db.tenantSmsNumber.update({
      where: { id },
      data: {
        ...(body.tenantId !== undefined ? { tenantId: body.tenantId } : {}),
        ...(body.assignedUserId !== undefined ? { assignedUserId: body.assignedUserId } : {}),
        ...(body.assignedExtensionId !== undefined ? { assignedExtensionId: body.assignedExtensionId } : {}),
        ...(body.isTenantDefault !== undefined ? { isTenantDefault: body.isTenantDefault } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        updatedAt: new Date(),
      },
    });
    return { ok: true };
  });

  app.get("/admin/apps/voip-ms/routing-preview", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!isSuper(user) && !isTenantAdmin(user)) return reply.status(403).send({ error: "FORBIDDEN" });
    const q = z.object({ phoneE164: z.string() }).parse(req.query || {});
    const n = canonicalSmsPhone(q.phoneE164);
    if (!n.ok) return reply.status(400).send({ error: "INVALID_PHONE" });
    const row = await db.tenantSmsNumber.findUnique({
      where: { phoneE164: n.e164 },
      include: { assignedExtension: { select: { ownerUserId: true } } },
    } as any) as any;
    if (!row) return { found: false, normalized: n.e164 };
    const extensionOwnerUserId = row.assignedExtension?.ownerUserId || null;
    return {
      found: true,
      normalized: n.e164,
      tenantId: row.tenantId,
      assignedUserId: row.assignedUserId,
      assignedExtensionId: row.assignedExtensionId,
      isTenantDefault: row.isTenantDefault,
      inboundRoutesTo: row.assignedUserId
        ? `user:${row.assignedUserId}`
        : extensionOwnerUserId
          ? `extension_owner:${extensionOwnerUserId}`
          : row.tenantId
            ? "tenant_inbox"
            : "unassigned",
    };
  });

  // ── Tenant & extension lists for the portal assignment UI ─────────────────
  app.get("/admin/apps/voip-ms/tenants", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!isSuper(user)) return reply.status(403).send({ error: "FORBIDDEN" });
    const rows = await db.tenant.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    return { tenants: rows };
  });

  app.get("/admin/apps/voip-ms/extensions", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!isSuper(user) && !isTenantAdmin(user)) return reply.status(403).send({ error: "FORBIDDEN" });
    const { tenantId } = z.object({ tenantId: z.string().min(1) }).parse(req.query || {});
    const effTenant = isSuper(user) ? tenantId : effectiveChatTenantId(req, user);
    const rows = await db.extension.findMany({
      where: { tenantId: effTenant },
      select: { id: true, extNumber: true, displayName: true },
      orderBy: { extNumber: "asc" },
    });
    return { extensions: rows };
  });

  // ── Send test SMS ───────────────────────────────────────────────────────────
  app.post("/admin/apps/voip-ms/send-test-sms", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!isSuper(user)) return reply.status(403).send({ error: "FORBIDDEN" });
    if (!requireCrypto(reply)) return;
    const raw = z
      .object({
        from: z.string().min(1),
        to: z.string().min(1),
        message: z.string().min(1).max(1600),
      })
      .parse(req.body || {});
    // Normalize to E.164 — accept any US/Canada format from the form
    const fromN = canonicalSmsPhone(raw.from);
    const toN = canonicalSmsPhone(raw.to);
    if (!fromN.ok) return reply.status(400).send({ error: "INVALID_FROM", message: `From number invalid: ${"error" in fromN ? fromN.error : "invalid phone"}` });
    if (!toN.ok) return reply.status(400).send({ error: "INVALID_TO", message: `To number invalid: ${"error" in toN ? toN.error : "invalid phone"}` });
    const creds = await loadVoipMsCreds();
    if (!creds) return reply.status(400).send({ error: "NOT_CONFIGURED", message: "VoIP.ms credentials not configured." });
    const cfg = await getOrCreateGlobalVoipConfig();
    const provider = new VoipMsSmsProvider(
      { username: creds.username, password: creds.password, fromNumber: fromN.e164, apiBaseUrl: cfg.apiBaseUrl || creds.apiBaseUrl },
      false, // real send, not test mode
    );
    try {
      const r = await provider.sendMessage({ tenantId: "test", from: fromN.e164, to: toN.e164, body: raw.message });
      return { ok: true, messageId: r.providerMessageId, from: fromN.e164, to: toN.e164 };
    } catch (e: unknown) {
      const detail = String((e as Error)?.message || e);
      return reply.status(502).send({ error: "SEND_FAILED", message: `VoIP.ms rejected the send: ${detail}` });
    }
  });

  function mergeVoipMsPayload(req: any): Record<string, unknown> {
    const q = req.query && typeof req.query === "object" ? (req.query as Record<string, unknown>) : {};
    const b = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    return { ...q, ...b };
  }

  async function handleVoipMsInbound(req: any, reply: any) {
    const cfg = await getOrCreateGlobalVoipConfig();
    let authorized = !cfg.webhookSecretEncrypted;
    if (cfg.webhookSecretEncrypted) {
      try {
        const { secret } = decryptJson<{ secret: string }>(cfg.webhookSecretEncrypted);
        const hdr = String(req.headers["x-voipms-signature"] || "");
        const payload = mergeVoipMsPayload(req);
        const tok = String(payload.token ?? "");
        const qsig = String(payload.signature ?? "");
        if (secret && (constantTimeEq(hdr, secret) || constantTimeEq(tok, secret) || constantTimeEq(qsig, secret))) authorized = true;
      } catch {
        authorized = false;
      }
    }
    if (!authorized && cfg.webhookSecretEncrypted) {
      return reply.status(401).type("text/plain").send("unauthorized");
    }

    const payload = mergeVoipMsPayload(req);
    const rawFrom = String(payload.from ?? payload.src ?? payload.callerid ?? "");
    const rawTo = String(payload.to ?? payload.dst ?? payload.did ?? "");
    const message = String(payload.message ?? payload.body ?? payload.msg ?? "");
    const providerMessageId = String(payload.id ?? payload.sms ?? payload.sms_id ?? payload.message_id ?? "").trim();
    const mmsUrls = extractInboundMmsUrls(payload);

    const nf = canonicalSmsPhone(rawFrom);
    const nt = canonicalSmsPhone(rawTo);
    if (!nt.ok) {
      await db.smsRoutingLog.create({
        data: {
          rawFrom,
          rawTo,
          normalizedFrom: nf.ok ? nf.e164 : null,
          normalizedTo: null,
          direction: "inbound",
          status: "invalid_to",
          error: "error" in nt ? nt.error : "invalid phone",
          payload: payload as object,
        },
      });
      return reply.type("text/plain").send("ok");
    }

    const num = await db.tenantSmsNumber.findUnique({
      where: { phoneE164: nt.e164 },
      include: { assignedExtension: { select: { id: true, ownerUserId: true } } },
    } as any) as any;
    if (!num || !num.tenantId) {
      await db.smsRoutingLog.create({
        data: {
          rawFrom,
          rawTo,
          normalizedFrom: nf.ok ? nf.e164 : null,
          normalizedTo: nt.e164,
          direction: "inbound",
          status: "unassigned",
          error: "no_tenant",
          payload: payload as object,
        },
      });
      return reply.type("text/plain").send("ok");
    }

    const extE164 = nf.ok ? nf.e164 : rawFrom;
    const inboxScope = num.assignedUserId || num.assignedExtension?.ownerUserId || "";
    const dk = smsDedupeKey(num.tenantId, nt.e164, extE164, inboxScope);

    let thread = await db.connectChatThread.findUnique({ where: { dedupeKey: dk } });
    if (!thread) {
      thread = await db.connectChatThread.create({
        data: {
          tenantId: num.tenantId,
          type: "SMS",
          title: `SMS ${extE164}`,
          dedupeKey: dk,
          tenantSmsE164: nt.e164,
          tenantSmsRaw: rawTo,
          externalSmsE164: extE164,
          externalSmsRaw: rawFrom,
          smsInboxOwnerUserId: inboxScope,
          lastMessageAt: new Date(),
        },
      });
    }
    await upsertSmsThreadParticipants({
      threadId: thread.id,
      tenantId: num.tenantId,
      inboxOwnerUserId: inboxScope,
      assignedExtensionId: num.assignedExtensionId || null,
    });

    const msg = await db.connectChatMessage.create({
      data: {
        tenantId: num.tenantId,
        threadId: thread.id,
        direction: "INBOUND",
        type: mmsUrls.length ? "IMAGE" : "TEXT",
        body: message,
        deliveryStatus: "delivered",
        smsProviderMessageId: providerMessageId ? `voipms:${providerMessageId}` : null,
        metadata: mmsUrls.length ? { mms: { urls: mmsUrls } } : undefined,
      },
    });
    await mirrorVoipMsInboundMmsRows({
      tenantId: num.tenantId,
      threadId: thread.id,
      messageId: msg.id,
      urls: mmsUrls,
      log: req.log,
    });
    await db.connectChatThread.update({
      where: { id: thread.id },
      data: { lastMessageAt: new Date(), updatedAt: new Date() },
    });
    await db.smsRoutingLog.create({
      data: {
        rawFrom,
        rawTo,
        normalizedFrom: nf.ok ? nf.e164 : null,
        normalizedTo: nt.e164,
        direction: "inbound",
        resolvedTenantId: num.tenantId,
        resolvedUserId: inboxScope || null,
        resolvedExtensionId: num.assignedExtensionId,
        resolvedThreadId: thread.id,
        status: "routed",
        payload: payload as object,
      },
    });
    if (deps.sendPushToUserDevices) {
      const recipients = await db.connectChatParticipant.findMany({
        where: { threadId: thread.id, leftAt: null, muted: false, userId: { not: null } },
        select: { userId: true },
      });
      const tenantId = num.tenantId;
      if (!tenantId) return reply.type("text/plain").send("ok");
      await Promise.all(recipients.map((recipient) =>
        recipient.userId
          ? deps.sendPushToUserDevices!({
              tenantId,
              userId: recipient.userId,
              payload: {
                type: "sms_message",
                conversationId: thread.id,
                messageId: msg.id,
                phoneNumber: extE164,
                tenantId,
                preview: pushPreview(message, mmsUrls.length ? "Sent an attachment" : "New SMS message"),
                timestamp: new Date().toISOString(),
              },
            }).catch((err: any) => app.log.warn({ err: err?.message, threadId: thread.id, messageId: msg.id }, "chat-push: sms failed"))
          : Promise.resolve(),
      ));
    }
    return reply.type("text/plain").send("ok");
  }

  app.post("/webhooks/voipms/sms", handleVoipMsInbound);
  app.get("/webhooks/voipms/sms", handleVoipMsInbound);
}

function constantTimeEq(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ba.length !== bb.length) return false;
    return ba.equals(bb);
  } catch {
    return false;
  }
}
