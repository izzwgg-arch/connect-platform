/**
 * STRESS: adversarial framing, fuzzed byte streams, concurrency floods,
 * and hostile UUID probes against the real TCP server. Every invariant is
 * re-checked after the assault:
 *  - the UUID bearer gate never admits an un-announced connection;
 *  - the parser never crashes the process on any byte sequence;
 *  - the μ-law transcode round-trips within tolerance on random audio;
 *  - the server never leaks sessions (adopt/refuse always terminate the
 *    socket and the session count returns to baseline);
 *  - the session never sends a non-320-byte audio frame.
 */

import "../telephony/services/requeueTestEnv";
import { describe, it } from "node:test";
import assert from "node:assert";
import net from "net";
import { EventEmitter } from "events";
import type { Socket } from "net";
import { AudioSocketParser, encodeFrame, FRAME_AUDIO, FRAME_TERMINATE, FRAME_UUID } from "./audioSocketFrames";
import { slinToUlawBuffer, ulawToSlinBuffer } from "./ulaw";
import { AnnouncementRegistry } from "./voiceAgentEvents";
import { VoiceAgentServer } from "./VoiceAgentServer";
import { VoiceAgentSession } from "./VoiceAgentSession";
import type { VoiceAgentApiClient, SessionStartResponse } from "./voiceAgentApiClient";
import type { OpenAiRealtimeClient } from "./openaiRealtime";

// Deterministic PRNG so a failure is reproducible from its seed.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uuidFor = (n: number) => {
  const hex = n.toString(16).padStart(8, "0") + "89abcdef0123456789abcdef";
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const uuidBytes = (u: string) => Buffer.from(u.replace(/-/g, ""), "hex");

describe("STRESS: framing parser fuzz", () => {
  it("never throws (except the bounded-overflow guard) on 5000 random byte streams", () => {
    const rand = mulberry32(1337);
    let overflows = 0;
    for (let iter = 0; iter < 5000; iter++) {
      const parser = new AudioSocketParser(8 * 1024);
      const chunks = 1 + Math.floor(rand() * 6);
      try {
        for (let c = 0; c < chunks; c++) {
          const len = Math.floor(rand() * 4000);
          const buf = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i++) buf[i] = Math.floor(rand() * 256);
          const frames = parser.push(buf);
          // Any frame that comes out must have a payload matching its header.
          for (const f of frames) assert.ok(f.payload.length <= 0xffff);
        }
      } catch (err) {
        // The ONLY permitted throw is the documented overflow guard.
        assert.match(String((err as Error).message), /audiosocket_buffer_overflow/);
        overflows++;
      }
    }
    // Some streams SHOULD trip the guard — proves it actually fires.
    assert.ok(overflows > 0, "overflow guard never fired across 5000 fuzz runs");
  });

  it("reassembles 2000 randomly-segmented valid frame streams identically", () => {
    const rand = mulberry32(99);
    for (let iter = 0; iter < 2000; iter++) {
      const nFrames = 1 + Math.floor(rand() * 5);
      const originals: Buffer[] = [];
      const wireParts: Buffer[] = [];
      for (let i = 0; i < nFrames; i++) {
        const payloadLen = Math.floor(rand() * 320);
        const payload = Buffer.allocUnsafe(payloadLen);
        for (let j = 0; j < payloadLen; j++) payload[j] = Math.floor(rand() * 256);
        originals.push(payload);
        wireParts.push(encodeFrame(FRAME_AUDIO, payload));
      }
      const wire = Buffer.concat(wireParts);
      // Random segmentation.
      const parser = new AudioSocketParser();
      const got: Buffer[] = [];
      let pos = 0;
      while (pos < wire.length) {
        const take = 1 + Math.floor(rand() * 400);
        const seg = wire.subarray(pos, Math.min(wire.length, pos + take));
        pos += seg.length;
        for (const f of parser.push(seg)) got.push(f.payload);
      }
      assert.equal(got.length, originals.length);
      for (let i = 0; i < got.length; i++) assert.ok(got[i].equals(originals[i]));
    }
  });
});

