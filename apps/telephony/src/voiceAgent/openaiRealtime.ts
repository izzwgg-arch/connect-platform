/**
 * OpenAI Realtime WebSocket client for the voice agent.
 *
 * Speaks the GA realtime interface (no OpenAI-Beta header — sending that
 * header selects the OLD beta event shapes) but tolerates beta-era event
 * names defensively, because the two interfaces differ mostly in names
 * (`response.output_audio.delta` vs `response.audio.delta`) and a bridge that
 * dies on a rename is a phone line that goes dead on a vendor deploy.
 *
 * Audio is g711 μ-law at 8 kHz IN AND OUT — deliberately matched to the
 * PBX's AudioSocket rate so the bridge transcodes companding only, never
 * resamples (see ulaw.ts).
 *
 * ⛔ The API key arrives per call from the api (the TENANT's own key via
 * ProviderCredential/OPENAI). It is held only in this object for the life of
 * the WebSocket and never logged.
 */

import { EventEmitter } from "events";
import WebSocket from "ws";
import { childLogger } from "../logging/logger";

const log = childLogger("VoiceAgentRealtime");

export interface RealtimeToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RealtimeSessionOptions {
  instructions: string;
  voice: string;
  tools: RealtimeToolSpec[];
  /** Silence (ms) before the server decides the caller finished a turn. */
  vadSilenceMs?: number;
}

export interface RealtimeToolCall {
  callId: string;
  name: string;
  argumentsJson: string;
}

export interface RealtimeClientDeps {
  /** Injectable WebSocket factory for tests. */
  createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
  url?: string;
}

