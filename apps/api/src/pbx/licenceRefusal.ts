/**
 * licenceRefusal.ts — every way the VitalPBX panel can refuse a write because of
 * its licence, in ONE place, plus the two ways it "succeeds" while quietly
 * throwing away what you asked for.
 *
 * ⛔⛔ WHY THIS FILE EXISTS. The VitalPBX subscription is CANCELLED. The mirror
 * (`/mirror/*` on the PBX helper, `scripts/pbx/mirror/`) is the main road for
 * extension work now; the panel is the fallback that is allowed to fail. That
 * inversion only works if we can RECOGNISE a licence refusal — and until
 * 2026-09-16 we recognised exactly one sentence:
 *
 *     String(e.message).includes("maximum number of al")
 *
 * which matches `extensions.max_reached` and NOTHING else. On 2026-09-16 a
 * paying customer's new extension was refused with
 * `extensions.vitxi_clients.max_reached` — *"You've reached the maximum number
 * of Mobile/WebRTC clients allowed for your current license."* — the gate did
 * not match it, no fallback ran, and the route answered a raw 422 with a
 * 200-character truncation of a JSON blob. The extension was left half-built:
 * its rows on the PBX, nothing in Asterisk, and a customer with no softphone.
 *
 * ⛔ Every string below was read off the running PBX
 * (`/usr/share/vitalpbx/i18n/en_US/*.txt`, 2026-09-16) — not guessed, and not
 * copied from another locale. `en_US` is what the robot session receives;
 * `zh_CN/extensions.txt` carries a DIFFERENT wording for the same key, which is
 * how the first reading of this bug went wrong. Match on the invariant middle
 * of each sentence, never the whole thing: the panel interpolates counts.
 */

/** What the licence is refusing. The kind decides which road to take next. */
export type LicenceRefusalKind =
  /** the per-tenant / per-server extension COUNT cap */
  | "extensions"
  /** an app device: VitXi / Mobile / WebRTC client */
  | "app_client"
  /** a VitalPBX Connect mobile device (the per-tenant `vpbx_devices` quota) */
  | "mobile_client"
  /** a desk phone in the provisioning module */
  | "provisioning"
  /** creating a TENANT — deliberately NOT an extension-write refusal */
  | "tenants"
  /** the generic "free items on this module" refusal */
  | "module_items"
  /** conferences, IVRs, queues, parking, custom contexts, MS Teams numbers */
  | "other_module";

type Rule = { kind: LicenceRefusalKind; fragment: string; i18nKey: string };

/**
 * ⛔ Ordered most-specific first: `extensions.vitxi_clients.max_reached` and
 * `extensions.max_reached` both contain "maximum number of", so a looser rule
 * placed first would mislabel the app-client refusal as an extension-count one
 * and send it to a fallback that cannot help.
 */
