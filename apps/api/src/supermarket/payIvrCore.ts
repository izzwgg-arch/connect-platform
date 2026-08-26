/**
 * Pay-by-phone IVR core — the pure state machine behind the Gesheft payment line.
 *
 * The whole call flow Izzy specced lives here as a reducer:
 *   caller-ID match → no PIN keyed (the stored, enrolled PIN is supplied
 *   silently by the runtime); foreign/unknown number → account lookup by keyed
 *   phone number, then PIN required. Main menu: 1 = balance, 2 = payment —
 *   the SAME keys everywhere. Amounts are keyed with * as the decimal point.
 *
 * Safety rails (from the approved plan — non-negotiable):
 * - ⛔ Stored cards only. There is NO state in this machine that collects card
 *   digits, and there must never be one (dtmf-masking-cannot-be-self-administered).
 * - ⛔ Amounts are CONFIRMED back before charging, and a charge happens only as
 *   an explicit `charge` effect the runtime performs ONCE per confirmation with
 *   an idempotent externalId. The reducer can never emit two charge effects
 *   without a fresh confirmation in between (stress-tested property).
 * - ⛔ Attempt caps everywhere (PIN 3, amount 3, lookup 3, confirm 3) — a
 *   stolen-card tester can't hammer the line; the cap lands on a human
 *   (20_connect_person), never a loop.
 * - ⛔ Refunds are impossible through their api; nothing here offers one.
 *
 * Prompts are the file names of the two shipped voice sets (Stephen/Kristen —
 * identical names), spliced with payAmount.amountToPromptRefs so the amount is
 * read in the same voice. This module never renders text at call time.
 *
 * Pure: no imports beyond payAmount, no IO, no Date. The runtime owns the DB
 * row, the POS client, and the clock.
 */

import { amountToPromptRefs, parseStarDecimalAmount, PAY_MAX_CENTS } from "./payAmount";

export const PAY_MAX_PIN_ATTEMPTS = 3;
export const PAY_MAX_AMOUNT_ATTEMPTS = 3;
export const PAY_MAX_LOOKUP_ATTEMPTS = 3;
export const PAY_MAX_CONFIRM_ROUNDS = 3;
export const PAY_MAX_CHARGES_PER_CALL = 3;

export type PayIvrPhase =
  | "start"
  | "pin_entry"
  | "lookup_entry"
  | "main_menu"
  | "after_balance_menu"
  | "amount_entry"
  | "confirm"
  | "charging"
  | "human"
  | "done";

export type PayIvrState = {
  phase: PayIvrPhase;
  /** POS customer id once resolved; null until lookup succeeds. */
  posCustomerId: string | null;
  /** True once a PIN (keyed or stored) has been accepted by the POS. */
  pinVerified: boolean;
  /** The PIN currently in force for POS calls. Never appears in prompts. */
  activePin: string | null;
  /** Whether activePin came from the enrolled store (silent) vs keyed. */
  pinFromStore: boolean;
  /** True only when the caller's own caller-ID matched the account — the ONLY case a keyed PIN may be enrolled. */
  callerIdMatched: boolean;
  pinAttempts: number;
  amountAttempts: number;
  lookupAttempts: number;
  confirmRounds: number;
  /** Amount pending confirmation, cents. */
  pendingCents: number | null;
  /** Count of confirmed charges this call — drives the externalId sequence. */
  chargeSeq: number;
  /** Total actually charged this call, cents. */
  chargedCents: number;
  lastBalanceCents: number | null;
};

export type PayIvrEffect =
  | { kind: "lookup_by_phone"; phone10: string }
  | { kind: "verify_pin"; pin: string }
  | { kind: "read_balance" }
  | { kind: "charge"; amountCents: number; chargeSeq: number }
  | { kind: "enroll_pin"; pin: string }
  | { kind: "transfer_to_person" }
  | { kind: "hangup" };

