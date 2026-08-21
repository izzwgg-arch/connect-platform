/**
 * Loopcom Direct — the pure decision layer for cross-company chat.
 *
 * ⛔⛔ EVERY PRIVACY RULE THIS FEATURE HAS LIVES IN THIS FILE, AS A PURE
 * FUNCTION WITH NO DATABASE AND NO I/O. The routes fetch rows and call these;
 * they never re-derive a rule inline. That is deliberate: this is the one
 * feature on the platform where a person at company A can reach a person at
 * company B, so the rules that decide whether that is allowed must be
 * readable, testable, and impossible to half-apply at one of several call
 * sites — the defect shape that has bitten this repo over and over (two IVR
 * publish paths, two SMS ingest paths, two invite paths).
 *
 * The three rules, in plain English:
 *   1. You can only be found if you personally verified your mobile number AND
 *      left "findable" on. No verification = you do not exist to search.
 *   2. A stranger's first message waits as a REQUEST. Until you accept, they
 *      cannot send a second message, cannot see that you read the first, and
 *      cannot call you.
 *   3. A block is one-directional and absolute, and is NEVER disclosed. To a
 *      blocked person, the blocker looks exactly like a number that is not on
 *      Loopcom — same words, same shape. Anything else is an oracle.
 */

import { canonicalSmsPhone } from "@connect/shared";

/** How a lookup answered. `not_found` is deliberately overloaded — see below. */
export type DirectLookupOutcome =
  | { kind: "found"; userId: string; findable: true }
  /**
   * ⛔ ONE outcome covers four very different truths: the number is not on
   * Loopcom, the person switched "findable" off, the person blocked you, or
   * you blocked them. The caller renders identical words for all four. Splitting
   * these apart would tell a stranger "this number IS on Loopcom, they just hid
   * from you" — which is precisely the fact a blocked person must not learn.
   */
  | { kind: "not_found" }
  | { kind: "self" }
  | { kind: "invalid_number"; reason: string };

export type DirectIdentityRow = {
  userId: string;
  tenantId: string;
  phoneE164: string;
  findable: boolean;
  requireRequests: boolean;
};

/**
 * Normalize what a person typed into the search box.
 * Accepts (347) 555-0182, 3475550182, +13475550182 — the shapes a human types.
 */
export function normalizeDirectPhone(raw: unknown): { ok: true; e164: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  const result = canonicalSmsPhone(trimmed);
  if (!result.ok) return { ok: false, reason: result.error };
  return { ok: true, e164: result.e164 };
}

/**
 * Decide what a number search may reveal.
 *
 * ⛔ `blockedEitherWay` must be true when EITHER side has blocked the other.
 * If only the blocker's own blocks were checked, a blocked person would still
 * find their blocker and be told "on Loopcom" — the block would be visible by
 * inference even though no message could be delivered.
 */
export function decideLookup(input: {
  viewerUserId: string;
  identity: DirectIdentityRow | null;
  blockedEitherWay: boolean;
  /** The target's company has the feature switched off. */
  targetTenantDisabled?: boolean;
}): DirectLookupOutcome {
  const { viewerUserId, identity, blockedEitherWay, targetTenantDisabled } = input;
  if (!identity) return { kind: "not_found" };
  if (identity.userId === viewerUserId) return { kind: "self" };
  if (!identity.findable) return { kind: "not_found" };
  if (targetTenantDisabled) return { kind: "not_found" };
  if (blockedEitherWay) return { kind: "not_found" };
  return { kind: "found", userId: identity.userId, findable: true };
}

export type DirectParticipantState = "ACTIVE" | "REQUEST_PENDING" | "DECLINED";

export type DirectParticipantRow = {
  userId: string;
  state: DirectParticipantState;
  lastReadAt: Date | null;
};

/**
 * The state the RECIPIENT starts in when a thread is created.
 *
 * ⛔ A prior relationship beats the requests setting: if these two have ever
 * had an accepted thread, a new one (they can't — one thread per pair — but a
 * DECLINED side re-opening counts) does not go back through requests. Making a
 * known contact re-request every time is the behaviour that teaches people to
 * ignore the tray.
 */
export function decideRecipientInitialState(input: {
  recipientRequiresRequests: boolean;
  recipientHasAcceptedBefore: boolean;
}): DirectParticipantState {
  if (input.recipientHasAcceptedBefore) return "ACTIVE";
  return input.recipientRequiresRequests ? "REQUEST_PENDING" : "ACTIVE";
}

export type SendDecision =
  | { ok: true }
  | { ok: false; reason: "not_a_participant" | "declined" | "blocked" | "awaiting_request"; message: string };

