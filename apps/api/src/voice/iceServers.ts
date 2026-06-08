/**
 * ICE / TURN server provisioning — single source of truth for what the
 * browser/mobile softphone receives as its RTCPeerConnection iceServers list.
 *
 * Why this module exists (incident 2026-06-08):
 *   The softphone was being handed a single UDP-only relay URL
 *   (`turn:<ip>:3478`). On networks that block UDP to non-standard ports
 *   (mobile carriers / 4G, restrictive corporate firewalls) the browser
 *   could not allocate a TURN relay, so media fell back to a direct path
 *   and produced one-way / no audio with no fallback. A remote 4G user in
 *   the Philippines hit this on every call for over a week with no alert.
 *
 *   These helpers guarantee the delivered ICE config always includes a
 *   TCP and/or TLS relay fallback whenever TURN is enabled, and they are
 *   pure (no DB / no env access) so they can be unit-tested and used by a
 *   startup guard.
 */
import { createHmac } from "node:crypto";

export type IceServer = { urls: string; username?: string; credential?: string };

export type TurnCredentials = { username: string; credential: string };

export const DEFAULT_TURN_CRED_TTL_SECS = 86400;

/**
 * Short-lived HMAC TURN credentials for CoTURN `use-auth-secret` mode.
 * username = "<expiry_unix_ts>", password = base64(HMAC-SHA1(secret, username)).
 */
export function generateTurnCredentials(
  secret: string,
  ttlSecs: number = DEFAULT_TURN_CRED_TTL_SECS,
  nowMs: number = Date.now(),
): TurnCredentials {
  const expiry = Math.floor(nowMs / 1000) + ttlSecs;
  const username = String(expiry);
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential };
}

function flattenUrls(urls: unknown): string[] {
  if (Array.isArray(urls)) return urls.map((u) => String(u || "").trim()).filter(Boolean);
  const s = String(urls || "").trim();
  return s ? [s] : [];
}

/** Lower-cased scheme of an ICE url, e.g. "turn", "turns", "stun". */
function urlScheme(url: string): string {
  const m = /^([a-z]+):/i.exec(url.trim());
  return m ? m[1].toLowerCase() : "";
}

/** transport= query value of a turn/turns url; defaults to "udp" per RFC. */
function urlTransport(url: string): "udp" | "tcp" {
  const m = /[?&]transport=([a-z]+)/i.exec(url);
  return m && m[1].toLowerCase() === "tcp" ? "tcp" : "udp";
}

export type IceTransportSummary = {
  hasStun: boolean;
  /** plain `turn:` over UDP (incl. no explicit transport) */
  hasTurnUdp: boolean;
  /** plain `turn:` over TCP */
  hasTurnTcp: boolean;
  /** `turns:` (TLS) — works through firewalls that only allow TLS/443-style egress */
  hasTurnsTls: boolean;
  turnCount: number;
};

export function classifyIceServers(iceServers: ReadonlyArray<IceServer | { urls?: unknown }>): IceTransportSummary {
  const summary: IceTransportSummary = {
    hasStun: false,
    hasTurnUdp: false,
    hasTurnTcp: false,
    hasTurnsTls: false,
    turnCount: 0,
  };
  for (const entry of iceServers || []) {
    for (const url of flattenUrls((entry as { urls?: unknown })?.urls)) {
      const scheme = urlScheme(url);
      if (scheme === "stun" || scheme === "stuns") {
        summary.hasStun = true;
      } else if (scheme === "turns") {
        summary.turnCount += 1;
        summary.hasTurnsTls = true;
      } else if (scheme === "turn") {
        summary.turnCount += 1;
        if (urlTransport(url) === "tcp") summary.hasTurnTcp = true;
        else summary.hasTurnUdp = true;
      }
    }
  }
  return summary;
}

export class IceFallbackError extends Error {
  readonly code = "ICE_CONFIG_NO_RELAY_FALLBACK";
  readonly summary: IceTransportSummary;
  constructor(message: string, summary: IceTransportSummary) {
    super(message);
    this.name = "IceFallbackError";
    this.summary = summary;
  }
}

/**
 * Guard: when TURN is enabled the client MUST be given a relay path that can
 * survive UDP-blocking networks — i.e. at least one TCP or TLS relay URL.
 * A UDP-only relay list is treated as a misconfiguration and throws.
 *
 * Returns the transport summary when the config is acceptable.
 */
export function assertIceServersHaveRelayFallback(
  iceServers: ReadonlyArray<IceServer | { urls?: unknown }>,
  opts: { turnEnabled: boolean },
): IceTransportSummary {
  const summary = classifyIceServers(iceServers);
  if (!opts.turnEnabled) return summary;
  if (summary.turnCount === 0) {
    throw new IceFallbackError(
      "TURN is enabled but no relay (turn:/turns:) URLs are delivered to clients",
      summary,
    );
  }
  if (!summary.hasTurnTcp && !summary.hasTurnsTls) {
    throw new IceFallbackError(
      "TURN relay is UDP-only — no TCP/TLS fallback. Clients on UDP-blocking networks (mobile/4G) cannot establish media.",
      summary,
    );
  }
  return summary;
}

/**
 * Expand a bare TURN host (e.g. "45.14.194.179" or "turn.example.com") into the
 * canonical multi-transport relay URL set: UDP + TCP on the standard port. Pass
 * an already-qualified `turn:`/`turns:` URL through unchanged.
 */
export function expandTurnHostToUrls(hostOrUrl: string, port = 3478): string[] {
  const raw = String(hostOrUrl || "").trim();
  if (!raw) return [];
  if (/^turns?:/i.test(raw)) return [raw];
  // strip an accidental scheme-less port suffix like "host:3478"
  const host = raw.replace(/:\d+$/, "");
  return [
    `turn:${host}:${port}?transport=udp`,
    `turn:${host}:${port}?transport=tcp`,
  ];
}

export type BuildIceServersInput = {
  /** STUN urls, e.g. ["stun:stun.l.google.com:19302"]. */
  stunUrls: string[];
  /** Normalized turn:/turns: urls (already include ?transport= when relevant). */
  turnUrls: string[];
  /** HMAC shared secret (CoTURN use-auth-secret). Preferred over static creds. */
  authSecret?: string | null;
  /** Legacy static credentials, used only when authSecret is absent. */
  staticUsername?: string | null;
  staticCredential?: string | null;
  credTtlSecs?: number;
  nowMs?: number;
};

/**
 * Build the iceServers array delivered to clients. STUN entries first, then one
 * entry per TURN url with fresh HMAC credentials (or static creds as fallback).
 */
export function buildIceServers(input: BuildIceServersInput): IceServer[] {
  const out: IceServer[] = [];
  for (const stun of input.stunUrls || []) {
    const u = String(stun || "").trim();
    if (u) out.push({ urls: u });
  }
  const turnUrls = (input.turnUrls || []).map((u) => String(u || "").trim()).filter(Boolean);
  if (turnUrls.length) {
    let creds: TurnCredentials | null = null;
    if (input.authSecret) {
      creds = generateTurnCredentials(input.authSecret, input.credTtlSecs ?? DEFAULT_TURN_CRED_TTL_SECS, input.nowMs);
    }
    for (const url of turnUrls) {
      const entry: IceServer = { urls: url };
      if (creds) {
        entry.username = creds.username;
        entry.credential = creds.credential;
      } else {
        if (input.staticUsername) entry.username = input.staticUsername;
        if (input.staticCredential) entry.credential = input.staticCredential;
      }
      out.push(entry);
    }
  }
  return out;
}
