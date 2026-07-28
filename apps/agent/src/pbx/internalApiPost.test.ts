/**
 * postInternalApi — transport-level retry for the agent's internal API doors
 * (live incident 2026-07-27: one "fetch failed" blip killed an approved action).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { postInternalApi } from "./internalApiPost";

const noSleep = async () => {};

test("retries a thrown fetch and succeeds on a later attempt", async () => {
  let calls = 0;
  const fetchImpl: any = async () => {
    calls++;
    if (calls < 3) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const resp = await postInternalApi({ url: "http://api:3001/x", secret: "s", body: { a: 1 }, timeoutMs: 1000, fetchImpl, sleep: noSleep });
  assert.equal(resp.status, 200);
  assert.equal(calls, 3);
});

test("rethrows after exhausting attempts", async () => {
  let calls = 0;
  const fetchImpl: any = async () => {
    calls++;
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    () => postInternalApi({ url: "http://api:3001/x", secret: "s", body: {}, timeoutMs: 1000, attempts: 3, fetchImpl, sleep: noSleep }),
    /fetch failed/,
  );
  assert.equal(calls, 3);
});

test("an HTTP error response is returned as-is and NEVER retried", async () => {
  let calls = 0;
  const fetchImpl: any = async () => {
    calls++;
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  };
  const resp = await postInternalApi({ url: "http://api:3001/x", secret: "s", body: {}, timeoutMs: 1000, fetchImpl, sleep: noSleep });
  assert.equal(resp.status, 500);
  assert.equal(calls, 1);
});

test("sends the shared-secret header and JSON body", async () => {
  let seen: any = null;
  const fetchImpl: any = async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response("{}", { status: 200 });
  };
  await postInternalApi({ url: "http://api:3001/internal/agent/moh/override", secret: "sekrit", body: { k: "v" }, timeoutMs: 1000, fetchImpl, sleep: noSleep });
  assert.equal(seen.url, "http://api:3001/internal/agent/moh/override");
  assert.equal((seen.init.headers as any)["x-agent-internal-secret"], "sekrit");
  assert.equal(seen.init.body, JSON.stringify({ k: "v" }));
});