export const LICENCE_REFUSAL_RULES: readonly Rule[] = [
  // ── extension / device writes ───────────────────────────────────────────
  {
    kind: "app_client",
    i18nKey: "extensions.vitxi_clients.max_reached",
    fragment: "maximum number of mobile/webrtc clients",
  },
  {
    kind: "app_client",
    i18nKey: "extensions.push.max_devices_with_qr",
    fragment: 'devices with the "qr" option enabled',
  },
  {
    kind: "mobile_client",
    i18nKey: "mobile_devices.validation.license_limit",
    fragment: "maximum number of allowed vitalpbx connect devices",
  },
  {
    kind: "mobile_client",
    i18nKey: "mobile_devices.validation.tenant_limit",
    fragment: "not allowed to add more than",
  },
  {
    kind: "extensions",
    i18nKey: "extensions.global_max_reached",
    fragment: "surpassed the allowable limit for extensions",
  },
  {
    kind: "extensions",
    i18nKey: "extensions.max_reached",
    fragment: "maximum number of allowed extensions",
  },
  // ⛔ The historical gate. `extensions.max_reached` is the sentence it was
  // written for, but the panel has been seen to elide the noun ("maximum number
  // of allowed …"), so the loose form is kept BELOW the specific ones above.
  {
    kind: "extensions",
    i18nKey: "extensions.max_reached (loose)",
    fragment: "maximum number of al",
  },
  // ── other modules ───────────────────────────────────────────────────────
  {
    kind: "provisioning",
    i18nKey: "provisioning.licensing.max_reached",
    fragment: "allowed phone devices that can be provisioned",
  },
  {
    kind: "tenants",
    i18nKey: "tenants (free tier)",
    fragment: "maximum number of free tenants",
  },
  {
    kind: "module_items",
    i18nKey: "app.license.max_items",
    fragment: "maximum number of free items allowed on this module",
  },
  {
    kind: "other_module",
    i18nKey: "conferences.max_reached",
    fragment: "maximum number of conferences",
  },
  { kind: "other_module", i18nKey: "ivr.max_reached", fragment: "maximum number of ivrs" },
  { kind: "other_module", i18nKey: "queues.max_reached", fragment: "maximum number of queues" },
  { kind: "other_module", i18nKey: "parking.max_reached", fragment: "maximum number of parking lots" },
  {
    kind: "other_module",
    i18nKey: "custom_contexts.max_custom_contexts",
    fragment: "cannot create more than one custom context",
  },
  {
    kind: "other_module",
    i18nKey: "ms_teams.validation.max_numbers_reached",
    fragment: "current license allows you to add",
  },
];

const textOf = (e: unknown): string => {
  if (e == null) return "";
  if (typeof e === "string") return e;
  const msg = (e as any)?.message;
  return typeof msg === "string" ? msg : String(e);
};

/** Which licence rule (if any) this refusal matches. */
export function licenceRefusalKind(e: unknown): LicenceRefusalKind | null {
  const t = textOf(e).toLowerCase();
  if (!t) return null;
  for (const r of LICENCE_REFUSAL_RULES) if (t.includes(r.fragment)) return r.kind;
  return null;
}

/** Is the licence talking at all? (Any module.) */
export function isLicenceRefusal(e: unknown): boolean {
  return licenceRefusalKind(e) !== null;
}

/**
 * Is this a licence refusal of an EXTENSION or DEVICE write — i.e. one the
 * mirror can answer?
 *
 * ⛔ `tenants` is deliberately excluded: "maximum number of free tenants" is the
 * tenant-create form refusing, and handing that to an extension fallback would
 * be nonsense. `other_module` is excluded for the same reason. This preserves
 * the one distinction the original narrow gate got right.
 */
export function isExtensionWriteLicenceRefusal(e: unknown): boolean {
  const kind = licenceRefusalKind(e);
  return (
    kind === "extensions" ||
    kind === "app_client" ||
    kind === "mobile_client" ||
    kind === "module_items"
  );
}

/**
 * ⛔⛔ THE WORSE FAILURE: a licence refusal disguised as a SUCCESS.
 *
 * The CSV importer does not refuse when it is over the app-client cap — it
 * imports the row and silently clears the flag:
 *
 *   import_extensions.vitxi_client.max_reached =
 *     The WebRTC Client flag was set to "no" for the device "%s" due to your
 *     current license limitations.
 *   import_extensions.mobile_client.max_reached = (the same, for Mobile Client)
 *
 * The notification still reads "Import Completed Successfully", the extension
 * exists, `pjsip show endpoints` shows an endpoint — and the person has a desk
 * phone where a softphone was ordered. Nothing downstream would ever notice.
 * Treat this as a FAILURE of the import, not a warning.
 */
export const LICENCE_SILENT_DOWNGRADE_FRAGMENTS: readonly string[] = [
  'webrtc client flag was set to "no"',
  'mobile client flag was set to "no"',
  "due to your current license limitations",
];

