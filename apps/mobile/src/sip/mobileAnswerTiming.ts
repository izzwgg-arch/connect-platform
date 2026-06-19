/**
 * Centralized mobile inbound-answer timing knobs.
 *
 * Initial wait covers register + first INVITE poll. Post-accept extension covers
 * the telephony AMI requeue window (backend ACCEPT → fresh PJSIP leg).
 */

/** Poll window before backend ACCEPT completes (register + early INVITE). */
export const MOBILE_SIP_ANSWER_INITIAL_WAIT_MS = 8_000;

/**
 * Pre-claim grace for the inbound answer pipeline.
 *
 * Why this is small (regression fix 2026-06-19)
 * ---------------------------------------------
 * On this deployment the PBX does NOT push the INVITE to the registered mobile
 * endpoint on its own — the INVITE only arrives AFTER the app calls the backend
 * ACCEPT (claim) endpoint, which requeues a fresh PJSIP leg. On-device traces
 * proved `newRTCSession` never fires before the claim and `wait_for_incoming_invite`
 * always times out, so the historical 8 s `MOBILE_SIP_ANSWER_INITIAL_WAIT_MS`
 * pre-claim window (added 2026-06-03 in "extended SIP wait") was pure dead time
 * on EVERY answer — the dominant cause of the multi-second "sat on answering"
 * symptom. We keep only a short grace to catch a genuinely early/direct INVITE
 * (e.g. a warm second call arriving over the live socket) before claiming; once
 * it elapses the pipeline claims immediately and the post-accept window
 * (MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS) still gives the requeued leg ample
 * time to land. Register is awaited before this window is consumed, so in the
 * cold path the claim fires essentially as soon as registration completes.
 *
 * Tuned to 150 ms (2026-06-19 follow-up): registration on the answer path takes
 * ~300-600 ms, so a window this small has already elapsed by the time the
 * invite-wait runs — the claim therefore fires the instant registration
 * resolves (no residual grace), while still leaving a tiny window to catch a
 * genuinely direct INVITE on a warm socket (e.g. a second call) before claiming.
 */
export const MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS = 150;

/** Extra poll time after backend ACCEPT when no session exists yet (requeue in flight). */
export const MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS = 16_000;

/** Hard cap for a single answer attempt (initial + extensions). */
export const MOBILE_SIP_ANSWER_MAX_WAIT_MS = 30_000;

/** JsSIP findIncoming poll interval — keep in sync with jssip.ts. */
export const MOBILE_SIP_ANSWER_POLL_MS = 15;

/** Mutable deadline used by JsSIP answerIncoming — extend after backend ACCEPT. */
export type SipAnswerDeadlineHandle = {
  extend(extraMs: number): void;
  getUntilMs(): number;
};

export function createSipAnswerDeadline(
  answerStartAt: number,
  initialTimeoutMs: number,
): { handle: SipAnswerDeadlineHandle; hardCapMs: number } {
  const hardCapMs = answerStartAt + MOBILE_SIP_ANSWER_MAX_WAIT_MS;
  // Floor at 100 ms (was 500): the inbound answer path now intentionally uses a
  // ~150 ms pre-claim grace (MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS) so the backend
  // claim fires the instant registration resolves. A 500 ms floor would re-add
  // ~150-350 ms of dead wait on every answer. Callers that need a longer window
  // (e.g. MOBILE_SIP_ANSWER_INITIAL_WAIT_MS = 8 s) pass it explicitly and are
  // unaffected by this lower floor.
  let untilMs = Math.min(
    hardCapMs,
    answerStartAt + Math.max(100, initialTimeoutMs),
  );
  const handle: SipAnswerDeadlineHandle = {
    extend(extraMs: number) {
      const candidate = Date.now() + Math.max(0, extraMs);
      if (candidate > untilMs) {
        untilMs = Math.min(candidate, hardCapMs);
      }
    },
    getUntilMs() {
      return untilMs;
    },
  };
  return { handle, hardCapMs };
}
