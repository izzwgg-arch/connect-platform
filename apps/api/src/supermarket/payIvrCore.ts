/**
 * Pay-by-phone IVR core — the pure state machine behind the Gesheft payment line.
 *
 * THE RULES (Izzy, 2026-08-25; restated in full 2026-09-17 after his 3064 call
 * was asked for a PIN):
 *   1. Caller-ID matches an account → they can pay. NO PIN IS EVER ASKED. The
 *      register (POS with Logic) still demands X-Customer-Pin on every balance
 *      read and every charge (proven again 2026-09-17: a charge on a no-PIN
 *      account is refused "Customer PIN required." with or without a header),
 *      so the runtime supplies it SILENTLY — the enrolled PIN if Loopcom holds
 *      one, else a one-credit probe that makes the register say which case
 *      applies. A matched caller whose own account cannot be served (no POS
 *      PIN, or a PIN Loopcom does not hold) is asked for the phone number of
 *      the account they want to pay or hear the balance on (Izzy, 09-17
 *      evening) and continues down rules 2–4 — `ownAccountBlocked` records why
 *      for the desk (the Orders screen "Phone PIN" enrols it and the next call
 *      is silent). ⛔ `matchedPinPolicy:
 *      "ask_once"` keeps the pre-09-17 behaviour (ask once, enroll, silent after)
 *      — it is an operator switch, never the default.
 *   2. Caller-ID unknown → the caller keys the phone number on the account.
 *   3. Account found → "enter your PIN, or press star if you do not have one".
 *      A keyed PIN is verified by the register and NEVER enrolled (a foreign
 *      number is exactly what the PIN protects against).
 *   4. Star → a one-time 6-digit code, delivered by PHONE CALL (an outbound call
 *      in the same recorded voice) or by TEXT, ONLY to a number on the account;
 *      the caller picks which number by its last four digits. A correct code
 *      proves the caller controls a number on the account, so they are served
 *      exactly like a matched caller (silent enrolled PIN, else a person).
 *   ⛔ An account the register has NO PIN for cannot be served by anyone —
 *      every value and no value is refused identically — so the line hands such
 *      a caller to a person AT ONCE (blockedReason "pin_not_set"), never after a
 *      futile PIN or code. Only the store can set a PIN in the POS.
 * Main menu: 1 = balance, 2 = payment — the SAME keys everywhere. Amounts are
 * keyed with * as the decimal point.
 *
 * Safety rails (from the approved plan — non-negotiable):
 * - ⛔ Stored cards only. There is NO state in this machine that collects card
 *   digits, and there must never be one (dtmf-masking-cannot-be-self-administered).
 * - ⛔ Amounts are CONFIRMED back before charging, and a charge happens only as
 *   an explicit `charge` effect the runtime performs ONCE per confirmation with
 *   an idempotent externalId. The reducer can never emit two charge effects
 *   without a fresh confirmation in between (stress-tested property).
 * - ⛔ Attempt caps everywhere (PIN 3, amount 3, lookup 3, confirm 3, code
 *   attempts 3, code sends 2, code waits 8) — a stolen-card tester can't hammer
 *   the line and a text flood is bounded per call; every cap lands on a human
 *   (20_connect_person), never a loop. A silent probe is not an attempt.
 * - ⛔ The code itself never enters this machine: the runtime hashes it, stores
 *   the hash in the session, and answers `code_result`. Full phone numbers are
 *   never spoken — only the last four digits.
 * - ⛔ Refunds are impossible through their api; nothing here offers one.
 *
 * Prompts are the file names of the shipped voice set (Stephen neural), spliced
 * with payAmount's number refs so amounts, last-four digits and codes are read
 * in the same voice. This module never renders text at call time.
 *
 * Pure: no imports beyond payAmount, no IO, no Date. The runtime owns the DB
 * row, the POS client, the code secret, the SMS sender and the clock.
 */

