/**
 * Instant hangup sync (2026-08-31).
 *
 * The complaint: "somebody hangs up and Active Calls / Team Directory keep
 * showing On Call for up to a minute." Two store-side causes:
 *
 *  1. reconcileLiveChannels iterated getActive() ONLY — a ringing/dialing
 *     call, or a call that dropped below two valid legs after a missed Hangup,
 *     was never reconciled against ARI and never got a callRemove on the
 *     delta stream; connected clients kept it until the 60s ghost sweep.
 *     Now the sweep covers EVERY tracked active-state call ("the ARI is
 *     down, the call is done"), with the 2-strike + grace guards unchanged.
 *
 *  2. When one leg's Hangup was missed and the sibling leg's Hangup arrived,
 *     the call kept the stale leg and stayed "up". The store now caches the
 *     latest RAW ARI channel set; a remaining leg that is absent from a
 *     fresh, non-empty snapshot it provably PREDATES (uniqueid epoch guard)
 *     is refuted, and the call ends the moment the real Hangup arrives.
 *
 * Run: node --import tsx --test src/telephony/state/CallStateStore.instantHangup.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

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
const { CallStateStore, uniqueidEpochMs } = require("./CallStateStore") as typeof import("./CallStateStore");
import type { NormalizedCall } from "../types";

const OLD_MS = Date.now() - 60_000;

// Epoch-bearing uniqueids OLD enough for the epoch-refutation safety margin.
const OLD_EPOCH_SEC = Math.floor(OLD_MS / 1000);
const LEG_A_UID = `${OLD_EPOCH_SEC}.100`;
const LEG_B_UID = `${OLD_EPOCH_SEC}.101`;

function newChannel(store: InstanceType<typeof CallStateStore>, opts: {
  linkedId: string; uniqueid: string; channel: string; channelState?: string;
}) {
  return store.upsertFromNewchannel({
    linkedId: opts.linkedId,
    uniqueid: opts.uniqueid,
    channel: opts.channel,
    channelState: opts.channelState ?? "6",
    callerIDNum: "8455551234",
    callerIDName: "",
    connectedLineNum: "",
    connectedLineName: "",
    context: "T25_cos-all",
    exten: "101",
    tenantId: "tenant-x",
    tenantSlug: "tenant_x",
    tenantName: "Tenant X",
    direction: "inbound",
  });
}

/** Two real legs, bridged and answered, backdated past every grace window. */
function bridgedTwoLegCall() {
  const store = new CallStateStore();
  const call = newChannel(store, { linkedId: LEG_A_UID, uniqueid: LEG_A_UID, channel: "PJSIP/trunk-leg-a" });
  newChannel(store, { linkedId: LEG_A_UID, uniqueid: LEG_B_UID, channel: "PJSIP/T25_101-leg-b" });
  store.onBridgeEnter({ linkedId: LEG_A_UID, uniqueid: LEG_A_UID, bridgeId: "br-1", bridgeNumChannels: "2" });
  call.metadata["lastBridgeEnterAtMs"] = OLD_MS;
  call.startedAt = new Date(OLD_MS).toISOString();
  return { store, call };
}

// ── 1. Widened ARI reconcile ────────────────────────────────────────────────

test("WIDENED RECONCILE: a ringing call whose channels left ARI is evicted (was: waited for the 60s sweep)", () => {
  const store = new CallStateStore();
  const call = newChannel(store, {
    linkedId: LEG_A_UID, uniqueid: LEG_A_UID, channel: "PJSIP/trunk-leg-a", channelState: "4", // ringing
  });
  call.startedAt = new Date(OLD_MS).toISOString();
  assert.equal(call.state, "ringing");
  assert.equal(store.getActive().length, 0, "precondition: a ringing call is NOT in getActive()");

  const evicted: NormalizedCall[] = [];
  const removed: string[] = [];
  store.on("callEvicted", (c) => evicted.push(c));
  store.on("callRemove", (id) => removed.push(id));

  store.reconcileLiveChannels([]); // strike 1
  store.reconcileLiveChannels([]); // strike 2 → evict

  assert.equal(evicted.length, 1, "ARI says the channels are gone — the call is done");
  assert.equal(evicted[0]!.state, "hungup");
  assert.ok(removed.includes(call.id), "clients are told to drop the row");
});

test("WIDENED RECONCILE: a call that dropped to ONE valid leg is still reconciled", () => {
  const { store, call } = bridgedTwoLegCall();
  // Simulate the state after a missed Hangup already stripped one channel
  // string but the call still fails hasValidBridgedParticipants (<2 legs).
  call.channels = ["PJSIP/T25_101-leg-b"];
  assert.equal(store.getActive().length, 0, "precondition: below 2 valid legs = not in getActive()");

  const evicted: NormalizedCall[] = [];
  store.on("callEvicted", (c) => evicted.push(c));

  store.reconcileLiveChannels([]);
  store.reconcileLiveChannels([]);

  assert.equal(evicted.length, 1, "one-leg leftovers must not linger to the 60s sweep");
});

