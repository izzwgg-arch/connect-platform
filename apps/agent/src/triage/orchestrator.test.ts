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
  mohProfile: {
    findMany: async () => [
      { id: "prof-jazz", name: "Jazz" },
      { id: "prof-classical", name: "Classical Calm" },
    ],
  },
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

// ── M1 (tenant hold music) chat wiring ──────────────────────────────────────

test("MOH activate: profile resolved by name, action keyed by the VITAL tenant id", async () => {
  const created: any[] = [];
  const orch = makeOrch(created);
  const intent = detectIntent("please change our hold music to Jazz");
  const out = await orch.handle(intent, { tenantId: "cmConnectCuid", clientUserId: "u1", role: "customer" }, "en");
  assert.equal(out.handled, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].capabilityId, "pbx.M1");
  assert.equal(created[0].tenantId, "21");
  assert.deepEqual(created[0].params, { tenantId: "21", objectId: "21", action: "activate", profileId: "prof-jazz", reason: "chat request" });
  assert.match(out.reply ?? "", /^Done/);
});

test("MOH deactivate: 'back to normal' maps to action:'deactivate'", async () => {
  const created: any[] = [];
  const orch = makeOrch(created);
  const intent = detectIntent("set our hold music back to normal please");
  await orch.handle(intent, { tenantId: "cmConnectCuid", clientUserId: "u1", role: "customer" }, "en");
  assert.equal(created[0].params.action, "deactivate");
  assert.equal(created[0].tenantId, "21");
});

test("MOH with no matching profile name asks instead of guessing", async () => {
  const created: any[] = [];
  const orch = makeOrch(created);
  const intent = detectIntent("change the hold music to something upbeat");
  const out = await orch.handle(intent, { tenantId: "cmConnectCuid", clientUserId: "u1", role: "customer" }, "en");
  assert.equal(out.handled, true);
  assert.equal(created.length, 0); // nothing drafted
  assert.match(out.reply ?? "", /Jazz, Classical Calm/);
});

// ── clarification resume (2026-07-26 live failure: bare "Main" reply fell to
// the LLM, which hallucinated "I'll pass the request to the team") ──────────

const CLARIFY = "Which hold music would you like? Your available options are: Jazz, Classical Calm.";

function prismaWithLastAssistant(lastContent: string): any {
  return {
    ...prismaStub,
    agentMessage: { findFirst: async () => ({ content: lastContent, contentEn: null }) },
  };
}

test("RESUME: bare profile name after the clarify question executes the switch", async () => {
  const created: any[] = [];
  const actions: any = { create: async (input: any) => { created.push(input); return { id: "a", status: "EXECUTED" }; } };
  const orch = new TriageOrchestrator(prismaWithLastAssistant(CLARIFY), {} as any, actions, async () => null);
  const out = await orch.handle(
    detectIntent("jazz"),
    { tenantId: "cmConnectCuid", clientUserId: "u1", role: "customer", conversationId: "conv1" },
    "en",
  );
  assert.equal(out.handled, true);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].params, { tenantId: "21", objectId: "21", action: "activate", profileId: "prof-jazz", reason: "chat request" });
  assert.match(out.reply ?? "", /^Done/);
});

test("RESUME: 'back to the regular schedule' after the clarify question deactivates", async () => {
  const created: any[] = [];
  const actions: any = { create: async (input: any) => { created.push(input); return { id: "a", status: "EXECUTED" }; } };
  const orch = new TriageOrchestrator(prismaWithLastAssistant(CLARIFY), {} as any, actions, async () => null);
  await orch.handle(detectIntent("back to the regular schedule"), { tenantId: "c", clientUserId: "u1", role: "customer", conversationId: "conv1" }, "en");
  assert.equal(created[0].params.action, "deactivate");
});

test("RESUME: unrelated chat after the clarify question is NOT hijacked", async () => {
  const created: any[] = [];
  const actions: any = { create: async (input: any) => { created.push(input); return { id: "a", status: "EXECUTED" }; } };
  const orch = new TriageOrchestrator(prismaWithLastAssistant(CLARIFY), {} as any, actions, async () => null);
  const out = await orch.handle(detectIntent("thank you so much"), { tenantId: "c", clientUserId: "u1", role: "customer", conversationId: "conv1" }, "en");
  assert.equal(out.handled, false);
  assert.equal(created.length, 0);
});

test("RESUME: profile-name reply with a different last assistant message stays chat", async () => {
  const created: any[] = [];
  const actions: any = { create: async (input: any) => { created.push(input); return { id: "a", status: "EXECUTED" }; } };
  const orch = new TriageOrchestrator(prismaWithLastAssistant("Done — enabled DND on ext 101."), {} as any, actions, async () => null);
  const out = await orch.handle(detectIntent("jazz"), { tenantId: "c", clientUserId: "u1", role: "customer", conversationId: "conv1" }, "en");
  assert.equal(out.handled, false);
  assert.equal(created.length, 0);
});

test("MOH longest-name match wins when names overlap", async () => {
  const created: any[] = [];
  const prisma: any = {
    ...prismaStub,
    mohProfile: { findMany: async () => [{ id: "p1", name: "Jazz" }, { id: "p2", name: "Jazz Deluxe" }] },
  };
  const actions: any = { create: async (input: any) => { created.push(input); return { id: "a", status: "EXECUTED" }; } };
  const orch = new TriageOrchestrator(prisma, {} as any, actions, async () => null);
  await orch.handle(detectIntent("switch hold music to Jazz Deluxe"), { tenantId: "c", clientUserId: "u1", role: "customer" }, "en");
  assert.equal(created[0].params.profileId, "p2");
});
