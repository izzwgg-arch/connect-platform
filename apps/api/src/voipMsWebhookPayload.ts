/**
 * VoIP.ms inbound webhook — the JSON envelope the per-DID `webhook` field POSTs.
 *
 * Captured on production 2026-09-07 by texting Connect's own 845-557-7768 from
 * 845-723-1213 with the per-DID `webhook` (NOT the older `sms_url_callback`)
 * pointed at `/webhooks/voipms/sms`:
 *
 *   POST /api/webhooks/voipms/sms?token=…&from={FROM}&to={TO}&…   ← placeholders
 *   Content-Type: application/json                                   stay LITERAL
 *   {"data":{"id":110997718,
 *            "payload":{"id":110997718,
 *                       "to":[{"status":"webhook_delivered","phone_number":"8455577768"}],
 *                       "from":{"phone_number":"8457231213"},
 *                       "text":"Connect webhook test 14:20:19",
 *                       "type":"SMS",              // "MMS" with media:[{"url":"https://voip.ms/media/…/media.png"}]
 *                       "media":[],
 *                       "received_at":"2026-09-07T14:20:46.000000+00:00",
 *                       "record_type":"message"},
 *            "event_type":"message.received",
 *            "record_type":"event"}}
 *
 * ⛔ The `{FROM}`/`{TO}` placeholders in the query are NEVER substituted on this
 * path, so `mergeVoipMsPayload` (query ⊕ body) hands the handler a literal
 * `to: "{TO}"` and the message is refused `invalid_to` — that is exactly what the
 * first tokened hit did. The envelope is the truth; when it is present it wins
 * over every top-level field.
 *
 * ⛔ Only `message.received` is ingested. Anything else (a future delivery
 * status, an outbound echo) is acknowledged with 200 and ignored — the poll and
 * its dedupe on `voipms:<id>` remain the safety net either way.
 */

export interface VoipMsWebhookMessage {
  /** Sender as VoIP.ms reports it (digits, a short code, or an alphanumeric id). */
  from: string;
  /** Our DID, digits as VoIP.ms reports them. */
  to: string;
  text: string;
  /** VoIP.ms message id — the same number `getSMS`/`getMMS` report, so the poll's `voipms:<id>` dedupe matches. */
  id: string;
  mediaUrls: string[];
  type: string;
}

export type VoipMsWebhookEnvelopeResult =
  | { kind: "message"; message: VoipMsWebhookMessage }
  | { kind: "ignored"; eventType: string }
  | { kind: "not_envelope" };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function mediaUrlsOf(media: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(media)) return out;
  for (const m of media) {
    const u =
      typeof m === "string"
        ? m
        : m && typeof m === "object"
          ? str((m as Record<string, unknown>).url ?? (m as Record<string, unknown>).media_url ?? (m as Record<string, unknown>).link)
          : "";
    if (/^https?:\/\//i.test(u)) out.push(u.trim());
  }
  return out;
}

/**
 * Pure. Returns the message when `payload` carries the VoIP.ms event envelope,
 * `ignored` when it is an envelope for some other event, and `not_envelope` for
 * the legacy flat shape (or anything else) so the caller can fall back to the
 * top-level `from`/`to`/`message` fields.
 */
export function parseVoipMsWebhookEnvelope(payload: Record<string, unknown> | null | undefined): VoipMsWebhookEnvelopeResult {
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>).data : null;
  if (!data || typeof data !== "object") return { kind: "not_envelope" };
  const d = data as Record<string, unknown>;
  const eventType = str(d.event_type);
  const inner = d.payload && typeof d.payload === "object" ? (d.payload as Record<string, unknown>) : null;
  if (!inner) return { kind: "not_envelope" };
  if (eventType !== "message.received") return { kind: "ignored", eventType: eventType || "(none)" };

  const fromObj = inner.from && typeof inner.from === "object" ? (inner.from as Record<string, unknown>) : null;
  const from = fromObj ? str(fromObj.phone_number) : str(inner.from);
  const toArr = Array.isArray(inner.to) ? (inner.to as unknown[]) : inner.to != null ? [inner.to] : [];
  const first = toArr[0];
  const to = first && typeof first === "object" ? str((first as Record<string, unknown>).phone_number) : str(first);
  const id = str(inner.id ?? d.id);
  if (!from || !to || !id) return { kind: "ignored", eventType: `${eventType}:incomplete` };

  return {
    kind: "message",
    message: {
      from,
      to,
      text: typeof inner.text === "string" ? inner.text : str(inner.text),
      id,
      mediaUrls: mediaUrlsOf(inner.media),
      type: str(inner.type) || (Array.isArray(inner.media) && inner.media.length ? "MMS" : "SMS"),
    },
  };
}
