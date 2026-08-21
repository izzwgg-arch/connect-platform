/**
 * Where one phone is up to, and what the customer is told about it.
 *
 * ⛔⛔ TWO VOCABULARIES, DELIBERATELY. Internally there are sixteen states, because
 * "we asked it to reset" and "it has gone quiet" and "it came back at a new address"
 * are three genuinely different situations and conflating them is how a wizard
 * resets a phone twice. The customer sees SIX words. Nothing from the internal set
 * is ever put on a customer's screen.
 *
 * ⛔⛔ AND THE REASON THE INTERNAL STATE IS PERSISTED ON THE SERVER, not in the app:
 * a factory reset is destructive and not idempotent. If the app closes, Windows
 * restarts, the network drops, or the phone comes back on a different address, the
 * record of "this phone has already been reset once" has to outlive all of it.
 * Losing our place must never turn into wiping a customer's phone a second time.
 */

export const PHONE_STATES = [
  "DISCOVERED",
  "IDENTIFIED",
  "AUTHENTICATED",
  "ASSIGNED",
  "PREPARING",
  "RESET_AUTHORIZED",
  "RESET_REQUESTED",
  "WAITING_FOR_REBOOT",
  "REDISCOVERING",
  "REDISCOVERED",
  "PROVISIONING_CONFIGURED",
  "PROVISIONING",
  "WAITING_FOR_REGISTRATION",
  "REGISTERED",
  "NEEDS_ATTENTION",
  "FAILED",
] as const;

export type PhoneState = (typeof PHONE_STATES)[number];

/** The six words a customer may see. */
export const CUSTOMER_STATES = [
  "Finding",
  "Preparing",
  "Restarting",
  "Connecting",
  "Ready",
  "Needs attention",
] as const;

export type CustomerState = (typeof CUSTOMER_STATES)[number];

const CUSTOMER_VIEW: Record<PhoneState, CustomerState> = {
  DISCOVERED: "Finding",
  IDENTIFIED: "Finding",
  AUTHENTICATED: "Preparing",
  ASSIGNED: "Preparing",
  PREPARING: "Preparing",
  RESET_AUTHORIZED: "Preparing",
  RESET_REQUESTED: "Restarting",
  WAITING_FOR_REBOOT: "Restarting",
  REDISCOVERING: "Restarting",
  REDISCOVERED: "Restarting",
  PROVISIONING_CONFIGURED: "Connecting",
  PROVISIONING: "Connecting",
  WAITING_FOR_REGISTRATION: "Connecting",
  REGISTERED: "Ready",
  NEEDS_ATTENTION: "Needs attention",
  FAILED: "Needs attention",
};

/**
 * ⛔ `FAILED` shows as "Needs attention", never as "Failed". A customer reading
 * "failed" on one of eight phones reads the whole setup as broken; the seven working
 * phones are the outcome they actually came for.
 */
export function customerStateFor(state: PhoneState): CustomerState {
  return CUSTOMER_VIEW[state];
}

/** Done, one way or the other. Nothing further happens without a person. */
export function isTerminal(state: PhoneState): boolean {
  return state === "REGISTERED" || state === "NEEDS_ATTENTION" || state === "FAILED";
}

/** The only state that counts as success. */
export function isSuccess(state: PhoneState): boolean {
  return state === "REGISTERED";
}

/**
 * What may follow what.
 *
 * ⛔ Every state may go to NEEDS_ATTENTION or FAILED — anything can go wrong at any
 * point. What is deliberately NOT here is a path back into RESET_AUTHORIZED from
 * anywhere downstream: once a phone has been reset, the way to reset it again is a
 * fresh authorization from a person, not a retry loop.
 */
