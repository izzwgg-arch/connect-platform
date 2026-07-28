/**
 * SDP munging: put Opus first in the audio codec list.
 *
 * Why: the PBX's codec profiles allow `ulaw` first (G.711 — 8 kHz narrowband,
 * the classic muffled telephone sound) with Opus also allowed. Verified live
 * 2026-07-28: app calls negotiated ulaw. Reordering our LOCAL SDP so Opus
 * leads makes the PBX pick Opus for the app leg — wideband quality on
 * extension-to-extension calls and far better packet-loss resilience
 * (in-band FEC) on mobile networks either way.
 *
 * Conservative by design: only reorders payload ids on the m=audio line —
 * never removes codecs, so if the far end can't do Opus the call falls back
 * to exactly what it negotiates today.
 */

/**
 * Strict variant for LOCAL OFFERS only: keep Opus (+ its redundancy codec and
 * telephone-event DTMF) and DROP the narrowband codecs (PCMU/PCMA/G722/CN/…)
 * from the m=audio line entirely.
 *
 * Why: verified live 2026-07-28 — our offer listed opus first, but the PBX's
 * ANSWER re-ordered to ulaw-first (`0 8 111 …`) and both sides then ran PCMU.
 * The PBX allows opus (codec_opus loaded), so an opus-only offer forces the
 * negotiation to opus and the PBX transcodes to the trunk on its side.
 * NEVER use this for answers — an answer must pick from what was offered, and
 * if the far end ever omits opus a stripped answer would kill the call. The
 * plain reorder (preferOpusInSdp) stays the answer path.
 * Fail-safe: if the SDP has no opus, this returns it untouched.
 */
export function preferOpusOnlyOffer(sdp: string): string {
  if (!sdp || typeof sdp !== "string") return sdp;

  const keepPts = new Set<string>();
  const keepRe = /^a=rtpmap:(\d+)\s+(opus|red|telephone-event)\//gim;
  let km: RegExpExecArray | null;
  let hasOpus = false;
  while ((km = keepRe.exec(sdp)) !== null) {
    keepPts.add(km[1]!);
    if (/opus/i.test(km[2]!)) hasOpus = true;
  }
  if (!hasOpus) return sdp;

  return sdp.replace(
    /^(m=audio\s+\d+\s+\S+\s+)([\d\s]+)$/im,
    (full, prefix: string, ptList: string) => {
      const kept = ptList.trim().split(/\s+/).filter((pt) => keepPts.has(pt));
      if (kept.length === 0) return full;
      return prefix + kept.join(" ");
    },
  );
}

/** Reorder the m=audio line of an SDP so Opus payload type(s) come first. */
export function preferOpusInSdp(sdp: string): string {
  if (!sdp || typeof sdp !== "string") return sdp;

  // Collect payload ids mapped to opus (case-insensitive; "opus/48000/2").
  const opusPts = new Set<string>();
  const rtpmapRe = /^a=rtpmap:(\d+)\s+opus\//gim;
  let m: RegExpExecArray | null;
  while ((m = rtpmapRe.exec(sdp)) !== null) opusPts.add(m[1]!);
  if (opusPts.size === 0) return sdp;

  // Reorder only the m=audio media line; leave everything else untouched.
  return sdp.replace(
    /^(m=audio\s+\d+\s+\S+\s+)([\d\s]+)$/im,
    (full, prefix: string, ptList: string) => {
      const pts = ptList.trim().split(/\s+/);
      const opusFirst = [
        ...pts.filter((pt) => opusPts.has(pt)),
        ...pts.filter((pt) => !opusPts.has(pt)),
      ];
      // Already leading — return unchanged to avoid touching line endings.
      if (opusFirst.join(" ") === pts.join(" ")) return full;
      return prefix + opusFirst.join(" ");
    },
  );
}
