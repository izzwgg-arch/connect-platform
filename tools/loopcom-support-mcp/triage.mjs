/**
 * TRIAGE — who gets an agent, and which lane they run in.
 *
 * Pure. No I/O, no clock of its own, no network. Every input is an argument so
 * the whole decision space can be driven exhaustively by stress.test.mjs — the
 * watcher itself stays a thin runner around these two functions.
 *
 * ⛔ WHY THIS IS A SEPARATE FILE: the two things that go wrong here are a
 * customer's ticket being silently dropped, and a flood of platform alarms
 * eating the day's budget so a real customer is never reached. Neither is
 * visible from a test of the runner — they are decisions, and decisions want to
 * be driven directly.
 */

/**
 * ⛔ The platform's OWN monitors raise escalations into the SAME table
 * customers do — 5 of the last 13 tickets were alarms, not people. Read off the
 * six creators in apps/api and apps/agent, 2026-08-31:
 *
 *   voicemailMailboxGuardrail.ts  userName "voicemail mailbox guardrail"
 *   smsForwardGuardrail.ts        userName "sms forward guardrail"
 *   turnHealthWatch.ts            userName "TURN monitor"
 *   voicemailEmailGuardrails.ts   userName "email guardrail"
 *   yiddishLabsCreditWatch.ts     userName "Yiddish Labs monitor"
 *   voicemailEmailRuntime.ts      userName "voicemail watchdog"   ⛔ SEE BELOW
 *
 * ⛔⛔ THE TRAP: the sixth one does NOT wear the platform's name. Every other
 * alarm sets `tenantName: "Loopcom platform"`, but voicemailEmailRuntime.ts:426
 * does `tenant.findFirst()` and stamps whatever REAL CUSTOMER comes back first.
 * So a platform alarm can arrive looking exactly like a customer ticket, and a
 * classifier keyed on tenantName alone would work it as one. userName is the
 * only field all six agree on.
 */
export const PLATFORM_MONITOR_USERNAMES = Object.freeze([
  "voicemail mailbox guardrail",
  "sms forward guardrail",
  "turn monitor",
  "email guardrail",
  "yiddish labs monitor",
  "voicemail watchdog",
]);

/** Every alarm but the trap above stamps this literally. Kept as a second, independent signal. */
export const PLATFORM_TENANT_NAME = "loopcom platform";

const norm = (v) => String(v ?? "").trim().toLowerCase();

/**
 * ⛔ FAILURE DIRECTION, and it decides the whole shape of this function:
 * an alarm mistaken for a customer costs one wasted agent run out of the alarm
 * lane's own budget. A customer mistaken for an alarm is a person who filed a
 * support request and NEVER GETS WORKED. So platform requires positive
 * evidence; everything unrecognised is a customer.
 */
export function classifyTicket(ticket) {
  const userName = norm(ticket?.userName);
  const tenantName = norm(ticket?.tenantName);

  if (userName && PLATFORM_MONITOR_USERNAMES.includes(userName)) {
    return { lane: "platform", why: `monitor "${ticket.userName}"` };
  }
  // Suffixed forms appear in the console ("Loopcom platform — email guardrail").
  if (tenantName === PLATFORM_TENANT_NAME || tenantName.startsWith(PLATFORM_TENANT_NAME + " ")) {
    return { lane: "platform", why: `company "${ticket.tenantName}"` };
  }
  return { lane: "customer", why: "no platform marker — treated as a person" };
}

export const DEFAULTS = Object.freeze({
  customerCap: 10,
  platformCap: 3,
  platformEnabled: true,
  /** A run that has not settled in this long is presumed dead and requeued once. */
  staleRunMs: 30 * 60 * 1000,
  /** ⛔ Bounded on purpose. Requeue-once recovers a crash; requeue-forever is a loop. */
  maxAttempts: 2,
});

/** Runs actually STARTED today, per lane. */
export function startedToday(state, day, lane) {
  return Object.values(state?.claimed ?? {}).filter(
    (c) =>
      // ⛔⛔ `status` MUST be tested. The first version counted every entry with
      // today's date, and backfill-skips write today's date — so a first run on
      // a queue of 20 tickets recorded 20 skips, read the cap as blown, and
      // deferred every REAL ticket that arrived afterwards. The feature would
      // have looked switched-on and quietly done nothing.
      c && c.status !== "skipped_pre_existing" && c.status !== "skipped_lane_off" &&
      String(c.at ?? "").slice(0, 10) === day &&
      (lane ? c.lane === lane : true),
  ).length;
}

/**
 * The whole decision for one ticket.
 * Returns { action, lane, why } where action is one of:
 *   work | skip_claimed | skip_pre_existing | skip_lane_off | defer_cap | requeue
 */
export function decideTicket({ ticket, state, now, cfg = {}, watchingSince }) {
  const c = { ...DEFAULTS, ...cfg };
  const ref = String(ticket?.reference ?? "").trim();
  if (!ref) return { action: "skip_claimed", lane: "customer", why: "ticket has no reference" };

  const { lane, why } = classifyTicket(ticket);
  const prior = state?.claimed?.[ref];
  const day = new Date(now).toISOString().slice(0, 10);

  if (prior) {
    // ⛔ A run killed mid-flight (reboot, Ctrl-C, a hung agent) leaves "running"
    // forever, and the old code then skipped that ticket for good — a customer's
    // request lost in silence. Recover it ONCE.
    const stale =
      prior.status === "running" &&
      now - new Date(prior.at ?? 0).getTime() > c.staleRunMs &&
      (prior.attempts ?? 1) < c.maxAttempts;
    if (stale) return { action: "requeue", lane, why: "previous run never finished" };
    return { action: "skip_claimed", lane, why: `already ${prior.status}` };
  }

  if (lane === "platform" && !c.platformEnabled) {
    return { action: "skip_lane_off", lane, why: "platform lane is switched off" };
  }

  const createdAt = new Date(ticket?.createdAt ?? 0).getTime();
  if (watchingSince && Number.isFinite(createdAt) && createdAt < new Date(watchingSince).getTime()) {
    return { action: "skip_pre_existing", lane, why: "raised before the watcher started" };
  }

  // ⛔ The caps are INDEPENDENT. That is the entire point of having lanes: a
  // night of alarms must not be able to consume the budget a customer needs.
  const cap = lane === "platform" ? c.platformCap : c.customerCap;
  if (startedToday(state, day, lane) >= cap) {
    return { action: "defer_cap", lane, why: `${lane} cap ${cap}/day reached` };
  }

  return { action: "work", lane, why };
}
