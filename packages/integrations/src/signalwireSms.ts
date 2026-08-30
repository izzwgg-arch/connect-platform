/**
 * SignalWire SMS/MMS sender — the carrier-facing twin of `VoipMsSmsProvider`.
 *
 * Lives in @connect/integrations so the WORKER (which dispatches every chat
 * message) and the API can share ONE implementation — a second copy is exactly
 * the two-publish-paths drift this repo keeps paying for. The api's admin test
 * bench (`apps/api/src/signalwire/signalWireClient.ts`) has its own richer
 * client with the SignalWireError taxonomy; THIS one is the minimal outbound
 * send used on the chat hot path.
 *
 * SignalWire's Compatibility API (Twilio-shaped):
 *   POST https://<space>/api/laml/2010-04-01/Accounts/<projectId>/Messages.json
 *   Basic auth projectId:apiToken, form-encoded. `MediaUrl` repeats — up to
 *   TEN media per message (vs VoIP.ms's three), and it accepts real audio MIME
 *   types, which is why voice notes on a SignalWire number ship as the actual
 *   audio file instead of the MP4 workaround VoIP.ms forces.
 *
 * ⛔ A send is NEVER retried here — a timeout means "we stopped listening",
 * not "it did not happen" (the addLNPPort / setSubAccount lesson). The caller
 * decides what a failure means; a duplicate text is worse than a failed one
 * that the person can resend.
 */

export interface SignalWireSmsCredentials {
  /** Bare host, e.g. `loopcom.signalwire.com` — no scheme, no path. */
  spaceUrl: string;
  projectId: string;
  apiToken: string;
}

export interface SignalWireSmsSendInput {
  tenantId?: string;
  from: string;
  to: string;
  body: string;
  mediaUrls?: string[];
}

export interface SignalWireSmsSendResult {
  status: string;
  providerMessageId?: string;
  providerStatus?: string;
  numSegments?: number | null;
}

/** SignalWire's Compatibility API accepts up to 10 MediaUrl entries per message. */
export const SIGNALWIRE_MMS_MEDIA_PER_MESSAGE = 10;

/**
 * SignalWire segments long bodies itself; 1600 chars is their documented hard
 * cap per message. Split only when we must — unlike VoIP.ms there is no
 * 160-char part dance on our side.
 */
export const SIGNALWIRE_MAX_BODY_CHARS = 1600;

export function signalWireBodyChunks(body: string): string[] {
  const text = String(body ?? "");
  if (text.length <= SIGNALWIRE_MAX_BODY_CHARS) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += SIGNALWIRE_MAX_BODY_CHARS) {
    out.push(text.slice(i, i + SIGNALWIRE_MAX_BODY_CHARS));
  }
  return out;
}

function toE164(num: string): string {
  const digits = String(num ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return String(num ?? "").startsWith("+") ? String(num) : `+${digits}`;
}

export class SignalWireSmsProvider {
  private credentials: SignalWireSmsCredentials;
  private testMode: boolean;

  constructor(credentials: SignalWireSmsCredentials, testMode = true) {
    this.credentials = credentials;
    this.testMode = testMode;
    if (!credentials.spaceUrl || !credentials.projectId || !credentials.apiToken) {
      throw new Error("SignalWire credentials are incomplete");
    }
  }

  /**
   * One message out (SMS when no media, MMS when mediaUrls carries anything).
   * Body must already be within SIGNALWIRE_MAX_BODY_CHARS (use
   * signalWireBodyChunks); media must be ≤ SIGNALWIRE_MMS_MEDIA_PER_MESSAGE.
   */
  async sendMessage(input: SignalWireSmsSendInput): Promise<SignalWireSmsSendResult> {
    if ((process.env.SIMULATE_PROVIDER_FAILURE_SIGNALWIRE || "false").toLowerCase() === "true") {
      const err: any = new Error("Simulated SignalWire provider outage");
      err.provider = "SIGNALWIRE";
      err.status = 503;
      err.code = "SIM_SIGNALWIRE_DOWN";
      throw err;
    }
    if (this.testMode) {
      return {
        status: "SENT",
        providerMessageId: `signalwire-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        providerStatus: "accepted",
      };
    }

    const form = new URLSearchParams();
    form.set("From", toE164(input.from));
    form.set("To", toE164(input.to));
    form.set("Body", String(input.body ?? ""));
    for (const url of input.mediaUrls ?? []) form.append("MediaUrl", url);

    const host = this.credentials.spaceUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    const url = `https://${host}/api/laml/2010-04-01/Accounts/${encodeURIComponent(this.credentials.projectId)}/Messages.json`;
    const auth = Buffer.from(`${this.credentials.projectId}:${this.credentials.apiToken}`).toString("base64");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    let json: any = {};
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: controller.signal,
      });
      json = await res.json().catch(() => ({}));
    } catch (fetchErr: any) {
      const err: any = new Error(
        fetchErr?.name === "AbortError"
          ? "SignalWire did not answer within 30 seconds — the message may or may not have gone out"
          : `SignalWire request failed: ${String(fetchErr?.message || fetchErr).slice(0, 200)}`,
      );
      err.provider = "SIGNALWIRE";
      err.code = fetchErr?.name === "AbortError" ? "SIGNALWIRE_TIMEOUT" : "SIGNALWIRE_UNREACHABLE";
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok || !json?.sid) {
      const err: any = new Error(
        `SignalWire refused the message: ${String(json?.message || json?.error_message || `HTTP ${res.status}`).slice(0, 300)}`,
      );
      err.provider = "SIGNALWIRE";
      err.status = res.status;
      err.code = json?.code != null ? `SIGNALWIRE_${json.code}` : "SIGNALWIRE_REJECTED";
      throw err;
    }
    return {
      status: "SENT",
      providerMessageId: `signalwire:${json.sid}`,
      providerStatus: String(json.status ?? "queued"),
      numSegments: json.num_segments != null ? Number(json.num_segments) : null,
    };
  }
}
