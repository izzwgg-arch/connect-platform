import { db } from "@connect/db";
import { decryptJson, encryptJson } from "@connect/security";

export function parseHeader(headers: Array<{ name: string; value: string }>, key: string): string | null {
  const h = headers.find((x) => x.name.toLowerCase() === key.toLowerCase());
  return h ? String(h.value || "") : null;
}

export function extractEmail(addr: string | null): string | null {
  if (!addr) return null;
  const m = addr.match(/<([^>]+)>/);
  const v = m ? m[1] : addr;
  return v.trim() || null;
}

/**
 * Classify a Gmail message as inbound or outbound (from the CRM sender's perspective).
 *
 * A message is considered inbound when:
 *  1. It has the INBOX label (it arrived in the inbox).
 *  2. The From address is NOT the CRM sender's own email address.
 *
 * This filters out sent-folder copies of outbound messages that happen to
 * also appear in label lists.
 */
export function classifyGmailMessage(opts: {
  labelIds: string[];
  fromEmail: string | null;
  senderEmailAddress: string;
}): { inbound: boolean; reason: string } {
  const inInbox = opts.labelIds.includes("INBOX");
  const isOwnSender =
    !!opts.fromEmail &&
    opts.fromEmail.toLowerCase() === String(opts.senderEmailAddress || "").toLowerCase();

  if (!inInbox) return { inbound: false, reason: "not_in_inbox" };
  if (isOwnSender) return { inbound: false, reason: "self_sent" };
  return { inbound: true, reason: "inbound" };
}

async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date | null; scope: string[]; tokenType: string } | null> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: String(refreshToken || ""), client_id: clientId, client_secret: clientSecret }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const accessToken = String(json.access_token || "");
  const expiresInSec = Number(json.expires_in || 0);
  const tokenType = String(json.token_type || "Bearer");
  const scope = String(json.scope || "").split(/\s+/).filter(Boolean);
  return { accessToken, expiresAt: expiresInSec ? new Date(Date.now() + expiresInSec * 1000) : null, scope, tokenType };
}

