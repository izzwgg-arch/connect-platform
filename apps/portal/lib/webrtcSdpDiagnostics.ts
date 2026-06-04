/**
 * WebRTC outbound SDP diagnostics (portal softphone).
 *
 * Pure, side-effect-free helpers used to diagnose the outbound
 * "488 / Incompatible SDP" WebRTC calling failure. These DO NOT mutate or
 * munge any SDP — they only read an offer and summarize it so the exact
 * rejected attribute/codec can be proven before any media-config fix.
 *
 * See docs/ai-context/WEBRTC_DIAGNOSTICS.md
 * ("Incident: WebRTC OUTBOUND fails — 488 / Incompatible SDP").
 */

/** SIP final response codes that JsSIP maps to cause `INCOMPATIBLE_SDP`. */
export const SDP_REJECT_SIP_CODES = [488, 606] as const;

/** A non-secret, copy-pasteable summary of a WebRTC offer SDP. */
export type SdpOfferSummary = {
  /** Transport profiles on each `m=` line, e.g. `UDP/TLS/RTP/SAVPF`. */
  profiles: string[];
  /** rtpmap names on the first `m=audio` block, e.g. `opus/48000/2`, `PCMU/8000`. */
  audioCodecs: string[];
  hasOpus: boolean;
  /** PCMU (payload 0) — G.711 µ-law. */
  hasPcmu: boolean;
  /** PCMA (payload 8) — G.711 a-law. */
  hasPcma: boolean;
  hasRtcpMux: boolean;
  hasBundle: boolean;
  hasDtlsFingerprint: boolean;
  /** `a=setup:` value — actpass / active / passive — or null. */
  dtlsSetup: string | null;
  hasIceUfrag: boolean;
  hasIcePwd: boolean;
  mLineCount: number;
  audioMLineCount: number;
  extmapCount: number;
};

function lines(sdp: string): string[] {
  return String(sdp || "").split(/\r\n|\r|\n/);
}

/**
 * Summarize a WebRTC offer SDP into non-secret fields. Never throws.
 * ICE ufrag/pwd and DTLS fingerprints are reported as booleans/flags only —
 * their raw values are ephemeral but we still avoid emitting them here.
 */
export function summarizeOfferSdp(sdp: string): SdpOfferSummary {
  const ls = lines(sdp);
  const profiles: string[] = [];
  const audioCodecs: string[] = [];
  let mLineCount = 0;
  let audioMLineCount = 0;
  let extmapCount = 0;
  let inFirstAudio = false;
  let seenFirstAudio = false;

  for (const raw of ls) {
    const line = raw.trim();
    if (line.startsWith("m=")) {
      mLineCount += 1;
      const parts = line.slice(2).split(/\s+/); // <media> <port> <proto> <fmt...>
      const media = parts[0] || "";
      const proto = parts[2] || "";
      if (proto) profiles.push(proto);
      const isAudio = media === "audio";
      if (isAudio) audioMLineCount += 1;
      // Track only the FIRST audio m-section for codec listing.
      inFirstAudio = isAudio && !seenFirstAudio;
      if (inFirstAudio) seenFirstAudio = true;
      continue;
    }
    if (inFirstAudio && line.startsWith("a=rtpmap:")) {
      const v = line.slice("a=rtpmap:".length).split(/\s+/)[1];
      if (v) audioCodecs.push(v);
    }
    if (line.startsWith("a=extmap:")) extmapCount += 1;
  }

  const lower = String(sdp || "").toLowerCase();
  const codecsLower = audioCodecs.map((c) => c.toLowerCase());
  const setupMatch = ls.map((l) => l.trim()).find((l) => l.startsWith("a=setup:"));

  return {
    profiles,
    audioCodecs,
    hasOpus: codecsLower.some((c) => c.startsWith("opus")),
    hasPcmu: codecsLower.some((c) => c.startsWith("pcmu")),
    hasPcma: codecsLower.some((c) => c.startsWith("pcma")),
    hasRtcpMux: lower.includes("a=rtcp-mux"),
    hasBundle: lower.includes("a=group:bundle"),
    hasDtlsFingerprint: lower.includes("a=fingerprint:"),
    dtlsSetup: setupMatch ? setupMatch.slice("a=setup:".length).trim() : null,
    hasIceUfrag: lower.includes("a=ice-ufrag:"),
    hasIcePwd: lower.includes("a=ice-pwd:"),
    mLineCount,
    audioMLineCount,
    extmapCount,
  };
}

