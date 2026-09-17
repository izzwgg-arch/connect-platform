/**
 * Pay-by-phone IVR core — the pure state machine behind the Gesheft payment line.
 *
 * THE FLOW (Izzy, 2026-09-17 evening, final — replaces the caller-ID rule and
 * the one-time code of earlier that day):
 *   1. A caller whose number is on a register account is asked: "To make a
 *      payment or hear a balance on the account for the number you are calling
 *      from, press 1. For a different account, press 2." A caller whose number
 *      is on no account goes straight to "enter the phone number on the account".
 *   2. Press 1 → enter the PIN. Press 2 → enter the account's phone number, then
 *      the PIN. EVERY caller keys the PIN — the register (POS with Logic)
 *      demands X-Customer-Pin on every balance read and every charge, and
 *      nothing is enrolled or remembered.
 *   3. Then the menu: 1 = balance, 2 = payment (the same keys everywhere).
 *   ⛔ An account the register has NO PIN for cannot be served by anyone (every
 *      value and no value is refused identically — proven 2026-09-17, balance
 *      AND charge). Before a PIN is ever asked, a silent one-credit probe learns
 *      which case applies; a no-PIN account hears "this account does not have a
 *      PIN set up yet — visit the store to set one up" and lands on a person
 *      (blockedReason "pin_not_set", desk-visible). Only the store can set one.
 * Amounts are keyed with * as the decimal point.
 *
 * Safety rails (from the approved plan — non-negotiable):
 * - ⛔ Stored cards only. There is NO state in this machine that collects card
 *   digits, and there must never be one (dtmf-masking-cannot-be-self-administered).
 * - ⛔ Amounts are CONFIRMED back before charging, and a charge happens only as
 *   an explicit `charge` effect the runtime performs ONCE per confirmation with
 *   an idempotent externalId. The reducer can never emit two charge effects
 *   without a fresh confirmation in between (stress-tested property).
 * - ⛔ Attempt caps everywhere (PIN 3, amount 3, lookup 3, confirm 3, menu 3) —
 *   a stolen-card tester can't hammer the line; every cap lands on a human
 *   (20_connect_person), never a loop. The silent probe is not an attempt.
 * - ⛔ Refunds are impossible through their api; nothing here offers one.
 *
 * Prompts are the file names of the shipped voice set (Stephen neural), spliced
 * with payAmount's number refs so amounts are read in the same voice. This
 * module never renders text at call time.
 *
 * Pure: no imports beyond payAmount, no IO, no Date. The runtime owns the DB
 * row, the POS client and the clock.
 */

import { amountToPromptRefs, parseStarDecimalAmount, PAY_MAX_CENTS } from "./payAmount";

export const PAY_MAX_PIN_ATTEMPTS = 3;
export const PAY_MAX_AMOUNT_ATTEMPTS = 3;
export const PAY_MAX_LOOKUP_ATTEMPTS = 3;
export const PAY_MAX_CONFIRM_ROUNDS = 3;
export const PAY_MAX_CHARGES_PER_CALL = 3;
/** Wrong/empty answers to "your account or a different one?" before a person. */
export const PAY_MAX_CHOICE_ATTEMPTS = 3;

/**
 * The sentinel the runtime sends to make the register say WHICH refusal
 * applies ("required" = no PIN on the account, "invalid" = there is one) before
 * a caller is asked to key anything. A lucky hit is never trusted: the caller
 * still keys the PIN.
 */
export const PAY_PROBE_PIN = "0";

export type PayIvrPhase =
  | "start"
  | "choose_account"
  | "lookup_entry"
  | "pin_entry"
  | "main_menu"
  | "after_balance_menu"
  | "amount_entry"
  | "confirm"
  | "card_entry"
  | "card_save_choice"
  | "card_offer"
  | "charging"
  | "human"
  | "done";

/** How a keyed card is used: this payment only, or stored on the account first. */
export type PayCardMode = "once" | "save";
/** Times the AGI collector may be (re)started per call before a person. */
export const PAY_MAX_CARD_ENTRY_ATTEMPTS = 2;

/** Why the register refused the PIN — mirrors posWithLogic.PosPinRefusal. */
export type PayPinReason = "not_set" | "invalid" | "unknown";

