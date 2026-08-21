import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDirectCard,
  buildPairKey,
  decideCanCall,
  decideCanSend,
  decideLookup,
  decideRecipientInitialState,
  normalizeDirectPhone,
  sanitizeMessageBody,
  visibleReadAtForOther,
  type DirectIdentityRow,
  type DirectParticipantRow,
} from "./directPolicy";

const identity = (over: Partial<DirectIdentityRow> = {}): DirectIdentityRow => ({
  userId: "u-them",
  tenantId: "t-them",
  phoneE164: "+13475550182",
  findable: true,
  requireRequests: true,
  ...over,
});

const part = (over: Partial<DirectParticipantRow> = {}): DirectParticipantRow => ({
  userId: "u-me",
  state: "ACTIVE",
  lastReadAt: null,
  ...over,
});

// ---------------------------------------------------------------- phone input

test("a human-typed number in any shape normalizes to one E.164 form", () => {
  for (const raw of ["(347) 555-0182", "347-555-0182", "3475550182", "+13475550182", " 1 347 555 0182 "]) {
    const r = normalizeDirectPhone(raw);
    assert.equal(r.ok, true, raw);
    if (r.ok) assert.equal(r.e164, "+13475550182", raw);
  }
});

test("junk in the number box is refused, never guessed at", () => {
  for (const raw of ["", "   ", "hello", "12", null, undefined, 3475550182]) {
    assert.equal(normalizeDirectPhone(raw as unknown).ok, false, String(raw));
  }
});

// -------------------------------------------------------------------- lookup

test("a verified findable person is found", () => {
  const out = decideLookup({ viewerUserId: "u-me", identity: identity(), blockedEitherWay: false });
  assert.equal(out.kind, "found");
});

test("⛔ THE ORACLE TEST: unknown number, hidden person, and a block are BYTE-IDENTICAL answers", () => {
  const notOnLoopcom = decideLookup({ viewerUserId: "u-me", identity: null, blockedEitherWay: false });
  const hidden = decideLookup({
    viewerUserId: "u-me",
    identity: identity({ findable: false }),
    blockedEitherWay: false,
  });
  const blocked = decideLookup({ viewerUserId: "u-me", identity: identity(), blockedEitherWay: true });
  const companyOff = decideLookup({
    viewerUserId: "u-me",
    identity: identity(),
    blockedEitherWay: false,
    targetTenantDisabled: true,
  });

  // Deep-equal, not just "all not_found" — an extra field on any one of these
  // would be the leak, and would still pass a kind-only assertion.
  assert.deepEqual(notOnLoopcom, { kind: "not_found" });
  assert.deepEqual(hidden, notOnLoopcom);
  assert.deepEqual(blocked, notOnLoopcom);
  assert.deepEqual(companyOff, notOnLoopcom);
});

test("looking up your own number says so rather than pretending you don't exist", () => {
  const out = decideLookup({ viewerUserId: "u-them", identity: identity(), blockedEitherWay: false });
  assert.equal(out.kind, "self");
});

// ------------------------------------------------------------- first contact

test("a stranger lands in the requests tray when the recipient wants requests", () => {
  assert.equal(
    decideRecipientInitialState({ recipientRequiresRequests: true, recipientHasAcceptedBefore: false }),
    "REQUEST_PENDING",
  );
});

test("someone already accepted comes straight through, even with requests on", () => {
  assert.equal(
    decideRecipientInitialState({ recipientRequiresRequests: true, recipientHasAcceptedBefore: true }),
    "ACTIVE",
  );
});

test("with requests switched off, a stranger arrives directly", () => {
  assert.equal(
    decideRecipientInitialState({ recipientRequiresRequests: false, recipientHasAcceptedBefore: false }),
    "ACTIVE",
  );
});

// --------------------------------------------------------------------- send

test("two active participants can talk", () => {
  const out = decideCanSend({
    senderUserId: "u-me",
    participants: [part(), part({ userId: "u-them" })],
    blockedEitherWay: false,
    senderMessageCount: 5,
  });
  assert.equal(out.ok, true);
});

test("⛔ THE ANTI-SPAM RULE: a pending request caps the sender at their one first message", () => {
  const first = decideCanSend({
    senderUserId: "u-me",
    participants: [part(), part({ userId: "u-them", state: "REQUEST_PENDING" })],
    blockedEitherWay: false,
    senderMessageCount: 0,
  });
  assert.equal(first.ok, true, "the first message must go through");

  const second = decideCanSend({
    senderUserId: "u-me",
    participants: [part(), part({ userId: "u-them", state: "REQUEST_PENDING" })],
    blockedEitherWay: false,
    senderMessageCount: 1,
  });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "awaiting_request");
});

