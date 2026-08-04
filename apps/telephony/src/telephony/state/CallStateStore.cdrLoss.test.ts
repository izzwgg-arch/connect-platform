/**
 * The CDR-loss hardening (2026-08-04).
 *
 * Root cause of "RelaxTires ext 101 sees no calls today": reconcileActiveBridges
 * force-evicted a LIVE call 0.8s after its bridges formed (stale ARI snapshot),
 * eviction emitted no hungup callUpsert so CdrNotifier never fired, and the real
 * AMI Cdr event arrived after the 30s retention window — the call vanished from
 * history. 71 calls erased on Aug 4, 179 on Aug 3, across all tenants.
 *
 * Four guarantees under test:
 *  1. Reconcile needs TWO consecutive absent polls before evicting.
 *  2. A freshly-bridged call is never evicted by reconcile (grace window).
 *  3. Every eviction path emits `callEvicted` so the CDR is filed regardless.
 *  4. An AMI Cdr event for an unknown call emits `orphanCdr` (synthesized call)
 *     — the PBX's own end-of-call report can never be dropped.
 *
 * Run: node --import tsx --test src/telephony/state/CallStateStore.cdrLoss.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

// Env bootstrap — env.ts validates on import (same pattern as CdrNotifier tests).
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
const { CallStateStore } = require("./CallStateStore") as typeof import("./CallStateStore");
import type { NormalizedCall } from "../types";

const OLD_BRIDGE_MS = Date.now() - 60_000;

/** Boot a store holding one bridged, answered call. Returns store + live call ref. */
function storeWithBridgedCall(opts?: { bridgeAgeMs?: number }) {
  const store = new CallStateStore();
  const call = store.upsertFromNewchannel({
    linkedId: "1785860821.162724",
    uniqueid: "1785860821.162724",
    channel: "PJSIP/344022_Comfortcont-00010f3b",
    channelState: "6",
    callerIDNum: "8456623080",
    callerIDName: "",
    connectedLineNum: "",
    connectedLineName: "",
    context: "T25_cos-all",
    exten: "8457761765",
    tenantId: "tenant-relax-tires",
    tenantSlug: "relax_tires",
    tenantName: "Relax Tires",
    direction: "inbound",
  });
  // Second real (non-helper) leg — getActive() requires a bridge with ≥2
  // non-helper channels, matching the live call's trunk + outbound pair.
  store.upsertFromNewchannel({
    linkedId: "1785860821.162724",
    uniqueid: "1785860840.162729",
    channel: "PJSIP/0001-00010f3c",
    channelState: "6",
    callerIDNum: "8455129339",
    callerIDName: "",
    connectedLineNum: "",
    connectedLineName: "",
    context: "trk-72-in",
    exten: "",
    tenantId: null,
    tenantSlug: null,
    tenantName: null,
    direction: "inbound",
  });
  store.onBridgeEnter({
    linkedId: "1785860821.162724",
    uniqueid: "1785860821.162724",
    bridgeId: "bridge-1",
    bridgeNumChannels: "2",
  });
  // onBridgeEnter stamps "now"; tests that need an old bridge override it.
  call.metadata["lastBridgeEnterAtMs"] = opts?.bridgeAgeMs ?? OLD_BRIDGE_MS;
  return { store, call };
}

test("reconcile: first absent poll is a strike, not an eviction", () => {
  const { store } = storeWithBridgedCall();
  const evicted: NormalizedCall[] = [];
  store.on("callEvicted", (c) => evicted.push(c));

  store.reconcileActiveBridges([]); // snapshot says: no bridges

  assert.equal(evicted.length, 0, "one stale snapshot must not kill a live call");
  assert.equal(store.getActive().length, 1);
});

test("reconcile: two consecutive absent polls evict — and the CDR is filed", () => {
  const { store } = storeWithBridgedCall();
  const evicted: NormalizedCall[] = [];
  store.on("callEvicted", (c) => evicted.push(c));

  store.reconcileActiveBridges([]);
  store.reconcileActiveBridges([]);

  assert.equal(evicted.length, 1, "second consecutive absence confirms the zombie");
  assert.equal(evicted[0]!.state, "hungup");
  assert.equal(evicted[0]!.linkedId, "1785860821.162724");
  assert.ok(evicted[0]!.endedAt, "filed record carries an end time");
  assert.equal(store.getActive().length, 0);
});

test("reconcile: a bridge present in the poll resets the strike counter", () => {
  const { store } = storeWithBridgedCall();
  const evicted: NormalizedCall[] = [];
  store.on("callEvicted", (c) => evicted.push(c));

  store.reconcileActiveBridges([]);           // strike 1
  store.reconcileActiveBridges(["bridge-1"]); // seen again — reset
  store.reconcileActiveBridges([]);           // strike 1 again

  assert.equal(evicted.length, 0);
  assert.equal(store.getActive().length, 1);
});

test("THE BUG: a freshly-bridged call survives stale snapshots (grace window)", () => {
  const { store } = storeWithBridgedCall({ bridgeAgeMs: Date.now() }); // bridged just now
  const evicted: NormalizedCall[] = [];
  store.on("callEvicted", (c) => evicted.push(c));

  // The live incident: the poll snapshot predates the bridge, reconcile ran
  // 0.8s after BridgeEnter and evicted a connected 5-minute call.
  store.reconcileActiveBridges([]);
  store.reconcileActiveBridges([]);
  store.reconcileActiveBridges([]);

  assert.equal(evicted.length, 0, "grace window must protect a just-bridged call");
  assert.equal(store.getActive().length, 1);
});

