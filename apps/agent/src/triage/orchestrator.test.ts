/**
 * TriageOrchestrator — M11 (DND) + scope/time-aware MOH wiring contracts.
 *
 * Pinned behaviors:
 *  - M-series AgentAction rows are keyed by the VITAL tenant number (G8 binding).
 *  - Regular users are ALWAYS extension-scoped for hold music (pbx.M2).
 *  - Tenant admins are asked "whole company or your extension?" when unclear.
 *  - Timers ("for 30 minutes"/"until 5pm") ride M1 expiresMinutes / M2 revertAt.
 *  - Calendar phrases become M1 schedule actions (one_time / weekly rules).
 *  - Clarify answers are resumed with FULL context across multiple questions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TriageOrchestrator } from "./orchestrator";
import { detectIntent } from "./intent";

function makePrisma(opts: { role?: string; ownExt?: string | null; override?: any; messages?: any[] } = {}): any {
  return {
    tenantPbxLink: { findUnique: async () => ({ pbxTenantId: "21" }) },
    extension: { findFirst: async () => (opts.ownExt === null ? null : { extNumber: opts.ownExt ?? "101" }) },
    user: { findUnique: async () => ({ role: opts.role ?? "USER" }) },
    mohProfile: {
      findMany: async () => [
        { id: "prof-jazz", name: "Jazz" },
        { id: "prof-classical", name: "Classical Calm" },
      ],
    },
    mohScheduleConfig: { findUnique: async () => ({ timezone: "America/New_York" }) },
    mohOverrideState: { findUnique: async () => opts.override ?? { isActive: false, profileId: null } },
    agentMessage: { findMany: async () => opts.messages ?? [] },
  };
}

function makeOrch(created: any[], prisma: any, status = "EXECUTED") {
  const actions: any = {
    create: async (input: any) => {
      created.push(input);
      return { id: "act1", status };
    },
  };
  return new TriageOrchestrator(prisma, {} as any, actions, async () => null);
}

const CTX = { tenantId: "cmConnectCuid", clientUserId: "u1", role: "customer" as const, conversationId: "conv1" };

// ── DND (M11) regression ─────────────────────────────────────────────────────

test("DND action row is keyed by the VITAL tenant id (G8 binding contract)", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma());
  const out = await orch.handle(detectIntent("put ext 101 on do not disturb"), CTX, "en");
  assert.equal(out.handled, true);
  assert.equal(created[0].capabilityId, "pbx.M11");
  assert.equal(created[0].tenantId, "21");
  assert.deepEqual(created[0].params, { tenantId: "21", objectId: "101", feature: "DND", enable: "yes" });
  assert.match(out.reply ?? "", /^Done/);
});

test("DND disable direction flows through to enable:'no'", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma());
  await orch.handle(detectIntent("take ext 101 out of do not disturb"), CTX, "en");
  assert.equal(created[0].params.enable, "no");
});

test("FAILED execution is reported as a failure, not 'submitted for approval'", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma(), "FAILED");
  const out = await orch.handle(detectIntent("put ext 101 on dnd"), CTX, "en");
  assert.match(out.reply ?? "", /didn't go through/);
  assert.doesNotMatch(out.reply ?? "", /approval/);
});

// ── MOH scope: regular users ─────────────────────────────────────────────────

test("REGULAR USER: hold-music change is scoped to their own extension (pbx.M2)", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "USER", ownExt: "104" }));
  const out = await orch.handle(detectIntent("please change our hold music to Jazz"), CTX, "en");
  assert.equal(out.handled, true);
  assert.equal(created[0].capabilityId, "pbx.M2");
  assert.equal(created[0].tenantId, "21");
  assert.deepEqual(created[0].params, { tenantId: "21", objectId: "104", action: "set", profileId: "prof-jazz", reason: "chat request" });
  assert.match(out.reply ?? "", /^Done/);
});

test("REGULAR USER: explicit whole-company request is refused with guidance", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "USER", ownExt: "104" }));
  const out = await orch.handle(detectIntent("change the hold music for the whole company to Jazz"), CTX, "en");
  assert.equal(out.handled, true);
  assert.equal(created.length, 0);
  assert.match(out.reply ?? "", /admin/);
  assert.match(out.reply ?? "", /104/);
});

test("REGULAR USER: another user's extension is refused", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "USER", ownExt: "104" }));
  const out = await orch.handle(detectIntent("change extension 102's hold music to Jazz"), CTX, "en");
  assert.equal(created.length, 0);
  assert.match(out.reply ?? "", /your own extension \(104\)/);
});

test("REGULAR USER: 'back to normal' clears their extension override (M2 clear)", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "USER", ownExt: "104" }));
  await orch.handle(detectIntent("set my hold music back to normal"), CTX, "en");
  assert.equal(created[0].capabilityId, "pbx.M2");
  assert.deepEqual(created[0].params, { tenantId: "21", objectId: "104", action: "clear", reason: "chat request" });
});

// ── MOH scope: tenant admins ─────────────────────────────────────────────────

test("ADMIN without explicit scope is ASKED whole-company vs extension", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "TENANT_ADMIN", ownExt: "101" }));
  const out = await orch.handle(detectIntent("change our hold music to Jazz"), CTX, "en");
  assert.equal(out.handled, true);
  assert.equal(created.length, 0);
  assert.match(out.reply ?? "", /^Should I change the hold music for the whole company, or just your extension \(101\)\?/);
});

test("ADMIN + explicit whole-company executes tenant-wide (pbx.M1)", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "TENANT_ADMIN" }));
  const out = await orch.handle(detectIntent("change the hold music for the whole company to Jazz"), CTX, "en");
  assert.equal(created[0].capabilityId, "pbx.M1");
  assert.deepEqual(created[0].params, { tenantId: "21", objectId: "21", action: "activate", profileId: "prof-jazz", reason: "chat request" });
  assert.match(out.reply ?? "", /^Done/);
});

test("ADMIN + 'my extension' scopes to their extension (pbx.M2)", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "TENANT_ADMIN", ownExt: "101" }));
  await orch.handle(detectIntent("change my extension's hold music to Jazz"), CTX, "en");
  assert.equal(created[0].capabilityId, "pbx.M2");
  assert.equal(created[0].params.objectId, "101");
});

test("ADMIN with no extension of their own defaults to tenant-wide without asking", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "TENANT_ADMIN", ownExt: null }));
  await orch.handle(detectIntent("change our hold music to Jazz"), CTX, "en");
  assert.equal(created[0].capabilityId, "pbx.M1");
});

// ── MOH timers ───────────────────────────────────────────────────────────────

test("TIMER: whole-company 'for 30 minutes' rides M1 expiresMinutes", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "TENANT_ADMIN" }));
  const out = await orch.handle(detectIntent("play Jazz hold music for the whole company for 30 minutes"), CTX, "en");
  assert.equal(created[0].capabilityId, "pbx.M1");
  assert.equal(created[0].params.expiresMinutes, 30);
  assert.equal(created[0].params.action, "activate");
  assert.match(out.reply ?? "", /30 minutes/);
});

test("TIMER: extension 'for 20 minutes' rides M2 + revertAfterMinutes", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "USER", ownExt: "104" }));
  await orch.handle(detectIntent("change my hold music to Jazz for 20 minutes"), CTX, "en");
  assert.equal(created[0].capabilityId, "pbx.M2");
  assert.equal(created[0].revertAfterMinutes, 20);
  assert.equal(created[0].params.profileId, "prof-jazz");
});

test("TIMED REVERT: 'change it back in 15 minutes' re-arms the active override with expiry", async () => {
  const created: any[] = [];
  const prisma = makePrisma({
    role: "TENANT_ADMIN",
    ownExt: null,
    override: { isActive: true, profileId: "prof-jazz" },
    messages: [{ role: "assistant", content: 'Done — switch the hold music to "Jazz".', contentEn: null }],
  });
  const orch = makeOrch(created, prisma);
  const out = await orch.handle(detectIntent("change it back in 15 minutes"), CTX, "en");
  assert.equal(out.handled, true);
  assert.equal(created[0].capabilityId, "pbx.M1");
  assert.equal(created[0].params.action, "activate");
  assert.equal(created[0].params.profileId, "prof-jazz");
  assert.equal(created[0].params.expiresMinutes, 15);
  assert.match(out.reply ?? "", /back to the regular schedule in 15 minutes/);
});

test("TIMED REVERT with nothing active says so instead of acting", async () => {
  const created: any[] = [];
  const prisma = makePrisma({
    role: "TENANT_ADMIN",
    ownExt: null,
    override: { isActive: false, profileId: null },
    messages: [{ role: "assistant", content: "Done — set the hold music back to the regular schedule.", contentEn: null }],
  });
  const orch = makeOrch(created, prisma);
  const out = await orch.handle(detectIntent("change it back in 15 minutes"), CTX, "en");
  assert.equal(created.length, 0);
  assert.match(out.reply ?? "", /already on the regular schedule/);
});

// ── MOH calendar schedules ───────────────────────────────────────────────────

test("SCHEDULE: 'tomorrow from 3pm to 5pm' becomes an M1 schedule action (one_time)", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "TENANT_ADMIN" }));
  const out = await orch.handle(detectIntent("for the whole company play Jazz hold music tomorrow from 3pm to 5pm"), CTX, "en");
  assert.equal(created[0].capabilityId, "pbx.M1");
  assert.equal(created[0].params.action, "schedule");
  assert.equal(created[0].params.profileId, "prof-jazz");
  assert.ok(String(created[0].params.startAt).endsWith("Z"));
  assert.ok(new Date(created[0].params.endAt as string) > new Date(created[0].params.startAt as string));
  assert.match(out.reply ?? "", /^Done — schedule "Jazz"/);
});

test("SCHEDULE: 'every friday from 3pm to 5pm' becomes an M1 weekly schedule", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "TENANT_ADMIN" }));
  await orch.handle(detectIntent("whole company hold music: play Jazz every friday from 3pm to 5pm"), CTX, "en");
  assert.equal(created[0].params.action, "schedule");
  assert.equal(created[0].params.weekday, 5);
  assert.equal(created[0].params.startTime, "15:00");
  assert.equal(created[0].params.endTime, "17:00");
});

test("SCHEDULE: active manual override adds the outranking heads-up to the reply", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "TENANT_ADMIN", override: { isActive: true, profileId: "prof-classical" } }));
  const out = await orch.handle(detectIntent("for the whole company play Jazz hold music tomorrow from 3pm to 5pm"), CTX, "en");
  assert.match(out.reply ?? "", /override is active right now/);
});

test("SCHEDULE: per-extension calendar window is politely declined", async () => {
  const created: any[] = [];
  const orch = makeOrch(created, makePrisma({ role: "USER", ownExt: "104" }));
  const out = await orch.handle(detectIntent("play Jazz hold music on my extension tomorrow from 3pm to 5pm"), CTX, "en");
  assert.equal(created.length, 0);
  assert.match(out.reply ?? "", /can't put a calendar schedule on a single extension/);
});

// ── clarification resume (multi-question, context preserved) ────────────────

const PROFILE_Q = "Which hold music would you like? Your available options are: Jazz, Classical Calm.";
const SCOPE_Q = "Should I change the hold music for the whole company, or just your extension (101)?";

test("RESUME: bare profile name after the profile question executes (regular user → M2)", async () => {
  const created: any[] = [];
  const prisma = makePrisma({ role: "USER", ownExt: "104", messages: [{ role: "assistant", content: PROFILE_Q, contentEn: null }] });
  const orch = makeOrch(created, prisma);
  const out = await orch.handle(detectIntent("jazz"), CTX, "en");
  assert.equal(out.handled, true);
  assert.deepEqual(created[0].params, { tenantId: "21", objectId: "104", action: "set", profileId: "prof-jazz", reason: "chat request" });
  assert.match(out.reply ?? "", /^Done/);
});

test("RESUME: scope answer 'whole company' merges with the original request (admin → M1)", async () => {
  const created: any[] = [];
  const prisma = makePrisma({
    role: "TENANT_ADMIN",
    messages: [
      { role: "assistant", content: SCOPE_Q, contentEn: null },
      { role: "user", content: "change our hold music to Jazz for 30 minutes", contentEn: null },
    ],
  });
  const orch = makeOrch(created, prisma);
  const out = await orch.handle(detectIntent("the whole company"), CTX, "en");
  assert.equal(out.handled, true);
  assert.equal(created[0].capabilityId, "pbx.M1");
  assert.equal(created[0].params.profileId, "prof-jazz");
  assert.equal(created[0].params.expiresMinutes, 30); // timing survived the clarify round-trip
});

test("RESUME: two-step clarify chain (scope, then profile) keeps everything", async () => {
  const created: any[] = [];
  const prisma = makePrisma({
    role: "TENANT_ADMIN",
    messages: [
      { role: "assistant", content: PROFILE_Q, contentEn: null },
      { role: "user", content: "whole company", contentEn: null },
      { role: "assistant", content: SCOPE_Q, contentEn: null },
      { role: "user", content: "change the hold music until 5pm", contentEn: null },
    ],
  });
  const orch = makeOrch(created, prisma);
  const out = await orch.handle(detectIntent("classical calm"), CTX, "en");
  assert.equal(out.handled, true);
  assert.equal(created[0].capabilityId, "pbx.M1");
  assert.equal(created[0].params.profileId, "prof-classical");
  assert.ok(Number(created[0].params.expiresMinutes) >= 1, "until-time became an expiry");
});

test("RESUME: 'back to the regular schedule' after the profile question deactivates", async () => {
  const created: any[] = [];
  const prisma = makePrisma({ role: "TENANT_ADMIN", ownExt: null, messages: [{ role: "assistant", content: PROFILE_Q, contentEn: null }] });
  const orch = makeOrch(created, prisma);
  await orch.handle(detectIntent("back to the regular schedule"), CTX, "en");
  assert.equal(created[0].params.action, "deactivate");
});

test("RESUME: unrelated chat after a clarify question is NOT hijacked", async () => {
  const created: any[] = [];
  const prisma = makePrisma({ role: "USER", messages: [{ role: "assistant", content: PROFILE_Q, contentEn: null }] });
  const orch = makeOrch(created, prisma);
  const out = await orch.handle(detectIntent("thank you so much"), CTX, "en");
  assert.equal(out.handled, false);
  assert.equal(created.length, 0);
});

test("RESUME: casual 'all good' after a clarify question is NOT a tenant-scope answer", async () => {
  const created: any[] = [];
  const prisma = makePrisma({ role: "TENANT_ADMIN", messages: [{ role: "assistant", content: SCOPE_Q, contentEn: null }] });
  const orch = makeOrch(created, prisma);
  const out = await orch.handle(detectIntent("all good, thanks!"), CTX, "en");
  assert.equal(out.handled, false);
  assert.equal(created.length, 0);
});

test("RESUME: profile-name reply after a NON-MOH assistant message stays chat", async () => {
  const created: any[] = [];
  const prisma = makePrisma({ role: "USER", messages: [{ role: "assistant", content: "Done — enabled Do Not Disturb on ext 101.", contentEn: null }] });
  const orch = makeOrch(created, prisma);
  const out = await orch.handle(detectIntent("jazz"), CTX, "en");
  assert.equal(out.handled, false);
  assert.equal(created.length, 0);
});

test("MOH longest-name match wins when names overlap", async () => {
  const created: any[] = [];
  const prisma = makePrisma({ role: "TENANT_ADMIN", ownExt: null });
  prisma.mohProfile = { findMany: async () => [{ id: "p1", name: "Jazz" }, { id: "p2", name: "Jazz Deluxe" }] };
  const orch = makeOrch(created, prisma);
  await orch.handle(detectIntent("switch hold music to Jazz Deluxe"), CTX, "en");
  assert.equal(created[0].params.profileId, "p2");
});
