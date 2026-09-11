/**
 * NOTHING MAY BE PERMANENTLY STUCK.
 *
 * ⛔⛔ THE DEFECT THIS EXISTS TO FIX, measured on Izzy's own run 2026-09-11. His
 * Yealink sat in `NEEDS_ATTENTION` with `haltedReason: support`. `NEEDS_ATTENTION`
 * has an EMPTY transition list and `isTerminal()` returns true for it, so there was
 * no way out — not by re-running the wizard, not by re-scanning, not by anything a
 * customer could do. Worse, the halt had been written BEFORE the fix that removed
 * the hour-long give-up: deleting that clock stopped new phones being halted and
 * could do nothing for one already halted. He pressed the button again, the same
 * stale sentence came back, and the whole run reported zero attempts.
 *
 * ⛔ THIS IS DELIBERATELY NOT A LADDER TRANSITION. `TRANSITIONS` in states.ts says
 * what the wizard will do ON ITS OWN, and a terminal state genuinely is terminal
 * there — the ladder must never quietly restart a phone it has given up on, because
 * that is a reboot loop on somebody's desk. A retry is a PERSON saying "go again",
 * which is a different kind of event, so it gets its own function, its own audit and
 * its own rules.
 *
 * ⛔⛔ AND THE ONE THING A RETRY MUST NEVER DO IS FORGIVE A RESET. `resetCount` is
 * the record of how many times we have actually wiped a customer's hardware. It
 * survives a retry, it survives a new run, and it survives the app being closed —
 * losing our place must never turn into wiping somebody's phone a second time.
 */

import { type PhoneState, isTerminal } from "./states";

export type RetryRecord = {
  state: PhoneState;
  /** How many times this handset has actually been wiped. NEVER cleared by a retry. */
  resetCount: number;
  attempts: number;
  /** Whether somebody has chosen who this phone belongs to. */
  hasExtension: boolean;
};

export type RetryPlan =
  | {
      allowed: true;
      /** Where the phone goes back to. */
      nextState: PhoneState;
      /** Attempts start again — a person asking is a new go, not a continuation. */
      resetAttempts: true;
      explain: string;
    }
  | {
      allowed: false;
      reason: "already_working" | "nothing_to_retry";
      explain: string;
      customerMessage: string;
    };

/**
 * What happens when a person presses "try this phone again".
 *
 * ⛔ Refusing on a WORKING phone is the important branch. A retry on a registered
 * handset would take a phone somebody is using, send it round the ladder again and
 * very possibly restart it — the single worst thing this wizard could do.
 */
export function planPhoneRetry(rec: RetryRecord): RetryPlan {
  if (rec.state === "REGISTERED") {
    return {
      allowed: false,
      reason: "already_working",
      explain: "phone is registered; a retry would restart a working handset",
      customerMessage: "This phone is already working — there is nothing to try again.",
    };
  }
  // Everything else may be retried, including the states the ladder considers
  // terminal. That is the whole point: `NEEDS_ATTENTION` means the wizard stopped,
  // not that the phone is beyond help.
  const nextState: PhoneState = rec.hasExtension ? "ASSIGNED" : "IDENTIFIED";
  return {
    allowed: true,
    nextState,
    resetAttempts: true,
    explain: isTerminal(rec.state)
      ? `person asked to try ${rec.state} phone again; returning to ${nextState}, reset history kept at ${rec.resetCount}`
      : `person asked to try a phone that was mid-flight in ${rec.state}; returning to ${nextState}`,
  };
}

/**
 * What a retry clears and what it keeps.
 *
 * ⛔ Kept on purpose: `resetCount`, `resetRequestedAt`, `registeredAt`, the MAC, the
 * assignment. Cleared on purpose: the notes and the halt reason, because leaving the
 * old sentence on screen after a retry is exactly what made Izzy's second run look
 * identical to his first.
 */
export type RetryClears = {
  state: PhoneState;
  attempts: number;
  customerNote: null;
  technicalNote: null;
  haltedReason: null;
};

export function retryClears(plan: Extract<RetryPlan, { allowed: true }>): RetryClears {
  return {
    state: plan.nextState,
    attempts: 0,
    customerNote: null,
    technicalNote: null,
    haltedReason: null,
  };
}

/**
 * How many phones in a run are stuck in a way a person could clear.
 *
 * ⛔ Used to decide whether the finish screen offers "try again" at all. A screen
 * that offers an action which cannot do anything is worse than one that offers none.
 */
export function retryableCount(states: PhoneState[]): number {
  return states.filter((s) => s !== "REGISTERED" && isTerminal(s)).length;
}

/**
 * The reset history a newly discovered row should INHERIT.
 *
 * ⛔⛔ THIS IS WHY A FRESH RUN IS SAFE. "One live run per customer" exists because two
 * runs would each believe they owned the reset counters, and a phone would get wiped
 * twice. That reasoning is sound and it had a cost: because a run is never closed,
 * a customer's run stays open forever and every stale state in it stays with them —
 * which is precisely how a halt written before a fix survived the fix.
 *
 * Carrying the count forward by hardware address removes the reason to keep runs open:
 * a new run may start, and a handset that has already been wiped once still knows it.
 */
export function inheritedResetCount(priorCountsForMac: number[]): number {
  let max = 0;
  for (const n of priorCountsForMac) {
    const v = Number(n);
    if (Number.isFinite(v) && v > max) max = Math.floor(v);
  }
  return max;
}