test("ghost cleanup (missed/renamed hangup) files the CDR", () => {
  const { store, call } = storeWithBridgedCall();
  const evicted: NormalizedCall[] = [];
  store.on("callEvicted", (c) => evicted.push(c));

  // Masquerade scenario: Asterisk renamed the trunk channel, so its Hangup
  // event's channel string doesn't match what the store recorded — the channel
  // list never empties. The second leg hangs up normally. Result: no live
  // channelIndex entries but a non-empty channel list = ghost.
  store.onHangup({
    linkedId: "1785860821.162724",
    uniqueid: "1785860821.162724",
    channel: "PJSIP/344022_Comfortcont-00010f3b<ZOMBIE>",
    cause: "16",
  });
  store.onHangup({
    linkedId: "1785860821.162724",
    uniqueid: "1785860840.162729",
    channel: "PJSIP/0001-00010f3c",
    cause: "16",
  });
  assert.equal(call.state, "up", "precondition: missed hangup leaves the call active");

  store.runStaleCleanup();

  assert.equal(evicted.length, 1, "ghost cleanup must file the record, not eat it");
  assert.equal(evicted[0]!.state, "hungup");
});

test("clearAll (AMI disconnect) files provisional CDRs for active calls", () => {
  const { store } = storeWithBridgedCall();
  const evicted: NormalizedCall[] = [];
  store.on("callEvicted", (c) => evicted.push(c));

  store.clearAll();

  assert.equal(evicted.length, 1);
  assert.equal(evicted[0]!.state, "hungup");
  assert.equal(evicted[0]!.metadata["staleEvictReason"], "ami_disconnect_clear_all");
});

test("orphan Cdr: an AMI Cdr event for an unknown call is synthesized and filed", () => {
  const store = new CallStateStore();
  const orphans: NormalizedCall[] = [];
  store.on("orphanCdr", (c) => orphans.push(c));

  // The exact lost call: evicted at 20s, ended at 5m32s — by then the store had
  // fully forgotten it, and this Cdr event was silently dropped.
  store.onCdr({
    linkedId: "1785860821.162724",
    duration: "312",
    billableSeconds: "304",
    disposition: "ANSWERED",
    source: "8456623080",
    destination: "101",
    dcontext: "T25_ring-group-dial",
    channel: "Local/101@T25_ring-group-dial-0000aa60;2",
    destChannel: "PJSIP/0001-00010f3c",
    lastApplication: "Dial",
  });

  assert.equal(orphans.length, 1, "the PBX's own end-of-call report must never be dropped");
  const c = orphans[0]!;
  assert.equal(c.state, "hungup");
  assert.equal(c.linkedId, "1785860821.162724");
  assert.equal(c.from, "8456623080");
  assert.equal(c.to, "101");
  assert.equal(c.durationSec, 312);
  assert.equal(c.billableSec, 304);
  // startedAt derives from the linkedId's epoch prefix (PBX-timezone-proof).
  assert.equal(c.startedAt, new Date(1785860821 * 1000).toISOString());
  assert.ok(c.answeredAt, "ANSWERED with billsec > 0 back-computes answeredAt");
  assert.ok(c.endedAt);
  // Both channel strings ride along so the API's tenant resolver and the
  // local-only skip guard see the real legs.
  assert.deepEqual(c.channels, ["Local/101@T25_ring-group-dial-0000aa60;2", "PJSIP/0001-00010f3c"]);
  const legs = c.metadata["cdrLegs"] as Array<{ lastApplication: string }>;
  assert.equal(legs.length, 1);
  assert.equal(legs[0]!.lastApplication, "Dial", "lastApplication feeds the voicemail-downgrade check");
  assert.equal(c.metadata["cdrDisposition"], "ANSWERED");
});

test("orphan Cdr: NO ANSWER leg synthesizes without answeredAt", () => {
  const store = new CallStateStore();
  const orphans: NormalizedCall[] = [];
  store.on("orphanCdr", (c) => orphans.push(c));

  store.onCdr({
    linkedId: "1785860900.999999",
    duration: "25",
    billableSeconds: "0",
    disposition: "NO ANSWER",
    source: "8456623080",
    destination: "8457761765",
    dcontext: "trk-37-in",
    channel: "PJSIP/344022_Comfortcont-00010f99",
  });

  assert.equal(orphans.length, 1);
  assert.equal(orphans[0]!.answeredAt, null);
  assert.equal(orphans[0]!.durationSec, 25);
});

test("orphan Cdr does NOT fire when the store still tracks the call", () => {
  const { store } = storeWithBridgedCall();
  const orphans: NormalizedCall[] = [];
  store.on("orphanCdr", (c) => orphans.push(c));

  store.onCdr({
    linkedId: "1785860821.162724",
    duration: "312",
    billableSeconds: "304",
    disposition: "ANSWERED",
    source: "8456623080",
    destination: "101",
    dcontext: "T25_ring-group-dial",
  });

  assert.equal(orphans.length, 0, "tracked calls use the normal enrichment path");
});
