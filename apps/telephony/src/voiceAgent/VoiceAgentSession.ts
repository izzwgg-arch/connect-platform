/**
 * One live voice-agent call: AudioSocket TCP on one side, OpenAI realtime on
 * the other, the api's tool doors in the middle.
 *
 * Failure direction, everywhere: END THE AUDIOSOCKET APP AND LET THE DIALPLAN
 * DECIDE. When this session refuses (no config, caps, provider down) or dies
 * mid-call, we terminate the AudioSocket stream and the dialplan's next
 * priority runs — which the PBX wiring points at the tenant's HUMAN fallback.
 * The AI is additive in front of the existing flow, never a replacement: its
 * worst failure is a caller reaching exactly what they reach today.
 *
 * Transfer signalling: the dialplan cannot see WHY AudioSocket returned, so
 * "caller wants a person" is flagged through AstDB (`connect/va/<uuid>` →
 * `transfer`) via the injected setter (AMI DBPut — the wake-dial lane). The
 * dialplan checks that key after AudioSocket and routes accordingly. Flag
 * write failing → worst case the caller lands at the fallback anyway, because
 * the PBX wiring makes FALLBACK the default branch, not hangup.
 *
 * Money/caps: the api enforces tenant caps at session-start; this side owns
 * the HARD per-call ceiling (maxCallSeconds) and an inactivity timeout, so a
 * stuck session cannot run a meter forever even if every other layer fails.
 */

import type { Socket } from "net";
import { childLogger } from "../logging/logger";
import {
  AudioSocketParser,
  FRAME_AUDIO,
  FRAME_ERROR,
  FRAME_TERMINATE,
  FRAME_UUID,
  FRAME_INTERVAL_MS,
  SLIN_FRAME_BYTES,
  encodeFrame,
} from "./audioSocketFrames";
import { slinToUlawBuffer, ulawToSlinBuffer } from "./ulaw";
import type { VoiceAgentAnnouncement } from "./voiceAgentEvents";
import type { SessionStartResponse, VoiceAgentApiClient } from "./voiceAgentApiClient";
import { OpenAiRealtimeClient, type RealtimeToolSpec } from "./openaiRealtime";

const log = childLogger("VoiceAgentSession");

/** Tools the model may call. Definitions live HERE (one place); execution
 * lives behind the api door, which re-validates everything — the model's
 * arguments are untrusted input all the way down. */
export const VOICE_AGENT_TOOLS: RealtimeToolSpec[] = [
  {
    name: "search_items",
    description:
      "Search the store's product catalog. Use for every item the caller mentions — by item number, product code, or name. Returns matching items with exact prices.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Item number, code, or name to search for" } },
      required: ["query"],
    },
  },
  {
    name: "finalize_order",
    description:
      "Create the order after reading the full order back to the caller and getting their confirmation. Only include items previously found via search_items.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              itemNumber: { type: "string" },
              quantity: { type: "number" },
            },
            required: ["itemNumber", "quantity"],
          },
        },
        customerName: { type: "string" },
        comments: { type: "string", description: "Payment remarks such as WIC — goes on the order's comments" },
        notes: { type: "string", description: "Any other caller remarks (delivery instructions etc.)" },
      },
      required: ["items"],
    },
  },
  {
    name: "end_call",
    description:
      "End the call after saying goodbye, or hand the caller to a person. Use reason 'transfer' whenever the caller asks for a human, speaks a language you cannot serve well (such as Yiddish), or you cannot make progress.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string", enum: ["done", "transfer"] } },
      required: ["reason"],
    },
  },
];

export interface VoiceAgentSessionDeps {
  api: VoiceAgentApiClient;
  /** AMI DBPut for the transfer flag; must never throw. */
  setTransferFlag: (uuid: string) => Promise<void>;
  createRealtime?: () => OpenAiRealtimeClient;
  now?: () => number;
  /** Test hook: pacing interval override. */
  frameIntervalMs?: number;
  onClosed?: (session: VoiceAgentSession) => void;
}

type EndReason =
  | "completed"
  | "transfer"
  | "caller_hangup"
  | "refused"
  | "provider_error"
  | "cap_reached"
  | "inactive"
  | "socket_error";

export class VoiceAgentSession {
  readonly uuid: string;
  private readonly socket: Socket;
  private readonly ann: VoiceAgentAnnouncement;
  private readonly deps: VoiceAgentSessionDeps;
  private readonly parser = new AudioSocketParser();
  private realtime: OpenAiRealtimeClient | null = null;
  private start: SessionStartResponse & { ok: true };

  private startedAt = 0;
  private lastActivityAt = 0;
  private ended = false;
  private endReasonPending: "done" | "transfer" | null = null;
  private draftId: string | null = null;