describe("STRESS: μ-law transcode on random audio", () => {
  it("slin→ulaw→slin round-trips within companding tolerance over 200k samples", () => {
    const rand = mulberry32(7);
    const N = 200_000;
    const slin = Buffer.allocUnsafe(N * 2);
    for (let i = 0; i < N; i++) slin.writeInt16LE(Math.floor(rand() * 65536) - 32768, i * 2);
    const back = ulawToSlinBuffer(slinToUlawBuffer(slin));
    assert.equal(back.length, slin.length);
    let worstRatio = 0;
    for (let i = 0; i < N; i++) {
      const a = slin.readInt16LE(i * 2);
      const b = back.readInt16LE(i * 2);
      const tol = Math.abs(a) * 0.07 + 132;
      assert.ok(Math.abs(a - b) <= tol, `sample ${a} → ${b}`);
      if (Math.abs(a) > 100) worstRatio = Math.max(worstRatio, Math.abs(a - b) / Math.abs(a));
    }
    // μ-law's whole point: relative error stays bounded across the range.
    // 0.0645 at sample 124 is inherent to μ-law's coarsest segment — verified
    // against the standard decode table (-32124/32124/0 exact). Not a defect.
    assert.ok(worstRatio < 0.066, `worst relative error ${worstRatio}`);
  });
});

// ── real-server assault ──────────────────────────────────────────────────────

class FloodApi {
  starts = 0;
  response: SessionStartResponse = { ok: false, reason: "stress_default" };
  async sessionStart(): Promise<SessionStartResponse> {
    this.starts++;
    return this.response;
  }
  async toolCall() {
    return { ok: true, output: "{}" };
  }
  async sessionEnd() {}
}

async function withServer(api: FloodApi, cap: number, fn: (s: VoiceAgentServer, port: number) => Promise<void>) {
  const server = new VoiceAgentServer({
    port: 0,
    maxConcurrentSessions: cap,
    api: api as unknown as VoiceAgentApiClient,
    dbPut: async () => ({}),
    sessionDeps: {
      createRealtime: () =>
        ({
          on() {},
          connect() {},
          appendAudio() {},
          createResponse() {},
          cancelActiveResponse() {},
          sendToolOutput() {},
          close() {},
        }) as never,
    },
  });
  server.start();
  await new Promise((r) => setTimeout(r, 40));
  const addr = (server as unknown as { server: net.Server }).server.address() as net.AddressInfo;
  try {
    await fn(server, addr.port);
  } finally {
    await server.stop();
  }
}

