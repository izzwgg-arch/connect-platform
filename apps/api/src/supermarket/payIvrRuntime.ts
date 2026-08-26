/**
 * Pay-by-phone runtime — binds the pure payIvrCore reducer to the database
 * (SupermarketPayCall = the durable per-call session) and the POS client
 * (the effects). Driven by the internal HTTP door the dialplan will call.
 *
 * Money rules, in code not prose:
 * - a `charge` effect builds its externalId from the session ROW id + the
 *   reducer's chargeSeq, so the same confirmation can never charge twice —
 *   their api answers 409 on a replay and we treat that as "already landed";
 * - the POS client never retries a write; a timeout surfaces as outcome
 *   "error", which the reducer routes to a HUMAN, never a retry loop;
 * - PINs: verified by attempting the balance read (their api validates);
 *   enrollment (encrypted, bound to account+caller-number) happens ONLY via
 *   the reducer's enroll_pin effect, whose own rules are pinned by tests.
 */

import {
  initialPayIvrState,
  reducePayIvr,
  type PayIvrEvent,
  type PayIvrOutput,
  type PayIvrState,
} from "./payIvrCore";
import { posClientForTenant } from "./integrationCredentials";
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

function parseBalance(body: any): number | null {
  const cents = posAmountToCents(body?.balance ?? body?.amount ?? body?.currentBalance);
  return cents === null ? null : cents;
}

async function findStoredPin(db: any, tenantId: string, posCustomerId: string, callerE164: string): Promise<string | null> {
  try {
    const row = await db.supermarketPhonePin.findFirst({
      where: { tenantId, posCustomerId, phoneE164: callerE164 },
      select: { pinEnc: true },
    });
    if (!row) return null;
    const sec = await import("@connect/security");
    if (!sec.hasCredentialsMasterKey()) return null;
    const value = sec.decryptJson<{ pin: string }>(row.pinEnc);
    return typeof value?.pin === "string" && value.pin.length >= 1 ? value.pin : null;
  } catch {
    return null;
  }
}

function toE164ish(raw: string): string {
  const ten = posPhoneDigits(raw);
  return ten ? `+1${ten}` : String(raw ?? "").slice(0, 20);
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
  let state: PayIvrState = (session.state as PayIvrState) ?? initialPayIvrState();

  // Build the inbound event.
  let event: PayIvrEvent;
  if (input.hangup) {
    event = { type: "hangup" };
  } else if (state.phase === "start") {
    // First step: resolve the caller by caller-ID before the reducer runs.
    const phone10 = posPhoneDigits(input.callerNumber);
    let callerKnown = false;
    let posCustomerId: string | null = null;
    if (phone10) {
      try {
        const body: any = await client.getCustomerIdByPhone(phone10);
        const id = body?.id ?? body?.customerId ?? null;
        if (id) {
          callerKnown = true;
          posCustomerId = String(id);
        }
      } catch (err: any) {
        if (!(err instanceof PosApiError && err.code === "pos_not_found")) {
          log.warn({ err: String(err?.code ?? err) }, "pay-ivr caller lookup failed");
        }
      }
    }
    let storedPin: string | null = null;
    if (callerKnown && posCustomerId) {
      state = { ...state, posCustomerId };
      storedPin = await findStoredPin(db, input.tenantId, posCustomerId, toE164ish(input.callerNumber));
    }
    event = { type: "call_start", callerKnown, hasStoredPin: storedPin !== null, storedPin: storedPin ?? undefined };
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
      if (effect.kind === "enroll_pin") {
        // Best-effort: enrollment failing must never fail the call.
        try {
          const sec = await import("@connect/security");
          if (sec.hasCredentialsMasterKey() && state.posCustomerId) {
            await db.supermarketPhonePin.upsert({
              where: {
                tenantId_posCustomerId_phoneE164: {
                  tenantId: input.tenantId,
                  posCustomerId: state.posCustomerId,
                  phoneE164: toE164ish(input.callerNumber),
                },
              },
              update: { pinEnc: sec.encryptJson({ pin: effect.pin }), lastUsedAt: new Date() },
              create: {
                tenantId: input.tenantId,
                posCustomerId: state.posCustomerId,
                phoneE164: toE164ish(input.callerNumber),
                pinEnc: sec.encryptJson({ pin: effect.pin }),
                lastUsedAt: new Date(),
              },
            });
          }
        } catch {
          /* enrollment is a convenience, never a failure */
        }
        continue;
      }
      if (effect.kind === "lookup_by_phone") {
        try {
          const body: any = await client.getCustomerIdByPhone(effect.phone10);
          const id = body?.id ?? body?.customerId ?? null;
          nextEvent = id
            ? { type: "lookup_result", found: true, posCustomerId: String(id) }
            : { type: "lookup_result", found: false };
        } catch {
          nextEvent = { type: "lookup_result", found: false };
        }
        continue;
      }
      if (effect.kind === "verify_pin") {
        if (!state.posCustomerId) {
          nextEvent = { type: "pin_result", ok: false };
          continue;
        }
        try {
          const body: any = await client.getCustomerBalance(state.posCustomerId, effect.pin);
          nextEvent = { type: "pin_result", ok: true, balanceCents: parseBalance(body) ?? undefined };
        } catch (err: any) {
          if (err instanceof PosApiError && (err.status === 401 || err.status === 403)) {
            // A stale STORED pin gets purged so the next call keys fresh.
            if (state.pinFromStore && state.posCustomerId) {
              await db.supermarketPhonePin
                .deleteMany({
                  where: {
                    tenantId: input.tenantId,
                    posCustomerId: state.posCustomerId,
                    phoneE164: toE164ish(input.callerNumber),
                  },
                })
                .catch(() => {});
            }
            nextEvent = { type: "pin_result", ok: false };
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
        posCustomerId: state.posCustomerId ?? undefined,
        chargeSeq: state.chargeSeq,
        chargedCents: state.chargedCents,
        status: state.phase === "done" ? "done" : state.phase === "human" ? "failed" : "open",
      },
    });

    if (!nextEvent) break;
    event = nextEvent;
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