test("a blocked sender is refused in the same words as any unavailable thread", () => {
  const blocked = decideCanSend({
    senderUserId: "u-me",
    participants: [part(), part({ userId: "u-them" })],
    blockedEitherWay: true,
    senderMessageCount: 0,
  });
  const declined = decideCanSend({
    senderUserId: "u-me",
    participants: [part({ state: "DECLINED" }), part({ userId: "u-them" })],
    blockedEitherWay: false,
    senderMessageCount: 0,
  });
  assert.equal(blocked.ok, false);
  assert.equal(declined.ok, false);
  if (!blocked.ok && !declined.ok) {
    // ⛔ The words must match, or the difference tells a blocked person they
    // were blocked rather than simply unavailable.
    assert.equal(blocked.message, declined.message);
  }
});

test("a non-participant cannot post into somebody else's conversation", () => {
  const out = decideCanSend({
    senderUserId: "u-stranger",
    participants: [part(), part({ userId: "u-them" })],
    blockedEitherWay: false,
    senderMessageCount: 0,
  });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "not_a_participant");
});

// ------------------------------------------------------------ read receipts

test("⛔ a pending request never leaks a read receipt", () => {
  const readAt = new Date("2026-08-21T12:00:00Z");
  assert.equal(visibleReadAtForOther(part({ state: "REQUEST_PENDING", lastReadAt: readAt })), null);
  assert.equal(visibleReadAtForOther(part({ state: "DECLINED", lastReadAt: readAt })), null);
  assert.equal(visibleReadAtForOther(part({ state: "ACTIVE", lastReadAt: readAt })), readAt);
});

// --------------------------------------------------------------------- call

test("⛔ a pending request cannot make somebody's phone ring", () => {
  const out = decideCanCall({
    callerUserId: "u-me",
    participants: [part(), part({ userId: "u-them", state: "REQUEST_PENDING" })],
    blockedEitherWay: false,
  });
  assert.equal(out.ok, false);
});

test("two active participants may call", () => {
  const out = decideCanCall({
    callerUserId: "u-me",
    participants: [part(), part({ userId: "u-them" })],
    blockedEitherWay: false,
  });
  assert.equal(out.ok, true);
});

test("a block stops a call as well as a message", () => {
  const out = decideCanCall({
    callerUserId: "u-me",
    participants: [part(), part({ userId: "u-them" })],
    blockedEitherWay: true,
  });
  assert.equal(out.ok, false);
});

// ------------------------------------------------------------------ pairing

test("the pair key is the same whichever way round the two people are given", () => {
  assert.equal(buildPairKey("a", "b"), buildPairKey("b", "a"));
  assert.notEqual(buildPairKey("a", "b"), buildPairKey("a", "c"));
});

// ------------------------------------------------------------------ message

test("an empty or whitespace-only message is refused", () => {
  for (const raw of ["", "   ", "\n\n", null, 42]) {
    assert.equal(sanitizeMessageBody(raw as unknown).ok, false, JSON.stringify(raw));
  }
});

test("⛔ ordinary spaces and newlines survive sanitising — only control characters go", () => {
  const out = sanitizeMessageBody("Hi Moshe, are you free at 2?\nI'll call you.");
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.body, "Hi Moshe, are you free at 2?\nI'll call you.");
});

test("a right-to-left override is stripped, the words are kept", () => {
  const rtlOverride = String.fromCodePoint(0x202e);
  const nul = String.fromCodePoint(0x0007);
  const out = sanitizeMessageBody(`pay${rtlOverride}me${nul} now`);
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.body, "payme now");
    assert.ok(!out.body.includes(rtlOverride));
  }
});

test("an over-long message is refused rather than silently cut", () => {
  assert.equal(sanitizeMessageBody("x".repeat(16_001)).ok, false);
  assert.equal(sanitizeMessageBody("x".repeat(16_000)).ok, true);
});

// --------------------------------------------------------------------- card

test("⛔ a person's card carries their name and company, never their email", () => {
  const card = buildDirectCard({
    displayName: "Moshe Green",
    tenantName: "Brooklyn Hardware Supply",
    phoneE164: "+13475550182",
  });
  assert.equal(card.name, "Moshe Green");
  assert.equal(card.company, "Brooklyn Hardware Supply");
  assert.equal(JSON.stringify(card).includes("@"), false);
});

test("a missing name falls back to a neutral label, never a blank card", () => {
  const card = buildDirectCard({ displayName: null, tenantName: null, phoneE164: "+13475550182" });
  assert.equal(card.name, "Loopcom user");
  assert.equal(card.company, "");
});
