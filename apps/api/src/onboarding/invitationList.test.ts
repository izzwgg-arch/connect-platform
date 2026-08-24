import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInvitationRow, countByFilter, decideState, gapWords, agoWords, type InvitationRowInput } from "./invitationList";

const NOW = new Date("2026-08-24T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 24 * 60 * 60 * 1000;

function row(over: Partial<InvitationRowInput> = {}): InvitationRowInput {
  return {
    id: "s1",
    publicToken: "tok",
    companyName: "Hanna Weber",
    contactFirstName: null,
    contactLastName: null,
    mainEmail: "chaniweb16@gmail.com",
    status: "INVITE_SENT",
    createdAt: ago(2 * DAY),
    updatedAt: ago(2 * DAY),
    submittedAt: null,
    paidAt: null,
    createdTenantId: null,
    extensionCount: 0,
    openedAt: null,
    lastActivityAt: null,
    currentStepLabel: null,
    inviteSentAt: ago(2 * DAY),
    ...over,
  };
}

test("a link nobody opened says so, and is worth chasing", () => {
  const r = buildInvitationRow(row(), NOW);
  assert.equal(r.state, "not_opened");
  assert.equal(r.stateLabel, "Not opened yet");
  assert.ok(r.storyLine.endsWith("nobody has ever opened it"));
  assert.equal(r.needsNudge, true);
  assert.equal(r.canResend, true, "there is an email on it, so it can be chased");
});

test("a link with no email can be copied but never resent", () => {
  const r = buildInvitationRow(row({ mainEmail: null, companyName: null }), NOW);
  assert.equal(r.canResend, false);
  assert.equal(r.companyName, "");
});

test("someone mid-wizard right now reads as in progress, not as trouble", () => {
  const r = buildInvitationRow(
    row({ openedAt: ago(20 * 60_000), lastActivityAt: ago(4 * 60_000), currentStepLabel: "Your number" }),
    NOW,
  );
  assert.equal(r.state, "in_progress");
  assert.equal(r.stateLabel, "Filling it in");
  assert.equal(r.needsNudge, false);
  assert.ok(r.storyLine.includes("stopped at “Your number”"));
  assert.ok(r.storyLine.includes("last seen 4 minutes ago"));
});

// ⛔ The whole point of the state: "opened it and went quiet" is the actionable
// one, and it used to be indistinguishable from "signed up fine".
test("someone who opened it and then went quiet for days is flagged", () => {
  const r = buildInvitationRow(row({ openedAt: ago(6 * DAY), lastActivityAt: ago(5 * DAY) }), NOW);
  assert.equal(r.state, "stalled");
  assert.equal(r.stateLabel, "Stopped halfway");
  assert.equal(r.needsNudge, true);
});

test("paid but still building is its own state — not 'live' and not 'stuck'", () => {
  const r = buildInvitationRow(row({ status: "AWAITING_PBX_SETUP", openedAt: ago(DAY), paidAt: ago(DAY) }), NOW);
  assert.equal(r.state, "building");
  assert.equal(r.stateLabel, "Setting up their phones");
  assert.equal(r.needsNudge, false);
});

test("submitted but unpaid is chased for payment, not for the wizard", () => {
  const r = buildInvitationRow(row({ status: "SUBMITTED", openedAt: ago(DAY), submittedAt: ago(DAY) }), NOW);
  assert.equal(r.state, "awaiting_payment");
  assert.equal(r.stateLabel, "Waiting on payment");
});

test("a finished sign-up says when it finished and offers no resend", () => {
  const r = buildInvitationRow(
    row({ status: "ACTIVE", openedAt: ago(4 * DAY), paidAt: ago(4 * DAY), submittedAt: ago(4 * DAY) }),
    NOW,
  );
  assert.equal(r.state, "live");
  assert.equal(r.stateLabel, "Live");
  assert.equal(r.canResend, false, "there is nothing left to invite them to");
  assert.ok(r.storyLine.includes("finished"));
});

test("a cancelled sign-up is never chased", () => {
  const r = buildInvitationRow(row({ status: "CANCELED", openedAt: ago(DAY) }), NOW);
  assert.equal(r.state, "cancelled");
  assert.equal(r.needsNudge, false);
  assert.equal(r.canResend, false);
});

test("the story line reads like a sentence, not a database row", () => {
  const r = buildInvitationRow(
    row({ status: "ACTIVE", inviteSentAt: new Date("2026-08-20T16:07:00Z"), openedAt: new Date("2026-08-20T16:09:00Z"), paidAt: new Date("2026-08-20T16:21:00Z"), submittedAt: new Date("2026-08-20T16:17:00Z") }),
    NOW,
  );
  assert.equal(r.storyLine, "Sent 20 Aug · opened 2 minutes later · finished 20 Aug");
  assert.ok(!/INVITE_SENT|ACTIVE|null|undefined/.test(r.storyLine));
});

test("a link that was never emailed says 'Made', not 'Sent'", () => {
  const r = buildInvitationRow(row({ inviteSentAt: null }), NOW);
  assert.ok(r.storyLine.startsWith("Made "), r.storyLine);
});

test("the filter counts add up the way the chips claim", () => {
  const rows = [
    buildInvitationRow(row({ id: "a" }), NOW),
    buildInvitationRow(row({ id: "b", status: "ACTIVE", openedAt: ago(DAY), paidAt: ago(DAY) }), NOW),
    buildInvitationRow(row({ id: "c", openedAt: ago(10 * 60_000), lastActivityAt: ago(60_000) }), NOW),
    buildInvitationRow(row({ id: "d", openedAt: ago(9 * DAY), lastActivityAt: ago(9 * DAY) }), NOW),
  ];
  const c = countByFilter(rows);
  assert.equal(c.all, 4);
  assert.equal(c.nudge, 2, "the unopened one and the abandoned one");
  assert.equal(c.inProgress, 1);
  assert.equal(c.finished, 1);
});

test("the nudge threshold is a boundary, not a vibe", () => {
  const justInside = decideState(row({ openedAt: ago(2.9 * DAY), lastActivityAt: ago(2.9 * DAY) }), NOW);
  const justOutside = decideState(row({ openedAt: ago(3.1 * DAY), lastActivityAt: ago(3.1 * DAY) }), NOW);
  assert.equal(justInside.state, "in_progress");
  assert.equal(justOutside.state, "stalled");
});

test("gaps and ages are written the way somebody would say them", () => {
  const t0 = new Date("2026-08-20T16:07:00Z");
  assert.equal(gapWords(t0, new Date("2026-08-20T16:07:30Z")), "30 seconds later");
  assert.equal(gapWords(t0, new Date("2026-08-20T16:09:00Z")), "2 minutes later");
  assert.equal(gapWords(t0, new Date("2026-08-20T20:07:00Z")), "4 hours later");
  assert.equal(gapWords(t0, new Date("2026-08-24T16:07:00Z")), "4 days later");
  assert.equal(agoWords(ago(30_000), NOW), "just now");
  assert.equal(agoWords(ago(1 * DAY), NOW), "24 hours ago");
});

// ⛔ CAUGHT BY READING THE LIVE SCREEN, NOT BY A FIXTURE. The "opened" beacon
// arrived after some of these sign-ups, and one an admin builds by script has
// no wizard events at all — so a missing beacon is not proof nobody used the
// link. The first live read showed a LIVE customer captioned "nobody has ever
// opened it", and a customer with autosaves in the record labelled "Not opened
// yet". Both are the kind of wrong that makes a screen untrustworthy.
test("a link with typing in it is never reported as unopened, even with no beacon", () => {
  const r = buildInvitationRow(
    row({ openedAt: null, lastActivityAt: ago(30 * 60_000), currentStepLabel: "Your number" }),
    NOW,
  );
  assert.notEqual(r.state, "not_opened");
  assert.equal(r.state, "in_progress");
  assert.ok(!r.storyLine.includes("nobody has ever opened it"), r.storyLine);
  assert.ok(r.storyLine.includes("they filled it in"), r.storyLine);
});

test("a finished account built by hand says so, instead of accusing the customer", () => {
  const r = buildInvitationRow(
    row({ status: "ACTIVE", openedAt: null, lastActivityAt: null, submittedAt: ago(2 * DAY), paidAt: null }),
    NOW,
  );
  assert.equal(r.state, "live");
  assert.ok(!r.storyLine.includes("nobody has ever opened it"), r.storyLine);
  assert.ok(r.storyLine.includes("set up for them"), r.storyLine);
  assert.ok(r.storyLine.includes("finished"), r.storyLine);
});

test("a genuinely untouched link still says so plainly", () => {
  const r = buildInvitationRow(row({ openedAt: null, lastActivityAt: null }), NOW);
  assert.equal(r.state, "not_opened");
  assert.ok(r.storyLine.endsWith("nobody has ever opened it"));
});
