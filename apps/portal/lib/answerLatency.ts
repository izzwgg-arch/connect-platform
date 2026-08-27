/**
 * Answer-latency instrumentation for the web softphone.
 *
 * ⛔⛔ WHY THIS EXISTS, AND WHY IT MEASURES RATHER THAN FIXES.
 * Gesheft ext 101 reports that answering on the computer "works on and off"
 * (tickets Q2FJRK 2026-08-24, QP7APH 2026-08-27). The mechanism is now known
 * from JsSIP's own source: on an inbound answer `request.reply(200, …)` sets
 * `STATUS_WAITING_FOR_ACK` and fires **`accepted`** — before any ACK — and the
 * portal binds `accepted` straight to "connected". So when the ACK never
 * arrives on a rebuilt socket the UI shows a CONNECTED call with no media for
 * TIMER_H (64 × T1 = ~32 s), after which JsSIP sends BYE and fires `ended`
 * with cause **NO_ACK**.
 *
 * ⛔ That cause is thrown away today: `session.on("ended", () => …)` takes no
 * argument. The one signal that already exists is discarded, which is why this
 * failure has never appeared in any dashboard.
 *
 * ⛔⛔ THIS FILE DELIBERATELY CHANGES NO BEHAVIOUR. It starts no timer that
 * tears anything down, cancels nothing, and answers no call differently. The
 * fix — a bounded watchdog — needs a timeout, and a timeout picked without
 * knowing how long a HEALTHY answer takes would tear down calls that were about
 * to succeed. That is the exact class of mistake the standing "never propose a
 * fix without checking what it breaks" rule exists to prevent. Measure first,
 * size the number from real data, then fix.
 */

/** What we know about one answer attempt. All times are `Date.now()`. */
export interface AnswerPhases {
  tappedAt?: number;
  /** Our 200 OK was handed to the transport (JsSIP "accepted"). */
  acceptedAt?: number;
  /** Their ACK arrived (JsSIP "confirmed"). The call is genuinely up. */
  confirmedAt?: number;
}

export type AnswerOutcome =
  | "confirmed"
  /** We answered, they never acknowledged — the Gesheft failure. */
  | "answered_never_confirmed"
  /** Ended before we ever sent a 200 OK (declined, caller gave up, etc). */
  | "ended_before_answer";

export interface AnswerLatencyReport {
  outcome: AnswerOutcome;
  /** Tap → 200 OK sent. Measures OUR side. */
  msTapToAccepted: number | null;
  /** Tap → ACK received. The number a future watchdog timeout must clear. */
  msTapToConfirmed: number | null;
  /** 200 OK → ACK. Measures the NETWORK round trip, which is what fails here. */
  msAcceptedToConfirmed: number | null;
  /** How long the doomed call sat looking connected. */
  msAnsweredWithoutAck: number | null;
  /** JsSIP's own cause on `ended` — "NO_ACK" is the one that matters. */
  endedCause: string | null;
  /** Which of the portal's two answer paths this was. */
  path: "primary" | "multicall";
}

/**
 * ⛔ Only an attempt the USER actually answered is worth reporting. A call that
 * rang and was never answered has no latency to measure, and reporting those
 * would bury the handful of real failures under every missed call.
 */
export function buildAnswerLatencyReport(
  phases: AnswerPhases,
  endedCause: string | null,
  path: "primary" | "multicall",
): AnswerLatencyReport | null {
  if (!phases.tappedAt) return null;

  const msTapToAccepted = phases.acceptedAt != null ? phases.acceptedAt - phases.tappedAt : null;
  const msTapToConfirmed = phases.confirmedAt != null ? phases.confirmedAt - phases.tappedAt : null;
  const msAcceptedToConfirmed =
    phases.acceptedAt != null && phases.confirmedAt != null ? phases.confirmedAt - phases.acceptedAt : null;

  if (phases.confirmedAt != null) {
    return { outcome: "confirmed", msTapToAccepted, msTapToConfirmed, msAcceptedToConfirmed, msAnsweredWithoutAck: null, endedCause, path };
  }
  if (phases.acceptedAt != null) {
    // ⛔ THE FAILURE. We sent 200 OK, the UI said connected, and no ACK ever
    // came. `msAnsweredWithoutAck` is how long the customer sat on a dead call
    // believing it was up — the number that turns "works on and off" into a
    // measurement.
    return {
      outcome: "answered_never_confirmed",
      msTapToAccepted,
      msTapToConfirmed: null,
      msAcceptedToConfirmed: null,
      msAnsweredWithoutAck: null,
      endedCause,
      path,
    };
  }
  return { outcome: "ended_before_answer", msTapToAccepted: null, msTapToConfirmed: null, msAcceptedToConfirmed: null, msAnsweredWithoutAck: null, endedCause, path };
}

/** Fills `msAnsweredWithoutAck` when we know when it ended. */
export function withEndedAt(report: AnswerLatencyReport, phases: AnswerPhases, endedAt: number): AnswerLatencyReport {
  if (report.outcome !== "answered_never_confirmed" || phases.acceptedAt == null) return report;
  return { ...report, msAnsweredWithoutAck: endedAt - phases.acceptedAt };
}

/**
 * Per-session phase store. A WeakMap so a session object going out of scope
 * takes its entry with it — no cleanup path to forget, and nothing to leak on a
 * client that stays open for days.
 */
export class AnswerLatencyTracker {
  private readonly phases = new WeakMap<object, AnswerPhases>();
  private readonly reported = new WeakSet<object>();

  tap(session: object, at: number = Date.now()): void {
    this.phases.set(session, { tappedAt: at });
  }
  accepted(session: object, at: number = Date.now()): void {
    const p = this.phases.get(session);
    if (p && p.acceptedAt == null) p.acceptedAt = at;
  }
  confirmed(session: object, at: number = Date.now()): void {
    const p = this.phases.get(session);
    if (p && p.confirmedAt == null) p.confirmedAt = at;
  }
  get(session: object): AnswerPhases | undefined {
    return this.phases.get(session);
  }
  /**
   * ⛔ At most ONE report per session, ever. A hung session can be ended more
   * than once (BYE plus a local teardown), and a duplicate would both waste the
   * 60-per-minute event budget and double-count the failure being measured.
   */
  finish(session: object, endedCause: string | null, path: "primary" | "multicall", at: number = Date.now()): AnswerLatencyReport | null {
    if (this.reported.has(session)) return null;
    const p = this.phases.get(session);
    if (!p) return null;
    const base = buildAnswerLatencyReport(p, endedCause, path);
    if (!base) return null;
    this.reported.add(session);
    return withEndedAt(base, p, at);
  }
}
