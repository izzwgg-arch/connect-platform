/**
 * M3/M4/M10 chat flow (owner directive 2026-07-28). Pinned behaviors:
 *  - the orchestrator grounds the LLM in the LIVE catalog (list_catalog door)
 *    and builds fully formed M3/M4/M10 params — no free-text reaches the ops;
 *  - status questions answer read-only from the catalog (zero actions);
 *  - regular users are fenced BEFORE any write; unknown names → clarify;
 *  - LLM down/low-confidence → honest "won't guess" reply, zero actions;
 *  - chat audio uploads that say "greeting/announcement" go to the native
 *    recording pipeline (M4 door), not hold music, and can chain a set_welcome.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { TriageOrchestrator } from "./orchestrator";
import { detectIntent } from "./intent";

const CATALOG = {
  tenantId: "21",
  extensions: [
    { id: 7, extension: "101", name: "Home" },
    { id: 8, extension: "102", name: "Front Desk" },
  ],
  queues: [{ id: 3, extension: "1121", description: "Sales", members: [{ extension: "101", name: "Home" }] }],
  ringGroups: [],
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
  timeConditions: [],
  customApplications: [],
  routes: [{ did: "8455577768", description: "Main", destinationId: 11, target: { type: "extension", targetId: "7", label: "101 Home" } }],
};

function makePrisma(opts: { role?: string } = {}): any {
  return {
    tenantPbxLink: { findUnique: async () => ({ pbxTenantId: "21" }) },
    extension: { findFirst: async () => ({ extNumber: "101" }) },
    user: { findUnique: async () => ({ role: opts.role ?? "TENANT_ADMIN" }) },
    mohProfile: {
      findMany: async () => [
        { id: "p1", name: "Main", vitalPbxMohClassName: "connect_landau_main" },
        { id: "p2", name: "Classic", vitalPbxMohClassName: "moh2" },
      ],
    },
    mohScheduleConfig: { findUnique: async () => ({ timezone: "America/New_York" }) },
    mohOverrideState: { findUnique: async () => null },
    mohExtensionOverride: { findFirst: async () => null },
    agentMessage: { findMany: async () => [] },
  };
}

function fakeLlm(json: Record<string, unknown>): any {
  return {
    available: () => [1],
    complete: async () => ({ text: JSON.stringify({ is_pbx_config: true, confidence: 0.9, ...json }) }),
  };
}

function makeOrch(opts: {
  created: any[];
  llm?: any;
  prisma?: any;
  status?: string;
  ivrCalls?: any[];
  catalogFails?: boolean;
}) {
  const actions: any = {
    create: async (input: any) => {
      opts.created.push(input);
      return { id: "act1", status: opts.status ?? "EXECUTED" };
    },
  };
  const routeApi = {
    call: async (body: any) => {
      if (opts.catalogFails) throw new Error("door down");
      assert.equal(body.action, "list_catalog");
      assert.equal(body.tenantId, "21"); // vital tenant id, never the Connect cuid
      return { ok: true, catalog: CATALOG };
    },
  };
  const ivrApi = {
    call: async (body: any) => {
      (opts.ivrCalls ?? []).push(body);
      return { ok: true, recording: { id: 42, name: body.recordingName, durationSec: 7 } };
    },
  };
  const queueApi = { call: async () => ({ ok: true }) };
  return new TriageOrchestrator(
    opts.prisma ?? makePrisma(),
    {} as any,
    actions,
    async () => null,
    opts.llm ?? null,
    null,
    routeApi,
    ivrApi,
    queueApi,
  );
}

const CTX = { tenantId: "cmConnectCuid", clientUserId: "u1", role: "customer" as const, conversationId: "conv1" };
const act = (raw: string) => ({ kind: "action", actionType: "pbx_config", raw }) as any;

// ── intent detection ─────────────────────────────────────────────────────────

test("INTENT: routing/IVR/queue phrases classify as pbx_config (queue MOH beats plain moh)", () => {
  assert.equal((detectIntent("add extension 102 to the sales queue") as any).actionType, "pbx_config");
  assert.equal((detectIntent("route my number to the front desk") as any).actionType, "pbx_config");
  assert.equal((detectIntent("press 2 should go to sales") as any).actionType, "pbx_config");
  assert.equal((detectIntent("change the queue hold music to Jazz") as any).actionType, "pbx_config");
  // plain hold music (no queue/menu words) still routes to the MOH flow
  assert.equal((detectIntent("change the hold music to Main") as any).actionType, "moh");
});

// ── M3 route ─────────────────────────────────────────────────────────────────

test("M3: 'route my number to sales' → EXECUTED retarget_v2 with resolved target", async () => {
  const created: any[] = [];
  const orch = makeOrch({ created, llm: fakeLlm({ domain: "route", operation: "set", did: null, target: "Sales", target_type: "queue" }) });
  const out = await orch.handle(act("route my number to the sales queue"), CTX, "en");
  assert.equal(created.length, 1);
  assert.equal(created[0].capabilityId, "pbx.M3");
  assert.equal(created[0].params.action, "retarget_v2");
  assert.equal(created[0].params.objectId, "8455577768");
  assert.equal(created[0].params.targetType, "queue");
  assert.equal(created[0].params.targetId, "3");
  assert.match(out.reply ?? "", /Done — route 8455577768 to queue 1121/);
});

test("M3: route status question answers read-only from the catalog, zero actions", async () => {
  const created: any[] = [];
  const orch = makeOrch({ created, llm: fakeLlm({ domain: "route", operation: "status" }) });
  const out = await orch.handle(act("where does my number route right now?"), CTX, "en");
  assert.equal(created.length, 0);
  assert.match(out.reply ?? "", /8455577768.*→ extension 101 Home/);
});

// ── M4 ivr ───────────────────────────────────────────────────────────────────

test("M4: 'press 2 goes to the front desk' → native_set_entry with objectId ivr:5:2", async () => {
  const created: any[] = [];
  const orch = makeOrch({ created, llm: fakeLlm({ domain: "ivr", operation: "set_entry", ivr: null, option: "2", target: "front desk", target_type: "extension" }) });
  const out = await orch.handle(act("on the main menu, press 2 should go to the front desk"), CTX, "en");
  assert.equal(created[0].capabilityId, "pbx.M4");
  assert.equal(created[0].params.action, "native_set_entry");
  assert.equal(created[0].params.objectId, "ivr:5:2");
  assert.equal(created[0].params.targetId, "8");
  assert.match(out.reply ?? "", /Done — point option 2 on IVR "Main Menu" to extension 102/);
});

test("M4: 'use the Holiday Greeting on the menu' → native_set_welcome", async () => {
  const created: any[] = [];
  const orch = makeOrch({ created, llm: fakeLlm({ domain: "ivr", operation: "set_welcome", ivr: "Main Menu", recording: "Holiday Greeting" }) });
  await orch.handle(act("play the holiday greeting on the main menu"), CTX, "en");
  assert.equal(created[0].params.action, "native_set_welcome");
  assert.equal(created[0].params.objectId, "ivr:5:welcome");
  assert.equal(created[0].params.recordingId, "9");
});

// ── M10 queue ────────────────────────────────────────────────────────────────

test("M10: 'add 102 to the sales queue' → member_add keyed by the queue extension", async () => {
  const created: any[] = [];
  const orch = makeOrch({ created, llm: fakeLlm({ domain: "queue", operation: "add_member", queue: "Sales", extension: "102" }) });
  const out = await orch.handle(act("add extension 102 to the sales queue"), CTX, "en");
  assert.equal(created[0].capabilityId, "pbx.M10");
  assert.equal(created[0].params.action, "member_add");
  assert.equal(created[0].params.objectId, "1121");
  assert.equal(created[0].params.extension, "102");
  assert.match(out.reply ?? "", /Done — add extension 102 to queue "Sales"/);
});

test("M10: queue hold music resolves the Connect profile to its Asterisk class", async () => {
  const created: any[] = [];
  const orch = makeOrch({ created, llm: fakeLlm({ domain: "queue", operation: "set_moh", queue: null, moh: "Main" }) });
  await orch.handle(act("change the queue hold music to Main"), CTX, "en");
  assert.equal(created[0].params.action, "set_moh");
  assert.equal(created[0].params.mohClass, "connect_landau_main");
});

test("M10: queue status lists members read-only, zero actions", async () => {
  const created: any[] = [];
  const orch = makeOrch({ created, llm: fakeLlm({ domain: "queue", operation: "status" }) });
  const out = await orch.handle(act("who is in the sales queue?"), CTX, "en");
  assert.equal(created.length, 0);
  assert.match(out.reply ?? "", /queue 1121 "Sales" — members: 101/);
});

// ── fences + honesty ─────────────────────────────────────────────────────────

test("FENCE: regular user asking for a config change is refused politely, zero actions", async () => {
  const created: any[] = [];
  const orch = makeOrch({
    created,
    prisma: makePrisma({ role: "USER" }),
    llm: fakeLlm({ domain: "queue", operation: "add_member", queue: "Sales", extension: "102" }),
  });
  const out = await orch.handle(act("add extension 102 to the sales queue"), CTX, "en");
  assert.equal(created.length, 0);
  assert.match(out.reply ?? "", /needs a company admin/);
});

test("CLARIFY: unknown queue name from the model → question, never a guessed write", async () => {
  const created: any[] = [];
  const orch = makeOrch({ created, llm: fakeLlm({ domain: "queue", operation: "add_member", queue: "Support", extension: "102" }) });
  const out = await orch.handle(act("add 102 to the support queue"), CTX, "en");
  assert.equal(created.length, 0);
  assert.match(out.reply ?? "", /couldn't find a queue called "Support"/);
});

test("HONESTY: LLM unavailable → 'won't guess' reply grounded in the real inventory, zero actions", async () => {
  const created: any[] = [];
  const orch = makeOrch({ created, llm: null });
  const out = await orch.handle(act("route stuff somewhere"), CTX, "en");
  assert.equal(created.length, 0);
  assert.match(out.reply ?? "", /never guess/);
  assert.match(out.reply ?? "", /8455577768/); // shows their real number
});

test("HONESTY: catalog door down → honest failure, zero actions", async () => {
  const created: any[] = [];
  const orch = makeOrch({ created, catalogFails: true });
  const out = await orch.handle(act("add 102 to the queue"), CTX, "en");
  assert.equal(created.length, 0);
  assert.match(out.reply ?? "", /couldn't reach your phone system/);
});

test("NOT CONFIG: model says it isn't a pbx request → handled:false (falls to chat LLM)", async () => {
  const orch = makeOrch({ created: [], llm: fakeLlm({ is_pbx_config: false }) });
  const out = await orch.handle(act("what's on the menu at the deli"), CTX, "en");
  assert.equal(out.handled, false);
});

test("FAILED action is reported honestly, never 'Done'", async () => {
  const created: any[] = [];
  const orch = makeOrch({ created, status: "FAILED", llm: fakeLlm({ domain: "route", operation: "set", did: null, target: "102", target_type: "extension" }) });
  const out = await orch.handle(act("route my number to 102"), CTX, "en");
  assert.match(out.reply ?? "", /didn't go through/);
  assert.doesNotMatch(out.reply ?? "", /Done/);
});

// ── chat audio upload → native recording (not hold music) ────────────────────

test("UPLOAD: 'this is our new greeting' uploads a native recording and chains set_welcome", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pbxcfg-test-"));
  const file = path.join(dir, "greet.mp3");
  await fs.writeFile(file, Buffer.from("fake-audio"));
  try {
    const created: any[] = [];
    const ivrCalls: any[] = [];
    const orch = makeOrch({ created, ivrCalls, llm: fakeLlm({ domain: "ivr", operation: "set_welcome", ivr: "Main Menu", recording: "Holiday Greeting" }) });
    const out = await orch.handle(
      { kind: "audio_upload", raw: "use this as the greeting on the main menu", files: [{ path: file, filename: "greet.mp3", sizeBytes: 10 }] },
      CTX,
      "en",
    );
    assert.equal(ivrCalls.length, 1);
    assert.equal(ivrCalls[0].action, "native_upload_recording");
    assert.equal(ivrCalls[0].tenantId, "21");
    assert.ok(String(ivrCalls[0].audioBase64).length > 0);
    // chained into the gated M4 flow
    assert.equal(created.length, 1);
    assert.equal(created[0].params.action, "native_set_welcome");
    assert.match(out.reply ?? "", /added the recording/);
    assert.match(out.reply ?? "", /Done/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("UPLOAD: regular user cannot upload phone-system recordings", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pbxcfg-test2-"));
  const file = path.join(dir, "greet.mp3");
  await fs.writeFile(file, Buffer.from("fake-audio"));
  try {
    const ivrCalls: any[] = [];
    const orch = makeOrch({ created: [], ivrCalls, prisma: makePrisma({ role: "USER" }) });
    const out = await orch.handle(
      { kind: "audio_upload", raw: "new greeting for the ivr", files: [{ path: file, filename: "greet.mp3", sizeBytes: 10 }] },
      CTX,
      "en",
    );
    assert.equal(ivrCalls.length, 0);
    assert.match(out.reply ?? "", /needs a company admin/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
