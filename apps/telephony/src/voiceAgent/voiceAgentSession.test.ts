/**
 * VoiceAgentSession behavioral tests against fake socket / realtime / api.
 *
 * The invariants that matter:
 *  - the tenant on every tool call comes from the SESSION (api-issued), never
 *    from anything the model said;
 *  - barge-in genuinely flushes queued speech;
 *  - every ending path reports session-end exactly once and terminates the
 *    AudioSocket stream (the dialplan's fallback branch depends on that);
 *  - transfer sets the AstDB flag BEFORE the stream ends.
 */

import "../telephony/services/requeueTestEnv";
import { describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "events";
import type { Socket } from "net";
import { VoiceAgentSession, VOICE_AGENT_TOOLS } from "./VoiceAgentSession";
import { encodeFrame, FRAME_AUDIO, FRAME_TERMINATE } from "./audioSocketFrames";
import type { OpenAiRealtimeClient } from "./openaiRealtime";
import type { VoiceAgentApiClient } from "./voiceAgentApiClient";

class FakeSocket extends EventEmitter {
  writes: Buffer[] = [];
  destroyed = false;
  setNoDelay(): void {}
  write(buf: Buffer): boolean {
    this.writes.push(Buffer.from(buf));
    return true;
  }
  destroy(): void {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
  }
  off(event: string, fn: (...args: unknown[]) => void): this {
    super.off(event, fn);
    return this;
  }
  framesWritten(): Array<{ type: number; len: number }> {
    const out: Array<{ type: number; len: number }> = [];
    let buf = Buffer.concat(this.writes);
    while (buf.length >= 3) {
      const len = buf.readUInt16BE(1);
      if (buf.length < 3 + len) break;
      out.push({ type: buf[0], len });
      buf = buf.subarray(3 + len);
    }
    return out;
  }
}

class FakeRealtime extends EventEmitter {
  connected: Array<{ apiKey: string; model: string; session: unknown }> = [];
  appended: Buffer[] = [];
  toolOutputs: Array<{ callId: string; output: string }> = [];
  responsesCreated: string[] = [];
  cancels = 0;
  closedCount = 0;
  connect(apiKey: string, model: string, session: unknown): void {
    this.connected.push({ apiKey, model, session });
  }
  appendAudio(ulaw: Buffer): void {
    this.appended.push(ulaw);
  }
  createResponse(instructions?: string): void {
    this.responsesCreated.push(instructions ?? "");
  }
  cancelActiveResponse(): void {
    this.cancels++;
  }
  sendToolOutput(callId: string, output: string): void {
    this.toolOutputs.push({ callId, output });
  }
  close(): void {
    this.closedCount++;
  }
}

class FakeApi {
  toolCalls: Array<{ callId: string; tenantId: string; name: string; argumentsJson: string }> = [];
  toolResult: { ok: boolean; output: string; draftId?: string | null } = { ok: true, output: "{}" };
  ended: Array<Record<string, unknown>> = [];
  async toolCall(req: { callId: string; tenantId: string; name: string; argumentsJson: string }) {
    this.toolCalls.push(req);
    return this.toolResult;
  }
  async sessionEnd(req: Record<string, unknown>) {
    this.ended.push(req);
  }
}

const ANN = {
  uuid: "01234567-89ab-cdef-0123-456789abcdef",
  pbxTenant: "102",
  did: "8457231213",
  callerNumber: "3479780090",
};

const START = {
  ok: true as const,
  callId: "call_1",
  tenantId: "tenant_A",
  apiKey: "sk-test",
  model: "gpt-realtime",
  voice: "cedar",
  instructions: "You take orders.",
  greeting: "Thanks for calling the demo store!",
  maxCallSeconds: 600,
};

function build(overrides: { start?: Partial<typeof START> } = {}) {
  const socket = new FakeSocket();
  const rt = new FakeRealtime();
  const api = new FakeApi();
  const transfers: string[] = [];
  const session = new VoiceAgentSession(
    socket as unknown as Socket,
    ANN,
    { ...START, ...overrides.start },
    {
      api: api as unknown as VoiceAgentApiClient,
      setTransferFlag: async (u) => {
        transfers.push(u);
      },
      createRealtime: () => rt as unknown as OpenAiRealtimeClient,
      frameIntervalMs: 2,
    },
  );
  session.run();
  return { socket, rt, api, transfers, session };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("VoiceAgentSession", () => {
  it("connects with the session's key/model and greets on ready", () => {
    const { rt } = build();
    assert.equal(rt.connected.length, 1);
    assert.equal(rt.connected[0].apiKey, "sk-test");
    assert.equal(rt.connected[0].model, "gpt-realtime");
    rt.emit("ready");
    assert.equal(rt.responsesCreated.length, 1);
    assert.match(rt.responsesCreated[0], /Thanks for calling the demo store/);
  });

  it("forwards caller audio as μ-law (320 slin bytes → 160 μ-law bytes)", () => {
    const { socket, rt } = build();
    socket.emit("data", encodeFrame(FRAME_AUDIO, Buffer.alloc(320, 3)));
    assert.equal(rt.appended.length, 1);
    assert.equal(rt.appended[0].length, 160);
  });

  it("paces model audio to the socket as full 320-byte frames", async () => {
    const { socket, rt } = build();
    rt.emit("audio", Buffer.alloc(480, 0x55)); // 3 frames worth of μ-law
    // Windows timer resolution is ~15 ms, so give the 2 ms pacer a wide window.
    await sleep(200);
    const audioFrames = socket.framesWritten().filter((f) => f.type === FRAME_AUDIO);
    assert.ok(audioFrames.length >= 3, `expected ≥3 paced frames, got ${audioFrames.length}`);
    for (const f of audioFrames) assert.equal(f.len, 320);
  });

  it("barge-in flushes queued speech and cancels the response", async () => {
    const { socket, rt } = build();
    rt.emit("audio", Buffer.alloc(8000, 0x55)); // ~1 s of queued speech
    await sleep(10);
    const before = socket.framesWritten().filter((f) => f.type === FRAME_AUDIO).length;
    rt.emit("speechStarted");
    await sleep(30);
    const after = socket.framesWritten().filter((f) => f.type === FRAME_AUDIO).length;
    assert.equal(rt.cancels, 1);
    // At most one frame could have raced the flush.
    assert.ok(after - before <= 1, `queued speech kept playing after barge-in (${before} → ${after})`);
  });

  it("tool calls carry the SESSION tenant, never anything model-supplied", async () => {
    const { rt, api } = build();
    rt.emit("toolCall", {
      callId: "tc1",
      name: "search_items",
      argumentsJson: JSON.stringify({ query: "tomato dip", tenantId: "tenant_EVIL" }),
    });
    await sleep(10);
    assert.equal(api.toolCalls.length, 1);
    assert.equal(api.toolCalls[0].tenantId, "tenant_A");
    assert.equal(api.toolCalls[0].callId, "call_1");
    assert.equal(rt.toolOutputs.length, 1);
  });

  it("end_call(done): goodbye plays, then terminate + session-end 'completed'", async () => {
    const { socket, rt, api } = build();
    rt.emit("toolCall", { callId: "tc2", name: "end_call", argumentsJson: '{"reason":"done"}' });
    await sleep(10);
    assert.match(rt.toolOutputs[0].output, /say_goodbye_now/);
    rt.emit("responseDone"); // goodbye finished, queue empty
    await sleep(10);
    const types = socket.framesWritten().map((f) => f.type);
    assert.ok(types.includes(FRAME_TERMINATE), "terminate frame sent");
    assert.equal(api.ended.length, 1);
    assert.equal(api.ended[0]["endReason"], "completed");
  });

  it("end_call(transfer): AstDB flag set with the session uuid", async () => {
    const { rt, api, transfers } = build();
    rt.emit("toolCall", { callId: "tc3", name: "end_call", argumentsJson: '{"reason":"transfer"}' });
    await sleep(10);
    rt.emit("responseDone");
    await sleep(10);
    assert.deepEqual(transfers, [ANN.uuid]);
    assert.equal(api.ended[0]["endReason"], "transfer");
  });

  it("caller hangup (terminate frame) ends exactly once", async () => {
    const { socket, api } = build();
    socket.emit("data", encodeFrame(FRAME_TERMINATE));
    await sleep(10);
    socket.emit("data", encodeFrame(FRAME_TERMINATE));
    socket.destroy();
    await sleep(10);
    assert.equal(api.ended.length, 1);
    assert.equal(api.ended[0]["endReason"], "caller_hangup");
  });

  it("provider failure ends the session toward the dialplan fallback", async () => {
    const { socket, rt, api } = build();
    rt.emit("fatal", new Error("boom"));
    await sleep(10);
    assert.equal(api.ended.length, 1);
    assert.equal(api.ended[0]["endReason"], "provider_error");
    assert.ok(socket.framesWritten().some((f) => f.type === FRAME_TERMINATE));
  });

  it("transcripts are collected and shipped with session-end", async () => {
    const { rt, api } = build();
    rt.emit("transcript", { role: "assistant", text: "Hi there!", final: true });
    rt.emit("transcript", { role: "caller", text: "Two milks please", final: true });
    rt.emit("fatal", new Error("x"));
    await sleep(10);
    const transcript = api.ended[0]["transcript"] as Array<{ role: string; text: string }>;
    assert.equal(transcript.length, 2);
    assert.equal(transcript[1].role, "caller");
  });

  it("tool registry: the three tools exist and finalize_order requires items", () => {
    const names = VOICE_AGENT_TOOLS.map((t) => t.name).sort();
    assert.deepEqual(names, ["end_call", "finalize_order", "search_items"]);
    const finalize = VOICE_AGENT_TOOLS.find((t) => t.name === "finalize_order")!;
    assert.deepEqual((finalize.parameters as { required?: string[] }).required, ["items"]);
  });
});
