/**
 * VoiceAgentServer tests over a REAL TCP socket on an ephemeral port.
 *
 * The UUID bearer-token gate is the security boundary (the port is
 * internet-reachable — docker-published ports bypass ufw on this host), so
 * the refusal paths get the most attention: unknown UUID, garbage stream,
 * no-UUID timeout, concurrency cap, api refusal. Plus the wiring guards that
 * keep the module inert without its env flag.
 */

import "../telephony/services/requeueTestEnv";
import { describe, it } from "node:test";
import assert from "node:assert";
import net from "net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { VoiceAgentServer } from "./VoiceAgentServer";
import { encodeFrame, FRAME_TERMINATE, FRAME_UUID } from "./audioSocketFrames";
import { voiceAgentEnabled } from "./index";
import type { VoiceAgentApiClient, SessionStartResponse } from "./voiceAgentApiClient";

const UUID = "01234567-89ab-cdef-0123-456789abcdef";
const UUID_BYTES = Buffer.from(UUID.replace(/-/g, ""), "hex");

class FakeApi {
  starts: unknown[] = [];
  response: SessionStartResponse = { ok: false, reason: "voice_agent_disabled" };
  configured = true;
  async sessionStart(req: unknown): Promise<SessionStartResponse> {
    this.starts.push(req);
    return this.response;
  }
  async toolCall() {
    return { ok: true, output: "{}" };
  }
  async sessionEnd() {}
}

async function withServer(
  api: FakeApi,
  fn: (server: VoiceAgentServer, port: number) => Promise<void>,
): Promise<void> {
  const server = new VoiceAgentServer({
    port: 0,
    api: api as unknown as VoiceAgentApiClient,
    dbPut: async () => ({}),
    sessionDeps: {
      // Never dial OpenAI from a unit test.
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
  // port 0 → ephemeral; grab the real one after listen.
  server.start();
  await new Promise((r) => setTimeout(r, 50));
  const port = (server as unknown as { server: net.Server }).server.address() as net.AddressInfo;
  try {
    await fn(server, port.port);
  } finally {
    await server.stop();
  }
}

function connectAndCollect(port: number): Promise<{ socket: net.Socket; chunks: Buffer[]; closed: Promise<void> }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, "127.0.0.1", () => {
      resolve({ socket, chunks, closed });
    });
    const closed = new Promise<void>((r) => socket.on("close", () => r()));
    socket.on("data", (c) => chunks.push(c));
    socket.on("error", () => undefined);
  });
}

