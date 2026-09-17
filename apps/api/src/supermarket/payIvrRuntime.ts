/**
 * Pay-by-phone runtime — binds the pure payIvrCore reducer to the database
 * (SupermarketPayCall = the durable per-call session) and the POS client
 * (the effects). Driven by the internal HTTP door the dialplan calls.
 *
 * Money rules, in code not prose:
 * - a `charge` effect builds its externalId from the session ROW id + the
 *   reducer's chargeSeq, so the same confirmation can never charge twice —
 *   their api answers 409 on a replay and we treat that as "already landed";
 * - the POS client never retries a write; a timeout surfaces as outcome
 *   "error", which the reducer routes to a HUMAN, never a retry loop;
 * - PINs: verified by attempting the balance read (their api validates) and
 *   the register's refusal is CLASSIFIED (posWithLogic.classifyPinRefusal):
 *   "not_set" means the POS has no PIN for the account and nobody can be
 *   served; "invalid" means there is one and it must be keyed. ⛔ Nothing is
 *   enrolled or remembered (Izzy, 2026-09-17 evening: every caller keys the
 *   PIN); the SupermarketPhonePin desk routes still exist but this line never
 *   reads them.
 *
 * Caller-ID matching: the register's phone lookup is an EXACT match on the
 * record's phone; the mirror (PosCustomer) knows every number on the record,
 * so a caller from an account's SECOND phone is still recognised. The mirror
 * also answers when the register is unreachable — a register outage must not
 * turn every known caller into a stranger. The keyed lookup (a caller entering
 * an account's number) uses the same resolver.
 */

import {
  initialPayIvrState,
  normalizePayIvrState,
  reducePayIvr,
  type PayIvrEvent,
  type PayIvrOutput,
  type PayIvrState,
  type PayPinReason,
} from "./payIvrCore";
import { posClientForTenant } from "./integrationCredentials";
import { mirrorCustomerByPhone } from "./customerSync";
import { posAmountToCents, posPhoneDigits, toPosExternalId, PosApiError } from "./posWithLogic";

export type PayIvrStepInput = {
  tenantId: string;
  callId: string;
  callerNumber: string;
  /** DTMF collected since the last step; absent on the first step. */
  digits?: string;
  /** True when the PBX reports the caller hung up. */
  hangup?: boolean;
};

export type PayIvrStepResult = {
  prompts: string[];
  gather: { what: string; maxDigits: number; starIsData: boolean } | null;
  transfer: boolean;
  done: boolean;
};

export type PayIvrRuntimeDeps = {
  db: any;
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void };
  clientFor?: typeof posClientForTenant;
};

/** Session status values persisted on SupermarketPayCall.status. */
export type PayCallStatus = "open" | "done" | "failed" | "no_pin";

function parseBalance(body: any): number | null {
  const cents = posAmountToCents(body?.balance ?? body?.amount ?? body?.currentBalance);
  return cents === null ? null : cents;
}

function toE164ish(raw: string): string {
  const ten = posPhoneDigits(raw);
  return ten ? `+1${ten}` : String(raw ?? "").slice(0, 20);
}

function pinReasonOf(err: unknown): PayPinReason {
  if (err instanceof PosApiError && err.pinReason) return err.pinReason;
  return "unknown";
}

function statusFor(state: PayIvrState): PayCallStatus {
  if (state.blockedReason === "pin_not_set") return "no_pin";
  if (state.phase === "done") return "done";
  if (state.phase === "human") return "failed";
  return "open";
}

/**
 * Resolve a phone number to a register account: the register's exact lookup
 * first, then the mirror (second numbers on the record; register outages).
 */