  // Outbound audio pacing: decoded slin bytes queued, drained one 20 ms frame
  // per tick. Barge-in = drop the whole queue.
  private outChunks: Buffer[] = [];
  private outOffset = 0;
  private paceTimer: ReturnType<typeof setInterval> | null = null;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  private readonly transcript: Array<{ role: string; text: string }> = [];
  private readonly toolLog: Array<{ name: string; argumentsJson: string; ok: boolean }> = [];

  constructor(socket: Socket, ann: VoiceAgentAnnouncement, startResp: SessionStartResponse & { ok: true }, deps: VoiceAgentSessionDeps) {
    this.socket = socket;
    this.ann = ann;
    this.uuid = ann.uuid;
    this.start = startResp;
    this.deps = deps;
  }

  /** Wire everything and start the conversation. */
  run(): void {
    const now = this.deps.now ?? (() => Date.now());
    this.startedAt = now();
    this.lastActivityAt = this.startedAt;

    const rt = this.deps.createRealtime ? this.deps.createRealtime() : new OpenAiRealtimeClient();
    this.realtime = rt;

    rt.on("ready", () => {
      rt.createResponse(
        `Greet the caller now. ${this.start.greeting ? `Use this greeting: "${this.start.greeting}"` : "Greet them warmly and ask what they would like to order."}`,
      );
    });
    rt.on("audio", (ulaw: Buffer) => {
      this.lastActivityAt = now();
      this.enqueueModelAudio(ulaw);
    });
    rt.on("speechStarted", () => {
      this.lastActivityAt = now();
      // Barge-in: the caller talked over the model — stop playing immediately.
      this.outChunks = [];
      this.outOffset = 0;
      rt.cancelActiveResponse();
    });
    rt.on("transcript", (t: { role: string; text: string }) => {
      if (t.text) this.transcript.push({ role: t.role, text: t.text });
    });
    rt.on("toolCall", (call) => {
      void this.onToolCall(call.callId, call.name, call.argumentsJson);
    });
    rt.on("responseDone", () => {
      if (this.endReasonPending) this.finishAfterDrain();
    });
    rt.on("fatal", () => void this.end("provider_error"));
    rt.on("closed", () => void this.end("provider_error"));

    rt.connect(this.start.apiKey, this.start.model, {
      instructions: this.start.instructions,
      voice: this.start.voice,
      tools: VOICE_AGENT_TOOLS,
    });

    // Pace model audio to the PBX at the AudioSocket frame cadence.
    this.paceTimer = setInterval(() => this.sendOneFrame(), this.deps.frameIntervalMs ?? FRAME_INTERVAL_MS);
    (this.paceTimer as unknown as { unref?: () => void }).unref?.();

    // Hard per-call ceiling — the last line of cost defence.
    const capMs = Math.max(30, this.start.maxCallSeconds) * 1000;
    this.capTimer = setTimeout(() => void this.end("cap_reached"), capMs);

    // Inactivity: no caller audio AND no model activity for 2 minutes.
    this.idleTimer = setInterval(() => {
      if (now() - this.lastActivityAt > 120_000) void this.end("inactive");
    }, 15_000);
    (this.idleTimer as unknown as { unref?: () => void }).unref?.();
    (this.capTimer as unknown as { unref?: () => void }).unref?.();

    this.socket.on("data", (chunk) => this.onSocketData(chunk));
    this.socket.on("error", () => void this.end("socket_error"));
    this.socket.on("close", () => void this.end("caller_hangup"));
  }

