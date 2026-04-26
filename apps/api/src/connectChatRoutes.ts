/**
 * Connect unified chat: internal threads + VoIP.ms SMS.
 * Registered from server.ts — keeps PBX/voice code isolated.
 */

import * as fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import { z } from "zod";
import { db } from "@connect/db";
import { decryptJson, encryptJson, hasCredentialsMasterKey } from "@connect/security";
import { buildChatSignedDownloadUrl, canonicalSmsPhone, verifyChatSignedDownload } from "@connect/shared";
import { validateVoipMsCredentials } from "@connect/integrations";
import {
  assertStorageKeyForThread,
  isAllowedChatMime,
  maxBytesForThread,
  resolveChatStoragePath,
  writeChatAttachmentFile,
} from "./chatAttachmentStorage";
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

function normalizeDidRow(raw: any): { did: string; e164: string; sms: boolean; mms: boolean } | null {
  const did = String(raw?.did ?? raw?.description ?? raw?.number ?? "").trim();
  if (!did) return null;
  const n = canonicalSmsPhone(did);
  if (!n.ok) return null;
  return {
    did,
    e164: n.e164,
    sms: raw?.smsenabled === "1" || raw?.sms === true || raw?.sms_enabled === "1" || String(raw?.sms ?? "").toLowerCase() === "yes",
    mms: raw?.mms === true || raw?.mmsenabled === "1" || String(raw?.mms ?? "").toLowerCase() === "yes",
  };
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

export type ConnectChatRoutesDeps = { smsQueue: Queue };

function publicChatDownloadBase(): string {
  return (process.env.PUBLIC_API_BASE_URL || process.env.PORTAL_PUBLIC_URL || "").replace(/\/+$/, "");
}

function extractInboundMmsUrls(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    const s = String(v ?? "").trim();
    if (/^https?:\/\//i.test(s)) out.push(s);
  };
  const arr = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) push(x);
  };
  push(payload.media_url);
  push(payload.mediaurl);
  push(payload.MediaUrl);
  arr(payload.media_urls);
  arr(payload.attachments);
  for (let i = 1; i <= 6; i += 1) {
    push((payload as Record<string, unknown>)[`media${i}`]);
    push((payload as Record<string, unknown>)[`Media${i}`]);
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

async function persistMessageAttachments(
  tenantId: string,
  threadId: string,
  messageId: string,
  rows: Array<{ storageKey: string; mimeType: string; sizeBytes: number; fileName: string }>,
): Promise<void> {
  for (const row of rows) {
    assertStorageKeyForThread(row.storageKey, tenantId, threadId);
    let abs: string;
    try {
      abs = resolveChatStoragePath(row.storageKey);
    } catch {
      throw new Error("INVALID_STORAGE_KEY");
    }
    if (!fs.existsSync(abs)) throw new Error("ATTACHMENT_NOT_FOUND");
    const st = await fs.promises.stat(abs);
    if (st.size !== row.sizeBytes) throw new Error("SIZE_MISMATCH");
    await db.connectChatMessageAttachment.create({
      data: {
        messageId,
        tenantId,
        fileName: row.fileName,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        storageKey: row.storageKey,
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

export function registerConnectChatRoutes(app: FastifyInstance, deps: ConnectChatRoutesDeps): void {
  // Signed-URL download for chat bytes (VoIP.ms MMS media1..3, thumbnails). No JWT.
  app.get("/chat/attachments/download/*", async (req, reply) => {
    const wildcardPath = (req.params as any)["*"] as string | undefined;
    const storageKey = decodeURIComponent(String(wildcardPath || ""));
    if (!storageKey) return reply.code(400).send({ error: "missing_key" });
    const q = req.query as { exp?: string; sig?: string };
    const verified = verifyChatSignedDownload(storageKey, q.exp, q.sig);
    if (!verified.ok) return reply.code(401).send({ error: "bad_signature", reason: verified.reason });
    let absolutePath: string;
    try {
      absolutePath = resolveChatStoragePath(storageKey);
    } catch {
      return reply.code(400).send({ error: "invalid_key" });
    }
    if (!fs.existsSync(absolutePath)) return reply.code(404).send({ error: "not_found" });
    const stat = await fs.promises.stat(absolutePath);
    reply.header("content-length", stat.size);
    reply.header("content-type", "application/octet-stream");
    return reply.send(fs.createReadStream(absolutePath));
  });

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
            messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, createdAt: true } },
          },
        },
      },
      orderBy: { thread: { lastMessageAt: "desc" } },
    });

    const threads = parts.map((p) => {
      const t = p.thread;
      const last = t.messages[0];
      let participantName = t.title || "Chat";
      let participantExtension = "";
      if (t.type === "SMS") {
        participantName = t.externalSmsE164 || "SMS";
        participantExtension = t.tenantSmsE164 || "";
      } else if (t.type === "TENANT_GROUP") {
        participantName = t.title || "Tenant Group";
      }
      return {
        id: t.id,
        type: t.type,
        title: t.title,
        participantName,
        participantExtension,
        lastMessage: last?.body || "",
        lastAt: (last?.createdAt || t.lastMessageAt).toISOString(),
        unread: 0,
        tenantSmsE164: t.tenantSmsE164,
        externalSmsE164: t.externalSmsE164,
      };
    });

    return { threads };
  });

  app.post("/chat/threads", async (req, reply) => {
    const user = req.user as JwtUser;
    const tenantId = effectiveChatTenantId(req, user);
    const body = z
      .object({
        type: z.enum(["dm", "sms", "group"]),
        peerUserId: z.string().optional(),
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

    if (body.type === "sms") {
      if (!canSendSmsRole(user)) return reply.status(403).send({ error: "FORBIDDEN" });
      if (!body.externalPhone) return reply.status(400).send({ error: "externalPhone required" });
      const extNorm = canonicalSmsPhone(body.externalPhone);
      if (!extNorm.ok) return reply.status(400).send({ error: "INVALID_PHONE", detail: extNorm.error });

      const extLink = await db.extension.findFirst({
        where: { tenantId, ownerUserId: user.sub, status: "ACTIVE" },
        select: { id: true },
      });
      const fromPick = await resolveOutboundSmsNumber(tenantId, user.sub, extLink?.id ?? null);
      if ("error" in fromPick) return reply.status(400).send({ error: "NO_SMS_NUMBER", message: fromPick.error });

      const assign = await db.tenantSmsNumber.findFirst({
        where: { id: fromPick.row.id, tenantId },
        select: { assignedUserId: true },
      });
      const inboxScope = assign?.assignedUserId && assign.assignedUserId === user.sub ? user.sub : "";

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
      if (m === "mime_not_allowed") return reply.status(400).send({ error: "MIME_NOT_ALLOWED" });
      if (m === "file_too_large") return reply.status(400).send({ error: "FILE_TOO_LARGE" });
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
    const rows = await db.connectChatMessage.findMany({
      where: { threadId, deletedForEveryoneAt: null },
      orderBy: { createdAt: "asc" },
      take: 200,
      include: {
        reactions: true,
        senderUser: { select: { email: true } },
        attachments: { orderBy: { createdAt: "asc" } },
      },
    });
    const base = publicChatDownloadBase();
    const messages = rows.map((m) => {
      const meta = m.metadata as { mms?: { urls?: string[] } } | null;
      const mmsUrls = Array.isArray(meta?.mms?.urls) ? meta!.mms!.urls! : [];
      return {
        id: m.id,
        threadId: m.threadId,
        senderId: m.senderUserId || "",
        senderName: m.senderUser?.email?.split("@")[0] || "System",
        body: m.body,
        sentAt: m.createdAt.toISOString(),
        mine: m.senderUserId === user.sub,
        type: m.type,
        editedAt: m.editedAt?.toISOString() || null,
        deliveryStatus: m.deliveryStatus,
        reactions: m.reactions,
        mmsUrls,
        attachments: (m.attachments || []).map((a) => ({
          id: a.id,
          fileName: a.fileName,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          downloadUrl: base ? buildChatSignedDownloadUrl(base, a.storageKey, 900) : null,
        })),
      };
    });
    return { messages };
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
        type: z.enum(["TEXT", "VOICE_NOTE", "IMAGE", "FILE", "LOCATION"]).optional(),
        replyToMessageId: z.string().optional(),
        attachments: z.array(attachmentSchema).max(3).optional(),
      })
      .parse(req.body || {});

    const thread = await db.connectChatThread.findFirst({ where: { id: threadId, tenantId } });
    if (!thread) return reply.status(404).send({ error: "THREAD_NOT_FOUND" });

    if (thread.type === "SMS") {
      if (!canSendSmsRole(user)) return reply.status(403).send({ error: "FORBIDDEN" });
      const ext = thread.externalSmsE164;
      const tenantDid = thread.tenantSmsE164;
      if (!ext || !tenantDid) return reply.status(400).send({ error: "SMS_THREAD_INCOMPLETE" });

      const creds = await loadVoipMsCreds();
      if (!creds) return reply.status(503).send({ error: "VOIPMS_NOT_CONFIGURED" });
      const cfg = await getOrCreateGlobalVoipConfig();
      if (!cfg.smsEnabled) return reply.status(503).send({ error: "VOIPMS_SMS_DISABLED" });

      const atts = input.attachments || [];
      if (atts.length > 0) {
        const smsRow = await db.tenantSmsNumber.findFirst({ where: { phoneE164: tenantDid, tenantId } });
        if (!cfg.mmsEnabled || !smsRow?.mmsCapable) {
          return reply.status(400).send({ error: "MMS_NOT_AVAILABLE", message: "Enable MMS globally and sync an MMS-capable DID." });
        }
      }

      const msgType =
        atts.length > 0 ? inferAttachmentMessageType(atts) : ((input.type as any) || "TEXT");

      const msg = await db.connectChatMessage.create({
        data: {
          tenantId,
          threadId,
          senderUserId: user.sub,
          direction: "OUTBOUND",
          type: msgType,
          body: input.body,
          replyToMessageId: input.replyToMessageId,
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

    const msgType =
      (input.attachments?.length || 0) > 0
        ? inferAttachmentMessageType(input.attachments!)
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
        deliveryStatus: "sent",
      },
    });
    try {
      if (input.attachments?.length) await persistMessageAttachments(tenantId, threadId, msg.id, input.attachments);
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
    const webhookUrl = baseUrl ? `${baseUrl.replace(/\/$/, "")}/webhooks/voipms/sms` : "(set PUBLIC_API_BASE_URL for full URL)";
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
      },
      update: {
        credentialsEncrypted: enc,
        apiBaseUrl: body.apiBaseUrl || null,
        ...(wh ? { webhookSecretEncrypted: wh } : {}),
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
        updatedAt: now,
      },
    });
    return probe.ok ? { ok: true } : reply.status(400).send({ ok: false, message: (probe as { message: string }).message });
  });

  app.post("/admin/apps/voip-ms/sync-numbers", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!isSuper(user)) return reply.status(403).send({ error: "FORBIDDEN" });
    if (!requireCrypto(reply)) return;
    const json = await voipMsApiCall("getDIDsInfo");
    if (String(json.status || "").toLowerCase() !== "success") {
      return reply.status(502).send({ error: "VOIPMS_SYNC_FAILED", detail: json });
    }
    const rawList: any[] = Array.isArray(json.dids) ? json.dids : Array.isArray(json.did) ? json.did : [];
    let n = 0;
    for (const raw of rawList) {
      const row = normalizeDidRow(raw);
      if (!row || !row.sms) continue;
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
      n += 1;
    }
    await db.globalVoipMsConfig.update({
      where: { id: "default" },
      data: { lastDidsSyncAt: new Date(), updatedAt: new Date() },
    });
    return { ok: true, upserted: n };
  });

  app.get("/admin/apps/voip-ms/numbers", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!isSuper(user) && !isTenantAdmin(user)) return reply.status(403).send({ error: "FORBIDDEN" });
    const tenantId = effectiveChatTenantId(req, user);
    const header = String(req.headers["x-tenant-context"] || "").trim();
    const where =
      isSuper(user) && !header
        ? {}
        : isSuper(user) && header
          ? { OR: [{ tenantId }, { tenantId: null }] }
          : { tenantId };
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
    const row = await db.tenantSmsNumber.findUnique({ where: { phoneE164: n.e164 } });
    if (!row) return { found: false, normalized: n.e164 };
    return {
      found: true,
      normalized: n.e164,
      tenantId: row.tenantId,
      assignedUserId: row.assignedUserId,
      assignedExtensionId: row.assignedExtensionId,
      isTenantDefault: row.isTenantDefault,
      inboundRoutesTo: row.assignedUserId ? `user:${row.assignedUserId}` : row.tenantId ? "tenant_inbox" : "unassigned",
    };
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
      return reply.status(401).send({ error: "unauthorized" });
    }

    const payload = mergeVoipMsPayload(req);
    const rawFrom = String(payload.from ?? payload.src ?? payload.callerid ?? "");
    const rawTo = String(payload.to ?? payload.dst ?? payload.did ?? "");
    const message = String(payload.message ?? payload.body ?? "");
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
          error: nt.error,
          payload: payload as object,
        },
      });
      return { ok: false };
    }

    const num = await db.tenantSmsNumber.findUnique({ where: { phoneE164: nt.e164 } });
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
      return { ok: true, accepted: true };
    }

    const extE164 = nf.ok ? nf.e164 : rawFrom;
    const inboxScope = num.assignedUserId || "";
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
      const users = num.assignedUserId
        ? await db.user.findMany({ where: { id: num.assignedUserId, tenantId: num.tenantId } })
        : await db.user.findMany({ where: { tenantId: num.tenantId } });
      for (const u of users) {
        await db.connectChatParticipant.upsert({
          where: { threadId_participantKey: { threadId: thread.id, participantKey: `u:${u.id}` } },
          create: { threadId: thread.id, participantKey: `u:${u.id}`, userId: u.id, role: "MEMBER" },
          update: { leftAt: null },
        });
      }
    }

    const msg = await db.connectChatMessage.create({
      data: {
        tenantId: num.tenantId,
        threadId: thread.id,
        direction: "INBOUND",
        type: mmsUrls.length ? "IMAGE" : "TEXT",
        body: message,
        deliveryStatus: "delivered",
        metadata: mmsUrls.length ? { mms: { urls: mmsUrls } } : undefined,
      },
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
        resolvedUserId: num.assignedUserId,
        resolvedExtensionId: num.assignedExtensionId,
        resolvedThreadId: thread.id,
        status: "routed",
        payload: payload as object,
      },
    });
    return { ok: true, threadId: thread.id, messageId: msg.id };
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