import { amountToPromptRefs, digitsToPromptRefs, parseStarDecimalAmount, PAY_MAX_CENTS } from "./payAmount";

export const PAY_MAX_PIN_ATTEMPTS = 3;
export const PAY_MAX_AMOUNT_ATTEMPTS = 3;
export const PAY_MAX_LOOKUP_ATTEMPTS = 3;
export const PAY_MAX_CONFIRM_ROUNDS = 3;
export const PAY_MAX_CHARGES_PER_CALL = 3;
/** Wrong one-time codes before a person. */
export const PAY_MAX_CODE_ATTEMPTS = 3;
/** One-time codes SENT per call (call or text) — the text-flood bound. */
export const PAY_MAX_CODE_SENDS = 2;
/** Empty reads while waiting for a code (≈10 s each) before a person. */
export const PAY_MAX_CODE_WAITS = 8;
/** Numbers offered for code delivery (press 1–4). */
export const PAY_MAX_CODE_NUMBERS = 4;
export const PAY_CODE_LENGTH = 6;

/**
 * The sentinel the runtime sends when a caller has no enrolled PIN to try.
 * It exists only to make the register say WHICH refusal applies ("required"
 * = no PIN on the account, "invalid" = there is one). For a MATCHED caller a
 * lucky hit simply serves the account — the outcome a matched caller wants.
 * For a FOREIGN caller a lucky hit is NOT trusted: they still key the PIN.
 */
export const PAY_PROBE_PIN = "0";

export type PayIvrPhase =
  | "start"
  | "pin_entry"
  | "lookup_entry"
  | "code_channel"
  | "code_number"
  | "code_entry"
  | "main_menu"
  | "after_balance_menu"
  | "amount_entry"
  | "confirm"
  | "charging"
  | "human"
  | "done";

/** Why the register refused the PIN — mirrors posWithLogic.PosPinRefusal. */
export type PayPinReason = "not_set" | "invalid" | "unknown";

/** What a matched caller gets when Loopcom does not hold the account's PIN. */
export type PayMatchedPinPolicy = "never" | "ask_once";

export type PayCodeChannel = "call" | "text";