export async function resolveCallerAccount(
  db: any,
  client: any,
  tenantId: string,
  callerNumber: string,
  log: { warn: (o: any, m?: string) => void },
): Promise<{ posCustomerId: string; via: "register" | "mirror" } | null> {
  const phone10 = posPhoneDigits(callerNumber);
  if (!phone10) return null;
  let registerSaidNotFound = false;
  try {
    const body: any = await client.getCustomerIdByPhone(phone10);
    const id = body?.id ?? body?.customerId ?? null;
    if (id) return { posCustomerId: String(id), via: "register" };
    registerSaidNotFound = true;
  } catch (err: any) {
    if (err instanceof PosApiError && err.code === "pos_not_found") registerSaidNotFound = true;
    else log.warn({ err: String(err?.code ?? err) }, "pay-ivr caller lookup failed; trying the mirror");
  }
  try {
    const m = await mirrorCustomerByPhone(db, tenantId, phone10);
    if (m?.posCustomerId) return { posCustomerId: String(m.posCustomerId), via: "mirror" };
  } catch {
    /* the mirror is a convenience; its absence is "unknown caller" */
  }
  void registerSaidNotFound;
  return null;
}

/**
 * Run one IVR step: load the session, feed the event, execute effects until
 * the machine wants caller input (or is done), persist, answer.
 */
export async function runPayIvrStep(deps: PayIvrRuntimeDeps, input: PayIvrStepInput): Promise<PayIvrStepResult> {
  const { db } = deps;
  const log = deps.log ?? { info: () => {}, warn: () => {} };
  const clientFor = deps.clientFor ?? posClientForTenant;
  const client = await clientFor(db, input.tenantId);
  if (!client) {
    // No register connection = the line cannot do anything but hand to a person.
    return { prompts: ["20_connect_person"], gather: null, transfer: true, done: false };
  }

  let session = await db.supermarketPayCall.findFirst({
    where: { tenantId: input.tenantId, callId: input.callId },
  });
  if (!session) {
    session = await db.supermarketPayCall.create({
      data: {
        tenantId: input.tenantId,
        callId: input.callId,
        callerNumber: toE164ish(input.callerNumber),
        state: initialPayIvrState() as any,
      },
    });
  }
  let state: PayIvrState = normalizePayIvrState(session.state);

  // Build the inbound event.
  let event: PayIvrEvent;
  if (input.hangup) {
    event = { type: "hangup" };
  } else if (state.phase === "start") {
    // First step: is the caller's own number on an account? (Decides only
    // whether they are OFFERED that account — the PIN is asked either way.)
    const account = await resolveCallerAccount(db, client, input.tenantId, input.callerNumber, log);
    event = { type: "call_start", callerKnown: account !== null, callerAccountId: account?.posCustomerId };
  } else {
    event = { type: "digits", value: String(input.digits ?? "") };
  }

  const prompts: string[] = [];
  let gather: PayIvrOutput["gather"] = null;
  let transfer = false;
  let guard = 0;

  // Reduce, execute effects, feed results back — until the machine wants input.
  while (guard++ < 12) {
    const outcome = reducePayIvr(state, event);
    state = outcome.state;
    prompts.push(...outcome.prompts);
    gather = outcome.gather;

    let nextEvent: PayIvrEvent | null = null;
    for (const effect of outcome.effects) {
      if (effect.kind === "transfer_to_person") {
        transfer = true;
        continue;
      }
      if (effect.kind === "hangup") continue;
      if (effect.kind === "lookup_by_phone") {
        const account = await resolveCallerAccount(db, client, input.tenantId, effect.phone10, log);
        nextEvent = account
          ? { type: "lookup_result", found: true, posCustomerId: account.posCustomerId }
          : { type: "lookup_result", found: false };
        continue;
      }
      if (effect.kind === "verify_pin") {
        if (!state.posCustomerId) {
          nextEvent = { type: "pin_result", ok: false, reason: "unknown" };
          continue;
        }
        try {
          const body: any = await client.getCustomerBalance(state.posCustomerId, effect.pin);
          nextEvent = { type: "pin_result", ok: true, balanceCents: parseBalance(body) ?? undefined };
        } catch (err: any) {
          if (err instanceof PosApiError && (err.status === 401 || err.status === 403)) {
            nextEvent = { type: "pin_result", ok: false, reason: pinReasonOf(err) };
          } else {
            // Provider outage ≠ wrong PIN — a person, not a lockout.
            nextEvent = { type: "charge_result", outcome: "error" };
            state = { ...state, phase: "charging" };
          }
        }
        continue;
      }
      if (effect.kind === "read_balance") {
        if (!state.posCustomerId || !state.activePin) {
          nextEvent = { type: "balance_result", ok: false };
          continue;
        }
        try {
          const body: any = await client.getCustomerBalance(state.posCustomerId, state.activePin);
          const cents = parseBalance(body);
          nextEvent = cents === null ? { type: "balance_result", ok: false } : { type: "balance_result", ok: true, balanceCents: cents };
        } catch {
          nextEvent = { type: "balance_result", ok: false };
        }
        continue;
      }
      if (effect.kind === "charge") {
        nextEvent = await performCharge(deps, client, session, state, input, effect.amountCents, effect.chargeSeq);
        continue;
      }
    }

    // Persist after every reduce+effects round — an api restart mid-call
    // resumes from the last durable state instead of re-charging.
    await db.supermarketPayCall.update({
      where: { id: session.id },
      data: {
        state: state as any,
        posCustomerId: state.posCustomerId ?? state.callerAccountId ?? undefined,
        chargeSeq: state.chargeSeq,
        chargedCents: state.chargedCents,
        status: statusFor(state),
      },
    });

    if (!nextEvent) break;
    event = nextEvent;
  }

  if (state.blockedReason === "pin_not_set" && transfer) {
    log.warn(
      { tenantId: input.tenantId, posCustomerId: state.posCustomerId, callerIdMatched: state.callerIdMatched },
      "pay-ivr: register has no PIN for this account — caller told to visit the store, handed to a person",
    );
  }

  return {
    prompts,
    gather: gather ? { what: gather.what, maxDigits: gather.maxDigits, starIsData: gather.starIsData } : null,
    transfer,
    done: state.phase === "done",
  };
}

