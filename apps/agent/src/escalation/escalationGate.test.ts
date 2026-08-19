/**
 * ⛔ THE ESCALATION GATE — the half no test covered, and the half that broke.
 *
 * `escalations.test.ts` tests the SMS builder and the report format. It never
 * drove `considerTurn`, so when the suppression test was written as
 * `ctx.role === "owner"` — the agent's ADMIN MODE, which every customer's own
 * TENANT_ADMIN has been in since 2026-08-06 — the whole suite stayed green
 * while the platform quietly threw away every tenant admin's escalation.
 *
 * Measured on production 2026-08-19: 93 "I've passed this to the Connect team"
 * promises made in admin-mode conversations since 2026-08-06, and 0 escalation
 * rows created. Ezra's 2026-08-18 trainer session alone: 48 promises, 0 rows.
 *
 * These tests exist so that can never be silent again. They cover BOTH faults
 * that had to line up for it:
 *   1. the gate — who is suppressed;
 *   2. the phrasing — what counts as a promise. The model says "the CONNECT
 *      team", which the old allow-list of "human"/"support" did not match, so
 *      43 of those 48 would have been missed even with the gate fixed.
 * Plus SOURCE guards on the wiring, because both defects were in the CALLER and
 * a unit test of the builder passes straight through them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EscalationService, isEscalationReply } from "./escalations";
import { isPlatformStaff } from "../authRoles";

/** CRLF-normalised: Izzy's checkout is autocrlf, and a source guard matching a
 *  literal newline fails only on Windows otherwise. */
const READ = (p: string) => fs.readFileSync(path.join(__dirname, p), "utf8").replace(/\r\n/g, "\n");

// ── 1. WHO IS SUPPRESSED ────────────────────────────────────────────────────

test("isPlatformStaff: only SUPER_ADMIN is Connect staff", () => {
  assert.equal(isPlatformStaff("SUPER_ADMIN"), true);
  assert.equal(isPlatformStaff("super_admin"), true);
  // ⛔ The whole bug: a tenant's own administrator is NOT us.
  assert.equal(isPlatformStaff("TENANT_ADMIN"), false);
  assert.equal(isPlatformStaff("USER"), false);
  assert.equal(isPlatformStaff("ADMIN"), false);
});

test("isPlatformStaff FAILS TOWARD ESCALATING on an unknown or missing role", () => {
  assert.equal(isPlatformStaff(undefined), false);
  assert.equal(isPlatformStaff(null), false);
  assert.equal(isPlatformStaff(""), false);
  assert.equal(isPlatformStaff("something-new"), false);
});

/** Minimal prisma double — enough to drive considerTurnInner end to end. */
function fakePrisma(created: any[]) {
  return {
    agentMessage: {
      findMany: async () => [
        { role: "assistant", content: "I've passed this to the Connect team: change Monday's opening time to 9:00 AM.", contentEn: null },
        { role: "user", content: "Change Monday's opening time to 9:00 AM.", contentEn: null },
      ],
    },
    agentEscalation: {
      findFirst: async () => null,
      create: async ({ data }: any) => { created.push(data); return { id: "esc_1" }; },
    },
    agentConversation: { findUnique: async () => ({ clientUserId: "u1" }) },
    agentAction: { findMany: async () => [] },
    tenant: { findUnique: async () => ({ name: "Connect Communications" }) },
    user: { findUnique: async () => ({ firstName: "Ezra", lastName: null, displayName: null, email: "ezra@connectcomunications.com" }) },
  };
}
const noopAudit = { record: async () => undefined } as any;

async function runTurn(staff: boolean) {
  const created: any[] = [];
  const svc = new EscalationService(fakePrisma(created) as any, null, null, noopAudit);
  svc.considerTurn({ tenantId: "t1", clientUserId: "u1", role: "owner", conversationId: "c1", isPlatformStaff: staff });
  await new Promise((r) => setTimeout(r, 60)); // fire-and-forget
  return created;
}

