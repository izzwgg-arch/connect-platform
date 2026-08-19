/**
 * ⛔ THE HOLD-MUSIC CLARIFY TRAP — a self-sustaining state that swallowed eight
 * consecutive unrelated questions on a live trainer account.
 *
 * Once "Which hold music would you like?" is the last assistant message, the
 * resume logic treats anything scope-shaped as the answer — and the scope test
 * matches the bare words "extension" and "company". So a question that merely
 * CONTAINS one of them was eaten as a hold-music reply, and because the reply
 * to it is the SAME clarify question, the state re-armed itself every turn.
 *
 * Measured live 2026-08-18 (Ezra, conversations …bfyo1x → …45eh7s): questions
 * about call forwarding, no-answer routing, restoring a previous setup, and
 * routing to a non-existent extension were each answered with the hold-music
 * question — eight in a row, across a conversation boundary.
 *
 * The rule these tests pin: a message that OPENS like a fresh request and never
 * mentions hold music is a fresh request, however scope-shaped its wording.
 * Genuine answers ("Jazz", "the whole company", "just mine") and genuine
 * hold-music questions must keep resuming.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TriageOrchestrator } from "./orchestrator";
import { detectIntent } from "./intent";

const PROFILE_Q = "Which hold music would you like? Your available options are: Jazz, Classical Calm.";

function makePrisma(messages: any[], role = "TENANT_ADMIN"): any {
  return {
    tenantPbxLink: { findUnique: async () => ({ pbxTenantId: "21" }) },
    extension: { findFirst: async () => ({ extNumber: "101" }) },
    user: { findUnique: async () => ({ role }) },
    mohProfile: {
      findMany: async () => [
        { id: "prof-jazz", name: "Jazz" },
        { id: "prof-classical", name: "Classical Calm" },
      ],
    },
    mohScheduleConfig: { findUnique: async () => ({ timezone: "America/New_York" }) },
    mohOverrideState: { findUnique: async () => ({ isActive: false, profileId: null }) },
    mohExtensionOverride: { findFirst: async () => null },
    agentMessage: { findMany: async () => messages },
  };
}

function makeOrch(created: any[], prisma: any) {
  const actions: any = { create: async (i: any) => { created.push(i); return { id: "act1", status: "EXECUTED" }; } };
  return new TriageOrchestrator(prisma, {} as any, actions, async () => null, null);
}

const CTX = { tenantId: "cmConnectCuid", clientUserId: "u1", role: "customer" as const, conversationId: "conv1" };

/** The clarify question is pending; the user says something else entirely. */
async function askWhilePending(text: string, role = "TENANT_ADMIN") {
  const created: any[] = [];
  const prisma = makePrisma([{ role: "assistant", content: PROFILE_Q, contentEn: null }], role);
  const out = await makeOrch(created, prisma).handle(detectIntent(text), CTX, "en");
  return { out, created };
}

/**
 * The defect, stated exactly: the answer to an unrelated question came back as
 * the hold-music clarify question, and/or a hold-music action was created from
 * it. Asserting on THAT rather than on `handled` is deliberate — a question the
 * orchestrator legitimately answers by another route (a queue status read, say)
 * is handled:true and is not the bug.
 */
function assertNotSwallowedByMoh(out: any, created: any[], q: string) {
  assert.ok(
    !/Which hold music would you like\?/.test(String(out.reply ?? "")),
    `swallowed by the hold-music clarify loop: ${q}`,
  );
  assert.equal(created.length, 0, `must not create a hold-music action from: ${q}`);
}

// ── the eight questions the trap ate, verbatim from 2026-08-18 ──────────────

for (const q of [
  "Can you tell me where calls to my extension go when I don't answer?",
  "Can you temporarily forward my extension somewhere else?",
  "Can you remove the forwarding and restore my original setup?",
  "What happens if you try to route a call to an extension that doesn't exist?",
  "Can you add my extension to the Service team?",
  "Can you remove my extension from a team without deleting the extension?",
  "What teams or ring groups are currently configured?",
  "Is my extension registered right now?",
]) {
  test(`TRAP: a new question is not a hold-music answer — "${q.slice(0, 52)}…"`, async () => {
    const { out, created } = await askWhilePending(q);
    assertNotSwallowedByMoh(out, created, q);
  });
}

// ── genuine answers must still resume ───────────────────────────────────────

test("a bare profile name still resumes the clarification", async () => {
  // Regular user ⇒ always extension-scoped, so the pick executes immediately.
  const { out, created } = await askWhilePending("Jazz", "USER");
  assert.equal(out.handled, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].params.profileId, "prof-jazz");
});

test("a bare scope answer still resumes the clarification", async () => {
  const { out } = await askWhilePending("the whole company");
  assert.equal(out.handled, true, "'the whole company' is an answer, not a new question");
});

test("'just mine' still resumes the clarification", async () => {
  const { out } = await askWhilePending("just mine");
  assert.equal(out.handled, true);
});

test("a question that DOES name hold music still resumes", async () => {
  // Ezra's Q117 — a real hold-music request phrased as a question.
  const { out } = await askWhilePending("Can you change the company's hold music without changing mine?");
  assert.equal(out.handled, true, "it names the thing, so it belongs to this flow");
});

test("'back to the regular schedule' still resumes (deactivate)", async () => {
  const { out, created } = await askWhilePending("back to the regular schedule");
  assert.equal(out.handled, true);
  assert.equal(created.length, 1);
});

// ── the belt to the braces: no clarify state may live forever ───────────────

test("after three consecutive unanswered asks, the orchestrator stops asking", async () => {
  const created: any[] = [];
  // Three clarify questions in a row with a scope-shaped reply between each —
  // the exact shape that used to sustain itself indefinitely.
  const prisma = makePrisma([
    { role: "assistant", content: PROFILE_Q, contentEn: null },
    { role: "user", content: "my extension", contentEn: null },
    { role: "assistant", content: PROFILE_Q, contentEn: null },
    { role: "user", content: "my extension", contentEn: null },
    { role: "assistant", content: PROFILE_Q, contentEn: null },
  ]);
  const out = await makeOrch(created, prisma).handle(detectIntent("my extension"), CTX, "en");
  assert.equal(out.handled, false, "give up and let the ordinary path answer");
  assert.equal(created.length, 0);
});
