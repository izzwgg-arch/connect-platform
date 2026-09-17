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
 *   served; "invalid" means there is one and it must be keyed. Enrollment
 *   (encrypted, bound to the ACCOUNT, provenance = the caller's number)
 *   happens ONLY via the reducer's enroll_pin effect, whose own rules are
 *   pinned by tests.
 *
 * Caller-ID matching (2026-09-17): the register's phone lookup is an EXACT
 * match on the record's phone; the mirror (PosCustomer) knows every number on
 * the record, so a caller from an account's SECOND phone is still matched.
 * The mirror also answers when the register is unreachable — a register
 * outage must not turn every known caller into a stranger. The keyed lookup
 * (a foreign caller entering the account's number) uses the same resolver.
 *
 * The one-time code (2026-09-17): `send_code` generates a 6-digit code, keeps
 * ONLY its salted hash + expiry in the session row (the loginOtp helpers —
 * the same shape the sign-in code uses), and delivers it by TEXT from the
 * store's own number (payLineSms) or by PHONE CALL, which the dialplan places
 * (`dial` + `dialPrompts` in the step result — the code is spoken digit by
 * digit from the recorded number set). `verify_code` compares the hash and
 * the clock and answers `code_result`, looking the enrolled PIN up at that
 * moment so a verified owner is served exactly like a matched caller. The
 * code is never logged.
 */

import {
  codeCallPromptRefs,
  initialPayIvrState,
  normalizePayIvrState,
  reducePayIvr,
  PAY_CODE_LENGTH,
  type PayIvrEvent,
  type PayIvrOutput,
  type PayIvrState,
  type PayMatchedPinPolicy,
  type PayPinReason,
} from "./payIvrCore";
import { posClientForTenant } from "./integrationCredentials";
import { mirrorCustomerById, mirrorCustomerByPhone } from "./customerSync";
import { posAmountToCents, posPhoneDigits, toMirrorCustomer, toPosExternalId, PosApiError } from "./posWithLogic";
import { payLineCodeSmsBody, sendPayLineSms, type PayLineSmsSend } from "./payLineSms";
import { generateOtpCode, hashOtpCode, otpCodeMatches } from "../mfa/loginOtp";

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
  /** Ten digits the dialplan must Originate() a code call to before acting on the rest; absent otherwise. */
  dial?: string;
  /** What that code call plays once answered. */
  dialPrompts?: string[];
};

export type PayIvrRuntimeDeps = {
  db: any;
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void };
  clientFor?: typeof posClientForTenant;
  /** Injectable for tests; production sends from the tenant's own number. */
  sendSms?: PayLineSmsSend;
  /** Injectable clock for the code's expiry. */
  now?: () => number;
  /** Injectable code generator (tests read the code back; production never does). */
  generateCode?: () => string;
  /** Overrides the env policy (tests). */
  matchedPinPolicy?: PayMatchedPinPolicy;
  /** The store's name in the code text; defaults to the tenant's name. */
  storeName?: string;
};

/** Session status values persisted on SupermarketPayCall.status. */
export type PayCallStatus = "open" | "done" | "failed" | "no_pin" | "pin_not_enrolled";

/** How long a one-time code is good for. */
export const PAY_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * The operator switch for matched callers with nothing enrolled. Izzy's rule
 * (2026-09-17) is "never": a matched caller is never asked for a PIN. "ask_once"
 * restores the 09-17-morning behaviour (asked once, enrolled, silent after).
 */
export function resolveMatchedPinPolicy(override?: PayMatchedPinPolicy): PayMatchedPinPolicy {
  if (override === "ask_once" || override === "never") return override;
  return String(process.env.SUPERMARKET_PAY_MATCHED_PIN_POLICY || "never").trim().toLowerCase() === "ask_once" ? "ask_once" : "never";
}

function parseBalance(body: any): number | null {
  const cents = posAmountToCents(body?.balance ?? body?.amount ?? body?.currentBalance);
  return cents === null ? null : cents;
}

/**
 * The enrolled PIN for an ACCOUNT. The vault row carries the number it was
 * enrolled from as provenance, but the PIN belongs to the account: a caller
 * from any of the account's own numbers (caller-ID matched), or one who keyed
 * back a code sent to one of them, gets it silently. Never called for a
 * caller who has proven nothing.
 */