export type PayIvrState = {
  phase: PayIvrPhase;
  /** POS customer id once resolved; null until lookup succeeds. */
  posCustomerId: string | null;
  /** True once a PIN (keyed, stored or probed) has been accepted by the POS. */
  pinVerified: boolean;
  /** The PIN currently in force for POS calls. Never appears in prompts. */
  activePin: string | null;
  /** Whether activePin came from the enrolled store (silent) vs keyed. */
  pinFromStore: boolean;
  /** Whether activePin is the silent probe sentinel. */
  pinProbe: boolean;
  /** True only when the caller's own caller-ID matched the account — the ONLY case a keyed PIN may be enrolled. */
  callerIdMatched: boolean;
  /** True once a one-time code delivered to a number on the account was keyed back correctly. */
  ownerVerified: boolean;
  /** What the register said about the account's PIN, once probed. */
  accountPinState: "unknown" | "set" | "not_set";
  /** The operator switch for matched callers with nothing enrolled (see header). */
  matchedPinPolicy: PayMatchedPinPolicy;
  /** Set when the line cannot serve this account. Desk-visible. */
  blockedReason: "pin_not_set" | "pin_not_enrolled" | null;
  /**
   * The caller-ID-matched account could not be served (Izzy, 09-17 evening:
   * "it should have asked me for the phone number in the account I want to
   * make a payment on, or hear balance"), so the caller was asked for another
   * account instead of a person. Desk-visible; the call goes on.
   */
  ownAccountBlocked: "pin_not_set" | "pin_not_enrolled" | null;
  pinAttempts: number;
  amountAttempts: number;
  lookupAttempts: number;
  confirmRounds: number;
  /** One-time code: how it is being delivered, to which of the account's numbers. */
  codeChannel: PayCodeChannel | null;
  /** Numbers on the account offered for delivery (10 digits each, ≤ PAY_MAX_CODE_NUMBERS). */
  codePhones: string[];
  codeSentTo: string | null;
  /** Opaque hash of the live code (runtime-owned) and its expiry, ms epoch. Never the code. */
  codeHash: string | null;
  codeExpiresAt: number | null;
  codeSends: number;
  codeAttempts: number;
  codeWaits: number;
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
  | { kind: "list_numbers" }
  | { kind: "send_code"; channel: PayCodeChannel; phone10: string }
  | { kind: "verify_code"; digits: string }
  | { kind: "transfer_to_person" }
  | { kind: "hangup" };

export type PayIvrGather = {
  /** What the runtime should collect next. */
  what: "pin" | "phone" | "menu" | "amount" | "confirm" | "code";
  maxDigits: number;
  /** '#' always terminates; '*' is data only in amount entry (and means "no PIN" / "resend" in pin/code entry). */
  starIsData: boolean;
};

export type PayIvrOutput = {
  state: PayIvrState;
  prompts: string[];
  gather: PayIvrGather | null;
  effects: PayIvrEffect[];
};

export type PayIvrEvent =
  | {
      type: "call_start";
      callerKnown: boolean;
      hasStoredPin: boolean;
      storedPin?: string;
      matchedPinPolicy?: PayMatchedPinPolicy;
    }
  | { type: "digits"; value: string }
  | { type: "lookup_result"; found: boolean; posCustomerId?: string }
  | { type: "pin_result"; ok: boolean; balanceCents?: number; reason?: PayPinReason }
  | { type: "numbers_result"; phones: string[] }
  | { type: "code_sent"; ok: boolean; codeHash?: string; expiresAt?: number }
  | { type: "code_result"; ok: boolean; reason?: "wrong" | "expired" | "none"; storedPin?: string }
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
    pinProbe: false,
    callerIdMatched: false,
    ownerVerified: false,
    accountPinState: "unknown",
    matchedPinPolicy: "never",
    blockedReason: null,
    ownAccountBlocked: null,
    pinAttempts: 0,
    amountAttempts: 0,
    lookupAttempts: 0,
    confirmRounds: 0,
    codeChannel: null,
    codePhones: [],
    codeSentTo: null,
    codeHash: null,
    codeExpiresAt: null,
    codeSends: 0,
    codeAttempts: 0,
    codeWaits: 0,
    pendingCents: null,
    chargeSeq: 0,
    chargedCents: 0,
    lastBalanceCents: null,
  };
}

/** Rows persisted before 2026-09-17 lack the newer fields; read them as their zero values. */
export function normalizePayIvrState(raw: unknown): PayIvrState {
  const base = initialPayIvrState();
  if (!raw || typeof raw !== "object") return base;
  const s = raw as Partial<PayIvrState>;
  return {
    ...base,
    ...s,
    pinProbe: s.pinProbe === true,
    ownerVerified: s.ownerVerified === true,
    accountPinState: s.accountPinState === "set" || s.accountPinState === "not_set" ? s.accountPinState : "unknown",
    matchedPinPolicy: s.matchedPinPolicy === "ask_once" ? "ask_once" : "never",
    blockedReason: s.blockedReason === "pin_not_set" || s.blockedReason === "pin_not_enrolled" ? s.blockedReason : null,
    ownAccountBlocked: s.ownAccountBlocked === "pin_not_set" || s.ownAccountBlocked === "pin_not_enrolled" ? s.ownAccountBlocked : null,
    codeChannel: s.codeChannel === "call" || s.codeChannel === "text" ? s.codeChannel : null,
    codePhones: Array.isArray(s.codePhones) ? s.codePhones.filter((p) => typeof p === "string") : [],
    codeSentTo: typeof s.codeSentTo === "string" ? s.codeSentTo : null,
    codeHash: typeof s.codeHash === "string" ? s.codeHash : null,
    codeExpiresAt: typeof s.codeExpiresAt === "number" ? s.codeExpiresAt : null,
    codeSends: Number.isInteger(s.codeSends) ? (s.codeSends as number) : 0,
    codeAttempts: Number.isInteger(s.codeAttempts) ? (s.codeAttempts as number) : 0,
    codeWaits: Number.isInteger(s.codeWaits) ? (s.codeWaits as number) : 0,
  };
}

