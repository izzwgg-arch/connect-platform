/**
 * M3/M4/M10 LLM extraction — validation + name→id resolution against the
 * live tenant catalog. Pinned behaviors:
 *  - every name the model returns is re-resolved against the catalog;
 *    unknown names → clarify (never a guessed write), garbage/low-confidence → null;
 *  - single-DID / single-IVR / single-queue tenants default sensibly;
 *  - queue hold music resolves through the tenant's Connect MOH profiles.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePbxCfgExtraction, resolveTarget, type PbxCatalog } from "./pbxCfgLlmExtract";

const CATALOG: PbxCatalog = {
  tenantId: "21",
  extensions: [
    { id: 7, extension: "101", name: "Home" },
    { id: 8, extension: "102", name: "Front Desk" },
  ],
  queues: [
    {
      id: 3,
      extension: "1121",
      description: "Sales",
      members: [{ extension: "101", name: "Home" }],
    },
  ],
  ringGroups: [{ id: 4, extension: "600", description: "All Phones" }],
  ivrs: [
    {
      id: 5,
      description: "Main Menu",
      welcomeRecordingId: 2,
      welcomeRecordingName: "Welcome",
      entries: [{ option: "1", target: { type: "extension", targetId: "7", label: "101 Home" } }],
    },
  ],
  recordings: [
    { id: 2, name: "Welcome" },
    { id: 9, name: "Holiday Greeting" },
  ],
  timeConditions: [{ id: 6, description: "Business Hours" }],
  customApplications: [],
  routes: [{ did: "8455577768", description: "Main", destinationId: 11, target: { type: "extension", targetId: "7", label: "101 Home" } }],
};

const MOH = [
  { name: "Main", mohClass: "connect_landau_main" },
  { name: "Classic", mohClass: "moh2" },
];

const INPUT = { text: "x", catalog: CATALOG, mohProfiles: MOH };
const v = (j: Record<string, unknown>) => validatePbxCfgExtraction(JSON.stringify({ confidence: 0.9, is_pbx_config: true, ...j }), INPUT);

// ── resolveTarget ─────────────────────────────────────────────────────────────

test("resolveTarget: extension by number, queue by name, type hint respected", () => {
  assert.deepEqual(resolveTarget(CATALOG, null, "102"), { type: "extension", id: "8", label: "extension 102 (Front Desk)" });
  assert.equal(resolveTarget(CATALOG, null, "sales")?.type, "queue");
  assert.equal(resolveTarget(CATALOG, null, "sales")?.id, "3");
  // hint "queue" with the queue's dialable number
  assert.equal(resolveTarget(CATALOG, "queue", "1121")?.id, "3");
  // IVR by (partial) name, ring group by name
  assert.equal(resolveTarget(CATALOG, null, "main menu")?.type, "ivr");
  assert.equal(resolveTarget(CATALOG, null, "all phones")?.type, "ring_group");
  assert.equal(resolveTarget(CATALOG, null, "nonexistent thing"), null);
});

// ── route (M3) ───────────────────────────────────────────────────────────────

test("route set: resolves target and defaults to the single DID", () => {
  const out = v({ domain: "route", operation: "set", did: null, target: "Sales", target_type: null });
  assert.equal(out?.kind, "op");
  const op = (out as any).op;
  assert.deepEqual(op, { domain: "route", op: "set", did: "8455577768", target: { type: "queue", id: "3", label: 'queue 1121 ("Sales")' } });
});

test("route set: DID matched by suffix digits (+1 prefix from speech)", () => {
  const out = v({ domain: "route", operation: "set", did: "+1 (845) 557-7768", target: "102", target_type: "extension" });
  assert.equal((out as any).op.did, "8455577768");
  assert.equal((out as any).op.target.id, "8");
});

test("route set: unknown target → clarify, never a guessed write", () => {
  const out = v({ domain: "route", operation: "set", did: null, target: "Bogus Dept" });
  assert.equal(out?.kind, "clarify");
  assert.match((out as any).question, /couldn't find "Bogus Dept"/);
});

test("route restore + status pass through", () => {
  assert.deepEqual((v({ domain: "route", operation: "restore", did: "8455577768" }) as any).op, { domain: "route", op: "restore", did: "8455577768" });
  assert.equal((v({ domain: "route", operation: "status" }) as any).op.op, "status");
});

// ── ivr (M4) ─────────────────────────────────────────────────────────────────

test("ivr set_entry: single-IVR default, option + target resolved", () => {
  const out = v({ domain: "ivr", operation: "set_entry", ivr: null, option: "2", target: "sales", target_type: "queue" });
  const op = (out as any).op;
  assert.equal(op.op, "set_entry");
  assert.equal(op.ivrId, 5);
  assert.equal(op.option, "2");
  assert.equal(op.target.type, "queue");
});

test("ivr set_welcome: recording resolved case-insensitively / by substring", () => {
  const out = v({ domain: "ivr", operation: "set_welcome", ivr: "main menu", recording: "holiday" });
  const op = (out as any).op;
  assert.equal(op.op, "set_welcome");
  assert.equal(op.recordingId, 9);
  assert.equal(op.recordingName, "Holiday Greeting");
});

test("ivr set_welcome: hallucinated recording → clarify listing the real ones", () => {
  const out = v({ domain: "ivr", operation: "set_welcome", ivr: null, recording: "Made Up Jingle" });
  assert.equal(out?.kind, "clarify");
  assert.match((out as any).question, /"Welcome", "Holiday Greeting"/);
});

test("ivr clear_entry + missing option → clarify", () => {
  assert.equal((v({ domain: "ivr", operation: "clear_entry", ivr: null, option: "4" }) as any).op.op, "clear_entry");
  assert.equal(v({ domain: "ivr", operation: "set_entry", ivr: null, option: null, target: "102" })?.kind, "clarify");
});

// ── queue (M10) ──────────────────────────────────────────────────────────────

test("queue add_member: single-queue default, extension ownership enforced", () => {
  const out = v({ domain: "queue", operation: "add_member", queue: null, extension: "102" });
  assert.deepEqual((out as any).op, { domain: "queue", op: "add_member", queueId: 3, queueExtension: "1121", queueName: "Sales", extension: "102" });
  // an extension the tenant doesn't own → clarify
  const bad = v({ domain: "queue", operation: "add_member", queue: "Sales", extension: "999" });
  assert.equal(bad?.kind, "clarify");
  assert.match((bad as any).question, /999 isn't one of your extensions/);
});

test("queue set_moh: resolves through the tenant's Connect hold-music profiles", () => {
  const out = v({ domain: "queue", operation: "set_moh", queue: "sales", moh: "main" });
  const op = (out as any).op;
  assert.equal(op.mohClass, "connect_landau_main");
  assert.equal(op.mohLabel, "Main");
  const bad = v({ domain: "queue", operation: "set_moh", queue: "sales", moh: "Techno" });
  assert.equal(bad?.kind, "clarify");
});

test("queue set_announcement: slot defaults to periodic, recording resolved", () => {
  const out = v({ domain: "queue", operation: "set_announcement", queue: null, recording: "welcome", slot: null });
  const op = (out as any).op;
  assert.equal(op.slot, "periodic");
  assert.equal(op.recordingId, 2);
});

test("queue: unknown queue name → clarify listing the real queues", () => {
  const out = v({ domain: "queue", operation: "remove_member", queue: "Support", extension: "101" });
  assert.equal(out?.kind, "clarify");
  assert.match((out as any).question, /1121 "Sales"/);
});

// ── guardrails ───────────────────────────────────────────────────────────────

test("guardrails: not_pbx_config, low confidence, garbage", () => {
  assert.equal(v({ is_pbx_config: false })?.kind, "not_pbx_config");
  assert.equal(validatePbxCfgExtraction(JSON.stringify({ is_pbx_config: true, domain: "route", operation: "set", confidence: 0.3 }), INPUT), null);
  assert.equal(validatePbxCfgExtraction("I think you want to change the queue!", INPUT), null);
  assert.equal(v({ domain: "nonsense", operation: "set" }), null);
});