export async function findStoredPin(db: any, tenantId: string, posCustomerId: string): Promise<string | null> {
  try {
    const row = await db.supermarketPhonePin.findFirst({
      where: { tenantId, posCustomerId },
      orderBy: { lastUsedAt: "desc" },
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

function pinReasonOf(err: unknown): PayPinReason {
  if (err instanceof PosApiError && err.pinReason) return err.pinReason;
  return "unknown";
}

function statusFor(state: PayIvrState): PayCallStatus {
  if (state.blockedReason === "pin_not_set") return "no_pin";
  if (state.blockedReason === "pin_not_enrolled") return "pin_not_enrolled";
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
 * Every number the register holds on the account (its record first, the
 * mirror's copy as a fallback), ten digits each, deduplicated, in the
 * record's order. ONLY these may receive a code.
 */
export async function listAccountNumbers(db: any, client: any, tenantId: string, posCustomerId: string): Promise<string[]> {
  const phones: string[] = [];
  const add = (p: unknown) => {
    const ten = posPhoneDigits(String(p ?? ""));
    if (ten && !phones.includes(ten)) phones.push(ten);
  };
  try {
    const rec: any = await client.getCustomerById(posCustomerId);
    const m = toMirrorCustomer(rec);
    for (const p of m?.phones ?? []) add(p);
  } catch {
    /* the mirror still knows the record */
  }
  if (phones.length === 0) {
    try {
      const row = await db.posCustomer.findFirst({
        where: { tenantId, posCustomerId: String(posCustomerId).slice(0, 64) },
        select: { phonesText: true },
      });
      for (const p of String(row?.phonesText ?? "").split(" ")) add(p);
    } catch {
      /* no mirror row = no numbers */
    }
  }
  return phones;
}

/**
 * Run one IVR step: load the session, feed the event, execute effects until
 * the machine wants caller input (or is done), persist, answer.
 */
export async function runPayIvrStep(deps: PayIvrRuntimeDeps, input: PayIvrStepInput): Promise<PayIvrStepResult> {
  const { db } = deps;
  const log = deps.log ?? { info: () => {}, warn: () => {} };
  const clientFor = deps.clientFor ?? posClientForTenant;
  const now = deps.now ?? (() => Date.now());
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
  let ownAccountId: string | null = null;
  if (input.hangup) {
    event = { type: "hangup" };
  } else if (state.phase === "start") {
    // First step: resolve the caller by caller-ID before the reducer runs.
    const account = await resolveCallerAccount(db, client, input.tenantId, input.callerNumber, log);
    let storedPin: string | null = null;
    if (account) {
      ownAccountId = account.posCustomerId;
      state = { ...state, posCustomerId: account.posCustomerId };
      storedPin = await findStoredPin(db, input.tenantId, account.posCustomerId);
    }
    event = {
      type: "call_start",
      callerKnown: account !== null,
      hasStoredPin: storedPin !== null,
      storedPin: storedPin ?? undefined,
      matchedPinPolicy: resolveMatchedPinPolicy(deps.matchedPinPolicy),
    };
  } else {
    event = { type: "digits", value: String(input.digits ?? "") };
  }

  const prompts: string[] = [];
  let gather: PayIvrOutput["gather"] = null;
  let transfer = false;
  let dial: string | undefined;
  let dialPrompts: string[] | undefined;
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
        const wasStored = state.pinFromStore;
        try {
          const body: any = await client.getCustomerBalance(state.posCustomerId, effect.pin);
          nextEvent = { type: "pin_result", ok: true, balanceCents: parseBalance(body) ?? undefined };
          if (wasStored) {
            await db.supermarketPhonePin
              .updateMany({ where: { tenantId: input.tenantId, posCustomerId: state.posCustomerId }, data: { lastUsedAt: new Date() } })
              .catch(() => {});
          }
        } catch (err: any) {
          if (err instanceof PosApiError && (err.status === 401 || err.status === 403)) {
            const reason = pinReasonOf(err);
            // A refused STORED pin is stale (changed or removed at the store):
            // purge the account's enrollment so the desk re-enrolls fresh.
            if (wasStored && state.posCustomerId) {
              await db.supermarketPhonePin
                .deleteMany({ where: { tenantId: input.tenantId, posCustomerId: state.posCustomerId } })
                .catch(() => {});
            }
            nextEvent = { type: "pin_result", ok: false, reason };
          } else {
            // Provider outage ≠ wrong PIN — a person, not a lockout.
            nextEvent = { type: "charge_result", outcome: "error" };
            state = { ...state, phase: "charging" };
          }
        }
        continue;
      }
      if (effect.kind === "list_numbers") {
        const phones = state.posCustomerId ? await listAccountNumbers(db, client, input.tenantId, state.posCustomerId) : [];
        nextEvent = { type: "numbers_result", phones };
        continue;
      }
      if (effect.kind === "send_code") {
        // ⛔ Only a number the register holds on the account — the reducer
        // chose it from list_numbers, but the runtime re-checks the invariant.
        if (!state.codePhones.includes(effect.phone10)) {
          nextEvent = { type: "code_sent", ok: false };
          continue;
        }
        const code = (deps.generateCode ?? generateOtpCode)();
        if (!/^\d{6}$/.test(code) || code.length !== PAY_CODE_LENGTH) {
          nextEvent = { type: "code_sent", ok: false };
          continue;
        }
        const codeHash = hashOtpCode(code, String(session.id));
        const expiresAt = now() + PAY_CODE_TTL_MS;
        if (effect.channel === "text") {
          const storeName = deps.storeName ?? (await storeNameFor(db, input.tenantId));
          const send = deps.sendSms ?? ((i: { tenantId: string; to10: string; body: string }) => sendPayLineSms(db, i));
          const sent = await send({ tenantId: input.tenantId, to10: effect.phone10, body: payLineCodeSmsBody(code, storeName) });
          if (!sent.ok) {
            log.warn({ tenantId: input.tenantId, posCustomerId: state.posCustomerId, error: sent.error }, "pay-ivr: code text could not be sent");
            nextEvent = { type: "code_sent", ok: false };
            continue;
          }
          log.info({ tenantId: input.tenantId, posCustomerId: state.posCustomerId, to: `…${effect.phone10.slice(-4)}`, channel: "text" }, "pay-ivr: one-time code sent");
        } else {
          // The dialplan places the call: ten digits + what to say once answered.
          dial = effect.phone10;
          dialPrompts = codeCallPromptRefs(code);
          log.info({ tenantId: input.tenantId, posCustomerId: state.posCustomerId, to: `…${effect.phone10.slice(-4)}`, channel: "call" }, "pay-ivr: one-time code call requested");
        }
        nextEvent = { type: "code_sent", ok: true, codeHash, expiresAt };
        continue;
      }
      if (effect.kind === "verify_code") {
        if (!state.codeHash) {
          nextEvent = { type: "code_result", ok: false, reason: "none" };
          continue;
        }
        if (state.codeExpiresAt !== null && now() > state.codeExpiresAt) {
          nextEvent = { type: "code_result", ok: false, reason: "expired" };
          continue;
        }
        if (!otpCodeMatches(effect.digits, String(session.id), state.codeHash)) {
          nextEvent = { type: "code_result", ok: false, reason: "wrong" };
          continue;
        }
        const storedPin = state.posCustomerId ? await findStoredPin(db, input.tenantId, state.posCustomerId) : null;
        log.info({ tenantId: input.tenantId, posCustomerId: state.posCustomerId, enrolled: storedPin !== null }, "pay-ivr: one-time code verified");
        nextEvent = { type: "code_result", ok: true, storedPin: storedPin ?? undefined };
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
        status: statusFor(state),
      },
    });

    if (!nextEvent) break;
    event = nextEvent;
  }

  if (state.blockedReason === "pin_not_set" && transfer) {
    log.warn(
      { tenantId: input.tenantId, posCustomerId: state.posCustomerId, callerIdMatched: state.callerIdMatched },
      "pay-ivr: register has no PIN for this account — caller handed to a person",
    );
  }
  if (state.ownAccountBlocked && state.phase === "lookup_entry" && prompts.includes("34_enter_account_phone")) {
    log.warn(
      { tenantId: input.tenantId, ownAccount: ownAccountId, reason: state.ownAccountBlocked },
      "pay-ivr: the caller's own account cannot be served — asked for the account to pay instead",
    );
  }
  if (state.blockedReason === "pin_not_enrolled" && transfer) {
    log.warn(
      { tenantId: input.tenantId, posCustomerId: state.posCustomerId, callerIdMatched: state.callerIdMatched, ownerVerified: state.ownerVerified },
      "pay-ivr: account has a PIN Loopcom does not hold — caller handed to a person; enroll it from the Orders desk",
    );
  }

  const result: PayIvrStepResult = {
    prompts,
    gather: gather ? { what: gather.what, maxDigits: gather.maxDigits, starIsData: gather.starIsData } : null,
    transfer,
    done: state.phase === "done",
  };
  if (dial && dialPrompts && !transfer && state.phase !== "done") {
    result.dial = dial;
    result.dialPrompts = dialPrompts;
  }
  return result;
}

async function storeNameFor(db: any, tenantId: string): Promise<string> {
  try {
    const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    const name = String(t?.name ?? "").trim();
    return name || "Your store";
  } catch {
    return "Your store";
  }
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

/** Exposed for tests: the mirror-by-id helper the number list falls back to. */
export { mirrorCustomerById };
