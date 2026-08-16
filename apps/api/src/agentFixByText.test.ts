import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * Drives the real gate ORDER of "Fix it!" by text against a faked database.
 * What has to be proven here is not that a fix works — that is the confirmation
 * machinery's own suite — but that a text message cannot cause one it should
 * not: wrong sender, wrong code, expired, replayed, or an action that was never
 * prepared.
 */
const state: any = { escalations: [], actions: [], users: [], applied: [], sent: [] };

mock.module("@connect/db", {
  namedExports: {
    db: {
      agentEscalation: {
        findUnique: async ({ where }: any) => state.escalations.find((e: any) => e.fixCodeHash === where.fixCodeHash) ?? null,
        update: async ({ where, data }: any) => {
          const e = state.escalations.find((x: any) => x.id === where.id);
          for (const [k, v] of Object.entries<any>(data)) e[k] = v && typeof v === "object" && "increment" in v ? (e[k] ?? 0) + v.increment : v;
          return e;
        },
        updateMany: async ({ where, data }: any) => {
          const e = state.escalations.find((x: any) => x.id === where.id && (where.fixCodeUsedAt !== null || true));
          if (!e) return { count: 0 };
          if (where.fixCodeUsedAt === null && e.fixCodeUsedAt) return { count: 0 };
          Object.assign(e, data);
          return { count: 1 };
        },
      },
      agentAction: {
        findUnique: async ({ where }: any) => state.actions.find((a: any) => a.id === where.id) ?? null,
      },
      user: {
        findMany: async ({ where }: any) =>
          state.users.filter((u: any) => (where.email ? u.email === where.email : true) && u.role === "SUPER_ADMIN" && u.status !== "DISABLED"),
      },
      connectChatMessage: { findMany: async () => state.inbound ?? [] },
    },
  },
});

mock.module("./billing/billingSmsSender", {
  namedExports: {
    normalizeUsPhone: (v: any) => {
      const d = String(v ?? "").replace(/\D/g, "");
      if (d.length === 10) return `+1${d}`;
      if (d.length === 11 && d.startsWith("1")) return `+${d}`;
      return null;
    },
    resolvePlatformSmsSender: async () => ({
      ok: true,
      send: async (m: any) => { state.sent.push(m); },
    }),
  },
});

mock.module("./agentGrantRoutes", {
  namedExports: {
    confirmCapabilityRegistry: { ids: () => ["agent.provisioning.add_extension"] },
    applyAgentFixAction: async (input: any) => {
      if (state.applyThrows) throw new Error(String(state.applyThrows));
      state.applied.push(input);
      return state.applyResult ?? { ok: true };
    },
  },
});

let mod: typeof import("./agentFixByText");

const CODE = "481203";
const OWNER = "+15622096644";
const STRANGER = "+19995551234";

beforeEach(async () => {
  if (!mod) mod = await import("./agentFixByText");
  process.env.AGENT_ESCALATION_SMS_TO = `${OWNER},+18457231213`;
  process.env.AGENT_FIX_APPROVER_EMAIL = "owner@connect.test";
  state.escalations = [
    {
      id: "esc_1",
      tenantId: "t_acme",
      tenantName: "Acme Ltd",
      fixActionId: "act_1",
      fixCodeHash: mod.hashFixCode(CODE),
      fixCodeExpiresAt: new Date(Date.now() + 3600_000),
      fixCodeUsedAt: null,
      fixAttempts: 0,
      fixStatus: "offered",
    },
  ];
  state.actions = [{ id: "act_1", status: "DRAFT", capabilityId: "agent.provisioning.add_extension", summary: "Add extension 104 for Sarah Klein." }];
  state.users = [{ id: "u_owner", tenantId: "t_admin", role: "SUPER_ADMIN", email: "owner@connect.test", status: "ACTIVE" }];
  state.applied = [];
  state.sent = [];
  state.applyResult = { ok: true };
  state.applyThrows = null;
  state.inbound = [];
});

test("the owner's reply carries out the fix and says what happened", async () => {
  const out = await mod.applyFixByCode({ code: CODE, from: OWNER });
  assert.equal(out.kind, "applied");
  assert.equal(state.applied.length, 1);
  assert.equal(state.applied[0].actionId, "act_1");
  assert.equal(state.applied[0].verifiedFrom, OWNER);
  assert.match(out.message, /Done for Acme Ltd/);
  assert.match(out.message, /Add extension 104/);
  assert.equal(state.escalations[0].fixStatus, "applied");
});

