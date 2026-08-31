/**
 * Per-call message ordering on the /ws/telephony feed (2026-08-31).
 *
 * The race under test: `call.remove` is broadcast SYNCHRONOUSLY at hangup, but
 * `call.upsert` rides an async CRM-enrichment promise (up to 2.5s). A stale
 * upsert delivered after the remove used to resurrect the dead call on every
 * client — and nothing corrected it until the server's next sweep. That is
 * the "hung up but Active Calls / Team Directory kept showing On Call for up
 * to a minute" complaint.
 *
 * Contracts pinned here:
 *  1. Every call message carries a per-call monotonic `seq`, assigned
 *     synchronously at emit time (so seq order == emit order even when
 *     delivery is late).
 *  2. An enrichment that resolves AFTER the call hung up (or left the store)
 *     delivers NOTHING — the remove is authoritative.
 *
 * Run: node --import tsx --test src/telephony/websocket/TelephonyBroadcaster.seq.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "events";

process.env.JWT_SECRET = "x".repeat(32);
process.env.AMI_USERNAME = "test";
process.env.AMI_PASSWORD = "test";
process.env.ARI_BASE_URL = "http://test.invalid";
process.env.ARI_USERNAME = "test";
process.env.ARI_PASSWORD = "test";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";
process.env.CDR_INGEST_URL = "http://test.invalid/internal/cdr-ingest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TelephonyBroadcaster } = require("./TelephonyBroadcaster") as typeof import("./TelephonyBroadcaster");
import type { NormalizedCall } from "../types";

type Sent = { via: "broadcast" | "client"; event: string; data: Record<string, unknown> };

function makeFakeSocket() {
  const sent: Sent[] = [];
  const client = { ws: { readyState: 1 }, userId: "u1", role: "USER", tenantId: null, extensions: [], isAlive: true };
  return {
    sent,
    broadcast(event: string, data: unknown) {
      sent.push({ via: "broadcast", event, data: data as Record<string, unknown> });
    },
    sendToClient(_client: unknown, event: string, data: unknown) {
      sent.push({ via: "client", event, data: data as Record<string, unknown> });
    },
    forEachClient(fn: (c: unknown) => void) {
      fn(client);
    },
    clientCount: () => 1,
    countMatchingClients: () => 1,
  };
}

function makeCall(id: string, state: NormalizedCall["state"]): NormalizedCall {
  return {
    id,
    linkedId: id,
    tenantId: "tenant-x",
    tenantSlug: null,
    tenantName: null,
    direction: "inbound",
    state,
    from: "8455551234",
    fromName: null,
    to: "101",
    connectedLine: null,
    source_extension: null,
    destination_extension: null,
    channelState: null,
    channels: ["PJSIP/trunk-a"],
    bridgeIds: [],
    extensions: ["101"],
    queueId: null,
    trunk: null,
    startedAt: new Date().toISOString(),
    answeredAt: null,
    extensionAnsweredAt: null,
    endedAt: null,
    durationSec: 0,
    billableSec: 0,
    metadata: {},
  } as unknown as NormalizedCall;
}

function makeStore() {
  const store = new EventEmitter() as EventEmitter & { getById: (id: string) => NormalizedCall | undefined };
  const byId = new Map<string, NormalizedCall>();
  store.getById = (id) => byId.get(id);
  return { store, byId };
}

const noopStores = { on() { /* extensions/queues not under test */ } };
const health = { getHealth: () => ({}) };

function boot(opts: { enricher?: { enabled(): boolean; enrichForClient(call: NormalizedCall, client: unknown): Promise<NormalizedCall> } | null } = {}) {
  const socket = makeFakeSocket();
  const { store, byId } = makeStore();
  const b = new TelephonyBroadcaster(
    socket as never,
    store as never,
    noopStores as never,
    noopStores as never,
    health as never,
    null,
    (opts.enricher ?? null) as never,
  );
  return { socket, store, byId, b };
}

test("SEQ: every call message carries a per-call monotonic seq; hangup remove and explicit remove keep counting", () => {
  const { socket, store, byId, b } = boot();
  const call = makeCall("c1", "up");
  byId.set("c1", call);

  store.emit("callUpsert", call);
  const hungup = { ...call, state: "hungup" as const };
  byId.set("c1", hungup as NormalizedCall);
  store.emit("callUpsert", hungup);
  store.emit("callRemove", "c1");

  const events = socket.sent.map((s) => ({ event: s.event, seq: s.data["seq"] }));
  assert.deepEqual(events, [
    { event: "telephony.call.upsert", seq: 1 },
    { event: "telephony.call.remove", seq: 2 },
    { event: "telephony.call.remove", seq: 3 },
  ]);
  b.stop();
});

test("SEQ: independent calls get independent counters", () => {
  const { socket, store, byId, b } = boot();
  const c1 = makeCall("c1", "up");
  const c2 = makeCall("c2", "up");
  byId.set("c1", c1);
  byId.set("c2", c2);

  store.emit("callUpsert", c1);
  store.emit("callUpsert", c2);
  store.emit("callUpsert", c1);

  const seqs = socket.sent.map((s) => [s.data["id"], s.data["seq"]]);
  assert.deepEqual(seqs, [["c1", 1], ["c2", 1], ["c1", 2]]);
  b.stop();
});

test("THE RACE: an enrichment that resolves AFTER the hangup delivers NOTHING", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => { release = r; });
  const enricher = {
    enabled: () => true,
    enrichForClient: async (call: NormalizedCall) => {
      await gate; // the CRM round-trip is still in flight…
      return call;
    },
  };
  const { socket, store, byId, b } = boot({ enricher });
  const call = makeCall("c1", "ringing");
  byId.set("c1", call);

  store.emit("callUpsert", call); // upsert enters the async enrichment path

  // …the call hangs up while the enrichment is pending. The remove goes out
  // synchronously.
  const hungup = { ...call, state: "hungup" as const };
  byId.set("c1", hungup as NormalizedCall);
  store.emit("callUpsert", hungup);

  // Now the enrichment finally resolves.
  release!();
  await new Promise((r) => setTimeout(r, 10));

  const upserts = socket.sent.filter((s) => s.event === "telephony.call.upsert");
  const removes = socket.sent.filter((s) => s.event === "telephony.call.remove");
  assert.equal(upserts.length, 0, "the stale enriched upsert must be dropped — it would resurrect a dead call");
  assert.equal(removes.length, 1, "the hangup remove went out synchronously");
  b.stop();
});

test("SEQ ACROSS THE ASYNC PATH: a late-but-legitimate enriched upsert carries its EMIT-time seq", async () => {
  const gates: Array<() => void> = [];
  const enricher = {
    enabled: () => true,
    enrichForClient: (call: NormalizedCall) =>
      new Promise<NormalizedCall>((resolve) => { gates.push(() => resolve(call)); }),
  };
  const { socket, store, byId, b } = boot({ enricher });
  const call = makeCall("c1", "up");
  byId.set("c1", call);

  store.emit("callUpsert", call); // seq 1, enrichment pending
  store.emit("callUpsert", call); // seq 2, enrichment pending

  // Deliveries complete OUT OF ORDER — the second emit's send lands first.
  gates[1]!();
  await new Promise((r) => setTimeout(r, 5));
  gates[0]!();
  await new Promise((r) => setTimeout(r, 5));

  const upserts = socket.sent.filter((s) => s.event === "telephony.call.upsert");
  assert.deepEqual(
    upserts.map((s) => s.data["seq"]),
    [2, 1],
    "delivery order flipped, but each message carries its emit-time seq — so the client can drop the stale one",
  );
  b.stop();
});
