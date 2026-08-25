/**
 * Asking a device who it is, over SIP.
 *
 * ⛔⛔ WHY THIS EXISTS (2026-08-25, A plus center's first live run): the office's
 * SIP devices were locked at the web page, so the HTTP fingerprint answered
 * "unknown" for every one of them — while every one of those same devices will
 * happily answer a SIP OPTIONS with a User-Agent header carrying its make and
 * model ("Fanvil i16SV 2.4.0", "Yealink SIP-T42S 66.84.0.125"). Izzy, live at
 * the office: "All SIP devices — model number, and MAC address." The SIP port is
 * the one thing a SIP device cannot turn off and still be a SIP device.
 *
 * ⛔ ONE packet per address, read-only. An OPTIONS is SIP's "are you there" —
 * it changes nothing on the device, requires no account and no password, and is
 * what every PBX on earth sends every few seconds as a keepalive. The reply's
 * User-Agent/Server header is the identity; nothing else is read.
 *
 * ⛔ The address is validated by the CALLER (capability.ts / lanScan's own host
 * list) — everything here still refuses a non-private address itself, because a
 * probe module that trusts its caller is one refactor from being an open relay.
 */

import { createSocket } from "node:dgram";
import { identityFromBanner, isPrivateIpv4, type DeviceFingerprint } from "./yealink";

export const SIP_PROBE_PORT = 5060;
export const SIP_PROBE_TIMEOUT_MS = 900;

/** Characters allowed into the OPTIONS packet from anything variable. ⛔ The ip
 * is already validated as dotted-quad; this is the belt on top — a CR/LF in any
 * interpolated value would be header injection into our own request. */
const SAFE_TOKEN = /^[0-9A-Za-z.:-]+$/;

export function buildSipOptions(ip: string, branchSeed: string): string | null {
  if (!isPrivateIpv4(ip)) return null;
  if (!SAFE_TOKEN.test(branchSeed)) return null;
  const branch = `z9hG4bK${branchSeed}`;
  // ⛔ CRLF line endings are the SIP wire format, not a style choice.
  return [
    `OPTIONS sip:probe@${ip}:${SIP_PROBE_PORT} SIP/2.0`,
    `Via: SIP/2.0/UDP 0.0.0.0:5060;branch=${branch};rport`,
    `From: <sip:loopcom-setup@invalid>;tag=${branchSeed}`,
    `To: <sip:probe@${ip}>`,
    `Call-ID: ${branchSeed}@loopcom-setup.invalid`,
    "CSeq: 1 OPTIONS",
    "Max-Forwards: 5",
    "User-Agent: Loopcom Setup",
    "Accept: application/sdp",
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n");
}

/**
 * The identity out of a SIP response datagram. ⛔ ANY SIP response counts — a
 * 200, a 405, even a 401 — because the User-Agent/Server header rides them all;
 * a device refusing the request still signs the refusal.
 */
export function parseSipBanner(datagram: string): string | null {
  const text = String(datagram || "");
  if (!/^SIP\/2\.0\s/i.test(text)) return null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^(?:User-Agent|Server)\s*:\s*(.{1,160})/i.exec(line.trim());
    if (m) return m[1].trim();
  }
  return null;
}

export type SipProbeResult = { banner: string; fingerprint: DeviceFingerprint } | null;

/**
 * Send one OPTIONS, wait briefly, read the banner. Resolves null on silence or
 * any error — a probe must never throw into a sweep.
 */
export function sipOptionsProbe(ip: string, timeoutMs = SIP_PROBE_TIMEOUT_MS): Promise<SipProbeResult> {
  return new Promise((resolve) => {
    if (!isPrivateIpv4(ip)) { resolve(null); return; }
    const seed = Math.random().toString(36).slice(2, 12);
    const packet = buildSipOptions(ip, seed);
    if (!packet) { resolve(null); return; }

    let settled = false;
    const socket = createSocket("udp4");
    const done = (result: SipProbeResult) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on("error", () => { clearTimeout(timer); done(null); });
    socket.on("message", (msg, rinfo) => {
      // ⛔ Only the address we asked may answer — a reply from anywhere else is
      // discarded, not parsed.
      if (rinfo.address !== ip) return;
      const banner = parseSipBanner(msg.toString("utf8"));
      clearTimeout(timer);
      if (!banner) { done(null); return; }
      done({ banner, fingerprint: identityFromBanner(banner) });
    });
    try {
      socket.send(packet, SIP_PROBE_PORT, ip, (err) => { if (err) { clearTimeout(timer); done(null); } });
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}
