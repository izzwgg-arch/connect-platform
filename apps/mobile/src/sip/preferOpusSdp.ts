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
