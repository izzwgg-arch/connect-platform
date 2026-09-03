/**
 * Which phone is this, when its address has changed underneath us?
 *
 * ⛔⛔ NEVER IDENTIFY A PHONE BY ITS ADDRESS. A factory reset drops the phone's DHCP
 * lease, so it comes back wherever the router feels like putting it — 192.168.1.41
 * before, 192.168.1.87 after. A wizard that tracks by address believes one phone
 * vanished and a different one appeared, and will happily reset the "new" one.
 *
 * The hardware address is the identity. It survives the reset, the reboot and the
 * address change, and it is the same value the PBX files the phone's config under.
 *
 * ⛔ It is also the one field in phone provisioning that NOTHING verifies. VitalPBX
 * writes a config named after the address it was told, and the handset downloads the
 * one named after the address it has — when those differ there is no error anywhere.
 * That is a seven-week outage this platform has already had. Comparing the two is
 * half the value of discovering phones at all.
 */

/** Lowercase hex, no separators. The one form everything else compares against. */
export function normalizeMac(input: unknown): string | null {
  const cleaned = String(input ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
  if (cleaned.length !== 12) return null;
  // Broadcast and all-zero are not devices.
  if (cleaned === "ffffffffffff" || cleaned === "000000000000") return null;
  // ⛔ Multicast MACs (least significant bit of the first octet set) are not hosts.
  // 01:00:5e:* in particular fills an ARP table and would put phantom "phones" in a
  // customer's inventory.
  const firstOctet = parseInt(cleaned.slice(0, 2), 16);
  if (Number.isNaN(firstOctet) || (firstOctet & 1) === 1) return null;
  return cleaned;
}

/** The form a person reads, and the form VitalPBX's own filenames use. */
export function formatMac(mac: string): string {
  const n = normalizeMac(mac);
  if (!n) return String(mac ?? "");
  return (n.match(/.{2}/g) ?? []).join(":").toUpperCase();
}

/**
 * Phone-maker hardware prefixes, from the IEEE OUI registry.
 *
 * ⛔ A prefix is a STRONG HINT, never proof. Vendors buy and sell address blocks,
 * and a phone behind a switch that rewrites addresses will not match at all. The
 * prefix decides what we try FIRST; the phone's own answer decides what it is.
 *
 * Widened 2026-08-22 when Izzy widened the scope to any VoIP device — a Grandstream
 * HT under a desk and a Fanvil speaker on a ceiling both had to stop reading as
 * "some other device, left alone".
 *
 * Widened again 2026-09-03 with Panasonic (a KX-TGP500 DECT base on Izzy's desk was
 * structurally invisible to the wizard). ⛔ Recognising a Panasonic does NOT mean we
 * can provision one — the PBX's provisioning catalog has no Panasonic brand at all
 * (checked read-only against provisioning.brands, 2026-09-03). Detection and
 * provisionability are separate questions; `vendorSupportsPbxProvisioning` in
 * deviceKinds.ts answers the second one.
 */
const VENDOR_PREFIXES: Array<{ vendor: "yealink" | "grandstream" | "fanvil" | "panasonic"; prefixes: string[] }> = [
  { vendor: "yealink", prefixes: ["805e0c", "805ec0", "001565", "249ad8", "805e18"] },
  // IEEE registrations for Grandstream Networks.
  { vendor: "grandstream", prefixes: ["000b82", "c074ad"] },
  // IEEE registration for Fanvil Technology.
  { vendor: "fanvil", prefixes: ["0c383e"] },
  // IEEE registrations for Panasonic Communications Co., Ltd. — the blocks their
  // KX-series SIP terminals ship on (0080f0 is the classic KX phone prefix).
  { vendor: "panasonic", prefixes: ["0080f0", "080023"] },
];

export type VendorGuess = {
  vendor: "yealink" | "grandstream" | "fanvil" | "panasonic" | "unknown";
  confidence: "prefix" | "none";
};

export function guessVendorFromMac(mac: string): VendorGuess {
  const n = normalizeMac(mac);
  if (!n) return { vendor: "unknown", confidence: "none" };
  for (const { vendor, prefixes } of VENDOR_PREFIXES) {
    for (const p of prefixes) {
      if (n.startsWith(p)) return { vendor, confidence: "prefix" };
    }
  }
  return { vendor: "unknown", confidence: "none" };
}

export type DiscoveredDevice = {
  mac: string;
  ip: string;
  /** Whether it answered on a web port, which desk phones essentially always do. */
  respondedOnHttp?: boolean;
  vendor?: string | null;
  model?: string | null;
  firmware?: string | null;
  /** Where the phone says it currently gets its settings from. */
  provisioningUrl?: string | null;
};

export type IdentityMatch =
  | { kind: "same"; movedFrom: string | null }
  | { kind: "new" }
  | { kind: "unusable"; why: string };

/**
 * Is the thing we just found the phone we were waiting for?
 *
 * ⛔ Address changes are EXPECTED and are not evidence of anything. Only the
 * hardware address decides. A device with an unreadable address is `unusable` and is
 * reported, never quietly treated as new — a phone we cannot identify is exactly the
 * phone we must not touch.
 */
export function matchDevice(expectedMac: string, found: DiscoveredDevice): IdentityMatch {
  const want = normalizeMac(expectedMac);
  const got = normalizeMac(found.mac);
  if (!want) return { kind: "unusable", why: "We do not have a usable hardware id for this phone." };
  if (!got) return { kind: "unusable", why: "This device did not report a usable hardware id." };
  if (want !== got) return { kind: "new" };
  return { kind: "same", movedFrom: null };
}

/**
 * Find the phone we reset, wherever it has come back.
 *
 * Returns the device if it is present, plus whether its address moved — which is
 * worth recording, because "came back at a new address" is the normal case and a
 * technician reading the diagnostics should see it stated rather than inferred.
 */
export function findByIdentity(
  expectedMac: string,
  previousIp: string | null,
  devices: DiscoveredDevice[],
): { device: DiscoveredDevice; movedFrom: string | null } | null {
  const want = normalizeMac(expectedMac);
  if (!want) return null;
  for (const d of devices) {
    if (normalizeMac(d.mac) !== want) continue;
    const moved = previousIp && d.ip && d.ip !== previousIp ? previousIp : null;
    return { device: d, movedFrom: moved };
  }
  return null;
}

/**
 * What the PBX record says versus what is actually on the desk.
 *
 * ⛔ This is the comparison nobody at Loopcom has ever been able to make, and the
 * one that would have caught Create A Box ext 102 seven weeks earlier.
 */
export type MacComparison = {
  /** On the network and on the PBX record — provisioning will reach it. */
  matched: Array<{ mac: string; ip: string; pbxDescription: string | null }>;
  /** On the network, unknown to the PBX — a phone nobody is provisioning. */
  onNetworkOnly: Array<{ mac: string; ip: string }>;
  /** On the PBX record, not on this network — moved, off, or the record is wrong. */
  onRecordOnly: Array<{ mac: string; pbxDescription: string | null }>;
};

export function compareToPbxRecords(
  found: DiscoveredDevice[],
  records: Array<{ mac: string; description?: string | null }>,
): MacComparison {
  const foundMap = new Map<string, DiscoveredDevice>();
  for (const d of found) {
    const m = normalizeMac(d.mac);
    if (m) foundMap.set(m, d);
  }
  const recordMap = new Map<string, string | null>();
  for (const r of records) {
    const m = normalizeMac(r.mac);
    // ⛔ A record with an unreadable address is dropped here but must be surfaced by
    // the caller: it can never match a handset, so it is a permanently broken record.
    if (m) recordMap.set(m, r.description ?? null);
  }

  const matched: MacComparison["matched"] = [];
  const onNetworkOnly: MacComparison["onNetworkOnly"] = [];
  for (const [mac, dev] of foundMap) {
    if (recordMap.has(mac)) matched.push({ mac, ip: dev.ip, pbxDescription: recordMap.get(mac) ?? null });
    else onNetworkOnly.push({ mac, ip: dev.ip });
  }
  const onRecordOnly: MacComparison["onRecordOnly"] = [];
  for (const [mac, description] of recordMap) {
    if (!foundMap.has(mac)) onRecordOnly.push({ mac, pbxDescription: description });
  }

  const byMac = (a: { mac: string }, b: { mac: string }) => a.mac.localeCompare(b.mac);
  matched.sort(byMac); onNetworkOnly.sort(byMac); onRecordOnly.sort(byMac);
  return { matched, onNetworkOnly, onRecordOnly };
}
