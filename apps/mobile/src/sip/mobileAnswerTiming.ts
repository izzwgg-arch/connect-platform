/**
 * Centralized mobile inbound-answer timing knobs.
 *
 * Initial wait covers register + first INVITE poll. Post-accept extension covers
 * the telephony AMI requeue window (backend ACCEPT → fresh PJSIP leg).
 */

/** Poll window before backend ACCEPT completes (register + early INVITE). */
export const MOBILE_SIP_ANSWER_INITIAL_WAIT_MS = 8_000;

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
  let untilMs = Math.min(
    hardCapMs,
    answerStartAt + Math.max(500, initialTimeoutMs),
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
