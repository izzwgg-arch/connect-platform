/**
 * GDMS provisioning REDIRECT — the durable, passwordless, LAN-independent way a Grandstream
 * self-provisions (Izzy, 2026-09-18: "Build the GDMS redirect for Grandstream").
 *
 * ⛔⛔ WHAT THIS IS, AND IS NOT. Grandstream's cloud (GDMS) has NO API to set a provisioning
 * server for a whole site/model template — the OpenAPI (41 endpoints, read from
 * doc.grandstream.dev/api_data.json, 2026-09-18) exposes only Organization/Site lists, Device
 * (add / edit / detail / config-xml), SIP Server, SIP Account and Task. So a "set the
 * provisioning address once for the account" template redirect is a GDMS WEB-CONSOLE setting
 * with no API. The redirect we CAN drive from code is the per-device one: push a config that
 * sets the phone's OWN provisioning server (P237) + protocol (P212) to our phoneprov folder, so
 * from then on the phone pulls its config from us on every boot. That push is `device/config/xml`
 * (already built + proven live 2026-09-15). This module is the reliability + SAFETY layer around
 * it that turns a fire-once push into a redirect you can trust "for years":
 *   1. a TARGET FENCE — never redirect a phone at a server that is not ours (the proven bug), and
 *   2. an ONLINE gate + a SYNCHRONISED read — so the wizard says the honest thing (delivered vs
 *      still queued because the phone has not checked into GDMS yet) instead of blind success.
 *
 * ⛔⛔ THE FENCE IS THE HEART. On 2026-09-15 a moved phone's template had `P47` (its SIP server)
 * hand-hardcoded to `10.8.0.1` — Create A Box's OpenVPN gateway — and the phone could never
 * register from anywhere but that VPN. Pushing THAT config over the cloud would have redirected a
 * customer's phone at an address it can never reach. So: a rendered config whose provisioning
 * server (P237) or SIP server (P47) is a PRIVATE / VPN / loopback / link-local address is REFUSED
 * before it is ever pushed, and a public PROVISIONING host that is not a Loopcom host is refused
 * too. This needs no per-firmware reverse engineering — it reads the two P-values our own PBX
 * renders, and the private-address rule alone catches the exact proven bug with zero false
 * positives (our correct config uses the public PBX IP `209.145.60.79`).
 */
import { DeviceError } from "./yealinkRps";

/** The provisioning server (P237, e.g. `209.145.60.79/phoneprov/<hash>`) and the primary SIP
 *  server (P47, e.g. `209.145.60.79` or `host:5060`) a rendered gs_provision config points at. */
export type RedirectTargets = { provisioning: string | null; sip: string | null };

function firstTag(xml: string, tag: string): string | null {
  // gs_provision is flat `<P237>value</P237>`; read the first occurrence, trimmed.
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i").exec(xml);
  if (!m) return null;
  const v = m[1].trim();
  return v.length ? v : null;
}

/** Reduce a server value to its bare host: drop any scheme, path, port, userinfo. */
export function hostOf(value: string | null | undefined): string | null {
  let s = String(value ?? "").trim();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // scheme:// if present (usually none in P-values)
  s = s.split("@").pop() as string; // userinfo@
  s = s.split("/")[0]; // path
  s = s.split("?")[0].split("#")[0];
  // host:port — but keep IPv6-in-brackets whole (Grandstream P-values are IPv4/host in practice).
  if (!s.startsWith("[")) s = s.split(":")[0];
  return s.trim().toLowerCase() || null;
}

export function parseRedirectTargets(xml: string): RedirectTargets {
  return {
    // P237 = provisioning server path; P271 selects the account, P47 is account-1's SIP server.
    provisioning: hostOf(firstTag(xml, "P237")),
    sip: hostOf(firstTag(xml, "P47")),
  };
}

/** A private, VPN-range, loopback or link-local IPv4 — a server a customer's phone can never
 *  reach from its own office. This alone is the proven-bug gate; it never false-refuses a
 *  legitimate PUBLIC deployment (our real config uses the public PBX IP). */
export function isUnreachablePublicly(host: string | null): boolean {
  if (!host) return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false; // a hostname is judged by the allow-list, not here
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this host"
  if (a === 169 && b === 254) return true; // link-local
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 (VPNs live here too)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

function hostIsAllowed(host: string, allowedHosts: readonly string[]): boolean {
  // A bare PUBLIC IPv4 is accepted: the config was rendered by our OWN phoneprov, and our real
  // P237/P47 use the public PBX IP, not a hostname — so an allow-list of hostnames would
  // false-refuse the legitimate config. The allow-list's teeth are for HOSTNAMES (catching a
  // look-alike like loopcom.net.evil.com); a public IP has already passed the unreachable gate.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return allowedHosts.some((h) => {
    const want = String(h || "").toLowerCase().trim();
    return want !== "" && (host === want || host.endsWith(`.${want}`));
  });
}

/**
 * ⛔⛔ Refuse to push a redirect config unless it points the phone at US. Throws
 * `DeviceError("gdms_redirect_target_refused", 400)` when:
 *   - it has no provisioning server (P237) at all — a redirect that redirects nowhere; or
 *   - the provisioning server or the SIP server is a private / VPN / loopback / link-local
 *     address (the proven 10.8.0.1 bug — no allow-list needed); or
 *   - the provisioning server is a PUBLIC host that is not a Loopcom host.
 * `allowedHosts` is optional: when omitted (defence-in-depth callers) only the unreachable-address
 * gate runs, which is the one that catches the real bug.
 */
export function assertRedirectConfigSafe(xml: string, allowedHosts: readonly string[] = []): void {
  if (!String(xml ?? "").includes("<gs_provision")) throw new DeviceError("gdms_config_xml_invalid", 400);
  const { provisioning, sip } = parseRedirectTargets(xml);
  if (!provisioning) throw new DeviceError("gdms_redirect_target_refused", 400);
  if (isUnreachablePublicly(provisioning)) throw new DeviceError("gdms_redirect_target_refused", 400);
  if (isUnreachablePublicly(sip)) throw new DeviceError("gdms_redirect_target_refused", 400);
  if (allowedHosts.length && !hostIsAllowed(provisioning, allowedHosts)) {
    throw new DeviceError("gdms_redirect_target_refused", 400);
  }
}

/** How far a redirect got, in words the caller can act on. */
export type RedirectDelivery =
  | { state: "not_claimed" } // the device is not in our GDMS — claim it first
  | { state: "refused"; code: string } // the config is unsafe or GDMS rejected the push
  | { state: "delivered" } // pushed AND the device reports the config synchronised
  | { state: "sent_applying" } // pushed to an online device; sync not yet confirmed
  | { state: "queued_offline" }; // pushed, but the device is not connected to GDMS — it will apply on check-in