/** True when a SIP failure is a WebRTC SDP/media rejection (488/606 or cause text). */
export function isWebrtcSdpRejection(input: {
  sipCode?: number | null;
  cause?: string | null;
}): boolean {
  const code = typeof input.sipCode === "number" ? input.sipCode : null;
  if (code != null && (SDP_REJECT_SIP_CODES as readonly number[]).includes(code)) return true;
  const cause = String(input.cause || "").toLowerCase();
  return cause.includes("incompatible sdp") || cause.includes("not acceptable here");
}

/** Stable label for diagnostics/telemetry, e.g. `WEBRTC_SDP_REJECT_488`. */
export function sdpRejectionLabel(sipCode?: number | null): string {
  return typeof sipCode === "number"
    ? `WEBRTC_SDP_REJECT_${sipCode}`
    : "WEBRTC_SDP_REJECT";
}

/**
 * Hardening guard: flag offer shapes Asterisk WebRTC endpoints reject.
 * Returns a list of human-readable problems (empty = looks compatible).
 * This does NOT decide the fix — it surfaces likely-incompatible offers so a
 * regression can't ship silently. The authoritative cause is still the live
 * Asterisk 488 + this summary.
 */
export function checkOfferCompatibility(summary: SdpOfferSummary): string[] {
  const issues: string[] = [];
  if (summary.audioMLineCount === 0) {
    issues.push("no m=audio section in offer");
  }
  if (summary.audioCodecs.length > 0 && !summary.hasOpus && !summary.hasPcmu && !summary.hasPcma) {
    issues.push("offer has no opus/PCMU/PCMA — no codec Asterisk allow-list accepts");
  }
  if (summary.profiles.length > 0 && !summary.profiles.some((p) => p.includes("SAVPF") || p.includes("SAVP"))) {
    issues.push(`non-secure media profile(s): ${summary.profiles.join(",")} (expected UDP/TLS/RTP/SAVPF for webrtc=yes)`);
  }
  if (!summary.hasDtlsFingerprint) {
    issues.push("missing a=fingerprint (DTLS) — required by media_encryption=dtls endpoint");
  }
  if (!summary.hasIceUfrag || !summary.hasIcePwd) {
    issues.push("missing ICE ufrag/pwd");
  }
  if (!summary.hasRtcpMux) {
    issues.push("missing a=rtcp-mux (endpoint has rtcp_mux=yes)");
  }
  return issues;
}

/**
 * Redact ICE credentials and candidate host addresses from an SDP before it is
 * logged/stored/downloaded. Keeps everything needed to diagnose a 488 (codecs,
 * fmtp, profile, rtcp-mux, BUNDLE, DTLS fingerprint+setup) — the DTLS
 * fingerprint is public and intentionally retained.
 */
export function redactSdpForDebug(sdp: string): string {
  return String(sdp || "")
    .replace(/^(a=ice-ufrag:).*$/gim, "$1[REDACTED]")
    .replace(/^(a=ice-pwd:).*$/gim, "$1[REDACTED]")
    // Mask raw IPv4/IPv6 host addresses in candidate lines (network info, not
    // needed for SDP/codec diagnosis); keep the rest of the candidate line.
    .replace(/^(a=candidate:.*)$/gim, (line) =>
      line
        .replace(/(\d{1,3}\.){3}\d{1,3}/g, "x.x.x.x")
        .replace(/\b([0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F:]+\b/g, "x:x:x"))
    .replace(/^(c=IN IP4 ).*$/gim, "$1x.x.x.x");
}

/**
 * Operator opt-in for verbose WebRTC SDP debug capture (portal only). Enabled by
 * any of: dev build, `?webrtcDebug` query param, or `localStorage
 * cc_webrtc_sdp_debug=1`. Gated so it never runs for normal production users.
 */
export function webrtcSdpDebugEnabled(): boolean {
  try {
    if (typeof window === "undefined") return false;
    if (process.env.NODE_ENV === "development") return true;
    if (window.localStorage?.getItem("cc_webrtc_sdp_debug") === "1") return true;
    const qs = new URLSearchParams(window.location.search);
    return qs.has("webrtcDebug") || qs.get("debug") === "webrtc";
  } catch {
    return false;
  }
}
