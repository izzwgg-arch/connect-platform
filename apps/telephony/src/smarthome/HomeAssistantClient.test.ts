import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { HaError, HomeAssistantClient } from "./HomeAssistantClient";

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<{ baseUrl: string; close: () => void; requests: { url: string; auth: string }[] }> {
  const requests: { url: string; auth: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", auth: req.headers.authorization ?? "" });
      handler(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close(), requests });
    });
  });
}

test("callService POSTs to the right path with bearer token and entity_id", async () => {
  const srv = await startServer((_req, res, body) => {
    assert.deepEqual(JSON.parse(body), { entity_id: "light.living_room", brightness: 128 });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("[]");
  });
  try {
    const ha = new HomeAssistantClient({ timeoutMs: 2000 });
    await ha.callService(
      { baseUrl: srv.baseUrl, token: "tok123" },
      {
        domain: "light",
        service: "turn_on",
        entityId: "light.living_room",
        serviceData: { brightness: 128 },
      },
    );
    assert.equal(srv.requests.length, 1);
    assert.equal(srv.requests[0].url, "/api/services/light/turn_on");
    assert.equal(srv.requests[0].auth, "Bearer tok123");
  } finally {
    srv.close();
  }
});

test("callService maps 401 to auth error without retry", async () => {
  const srv = await startServer((_req, res) => {
    res.writeHead(401);
    res.end();
  });
  try {
    const ha = new HomeAssistantClient({ timeoutMs: 2000 });
    await assert.rejects(
      ha.callService(
        { baseUrl: srv.baseUrl, token: "bad" },
        { domain: "light", service: "turn_on", entityId: "light.x" },
      ),
      (err: unknown) => err instanceof HaError && err.kind === "auth",
    );
    assert.equal(srv.requests.length, 1);
  } finally {
    srv.close();
  }
});

test("callService maps 500 to service error", async () => {
  const srv = await startServer((_req, res) => {
    res.writeHead(500);
    res.end();
  });
  try {
    const ha = new HomeAssistantClient({ timeoutMs: 2000 });
    await assert.rejects(
      ha.callService(
        { baseUrl: srv.baseUrl, token: "tok" },
        { domain: "switch", service: "toggle", entityId: "switch.x" },
      ),
      (err: unknown) => err instanceof HaError && err.kind === "service",
    );
  } finally {
    srv.close();
  }
});

test("callService retries once on connection failure then reports unreachable", async () => {
  const ha = new HomeAssistantClient({ timeoutMs: 1000 });
  await assert.rejects(
    ha.callService(
      // Port 1 — nothing listens there.
      { baseUrl: "http://127.0.0.1:1", token: "tok" },
      { domain: "light", service: "turn_on", entityId: "light.x" },
    ),
    (err: unknown) => err instanceof HaError && (err.kind === "unreachable" || err.kind === "timeout"),
  );
});

test("getState returns state string and null on failure", async () => {
  const srv = await startServer((req, res) => {
    if (req.url === "/api/states/light.ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ entity_id: "light.ok", state: "on" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const ha = new HomeAssistantClient({ timeoutMs: 2000 });
    const target = { baseUrl: srv.baseUrl, token: "tok" };
    assert.equal(await ha.getState(target, "light.ok"), "on");
    assert.equal(await ha.getState(target, "light.missing"), null);
  } finally {
    srv.close();
  }
});