const TRANSITIONS: Record<PhoneState, PhoneState[]> = {
  DISCOVERED: ["IDENTIFIED"],
  IDENTIFIED: ["AUTHENTICATED", "ASSIGNED"],
  AUTHENTICATED: ["ASSIGNED"],
  ASSIGNED: ["PREPARING"],
  PREPARING: ["PROVISIONING_CONFIGURED", "RESET_AUTHORIZED"],
  RESET_AUTHORIZED: ["RESET_REQUESTED"],
  RESET_REQUESTED: ["WAITING_FOR_REBOOT"],
  WAITING_FOR_REBOOT: ["REDISCOVERING"],
  REDISCOVERING: ["REDISCOVERED"],
  REDISCOVERED: ["PROVISIONING_CONFIGURED"],
  PROVISIONING_CONFIGURED: ["PROVISIONING"],
  PROVISIONING: ["WAITING_FOR_REGISTRATION"],
  WAITING_FOR_REGISTRATION: ["REGISTERED"],
  REGISTERED: [],
  NEEDS_ATTENTION: [],
  FAILED: [],
};

const ALWAYS_ALLOWED: PhoneState[] = ["NEEDS_ATTENTION", "FAILED"];

export function canTransition(from: PhoneState, to: PhoneState): boolean {
  if (from === to) return true;
  if (ALWAYS_ALLOWED.includes(to) && !isTerminal(from)) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export type PhoneRecord = {
  state: PhoneState;
  /** How many times this phone has actually been reset. Never derived, always stored. */
  resetCount: number;
  /** Whether a person has authorized a reset that has not been spent yet. */
  resetAuthorizedAt: string | null;
  /** How many full attempts the ladder has made on this phone. */
  attempts: number;
};

/**
 * The cap. Izzy: the agent must do everything in its power to connect every phone —
 * but the phones that cannot be connected are the ones another company owns or the
 * customer's own router keeps overriding, and neither of those gets better on the
 * third try.
 *
 * ⛔⛔ TWO IS DELIBERATE. Resetting a customer's phone in a loop is worse than
 * stopping and saying why: it keeps the handset rebooting all day, it looks like an
 * attack to the previous provider, and it never once produces a different answer.
 */
export const MAX_ATTEMPTS = 2;

/** A phone may only ever be factory reset once per authorization, and once per run. */
export const MAX_RESETS_PER_RUN = 1;

export type ResetDecision =
  | { allowed: true }
  | { allowed: false; reason: "not_authorized" | "already_reset" | "attempts_exhausted" | "terminal"; explain: string };

/**
 * ⛔⛔ THE ONE FUNCTION THAT MUST NOT BE WRONG. Everything about not wiping a
 * customer's phone by accident comes down to this returning false when it should.
 * It is pure, it takes the stored record rather than anything in memory, and it
 * fails closed on every branch.
 */
export function decideReset(rec: PhoneRecord): ResetDecision {
  if (isTerminal(rec.state)) {
    return { allowed: false, reason: "terminal", explain: "This phone is already finished with." };
  }
  if (rec.attempts >= MAX_ATTEMPTS) {
    return {
      allowed: false,
      reason: "attempts_exhausted",
      explain: "We have already tried this phone twice. Trying again will not change the answer.",
    };
  }
  if (rec.resetCount >= MAX_RESETS_PER_RUN) {
    return {
      allowed: false,
      reason: "already_reset",
      explain: "This phone has already been cleared once during this setup.",
    };
  }
  if (!rec.resetAuthorizedAt) {
    return {
      allowed: false,
      reason: "not_authorized",
      explain: "Nobody in the office has approved clearing this phone.",
    };
  }
  return { allowed: true };
}

/** Roll a run's phones up into the numbers the customer sees. */
export type RunSummary = {
  total: number;
  ready: number;
  working: number;
  needsAttention: number;
  /** True once nothing is still moving. */
  finished: boolean;
  /** "Your phones are ready" vs "7 of your 8 phones are ready". */
  headline: string;
};

export function summarizeRun(states: PhoneState[]): RunSummary {
  const total = states.length;
  const ready = states.filter(isSuccess).length;
  const needsAttention = states.filter((s) => s === "NEEDS_ATTENTION" || s === "FAILED").length;
  const working = total - ready - needsAttention;
  const finished = working === 0;
  let headline: string;
  if (total === 0) headline = "No phones to set up";
  else if (!finished) headline = `${ready} of ${total} phones ready`;
  else if (needsAttention === 0) headline = total === 1 ? "Your phone is ready" : "Your phones are ready";
  // ⛔ Count the wins first. Never "1 failed".
  else headline = `${ready} of your ${total} phones are ready`;
  return { total, ready, working, needsAttention, finished, headline };
}
