import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ivritTranscribe, extractIvritText } from "./ivritStt";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("extractIvritText flattens aggregated segment stream", () => {
  const output = [
    { result: [
      [ { type: "segments", data: [{ text: "גוט מארגן" }] } ],
      [ { type: "progress", data: {} }, { type: "segments", data: [{ text: "וואס מאכסטו" }] } ],
    ] },
  ];
  assert.equal(extractIvritText(output), "גוט מארגן וואס מאכסטו");
});

test("extractIvritText tolerates empty / odd shapes", () => {
  assert.equal(extractIvritText([{ result: [] }]), "");
  assert.equal(extractIvritText(undefined), "");
  assert.equal(extractIvritText([]), "");
});

test("ivritTranscribe: runsync COMPLETED inline → text", async () => {
  globalThis.fetch = (async (url: any) => {
    assert.match(String(url), /runsync/);
    return { ok: true, json: async () => ({ status: "COMPLETED", output: [{ result: [[{ type: "segments", data: [{ text: "שלום" }] }]] }] }) } as any;
  }) as any;
  const r = await ivritTranscribe("rpa_key", "ep123", Buffer.from([1, 2, 3, 4]));
  assert.equal(r.text, "שלום");
});

test("ivritTranscribe: polls /status until COMPLETED", async () => {
  let call = 0;
  globalThis.fetch = (async (url: any) => {
    call++;
    if (String(url).includes("runsync")) return { ok: true, json: async () => ({ id: "j1", status: "IN_QUEUE" }) } as any;
    // /status polls
    if (call < 3) return { json: async () => ({ id: "j1", status: "IN_PROGRESS" }) } as any;
    return { json: async () => ({ id: "j1", status: "COMPLETED", output: [{ result: [[{ type: "segments", data: [{ text: "פארטיג" }] }]] }] }) } as any;
  }) as any;
  const r = await ivritTranscribe("rpa_key", "ep123", Buffer.from([1, 2, 3, 4]), { timeoutMs: 20000 });
  assert.equal(r.text, "פארטיג");
});

test("ivritTranscribe: not configured throws", async () => {
  await assert.rejects(() => ivritTranscribe("", "ep", Buffer.from([1])), /ivrit_not_configured/);
  await assert.rejects(() => ivritTranscribe("k", "", Buffer.from([1])), /ivrit_not_configured/);
});