test("a TENANT_ADMIN (role 'owner', NOT staff) DOES get an escalation — the 2026-08-06 regression", async () => {
  const created = await runTurn(false);
  assert.equal(created.length, 1, "a tenant admin's request must reach a person");
  assert.equal(created[0].tenantName, "Connect Communications");
  assert.match(String(created[0].userName), /Ezra/);
});

test("Connect staff (SUPER_ADMIN) is still suppressed — escalating to yourself is noise", async () => {
  assert.equal((await runTurn(true)).length, 0);
});

// ── 2. WHAT COUNTS AS A PROMISE ─────────────────────────────────────────────

test("the phrasings the model ACTUALLY used on 2026-08-18 all count", () => {
  for (const s of [
    "I've passed this to the Connect team: change Monday's opening time to 9:00 AM.",
    "I've passed this request to the Connect team: Route unanswered Sales calls to the Sales voicemail mailbox.",
    "I've passed this to the Connect team as a routing request.",
    "I've forwarded this IVR Studio request to the Connect team and recorded the details:",
    "I've passed the request to the Connect team to confirm them.",
    "Your phone system doesn't have any IVR menus yet — I've flagged this for our team.",
    "I've passed this to the Connect team to check your holiday settings.",
    // the older idioms must keep working
    "I've passed this to our team.",
    "I've passed along: the customer wants a second extension.",
    "Our support team will follow up.",
  ]) assert.equal(isEscalationReply(s), true, `should escalate: ${s}`);
});

test("⛔ AN OFFER IS NOT A PROMISE — these must never text the owner", () => {
  for (const s of [
    "Yes — I can pass that IVR change to the Connect team. Which key should callers press?",
    "I can't add contacts directly, but I can pass the request to the Connect team.",
    "Once I have those details, I'll pass the queue setup request to the Connect team.",
    "I can pass that request to the Connect team, but I need the specific voicemail mailbox.",
    "I'd need the Sales extension before passing the request to the Connect team.",
    "Those changes must be handled through the relevant account controls or passed to the Connect team.",
  ]) assert.equal(isEscalationReply(s), false, `should NOT escalate: ${s}`);
});

test("a promise followed by a request for detail is still a promise", () => {
  assert.equal(
    isEscalationReply(
      "I've passed this to the Connect team: send after-hours calls directly to voicemail. Your account has no after-hours schedule, so they'll need to configure the rule first.",
    ),
    true,
  );
});

test("ordinary replies are never escalations", () => {
  for (const s of [
    "Your extension 1101 is registered and online.",
    "You have one contact saved: Ezra Leyson.",
    "Your phone system doesn't have any IVR menus yet.",
    "",
  ]) assert.equal(isEscalationReply(s), false, `should NOT escalate: ${s}`);
});

// ── 3. THE WIRING (source guards — both defects were in the caller) ─────────

test("SOURCE: the chat route suppresses on isPlatformStaff, never on the agent's admin mode", () => {
  const src = READ("../conversation/routes.ts");
  assert.ok(
    /isPlatformStaff:\s*isPlatformStaff\(identity\.platformRole\)/.test(src),
    "considerTurn must be passed isPlatformStaff(identity.platformRole)",
  );
  assert.ok(!/isPlatformStaff:\s*role\s*===/.test(src), "suppression must not be derived from the mapped 'owner' role");
});

test("SOURCE: the escalation gate itself reads isPlatformStaff, not ctx.role", () => {
  const src = READ("./escalations.ts");
  assert.ok(/if\s*\(ctx\.isPlatformStaff\)\s*return;/.test(src), "gate must test ctx.isPlatformStaff");
  assert.ok(
    !/if\s*\(ctx\.role\s*===\s*"owner"\)\s*return;/.test(src),
    "⛔ the old gate suppressed every tenant admin — it must not come back",
  );
});

test("SOURCE: the JWT keeps the raw platform role", () => {
  const src = READ("../auth.ts");
  assert.ok(/platformRole\??:/.test(src), "AgentIdentity must carry platformRole");
  assert.ok(/platformRole:\s*payload\.role/.test(src), "platformRole must come from the JWT payload");
});