/**
 * May this person send a message into this thread right now?
 *
 * ⛔ THE ANTI-SPAM PROPERTY IS THE `awaiting_request` BRANCH, and it is the one
 * thing here that must never be relaxed for convenience: while the other side
 * has not accepted, the sender is capped at the ONE message they already sent.
 * Without it, "requests" only delays spam by one tap — a stranger could stack
 * fifty messages in a tray you have not opened.
 */
export function decideCanSend(input: {
  senderUserId: string;
  participants: DirectParticipantRow[];
  blockedEitherWay: boolean;
  senderMessageCount: number;
}): SendDecision {
  const { senderUserId, participants, blockedEitherWay, senderMessageCount } = input;

  const me = participants.find((p) => p.userId === senderUserId);
  if (!me) {
    return { ok: false, reason: "not_a_participant", message: "This conversation isn't available." };
  }
  if (me.state === "DECLINED") {
    return { ok: false, reason: "declined", message: "This conversation isn't available." };
  }
  if (blockedEitherWay) {
    // ⛔ Same words as any other unavailable thread — never "you were blocked".
    return { ok: false, reason: "blocked", message: "This conversation isn't available." };
  }

  const others = participants.filter((p) => p.userId !== senderUserId);
  const awaiting = others.some((p) => p.state === "REQUEST_PENDING");
  if (awaiting && senderMessageCount >= 1) {
    return {
      ok: false,
      reason: "awaiting_request",
      message: "You've sent your first message. You can write again once they accept your request.",
    };
  }
  return { ok: true };
}

/**
 * What the OTHER side is allowed to learn about my reading habits.
 * ⛔ A pending request must never leak a read receipt — that is half of what
 * makes opening a request safe ("Rivky can't see that you've read this").
 */
export function visibleReadAtForOther(other: DirectParticipantRow): Date | null {
  return other.state === "ACTIVE" ? other.lastReadAt : null;
}

/**
 * May a video call be started in this thread?
 * ⛔ Strictly stronger than sending: BOTH sides must be ACTIVE. A pending
 * request must not be able to make someone's phone ring.
 */
export function decideCanCall(input: {
  callerUserId: string;
  participants: DirectParticipantRow[];
  blockedEitherWay: boolean;
}): { ok: true } | { ok: false; message: string } {
  const { callerUserId, participants, blockedEitherWay } = input;
  if (blockedEitherWay) return { ok: false, message: "This conversation isn't available." };
  const me = participants.find((p) => p.userId === callerUserId);
  if (!me || me.state !== "ACTIVE") return { ok: false, message: "This conversation isn't available." };
  const others = participants.filter((p) => p.userId !== callerUserId);
  if (others.length === 0) return { ok: false, message: "This conversation isn't available." };
  if (!others.every((p) => p.state === "ACTIVE")) {
    return { ok: false, message: "You can call once they accept your request." };
  }
  return { ok: true };
}

/**
 * One thread per pair of people, forever — enforced by a unique index rather
 * than by every caller remembering to look both ways round.
 */
export function buildPairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/**
 * Remove control characters and bidi overrides. A right-to-left override can
 * make a message render as something other than what was sent, so it is
 * stripped before storage — but ordinary spaces and newlines are kept.
 * Written as a code check rather than a regex literal on purpose: the escape
 * form is easy to get wrong and a wrong one silently strips real text.
 */
function stripUnsafeChars(input: string): string {
  let out = "";
  for (const ch of input) {
    const c = ch.codePointAt(0) ?? 0;
    const isControl = (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127;
    const isBidi = (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    if (!isControl && !isBidi) out += ch;
  }
  return out;
}

export const DIRECT_MAX_BODY = 16_000;

export function sanitizeMessageBody(raw: unknown): { ok: true; body: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "Type a message first." };
  // Strip control characters and bidi overrides (a right-to-left override can
  // make a message render as something other than what was sent) — never spaces.
  // eslint-disable-next-line no-control-regex
  const body = stripUnsafeChars(raw).trim();
  if (!body) return { ok: false, message: "Type a message first." };
  if (body.length > DIRECT_MAX_BODY) return { ok: false, message: "That message is too long." };
  return { ok: true, body };
}

/**
 * How a person is introduced to someone who has never met them: their name and
 * the company they work for. ⛔ Never their email — a Direct card is shown to
 * someone at ANOTHER company, and an email address is the one identifier that
 * follows a person everywhere.
 */
export function buildDirectCard(input: {
  displayName: string | null;
  tenantName: string | null;
  phoneE164: string;
}): { name: string; company: string; phoneE164: string } {
  const name = (input.displayName ?? "").trim() || "Loopcom user";
  const company = (input.tenantName ?? "").trim() || "";
  return { name, company, phoneE164: input.phoneE164 };
}
