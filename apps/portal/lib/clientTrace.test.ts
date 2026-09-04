/**
 * The client trace buffer — the bounds are the safety (never one request per
 * event, never unbounded memory, never a retry loop, never while signed out).
 * Runs under node: a minimal window/document/navigator is stubbed so the
 * module's "browser only" guards let it through.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── minimal browser stubs, installed BEFORE the module loads ────────────────
const g = globalThis as Record<string, any>;
let token = "tok";
g.window = {
  addEventListener() {},
  localStorage: { getItem: (k: string) => (k === "token" ? token : null) },
  sessionStorage: { getItem: () => "sess1", setItem() {} },
  location: { origin: "http://localhost" },
};
g.document = { addEventListener() {}, visibilityState: "visible" };
// node 24 exposes `navigator` as a getter-only global; a plain assignment throws.
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 Loopcom/0.1.16 Chrome/146" }, configurable: true, writable: true });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mod = require("./clientTrace") as typeof import("./clientTrace");
const { trace, flushClientTrace, __clientTraceTestSeams: seams, TRACE_BUFFER_CAP, TRACE_BATCH_SIZE, summarizeDevices, shortDeviceId, labelFor, inventorySignature } = mod;

type Sent = { sessionId: string; events: Array<{ kind: string; facts: Record<string, unknown> }>; keepalive: boolean };
let sent: Sent[] = [];
let fail = false;

beforeEach(() => {
  sent = [];
  fail = false;
  token = "tok";
  seams.reset();
  seams.setTransport(async (sessionId, events, keepalive) => {
    if (fail) throw new Error("boom");
    sent.push({ sessionId, events, keepalive });
  });
});

test("events are queued, then sent in ONE batch — never one request per event", async () => {
  for (let i = 0; i < 7; i++) trace("press", { action: "dtmf", i });
  assert.equal(sent.length, 0, "nothing goes out synchronously");
  await flushClientTrace();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].events.length, 7);
  assert.equal(sent[0].sessionId, "sess1");
});

test("⛔ a batch never exceeds the api cap; a big buffer drains in chunks", async () => {
  for (let i = 0; i < 120; i++) trace("press", { i });
  await flushClientTrace();
  assert.equal(sent.length, 3);
  for (const s of sent) assert.ok(s.events.length <= TRACE_BATCH_SIZE);
  assert.equal(sent.reduce((n, s) => n + s.events.length, 0), 120);
});

test("⛔ the buffer is capped — a burst drops the OLDEST, memory never grows", () => {
  for (let i = 0; i < TRACE_BUFFER_CAP + 50; i++) trace("press", { i });
  assert.equal(seams.buffered(), TRACE_BUFFER_CAP);
});

test("⛔ a failed send puts the chunk back and STOPS — no tight retry loop", async () => {
  for (let i = 0; i < 60; i++) trace("press", { i });
  fail = true;
  await flushClientTrace();
  assert.equal(sent.length, 0);
  assert.equal(seams.buffered(), 60, "nothing lost");
  fail = false;
  await flushClientTrace();
  assert.equal(sent.reduce((n, s) => n + s.events.length, 0), 60);
});

test("⛔ signed out: nothing is sent and the buffer waits", async () => {
  token = "";
  trace("press", { action: "answer" });
  await flushClientTrace();
  assert.equal(sent.length, 0);
  assert.equal(seams.buffered(), 1);
});

test("an identical device inventory is not re-sent (a Bluetooth flap that changed nothing)", async () => {
  const devs = [
    { deviceId: "abcdefgh1234", kind: "audioinput", label: "Headset Microphone (Jabra)" },
    { deviceId: "zyxwvuts9876", kind: "audiooutput", label: "Headset Earphone (Jabra)" },
  ];
  trace("device_inventory", { ...summarizeDevices(devs), why: "mount" });
  trace("device_inventory", { ...summarizeDevices(devs), why: "devicechange" });
  trace("device_inventory", { ...summarizeDevices([...devs, { deviceId: "new1new1", kind: "audiooutput", label: "Speakers (Realtek)" }]), why: "devicechange" });
  await flushClientTrace();
  const inv = sent.flatMap((s) => s.events).filter((e) => e.kind === "device_inventory");
  assert.equal(inv.length, 2);
});

test("a keepalive flush sends exactly one request", async () => {
  for (let i = 0; i < 120; i++) trace("press", { i });
  await flushClientTrace({ keepalive: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].keepalive, true);
});

test("helpers: short ids, labels, signatures", () => {
  assert.equal(shortDeviceId("abcdefghijkl"), "abcdefgh");
  assert.equal(shortDeviceId("default"), "default");
  assert.equal(shortDeviceId(""), "");
  const outs = [{ deviceId: "a1", label: "Speakers (Realtek)" }];
  assert.equal(labelFor(outs, "a1"), "Speakers (Realtek)");
  assert.equal(labelFor(outs, ""), "System default");
  assert.equal(labelFor(outs, "zz"), "(unnamed zz)");
  const s = summarizeDevices([{ deviceId: "a1b2c3d4e5", kind: "audiooutput", label: "X" }]);
  assert.deepEqual(s, { inputs: [], outputs: [{ id: "a1b2c3d4", label: "X" }] });
  assert.equal(inventorySignature(s), inventorySignature(summarizeDevices([{ deviceId: "a1b2c3d4ZZZ", kind: "audiooutput", label: "X" }])));
});
