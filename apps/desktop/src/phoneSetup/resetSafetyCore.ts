/**
 * WHETHER THIS PHONE MAY BE WIPED — decided ON THE CUSTOMER'S OWN COMPUTER.
 *
 * ⛔⛔ THIS IS THE FENCE, AND IT BEING HERE IS THE POINT. The server decides that a
 * reset is the next move; this decides whether that move is survivable for the actual
 * device in front of it, from what the device said about ITSELF. A compromised Loopcom
 * account can ask for a reset. It cannot make the analog adapter under somebody's desk
 * report itself as a desk phone, and it cannot make a phone on Wi-Fi report a cable.
 *
 * ⛔ A factory reset erases the phone's network settings with everything else. Wired:
 * costs nothing, it asks the router again and comes back. On Wi-Fi: it forgets the
 * network name and password and comes back on NO network, so nothing can ever reach it
 * again — not us, not the customer, not the previous provider. On an analog adapter it
 * takes the line settings, so the customer's ordinary phones and fax go dead. On a
 * cordless base it unpairs every handset.
 *
 * ⛔⛔ THIS IS A COPY of packages/shared/src/deskPhoneSetup/resetSafety.ts (plus the
 * KIND_PATTERNS it reads from deviceKinds.ts). The desktop app bundles nothing from the
 * monorepo — electron-builder packs dist/** only — so the lists live here twice, and
 * `resetSafetyDrift.test.ts` reads the shared files and fails if the two ever disagree
 * on the kind patterns, the wireless patterns, the refusal reasons or the order the
 * checks run in. Same arrangement as coworker/policyCore.ts, for the same reason.
 *
 * ⛔ Pure. No fs, no net, no Electron.
 */

export type DeviceKind = "desk_phone" | "ata" | "cordless_base" | "pager" | "doorbell" | "unknown";

/** ⛔ Order matters: door and paging families before the generic desk families. */
const KIND_PATTERNS: Array<{ kind: DeviceKind; re: RegExp }> = [
  { kind: "doorbell", re: /^GDS\d{4}/i },
  { kind: "doorbell", re: /^I\d{1,2}[A-Z]{0,2}$/i },
  { kind: "pager", re: /^PA\d/i },
  { kind: "ata", re: /^HT\d{3}/i },
  { kind: "ata", re: /^DAG\d/i },
  { kind: "cordless_base", re: /^W\d{2}B/i },
  { kind: "desk_phone", re: /^KXTGP55\d/i },
  { kind: "cordless_base", re: /^KXTGP\d{3}/i },
  { kind: "desk_phone", re: /^KX(UT|HDV)\d{3}/i },
  { kind: "desk_phone", re: /^(SIP)?T\d{2}/i },
  { kind: "desk_phone", re: /^CP\d{3}/i },
  { kind: "desk_phone", re: /^(GXP|GRP)\d{4}/i },
  { kind: "desk_phone", re: /^AX\d{2}/i },
  { kind: "desk_phone", re: /^X\d{1,2}[USVG]?$/i },
];

export function deviceKindFor(model: string | null | undefined): DeviceKind {
  const m = String(model ?? "").trim().toUpperCase().replace(/[\s_-]/g, "");
  if (!m) return "unknown";
  for (const { kind, re } of KIND_PATTERNS) if (re.test(m)) return kind;
  return "unknown";
}

/**
 * Models that can join Wi-Fi, so an unreported link on them is a real risk.
 *
 * ⛔ Deliberately generous. A false "this might be wireless" costs one yes/no question;
 * a false "this is definitely wired" costs the customer a phone.
 */
const WIRELESS_CAPABLE_PATTERNS: RegExp[] = [
  /^(SIP)?T\d{2}W/i,
  /^CP9\d{2}/i,
  /^W\d{2}/i,
  /^WP\d{2}/i,
  /^GRP\d{3}\d?W/i,
  /WIFI$/i,
  /-W$/i,
];

export function modelCanUseWifi(model: string | null | undefined): boolean {
  const kept = String(model ?? "").trim().toUpperCase().replace(/[\s_]/g, "");
  if (!kept) return false;
  const stripped = kept.replace(/-/g, "");
  return WIRELESS_CAPABLE_PATTERNS.some((re) => re.test(kept) || re.test(stripped));
}

export type LinkType = "wired" | "wireless" | "unknown";

export type ResetRefusal =
  | "ata_analog_lines"
  | "cordless_unpairs_handsets"
  | "door_or_paging"
  | "wireless_forgets_network"
  | "wireless_capable_unconfirmed"
  | "model_unknown";

export type LocalResetVerdict = { allowed: true } | { allowed: false; reason: ResetRefusal };

/**
 * ⛔ ORDER IS THE POLICY, and it matches the shared copy line for line. The shape
 * refusals come first because an analog adapter on a cable is still an analog adapter —
 * being wired makes the NETWORK loss recoverable and does nothing for the lines.
 */
export function decideLocalFactoryReset(model: string | null | undefined, link: LinkType): LocalResetVerdict {
  const kind = deviceKindFor(model);
  if (kind === "ata") return { allowed: false, reason: "ata_analog_lines" };
  if (kind === "cordless_base") return { allowed: false, reason: "cordless_unpairs_handsets" };
  if (kind === "doorbell" || kind === "pager") return { allowed: false, reason: "door_or_paging" };
  if (link === "wireless") return { allowed: false, reason: "wireless_forgets_network" };
  if (link === "unknown" && modelCanUseWifi(model)) return { allowed: false, reason: "wireless_capable_unconfirmed" };
  if (!String(model ?? "").trim()) return { allowed: false, reason: "model_unknown" };
  return { allowed: true };
}
