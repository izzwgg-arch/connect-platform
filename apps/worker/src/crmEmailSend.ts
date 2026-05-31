import { db } from "@connect/db";
import { decryptJson, encryptJson } from "@connect/security";
import { htmlToCrmPlainText } from "@connect/shared";
import * as fs from "node:fs";
import * as path from "node:path";

export const CRM_EMAIL_LOGO_CID = "connect-crm-business-logo";

function base64url(input: string | Buffer): string {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64(input: string | Buffer): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8"))
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n")
    .trim();
}

function escapeHeader(raw: string): string {
  return String(raw || "").replace(/[\r\n]+/g, " ").trim();
}

function encodeMimeHeader(raw: string): string {
  const s = escapeHeader(raw);
  return /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date | null; scope: string[]; tokenType: string } | null> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const accessToken = String(json.access_token || "");
  const expiresInSec = Number(json.expires_in || 0);
  const tokenType = String(json.token_type || "Bearer");
  const scope = String(json.scope || "").split(/\s+/).filter(Boolean);
  return { accessToken, expiresAt: expiresInSec ? new Date(Date.now() + expiresInSec * 1000) : null, scope, tokenType };
}

function buildPlainTextMime(fromHeader: string, to: string, subject: string, bodyText: string): string {
  const headers = [
    `From: ${fromHeader}`,
    `To: <${escapeHeader(to)}>`,
    `Subject: ${encodeMimeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
  ];
  return headers.join("\r\n") + "\r\n\r\n" + bodyText;
}

function getCrmEmailAssetStorageRoot(): string {
  const root =
    process.env.CRM_EMAIL_ASSET_STORAGE_DIR ||
    (process.env.CRM_DOC_STORAGE_DIR
      ? path.join(process.env.CRM_DOC_STORAGE_DIR, "email-assets")
      : path.resolve(process.cwd(), "data/crm-email-assets"));
  return root.replace(/\/+$/, "");
}

function resolveCrmEmailAssetStoragePath(storageKey: string): string {
  const clean = String(storageKey || "").replace(/\\/g, "/");
  if (!clean || clean.includes("..")) throw new Error("invalid_storage_key");
  const root = getCrmEmailAssetStorageRoot();
  const full = path.resolve(root, clean);
  if (!full.startsWith(root + path.sep) && full !== root) throw new Error("invalid_storage_key_scope");
  return full;
}

type CrmSendAttachment = {
  id: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  contentId?: string;
  inline?: boolean;
};

async function loadTemplateAttachments(input: {
  tenantId: string;
  templateId?: string | null;
  attachmentIds?: string[] | null;
}): Promise<CrmSendAttachment[]> {
  if (!input.templateId && (!input.attachmentIds || input.attachmentIds.length === 0)) return [];
  const where: any = { tenantId: input.tenantId };
  if (input.templateId) where.templateId = input.templateId;
  if (input.attachmentIds && input.attachmentIds.length > 0) where.id = { in: input.attachmentIds };
  const rows = await (db as any).crmEmailTemplateAttachment.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: 20,
  }).catch(() => []);
  return rows.map((row: any) => ({
    id: row.id,
    originalFileName: row.originalFileName,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes || 0),
    storageKey: row.storageKey,
  }));
}

async function loadInlineLogoAttachment(tenantId: string, bodyHtml?: string | null): Promise<CrmSendAttachment | null> {
  if (!bodyHtml || !bodyHtml.includes(`cid:${CRM_EMAIL_LOGO_CID}`)) return null;
  const row = await (db as any).crmEmailBranding.findUnique({
    where: { tenantId },
    select: {
      logoStorageKey: true,
      logoMimeType: true,
      logoFileName: true,
    },
  }).catch(() => null);
  if (!row?.logoStorageKey) return null;
  return {
    id: "branding-logo",
    originalFileName: row.logoFileName || "business-logo",
    mimeType: row.logoMimeType || "image/png",
    sizeBytes: 0,
    storageKey: row.logoStorageKey,
    contentId: CRM_EMAIL_LOGO_CID,
    inline: true,
  };
}

export async function buildRichMime(input: {
  fromHeader: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  attachments: CrmSendAttachment[];
}): Promise<string> {
  const mixedBoundary = `connect_mixed_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const relatedBoundary = `connect_related_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const altBoundary = `connect_alt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const html = input.bodyHtml || "";
  const text = input.bodyText || (html ? htmlToCrmPlainText(html) : "");
  const inlineAttachments = input.attachments.filter((attachment) => attachment.inline);
  const fileAttachments = input.attachments.filter((attachment) => !attachment.inline);
  const headers = [
    `From: ${input.fromHeader}`,
    `To: <${escapeHeader(input.to)}>`,
    `Subject: ${encodeMimeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
  ];
  const parts: string[] = [];
  parts.push(`--${mixedBoundary}`);
  if (inlineAttachments.length > 0) {
    parts.push(`Content-Type: multipart/related; boundary="${relatedBoundary}"`);
    parts.push("");
    parts.push(`--${relatedBoundary}`);
  }
  parts.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  parts.push("");
  parts.push(`--${altBoundary}`);
  parts.push("Content-Type: text/plain; charset=UTF-8");
  parts.push("Content-Transfer-Encoding: base64");
  parts.push("");
  parts.push(b64(text));
  if (html) {
    parts.push(`--${altBoundary}`);
    parts.push("Content-Type: text/html; charset=UTF-8");
    parts.push("Content-Transfer-Encoding: base64");
    parts.push("");
    parts.push(b64(html));
  }
  parts.push(`--${altBoundary}--`);
  for (const attachment of inlineAttachments) {
    const bytes = await fs.promises.readFile(resolveCrmEmailAssetStoragePath(attachment.storageKey));
    const safeName = escapeHeader(attachment.originalFileName || "attachment");
    parts.push(`--${relatedBoundary}`);
    parts.push(`Content-Type: ${attachment.mimeType || "application/octet-stream"}; name="${safeName}"`);
    parts.push("Content-Transfer-Encoding: base64");
    if (attachment.contentId) parts.push(`Content-ID: <${attachment.contentId}>`);
    parts.push(`Content-Disposition: inline; filename="${safeName}"`);
    parts.push("");
    parts.push(b64(bytes));
  }
  if (inlineAttachments.length > 0) parts.push(`--${relatedBoundary}--`);
  for (const attachment of fileAttachments) {
    const bytes = await fs.promises.readFile(resolveCrmEmailAssetStoragePath(attachment.storageKey));
    const safeName = escapeHeader(attachment.originalFileName || "attachment");
    parts.push(`--${mixedBoundary}`);
    parts.push(`Content-Type: ${attachment.mimeType || "application/octet-stream"}; name="${safeName}"`);
    parts.push("Content-Transfer-Encoding: base64");
    parts.push(`Content-Disposition: attachment; filename="${safeName}"`);
    parts.push("");
    parts.push(b64(bytes));
  }
  parts.push(`--${mixedBoundary}--`);
  return headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n");
}

function formatFromHeader(senderName: string | null | undefined, displayName: string | null | undefined, emailAddress: string): string {
  const name = (senderName && senderName.trim()) || (displayName && displayName.trim()) || "";
  if (!name) return `<${emailAddress}>`;
  // Escape quotes per RFC 5322 quoted-string
  const safe = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${safe}" <${emailAddress}>`;
}

/**
 * Process a CRM email send job.
 *
 * Resolves the sender CrmEmailConnection in this order:
 *  1. job.connectionId (set by new API send/test paths)
 *  2. Legacy fallback: any CONNECTED USER-scope row for (tenantId, userId)
 *     — supports jobs queued before the Phase 1.5 worker deploy.
 */
export async function processCrmEmailSendJob(job: {
  tenantId: string;
  userId: string;
  connectionId?: string | null;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  contactId?: string | null;
  templateId?: string | null;
  attachmentIds?: string[] | null;
}) {
  let conn = job.connectionId
    ? await db.crmEmailConnection.findFirst({ where: { id: job.connectionId, tenantId: job.tenantId } })
    : null;
  if (!conn) {
    // Legacy queued job (no connectionId) — resolve caller's own USER sender by tenant+userId.
    conn = await db.crmEmailConnection.findFirst({ where: { tenantId: job.tenantId, userId: job.userId, scope: "USER" } });
  }
  if (!conn || conn.status !== "CONNECTED") throw new Error("not_connected");

  const senderConnectionId = conn.id;

  const accessPayload = decryptJson<any>(conn.encryptedAccessToken);
  let accessToken = String(accessPayload?.accessToken || "");

  if (!accessToken || (conn.tokenExpiresAt && conn.tokenExpiresAt < new Date(Date.now() + 60_000))) {
    const refreshPayload = decryptJson<any>(conn.encryptedRefreshToken);
    const rt = String(refreshPayload?.refreshToken || "");
    if (rt) {
      const refreshed = await refreshAccessToken(rt);
      if (refreshed) {
        accessToken = refreshed.accessToken;
        await db.crmEmailConnection.update({
          where: { id: senderConnectionId },
          data: {
            encryptedAccessToken: encryptJson({ accessToken: refreshed.accessToken, tokenType: refreshed.tokenType, scope: refreshed.scope }),
            tokenExpiresAt: refreshed.expiresAt,
            scopes: refreshed.scope,
          },
        });
      }
    }
  }

  if (!accessToken) throw new Error("no_access_token");

  const fromEmail = conn.emailAddress;
  const fromHeader = formatFromHeader(conn.senderName, conn.displayName, fromEmail);
  const attachments = await loadTemplateAttachments({
    tenantId: job.tenantId,
    templateId: job.templateId,
    attachmentIds: job.attachmentIds,
  });
  const inlineLogo = await loadInlineLogoAttachment(job.tenantId, job.bodyHtml);
  const allAttachments = inlineLogo ? [inlineLogo, ...attachments] : attachments;
  const attachmentSnapshot = attachments.map((a) => ({
    id: a.id,
    originalFileName: a.originalFileName,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
  }));
  const rawMime = job.bodyHtml || allAttachments.length > 0
    ? await buildRichMime({
        fromHeader,
        to: job.to,
        subject: job.subject || "",
        bodyText: job.bodyText || "",
        bodyHtml: job.bodyHtml || "",
        attachments: allAttachments,
      })
    : buildPlainTextMime(fromHeader, job.to, job.subject || "", job.bodyText || "");
  const rawB64 = base64url(Buffer.from(rawMime, "utf8"));

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: rawB64 }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    await (db as any).crmEmailSendLog.create({
      data: {
        tenantId: job.tenantId,
        userId: job.userId,
        senderConnectionId,
        contactId: job.contactId || null,
        templateId: job.templateId || null,
        toEmail: job.to,
        subject: job.subject || null,
        status: "FAILED",
        errorMessage: String(json?.error?.message || json?.message || `send_failed_${res.status}`),
        attachmentSnapshot: attachmentSnapshot.length ? attachmentSnapshot : undefined,
      },
    });
    throw new Error("gmail_send_failed");
  }

  const gmailMessageId = String(json?.id || "");
  const gmailThreadId = String(json?.threadId || "");

  let threadId: string | undefined;
  if (gmailThreadId) {
    const t = await db.crmEmailThread.upsert({
      where: { tenantId_gmailThreadId: { tenantId: job.tenantId, gmailThreadId } },
      create: {
        tenantId: job.tenantId,
        userId: job.userId,
        senderConnectionId,
        contactId: job.contactId || null,
        gmailThreadId,
        subject: job.subject || null,
        lastMessageAt: new Date(),
        unreadCount: 0,
      },
      update: { lastMessageAt: new Date(), senderConnectionId },
    });
    threadId = t.id;
  }

  await db.$transaction(async (tx) => {
    await tx.crmEmailMessage.create({
      data: {
        tenantId: job.tenantId,
        userId: job.userId,
        senderConnectionId,
        threadId: threadId || null,
        contactId: job.contactId || null,
        gmailMessageId,
        direction: "OUTBOUND",
        subject: job.subject || null,
        fromEmail,
        toEmail: job.to,
        previewSnippet: (job.bodyText || "").slice(0, 200),
        sentAt: new Date(),
      },
    });

    await (tx as any).crmEmailSendLog.create({
      data: {
        tenantId: job.tenantId,
        userId: job.userId,
        senderConnectionId,
        contactId: job.contactId || null,
        templateId: job.templateId || null,
        gmailMessageId,
        gmailThreadId: gmailThreadId || null,
        toEmail: job.to,
        subject: job.subject || null,
        status: "SENT",
        sentAt: new Date(),
        attachmentSnapshot: attachmentSnapshot.length ? attachmentSnapshot : undefined,
      },
    });

    if (job.templateId) {
      await (tx as any).crmEmailTemplate.update({
        where: { id: job.templateId },
        data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
      }).catch(() => undefined);
    }

    if (job.contactId) {
      await tx.crmTimelineEvent.create({
        data: {
          tenantId: job.tenantId,
          contactId: job.contactId,
          type: "EMAIL_SENT",
          title: "Email sent",
          body: job.subject || "Email sent",
          metadata: { to: job.to, senderEmail: fromEmail, scope: conn.scope },
          createdByUserId: job.userId,
        },
      });
    }
  });

  return { ok: true, gmailMessageId, gmailThreadId };
}
