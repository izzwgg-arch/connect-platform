/**
 * Wake-dial leg resolution for the Mode-B cold-answer re-delivery (2026-08-25).
 *
 * Since the 2026-08-05 fleet rollout, a wake-enrolled extension's app fork is
 * dialed through `Local/T<pbx>_<ext>_1@connect-mobile-wake-dial/n` instead of a
 * direct `PJSIP/T<pbx>_<ext>_1` dial from a `*local-dialing*` context. Mode-B's
 * direct-extension gate (written 2026-06-29, BEFORE that context existed) never
 * learned the shape, so every wake-enrolled tenant's cold answer was refused
 * `not_direct_extension` — proven live on Fixup Group ext 103, linkedId
 * 1787609370.20746 (2026-08-24): the user tapped Answer, the fresh iPhone
 * contact was registered and visible to the registry, and the requeue refused.
 * See docs/ai-context/AGENT_HANDOFF_FIXUP_GROUP_IPHONE_2026-08-24.md §11.
 *
 * A second defect hid behind the first: `extLegAor` is captured once per call
 * from the FIRST extension-leg DialBegin, which on a desk+app extension is the
 * DESK AOR (`T31_103`) — so even with the gate fixed, the fresh-contact search
 * would look at the wrong endpoint. The wake-dial Local channel's own name
 * carries the authoritative app AOR (`T31_103_1`), the extension number and the
 * pbx code, so this module derives all three from the channel list instead.
 */

export type WakeDialLeg = {
  /** The app endpoint/AOR the wake leg dials, e.g. `T31_103_1`. */
  aor: string;
  /** The tenant pbx code, e.g. `T31` — target context is `<pbxCode>_cos-all`. */
  pbxCode: string;
  /** The extension number, e.g. `103` — the exten inside `<pbxCode>_cos-all`. */
  ext: string;
};

/**
 * Matches both halves of the wake-dial Local channel pair, e.g.
 * `Local/T31_103_1@connect-mobile-wake-dial-0000120f;1` / `...;2`.
 */
const WAKE_DIAL_CHANNEL_RE = /^Local\/((T\d+)_(\d+)_1)@connect-mobile-wake-dial-/i;

/**
 * Resolve the wake-dial leg for a call from its live channel list.
 *
 * `preferExt` is the extension the API's invite-accept requeue names
 * (`CallInvite.toExtension`, arriving as `fallbackExten`). When provided it is
 * authoritative: a wake leg for a DIFFERENT extension is never returned — with
 * several wake-enrolled extensions ringing (a ring group), redirecting on the
 * wrong one's behalf would re-dial an extension the user never answered.
 * Without it (an older API build), exactly one distinct wake AOR is accepted
 * and anything ambiguous fails closed to `null`.
 */
export function resolveWakeDialLeg(
  channels: readonly string[],
  preferExt?: string | null,
): WakeDialLeg | null {
  const byAor = new Map<string, WakeDialLeg>();
  for (const ch of channels) {
    const m = WAKE_DIAL_CHANNEL_RE.exec(String(ch ?? ""));
    if (!m) continue;
    byAor.set(m[1], { aor: m[1], pbxCode: m[2], ext: m[3] });
  }
  if (byAor.size === 0) return null;
  const want = String(preferExt ?? "").replace(/\D/g, "");
  if (want) {
    for (const leg of byAor.values()) {
      if (leg.ext === want) return leg;
    }
    return null; // the named extension has no wake leg on this call — fail closed
  }
  return byAor.size === 1 ? [...byAor.values()][0] : null;
}
