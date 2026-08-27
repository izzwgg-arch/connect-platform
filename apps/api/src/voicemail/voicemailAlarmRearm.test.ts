/**
 * Two holes the 2026-08-27 audit found in the guards themselves, not in the
 * pipeline they watch:
 *
 * 1. Every email guardrail could fire exactly ONCE, EVER. The de-dupe suppressed
 *    on any OPEN escalation with the same key and `AgentEscalationStatus` has no
 *    RESOLVED value, so a delivered alarm ends at SENT and nothing ever moves it.
 *    One of the six keys was already burned. For a pipeline whose whole
 *    requirement is "an email must never silently fail", the alarm going
 *    permanently quiet after its first use is the worst possible failure.
 *
 * 2. A mailbox with nobody to email it was announced NOWHERE. `no_recipient` is
 *    deliberately filtered out of the watchdog's alarm, so fifteen voicemails
 *    reached nobody in a week across five mailboxes — three of them new that
 *    week, including a 3m42s message — with no signal anywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  decideEscalationSuppressed,
  decideNewlyBlindMailboxes,
  raiseGuardrailEscalation,
  ESCALATION_REDUPE_WINDOW_MS,
  ALARM_PREFIX,
} from "./voicemailEmailGuardrails";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

// ── 1. The alarm must re-arm ────────────────────────────────────────────────

test("a fresh alarm of the same kind is suppressed — a fault does not text every tick", () => {
  assert.equal(decideEscalationSuppressed({ existingCreatedAt: ago(60_000), now: NOW }), true);
});

test("⛔ an OLD alarm no longer suppresses — the guard re-arms", () => {
  assert.equal(
    decideEscalationSuppressed({ existingCreatedAt: ago(ESCALATION_REDUPE_WINDOW_MS + 1000), now: NOW }),
    false,
    "this is the whole fix: without it every key fires once, ever",
  );
});

test("⛔ the ALREADY-BURNED key from 2026-08-21 is re-armed by this change", () => {
  // The real row: "Voicemail email watchdog has stopped", created 2026-08-21,
  // status SENT, and nothing can ever move it out of SENT.
  const burned = new Date("2026-08-21T12:09:38.000Z");
  assert.equal(decideEscalationSuppressed({ existingCreatedAt: burned, now: NOW }), false);
});

test("no existing alarm never suppresses", () => {
  assert.equal(decideEscalationSuppressed({ existingCreatedAt: null, now: NOW }), false);
});

test("⛔ a future-dated row (clock skew) must not suppress forever", () => {
  assert.equal(
    decideEscalationSuppressed({ existingCreatedAt: new Date(NOW.getTime() + 3600_000), now: NOW }),
    false,
  );
});

test("⛔ the window is hours, not minutes — an alarm that texts through the night gets muted", () => {
  assert.ok(ESCALATION_REDUPE_WINDOW_MS >= 60 * 60_000, "too chatty");
  assert.ok(ESCALATION_REDUPE_WINDOW_MS <= 24 * 60 * 60_000, "too quiet to be a nag");
});

test("raiseGuardrailEscalation writes again once the old one has aged out", async () => {
  const created: any[] = [];
  const database = {
    agentEscalation: {
      findFirst: async () => ({ id: "old", createdAt: ago(ESCALATION_REDUPE_WINDOW_MS + 60_000) }),
      create: async (a: any) => { created.push(a.data); },
    },
  };
  const alarm = { key: ALARM_PREFIX.sweepDead, summary: "x", sms: "y", report: "z", fix: "f" };
  const wrote = await raiseGuardrailEscalation(alarm, undefined, database, NOW);
  assert.equal(wrote, true);
  assert.equal(created.length, 1);
});

test("raiseGuardrailEscalation stays quiet while the old one is recent", async () => {
  const created: any[] = [];
  const database = {
    agentEscalation: {
      findFirst: async () => ({ id: "recent", createdAt: ago(60_000) }),
      create: async (a: any) => { created.push(a.data); },
    },
  };
  const alarm = { key: ALARM_PREFIX.sweepDead, summary: "x", sms: "y", report: "z", fix: "f" };
  assert.equal(await raiseGuardrailEscalation(alarm, undefined, database, NOW), false);
  assert.deepEqual(created, []);
});

// ── 2. A mailbox that has just gone blind ───────────────────────────────────

test("⛔ the FIRST run is a baseline, never a back-catalogue burst", () => {
  const v = decideNewlyBlindMailboxes({ previous: null, current: ["t1:108", "t2:105", "t3:106"] });
  assert.equal(v.firstRun, true);
  assert.deepEqual(v.newly, [], "paging about every already-known blind mailbox on deploy is the burst to avoid");
});

test("only a mailbox that has JOINED the set is announced", () => {
  const v = decideNewlyBlindMailboxes({ previous: ["t1:108"], current: ["t1:108", "t2:105"] });
  assert.deepEqual(v.newly, ["t2:105"]);
});

test("a mailbox already in the set is never re-announced — no nagging", () => {
  const v = decideNewlyBlindMailboxes({ previous: ["t1:108", "t2:105"], current: ["t1:108", "t2:105"] });
  assert.deepEqual(v.newly, []);
});

test("a mailbox that leaves the set and returns is announced again", () => {
  const gone = decideNewlyBlindMailboxes({ previous: ["t1:108"], current: [] });
  assert.deepEqual(gone.newly, []);
  const back = decideNewlyBlindMailboxes({ previous: [], current: ["t1:108"] });
  assert.deepEqual(back.newly, ["t1:108"], "fixing the address must re-arm the alarm for that mailbox");
});

test("the three mailboxes that went blind unnoticed in the audit week would all have been announced", () => {
  const before = ["aplus:108", "landau:101"];
  const after = ["aplus:108", "landau:101", "bvisible:105", "bvisible:106", "createabox:105"];
  const v = decideNewlyBlindMailboxes({ previous: before, current: after });
  assert.deepEqual(v.newly, ["bvisible:105", "bvisible:106", "createabox:105"]);
});

// ── Source guards: wiring, because a check nobody calls is not a check ──────

function code(file: string): string {
  return readFileSync(join(__dirname, file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
    .join("\n");
}

test("⛔ the blind-mailbox check is actually started, with a boot kick AND an interval", () => {
  const s = code("voicemailEmailGuardrails.ts");
  const start = s.slice(s.indexOf("export function startEmailGuardrails"));
  // ⛔ `[^)]*` cannot cross the `)` in `() =>`; match across it deliberately.
  assert.match(start, /setTimeout\([\s\S]{0,120}?runBlindMailboxCheck/, "a bare setInterval is starved by a busy deploy day");
  assert.match(start, /setInterval\([\s\S]{0,120}?runBlindMailboxCheck/);
});

test("⛔ the escalation de-dupe consults the time window, not merely existence", () => {
  const s = code("voicemailEmailGuardrails.ts");
  assert.match(s, /decideEscalationSuppressed\(/);
  assert.doesNotMatch(
    s,
    /if \(open\) \{\s*\n\s*log\?\.info/,
    "the unbounded `if (open)` suppression is what made every alarm one-shot",
  );
});

test("⛔ these guards raise escalations and NEVER queue an email themselves", () => {
  // ⛔ Asserting the file contains no "ADMIN_ALERT" at all is the WRONG check and
  // fails on correct code: the string legitimately appears as the admin tenant-id
  // constant and as `type: { not: "ADMIN_ALERT" }` filters that deliberately
  // EXCLUDE it. Count against the real risk instead — an email job being created
  // here, which would ride the muted type and reach nobody.
  const s = code("voicemailEmailGuardrails.ts");
  assert.doesNotMatch(s, /emailJob\.create/, "an alarm must never be an email; it must be an escalation");
  assert.match(s, /agentEscalation\.create/, "the escalation is the only channel that reaches a phone");
});
