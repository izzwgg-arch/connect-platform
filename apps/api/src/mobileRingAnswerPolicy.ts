/**
 * Decides whether an `answered_elsewhere` stop-ringing sweep is looking at an
 * invite that was fulfilled BY ITS OWN APP — in which case the invite must be
 * marked ACCEPTED and NO cancel push may be sent to that user.
 *
 * ⛔⛔ WHY THIS EXISTS — Hanna's dropped answers, 2026-08-21. A cold-start
 * lock-screen answer sends its SIP 200 OK over the already-open socket while
 * the HTTPS claim of the CallInvite crawls over a lossy cellular link and
 * loses the race. Telephony then reports the answered call as
 * `answered_elsewhere` (a feature built for desk-phone answers), the api
 * cancels the still-PENDING invite and pushes INVITE_CANCELED to ALL of the
 * user's devices — including the phone that just answered — and the app's
 * cancel handler tears down the live, audible call 3–4 s after connect,
 * stamping it `user_hangup`. Proven with a control: the one answer whose
 * claim landed first was never canceled and survived. Full detail:
 * docs/ai-context/AGENT_HANDOFF_HANNA_FIRST_CALLS_2026-08-21.md §3.
 *
 * ⛔ THE RULE: only the APP/WebRTC device endpoint (`T<t>_<ext>_<n>` — with a
 * device suffix) fulfils an invite. A DESK phone answering (`T<t>_<ext>`, no
 * suffix) must still cancel-push the apps — that is the original 2026-07-29
 * feature ("they answer the phone and the app still rings") and it stays.
 *
 * ⛔ Matching is by EXTENSION within the same call (the invite list is already
 * scoped to one pbxCallId), so a ring-group sibling invite to another
 * extension is still canceled when this one's app answers.
 */

/** `PJSIP/T141_101_1-0000125e` → `T141_101_1`; null for anything else. */
export function endpointFromChannel(channel: string | null | undefined): string | null {
  const m = /^PJSIP\/(T\d+_\d+(?:_\d+)?)-/i.exec(String(channel ?? ""));
  return m ? m[1] : null;
}

/**
 * True when `answeredEndpoint` is the invited extension's own APP/WebRTC
 * device endpoint — i.e. the "elsewhere" is actually the invited app itself.
 */
export function inviteFulfilledByOwnApp(
  answeredEndpoint: string | null | undefined,
  inviteToExtension: string | null | undefined,
): boolean {
  const ep = String(answeredEndpoint ?? "").trim();
  const ext = String(inviteToExtension ?? "").trim();
  if (!ep || !ext) return false;
  // App/WebRTC device endpoints carry a device suffix: T<tenant>_<ext>_<n>.
  const m = /^T\d+_(\d+)_\d+$/i.exec(ep);
  if (!m) return false; // desk phone (no suffix) or anything unrecognised
  return m[1] === ext;
}
