import { db } from "@connect/db";
import { decryptJson, encryptJson } from "@connect/security";

function parseHeader(headers: Array<{ name: string; value: string }>, key: string): string | null {
  const h = headers.find((x) => x.name.toLowerCase() === key.toLowerCase());
  return h ? String(h.value || "") : null;
}

function extractEmail(addr: string | null): string | null {
  if (!addr) return null;
  const m = addr.match(/<([^>]+)>/);
  const v = m ? m[1] : addr;
  return v.trim() || null;
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

export async function processCrmEmailSyncJob(job: { tenantId: string; connectionId: string }) {
  const { tenantId, connectionId } = job;
  const conn = await db.crmEmailConnection.findFirst({ where: { id: connectionId, tenantId, status: "CONNECTED", replyTrackingEnabled: true } });
  if (!conn) return { ok: true, skipped: true };

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
      }
    }
  }
  if (!accessToken) return { ok: false, error: "no_access_token" };

  // Known CRM threads for this connection
  const threads = await db.crmEmailThread.findMany({ where: { tenantId, senderConnectionId: conn.id }, select: { id: true, gmailThreadId: true, contactId: true, userId: true } });
  let fetched = 0;
  let inserted = 0;

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
    const res = await fetch(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) continue;
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

      // Inbound: message in INBOX and not from our own sender address.
      const inbound = labels.includes("INBOX") && (!!fromEmail && fromEmail.toLowerCase() !== String(conn.emailAddress || "").toLowerCase());
      if (!inbound) continue;

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
      }
    }
  }

  return { ok: true, fetched, inserted };
}
