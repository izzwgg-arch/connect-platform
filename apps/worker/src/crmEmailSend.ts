import { db } from "@connect/db";
import { decryptJson, encryptJson } from "@connect/security";

function base64url(input: string | Buffer): string {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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

function buildPlainTextMime(fromEmail: string, to: string, subject: string, bodyText: string): string {
  const headers = [
    `From: <${fromEmail}>`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
  ];
  return headers.join("\r\n") + "\r\n\r\n" + bodyText;
}

export async function processCrmEmailSendJob(job: { tenantId: string; userId: string; to: string; subject: string; bodyText: string; contactId?: string | null }) {
  const conn = await db.crmEmailConnection.findUnique({ where: { tenantId_userId: { tenantId: job.tenantId, userId: job.userId } } });
  if (!conn || conn.status !== "CONNECTED") throw new Error("not_connected");

  const accessPayload = decryptJson<any>(conn.encryptedAccessToken);
  let accessToken = String(accessPayload?.accessToken || "");

  if (!accessToken || (conn.tokenExpiresAt && conn.tokenExpiresAt < new Date(Date.now() + 60_000))) {
    const refreshPayload = decryptJson<any>(conn.encryptedRefreshToken);
    const rt = String(refreshPayload?.refreshToken || "");
    if (rt) {
      const refreshed = await refreshAccessToken(rt);
      if (refreshed) {
        accessToken = refreshed.accessToken;
        await db.crmEmailConnection.update({ where: { tenantId_userId: { tenantId: job.tenantId, userId: job.userId } }, data: { encryptedAccessToken: encryptJson({ accessToken: refreshed.accessToken, tokenType: refreshed.tokenType, scope: refreshed.scope }), tokenExpiresAt: refreshed.expiresAt, scopes: refreshed.scope } });
      }
    }
  }

  if (!accessToken) throw new Error("no_access_token");

  const fromEmail = conn.emailAddress;
  const rawMime = buildPlainTextMime(fromEmail, job.to, job.subject || "", job.bodyText || "");
  const rawB64 = base64url(Buffer.from(rawMime, "utf8"));

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: rawB64 }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    await db.crmEmailSendLog.create({ data: { tenantId: job.tenantId, userId: job.userId, contactId: job.contactId || null, toEmail: job.to, subject: job.subject || null, status: "FAILED", errorMessage: String(json?.error?.message || json?.message || `send_failed_${res.status}`) } });
    throw new Error("gmail_send_failed");
  }

  const gmailMessageId = String(json?.id || "");
  const gmailThreadId = String(json?.threadId || "");

  let threadId: string | undefined;
  if (gmailThreadId) {
    const t = await db.crmEmailThread.upsert({
      where: { tenantId_gmailThreadId: { tenantId: job.tenantId, gmailThreadId } },
      create: { tenantId: job.tenantId, userId: job.userId, contactId: job.contactId || null, gmailThreadId, subject: job.subject || null, lastMessageAt: new Date(), unreadCount: 0 },
      update: { lastMessageAt: new Date() },
    });
    threadId = t.id;
  }

  await db.$transaction(async (tx) => {
    await tx.crmEmailMessage.create({
      data: {
        tenantId: job.tenantId,
        userId: job.userId,
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

    await tx.crmEmailSendLog.create({ data: { tenantId: job.tenantId, userId: job.userId, contactId: job.contactId || null, gmailMessageId, gmailThreadId: gmailThreadId || null, toEmail: job.to, subject: job.subject || null, status: "SENT", sentAt: new Date() } });

    if (job.contactId) {
      await tx.crmTimelineEvent.create({ data: { tenantId: job.tenantId, contactId: job.contactId, type: "EMAIL_SENT", title: "Email sent", body: job.subject || "Email sent", metadata: { to: job.to }, createdByUserId: job.userId } });
    }
  });

  return { ok: true, gmailMessageId, gmailThreadId };
}