export type PayIvrGather = {
  /** What the runtime should collect next. */
  what: "pin" | "phone" | "menu" | "amount" | "confirm";
  maxDigits: number;
  /** '#' always terminates; '*' is data only in amount entry. */
  starIsData: boolean;
};

export type PayIvrOutput = {
  state: PayIvrState;
  prompts: string[];
  gather: PayIvrGather | null;
  effects: PayIvrEffect[];
};

export type PayIvrEvent =
  | { type: "call_start"; callerKnown: boolean; hasStoredPin: boolean; storedPin?: string }
  | { type: "digits"; value: string }
  | { type: "lookup_result"; found: boolean; posCustomerId?: string }
  | { type: "pin_result"; ok: boolean; balanceCents?: number }
  | { type: "balance_result"; ok: boolean; balanceCents?: number }
  | {
      type: "charge_result";
      outcome: "approved" | "declined" | "no_card" | "duplicate" | "error";
      newBalanceCents?: number;
    }
  | { type: "hangup" };

export function initialPayIvrState(): PayIvrState {
  return {
    phase: "start",
    posCustomerId: null,
    pinVerified: false,
    activePin: null,
    pinFromStore: false,
    callerIdMatched: false,
    pinAttempts: 0,
    amountAttempts: 0,
    lookupAttempts: 0,
    confirmRounds: 0,
    pendingCents: null,
    chargeSeq: 0,
    chargedCents: 0,
    lastBalanceCents: null,
  };
}

const G: Record<string, PayIvrGather> = {
  pin: { what: "pin", maxDigits: 8, starIsData: false },
  phone: { what: "phone", maxDigits: 10, starIsData: false },
  menu: { what: "menu", maxDigits: 1, starIsData: false },
  amount: { what: "amount", maxDigits: 9, starIsData: true },
  confirm: { what: "confirm", maxDigits: 1, starIsData: false },
};

function out(state: PayIvrState, prompts: string[], gather: PayIvrGather | null, effects: PayIvrEffect[] = []): PayIvrOutput {
  return { state, prompts, gather, effects };
}

function toHuman(state: PayIvrState, prompts: string[]): PayIvrOutput {
  return out({ ...state, phase: "human" }, [...prompts, "20_connect_person"], null, [{ kind: "transfer_to_person" }]);
}

function mainMenu(state: PayIvrState, lead: string[] = []): PayIvrOutput {
  return out({ ...state, phase: "main_menu" }, [...lead, "22_main_menu"], G.menu);
}

function afterBalanceMenu(state: PayIvrState, lead: string[]): PayIvrOutput {
  return out({ ...state, phase: "after_balance_menu" }, [...lead, "21_menu_after_balance"], G.menu);
}

/**
 * The reducer. Given the current state and an event, returns the next state,
 * the prompt refs to play, what to gather next, and the effects the runtime
 * must perform. Unknown/impossible events in a phase are ignored gracefully
 * (replay the phase's gather) — a stray DTMF or a duplicated webhook must
 * never advance money state.
 */