  private onSocketData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch {
      void this.end("socket_error");
      return;
    }
    for (const frame of frames) {
      if (frame.type === FRAME_AUDIO) {
        this.lastActivityAt = (this.deps.now ?? (() => Date.now()))();
        this.realtime?.appendAudio(slinToUlawBuffer(frame.payload));
      } else if (frame.type === FRAME_TERMINATE) {
        void this.end("caller_hangup");
      } else if (frame.type === FRAME_ERROR) {
        log.warn({ uuid: this.uuid }, "voice-agent: AudioSocket error frame");
      } else if (frame.type === FRAME_UUID) {
        // Already consumed by the server before the session was built.
      }
    }
  }

  private enqueueModelAudio(ulaw: Buffer): void {
    this.outChunks.push(ulawToSlinBuffer(ulaw));
    // Bound the queue: past ~60 s of buffered speech something is wrong.
    let total = 0;
    for (const c of this.outChunks) total += c.length;
    if (total > 16_000 * 2 * 60) {
      this.outChunks = [];
      this.outOffset = 0;
    }
  }

  private sendOneFrame(): void {
    if (this.ended) return;
    // Assemble exactly one 320-byte slin frame from the queue, if available.
    let need = SLIN_FRAME_BYTES;
    const parts: Buffer[] = [];
    while (need > 0 && this.outChunks.length > 0) {
      const head = this.outChunks[0];
      const avail = head.length - this.outOffset;
      const takeN = Math.min(avail, need);
      parts.push(head.subarray(this.outOffset, this.outOffset + takeN));
      need -= takeN;
      this.outOffset += takeN;
      if (this.outOffset >= head.length) {
        this.outChunks.shift();
        this.outOffset = 0;
      }
    }
    if (parts.length === 0) return; // silence — send nothing
    let frame = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    if (frame.length < SLIN_FRAME_BYTES) {
      // Pad the tail frame with silence so Asterisk always gets full frames.
      const padded = Buffer.alloc(SLIN_FRAME_BYTES);
      frame.copy(padded, 0);
      frame = padded;
    }
    this.writeFrame(FRAME_AUDIO, frame);
    // If we are wrapping up and the goodbye finished draining, end now.
    if (this.endReasonPending && this.outChunks.length === 0) this.finishAfterDrain();
  }

  private async onToolCall(callId: string, name: string, argumentsJson: string): Promise<void> {
    const rt = this.realtime;
    if (!rt || this.ended) return;
    if (name === "end_call") {
      let reason: "done" | "transfer" = "done";
      try {
        const parsed = JSON.parse(argumentsJson) as { reason?: string };
        if (parsed.reason === "transfer") reason = "transfer";
      } catch {
        /* malformed arguments → treat as done */
      }
      this.toolLog.push({ name, argumentsJson, ok: true });
      this.endReasonPending = reason;
      // Let the model say its goodbye; responseDone + drained queue ends it.
      rt.sendToolOutput(callId, JSON.stringify({ ok: true, say_goodbye_now: true }));
      // Safety: if no goodbye ever arrives, end anyway.
      setTimeout(() => {
        if (!this.ended) this.finishAfterDrain(true);
      }, 12_000);
      return;
    }
    if (name !== "search_items" && name !== "finalize_order") {
      rt.sendToolOutput(callId, JSON.stringify({ error: "unknown_tool" }));
      return;
    }
    const res = await this.deps.api.toolCall({
      callId: this.start.callId,
      tenantId: this.start.tenantId,
      name,
      argumentsJson,
    });
    this.toolLog.push({ name, argumentsJson, ok: res.ok });
    if (res.draftId) this.draftId = res.draftId;
    if (this.ended) return;
    rt.sendToolOutput(callId, res.output);
  }

  private finishAfterDrain(force = false): void {
    if (this.ended || !this.endReasonPending) return;
    if (!force && this.outChunks.length > 0) return; // goodbye still playing
    const reason = this.endReasonPending;
    void this.end(reason === "transfer" ? "transfer" : "completed");
  }

  /** Refusal path used by the server before a session ever runs. */
  static refuse(socket: Socket): void {
    try {
      socket.write(encodeFrame(FRAME_TERMINATE));
    } catch {
      /* peer already gone */
    }
    try {
      socket.destroy();
    } catch {
      /* idem */
    }
  }

  async end(reason: EndReason): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const now = this.deps.now ?? (() => Date.now());
    const seconds = Math.max(0, Math.round((now() - this.startedAt) / 1000));

    if (this.paceTimer) clearInterval(this.paceTimer);
    if (this.capTimer) clearTimeout(this.capTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);

    // Transfer flag FIRST (dialplan reads it the instant AudioSocket returns).
    if (reason === "transfer") {
      try {
        await this.deps.setTransferFlag(this.uuid);
      } catch {
        // Fallback is the dialplan default branch — the caller still lands
        // with a human; we only lose the explicit marker.
      }
    }

    try {
      this.realtime?.close();
    } catch {
      /* idem */
    }
    this.writeFrame(FRAME_TERMINATE, Buffer.alloc(0));
    try {
      this.socket.destroy();
    } catch {
      /* idem */
    }

    log.info({ uuid: this.uuid, tenantId: this.start.tenantId, reason, seconds }, "voice-agent: session ended");
    try {
      await this.deps.api.sessionEnd({
        callId: this.start.callId,
        seconds,
        endReason: reason,
        transcript: this.transcript.slice(0, 400),
        toolCalls: this.toolLog.slice(0, 100),
        draftId: this.draftId,
      });
    } catch {
      /* report is best-effort */
    }
    this.deps.onClosed?.(this);
  }

  private writeFrame(type: number, payload: Buffer): void {
    try {
      if (!this.socket.destroyed) this.socket.write(encodeFrame(type, payload));
    } catch {
      /* socket raced shut */
    }
  }
}