test("WIDENED RECONCILE: a live ringing call (channels present in ARI) is never touched", () => {
  const store = new CallStateStore();
  const call = newChannel(store, {
    linkedId: LEG_A_UID, uniqueid: LEG_A_UID, channel: "PJSIP/trunk-leg-a", channelState: "4",
  });
  call.startedAt = new Date(OLD_MS).toISOString();

  const evicted: NormalizedCall[] = [];
  store.on("callEvicted", (c) => evicted.push(c));
  for (let i = 0; i < 5; i++) store.reconcileLiveChannels([LEG_A_UID]);

  assert.equal(evicted.length, 0);
  assert.equal(call.state, "ringing");
});

test("WIDENED RECONCILE: young-call grace still protects a fresh non-active call", () => {
  const store = new CallStateStore();
  newChannel(store, {
    linkedId: LEG_A_UID, uniqueid: LEG_A_UID, channel: "PJSIP/trunk-leg-a", channelState: "4",
  }); // startedAt = now → inside RECONCILE_BRIDGE_GRACE_MS

  const evicted: NormalizedCall[] = [];
  store.on("callEvicted", (c) => evicted.push(c));
  store.reconcileLiveChannels([]);
  store.reconcileLiveChannels([]);
  store.reconcileLiveChannels([]);

  assert.equal(evicted.length, 0, "grace window applies to the widened sweep too");
});

// ── 2. Hangup-time ARI refutation of stale sibling legs ─────────────────────

test("ARI REFUTATION: sibling leg's missed Hangup — the real Hangup ends the call NOW", () => {
  const { store, call } = bridgedTwoLegCall();
  const removed: string[] = [];
  store.on("callRemove", (id) => removed.push(id));

  // A fresh ARI poll already shows leg A dead (its Hangup event was missed).
  store.reconcileLiveChannels([LEG_B_UID]);

  // Leg B's real Hangup arrives. Leg A's stale entry used to keep the call
  // "up" until the reconciler/60s sweep; the cached ARI set now refutes it.
  store.onHangup({ linkedId: LEG_A_UID, uniqueid: LEG_B_UID, channel: "PJSIP/T25_101-leg-b", cause: "16" });

  assert.equal(call.state, "hungup", "the call must end at the Hangup event, not at the next sweep");
  assert.ok(removed.includes(call.id), "clients are told immediately");
});

test("ARI REFUTATION SAFETY: an EMPTY ARI snapshot refutes nothing at hangup time", () => {
  const { store, call } = bridgedTwoLegCall();

  store.reconcileLiveChannels([]); // suspicious empty snapshot (ARI hiccup shape)
  store.onHangup({ linkedId: LEG_A_UID, uniqueid: LEG_B_UID, channel: "PJSIP/T25_101-leg-b", cause: "16" });

  assert.equal(call.state, "up", "an empty snapshot must never end calls at hangup time");

  // …but the strike-guarded reconciler still catches the leftover within ~2 polls.
  const evicted: NormalizedCall[] = [];
  store.on("callEvicted", (c) => evicted.push(c));
  store.reconcileLiveChannels([]);
  store.reconcileLiveChannels([]);
  assert.equal(evicted.length, 1, "the fallback net still clears it");
});

test("ARI REFUTATION SAFETY: a leg YOUNGER than the snapshot is never refuted", () => {
  const store = new CallStateStore();
  const freshUidA = `${Math.floor(Date.now() / 1000)}.200`; // created ~now
  const freshUidB = `${Math.floor(Date.now() / 1000)}.201`;
  const call = newChannel(store, { linkedId: freshUidA, uniqueid: freshUidA, channel: "PJSIP/trunk-young-a" });
  newChannel(store, { linkedId: freshUidA, uniqueid: freshUidB, channel: "PJSIP/T25_101-young-b" });
  store.onBridgeEnter({ linkedId: freshUidA, uniqueid: freshUidA, bridgeId: "br-y", bridgeNumChannels: "2" });

  // Snapshot taken "now" cannot prove anything about a channel created "now" —
  // the stale-snapshot lie the 2026-08-04 evictions came from.
  store.reconcileLiveChannels([freshUidB]);
  store.onHangup({ linkedId: freshUidA, uniqueid: freshUidB, channel: "PJSIP/T25_101-young-b", cause: "16" });

  assert.equal(call.state, "up", "a young leg absent from the snapshot is NOT proof of death");
});

test("ARI REFUTATION SAFETY: no cached snapshot at all refutes nothing", () => {
  const { store, call } = bridgedTwoLegCall();
  store.onHangup({ linkedId: LEG_A_UID, uniqueid: LEG_B_UID, channel: "PJSIP/T25_101-leg-b", cause: "16" });
  assert.equal(call.state, "up");
});

// ── 3. uniqueid epoch parsing ───────────────────────────────────────────────

test("uniqueidEpochMs: parses plain and systemname-prefixed uniqueids, refuses junk", () => {
  assert.equal(uniqueidEpochMs("1788096475.42709"), 1788096475000);
  assert.equal(uniqueidEpochMs("pbx-1788096475.42709"), 1788096475000);
  assert.equal(uniqueidEpochMs("not-a-uid"), null);
  assert.equal(uniqueidEpochMs(""), null);
  assert.equal(uniqueidEpochMs("123.456"), null, "implausible epoch is refused");
  assert.equal(uniqueidEpochMs("9999999999.1"), null, "far-future epoch is refused");
});
