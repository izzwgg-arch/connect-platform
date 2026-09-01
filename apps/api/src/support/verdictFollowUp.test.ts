/**
 * "No, still not right" must GO somewhere.
 *
 * ⛔ THE BUG THIS PINS CLOSED: the verdict route told the customer "We've
 * reopened it and someone will pick it up" while `recordVerdict` only stamped
 * the row — no reopen, no re-queue, no notification (found 2026-09-01, two
 * customers got that message the day before). That is the unearned-promise
 * class the safety gate exists to refuse, in our own route. Now a not_fixed
 * verdict files a follow-up escalation — texted to the owner by the dispatcher,
 * re-investigated by the watcher — and the wording only promises what happened.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  recordVerdict,
  decideVerdictFollowUp,
  FOLLOWUP_PREFIX,
  NEEDS_PERSON_MARKER,
} from "./customerUpdate";

// ─────────────────────────────────────────────── the pure decision

describe("decideVerdictFollowUp", () => {
  test("fixed spawns nothing", () => {
    assert.equal(decideVerdictFollowUp({ verdict: "fixed", escalationSummary: "anything" }), "none");
  });
  test("first not_fixed re-investigates", () => {
    assert.equal(decideVerdictFollowUp({ verdict: "not_fixed", escalationSummary: "The app — badge stuck" }), "reinvestigate");
  });
  test("⛔ a not_fixed on a ticket that WAS the re-investigation goes to a person — the loop cap", () => {
    assert.equal(
      decideVerdictFollowUp({ verdict: "not_fixed", escalationSummary: `${FOLLOWUP_PREFIX} — T6HMUQ: badge stuck` }),
      "needs_person",
    );
  });
  test("⛔ a not_fixed on an already-marked ticket also goes to a person", () => {
    assert.equal(
      decideVerdictFollowUp({ verdict: "not_fixed", escalationSummary: `${NEEDS_PERSON_MARKER} anything` }),
      "needs_person",
    );
  });
});

// ─────────────────────────────────────────────── the service, end to end

function fakeDb(seed: { updates?: any[]; escalations?: any[] } = {}) {
  const state = {
    updates: seed.updates ?? [],
    escalations: seed.escalations ?? [],
    created: [] as any[],
  };
  return {
    state,
    supportUpdate: {
      updateMany: async ({ where, data }: any) => {
        const hit = state.updates.filter(
          (u: any) =>
            u.id === where.id && u.userId === where.userId && u.tenantId === where.tenantId &&
            where.status.in.includes(u.status),
        );
        hit.forEach((u: any) => Object.assign(u, data));
        return { count: hit.length };
      },
      findUnique: async ({ where }: any) => state.updates.find((u: any) => u.id === where.id) ?? null,
    },
    agentEscalation: {
      findUnique: async ({ where }: any) => state.escalations.find((e: any) => e.id === where.id) ?? null,
      create: async ({ data }: any) => {
        state.created.push(data);
        return { id: "esc-followup-" + state.created.length, ...data };
      },
    },
  };
}

const UPDATE = {
  id: "u1", escalationId: "e1", tenantId: "t1", userId: "u-customer",
  ticketRef: "UXN2E6", status: "delivered",
  technicalReport: "Investigated only. The badge is fed by /chat/threads unread counts…",
};
const ESC = {
  id: "e1", conversationId: "c1", tenantId: "t1", tenantName: "Connect Communications",
  clientUserId: "u-customer", userName: "ezra", userEmail: "ezra@connectcomunications.com",
  requestSummary: "The app — the unread badge will not clear",
};

const verdictInput = (v: "fixed" | "not_fixed", note?: string) => ({
  updateId: "u1", userId: "u-customer", tenantId: "t1", verdict: v, note,
});

describe("recordVerdict files the follow-up", () => {
  test("not_fixed creates a QUEUED escalation for the SAME customer — the dispatcher will text it", async () => {
    const db = fakeDb({ updates: [{ ...UPDATE }], escalations: [{ ...ESC }] });
    const out = await recordVerdict(db, verdictInput("not_fixed", "still stuck at 3"));
    assert.equal(out.ok, true);
    assert.equal(out.followUp, "reinvestigate");
    assert.equal(db.state.created.length, 1);
    const created = db.state.created[0];
    assert.equal(created.status, "QUEUED");
    assert.equal(created.clientUserId, "u-customer");
    // ⛔ The watcher classifies by userName — the ORIGINAL customer's name keeps
    // it in the customer lane rather than reading as a platform alarm.
    assert.equal(created.userName, "ezra");
    assert.ok(created.requestSummary.startsWith(FOLLOWUP_PREFIX));
    assert.ok(created.report.includes("still stuck at 3"), "the customer's note must reach the agent");
    assert.ok(created.report.includes("badge is fed by /chat/threads"), "the previous report must reach the agent");
    // ⛔ Required column: `null` here is a swallowed PrismaClientValidationError.
    assert.notEqual(created.proposedFix, null);
    assert.notEqual(created.proposedFix, undefined);
  });

  test("⛔ the SMS is plain ASCII — one emoji turns 160 chars into 70", async () => {
    const db = fakeDb({ updates: [{ ...UPDATE }], escalations: [{ ...ESC }] });
    await recordVerdict(db, verdictInput("not_fixed", "the ⛔ badge — still there…"));
    assert.match(db.state.created[0].smsBody, /^[\x20-\x7e]*$/);
  });

  test("⛔ the SECOND not_fixed is marked for a person — the watcher must not loop", async () => {
    const db = fakeDb({
      updates: [{ ...UPDATE }],
      escalations: [{ ...ESC, requestSummary: `${FOLLOWUP_PREFIX} — UXN2E6: the unread badge` }],
    });
    const out = await recordVerdict(db, verdictInput("not_fixed"));
    assert.equal(out.followUp, "needs_person");
    assert.ok(db.state.created[0].requestSummary.startsWith(NEEDS_PERSON_MARKER));
  });

  test("fixed creates nothing", async () => {
    const db = fakeDb({ updates: [{ ...UPDATE }], escalations: [{ ...ESC }] });
    const out = await recordVerdict(db, verdictInput("fixed"));
    assert.equal(out.followUp, "none");
    assert.equal(db.state.created.length, 0);
  });

  test("⛔ a failed follow-up never fails the verdict — and reports itself honestly", async () => {
    const db = fakeDb({ updates: [{ ...UPDATE }], escalations: [{ ...ESC }] });
    db.agentEscalation.create = async () => {
      throw new Error("db is having a day");
    };
    const out = await recordVerdict(db, verdictInput("not_fixed"));
    assert.equal(out.ok, true, "the customer's answer must be recorded regardless");
    assert.equal(out.followUp, "failed");
  });

  test("someone else's update stays unanswerable", async () => {
    const db = fakeDb({ updates: [{ ...UPDATE }], escalations: [{ ...ESC }] });
    const out = await recordVerdict(db, { ...verdictInput("not_fixed"), userId: "u-intruder" });
    assert.equal(out.ok, false);
    assert.equal(db.state.created.length, 0);
  });
});

// ─────────────────────────────────────────────── the route's wording

describe("⛔ SOURCE GUARD — the route can no longer promise what did not happen", () => {
  const src = fs.readFileSync(path.join(__dirname, "customerUpdateRoutes.ts"), "utf8").replace(/\r\n/g, "\n");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

  test("the old unearned sentence is gone", () => {
    assert.ok(!code.includes("We've reopened it and someone will pick it up"),
      "that sentence was false — recordVerdict only stamped the row");
  });

  test("the honest wording is keyed on what recordVerdict actually did", () => {
    assert.ok(code.includes("out.followUp"), "the route no longer reads the follow-up outcome");
  });
});
