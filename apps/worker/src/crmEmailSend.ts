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

function buildPlainTextMime(fromHeader: string, to: string, subject: string, bodyText: string): string {
  const headers = [
    `From: ${fromHeader}`,
    `To: <${to}>`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
  ];
  return headers.join("\r\n") + "\r\n\r\n" + bodyText;
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
  contactId?: string | null;
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
  const rawMime = buildPlainTextMime(fromHeader, job.to, job.subject || "", job.bodyText || "");
  const rawB64 = base64url(Buffer.from(rawMime, "utf8"));

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: rawB64 }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    await db.crmEmailSendLog.create({
      data: {
        tenantId: job.tenantId,
        userId: job.userId,
        senderConnectionId,
        contactId: job.contactId || null,
        toEmail: job.to,
        subject: job.subject || null,
        status: "FAILED",
        errorMessage: String(json?.error?.message || json?.message || `send_failed_${res.status}`),
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

    await tx.crmEmailSendLog.create({
      data: {
        tenantId: job.tenantId,
        userId: job.userId,
        senderConnectionId,
        contactId: job.contactId || null,
        gmailMessageId,
        gmailThreadId: gmailThreadId || null,
        toEmail: job.to,
        subject: job.subject || null,
        status: "SENT",
        sentAt: new Date(),
      },
    });

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
