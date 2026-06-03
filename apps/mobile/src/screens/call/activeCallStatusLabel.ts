/**
 * Active-call status label — pure helper for UI + tests.
 * CONNECTED requires real SIP connected state, not answer-handoff alone.
 */

export function activeCallStatusLabel(input: {
  isEnded: boolean;
  isHoldState: boolean;
  isAnswerInFlight: boolean;
  callState: string;
}): string {
  if (input.isEnded) return "CALL ENDED";
  if (input.isHoldState) return "ON HOLD";
  if (input.isAnswerInFlight) return "ANSWERING…";
  if (input.callState === "connected") return "CONNECTED";
  if (input.callState === "dialing") return "CALLING…";
  if (input.callState === "ringing") return "RINGING…";
  return "CONNECTING…";
}
