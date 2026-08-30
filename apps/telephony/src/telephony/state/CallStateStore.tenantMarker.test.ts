/**
 * The telephony half of the CROSS-TENANT LEAK fix (2026-08-02).
 *
 * This service produced the wrong tenant labels: 116 calls in 7 days written
 * into other companies' history, 11 customers. Two causes, both here —
 * first-leg-wins attribution that could never be corrected, and a resolver that
 * could not read the `T<n>_` marker Asterisk stamps on the call.
 *
 * Run: node --import tsx --test src/telephony/state/CallStateStore.tenantMarker.test.ts
 */
import "../services/requeueTestEnv";
import assert from "node:assert/strict";
import test from "node:test";
import { extractPbxTenantCodeFromCallFields } from "./pbxTenantMarker";

test("reads the tenant marker from a dcontext", () => {
  assert.equal(extractPbxTenantCodeFromCallFields("T102_cos-all"), "T102");
});

test("reads it from a channel", () => {
  assert.equal(extractPbxTenantCodeFromCallFields(undefined, "PJSIP/T8_108-0000f9d2"), "T8");
});

test("reads it from a Local channel mid-string", () => {
  assert.equal(extractPbxTenantCodeFromCallFields(undefined, "Local/111@T8_queue-call-to-agents-00009ffb;1"), "T8");
});

test("THE LEAK: T102 and T21 are different companies", () => {
  assert.notEqual(
    extractPbxTenantCodeFromCallFields("T102_cos-all"),
    extractPbxTenantCodeFromCallFields("T21_cos-all"),
  );
});

test("T1 / T10 / T102 never collide — a prefix match would misfile whole tenants", () => {
  assert.equal(extractPbxTenantCodeFromCallFields("T1_cos-all"), "T1");
  assert.equal(extractPbxTenantCodeFromCallFields("T10_cos-all"), "T10");
  assert.equal(extractPbxTenantCodeFromCallFields("T102_cos-all"), "T102");
});

test("conflicting markers yield NOTHING rather than picking a side", () => {
  assert.equal(extractPbxTenantCodeFromCallFields("T21_cos-all", "PJSIP/T8_101-0000beef"), null);
});

test("agreeing markers across legs resolve normally", () => {
  assert.equal(extractPbxTenantCodeFromCallFields("T21_cos-all", "PJSIP/T21_101-0000beef"), "T21");
});

test("no marker returns null so weaker resolution still runs", () => {
  assert.equal(extractPbxTenantCodeFromCallFields("ext-local-a_plus_center"), null);
  assert.equal(extractPbxTenantCodeFromCallFields("PJSIP/344022_Comfortcont-0000f9cd"), null);
  assert.equal(extractPbxTenantCodeFromCallFields(undefined, null), null);
});

test("malformed input can never throw on the live-call path", () => {
  assert.equal(extractPbxTenantCodeFromCallFields("", "   ", "TX_nope", "T_no"), null);
  assert.equal(extractPbxTenantCodeFromCallFields(42 as any, {} as any), null);
});

// ── DialBegin tenant fill (2026-08-29, the SignalWire null-tenant ring push) ──
// The trunk leg of a SignalWire inbound call carries no DID in its exten (the
// request-URI user is "s"), so the call reaches DialBegin with tenantId null —
// and DialBegin is the event that adds the extension and triggers the ONE-SHOT
// mobile ring push. These tests replay the real call (linkedId
// 1788055211.42054) and pin that the tenant is now resolved from the dialed
// leg's own name BEFORE the callUpsert emit, so the push can never again go
// out tenant-less and be guessed into another company.
import { CallStateStore } from "./CallStateStore";

function makeStoreWithResolver() {
  const store = new CallStateStore();
  store.setTenantCodeToConnectIdResolver((code: string) =>
    code === "T102" ? "cms8yjvth8ctlo4137738yg0n" : null,
  );
  return store;
}

function seedSignalWireTrunkLeg(store: CallStateStore, linkedId: string) {
  // The real trunk leg: no DID, exten "s", no tenant marker anywhere.
  store.upsertFromNewchannel({
    linkedId,
    uniqueid: linkedId,
    channel: "PJSIP/loopcom-pbx-000054d8",
    channelState: "4",
    callerIDNum: "+15622096644",
    callerIDName: "",
    connectedLineNum: "",
    connectedLineName: "",
    context: "trk-132-in",
    exten: "s",
    tenantId: null,
    tenantSlug: null,
    tenantName: null,
    direction: "inbound",
  });
}

test("DialBegin resolves the tenant from the wake-dial Local destination before its emit", () => {
  const store = makeStoreWithResolver();
  const linkedId = "1788055211.42054";
  seedSignalWireTrunkLeg(store, linkedId);
  assert.equal(store.getById(linkedId)?.tenantId, null, "precondition: trunk leg alone resolves nothing");

  let tenantAtEmit: string | null | undefined = "never-emitted";
  store.on("callUpsert", (c: any) => { tenantAtEmit = c.tenantId; });
  store.onDialBegin({
    linkedId,
    callerIDNum: "+15622096644",
    destination: "Local/T102_101_1@connect-mobile-wake-dial/n",
    channel: "PJSIP/loopcom-pbx-000054d8",
    context: "sub-local-dialing",
    exten: "101",
  });
  // The one-shot push notifier reads tenantId off the EMITTED call — it must
  // already carry the resolved tenant on this very event, not a later one.
  assert.equal(tenantAtEmit, "cms8yjvth8ctlo4137738yg0n");
  assert.equal(store.getById(linkedId)?.tenantId, "cms8yjvth8ctlo4137738yg0n");
  assert.equal(store.getById(linkedId)?.metadata["pbxVitalTenantId"], "102");
});

test("DialBegin tenant fill NEVER overrides a tenant already resolved", () => {
  const store = makeStoreWithResolver();
  const linkedId = "test-already-resolved.1";
  store.upsertFromNewchannel({
    linkedId,
    uniqueid: linkedId,
    channel: "PJSIP/sometrunk-0000c0de",
    channelState: "4",
    callerIDNum: "+15550001111",
    callerIDName: "",
    connectedLineNum: "",
    connectedLineName: "",
    context: "from-pstn",
    exten: "8455551234",
    tenantId: "already-resolved-tenant",
    tenantSlug: null,
    tenantName: "Some Co",
    direction: "inbound",
  });
  store.onDialBegin({
    linkedId,
    callerIDNum: "+15550001111",
    destination: "Local/T102_101_1@connect-mobile-wake-dial/n",
    channel: "PJSIP/sometrunk-0000c0de",
    context: "sub-local-dialing",
    exten: "101",
  });
  assert.equal(store.getById(linkedId)?.tenantId, "already-resolved-tenant");
});

test("DialBegin with an unknown tenant code leaves tenantId null (weaker resolution still runs later)", () => {
  const store = makeStoreWithResolver();
  const linkedId = "test-unknown-code.1";
  seedSignalWireTrunkLeg(store, linkedId);
  store.onDialBegin({
    linkedId,
    callerIDNum: "+15622096644",
    destination: "Local/T999_101_1@connect-mobile-wake-dial/n",
    channel: "PJSIP/loopcom-pbx-000054d8",
    context: "sub-local-dialing",
    exten: "101",
  });
  assert.equal(store.getById(linkedId)?.tenantId, null);
});
