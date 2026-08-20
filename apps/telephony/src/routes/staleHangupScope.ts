/**
 * Scope rules for POST /telephony/calls/stale-hangup-for-extension.
 *
 * ⛔⛔ THIS DECIDES WHICH LIVE CALLS GET HUNG UP. Read before changing anything.
 *
 * THE DEFECT THIS EXISTS TO PREVENT (proven live, Trust Bookkeepings ext 106,
 * 2026-08-20):
 * The portal fires this route 10 s after a user presses hangup, as a last-resort
 * cleanup for a call the PBX never sent an AMI Hangup for. It used to select its
 * victims by EXTENSION NUMBER — and an extension is shared by several devices:
 *
 *     PJSIP/T18_106      ← the DESK PHONE
 *     PJSIP/T18_106_1    ← the portal / web app
 *
 * So a portal user hanging up their own call scheduled a sweep that, ten seconds
 * later, hung up the DESK PHONE's live, answered, bridged call — and any other
 * call the extension had going. Every one of the 7 force-hangups found in the
 * telephony log was a `PJSIP/T18_106-…` desk channel; not one was the portal's
 * own `T18_106_1`. To the customer this is "I was talking and the call just
 * dropped", with nothing wrong on the PBX.
 *
 * THE RULES
 *  1. The caller MUST identify its own PJSIP endpoint (`sipUsername`). No
 *     endpoint → evict NOTHING. Fails closed on purpose: not running leaves a
 *     stale row in the live-calls list (cosmetic); running too broadly cuts off
 *     a customer mid-sentence (not recoverable).
 *  2. A call is a candidate only if that endpoint is one of its LIVE channels.
 *     `call.channels` is pruned on Hangup, so a losing ring leg (an inbound call
 *     that rang both devices and was answered on the desk) correctly does NOT
 *     match the app.
 *  3. The call must predate the stated hangup by ≥2 s, so a call dialled during
 *     the 10 s wait is never swept.
 *
 * ⛔ Never reintroduce a match on the extension number, `from`, or `to` — those
 * are all shared by every device on the extension, which is the whole bug.
 */

/** A live call, reduced to just what the scope decision needs. */
export type StaleHangupCandidate = {
  id: string;
  tenantId?: string | null;
  /** LIVE channels only (pruned on Hangup), e.g. ["PJSIP/T18_106_1-00000939"]. */
  channels: string[];
  startedAt?: string | Date | null;
};

export type StaleHangupScopeInput = {
  /** The caller's own PJSIP endpoint, e.g. "T18_106_1". */
  sipUsername?: unknown;
  /** ISO timestamp of the hangup the sweep is following up on. */
  hangupAt?: unknown;
  /** Tenant of the requesting session, or null for internal callers. */
  tenantId?: string | null;
};

export type StaleHangupScopeDecision =
  | { evict: false; reason: "sip_username_required" }
  | { evict: true; targets: StaleHangupCandidate[] };

/** A call must predate the hangup by this much to be considered stale. */
export const STALE_HANGUP_MIN_AGE_MS = 2_000;

/**
 * Does `channel` belong to `endpoint`?
 *
 * Asterisk channel names are `<tech>/<endpoint>-<hex sequence>`, e.g.
 * `PJSIP/T18_106_1-00000939`. The endpoint is matched WHOLE — a prefix match
 * would make the desk phone's `T18_106` match the app's `T18_106_1` and
 * resurrect the exact bug this module exists to prevent.
 */
export function isChannelForEndpoint(channel: string, endpoint: string): boolean {
  if (!channel || !endpoint) return false;
  const slash = channel.indexOf("/");
  const bare = slash >= 0 ? channel.slice(slash + 1) : channel;
  const dash = bare.lastIndexOf("-");
  const channelEndpoint = dash > 0 ? bare.slice(0, dash) : bare;
  return channelEndpoint === endpoint;
}

/**
 * Decide which live calls this stale-hangup request may hang up.
 * Returns `{ evict: false }` when the request cannot be scoped to one device.
 */
export function decideStaleHangupTargets(
  input: StaleHangupScopeInput,
  activeCalls: StaleHangupCandidate[],
): StaleHangupScopeDecision {
  const endpoint =
    typeof input.sipUsername === "string" ? input.sipUsername.trim() : "";
  if (!endpoint) return { evict: false, reason: "sip_username_required" };

  const hangupTs =
    typeof input.hangupAt === "string" ? new Date(input.hangupAt).getTime() : 0;
  const hasHangupTs = Number.isFinite(hangupTs) && hangupTs > 0;

  const targets = activeCalls.filter((call) => {
    if (input.tenantId && call.tenantId && call.tenantId !== input.tenantId) {
      return false;
    }
    // ⛔ The load-bearing check. Only a call this very device is still on.
    if (!call.channels.some((ch) => isChannelForEndpoint(ch, endpoint))) {
      return false;
    }
    if (hasHangupTs && call.startedAt) {
      const startedMs = new Date(call.startedAt).getTime();
      if (!Number.isFinite(startedMs)) return false;
      if (startedMs > hangupTs - STALE_HANGUP_MIN_AGE_MS) return false;
    }
    return true;
  });

  return { evict: true, targets };
}

// ── Layer 2: Asterisk is the only authority on whether a call is real ───────
//
// ⛔⛔ THE LESSON THIS ENCODES, measured over 14 days of nginx logs:
// the client-triggered sweep ran 303 times and "cleared" something 9 times —
// and ALL NINE ended a real, answered, talking call (103 s, 551 s, 180 s, …;
// 13 conversations across Fixup Group, Gesheft and Trust Bookkeepings). It
// never once cleaned up a genuine ghost, because 242 of the other sweeps
// answered "already gone" — the normal AMI Hangup path and the ARI reconciler
// had beaten it to every real ghost.
//
// The reason it could do that is that NOTHING in the path ever checked whether
// the call was stale. It ran on `callStore.getActive()`, which by definition
// returns calls that are UP and properly bridged with live participants, and
// hung them up on the client's word alone.
//
// `CallStateStore.reconcileLiveChannels` already had the right answer and the
// scar tissue to prove it ("265 evictions on Aug 3; a Gesheft call was killed
// 40 s into a talk"): a call is dead ONLY when none of its channels exist in
// ARI's raw /channels snapshot. This applies the same rule here.

/** ARI's raw `/channels` snapshot, reduced to what the liveness check needs. */
export type AsteriskLiveSnapshot = {
  /** Channel `id` values — i.e. Asterisk uniqueids. */
  ids: Set<string>;
  /** Channel `name` values, e.g. "PJSIP/T18_106-0000093b". */
  names: Set<string>;
};

/**
 * Does Asterisk still have this call?
 *
 * ⛔ Fails toward "YES, it is live" — an unknown answer must never license a
 * teardown. A call is only considered gone when NOT ONE of its uniqueids and
 * NOT ONE of its channel names appears in the snapshot.
 */
export function isCallLiveInAsterisk(
  call: { channels: string[] },
  uniqueIds: string[],
  live: AsteriskLiveSnapshot,
): boolean {
  if (uniqueIds.some((uid) => live.ids.has(uid))) return true;
  for (const name of call.channels) {
    if (live.names.has(name)) return true;
    // Local channels appear as "…;1"/"…;2" halves of the recorded name.
    for (const liveName of live.names) {
      if (liveName.startsWith(`${name};`)) return true;
    }
  }
  return false;
}
