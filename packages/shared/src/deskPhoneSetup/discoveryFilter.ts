/**
 * Which of the devices on an office network are actually desk phones?
 *
 * ⛔⛔ THE SCANNER RETURNS EVERYTHING — every laptop, printer, camera and the router
 * itself, because the ARP table does not know what anything is. Submitting all of it
 * as "phones" would open the wizard on "We found 23 desk phones" in an office with
 * four, and the other nineteen rows would be the customer's printer fleet dressed up
 * as broken phones. Found on the 2026-08-22 review pass; before this module the
 * wizard sent every host straight to the server.
 *
 * ⛔ The split is deliberately conservative in BOTH directions:
 *   • a device is a PHONE only on evidence — the phone told us (fingerprint), or its
 *     hardware address is in a known phone-maker block;
 *   • everything else is COUNTED, never silently dropped, so the screen can say
 *     "and 19 other devices, which we left alone" — a non-Yealink phone in phase one
 *     lands there and the honest sentence is what stops that reading as a bug.
 */

import { guessVendorFromMac, normalizeMac } from "./deviceIdentity";

export type ScannedHost = {
  mac: string;
  ip: string;
  respondedOnHttp?: boolean;
  fingerprint?: {
    vendor?: string | null;
    model?: string | null;
    confidence?: "reported" | "banner" | "none";
  } | null;
};

export type DiscoveryVerdict = {
  /** Devices with evidence of being a desk phone — these go to the server. */
  phones: ScannedHost[];
  /** Everything else, counted for the honesty line and never submitted. */
  othersCount: number;
  /**
   * Hosts worth spending a fingerprint call on. ⛔ Fingerprinting EVERY ARP entry
   * costs 4 seconds per silent host and burns the capability's 30-actions-a-minute
   * budget on printers; a host that never answered a web probe and is not in a
   * phone-maker's address block is not going to turn out to be a phone.
   */
};

/** Should this host get a fingerprint call at all? */
export function shouldFingerprint(host: { mac: string; respondedOnHttp?: boolean }): boolean {
  if (host.respondedOnHttp) return true;
  return guessVendorFromMac(host.mac).vendor !== "unknown";
}

/** Is there evidence this specific device is a desk phone? */
export function looksLikePhone(host: ScannedHost): boolean {
  if (!normalizeMac(host.mac)) return false;
  const fp = host.fingerprint;
  if (fp) {
    if (String(fp.vendor ?? "").toLowerCase() === "yealink") return true;
    // A model was actually read off the device — that is the device speaking.
    if (fp.model && fp.confidence && fp.confidence !== "none") return true;
  }
  // The hardware address is in a known phone-maker block. Strong enough to show the
  // device even when its web interface refused to identify itself (a locked phone
  // does exactly that).
  if (guessVendorFromMac(host.mac).vendor !== "unknown") return true;
  return false;
}

export function classifyDiscoveredHosts(hosts: ScannedHost[]): DiscoveryVerdict & { phones: ScannedHost[] } {
  const phones: ScannedHost[] = [];
  let othersCount = 0;
  const seen = new Set<string>();
  for (const h of hosts) {
    const mac = normalizeMac(h.mac);
    if (!mac || seen.has(mac)) continue;
    seen.add(mac);
    if (looksLikePhone(h)) phones.push(h);
    else othersCount += 1;
  }
  return { phones, othersCount };
}