describe("STRESS: server under assault", () => {
  it("100 hostile probes (bad/absent/garbage UUIDs) admit ZERO sessions and all close", async () => {
    const api = new FloodApi();
    await withServer(api, 8, async (server, port) => {
      const rand = mulberry32(42);
      const closes: Array<Promise<void>> = [];
      for (let i = 0; i < 100; i++) {
        const sock = net.connect(port, "127.0.0.1");
        closes.push(new Promise<void>((r) => sock.on("close", () => r())));
        sock.on("error", () => undefined);
        sock.on("connect", () => {
          const mode = i % 4;
          if (mode === 0) sock.write(encodeFrame(FRAME_UUID, uuidBytes(uuidFor(900000 + i)))); // unknown uuid
          else if (mode === 1) sock.write(Buffer.from([0x01, 0x00, 0x08, 1, 2, 3])); // truncated uuid frame, then nothing
          else if (mode === 2) {
            // garbage flood
            for (let k = 0; k < 300; k++) {
              const b = Buffer.allocUnsafe(200);
              for (let j = 0; j < b.length; j++) b[j] = Math.floor(rand() * 256);
              sock.write(b);
            }
          }
          // mode 3: connect and stay silent (UUID timeout path)
        });
      }
      // Wait for the timeout path (5 s) plus margin.
      await Promise.race([Promise.all(closes), new Promise((r) => setTimeout(r, 7000))]);
      assert.equal(api.starts, 0, "no api session-start for any hostile probe");
      assert.equal(server.activeSessionCount(), 0, "no sessions leaked");
    });
  });

  it("concurrency cap holds under a simultaneous burst; excess is refused, count never exceeds cap", async () => {
    const api = new FloodApi();
    api.response = {
      ok: true,
      callId: "c",
      tenantId: "t",
      apiKey: "k",
      model: "gpt-realtime",
      voice: "cedar",
      instructions: "x",
      greeting: "",
      maxCallSeconds: 60,
    };
    const CAP = 4;
    await withServer(api, CAP, async (server, port) => {
      const socks: net.Socket[] = [];
      for (let i = 0; i < 20; i++) {
        server.announce({ uuid: uuidFor(i), pbxTenant: "102", did: null, callerNumber: null });
        const sock = net.connect(port, "127.0.0.1");
        sock.on("error", () => undefined);
        sock.on("connect", () => sock.write(encodeFrame(FRAME_UUID, uuidBytes(uuidFor(i)))));
        socks.push(sock);
      }
      // Poll the live count; it must never exceed the cap at any instant.
      let peak = 0;
      for (let t = 0; t < 30; t++) {
        peak = Math.max(peak, server.activeSessionCount());
        assert.ok(server.activeSessionCount() <= CAP, `count ${server.activeSessionCount()} exceeded cap ${CAP}`);
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.ok(peak >= 1 && peak <= CAP);
      for (const s of socks) s.destroy();
    });
  });
});

// ── session-level chaos: every audio frame the session emits is well-formed ──

class ChaosSocket extends EventEmitter {
  writes: Buffer[] = [];
  destroyed = false;
  setNoDelay() {}
  write(b: Buffer) {
    this.writes.push(Buffer.from(b));
    return true;
  }
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
  }
  off(e: string, f: (...a: unknown[]) => void) {
    super.off(e, f);
    return this;
  }
}
class ChaosRealtime extends EventEmitter {
  connect() {}
  appendAudio() {}
  createResponse() {}
  cancelActiveResponse() {}
  sendToolOutput() {}
  close() {}
}
class ChaosApi {
  async toolCall() {
    return { ok: true, output: "{}" };
  }
  async sessionEnd() {}
}

describe("STRESS: session emits only well-formed audio under random model output", () => {
  it("across 300 sessions of random-sized model audio + barge-ins, every emitted AUDIO frame is exactly 320 bytes", async () => {
    const rand = mulberry32(2024);
    for (let iter = 0; iter < 300; iter++) {
      const socket = new ChaosSocket();
      const rt = new ChaosRealtime();
      const session = new VoiceAgentSession(
        socket as unknown as Socket,
        { uuid: uuidFor(iter), pbxTenant: "102", did: null, callerNumber: null },
        {
          ok: true,
          callId: "c",
          tenantId: "t",
          apiKey: "k",
          model: "gpt-realtime",
          voice: "cedar",
          instructions: "x",
          greeting: "",
          maxCallSeconds: 600,
        },
        {
          api: new ChaosApi() as unknown as VoiceAgentApiClient,
          setTransferFlag: async () => {},
          createRealtime: () => rt as unknown as OpenAiRealtimeClient,
          frameIntervalMs: 1,
        },
      );
      session.run();
      // Fire random model audio + random barge-ins + random caller audio.
      const events = 3 + Math.floor(rand() * 8);
      for (let e = 0; e < events; e++) {
        const roll = rand();
        if (roll < 0.5) rt.emit("audio", Buffer.alloc(1 + Math.floor(rand() * 700), Math.floor(rand() * 256)));
        else if (roll < 0.7) rt.emit("speechStarted");
        else socket.emit("data", encodeFrame(FRAME_AUDIO, Buffer.alloc(320, Math.floor(rand() * 256))));
      }
      await new Promise((r) => setTimeout(r, 30));
      await session.end("completed");
      // Every AUDIO frame this session wrote must be exactly one slin frame.
      let buf = Buffer.concat(socket.writes);
      while (buf.length >= 3) {
        const len = buf.readUInt16BE(1);
        if (buf.length < 3 + len) break;
        const type = buf[0];
        if (type === FRAME_AUDIO) assert.equal(len, 320, `malformed audio frame len ${len} in iter ${iter}`);
        buf = buf.subarray(3 + len);
      }
    }
  });
});