async function performCharge(
  deps: PayIvrRuntimeDeps,
  client: any,
  session: any,
  state: PayIvrState,
  input: PayIvrStepInput,
  amountCents: number,
  chargeSeq: number,
): Promise<PayIvrEvent> {
  const { db } = deps;
  if (!state.posCustomerId || !state.activePin) return { type: "charge_result", outcome: "error" };

  // Card on file: the first stored card. No card = no phone payment, period.
  let cardId: string | null = null;
  try {
    const cards: any = await client.listCustomerCards(state.posCustomerId);
    const list = Array.isArray(cards) ? cards : cards?.items ?? cards?.cards ?? [];
    const first = Array.isArray(list) && list.length > 0 ? list[0] : null;
    cardId = first?.id ? String(first.id) : first?.cardId ? String(first.cardId) : null;
  } catch {
    return { type: "charge_result", outcome: "error" };
  }
  if (!cardId) return { type: "charge_result", outcome: "no_card" };

  // Idempotency: session row id tail + seq, bounded to their 20-char cap.
  const externalId = toPosExternalId(`pc${String(session.id).replace(/[^A-Za-z0-9]/g, "").slice(-14)}s${chargeSeq}`);
  try {
    const body: any = await client.createCharge(state.posCustomerId, state.activePin, {
      externalId,
      amountCents,
      cardId,
    });
    const newBalance = posAmountToCents(body?.newBalance);
    await db.supermarketPayCall.update({
      where: { id: session.id },
      data: { chargedCents: { increment: amountCents } },
    }).catch(() => {});
    return { type: "charge_result", outcome: "approved", newBalanceCents: newBalance ?? undefined };
  } catch (err: any) {
    if (err instanceof PosApiError) {
      if (err.code === "pos_duplicate") return { type: "charge_result", outcome: "duplicate" };
      if (err.status === 402 || /declin/i.test(err.bodyPreview)) return { type: "charge_result", outcome: "declined" };
      if (err.status === 400 || err.status === 422) return { type: "charge_result", outcome: "declined" };
    }
    // ⛔ Timeout / 5xx: the charge MAY have landed. NEVER retried — their 409
    // on our externalId protects a later replay, and a person takes over now.
    return { type: "charge_result", outcome: "error" };
  }
}
