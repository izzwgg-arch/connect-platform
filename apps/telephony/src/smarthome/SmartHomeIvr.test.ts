import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IvrChannel } from "./agi/AgiChannel";
import { parseSmartHomeConfig } from "./config";
import { hashPin } from "./pinHash";
import { PinLockout } from "./pinLockout";
import { HomeAssistantClient } from "./HomeAssistantClient";
import { SmartHomeIvr } from "./SmartHomeIvr";

/** Scripted fake channel: yields queued DTMF inputs, records played prompts. */
class FakeChannel implements IvrChannel {
  readonly callerId: string;
  readonly played: string[] = [];
  readonly inputs: (string | null)[];
  answered = false;
  hungUp = false;

  constructor(inputs: (string | null)[], callerId = "15551230000") {
    this.inputs = [...inputs];
    this.callerId = callerId;
  }
  async answer(): Promise<void> {
    this.answered = true;
  }
  async getData(promptFile: string): Promise<string | null> {
    this.played.push(`getData:${promptFile}`);
    return this.inputs.length > 0 ? this.inputs.shift()! : "";
  }
  async play(promptFile: string): Promise<void> {
    this.played.push(`play:${promptFile}`);
  }
  async hangup(): Promise<void> {
    this.hungUp = true;
  }
}

function makeConfig(overrides: { pin?: string; baseUrl?: string } = {}) {
  return parseSmartHomeConfig({
    accounts: [
      {
        id: "test-home",
        pinHash: hashPin(overrides.pin ?? "4821"),
        ha: { baseUrl: overrides.baseUrl ?? "http://127.0.0.1:1", token: "tok" },
        menu: [
          { digit: "1", label: "lights on", domain: "light", service: "turn_on", entityId: "light.living" },
          { digit: "2", label: "lights off", domain: "light", service: "turn_off", entityId: "light.living" },
        ],
      },
    ],
  });
}

function startHa(): Promise<{ baseUrl: string; close: () => void; calls: string[] }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close(), calls });
    });
  });
}

test("full happy path: PIN → press 1 → HA called → confirmation → goodbye", async () => {
  const ha = await startHa();
  try {
    const events: string[] = [];
    const ivr = new SmartHomeIvr({
      config: makeConfig({ baseUrl: ha.baseUrl }),
      ha: new HomeAssistantClient({ timeoutMs: 2000 }),
      lockout: new PinLockout(),
      onEvent: (e) => events.push(e),
    });
    const chan = new FakeChannel(["4821", "1", "*"]);
    await ivr.handleCall(chan);

    assert.ok(chan.answered);
    assert.ok(chan.hungUp);
    assert.deepEqual(ha.calls, ["/api/services/light/turn_on"]);
    assert.ok(chan.played.includes("play:auth-thankyou"), `played: ${chan.played}`);
    assert.ok(chan.played.at(-1) === "play:vm-goodbye");
    assert.ok(events.includes("auth_success"));
    assert.ok(events.includes("ha_action_ok"));
  } finally {
    ha.close();
  }
});

test("wrong PIN three times → no menu, goodbye, failures recorded", async () => {
  const events: string[] = [];
  const lockout = new PinLockout();
  const ivr = new SmartHomeIvr({
    config: makeConfig(),
    ha: new HomeAssistantClient({ timeoutMs: 500 }),
    lockout,
    onEvent: (e) => events.push(e),
  });
  const chan = new FakeChannel(["1111", "2222", "3333"]);
  await ivr.handleCall(chan);

  assert.ok(chan.hungUp);
  assert.equal(events.filter((e) => e === "auth_failed").length, 3);
  assert.ok(!events.includes("auth_success"));
  // No HA prompts — never reached the menu.
  assert.ok(!chan.played.some((p) => p === "play:auth-thankyou"));
});

test("locked-out caller is refused before any PIN prompt", async () => {
  const lockout = new PinLockout({ windowMs: 60_000, maxPerCaller: 1, maxGlobal: 100 });
  lockout.recordFailure("15551230000");
  const events: string[] = [];
  const ivr = new SmartHomeIvr({
    config: makeConfig(),
    ha: new HomeAssistantClient({ timeoutMs: 500 }),
    lockout,
    onEvent: (e) => events.push(e),
  });
  const chan = new FakeChannel(["4821"]); // correct PIN, but must never be asked
  await ivr.handleCall(chan);

  assert.ok(events.includes("auth_locked_out"));
  assert.ok(!events.includes("auth_success"));
  assert.ok(!chan.played.some((p) => p.startsWith("getData:")));
});

test("unmapped digit plays invalid prompt; HA failure plays fail prompt", async () => {
  const events: string[] = [];
  const ivr = new SmartHomeIvr({
    config: makeConfig(), // baseUrl port 1 → HA unreachable
    ha: new HomeAssistantClient({ timeoutMs: 300 }),
    lockout: new PinLockout(),
    onEvent: (e) => events.push(e),
  });
  const chan = new FakeChannel(["4821", "9", "2", "*"]);
  await ivr.handleCall(chan);

  assert.ok(chan.played.includes("play:invalid"), `played: ${chan.played}`);
  assert.ok(chan.played.includes("play:sorry"), `played: ${chan.played}`);
  assert.ok(events.includes("ha_action_failed"));
});

test("silence twice at the menu ends the call politely", async () => {
  const ivr = new SmartHomeIvr({
    config: makeConfig(),
    ha: new HomeAssistantClient({ timeoutMs: 300 }),
    lockout: new PinLockout(),
  });
  const chan = new FakeChannel(["4821"]); // then only "" timeouts
  await ivr.handleCall(chan);
  assert.ok(chan.hungUp);
  assert.equal(chan.played.at(-1), "play:vm-goodbye");
});

test("caller hangup mid-PIN aborts without throwing", async () => {
  const ivr = new SmartHomeIvr({
    config: makeConfig(),
    ha: new HomeAssistantClient({ timeoutMs: 300 }),
    lockout: new PinLockout(),
  });
  const chan = new FakeChannel([null]);
  await ivr.handleCall(chan);
  assert.ok(chan.hungUp);
});

test("config rejects duplicate menu digits and missing PIN", () => {
  assert.throws(() =>
    parseSmartHomeConfig({
      accounts: [
        {
          id: "dup",
          pinPlain: "1234",
          ha: { baseUrl: "http://x", token: "t" },
          menu: [
            { digit: "1", label: "a", domain: "light", service: "turn_on", entityId: "light.a" },
            { digit: "1", label: "b", domain: "light", service: "turn_off", entityId: "light.b" },
          ],
        },
      ],
    }),
  );
  assert.throws(() =>
    parseSmartHomeConfig({
      accounts: [
        {
          id: "nopin",
          ha: { baseUrl: "http://x", token: "t" },
          menu: [{ digit: "1", label: "a", domain: "light", service: "turn_on", entityId: "light.a" }],
        },
      ],
    }),
  );
});