test("⛔ a stranger's text with the right code does NOTHING and gets no reply", async () => {
  const out = await mod.applyFixByCode({ code: CODE, from: STRANGER });
  assert.equal(state.applied.length, 0, "must not execute");
  assert.equal(out.replyTo, null, "must not tell an unknown number anything");
  assert.equal(state.escalations[0].fixCodeUsedAt, null, "and must not burn the code");
});

test("⛔ the same code cannot be spent twice", async () => {
  const first = await mod.applyFixByCode({ code: CODE, from: OWNER });
  assert.equal(first.kind, "applied");
  const second = await mod.applyFixByCode({ code: CODE, from: OWNER });
  assert.equal(second.kind, "already_used");
  assert.equal(state.applied.length, 1, "the work must have run exactly once");
});

test("an unknown code changes nothing", async () => {
  const out = await mod.applyFixByCode({ code: "000000", from: OWNER });
  assert.equal(out.kind, "unknown_code");
  assert.equal(state.applied.length, 0);
});

test("an expired code changes nothing", async () => {
  state.escalations[0].fixCodeExpiresAt = new Date(Date.now() - 1000);
  const out = await mod.applyFixByCode({ code: CODE, from: OWNER });
  assert.equal(out.kind, "expired");
  assert.equal(state.applied.length, 0);
});

test("⛔ a refusal from a gate keeps the code spent — no retry loop over SMS", async () => {
  state.applyResult = { ok: false, error: "extension_taken", message: "Extension 104 is already in use." };
  const out = await mod.applyFixByCode({ code: CODE, from: OWNER });
  assert.equal(out.kind, "refused");
  assert.match(out.message, /already in use/);
  assert.match(out.message, /Nothing was changed/);
  assert.ok(state.escalations[0].fixCodeUsedAt, "the code stays spent");
});

test("a thrown failure is reported honestly and never retried silently", async () => {
  state.applyThrows = "PBX unreachable";
  const out = await mod.applyFixByCode({ code: CODE, from: OWNER });
  assert.equal(out.kind, "failed");
  assert.match(out.message, /PBX unreachable/);
  assert.match(out.message, /Needs a person/);
  assert.ok(state.escalations[0].fixCodeUsedAt, "⛔ the code stays spent — half-done work must never be re-run by text");
  assert.equal(state.escalations[0].fixStatus, "failed");
});

test("⛔ with several super-admins and no configured approver, it refuses rather than pick one", async () => {
  delete process.env.AGENT_FIX_APPROVER_EMAIL;
  state.users.push({ id: "u_two", tenantId: "t_admin", role: "SUPER_ADMIN", email: "other@connect.test", status: "ACTIVE" });
  const out = await mod.applyFixByCode({ code: CODE, from: OWNER });
  assert.equal(out.kind, "refused");
  assert.match(out.message, /AGENT_FIX_APPROVER_EMAIL/);
  assert.equal(state.applied.length, 0);
});

test("an escalation with no prepared action never gets a code", async () => {
  const code = await mod.offerFixCode({ id: "esc_2", fixActionId: null });
  assert.equal(code, null);
});

test("⛔ a code is not offered for an action that is no longer a DRAFT", async () => {
  state.actions[0].status = "APPROVED";
  const code = await mod.offerFixCode({ id: "esc_1", fixActionId: "act_1" });
  assert.equal(code, null, "an already-spent action must not be re-offered by text");
});

test("⛔ a code is not offered for a capability the registry does not know", async () => {
  state.actions[0].capabilityId = "action.something.exotic";
  const code = await mod.offerFixCode({ id: "esc_1", fixActionId: "act_1" });
  assert.equal(code, null);
});

test("a fresh code is six digits and is stored only as a hash", async () => {
  state.escalations[0].fixCodeHash = null;
  const code = await mod.offerFixCode({ id: "esc_1", fixActionId: "act_1" });
  assert.ok(code && /^\d{6}$/.test(code));
  assert.equal(state.escalations[0].fixCodeHash, mod.hashFixCode(code!));
  assert.notEqual(state.escalations[0].fixCodeHash, code, "the code itself must never be stored");
});

test("the sweep ignores ordinary conversation and acts only on an approval", async () => {
  state.inbound = [
    { id: "m1", body: "thanks!", thread: { externalSmsE164: OWNER } },
    { id: "m2", body: `FIX ${CODE}`, thread: { externalSmsE164: OWNER } },
    { id: "m3", body: "ok do it", thread: { externalSmsE164: OWNER } },
  ];
  const summary = await mod.sweepFixRepliesBatch();
  assert.equal(summary.read, 3);
  assert.equal(summary.approvals, 1);
  assert.equal(summary.applied, 1);
  assert.equal(summary.ignored, 2);
  assert.equal(state.sent.length, 1, "exactly one confirmation text goes back");
});