export async function processCrmEmailSyncJob(job: { tenantId: string; connectionId: string; diag?: boolean }) {
  const { tenantId, connectionId } = job;
  const conn = await db.crmEmailConnection.findFirst({ where: { id: connectionId, tenantId, status: "CONNECTED" } });
  if (!conn) {
    console.warn(`crm-email-sync: connection ${connectionId} not found or not CONNECTED — skipped`);
    return { ok: true, skipped: true, reason: "connection_not_found" };
  }
  if (!conn.replyTrackingEnabled) {
    console.warn(
      `crm-email-sync: connection ${connectionId} (${conn.emailAddress}) has replyTrackingEnabled=false — ` +
      "skipped. Reconnect with enableReplyTracking=true (requires gmail.readonly scope) to enable reply sync.",
    );
    return { ok: true, skipped: true, reason: "reply_tracking_disabled" };
  }

  // Ensure access token present/fresh
  const accessPayload = decryptJson<any>(conn.encryptedAccessToken) || {};
  let accessToken = String(accessPayload?.accessToken || "");
  if (!accessToken || (conn.tokenExpiresAt && conn.tokenExpiresAt < new Date(Date.now() + 60_000))) {
    const rtPayload = decryptJson<any>(conn.encryptedRefreshToken) || {};
    const rt = String(rtPayload?.refreshToken || "");
    if (rt) {
      const refreshed = await refreshAccessToken(rt);
      if (refreshed) {
        accessToken = refreshed.accessToken;
        await db.crmEmailConnection.update({
          where: { id: conn.id },
          data: {
            encryptedAccessToken: encryptJson({ accessToken: refreshed.accessToken, tokenType: refreshed.tokenType, scope: refreshed.scope }),
            tokenExpiresAt: refreshed.expiresAt,
            scopes: refreshed.scope,
            lastSyncAt: new Date(),
          },
        });
      } else {
        console.warn(`crm-email-sync: token refresh failed for connection ${connectionId} (${conn.emailAddress}) — no access token available`);
      }
    }
  }
  if (!accessToken) {
    console.warn(`crm-email-sync: connection ${connectionId} (${conn.emailAddress}) has no usable access token after refresh attempt — skipped`);
    return { ok: false, error: "no_access_token" };
  }

  // Known CRM threads for this connection.
  // Also include legacy threads created before Phase 1.5 added senderConnectionId (June 2026).
  // For USER-scope connections those threads carry the sending user's userId; for TENANT-scope
  // senderConnectionId was always set from day one (TENANT scope added in the same migration).
  const threadOrClauses: Array<{ senderConnectionId: string | null; userId?: string }> = [
    { senderConnectionId: conn.id },
  ];
  if (conn.scope === "USER" && conn.userId) {
    // Legacy USER threads: senderConnectionId was null before Phase 1.5; match by userId.
    threadOrClauses.push({ senderConnectionId: null, userId: conn.userId });
  }
  const threads = await db.crmEmailThread.findMany({
    where: { tenantId, OR: threadOrClauses },
    select: { id: true, gmailThreadId: true, contactId: true, userId: true },
  });
  if (threads.length === 0) {
    console.log(`crm-email-sync: connection ${connectionId} (${conn.emailAddress}) — no CRM threads tracked for this sender; no Gmail API calls made`);
  }
  let fetched = 0;
  let inserted = 0;
  let skippedNotInbound = 0;
  let skippedDuplicates = 0;
  let errorCount = 0;

  for (const t of threads) {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(t.gmailThreadId)}`);
    url.searchParams.set("format", "metadata");
    url.searchParams.set("metadataHeaders", "From");
    url.searchParams.append("metadataHeaders", "To");
    url.searchParams.append("metadataHeaders", "Cc");
    url.searchParams.append("metadataHeaders", "Subject");
    url.searchParams.append("metadataHeaders", "Date");
    url.searchParams.append("metadataHeaders", "Message-Id");
    url.searchParams.append("metadataHeaders", "In-Reply-To");
    url.searchParams.append("metadataHeaders", "References");
    let json: any = null;
    try {
      const res = await fetch(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } });
      json = await res.json().catch(() => ({}));
      if (!res.ok) {
        console.warn(`crm-email-sync: Gmail API HTTP ${res.status} for thread ${t.gmailThreadId} (connection ${connectionId}, email ${conn.emailAddress})`);
        errorCount += 1;
        continue;
      }
    } catch {
      errorCount += 1;
      continue;
    }
    const msgs: any[] = Array.isArray(json?.messages) ? json.messages : [];
    fetched += msgs.length;

    for (const m of msgs) {
      const msgId = String(m?.id || "");
      if (!msgId) continue;
      const labels: string[] = Array.isArray(m?.labelIds) ? m.labelIds : [];
      const payload = m?.payload || {};
      const headers: Array<{ name: string; value: string }> = Array.isArray(payload?.headers) ? payload.headers : [];
      const fromEmail = extractEmail(parseHeader(headers, "From"));
      const toEmail = extractEmail(parseHeader(headers, "To"));
      const subject = parseHeader(headers, "Subject") || null;
      const dateStr = parseHeader(headers, "Date");
      const receivedAt = dateStr ? new Date(dateStr) : null;
      const snippet = typeof m?.snippet === "string" ? m.snippet.slice(0, 300) : null;

      // Classify as inbound: must be in INBOX and not from our own sender address.
      const { inbound } = classifyGmailMessage({ labelIds: labels, fromEmail, senderEmailAddress: conn.emailAddress });
      if (!inbound) {
        skippedNotInbound += 1;
        continue;
      }

      try {
        await db.crmEmailMessage.create({
          data: {
            tenantId,
            userId: t.userId,
            threadId: t.id,
            contactId: t.contactId || null,
            gmailMessageId: msgId,
            direction: "INBOUND",
            subject: subject || null,
            fromEmail: fromEmail || null,
            toEmail: toEmail || null,
            previewSnippet: snippet || null,
            receivedAt: receivedAt || new Date(),
            senderConnectionId: conn.id,
          },
        });
        inserted += 1;

        if (t.contactId) {
          await db.crmTimelineEvent.create({
            data: {
              tenantId,
              contactId: t.contactId,
              type: "EMAIL_RECEIVED",
              title: "Email received",
              body: subject || "Email received",
              metadata: { from: fromEmail, to: toEmail, threadId: t.gmailThreadId },
              createdByUserId: null,
            },
          }).catch(() => undefined);
        }
      } catch {
        // Unique conflict or validation error — skip silently (metadata only)
        skippedDuplicates += 1;
      }
    }
  }

  // Update lastSyncAt regardless of outcome (indicates we attempted)
  await db.crmEmailConnection.update({ where: { id: conn.id }, data: { lastSyncAt: new Date(), lastError: errorCount ? `errors:${errorCount}` : null } }).catch(() => undefined);

  // Write a compact audit breadcrumb with counts only (no message bodies)
  try {
    await db.auditLog.create({
      data: {
        tenantId,
        action: "CRM_EMAIL_SYNC_RESULT",
        entityType: "CrmEmailConnection",
        entityId: conn.id,
        metadata: {
          threadsChecked: threads.length,
          fetched,
          inserted,
          skippedNotInbound,
          skippedDuplicates,
          errors: errorCount,
        },
      },
    });
  } catch {}

  return { ok: true, threadsChecked: threads.length, fetched, inserted, skippedNotInbound, skippedDuplicates, errors: errorCount };
}