describe("VoiceAgentServer", () => {
  it("refuses an unknown UUID with a terminate frame and closes", async () => {
    const api = new FakeApi();
    await withServer(api, async (_server, port) => {
      const { socket, chunks, closed } = await connectAndCollect(port);
      socket.write(encodeFrame(FRAME_UUID, UUID_BYTES));
      await closed;
      const all = Buffer.concat(chunks);
      assert.ok(all.length >= 3 && all[0] === FRAME_TERMINATE, "terminate frame expected");
      assert.equal(api.starts.length, 0, "api never consulted for an unknown uuid");
    });
  });

  it("adopts an announced UUID and consults the api; api refusal terminates", async () => {
    const api = new FakeApi();
    api.response = { ok: false, reason: "no_key" };
    await withServer(api, async (server, port) => {
      server.announce({ uuid: UUID, pbxTenant: "102", did: null, callerNumber: null });
      const { socket, closed } = await connectAndCollect(port);
      socket.write(encodeFrame(FRAME_UUID, UUID_BYTES));
      await closed;
      assert.equal(api.starts.length, 1);
      const req = api.starts[0] as { sessionUuid: string; pbxTenant: string };
      assert.equal(req.sessionUuid, UUID);
      assert.equal(req.pbxTenant, "102");
    });
  });

  it("waits out the AMI/TCP race: announcement arriving AFTER the connection still adopts", async () => {
    const api = new FakeApi();
    api.response = { ok: false, reason: "no_key" };
    await withServer(api, async (server, port) => {
      const { socket, closed } = await connectAndCollect(port);
      socket.write(encodeFrame(FRAME_UUID, UUID_BYTES));
      await new Promise((r) => setTimeout(r, 300));
      server.announce({ uuid: UUID, pbxTenant: "102", did: null, callerNumber: null });
      await closed;
      assert.equal(api.starts.length, 1, "late announcement adopted");
    });
  });

  it("a garbage stream is refused without reaching the api", async () => {
    const api = new FakeApi();
    await withServer(api, async (_server, port) => {
      const { socket, closed } = await connectAndCollect(port);
      // A giant bogus frame header followed by junk trips the overflow guard.
      socket.write(Buffer.from([0x10, 0xff, 0xff]));
      for (let i = 0; i < 1200; i++) socket.write(Buffer.alloc(256, 0x41));
      await closed;
      assert.equal(api.starts.length, 0);
    });
  });

  it("successful start creates a session; concurrency cap refuses the next", async () => {
    const api = new FakeApi();
    api.response = {
      ok: true,
      callId: "c1",
      tenantId: "t1",
      apiKey: "sk-x",
      model: "gpt-realtime",
      voice: "cedar",
      instructions: "x",
      greeting: "",
      maxCallSeconds: 60,
    };
    const uuid2 = "11234567-89ab-cdef-0123-456789abcdef";
    await withServer(api, async (server, port) => {
      (server as unknown as { opts: { maxConcurrentSessions: number } }).opts.maxConcurrentSessions = 1;
      server.announce({ uuid: UUID, pbxTenant: "102", did: null, callerNumber: null });
      const a = await connectAndCollect(port);
      a.socket.write(encodeFrame(FRAME_UUID, UUID_BYTES));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(server.activeSessionCount(), 1, "first session live");

      server.announce({ uuid: uuid2, pbxTenant: "102", did: null, callerNumber: null });
      const b = await connectAndCollect(port);
      b.socket.write(encodeFrame(FRAME_UUID, Buffer.from(uuid2.replace(/-/g, ""), "hex")));
      await b.closed;
      assert.equal(server.activeSessionCount(), 1, "second refused at the cap");
      a.socket.destroy();
    });
  });
});

describe("voice-agent wiring guards", () => {
  it("module is inert without VOICE_AGENT_ENABLED=1", () => {
    assert.equal(voiceAgentEnabled({}), false);
    assert.equal(voiceAgentEnabled({ VOICE_AGENT_ENABLED: "0" }), false);
    assert.equal(voiceAgentEnabled({ VOICE_AGENT_ENABLED: "true" }), false, "only the literal '1' arms it");
    assert.equal(voiceAgentEnabled({ VOICE_AGENT_ENABLED: "1" }), true);
  });

  it("telephony index guards the start in try/catch and the flag gate (source guard)", () => {
    const src = readFileSync(path.join(__dirname, "..", "telephony", "index.ts"), "utf8").replace(/\r\n/g, "\n");
    assert.ok(src.includes("voiceAgentServer = startVoiceAgent(ami)"), "wired into start()");
    const tryIdx = src.indexOf("try {\n      voiceAgentServer = startVoiceAgent");
    assert.ok(tryIdx > 0, "startVoiceAgent call is inside a try block");
    const gate = readFileSync(path.join(__dirname, "index.ts"), "utf8").replace(/\r\n/g, "\n");
    assert.ok(gate.includes('VOICE_AGENT_ENABLED ?? "").trim() === "1"'), "env flag gate present");
  });

  it("isolation: voice-agent sources never import telephony call-path modules (source guard)", () => {
    const files = [
      "index.ts",
      "VoiceAgentServer.ts",
      "VoiceAgentSession.ts",
      "voiceAgentApiClient.ts",
      "openaiRealtime.ts",
      "voiceAgentEvents.ts",
      "audioSocketFrames.ts",
      "ulaw.ts",
    ];
    for (const f of files) {
      // Strip comment lines FIRST — the doc headers name the very modules
      // they promise not to touch (the recorded negative-guard trap).
      const src = readFileSync(path.join(__dirname, f), "utf8")
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      for (const forbidden of ["CallStateStore", "MobilePushNotifier", "TelephonyService", "HealingEngine", "wakeDialLeg"]) {
        assert.ok(!src.includes(forbidden), `${f} must not touch ${forbidden}`);
      }
    }
  });
});