const G: Record<string, PayIvrGather> = {
  pin: { what: "pin", maxDigits: 8, starIsData: false },
  phone: { what: "phone", maxDigits: 10, starIsData: false },
  menu: { what: "menu", maxDigits: 1, starIsData: false },
  amount: { what: "amount", maxDigits: 9, starIsData: true },
  confirm: { what: "confirm", maxDigits: 1, starIsData: false },
  code: { what: "code", maxDigits: PAY_CODE_LENGTH, starIsData: false },
};

/** The PIN prompt: a foreign caller is told about star; a matched caller under ask_once is not. */
function pinPrompt(state: PayIvrState): string {
  return state.callerIdMatched ? "02_pin" : "23_pin_or_star";
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

/**
 * A MATCHED caller whose own account cannot be served is not dead-ended on a
 * person (Izzy, 09-17 evening, calling from his cell on a no-PIN account: "it
 * should have asked me for the phone number in the account I want to make a
 * payment on, or hear balance"). They are asked for the account's phone number
 * and continue down the looked-up path (PIN or star), where any account with a
 * PIN can be served. Only once, and only the caller's OWN account: a looked-up
 * or owner-verified account that cannot be served still ends at a person.
 */
function redirectToLookup(state: PayIvrState, reason: "pin_not_set" | "pin_not_enrolled"): PayIvrOutput | null {
  if (!state.callerIdMatched || state.ownerVerified || state.ownAccountBlocked) return null;
  return out(
    {
      ...state,
      phase: "lookup_entry",
      posCustomerId: null,
      callerIdMatched: false,
      activePin: null,
      pinFromStore: false,
      pinProbe: false,
      pinVerified: false,
      accountPinState: "unknown",
      blockedReason: null,
      ownAccountBlocked: reason,
      lookupAttempts: 0,
    },
    ["34_enter_account_phone"],
    G.phone,
  );
}

/** The register can never serve this account: no PIN exists in the POS. Another account, or a person. */
function blockedNoPin(state: PayIvrState): PayIvrOutput {
  return (
    redirectToLookup(state, "pin_not_set") ??
    toHuman({ ...state, activePin: null, pinFromStore: false, pinProbe: false, accountPinState: "not_set", blockedReason: "pin_not_set" }, [])
  );
}

/** The account has a PIN that Loopcom does not hold, and this caller is never asked for it. Another account, or a person; the desk enrolls. */
function blockedNotEnrolled(state: PayIvrState): PayIvrOutput {
  return (
    redirectToLookup(state, "pin_not_enrolled") ??
    toHuman({ ...state, activePin: null, pinFromStore: false, pinProbe: false, accountPinState: "set", blockedReason: "pin_not_enrolled" }, [])
  );
}

/** Silent probe: makes the register classify the account without the caller keying anything. */
function probe(state: PayIvrState, prompts: string[]): PayIvrOutput {
  return out(
    { ...state, phase: "pin_entry", activePin: PAY_PROBE_PIN, pinFromStore: false, pinProbe: true },
    prompts,
    null,
    [{ kind: "verify_pin", pin: PAY_PROBE_PIN }],
  );
}

/** Silent verification with an enrolled PIN — the caller keys nothing. */
function silentVerify(state: PayIvrState, storedPin: string, prompts: string[]): PayIvrOutput {
  return out(
    { ...state, phase: "pin_entry", activePin: storedPin, pinFromStore: true, pinProbe: false },
    prompts,
    null,
    [{ kind: "verify_pin", pin: storedPin }],
  );
}

/** The code-delivery menu: call or text. */
function codeChannelMenu(state: PayIvrState, lead: string[] = []): PayIvrOutput {
  return out({ ...state, phase: "code_channel", codeChannel: null }, [...lead, "24_code_channel_menu"], G.menu);
}

/** "Press 1 for the number ending in 3 0 6 4. Press 2 for …" — last four digits only, ever. */
function codeNumberMenu(state: PayIvrState): PayIvrOutput {
  const prompts: string[] = ["25_code_number_intro"];
  state.codePhones.forEach((phone, i) => {
    prompts.push("26_press", `num_${i + 1}`, "27_for_number_ending_in", ...digitsToPromptRefs(phone.slice(-4)));
  });
  return out({ ...state, phase: "code_number" }, prompts, G.menu);
}

function sendCode(state: PayIvrState, channel: PayCodeChannel, phone10: string): PayIvrOutput {
  return out({ ...state, phase: "code_entry", codeChannel: channel, codeSentTo: phone10 }, [], null, [
    { kind: "send_code", channel, phone10 },
  ]);
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
      const policy: PayMatchedPinPolicy = event.matchedPinPolicy === "ask_once" ? "ask_once" : "never";
      if (!event.callerKnown) {
        return out({ ...state, matchedPinPolicy: policy, phase: "lookup_entry" }, ["01_welcome", "13_not_recognized"], G.phone);
      }
      const matched = { ...state, matchedPinPolicy: policy, callerIdMatched: true };
      if (event.hasStoredPin && event.storedPin) {
        return silentVerify(matched, event.storedPin, ["01_welcome"]);
      }
      // Nothing enrolled: still nothing keyed. The probe makes the register say
      // whether this account has a PIN at all (see PAY_PROBE_PIN).
      return probe(matched, ["01_welcome"]);
    }

    case "lookup_entry": {
      if (event.type === "digits") {
        const raw = event.value.replace(/\D/g, "");
        // Izzy, 2026-08-26: "the area code is always 845" — seven digits are accepted.
        const digits = raw.length === 7 ? `845${raw}` : raw.length === 11 && raw.startsWith("1") ? raw.slice(1) : raw;
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
        // ⛔ A looked-up account is a FOREIGN number by definition: the PIN is
        // always keyed, never enrolled, never read from the store. Before
        // asking, a silent probe learns whether the account HAS a PIN — an
        // account with none cannot be served by anyone, so the caller is not
        // sent through a PIN or a code that can never work.
        return probe({ ...state, posCustomerId: event.posCustomerId, callerIdMatched: false, ownerVerified: false }, []);
      }
      return out(state, [], G.phone);
    }

    case "pin_entry": {
      if (event.type === "digits") {
        // A silent verification is in flight — digits cannot belong to it.
        if (state.pinFromStore || state.pinProbe) return out(state, [], null);
        const value = event.value.trim();
        // Star = "I do not have a PIN" (foreign callers only; the prompt says so).
        if (!state.callerIdMatched && value.startsWith("*")) {
          return codeChannelMenu(state);
        }
        const pin = value.replace(/[^0-9]/g, "");
        if (pin.length < 1 || pin.length > 8) {
          const attempts = state.pinAttempts + 1;
          if (attempts >= PAY_MAX_PIN_ATTEMPTS) return toHuman({ ...state, pinAttempts: attempts }, ["15_too_many_tries"]);
          return out({ ...state, pinAttempts: attempts }, ["03_pin_wrong", pinPrompt(state)], G.pin);
        }
        return out({ ...state, activePin: pin, pinFromStore: false, pinProbe: false }, [], null, [{ kind: "verify_pin", pin }]);
      }
      if (event.type === "pin_result") {
        if (event.ok) {
          // A foreign caller's PROBE happening to pass proves nothing about
          // the caller: they still key the PIN. (A matched caller is served.)
          if (state.pinProbe && !state.callerIdMatched && !state.ownerVerified) {
            return out({ ...state, activePin: null, pinProbe: false, accountPinState: "set" }, [pinPrompt(state)], G.pin);
          }
          const next: PayIvrState = {
            ...state,
            pinVerified: true,
            pinProbe: false,
            accountPinState: "set",
            lastBalanceCents: typeof event.balanceCents === "number" ? event.balanceCents : state.lastBalanceCents,
          };
          const effects: PayIvrEffect[] = [];
          // Enrollment: ONLY when this very call's caller-ID matched the
          // account, and ONLY a keyed PIN (ask_once). A looked-up account —
          // even one whose owner keyed back a code — must never be enrolled.
          if (!state.pinFromStore && state.callerIdMatched && state.activePin) {
            effects.push({ kind: "enroll_pin", pin: state.activePin });
          }
          const res = mainMenu(next);
          return { ...res, effects: [...effects, ...res.effects] };
        }
        // ⛔ "PIN required" = the POS has NO PIN for this account. Nothing any
        // caller keys can pass; asking would be theatre. A person, at once,
        // and the desk learns why (blockedReason).
        if (event.reason === "not_set") return blockedNoPin(state);
        const known = { ...state, accountPinState: "set" as const };
        // A stored PIN refused → the enrollment is stale (the runtime purged
        // it). The caller is treated as having nothing enrolled.
        if (state.pinFromStore) {
          if (state.callerIdMatched && state.matchedPinPolicy === "ask_once") {
            return out({ ...known, activePin: null, pinFromStore: false, pinProbe: false }, ["02_pin"], G.pin);
          }
          return blockedNotEnrolled(known);
        }
        if (state.pinProbe) {
          // A matched caller: the store set a PIN Loopcom does not know.
          // Rule 1 — never asked. (ask_once: the ONE time they are asked.)
          if (state.callerIdMatched) {
            if (state.matchedPinPolicy === "ask_once") {
              return out({ ...known, activePin: null, pinProbe: false }, ["02_pin"], G.pin);
            }
            return blockedNotEnrolled(known);
          }
          // A foreign caller: the account has a PIN — ask for it, star for a code.
          return out({ ...known, activePin: null, pinProbe: false }, ["23_pin_or_star"], G.pin);
        }
        const attempts = known.pinAttempts + 1;
        if (attempts >= PAY_MAX_PIN_ATTEMPTS) return toHuman({ ...known, pinAttempts: attempts, activePin: null }, ["15_too_many_tries"]);
        return out({ ...known, pinAttempts: attempts, activePin: null }, ["03_pin_wrong", pinPrompt(known)], G.pin);
      }
      return out(state, [], state.activePin ? null : G.pin);
    }

    case "code_channel": {
      if (event.type === "digits") {
        const key = event.value.trim();
        if (key !== "1" && key !== "2") return codeChannelMenu(state);
        if (state.codeSends >= PAY_MAX_CODE_SENDS) return toHuman(state, []);
        const channel: PayCodeChannel = key === "1" ? "call" : "text";
        return out({ ...state, codeChannel: channel }, [], null, [{ kind: "list_numbers" }]);
      }
      if (event.type === "numbers_result") {
        const phones = event.phones.filter((p) => /^\d{10}$/.test(p)).slice(0, PAY_MAX_CODE_NUMBERS);
        const channel = state.codeChannel ?? "text";
        // No number on file = nowhere to prove ownership. A person.
        if (phones.length === 0) return toHuman({ ...state, codePhones: [] }, []);
        if (phones.length === 1) return sendCode({ ...state, codePhones: phones }, channel, phones[0]);
        return codeNumberMenu({ ...state, codePhones: phones });
      }
      return out(state, [], G.menu);
    }

    case "code_number": {
      if (event.type !== "digits") return out(state, [], G.menu);
      const idx = Number(event.value.trim()) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= state.codePhones.length) return codeNumberMenu(state);
      if (state.codeSends >= PAY_MAX_CODE_SENDS) return toHuman(state, []);
      return sendCode(state, state.codeChannel ?? "text", state.codePhones[idx]);
    }

    case "code_entry": {
      if (event.type === "code_sent") {
        if (!event.ok || !event.codeHash) return toHuman({ ...state, codeHash: null }, []);
        return out(
          { ...state, codeHash: event.codeHash, codeExpiresAt: event.expiresAt ?? null, codeSends: state.codeSends + 1, codeAttempts: 0, codeWaits: 0 },
          [state.codeChannel === "call" ? "31_code_call_sent" : "32_code_text_sent"],
          G.code,
        );
      }
      if (event.type === "digits") {
        // The code is still on its way (a code_sent has not landed yet): ignore.
        if (!state.codeHash) return out(state, [], null);
        const value = event.value.trim();
        if (value === "") {
          // The caller is waiting for the call/text — keep listening, bounded.
          const waits = state.codeWaits + 1;
          if (waits > PAY_MAX_CODE_WAITS) return toHuman({ ...state, codeWaits: waits }, []);
          return out({ ...state, codeWaits: waits }, ["30_enter_code"], G.code);
        }
        if (value.startsWith("*")) {
          // Resend, bounded by PAY_MAX_CODE_SENDS.
          if (state.codeSends >= PAY_MAX_CODE_SENDS) return toHuman(state, []);
          return codeChannelMenu({ ...state, codeHash: null, codeExpiresAt: null });
        }
        const digits = value.replace(/\D/g, "");
        if (digits.length !== PAY_CODE_LENGTH) {
          const attempts = state.codeAttempts + 1;
          if (attempts >= PAY_MAX_CODE_ATTEMPTS) return toHuman({ ...state, codeAttempts: attempts }, ["15_too_many_tries"]);
          return out({ ...state, codeAttempts: attempts }, ["33_code_wrong", "30_enter_code"], G.code);
        }
        return out(state, [], null, [{ kind: "verify_code", digits }]);
      }
      if (event.type === "code_result") {
        if (event.ok) {
          // Ownership proven: from here on this caller is served like a
          // matched caller. The code is spent.
          const owner: PayIvrState = { ...state, ownerVerified: true, codeHash: null, codeExpiresAt: null };
          if (event.storedPin) return silentVerify(owner, event.storedPin, []);
          // The account has a PIN (probed "set" before the star) that Loopcom
          // does not hold, and the caller said they do not have it.
          return blockedNotEnrolled(owner);
        }
        if (event.reason === "expired") {
          if (state.codeSends >= PAY_MAX_CODE_SENDS) return toHuman({ ...state, codeHash: null }, ["33_code_wrong"]);
          return codeChannelMenu({ ...state, codeHash: null, codeExpiresAt: null }, ["33_code_wrong"]);
        }
        const attempts = state.codeAttempts + 1;
        if (attempts >= PAY_MAX_CODE_ATTEMPTS) return toHuman({ ...state, codeAttempts: attempts, codeHash: null }, ["15_too_many_tries"]);
        return out({ ...state, codeAttempts: attempts }, ["33_code_wrong", "30_enter_code"], G.code);
      }
      return out(state, [], state.codeHash ? G.code : null);
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

/** The prompt refs an outbound code call plays once the callee answers: intro, the six digits, again, goodbye. */
export function codeCallPromptRefs(code: string): string[] {
  const digits = digitsToPromptRefs(code);
  return ["28_code_call_intro", ...digits, "29_code_again", ...digits, "10_thanks_bye"];
}

/** Invariant helper for tests: how many charge effects a full event trace produced. */
export function countChargeEffects(outputs: PayIvrOutput[]): number {
  return outputs.reduce((n, o) => n + o.effects.filter((e) => e.kind === "charge").length, 0);
}

/** The amount cap restated for callers that build charges outside the reducer. */
export const PAY_IVR_MAX_CENTS = PAY_MAX_CENTS;