// Events:
//  'ready'          — session.updated accepted (safe to greet)
//  'audio'          — Buffer of μ-law bytes from the model
//  'speechStarted'  — caller began talking (barge-in point)
//  'toolCall'       — RealtimeToolCall
//  'transcript'     — { role: 'assistant'|'caller', text, final }
//  'responseDone'   — a response finished
//  'fatal'          — unrecoverable session error (bridge should end call)
//  'closed'         — socket closed
export class OpenAiRealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly deps: RealtimeClientDeps;
  private activeResponseId: string | null = null;
  private closed = false;
  /** Beta-shape retry: flips after a config rejection, once. */
  private triedBetaShape = false;
  private pendingSession: RealtimeSessionOptions | null = null;

  constructor(deps: RealtimeClientDeps = {}) {
    super();
    this.deps = deps;
  }

  connect(apiKey: string, model: string, session: RealtimeSessionOptions): void {
    const url = `${this.deps.url ?? "wss://api.openai.com/v1/realtime"}?model=${encodeURIComponent(model)}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    this.pendingSession = session;
    const ws = this.deps.createSocket
      ? this.deps.createSocket(url, headers)
      : new WebSocket(url, { headers, handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on("open", () => {
      this.sendSessionUpdate("ga");
    });
    ws.on("message", (data) => {
      try {
        this.onMessage(JSON.parse(String(data)));
      } catch (err) {
        log.warn({ err: String(err) }, "voice-agent: unparseable realtime event");
      }
    });
    ws.on("error", (err) => {
      log.warn({ err: String(err?.message ?? err) }, "voice-agent: realtime socket error");
      if (!this.closed) this.emit("fatal", new Error("realtime_socket_error"));
    });
    ws.on("close", () => {
      if (!this.closed) {
        this.closed = true;
        this.emit("closed");
      }
    });
  }

  /** Append caller audio (μ-law bytes). */
  appendAudio(ulaw: Buffer): void {
    this.send({ type: "input_audio_buffer.append", audio: ulaw.toString("base64") });
  }

  /** Ask the model to speak first (the greeting). */
  createResponse(extraInstructions?: string): void {
    const body: Record<string, unknown> = {};
    if (extraInstructions) body["instructions"] = extraInstructions;
    this.send({ type: "response.create", response: body });
  }

  /** Barge-in: stop the in-flight response, if any. */
  cancelActiveResponse(): void {
    if (this.activeResponseId) {
      this.send({ type: "response.cancel", response_id: this.activeResponseId });
      this.activeResponseId = null;
    }
  }

  sendToolOutput(callId: string, output: string): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    });
    this.send({ type: "response.create", response: {} });
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* already dead */
    }
    this.ws = null;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private send(payload: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      log.warn({ err: String(err) }, "voice-agent: realtime send failed");
    }
  }

  private sendSessionUpdate(shape: "ga" | "beta"): void {
    const s = this.pendingSession;
    if (!s) return;
    const tools = s.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    if (shape === "ga") {
      this.send({
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["audio"],
          instructions: s.instructions,
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              transcription: { model: "gpt-4o-mini-transcribe" },
              turn_detection: {
                type: "server_vad",
                silence_duration_ms: s.vadSilenceMs ?? 600,
                create_response: true,
                interrupt_response: true,
              },
            },
            output: { format: { type: "audio/pcmu" }, voice: s.voice },
          },
          tools,
          tool_choice: "auto",
        },
      });
    } else {
      this.send({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: s.instructions,
          voice: s.voice,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: { type: "server_vad", silence_duration_ms: s.vadSilenceMs ?? 600 },
          tools,
          tool_choice: "auto",
        },
      });
    }
  }

  private onMessage(evt: Record<string, unknown>): void {
    const type = String(evt["type"] ?? "");
    switch (type) {
      case "session.created":
        return; // wait for session.updated (our config applied)
      case "session.updated":
        this.emit("ready");
        return;
      case "input_audio_buffer.speech_started":
        this.emit("speechStarted");
        return;
      case "response.created": {
        const resp = evt["response"] as { id?: string } | undefined;
        this.activeResponseId = resp?.id ?? null;
        return;
      }
      // GA and beta names for model audio out:
      case "response.output_audio.delta":
      case "response.audio.delta": {
        const b64 = String(evt["delta"] ?? "");
        if (b64) this.emit("audio", Buffer.from(b64, "base64"));
        return;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        this.emit("transcript", { role: "assistant", text: String(evt["transcript"] ?? ""), final: true });
        return;
      case "conversation.item.input_audio_transcription.completed":
        this.emit("transcript", { role: "caller", text: String(evt["transcript"] ?? ""), final: true });
        return;
      case "response.function_call_arguments.done": {
        const call: RealtimeToolCall = {
          callId: String(evt["call_id"] ?? ""),
          name: String(evt["name"] ?? ""),
          argumentsJson: String(evt["arguments"] ?? "{}"),
        };
        if (call.callId && call.name) this.emit("toolCall", call);
        return;
      }
      case "response.done":
        this.activeResponseId = null;
        this.emit("responseDone");
        return;
      case "error": {
        const err = (evt["error"] ?? {}) as { message?: string; code?: string; param?: string };
        const message = String(err.message ?? "realtime_error");
        // A rejected session shape gets ONE retry with the beta shape — the
        // interfaces renamed fields, and dying on a rename would make every
        // call fail on a vendor-side interface change.
        const looksLikeConfigRejection =
          /unknown|invalid|param|session/i.test(message) && !this.triedBetaShape && this.activeResponseId === null;
        if (looksLikeConfigRejection && /session/i.test(String(err.param ?? "") + message)) {
          this.triedBetaShape = true;
          log.warn({ message }, "voice-agent: GA session shape rejected — retrying with beta shape");
          this.sendSessionUpdate("beta");
          return;
        }
        // response.cancel with nothing active is a benign race, never fatal.
        if (/cancel/i.test(message) && /no active|not active|none/i.test(message)) return;
        log.warn({ message, code: err.code }, "voice-agent: realtime error event");
        this.emit("fatal", new Error(message));
        return;
      }
      default:
        // Deltas we don't consume (text deltas, item lifecycle) are normal.
        return;
    }
  }
}