export function isLicenceSilentDowngrade(e: unknown): boolean {
  const t = textOf(e).toLowerCase();
  if (!t) return false;
  return LICENCE_SILENT_DOWNGRADE_FRAGMENTS.some((f) => t.includes(f));
}

/* ── the mirror's own refusal ─────────────────────────────────────────────── */

/**
 * ⛔⛔ `/mirror/extension-add` answers a raw MySQL error when the helper's
 * database user has not been granted INSERT on the extension tables:
 *
 *   (1142, "INSERT command denied to user 'connect_route_helper'@'localhost'
 *           for table `ombutel`.`ombu_extensions`")
 *
 * That happened on production on 2026-09-16, three weeks after the endpoint
 * shipped, because the endpoint was only ever proven ON THE CLONE AS MySQL
 * ROOT (`scripts/pbx/mirror/add-extension-accept.py` connects as root and
 * refuses to run where a licence file exists), while the production grant file
 * `mirror-grants-20260819.sql` covers the TENANT-CREATE tables only.
 *
 * A raw 1142 in a 422 body is unreadable and sends the next agent hunting a
 * bug that does not exist. Name the fix instead.
 */
export function isMirrorGrantMissing(e: unknown): boolean {
  const t = textOf(e).toLowerCase();
  return t.includes("command denied to user") || t.includes("(1142");
}

/** The grants file that closes it — kept here so one edit updates every message. */
export const MIRROR_EXTENSION_GRANTS_FILE =
  "scripts/pbx/mirror/mirror-extension-grants-20260916.sql";

export function mirrorGrantMissingMessage(detail?: string): string {
  return (
    "The phone system's own licence will not create this any more, and Connect's " +
    "mirror — the road that replaces it — is not allowed to write to the extension " +
    "tables on this phone system yet. Nothing was changed. " +
    `Install the grants once, as root on the PBX: ${MIRROR_EXTENSION_GRANTS_FILE}` +
    (detail ? ` (the phone system said: ${detail})` : "")
  );
}

/**
 * The plain-English sentence for a licence refusal we could not route around.
 * ⛔ It must say what state the PBX is in, because the caller has usually
 * already written SOMETHING — see `halfBuiltExtensionMessage`.
 */
export function licenceRefusalMessage(kind: LicenceRefusalKind): string {
  switch (kind) {
    case "app_client":
      return (
        "The phone system's licence refuses to create any more app (mobile / browser " +
        "softphone) devices, and freeing one does not reopen it — the figure it checks " +
        "is not a live count. This has to go through Connect's mirror instead."
      );
    case "mobile_client":
      return (
        "The phone system's licence refuses to create any more VitalPBX Connect mobile " +
        "devices for this customer. This has to go through Connect's mirror instead."
      );
    case "extensions":
      return (
        "The phone system's free edition refuses to create another extension for this " +
        "customer (its own 12-extension limit). This has to go through Connect's mirror instead."
      );
    case "provisioning":
      return "The phone system's licence refuses to provision another desk phone. Use the PBX helper.";
    case "tenants":
      return "The phone system's free edition refuses to create another tenant. Use the mirror's tenant-create.";
    case "module_items":
    case "other_module":
    default:
      return "The phone system's licence refused this change. Nothing was changed.";
  }
}

/**
 * ⛔ A create that throws PART WAY leaves rows on the PBX and NOTHING in
 * Asterisk — the throw happens before Apply. Say so, every time, with the
 * repair, so nobody reports "it failed" on a customer who now half-exists.
 */
export function halfBuiltExtensionMessage(ext: string, what: string): string {
  return (
    `Extension ${ext} was partly created before this failed: ${what}. ` +
    "Its rows are on the phone system but it is NOT live in Asterisk (a create that " +
    "throws never reaches Apply). Either finish it through the mirror, or delete it " +
    "from the console and start again — do not leave it: check `pjsip show endpoints`, " +
    "never the panel's own success message."
  );
}