export type PayIvrState = {
  phase: PayIvrPhase;
  /** POS customer id once resolved; null until lookup succeeds. */
  posCustomerId: string | null;
  /** The account the caller's own number is on, if any (kept when they pick "a different one"). */
  callerAccountId: string | null;
  /** True once a keyed PIN has been accepted by the POS. */
  pinVerified: boolean;
  /** The PIN currently in force for POS calls. Never appears in prompts. */
  activePin: string | null;
  /** Whether activePin is the silent probe sentinel. */
  pinProbe: boolean;
  /** True when the account being served is the caller's own (they pressed 1). */
  callerIdMatched: boolean;
  /** What the register said about the account's PIN, once probed. */
  accountPinState: "unknown" | "set" | "not_set";
  /** Set when the line cannot serve this account. Desk-visible. */
  blockedReason: "pin_not_set" | null;
  choiceAttempts: number;
  pinAttempts: number;
  amountAttempts: number;
  lookupAttempts: number;
  confirmRounds: number;
  /** A keyed card is in play for the next charge (the card itself lives in payCardVault, never here). */
  cardMode: PayCardMode | null;
  /** Last four of the keyed card — the only card-derived value allowed in this state. */
  cardLast4: string | null;
  cardEntryAttempts: number;
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
  | { kind: "charge"; amountCents: number; chargeSeq: number; cardMode: PayCardMode | null }
  | { kind: "transfer_to_person" }
  | { kind: "hangup" };

export type PayIvrGather = {
  /** What the runtime should collect next. "card" = the dialplan runs the AGI collector (digits never pass through a step). */
  what: "choice" | "pin" | "phone" | "menu" | "amount" | "confirm" | "card";
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
  | { type: "call_start"; callerKnown: boolean; callerAccountId?: string }
  | { type: "digits"; value: string }
  | { type: "lookup_result"; found: boolean; posCustomerId?: string }
  | { type: "pin_result"; ok: boolean; balanceCents?: number; reason?: PayPinReason }
  | { type: "balance_result"; ok: boolean; balanceCents?: number }
  /** The AGI collector finished: a valid card is in the vault (ok) or the caller gave up. */
  | { type: "card_entered"; ok: boolean; last4?: string }
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
    callerAccountId: null,
    pinVerified: false,
    activePin: null,
    pinProbe: false,
    callerIdMatched: false,
    accountPinState: "unknown",
    blockedReason: null,
    choiceAttempts: 0,
    pinAttempts: 0,
    amountAttempts: 0,
    lookupAttempts: 0,
    confirmRounds: 0,
    cardMode: null,
    cardLast4: null,
    cardEntryAttempts: 0,
    pendingCents: null,
    chargeSeq: 0,
    chargedCents: 0,
    lastBalanceCents: null,
  };
}

const PHASES: PayIvrPhase[] = [
  "start",
  "choose_account",
  "lookup_entry",
  "pin_entry",
  "main_menu",
  "after_balance_menu",
  "amount_entry",
  "confirm",
  "card_entry",
  "card_save_choice",
  "card_offer",
  "charging",
  "human",
  "done",
];

/**
 * Rows persisted by earlier shapes of this machine (the 09-17 morning/afternoon
 * ones carried code/vault fields and phases this machine no longer has) are read
 * as their zero values; an unknown phase becomes "human" so a half-finished call
 * from an older shape ends at a person, never in a loop.
 */