export function reducePayIvr(state: PayIvrState, event: PayIvrEvent): PayIvrOutput {
  if (event.type === "hangup") {
    return out({ ...state, phase: "done" }, [], null);
  }

  switch (state.phase) {
    case "start": {
      if (event.type !== "call_start") return out(state, [], null);
      if (!event.callerKnown) {
        return out({ ...state, phase: "lookup_entry" }, ["01_welcome", "13_not_recognized"], G.phone);
      }
      const matched = { ...state, callerIdMatched: true };
      if (event.hasStoredPin && event.storedPin) {
        // Silent verification with the enrolled PIN — the caller keys nothing.
        return out(
          { ...matched, phase: "pin_entry", activePin: event.storedPin, pinFromStore: true },
          ["01_welcome"],
          null,
          [{ kind: "verify_pin", pin: event.storedPin }],
        );
      }
      return out({ ...matched, phase: "pin_entry" }, ["01_welcome", "02_pin"], G.pin);
    }

    case "lookup_entry": {
      if (event.type === "digits") {
        const digits = event.value.replace(/\D/g, "");
        if (digits.length !== 10) {
          const attempts = state.lookupAttempts + 1;
          if (attempts >= PAY_MAX_LOOKUP_ATTEMPTS) return toHuman({ ...state, lookupAttempts: attempts }, ["19_lookup_not_found"]);
          return out({ ...state, lookupAttempts: attempts }, ["19_lookup_not_found", "13_not_recognized"], G.phone);
        }
        return out(state, [], null, [{ kind: "lookup_by_phone", phone10: digits }]);
      }
      if (event.type === "lookup_result") {
        if (!event.found || !event.posCustomerId) {
          const attempts = state.lookupAttempts + 1;
          if (attempts >= PAY_MAX_LOOKUP_ATTEMPTS) return toHuman({ ...state, lookupAttempts: attempts }, ["19_lookup_not_found"]);
          return out({ ...state, lookupAttempts: attempts }, ["19_lookup_not_found", "13_not_recognized"], G.phone);
        }
        // ⛔ A looked-up account is a FOREIGN number by definition: PIN always
        // keyed, never enrolled, never read from the store.
        return out(
          { ...state, phase: "pin_entry", posCustomerId: event.posCustomerId, callerIdMatched: false },
          ["02_pin"],
          G.pin,
        );
      }
      return out(state, [], G.phone);
    }

    case "pin_entry": {
      if (event.type === "digits") {
        const pin = event.value.replace(/[^0-9]/g, "");
        if (pin.length < 1 || pin.length > 8) {
          const attempts = state.pinAttempts + 1;
          if (attempts >= PAY_MAX_PIN_ATTEMPTS) return toHuman({ ...state, pinAttempts: attempts }, ["15_too_many_tries"]);
          return out({ ...state, pinAttempts: attempts }, ["03_pin_wrong", "02_pin"], G.pin);
        }
        return out({ ...state, activePin: pin, pinFromStore: false }, [], null, [{ kind: "verify_pin", pin }]);
      }
      if (event.type === "pin_result") {
        if (event.ok) {
          const next: PayIvrState = {
            ...state,
            pinVerified: true,
            lastBalanceCents: typeof event.balanceCents === "number" ? event.balanceCents : state.lastBalanceCents,
          };
          const effects: PayIvrEffect[] = [];
          // Enrollment: ONLY a keyed PIN, ONLY when this very call's caller-ID
          // matched the account. A stored PIN is already enrolled; a looked-up
          // account (foreign number) must never be enrolled.
          if (!state.pinFromStore && state.callerIdMatched && state.activePin) {
            effects.push({ kind: "enroll_pin", pin: state.activePin });
          }
          const res = mainMenu(next);
          return { ...res, effects: [...effects, ...res.effects] };
        }
        // Stored PIN refused → the enrollment is stale; fall back to keying.
        if (state.pinFromStore) {
          return out(
            { ...state, activePin: null, pinFromStore: false },
            ["02_pin"],
            G.pin,
          );
        }
        const attempts = state.pinAttempts + 1;
        if (attempts >= PAY_MAX_PIN_ATTEMPTS) return toHuman({ ...state, pinAttempts: attempts, activePin: null }, ["15_too_many_tries"]);
        return out({ ...state, pinAttempts: attempts, activePin: null }, ["03_pin_wrong", "02_pin"], G.pin);
      }
      return out(state, [], state.activePin ? null : G.pin);
    }

    case "main_menu":
    case "after_balance_menu": {
      if (event.type === "digits") {
        const key = event.value.trim();
        if (key === "1") return out(state, [], null, [{ kind: "read_balance" }]);
        if (key === "2") {
          return out({ ...state, phase: "amount_entry", amountAttempts: 0 }, ["05_amount_prompt"], G.amount);
        }
        // Anything else: repeat the menu of the phase we're in.
        return state.phase === "main_menu" ? mainMenu(state, ["14_invalid_amount"].slice(0, 0)) : afterBalanceMenu(state, []);
      }
      if (event.type === "balance_result") {
        if (!event.ok || typeof event.balanceCents !== "number") {
          return toHuman(state, []);
        }
        const lead = ["04_balance_intro", ...amountToPromptRefs(Math.max(0, event.balanceCents))];
        return afterBalanceMenu({ ...state, lastBalanceCents: event.balanceCents }, lead);
      }
      return out(state, [], G.menu);
    }

    case "amount_entry": {
      if (event.type !== "digits") return out(state, [], G.amount);
      const parsed = parseStarDecimalAmount(event.value);
      if (!parsed.ok) {
        const attempts = state.amountAttempts + 1;
        if (attempts >= PAY_MAX_AMOUNT_ATTEMPTS) return toHuman({ ...state, amountAttempts: attempts }, ["14_invalid_amount"]);
        return out({ ...state, amountAttempts: attempts }, ["14_invalid_amount", "05_amount_prompt"], G.amount);
      }
      return out(
        { ...state, phase: "confirm", pendingCents: parsed.cents },
        ["06_confirm_intro", ...amountToPromptRefs(parsed.cents), "07_confirm_choice"],
        G.confirm,
      );
    }

    case "confirm": {
      if (event.type !== "digits") return out(state, [], G.confirm);
      const key = event.value.trim();
      if (key === "1" && state.pendingCents !== null) {
        const seq = state.chargeSeq + 1;
        if (seq > PAY_MAX_CHARGES_PER_CALL) return toHuman(state, []);
        return out(
          { ...state, phase: "charging", chargeSeq: seq },
          ["08_processing"],
          null,
          [{ kind: "charge", amountCents: state.pendingCents, chargeSeq: seq }],
        );
      }
      if (key === "2") {
        const rounds = state.confirmRounds + 1;
        if (rounds >= PAY_MAX_CONFIRM_ROUNDS) return toHuman({ ...state, confirmRounds: rounds }, []);
        return out(
          { ...state, phase: "amount_entry", confirmRounds: rounds, pendingCents: null },
          ["05_amount_prompt"],
          G.amount,
        );
      }
      return out(state, ["07_confirm_choice"], G.confirm);
    }

    case "charging": {
      if (event.type !== "charge_result") return out(state, [], null);
      const cleared: PayIvrState = { ...state, pendingCents: null };
      if (event.outcome === "approved" || event.outcome === "duplicate") {
        // duplicate = our externalId already landed (a retried webhook or a
        // replayed step) — the money moved exactly once; report it as done.
        const charged = cleared.chargedCents + (state.pendingCents ?? 0);
        const lead = ["09_approved_intro"];
        if (typeof event.newBalanceCents === "number") {
          lead.push(...amountToPromptRefs(Math.max(0, event.newBalanceCents)));
        }
        return afterBalanceMenu(
          { ...cleared, chargedCents: charged, lastBalanceCents: event.newBalanceCents ?? cleared.lastBalanceCents },
          lead,
        );
      }
      if (event.outcome === "no_card") {
        return toHuman(cleared, ["12_no_card"]);
      }
      if (event.outcome === "declined") {
        const attempts = cleared.amountAttempts + 1;
        if (attempts >= PAY_MAX_AMOUNT_ATTEMPTS) return toHuman({ ...cleared, amountAttempts: attempts }, ["11_declined"]);
        return out({ ...cleared, phase: "amount_entry", amountAttempts: attempts }, ["11_declined", "05_amount_prompt"], G.amount);
      }
      // error: their api unreachable / unexpected — a person, never a retry loop.
      return toHuman(cleared, []);
    }

    case "human":
    case "done":
      return out(state, [], null);
  }
}

/** Invariant helper for tests: how many charge effects a full event trace produced. */
export function countChargeEffects(outputs: PayIvrOutput[]): number {
  return outputs.reduce((n, o) => n + o.effects.filter((e) => e.kind === "charge").length, 0);
}

/** The amount cap restated for callers that build charges outside the reducer. */
export const PAY_IVR_MAX_CENTS = PAY_MAX_CENTS;
