/** WebRTC/mobile SIP identity fields from a PbxExtensionLink row. */
export type WebrtcPbxLinkIdentity = {
  pbxSipUsername?: string | null;
  pbxDeviceName?: string | null;
};

/**
 * Resolve SIP URI + digest auth usernames for WebRTC/mobile provisioning.
 * VitalPBX WebRTC endpoints register against the device name (e.g. T25_101_1),
 * not the shorter device user field (e.g. 101_1). When pbxDeviceName is present,
 * both sipUsername and authUsername must use it so JsSIP From/To matches the PBX AOR.
 */
export function resolveWebrtcSipIdentity(pbxLink: WebrtcPbxLinkIdentity): {
  sipUsername: string;
  authUsername: string;
} {
  const deviceName = String(pbxLink.pbxDeviceName ?? "").trim();
  const sipUser = String(pbxLink.pbxSipUsername ?? "").trim();
  const identity = deviceName || sipUser;
  return { sipUsername: identity, authUsername: identity };
}

export type VoiceProvisioningBundle = {
  sipUsername: string;
  authUsername: string;
  sipPassword: string | null;
  sipWsUrl: string;
  sipDomain: string;
  outboundProxy: string | null;
  iceServers: unknown[];
  dtmfMode: string;
};

export function buildVoiceProvisioningBundleFromIdentity(
  webrtcCfg: {
    sipWsUrl: string;
    sipDomain: string;
    outboundProxy: string | null;
    iceServers: unknown[];
    dtmfMode: string;
  },
  pbxLink: WebrtcPbxLinkIdentity,
  sipPassword: string | null,
): VoiceProvisioningBundle {
  const { sipUsername, authUsername } = resolveWebrtcSipIdentity(pbxLink);
  return {
    sipUsername,
    authUsername,
    sipPassword,
    sipWsUrl: webrtcCfg.sipWsUrl,
    sipDomain: webrtcCfg.sipDomain,
    outboundProxy: webrtcCfg.outboundProxy,
    iceServers: webrtcCfg.iceServers,
    dtmfMode: webrtcCfg.dtmfMode,
  };
}

/** JsSIP/AOR URI helper for tests and diagnostics. */
export function webrtcSipUri(sipDomain: string, pbxLink: WebrtcPbxLinkIdentity): string {
  const { sipUsername } = resolveWebrtcSipIdentity(pbxLink);
  return `sip:${sipUsername}@${sipDomain}`;
}

// ── WebSocket host normalization ──────────────────────────────────────────────
// A `wss://` URL pointed at a raw IP can NEVER pass Android/browser TLS hostname
// verification: the PBX serves a certificate issued for its FQDN (e.g.
// `m.connectcomunications.com`), and an IP literal is not in the cert SAN. When
// that happens the WebSocket closes with code 1006 ("Hostname x not verified")
// before a single SIP REGISTER is sent, so the softphone silently never
// registers. These helpers let the provisioning layer rewrite an IP-literal WS
// host to the PBX's canonical FQDN so registration works regardless of what got
// persisted in env (`PBX_WS_ENDPOINT`) or the tenant row (`Tenant.sipWsUrl`).

/** True when `host` is a bare IPv4 or IPv6 literal (TLS hostname verification fails for these). */
export function isIpLiteralHost(host: string | null | undefined): boolean {
  const h = String(host ?? "").trim().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4
  if (h.includes(":")) return true; // IPv6 (always contains colons; bare hostnames never do)
  return false;
}

/**
 * Extract a usable FQDN (non-IP hostname) from a URL or bare host string.
 * Returns null for empty input, IP literals, or unparseable values.
 */
export function hostnameIfFqdn(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let host = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      host = new URL(raw).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/^\[|\]$/g, "").replace(/:\d+$/, "").trim();
  if (!host || isIpLiteralHost(host)) return null;
  return host;
}

/**
 * Resolve the PBX's public FQDN (the host its TLS cert is issued for) from the
 * tenant/link/env, in priority order. Used to rewrite IP-literal WS URLs.
 */
export function deriveCanonicalPbxHost(sources: {
  sipDomain?: string | null;
  pbxDomain?: string | null;
  pbxInstanceBaseUrl?: string | null;
  envPublicHost?: string | null;
}): string | null {
  return (
    hostnameIfFqdn(sources.sipDomain) ||
    hostnameIfFqdn(sources.pbxDomain) ||
    hostnameIfFqdn(sources.pbxInstanceBaseUrl) ||
    hostnameIfFqdn(sources.envPublicHost) ||
    null
  );
}

/**
 * If `wsUrl`'s host is an IP literal and a canonical FQDN is known, rewrite the
 * host to the FQDN (preserving scheme/port/path). Otherwise returns `wsUrl`
 * unchanged. This is the single guard that keeps WebRTC registration working
 * even when an IP slipped into env or the tenant row.
 */
export function normalizeSipWsUrlHost(
  wsUrl: string | null | undefined,
  canonicalHost: string | null,
): string | null {
  const raw = String(wsUrl ?? "").trim();
  if (!raw) return wsUrl ?? null;
  if (!canonicalHost) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (!isIpLiteralHost(u.hostname)) return raw;
  u.hostname = canonicalHost;
  return u.toString();
}
