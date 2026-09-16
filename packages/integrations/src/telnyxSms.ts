/**
 * Telnyx SMS/MMS sender — the third carrier-facing twin beside
 * `VoipMsSmsProvider` and `SignalWireSmsProvider` (2026-09-16 unified
 * messaging build, Phase 1).
 *
 * Lives in @connect/integrations so the WORKER (which dispatches every chat
 * message) and the API can share ONE implementation — a second copy is exactly
 * the two-publish-paths drift this repo keeps paying for. The api's admin test
 * bench (`apps/api/src/telnyx/telnyxClient.ts`) has its own richer client with
 * the TelnyxError taxonomy; THIS one is the minimal outbound send used on the
 * chat hot path.
 *
 * Telnyx Messaging API v2:
 *   POST https://api.telnyx.com/v2/messages
 *   Authorization: Bearer KEY…, JSON body { from, to, text, media_urls? }.
 *   Long text is segmented by Telnyx itself; media_urls carries up to TEN
 *   entries per message, and Telnyx fetches real audio MIME types directly —
 *   so, like SignalWire, voice notes ship as the actual audio file.
 *
 * ⛔ A send is NEVER retried here — a timeout means "we stopped listening",
 * not "it did not happen". The caller decides what a failure means; a
 * duplicate text is worse than a failed one the person can resend.
 */

export interface TelnyxSmsCredentials {
  /** The API v2 key (`KEY…`) — the only value Telnyx auth needs. */
  apiKey: string;
}

export interface TelnyxSmsSendInput {
  tenantId?: string;
  from: string;
  to: string;
  body: string;
  mediaUrls?: string[];
}

export interface TelnyxSmsSendResult {
  status: string;
  /** Fully prefixed (`telnyx:<uuid>`) so dedupe/status keying stays exact. */
  providerMessageId?: string;
  providerStatus?: string;
}

/** Telnyx's /v2/messages accepts up to 10 media_urls entries per message. */
export const TELNYX_MMS_MEDIA_PER_MESSAGE = 10;

/**
 * Telnyx segments long bodies itself; 1600 chars mirrors the SignalWire cap
 * and stays comfortably inside Telnyx's own per-message limit. Split only
 * when we must — no 160-char part dance on our side.
 */
export const TELNYX_MAX_BODY_CHARS = 1600;

export function telnyxBodyChunks(body: string): string[] {
  const text = String(body ?? "");
  if (text.length <= TELNYX_MAX_BODY_CHARS) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += TELNYX_MAX_BODY_CHARS) {
    out.push(text.slice(i, i + TELNYX_MAX_BODY_CHARS));
  }
  return out;
}

function toE164(num: string): string {
  const digits = String(num ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return String(num ?? "").startsWith("+") ? String(num) : `+${digits}`;
}

export class TelnyxSmsProvider {
  private credentials: TelnyxSmsCredentials;
  private testMode: boolean;

  constructor(credentials: TelnyxSmsCredentials, testMode = true) {
    this.credentials = credentials;
    this.testMode = testMode;
    if (!credentials.apiKey) {
      throw new Error("Telnyx credentials are incomplete");
    }
  }

  /**
   * One message out (SMS when no media, MMS when mediaUrls carries anything).
   * Body must already be within TELNYX_MAX_BODY_CHARS (use telnyxBodyChunks);
   * media must be ≤ TELNYX_MMS_MEDIA_PER_MESSAGE.
   */
  async sendMessage(input: TelnyxSmsSendInput): Promise<TelnyxSmsSendResult> {
    // Chaos hook — same shape as SIMULATE_PROVIDER_FAILURE_SIGNALWIRE, used by
    // the fallback tests and any future failure drill. Never set in prod.
    if ((process.env.SIMULATE_PROVIDER_FAILURE_TELNYX || "false").toLowerCase() === "true") {
      const err: any = new Error("Simulated Telnyx provider outage");
      err.provider = "TELNYX";
      err.status = 503;
      err.code = "SIM_TELNYX_DOWN";
      throw err;
    }
    if (this.testMode) {
      return {
        status: "SENT",
        providerMessageId: `telnyx-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        providerStatus: "accepted",
      };
    }

    const payload: Record<string, unknown> = {
      from: toE164(input.from),
      to: toE164(input.to),
      text: String(input.body ?? ""),
    };
    if (input.mediaUrls && input.mediaUrls.length) payload.media_urls = input.mediaUrls;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    let json: any = {};
    try {
      res = await fetch("https://api.telnyx.com/v2/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.credentials.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      json = await res.json().catch(() => ({}));
    } catch (fetchErr: any) {
      const err: any = new Error(
        fetchErr?.name === "AbortError"
          ? "Telnyx did not answer within 30 seconds — the message may or may not have gone out"
          : `Telnyx request failed: ${String(fetchErr?.message || fetchErr).slice(0, 200)}`,
      );
      err.provider = "TELNYX";
      err.code = fetchErr?.name === "AbortError" ? "TELNYX_TIMEOUT" : "TELNYX_UNREACHABLE";
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const messageId = json?.data?.id ? String(json.data.id) : null;
    if (!res.ok || !messageId) {
      const firstError = Array.isArray(json?.errors) ? json.errors[0] : null;
      const err: any = new Error(
        `Telnyx refused the message: ${String(firstError?.detail || firstError?.title || `HTTP ${res.status}`).slice(0, 300)}`,
      );
      err.provider = "TELNYX";
      err.status = res.status;
      err.code = firstError?.code != null ? `TELNYX_${firstError.code}` : "TELNYX_REJECTED";
      throw err;
    }
    return {
      status: "SENT",
      providerMessageId: `telnyx:${messageId}`,
      providerStatus: String(json?.data?.to?.[0]?.status ?? "queued"),
    };
  }
}
