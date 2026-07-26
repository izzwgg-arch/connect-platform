/**
 * TriageOrchestrator — M11 (DND) wiring contract.
 *
 * Regression for the 2026-07-26 live failure: the AgentAction row for a
 * pbx.M* capability MUST be created with tenantId = the VITAL tenant number
 * (params.tenantId), because the modify executor's G8 gate recomputes the
 * params-hash from params.tenantId and requires action.tenantId to match.
 * Creating the row with the Connect cuid fails G8 ("Params-hash mismatch").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TriageOrchestrator } from "./orchestrator";
import { detectIntent } from "./intent";

const prismaStub: any = {
  tenantPbxLink: { findUnique: async () => ({ pbxTenantId: "21" }) },
  extension: { findFirst: async () => ({ extNumber: "101" }) },
};

function makeOrch(created: any[]) {
  const actions: any = {
    create: async (input: any) => {
      created.push(input);
      return { id: "act1", status: "EXECUTED" };
    },
  };
  return new TriageOrchestrator(prismaStub, {} as any, actions, async () => null);
}

test("DND action row is keyed by the VITAL tenant id (G8 binding contract)", async () => {
  const created: any[] = [];
  const orch = makeOrch(created);
  const intent = detectIntent("put ext 101 on do not disturb");
  const out = await orch.handle(intent, { tenantId: "cmConnectCuid", clientUserId: "u1", role: "customer" }, "en");
  assert.equal(out.handled, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].capabilityId, "pbx.M11");
  assert.equal(created[0].tenantId, "21"); // vital tenant number, NOT the Connect cuid
  assert.deepEqual(created[0].params, { tenantId: "21", objectId: "101", feature: "DND", enable: "yes" });
  assert.match(out.reply ?? "", /^Done/);
});

test("DND disable direction flows through to enable:'no'", async () => {
  const created: any[] = [];
  const orch = makeOrch(created);
  const intent = detectIntent("take ext 101 out of do not disturb");
  await orch.handle(intent, { tenantId: "cmConnectCuid", clientUserId: "u1", role: "customer" }, "en");
  assert.equal(created[0].params.enable, "no");
});

test("FAILED execution is reported as a failure, not 'submitted for approval'", async () => {
  const created: any[] = [];
  const actions: any = { create: async (input: any) => { created.push(input); return { id: "act1", status: "FAILED" }; } };
  const orch = new TriageOrchestrator(prismaStub, {} as any, actions, async () => null);
  const out = await orch.handle(detectIntent("put ext 101 on dnd"), { tenantId: "c", clientUserId: "u1", role: "customer" }, "en");
  assert.match(out.reply ?? "", /didn't go through/);
  assert.doesNotMatch(out.reply ?? "", /approval/);
});