export function normalizePayIvrState(raw: unknown): PayIvrState {
  const base = initialPayIvrState();
  if (!raw || typeof raw !== "object") return base;
  const s = raw as Partial<PayIvrState> & Record<string, unknown>;
  const num = (v: unknown) => (Number.isInteger(v) ? (v as number) : 0);
  return {
    ...base,
    phase: PHASES.includes(s.phase as PayIvrPhase) ? (s.phase as PayIvrPhase) : "human",
    posCustomerId: typeof s.posCustomerId === "string" ? s.posCustomerId : null,
    callerAccountId: typeof s.callerAccountId === "string" ? s.callerAccountId : null,
    pinVerified: s.pinVerified === true,
    activePin: typeof s.activePin === "string" ? s.activePin : null,
    pinProbe: s.pinProbe === true,
    callerIdMatched: s.callerIdMatched === true,
    accountPinState: s.accountPinState === "set" || s.accountPinState === "not_set" ? s.accountPinState : "unknown",
    blockedReason: s.blockedReason === "pin_not_set" ? "pin_not_set" : null,
    choiceAttempts: num(s.choiceAttempts),
    pinAttempts: num(s.pinAttempts),
    amountAttempts: num(s.amountAttempts),
    lookupAttempts: num(s.lookupAttempts),
    confirmRounds: num(s.confirmRounds),
    cardMode: s.cardMode === "once" || s.cardMode === "save" ? s.cardMode : null,
    cardLast4: typeof s.cardLast4 === "string" ? s.cardLast4.replace(/\D/g, "").slice(-4) : null,
    cardEntryAttempts: num(s.cardEntryAttempts),
    pendingCents: Number.isInteger(s.pendingCents) ? (s.pendingCents as number) : null,
    chargeSeq: num(s.chargeSeq),
    chargedCents: num(s.chargedCents),
    lastBalanceCents: Number.isInteger(s.lastBalanceCents) ? (s.lastBalanceCents as number) : null,
  };
}

const G: Record<string, PayIvrGather> = {
  choice: { what: "choice", maxDigits: 1, starIsData: false },
  pin: { what: "pin", maxDigits: 8, starIsData: false },
  phone: { what: "phone", maxDigits: 10, starIsData: false },
  menu: { what: "menu", maxDigits: 1, starIsData: false },
  amount: { what: "amount", maxDigits: 9, starIsData: true },
  confirm: { what: "confirm", maxDigits: 1, starIsData: false },
  card: { what: "card", maxDigits: 0, starIsData: false },
};

/**
 * Hand the caller to the AGI card collector. The dialplan plays nothing of
 * ours first (the AGI voices its own prompts) and the digits never come back
 * through a step: the AGI posts them to the card door, which raises
 * `card_entered`. Re-entered at most PAY_MAX_CARD_ENTRY_ATTEMPTS times.
 */
function cardEntry(state: PayIvrState, lead: string[] = []): PayIvrOutput {
  const attempts = state.cardEntryAttempts + 1;
  if (attempts > PAY_MAX_CARD_ENTRY_ATTEMPTS) return toHuman(state, []);
  return out({ ...state, phase: "card_entry", cardEntryAttempts: attempts, cardMode: null, cardLast4: null }, lead, G.card);
}

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

/** "Your account, or a different one?" — only a caller whose number is on an account hears it. */
function chooseAccount(state: PayIvrState, lead: string[] = []): PayIvrOutput {
  return out({ ...state, phase: "choose_account" }, [...lead, "37_which_account"], G.choice);
}

/** "Enter the phone number on the account" — for a stranger (13) or a caller who chose a different account (38). */
function askPhone(state: PayIvrState, prompts: string[]): PayIvrOutput {
  return out({ ...state, phase: "lookup_entry" }, prompts, G.phone);
}

/** The register can never serve this account: no PIN exists in the POS. Say where to fix it, then a person. */
function blockedNoPin(state: PayIvrState): PayIvrOutput {
  return toHuman(
    { ...state, activePin: null, pinProbe: false, accountPinState: "not_set", blockedReason: "pin_not_set" },
    ["36_no_pin_visit_store"],
  );
}

