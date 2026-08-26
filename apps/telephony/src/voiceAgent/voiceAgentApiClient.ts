/**
 * Telephony → api doors for the voice agent.
 *
 * Same lane as CDR ingest: base URL derived from CDR_INGEST_URL, authenticated
 * with the shared internal secret. All three doors are secret-gated on the api
 * side and fail closed there; here every call has a hard timeout because the
 * caller is standing on a live phone call — a hung HTTP request must never
 * hold a session hostage.
 *
 * ⛔ session-start returns the TENANT'S OWN OpenAI key (ProviderCredential /
 * OPENAI). It is passed straight into the realtime socket and never logged —
 * a log line with a key in it outlives the call in every log shipper.
 */

import { env } from "../config/env";
import { childLogger } from "../logging/logger";

const log = childLogger("VoiceAgentApi");

export interface SessionStartRequest {
  sessionUuid: string;
  pbxTenant: string;
  did: string | null;
  callerNumber: string | null;
}

export type SessionStartResponse =
  | {
      ok: true;
      callId: string;
      tenantId: string;
      apiKey: string;
      model: string;
      voice: string;
      instructions: string;
      greeting: string;
      maxCallSeconds: number;
    }
  | { ok: false; reason: string };

export interface ToolCallRequest {
  callId: string;
  tenantId: string;
  name: string;
  argumentsJson: string;
}

export interface SessionEndRequest {
  callId: string;
  seconds: number;
  endReason: string;
  transcript: Array<{ role: string; text: string }>;
  toolCalls: Array<{ name: string; argumentsJson: string; ok: boolean }>;
  draftId?: string | null;
}

export class VoiceAgentApiClient {
  private readonly base: string | null;
  private readonly secret: string | undefined;

  constructor(opts: { base?: string; secret?: string } = {}) {
    const derived = env.CDR_INGEST_URL ? env.CDR_INGEST_URL.replace(/\/[^/]+$/, "") : null;
    this.base = opts.base ?? derived;
    this.secret = opts.secret ?? env.CDR_INGEST_SECRET;
  }

  get configured(): boolean {
    return Boolean(this.base && this.secret);
  }

  async sessionStart(req: SessionStartRequest): Promise<SessionStartResponse> {
    const res = await this.post("/voice-agent/session-start", req, 5_000);
    if (!res) return { ok: false, reason: "api_unreachable" };
    if (res["ok"] === true && typeof res["apiKey"] === "string") {
      return res as SessionStartResponse & { ok: true };
    }
    return { ok: false, reason: String(res["reason"] ?? res["error"] ?? "refused") };
  }

  async toolCall(req: ToolCallRequest): Promise<{ ok: boolean; output: string; draftId?: string | null }> {
    const res = await this.post("/voice-agent/tool", req, 10_000);
    if (!res) return { ok: false, output: JSON.stringify({ error: "The system is briefly unavailable — apologise and offer to try once more." }) };
    return {
      ok: res["ok"] === true,
      output: typeof res["output"] === "string" ? res["output"] : JSON.stringify(res["output"] ?? {}),
      draftId: typeof res["draftId"] === "string" ? res["draftId"] : null,
    };
  }

  /** Fire-and-forget: a failed end report must never throw into teardown. */
  async sessionEnd(req: SessionEndRequest): Promise<void> {
    await this.post("/voice-agent/session-end", req, 10_000);
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown> | null> {
    if (!this.base || !this.secret) {
      log.warn({ path }, "voice-agent: api client not configured (CDR_INGEST_URL/SECRET)");
      return null;
    }
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cdr-secret": this.secret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok && json["ok"] === undefined) {
        return { ok: false, reason: String(json["error"] ?? `http_${res.status}`) };
      }
      return json;
    } catch (err) {
      log.warn({ path, err: String(err instanceof Error ? err.message : err) }, "voice-agent: api call failed");
      return null;
    }
  }
}
