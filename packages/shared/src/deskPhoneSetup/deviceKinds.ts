/**
 * Not just desk phones. Izzy, 2026-08-22: "Any VoIP device. It could be a desk
 * phone, a Grandstream HT device, a wireless cordless Yealink base station, a
 * doorbell… I have one customer with a Fanvil PA device. The system should be able
 * to connect all of them automatically."
 *
 * ⛔⛔ THE KIND DECIDES THREE THINGS, and nothing else may branch on a model string:
 *   1. what the customer is told it is ("Small box your regular phones plug into",
 *      never "ATA");
 *   2. which house rules apply (a Grandstream HT ALWAYS blocks calls from anywhere
 *      but our server; nothing gets BLF buttons except a desk phone);
 *   3. whether the office machine may drive it locally (the local adapter speaks
 *      Yealink's mechanisms; sending those at a Grandstream is at best noise).
 *
 * ⛔ Model patterns below are the vendors' own published families, not guesses:
 * Yealink T/CP/W/AX, Grandstream HT8xx ATAs, GXP/GRP desk phones and GDS door
 * systems, Fanvil PA paging gateways and i-series intercoms. A model that matches
 * nothing is "unknown", and unknown is shown honestly, never guessed into a kind.
 */

export type DeviceKind =
  | "desk_phone"
  | "ata"            // analog adapter: regular phones/fax plug into it
  | "cordless_base"  // a base station whose handsets roam the office
  | "pager"          // overhead speaker / paging amplifier
  | "doorbell"       // door intercom / door phone
  | "unknown";

const KIND_PATTERNS: Array<{ kind: DeviceKind; re: RegExp }> = [
  // ⛔ Order matters only where families could collide; door systems and paging
  // before generic desk families so "GDS3710" is never read as a desk phone.
  { kind: "doorbell", re: /^GDS\d{4}/i },                    // Grandstream door systems
  { kind: "doorbell", re: /^I\d{1,2}[A-Z]{0,2}$/i },         // Fanvil i-series intercoms (i16V, i31S, i62…)
  { kind: "pager", re: /^PA\d/i },                           // Fanvil PA2/PA3 paging gateway
  { kind: "ata", re: /^HT\d{3}/i },                          // Grandstream HT801/802/812/814…
  { kind: "cordless_base", re: /^W\d{2}B/i },                // Yealink W60B/W70B/W80B/W90B bases
  { kind: "desk_phone", re: /^(SIP)?T\d{2}/i },              // Yealink T-series (separators already stripped)
  { kind: "desk_phone", re: /^CP\d{3}/i },                   // Yealink conference phones
  { kind: "desk_phone", re: /^(GXP|GRP)\d{4}/i },            // Grandstream desk phones
  { kind: "desk_phone", re: /^AX\d{2}/i },
  { kind: "desk_phone", re: /^X\d{1,2}[USVG]?$/i },          // Fanvil X-series desk phones
];

export function deviceKindFor(model: string | null | undefined): DeviceKind {
  const m = String(model ?? "").trim().toUpperCase().replace(/[\s_-]/g, "");
  if (!m) return "unknown";
  for (const { kind, re } of KIND_PATTERNS) {
    if (re.test(m)) return kind;
  }
  return "unknown";
}

/**
 * What the customer reads beside the picture. ⛔ Plain words a person can match to
 * the thing on the wall or under the desk — never the category jargon.
 */
export function describeKind(kind: DeviceKind): string {
  switch (kind) {
    case "desk_phone": return "Desk phone";
    case "ata": return "Small box your regular phones plug into";
    case "cordless_base": return "Cordless phone base station";
    case "pager": return "Overhead speaker box";
    case "doorbell": return "Door intercom";
    default: return "Phone equipment";
  }
}

/** Only a desk phone has side keys — nothing else ever gets a button layout. */
export function kindSupportsButtons(kind: DeviceKind): boolean {
  return kind === "desk_phone";
}

/**
 * May the office machine drive this device with the local adapter?
 *
 * ⛔ The adapter speaks Yealink's documented mechanisms (Action URI, the
 * check-sync NOTIFY family). Sending those at a Grandstream or a Fanvil is not
 * "worth a try" — it is an unauthenticated request pattern another vendor's device
 * may log, refuse or mishandle. Until an adapter for that vendor is captured off a
 * real device, the honest move is to configure it SERVER-side (the provisioning
 * template) and say so, never to poke it.
 */
export function vendorSupportsLocalActions(vendor: string | null | undefined): boolean {
  return String(vendor ?? "").trim().toLowerCase() === "yealink";
}

/**
 * The house rules that attach to a KIND, on top of the fleet-wide standards.
 *
 * ⛔⛔ THE GRANDSTREAM HT RULE IS IZZY'S, 2026-08-22, VERBATIM INTENT: "it always
 * has to block incoming calls from other places. Only from the SIP URL, incoming
 * calls should be accepted. It should always be set to the Eastern time zone."
 * An HT with that switch off rings its analog phones for ANY SIP scanner that
 * finds it on the internet — a 3am phantom-ring machine.
 *
 * ⛔ These are stated as REQUIREMENTS, not as vendor config keys. The exact
 * Grandstream P-codes are written by the template layer, and per this repo's rule
 * they get captured off a real device's config before that writer ships — a wrong
 * P-code silently configures nothing.
 */
export type KindRequirement = {
  id: string;
  /** For the technician. */
  requirement: string;
  /** For the customer, if it is ever shown at all. */
  plain: string;
};

export function kindRequirements(kind: DeviceKind): KindRequirement[] {
  const eastern: KindRequirement = {
    id: "eastern_time",
    requirement: "Time zone locked to America/New_York with automatic daylight saving",
    plain: "The clock sets itself to New York time.",
  };
  switch (kind) {
    case "ata":
      return [
        {
          id: "inbound_from_sip_server_only",
          requirement:
            "Accept incoming calls ONLY from the SIP server it is registered to; refuse INVITEs from any other source",
          plain: "It only accepts calls that come through Loopcom.",
        },
        eastern,
      ];
    case "doorbell":
    case "pager":
      // A device that opens a door or speaks into a room must never take
      // instructions from anything but our server.
      return [
        {
          id: "inbound_from_sip_server_only",
          requirement:
            "Accept incoming calls/pages ONLY from the SIP server it is registered to",
          plain: "Only Loopcom can ring it.",
        },
        eastern,
      ];
    default:
      return [eastern];
  }
}
