import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IvrChannel } from "./agi/AgiChannel";
import { parseSmartHomeConfig } from "./config";
import { HaError } from "./HomeAssistantClient";
import { HomeAssistantClient } from "./HomeAssistantClient";
import { executeWebhook } from "./webhookExecutor";
import { PinLockout } from "./pinLockout";
import { SmartHomeIvr } from "./SmartHomeIvr";

class FakeChannel implements IvrChannel {
  readonly callerId = "15551230000";
  readonly played: string[] = [];
  readonly inputs: (string | null)[];
  hungUp = false;
  constructor(inputs: (string | null)[]) {
    this.inputs = [...inputs];
  }
  async answer(): Promise<void> {}
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

function startServer(
  status: number,
): Promise<{
  baseUrl: string;
  close: () => void;
  requests: { method: string; url: string; auth: string; body: string }[];
}> {
  const requests: { method: string; url: string; auth: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization ?? "",
        body,
      });
      res.writeHead(status);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close(), requests });
    });
  });
}

test("executeWebhook POSTs body and headers", async () => {
  const srv = await startServer(200);
  try {
    await executeWebhook({
      url: `${srv.baseUrl}/hooks/lights-on`,
      method: "POST",
      headers: { Authorization: "Bearer hooktok" },
      body: { scene: "evening" },
    });
    assert.equal(srv.requests.length, 1);
    assert.equal(srv.requests[0].method, "POST");
    assert.equal(srv.requests[0].url, "/hooks/lights-on");
    assert.equal(srv.requests[0].auth, "Bearer hooktok");
    assert.deepEqual(JSON.parse(srv.requests[0].body), { scene: "evening" });
  } finally {
    srv.close();
  }
});

test("executeWebhook maps 401 to auth and 500 to service errors", async () => {
  const srv401 = await startServer(401);
  const srv500 = await startServer(500);
  try {
    await assert.rejects(
      executeWebhook({ url: `${srv401.baseUrl}/x`, method: "GET" }),
      (e: unknown) => e instanceof HaError && e.kind === "auth",
    );
    await assert.rejects(
      executeWebhook({ url: `${srv500.baseUrl}/x`, method: "GET" }),
      (e: unknown) => e instanceof HaError && e.kind === "service",
    );
  } finally {
    srv401.close();
    srv500.close();
  }
});

test("webhook-only account (no HA section) validates and runs from the IVR menu", async () => {
  const srv = await startServer(200);
  try {
    const config = parseSmartHomeConfig({
      accounts: [
        {
          id: "hooks-only",
          pinPlain: "9999",
          menu: [
            {
              digit: "1",
              label: "garage via node-red",
              webhook: { url: `${srv.baseUrl}/garage`, method: "POST", body: { action: "open" } },
            },
          ],
        },
      ],
    });
    const ivr = new SmartHomeIvr({
      config,
      ha: new HomeAssistantClient({ timeoutMs: 500 }),
      lockout: new PinLockout(),
    });
    const chan = new FakeChannel(["9999", "1", "*"]);
    await ivr.handleCall(chan);
    assert.equal(srv.requests.length, 1);
    assert.equal(srv.requests[0].url, "/garage");
    assert.ok(chan.played.includes("play:auth-thankyou"));
    assert.ok(chan.hungUp);
  } finally {
    srv.close();
  }
});

test("config rejects item with both HA and webhook, or neither, or HA without account.ha", () => {
  const base = { id: "x", pinPlain: "1234" };
  // both
  assert.throws(() =>
    parseSmartHomeConfig({
      accounts: [
        {
          ...base,
          ha: { baseUrl: "http://h", token: "t" },
          menu: [
            {
              digit: "1",
              label: "both",
              domain: "light",
              service: "turn_on",
              entityId: "light.x",
              webhook: { url: "http://w/x" },
            },
          ],
        },
      ],
    }),
  );
  // neither
  assert.throws(() =>
    parseSmartHomeConfig({
      accounts: [{ ...base, menu: [{ digit: "1", label: "empty" }] }],
    }),
  );
  // HA action but no ha section
  assert.throws(() =>
    parseSmartHomeConfig({
      accounts: [
        {
          ...base,
          menu: [{ digit: "1", label: "ha", domain: "light", service: "turn_on", entityId: "light.x" }],
        },
      ],
    }),
  );
});
