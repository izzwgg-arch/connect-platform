/**
 * MAC address handling and desk-phone vendor identification.
 *
 * Why this exists: the MAC on the PBX record is the single point of failure in
 * phone provisioning, and nothing verifies it. VitalPBX pre-generates a config
 * file named after the MAC it was told; the phone downloads the file named
 * after the MAC it actually has. Get one character wrong and the panel looks
 * perfect while the phone serves a config from weeks ago — with a clean 200 in
 * the logs, never a 404. That was seven weeks of Create A Box ext 102.
 *
 * ⛔ THE NORMALISATION IS THE POINT. Every source writes MACs differently:
 * the panel stores `805e0c4d7e6b`, Windows ARP prints `80-5e-0c-4d-7e-6b`, the
 * phone's own web page shows `80:5E:0C:4D:7E:6B`, and the nginx user agent uses
 * yet another. Comparing two of those without normalising first answers
 * "different" for the same phone, which defeats the entire purpose of
 * collecting them.
 */

/**
 * OUI prefixes (first three bytes) for the desk-phone vendors that actually
 * appear on this platform.
 *
 * ⛔ This list is deliberately partial and an unknown MAC is NORMAL, not an
 * error — every office has printers, laptops and TVs on the same network. The
 * vendor is a hint that helps a human read the list; nothing downstream should
 * refuse to work because it came back null.
 */
const OUI_VENDORS: Record<string, string> = {
  // Yealink — the fleet's most common handset. 805e0c is the prefix on the
  // Gesheft T53W whose reassignment went unnoticed for a week.
  "805e0c": "Yealink",
  "249ad8": "Yealink",
  "001565": "Yealink",
  "445ce9": "Yealink",
  "805ec0": "Yealink",
  "5422f8": "Yealink",
  "6c1c71": "Yealink",
  // Polycom / Poly
  "0004f2": "Polycom",
  "64167f": "Polycom",
  "482567": "Polycom",
  "00e0db": "Polycom",
  // Grandstream
  "000b82": "Grandstream",
  "c074ad": "Grandstream",
  "ec74d7": "Grandstream",
  // Cisco and the Linksys/Sipura ATA lineage
  "001aa1": "Cisco",
  "000e08": "Cisco",
  "887556": "Cisco",
  // Snom
  "000413": "Snom",
  // Fanvil
  "00a859": "Fanvil",
  "0c383e": "Fanvil",
  // Aastra / Mitel
  "00085d": "Mitel",
  // Panasonic (both Panasonic Communications blocks their KX SIP terminals use)
  "0080f0": "Panasonic",
  "080023": "Panasonic",
};

/**
 * Reduce any MAC spelling to lowercase hex with no separators.
 * Returns null for anything that is not a real 48-bit MAC — a caller that
 * cannot produce a valid MAC should store nothing rather than store junk that
 * will never match.
 */
export function normalizeMac(input: string | null | undefined): string | null {
  if (!input) return null;
  const cleaned = String(input).toLowerCase().replace(/[^0-9a-f]/g, "");
  if (cleaned.length !== 12) return null;
  // All-zero and broadcast are structurally valid but never a real handset.
  if (cleaned === "000000000000" || cleaned === "ffffffffffff") return null;
  return cleaned;
}

/** Human-readable form for screens: `80:5e:0c:4d:7e:6b`. */
export function formatMac(normalized: string | null | undefined): string | null {
  const mac = normalizeMac(normalized);
  if (!mac) return null;
  return (mac.match(/.{2}/g) || []).join(":");
}

/**
 * Best-guess vendor from the OUI prefix. Null means "not a phone we recognise",
 * which is the common and correct answer for most devices on a network.
 */
export function vendorForMac(input: string | null | undefined): string | null {
  const mac = normalizeMac(input);
  if (!mac) return null;
  return OUI_VENDORS[mac.slice(0, 6)] ?? null;
}

/** Is this MAC one of the desk-phone vendors we know how to provision? */
export function looksLikeDeskPhone(input: string | null | undefined): boolean {
  return vendorForMac(input) !== null;
}

/**
 * Do two MAC spellings refer to the same handset?
 *
 * ⛔ This is the comparison the provisioning bug needed and nobody had. Use it
 * whenever a MAC from one system is checked against a MAC from another; never
 * compare the raw strings.
 */
export function sameMac(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeMac(a);
  const right = normalizeMac(b);
  if (!left || !right) return false;
  return left === right;
}

/** Basic IPv4 sanity, so a scan cannot fill the table with nonsense. */
export function normalizeIpv4(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  const m = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map((p) => Number(p));
  if (parts.some((p) => p > 255)) return null;
  // 0.0.0.0 and the broadcast address are never a host we can reach.
  if (parts.every((p) => p === 0)) return null;
  if (parts[0] === 255) return null;
  return parts.join(".");
}
