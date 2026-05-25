import type { WaNormalizedEvent, WaInboundMessageEvent, WaStatusEvent } from "@connect/shared/src/whatsappTypes";

function sanitize(input: unknown): Record<string, unknown> {
  const src = (input && typeof input === "object") ? (input as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  const blocked = new Set(["authorization", "auth", "token", "secret", "password", "access_token", "verify_token", "app_secret", "webhook_secret"]);
  for (const [k, v] of Object.entries(src)) {
    const key = String(k || "").toLowerCase();
    if (blocked.has(key) || key.includes("token") || key.includes("secret") || key.includes("password")) continue;
    out[k] = v;
  }
  return out;
}

export function normalizeMeta(body: any, tenantId: string, phoneNumberId: string): WaNormalizedEvent[] {
  const out: WaNormalizedEvent[] = [];
  const entry = Array.isArray(body?.entry) ? body.entry[0] : null;
  const changes = Array.isArray(entry?.changes) ? entry.changes[0] : null;
  const value = changes?.value || {};
  const metadata = value?.metadata || {};
  const displayNumber = String(metadata?.display_phone_number || "").trim();
  const messages = Array.isArray(value?.messages) ? value.messages : [];
  const statuses = Array.isArray(value?.statuses) ? value.statuses : [];

  for (const m of messages) {
    const from = String(m?.from || "").trim();
    const textBody = String(m?.text?.body || m?.button?.text || "").trim();
    const extId = String(m?.id || "").trim() || null;
    const ev: WaInboundMessageEvent = {
      type: "wa_inbound_message",
      tenantId,
      provider: "WHATSAPP_META",
      accountRef: phoneNumberId,
      externalMessageId: extId,
      from,
      to: displayNumber || `meta:${phoneNumberId}`,
      bodyText: textBody || null,
      media: undefined, // PR1: leave media for PR2
      timestamp: new Date().toISOString(),
      providerPayloadRedacted: sanitize(m),
    };
    out.push(ev);
  }

  for (const s of statuses) {
    const extId = String(s?.id || "").trim();
    if (!extId) continue;
    const stRaw = String(s?.status || "").toLowerCase();
    const status = stRaw === "failed" ? "FAILED" : stRaw === "delivered" ? "DELIVERED" : stRaw === "sent" ? "SENT" : "QUEUED";
    const ev: WaStatusEvent = {
      type: "wa_status",
      tenantId,
      provider: "WHATSAPP_META",
      accountRef: phoneNumberId,
      externalMessageId: extId,
      status,
      errorCode: status === "FAILED" ? String(s?.errors?.[0]?.code || "DELIVERY_FAILED") : null,
      timestamp: new Date().toISOString(),
      providerPayloadRedacted: sanitize(s),
    };
    out.push(ev);
  }

  return out;
}

export function normalizeTwilioStatus(form: Record<string, any>, tenantId: string): WaNormalizedEvent[] {
  const out: WaNormalizedEvent[] = [];
  const accountSid = String(form.AccountSid || form.accountSid || "").trim();
  const messageSid = String(form.MessageSid || form.SmsSid || form.messageSid || "").trim();
  const statusRaw = String(form.MessageStatus || form.SmsStatus || form.status || "").trim().toLowerCase();
  const body = String(form.Body || form.body || "").trim();
  const from = String(form.From || form.from || "").trim();
  const to = String(form.To || form.to || "").trim();

  const direction = statusRaw === "received" || (body && !statusRaw) ? "INBOUND" : "OUTBOUND";
  if (direction === "INBOUND" && (from || body)) {
    const ev: WaInboundMessageEvent = {
      type: "wa_inbound_message",
      tenantId,
      provider: "WHATSAPP_TWILIO",
      accountRef: accountSid,
      externalMessageId: messageSid || null,
      from,
      to,
      bodyText: body || null,
      media: undefined,
      timestamp: new Date().toISOString(),
      providerPayloadRedacted: sanitize(form),
    };
    out.push(ev);
  }

  if (messageSid) {
    const mappedStatus = statusRaw === "failed" || statusRaw === "undelivered" ? "FAILED" : statusRaw === "delivered" ? "DELIVERED" : statusRaw === "sent" || statusRaw === "accepted" ? "SENT" : direction === "INBOUND" ? "INBOUND" as any : "QUEUED";
    const ev: WaStatusEvent = {
      type: "wa_status",
      tenantId,
      provider: "WHATSAPP_TWILIO",
      accountRef: accountSid,
      externalMessageId: messageSid,
      status: mappedStatus === ("INBOUND" as any) ? "QUEUED" : mappedStatus, // ensure WaStatus shape
      errorCode: mappedStatus === "FAILED" ? String(form.ErrorCode || form.error_code || "DELIVERY_FAILED") : null,
      timestamp: new Date().toISOString(),
      providerPayloadRedacted: sanitize(form),
    };
    out.push(ev);
  }

  return out;
}