/** Silent probe: makes the register classify the account before anyone keys a PIN. */
function probe(state: PayIvrState, posCustomerId: string, own: boolean): PayIvrOutput {
  return out(
    { ...state, phase: "pin_entry", posCustomerId, callerIdMatched: own, activePin: PAY_PROBE_PIN, pinProbe: true, pinAttempts: 0 },
    [],
    null,
    [{ kind: "verify_pin", pin: PAY_PROBE_PIN }],
  );
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
      if (event.callerKnown && event.callerAccountId) {
        return chooseAccount({ ...state, callerAccountId: event.callerAccountId }, ["01_welcome"]);
      }
      return askPhone(state, ["01_welcome", "13_not_recognized"]);
    }

    case "choose_account": {
      if (event.type !== "digits") return out(state, [], G.choice);
      const key = event.value.trim();
      if (key === "1" && state.callerAccountId) return probe(state, state.callerAccountId, true);
      if (key === "2") return askPhone(state, ["38_enter_phone"]);
      const attempts = state.choiceAttempts + 1;
      if (attempts >= PAY_MAX_CHOICE_ATTEMPTS) return toHuman({ ...state, choiceAttempts: attempts }, []);
      return chooseAccount({ ...state, choiceAttempts: attempts });
    }

    case "lookup_entry": {
      if (event.type === "digits") {
        const raw = event.value.replace(/\D/g, "");
        // Izzy, 2026-08-26: "the area code is always 845" — seven digits are accepted.
        const digits = raw.length === 7 ? `845${raw}` : raw.length === 11 && raw.startsWith("1") ? raw.slice(1) : raw;
        if (digits.length !== 10) {
          const attempts = state.lookupAttempts + 1;
          if (attempts >= PAY_MAX_LOOKUP_ATTEMPTS) return toHuman({ ...state, lookupAttempts: attempts }, ["19_lookup_not_found"]);
          return askPhone({ ...state, lookupAttempts: attempts }, ["19_lookup_not_found", "38_enter_phone"]);
        }
        return out(state, [], null, [{ kind: "lookup_by_phone", phone10: digits }]);
      }
      if (event.type === "lookup_result") {
        if (!event.found || !event.posCustomerId) {
          const attempts = state.lookupAttempts + 1;
          if (attempts >= PAY_MAX_LOOKUP_ATTEMPTS) return toHuman({ ...state, lookupAttempts: attempts }, ["19_lookup_not_found"]);
          return askPhone({ ...state, lookupAttempts: attempts }, ["19_lookup_not_found", "38_enter_phone"]);
        }
        // The account may be the caller's own (they keyed their own number): that
        // is still "a keyed account" — the PIN is asked either way.
        return probe(state, event.posCustomerId, event.posCustomerId === state.callerAccountId);
      }
      return out(state, [], G.phone);
    }

    case "pin_entry": {
      if (event.type === "digits") {
        // The silent probe is in flight — digits cannot belong to it.
        if (state.pinProbe) return out(state, [], null);
        const pin = event.value.replace(/[^0-9]/g, "");
        if (pin.length < 1 || pin.length > 8) {
          const attempts = state.pinAttempts + 1;
          if (attempts >= PAY_MAX_PIN_ATTEMPTS) return toHuman({ ...state, pinAttempts: attempts }, ["15_too_many_tries"]);
          return out({ ...state, pinAttempts: attempts }, ["03_pin_wrong", "02_pin"], G.pin);
        }
        return out({ ...state, activePin: pin, pinProbe: false }, [], null, [{ kind: "verify_pin", pin }]);
      }
      if (event.type === "pin_result") {
        // ⛔ "PIN required" = the POS has NO PIN for this account. Nothing any
        // caller keys can pass; asking would be theatre.
        if (event.reason === "not_set") return blockedNoPin(state);
        if (state.pinProbe) {
          // The probe only classifies. Served or "invalid", the caller keys the PIN.
          return out({ ...state, activePin: null, pinProbe: false, accountPinState: "set" }, ["02_pin"], G.pin);
        }
        if (event.ok) {
          const next: PayIvrState = {
            ...state,
            pinVerified: true,
            accountPinState: "set",
            lastBalanceCents: typeof event.balanceCents === "number" ? event.balanceCents : state.lastBalanceCents,
          };
          return mainMenu(next);
        }
        const attempts = state.pinAttempts + 1;
        if (attempts >= PAY_MAX_PIN_ATTEMPTS) return toHuman({ ...state, pinAttempts: attempts, activePin: null }, ["15_too_many_tries"]);
        return out({ ...state, pinAttempts: attempts, activePin: null, accountPinState: "set" }, ["03_pin_wrong", "02_pin"], G.pin);
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
        return state.phase === "main_menu" ? mainMenu(state) : afterBalanceMenu(state, []);
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
        ["06_confirm_intro", ...amountToPromptRefs(parsed.cents), "39_confirm_choice_card"],
        G.confirm,
      );
    }

    case "confirm": {
      if (event.type !== "digits") return out(state, [], G.confirm);
      const key = event.value.trim();
      if (key === "1" && state.pendingCents !== null) return startCharge(state, null);
      if (key === "2") {
        const rounds = state.confirmRounds + 1;
        if (rounds >= PAY_MAX_CONFIRM_ROUNDS) return toHuman({ ...state, confirmRounds: rounds }, []);
        return out(
          { ...state, phase: "amount_entry", confirmRounds: rounds, pendingCents: null },
          ["05_amount_prompt"],
          G.amount,
        );
      }
      // "pay with a different card" — Izzy, 2026-09-17 night.
      if (key === "3" && state.pendingCents !== null) return cardEntry(state);
      return out(state, ["39_confirm_choice_card"], G.confirm);
    }

    case "card_entry": {
      if (event.type === "card_entered") {
        if (!event.ok) return toHuman({ ...state, cardMode: null, cardLast4: null }, ["45_card_invalid"]);
        return out(
          { ...state, phase: "card_save_choice", cardLast4: String(event.last4 ?? "").replace(/\D/g, "").slice(-4) || null },
          ["46_card_save_choice"],
          G.menu,
        );
      }
      // A step arrived while the collector was expected to run (it did not reach
      // the card door, or the dialplan came back early): run it again, bounded.
      if (event.type === "digits") return cardEntry(state);
      return out(state, [], G.card);
    }

    case "card_save_choice": {
      if (event.type !== "digits") return out(state, [], G.menu);
      const key = event.value.trim();
      if (key === "1" && state.pendingCents !== null) return startCharge(state, "once");
      if (key === "2" && state.pendingCents !== null) return startCharge(state, "save");
      return out(state, ["46_card_save_choice"], G.menu);
    }

    case "card_offer": {
      if (event.type !== "digits") return out(state, [], G.menu);
      const key = event.value.trim();
      if (key === "1" && state.pendingCents !== null) return cardEntry(state);
      return toHuman(state, []);
    }

    case "charging": {
      if (event.type !== "charge_result") return out(state, [], null);
      const keyed = state.cardMode !== null;
      const cleared: PayIvrState = { ...state, pendingCents: null, cardMode: null };
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
        // No card on file: offer to key one for THIS amount (the amount is kept).
        return out({ ...state, cardMode: null, phase: "card_offer" }, ["12_no_card", "40_card_offer"], G.menu);
      }
      if (event.outcome === "declined") {
        if (keyed) {
          // The keyed card was refused: another card, or a person. Amount kept.
          return out({ ...state, cardMode: null, phase: "card_offer" }, ["11_declined", "47_card_declined_offer"], G.menu);
        }
        const attempts = cleared.amountAttempts + 1;
        if (attempts >= PAY_MAX_AMOUNT_ATTEMPTS) return toHuman({ ...cleared, amountAttempts: attempts }, ["11_declined"]);
        return out({ ...cleared, phase: "amount_entry", amountAttempts: attempts }, ["11_declined", "05_amount_prompt"], G.amount);
      }
      // error: their api unreachable / unexpected — a person, never a retry loop.
      return toHuman(cleared, []);
    }

    case "human":
      // A step after the hand-off (e.g. the dialplan returning from the AGI
      // collector) must land on the person again, never sit in a silent loop.
      return out(state, [], null, [{ kind: "transfer_to_person" }]);
    case "done":
      return out(state, [], null);
  }
}

/** One confirmed charge: card on file (cardMode null) or the keyed card, once or saved first. */
function startCharge(state: PayIvrState, cardMode: PayCardMode | null): PayIvrOutput {
  if (state.pendingCents === null) return toHuman(state, []);
  const seq = state.chargeSeq + 1;
  if (seq > PAY_MAX_CHARGES_PER_CALL) return toHuman(state, []);
  return out(
    { ...state, phase: "charging", chargeSeq: seq, cardMode },
    ["08_processing"],
    null,
    [{ kind: "charge", amountCents: state.pendingCents, chargeSeq: seq, cardMode }],
  );
}

/** Invariant helper for tests: how many charge effects a full event trace produced. */
export function countChargeEffects(outputs: PayIvrOutput[]): number {
  return outputs.reduce((n, o) => n + o.effects.filter((e) => e.kind === "charge").length, 0);
}

/** The amount cap restated for callers that build charges outside the reducer. */
export const PAY_IVR_MAX_CENTS = PAY_MAX_CENTS;
