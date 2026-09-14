/**
 * What did we discover? — the one identification pipeline behind the desk phone wizard.
 *
 * ⛔⛔ THE WIZARD ASKS "WHAT DEVICE IS THIS?", NEVER "WHAT BRAND DID THE CUSTOMER PICK?".
 * Every observation about a device — its hardware address, the model it announced over
 * SIP, its web page, the phone system's own record, the maker's cloud, a scanned label,
 * a person's answer — goes in as EVIDENCE with a named source, and one function decides
 * what the device is, how sure we are, and what Connect can actually do with it.
 * Grandstream, Yealink, Fanvil and Poly differences live in the evidence and in the
 * capability rules below, never in the customer's workflow.
 *
 * ⛔ Rules this file enforces, each with a test:
 *   1. A MAC block (OUI) names a MANUFACTURER only. It never names a model.
 *   2. Evidence that names a DIFFERENT hardware address than the device is refused and
 *      recorded as a conflict — a label scanned off the wrong phone must not rename
 *      this one.
 *   3. A capability is true only when a mechanism Connect really has can perform it.
 *      Vendor-cloud actions are true only when that provider is configured AND reported
 *      the device as ours. Nothing is inferred from a brand name.
 *   4. Uncertainty is stated: confidence, a numeric score, every source, every conflict.
 *
 * Pure: no network, no database, no clock except values passed in.
 */

import { normalizeMac, formatMac } from "./deviceIdentity";
import { deviceKindFor, type DeviceKind, vendorSupportsPbxProvisioning } from "./deviceKinds";
import {
  findCatalogModel, vendorsForMac, vendorSlugFor, vendorSupportsHttpActions, vendorSupportsLocalReset, vendorSupportsPnpHandoff,
} from "./vendorAdapters";
import type { PhoneState } from "./states";

/* ── manufacturers ─────────────────────────────────────────────────────────── */

export const SUPPORTED_MANUFACTURERS = ["grandstream", "yealink", "fanvil", "poly"] as const;
export type SupportedManufacturer = (typeof SUPPORTED_MANUFACTURERS)[number];
/** "other" = a maker we recognise but do not run a provider for; "unknown" = nobody can say. */
export type Manufacturer = SupportedManufacturer | "other" | "unknown";

export function isSupportedManufacturer(value: unknown): value is SupportedManufacturer {
  return (SUPPORTED_MANUFACTURERS as readonly string[]).includes(String(value));
}

/** Any vendor text (a banner, a record, a picker) → our manufacturer id. Never guesses. */
export function manufacturerFromText(text: string | null | undefined): Manufacturer {
  const raw = String(text ?? "").trim();
  if (!raw || /^unknown$/i.test(raw)) return "unknown";
  const slug = vendorSlugFor(raw);
  if (slug === "polycom") return "poly";
  if (slug === "grandstream" || slug === "yealink" || slug === "fanvil") return slug;
  if (slug) return "other";
  // Panasonic has no PBX brand row but is still a real maker we recognise.
  if (/panasonic/i.test(raw)) return "other";
  return "unknown";
}

/* ── hardware addresses ────────────────────────────────────────────────────── */

const MAC_SHAPES = [
  /^[0-9a-f]{12}$/i,                                   // c074ad8c605f
  /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i,                   // C0:74:AD:8C:60:5F
  /^[0-9a-f]{2}(-[0-9a-f]{2}){5}$/i,                   // c0-74-ad-8c-60-5f
  /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i,          // c074.ad8c.605f
];

/**
 * A hardware address in any of the forms people and devices actually write it, or null.
 *
 * ⛔ Stricter than `normalizeMac`, which strips every non-hex character: that is right
 * for an ARP table and wrong for typed or scanned input, where "PHONE AB12 CD34 EF56"
 * would otherwise become an address. Mixed separators are refused for the same reason.
 */
export function parseMacAddress(input: unknown): { normalized: string; formatted: string } | null {
  const text = String(input ?? "").trim();
  if (!MAC_SHAPES.some((re) => re.test(text))) return null;
  const normalized = normalizeMac(text);
  if (!normalized) return null;
  return { normalized, formatted: formatMac(normalized) };
}

/** What the MAC block says about the maker — and nothing about the model. */
export function manufacturerFromOui(mac: string): { manufacturer: Manufacturer; candidates: string[] } {
  const n = normalizeMac(mac);
  if (!n) return { manufacturer: "unknown", candidates: [] };
  const candidates = vendorsForMac(n).map(String);
  if (candidates.length === 1) return { manufacturer: manufacturerFromText(candidates[0]), candidates };
  // ⛔ A block registered to two makers (Fanvil + Attimo share 0c383e) names neither.
  return { manufacturer: "unknown", candidates };
}

/* ── models ────────────────────────────────────────────────────────────────── */

const LEADING_MAKER_WORDS = /^(SIP|YEALINK|GRANDSTREAM|FANVIL|POLYCOM|POLY|HPPOLY|HP)+/;

/** The model as one comparable token: "Yealink SIP-T54W" → "T54W", "Poly Edge E350" → "EDGEE350". */
export function canonicalModel(raw: string | null | undefined): string | null {
  let m = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!m) return null;
  for (let i = 0; i < 3; i++) {
    const stripped = m.replace(LEADING_MAKER_WORDS, "");
    if (!stripped || stripped === m) break;
    m = stripped;
  }
  if (!m || m.length > 32) return null;
  return m;
}

/* ── device types ──────────────────────────────────────────────────────────── */

export const DEVICE_TYPES = [
  "desk_phone", "video_phone", "ata", "door_phone", "intercom", "conference_phone",
  "cordless_base", "gateway", "paging_device", "other_supported_endpoint", "unknown",
] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

type TypeRule = { manufacturer: SupportedManufacturer; type: DeviceType; re: RegExp; distinctive: boolean };

/**
 * The makers' own published product families. ⛔ `distinctive` families are named by
 * their prefix alone (nobody else ships a "GXP2170" or a "VVX450"), so they may also
 * identify the MANUFACTURER when nothing else did. Short prefixes like Fanvil "X5" or
 * Yealink "T5" are NOT distinctive and are only applied when the maker is already known.
 * Order matters inside a maker: specific before general.
 */
const TYPE_RULES: TypeRule[] = [
  // Grandstream
  { manufacturer: "grandstream", type: "video_phone", re: /^GXV\d{4}/, distinctive: true },
  { manufacturer: "grandstream", type: "desk_phone", re: /^(GXP|GRP)\d{4}/, distinctive: true },
  { manufacturer: "grandstream", type: "other_supported_endpoint", re: /^WP8\d{2}/, distinctive: true },
  { manufacturer: "grandstream", type: "ata", re: /^HT\d{3}/, distinctive: true },
  { manufacturer: "grandstream", type: "door_phone", re: /^GDS\d{4}/, distinctive: true },
  { manufacturer: "grandstream", type: "paging_device", re: /^GSC350[56]/, distinctive: true },
  { manufacturer: "grandstream", type: "intercom", re: /^GSC35\d{2}/, distinctive: true },
  { manufacturer: "grandstream", type: "conference_phone", re: /^GAC\d{4}/, distinctive: true },
  { manufacturer: "grandstream", type: "cordless_base", re: /^DP7\d{2}/, distinctive: true },
  { manufacturer: "grandstream", type: "gateway", re: /^GXW\d{4}/, distinctive: true },
  // Yealink
  { manufacturer: "yealink", type: "video_phone", re: /^VP\d{2}/, distinctive: true },
  { manufacturer: "yealink", type: "conference_phone", re: /^CP\d{3,4}/, distinctive: false },
  { manufacturer: "yealink", type: "cordless_base", re: /^W\d{2}[BP]$/, distinctive: false },
  { manufacturer: "yealink", type: "desk_phone", re: /^MP\d{2}/, distinctive: false },
  { manufacturer: "yealink", type: "desk_phone", re: /^T\d{2}/, distinctive: false },
  { manufacturer: "yealink", type: "desk_phone", re: /^AX\d{2}/, distinctive: false },
  // Fanvil
  { manufacturer: "fanvil", type: "paging_device", re: /^PA\d/, distinctive: false },
  { manufacturer: "fanvil", type: "intercom", re: /^I1\d[A-Z]{0,2}$/, distinctive: false },
  { manufacturer: "fanvil", type: "door_phone", re: /^I[2-9]\d[A-Z]{0,2}$/, distinctive: false },
  { manufacturer: "fanvil", type: "desk_phone", re: /^(X\d{1,3}[A-Z]{0,2}|V6\d[A-Z]?|H\d[A-Z]{0,2}|W6\d{2}W?)$/, distinctive: false },
  // Poly (Polycom)
  { manufacturer: "poly", type: "video_phone", re: /^VVX1500/, distinctive: true },
  { manufacturer: "poly", type: "cordless_base", re: /^(VVXD2\d{2}|D2\d{2}|ROVE(B\d|\d{2}))$/, distinctive: false },
  { manufacturer: "poly", type: "desk_phone", re: /^(VVX|CCX)\d{3}/, distinctive: true },
  { manufacturer: "poly", type: "desk_phone", re: /^EDGE[EB]\d{2,3}/, distinctive: true },
  { manufacturer: "poly", type: "conference_phone", re: /^(REALPRESENCE)?TRIO\d{4}/, distinctive: true },
  { manufacturer: "poly", type: "conference_phone", re: /^(SOUNDSTATIONIP\d{4}|IP[5-7]000)$/, distinctive: true },
  { manufacturer: "poly", type: "desk_phone", re: /^SOUNDPOINTIP\d{3}$/, distinctive: true },
  { manufacturer: "poly", type: "desk_phone", re: /^OBI1\d{3}$/, distinctive: true },
  { manufacturer: "poly", type: "ata", re: /^(OBI[2-5]\d{2}|ATA40[02])$/, distinctive: true },
];

const KIND_TO_TYPE: Record<DeviceKind, DeviceType> = {
  desk_phone: "desk_phone", ata: "ata", cordless_base: "cordless_base",
  pager: "paging_device", doorbell: "door_phone", unknown: "unknown",
};

/** The manufacturer a distinctive model prefix names on its own, or null. */
export function manufacturerFromModel(model: string | null | undefined): SupportedManufacturer | null {
  const m = canonicalModel(model);
  if (!m) return null;
  const hits = new Set(TYPE_RULES.filter((r) => r.distinctive && r.re.test(m)).map((r) => r.manufacturer));
  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * What kind of thing this is. ⛔ A model matching nothing is "unknown" — shown honestly,
 * never guessed, because the type decides what the customer is told to look for.
 */
export function classifyDeviceType(manufacturer: Manufacturer, model: string | null | undefined): DeviceType {
  const m = canonicalModel(model);
  if (!m) return "unknown";
  const known = isSupportedManufacturer(manufacturer);
  for (const rule of TYPE_RULES) {
    if (known ? rule.manufacturer !== manufacturer : !rule.distinctive) continue;
    if (rule.re.test(m)) return rule.type;
  }
  // The long-standing kind patterns still cover Panasonic, Dinstar and the rest.
  return KIND_TO_TYPE[deviceKindFor(m)] ?? "unknown";
}

/** Plain words a person can match to the thing on the desk, the wall or the ceiling. */
export function describeDeviceType(type: DeviceType): string {
  switch (type) {
    case "desk_phone": return "Desk phone";
    case "video_phone": return "Video phone";
    case "ata": return "Small box your regular phones plug into";
    case "door_phone": return "Door intercom";
    case "intercom": return "Intercom speaker";
    case "conference_phone": return "Conference room speakerphone";
    case "cordless_base": return "Cordless phone base station";
    case "gateway": return "Phone line gateway";
    case "paging_device": return "Overhead speaker box";
    case "other_supported_endpoint": return "Phone equipment";
    default: return "Phone equipment";
  }
}

/** For code that still speaks the older five kinds (house rules, button layouts). */
export function deviceKindForType(type: DeviceType): DeviceKind {
  switch (type) {
    case "desk_phone": case "video_phone": case "conference_phone": return "desk_phone";
    case "ata": case "gateway": return "ata";
    case "cordless_base": return "cordless_base";
    case "paging_device": return "pager";
    case "door_phone": case "intercom": return "doorbell";
    default: return "unknown";
  }
}

/* ── evidence ──────────────────────────────────────────────────────────────── */

export const IDENTIFICATION_SOURCES = [
  "mac_oui", "sip_user_agent", "http_banner", "http_device_api", "device_banner", "pnp_subscribe",
  "pbx_provisioning_record", "pbx_registration", "vendor_cloud", "barcode_label", "serial_number",
  "manual_entry", "existing_inventory",
] as const;
export type IdentificationSource = (typeof IDENTIFICATION_SOURCES)[number];

/**
 * How much a source is trusted to name a MODEL. ⛔ The phone system's own record is
 * deliberately below the device's own words: Izzy's rig proved records go stale (three
 * phones on his desk carried other customers' records). OUI has no model weight at all.
 */
const MODEL_TRUST: Record<IdentificationSource, number> = {
  vendor_cloud: 95, http_device_api: 90, barcode_label: 85, sip_user_agent: 75, manual_entry: 72,
  http_banner: 65, device_banner: 62, pbx_provisioning_record: 55, existing_inventory: 50,
  pnp_subscribe: 45, pbx_registration: 40, serial_number: 0, mac_oui: 0,
};
/** How much a source is trusted to name a MANUFACTURER. */
const MAKER_TRUST: Record<IdentificationSource, number> = {
  vendor_cloud: 95, http_device_api: 90, barcode_label: 80, sip_user_agent: 75, manual_entry: 70,
  http_banner: 65, device_banner: 62, pbx_provisioning_record: 55, existing_inventory: 50,
  pnp_subscribe: 40, pbx_registration: 35, serial_number: 0, mac_oui: 45,
};

export type IdentificationEvidence = {
  source: IdentificationSource;
  manufacturer?: string | null;
  model?: string | null;
  firmware?: string | null;
  serialNumber?: string | null;
  deviceType?: DeviceType | null;
  /** The hardware address THIS evidence is about, when it carries one (a label, a cloud row). */
  mac?: string | null;
  ip?: string | null;
  observedAt?: string | null;
};

export type IdentificationConfidence = "confirmed" | "high" | "medium" | "low" | "unknown";

export type IdentificationSourceSummary = {
  source: IdentificationSource;
  contributed: Array<"manufacturer" | "model" | "firmware" | "serialNumber" | "deviceType">;
  manufacturer: Manufacturer | null;
  model: string | null;
  observedAt: string | null;
};

export type IdentificationConflict = {
  code: "manufacturer_disagrees" | "model_disagrees" | "evidence_for_different_mac" | "model_does_not_match_maker";
  detail: string;
};

export type DeviceIdentification = {
  valid: boolean;
  manufacturer: Manufacturer;
  model: string | null;
  deviceType: DeviceType;
  deviceTypeLabel: string;
  confidence: IdentificationConfidence;
  confidenceScore: number;
  mac: string | null;
  macFormatted: string | null;
  ip: string | null;
  serialNumber: string | null;
  firmware: string | null;
  capabilities: DeviceCapabilities;
  identificationSources: IdentificationSourceSummary[];
  conflicts: IdentificationConflict[];
  /** Whether a person still needs to tell us what this is before it can be set up. */
  needsIdentifying: boolean;
};

/** Device-supplied text is attacker-influenceable: bounded, control and bidi characters gone. */
export function cleanDeviceText(value: unknown, max = 80): string | null {
  const s = String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s ? s.slice(0, max) : null;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const SERIAL = /^[A-Z0-9][A-Z0-9-]{4,39}$/;

export function cleanSerialNumber(value: unknown): string | null {
  const s = String(value ?? "").toUpperCase().replace(/\s+/g, "").trim();
  return SERIAL.test(s) ? s : null;
}

/* ── capabilities ──────────────────────────────────────────────────────────── */

export const CLOUD_ACTIONS = [
  "lookup", "claim", "reboot", "factory_reset", "reprovision", "push_config", "firmware_update", "diagnostics", "status",
] as const;
export type CloudAction = (typeof CLOUD_ACTIONS)[number];

export type CloudPlatform = "gdms" | "yealink_rps" | "fanvil_fdps" | "poly_zero_touch";

/**
 * What a provider can do in THIS deployment. ⛔ `supportedActions` is the list the adapter
 * implements against the vendor's documented API AND has credentials for — not what the
 * vendor's marketing says the platform can do.
 */
export type ProviderReadiness = {
  manufacturer: SupportedManufacturer;
  platform: CloudPlatform;
  cloudConfigured: boolean;
  supportedActions: CloudAction[];
  claimRequiresSerial: boolean | null;
  /** RPS-style services only redirect a factory-fresh phone; they cannot manage it. */
  redirectOnly: boolean;
  /** Plain English, safe for any screen: why it is or is not available. */
  note: string;
};

export type CloudDeviceState = {
  checked: boolean;
  found: boolean | null;
  managedByUs: boolean | null;
  ownedElsewhere: boolean | null;
  online: boolean | null;
};

export const UNCHECKED_CLOUD_STATE: CloudDeviceState = {
  checked: false, found: null, managedByUs: null, ownedElsewhere: null, online: null,
};

export type CapabilityPath = "vendor_cloud" | "local_http" | "local_pnp" | "pbx_record";

export type DeviceCapabilities = {
  canClaim: boolean;
  canCloudManage: boolean;
  canFactoryReset: boolean;
  canReboot: boolean;
  canReprovision: boolean;
  canPushConfig: boolean;
  canUpdateFirmware: boolean;
  canAssignSip: boolean;
  canCollectDiagnostics: boolean;
  requiresSerialToClaim: boolean;
  requiresLocalAuth: boolean;
  supportsZeroTouch: boolean;
  /** Which mechanism backs each true capability — the admin screen shows this. */
  paths: Partial<Record<keyof Omit<DeviceCapabilities, "paths" | "notes">, CapabilityPath[]>>;
  notes: string[];
};

export function capabilitiesFor(input: {
  manufacturer: Manufacturer;
  model: string | null;
  deviceType: DeviceType;
  readiness?: ProviderReadiness | null;
  cloud?: CloudDeviceState | null;
}): DeviceCapabilities {
  const paths: DeviceCapabilities["paths"] = {};
  const add = (k: keyof DeviceCapabilities["paths"], p: CapabilityPath) => { (paths[k] ??= []).push(p); };
  const notes: string[] = [];
  const readiness = input.readiness && input.readiness.manufacturer === input.manufacturer ? input.readiness : null;
  const cloud = input.cloud ?? UNCHECKED_CLOUD_STATE;
  const configured = Boolean(readiness?.cloudConfigured);
  const has = (a: CloudAction) => configured && Boolean(readiness?.supportedActions.includes(a));

  const canClaim = has("claim") && cloud.ownedElsewhere !== true;
  if (canClaim) add("canClaim", "vendor_cloud");
  if (has("claim") && cloud.ownedElsewhere === true) notes.push("The maker's cloud reports this device belongs to another account.");

  const canCloudManage = configured && !readiness?.redirectOnly && cloud.managedByUs === true;
  if (canCloudManage) add("canCloudManage", "vendor_cloud");
  const cloudDoes = (a: CloudAction) => canCloudManage && has(a);

  const vendorText = input.manufacturer === "poly" ? "polycom" : input.manufacturer;
  const identified = input.manufacturer !== "unknown" && input.manufacturer !== "other";
  const localHttp = identified && vendorSupportsHttpActions(vendorText);
  const localPnp = vendorSupportsPnpHandoff(identified ? vendorText : null) && input.deviceType !== "unknown";

  const canReboot = cloudDoes("reboot") || localHttp;
  if (cloudDoes("reboot")) add("canReboot", "vendor_cloud");
  if (localHttp) add("canReboot", "local_http");

  // ⛔ A local wipe exists for the brands with a shipped reset executor (Yealink Action URI,
  // Grandstream session API). `vendorSupportsLocalReset` is the one place that list lives.
  const localReset = identified && vendorSupportsLocalReset(vendorText);
  const canFactoryReset = cloudDoes("factory_reset") || localReset;
  if (cloudDoes("factory_reset")) add("canFactoryReset", "vendor_cloud");
  if (localReset) add("canFactoryReset", "local_http");

  const canReprovision = cloudDoes("reprovision") || localHttp || localPnp;
  if (cloudDoes("reprovision")) add("canReprovision", "vendor_cloud");
  if (localHttp) add("canReprovision", "local_http");
  if (localPnp) add("canReprovision", "local_pnp");

  const canPushConfig = cloudDoes("push_config");
  if (canPushConfig) add("canPushConfig", "vendor_cloud");
  const canUpdateFirmware = cloudDoes("firmware_update");
  if (canUpdateFirmware) add("canUpdateFirmware", "vendor_cloud");
  const canCollectDiagnostics = cloudDoes("diagnostics");
  if (canCollectDiagnostics) add("canCollectDiagnostics", "vendor_cloud");

  // SIP accounts reach a handset through the phone system's own provisioning record.
  const catalogued = input.model ? Boolean(findCatalogModel(input.model)) : false;
  const canAssignSip = identified && catalogued && vendorSupportsPbxProvisioning(vendorText);
  if (canAssignSip) add("canAssignSip", "pbx_record");
  if (identified && input.model && !catalogued) notes.push("The phone system has no settings profile for this model yet.");

  const requiresSerialToClaim = canClaim && readiness?.claimRequiresSerial === true;
  const supportsZeroTouch = has("claim");
  if (supportsZeroTouch) add("supportsZeroTouch", "vendor_cloud");
  if (readiness && !readiness.cloudConfigured) notes.push(readiness.note);

  return {
    canClaim, canCloudManage, canFactoryReset, canReboot, canReprovision, canPushConfig,
    canUpdateFirmware, canAssignSip, canCollectDiagnostics, requiresSerialToClaim,
    requiresLocalAuth: localHttp, supportsZeroTouch, paths, notes,
  };
}

/* ── the pipeline ──────────────────────────────────────────────────────────── */

export type IdentifyDeviceInput = {
  mac: string;
  ip?: string | null;
  evidence?: IdentificationEvidence[];
  readiness?: ProviderReadiness[];
  cloud?: CloudDeviceState | null;
};

type Scored = { ev: IdentificationEvidence; maker: Manufacturer | null; model: string | null };

export function identifyDevice(input: IdentifyDeviceInput): DeviceIdentification {
  const normalized = normalizeMac(input.mac);
  const ip = IPV4.test(String(input.ip ?? "").trim()) ? String(input.ip).trim() : null;
  const conflicts: IdentificationConflict[] = [];

  if (!normalized) {
    const capabilities = capabilitiesFor({ manufacturer: "unknown", model: null, deviceType: "unknown" });
    return {
      valid: false, manufacturer: "unknown", model: null, deviceType: "unknown", deviceTypeLabel: describeDeviceType("unknown"),
      confidence: "unknown", confidenceScore: 0, mac: null, macFormatted: null, ip, serialNumber: null, firmware: null,
      capabilities, identificationSources: [], conflicts: [], needsIdentifying: true,
    };
  }

  const oui = manufacturerFromOui(normalized);
  const all: IdentificationEvidence[] = [];
  if (oui.manufacturer !== "unknown") all.push({ source: "mac_oui", manufacturer: oui.manufacturer });
  for (const raw of input.evidence ?? []) {
    if (!raw || !(IDENTIFICATION_SOURCES as readonly string[]).includes(raw.source)) continue;
    if (raw.source === "mac_oui") continue; // derived here, never trusted from a caller
    if (raw.mac) {
      const claimed = normalizeMac(raw.mac);
      if (!claimed || claimed !== normalized) {
        conflicts.push({ code: "evidence_for_different_mac", detail: `${raw.source} describes another device` });
        continue;
      }
    }
    all.push(raw);
  }

  const scored: Scored[] = all.map((ev) => {
    const model = ev.source === "mac_oui" ? null : canonicalModel(cleanDeviceText(ev.model, 40));
    const stated = manufacturerFromText(cleanDeviceText(ev.manufacturer, 40));
    const implied = manufacturerFromModel(model);
    const maker: Manufacturer | null = stated !== "unknown" ? stated : implied;
    return { ev, maker, model };
  });

  // Manufacturer: the most trusted source that names one.
  const makerVotes = scored.filter((s) => s.maker && s.maker !== "unknown")
    .sort((a, b) => MAKER_TRUST[b.ev.source] - MAKER_TRUST[a.ev.source]);
  const manufacturer: Manufacturer = makerVotes[0]?.maker ?? "unknown";
  const makerConflict = makerVotes.some((s) => s.maker !== manufacturer && s.maker !== "other" && manufacturer !== "other");
  if (makerConflict) {
    const others = [...new Set(makerVotes.filter((s) => s.maker !== manufacturer).map((s) => `${s.ev.source}=${s.maker}`))];
    conflicts.push({ code: "manufacturer_disagrees", detail: `chose ${manufacturer}; also saw ${others.join(", ")}` });
  }

  // Model: the most trusted source that names one consistent with that manufacturer.
  const modelVotes = scored.filter((s) => s.model)
    .sort((a, b) => MODEL_TRUST[b.ev.source] - MODEL_TRUST[a.ev.source]);
  let chosen: Scored | undefined;
  for (const s of modelVotes) {
    const implied = manufacturerFromModel(s.model);
    if (implied && isSupportedManufacturer(manufacturer) && implied !== manufacturer) {
      conflicts.push({ code: "model_does_not_match_maker", detail: `${s.ev.source} said ${s.model}` });
      continue;
    }
    if (s.maker && s.maker !== "unknown" && manufacturer !== "unknown" && s.maker !== manufacturer) continue;
    chosen = s;
    break;
  }
  const model = chosen?.model ?? null;
  const disagreeingModels = [...new Set(modelVotes.map((s) => s.model).filter((m) => m && m !== model))];
  if (model && disagreeingModels.length) {
    conflicts.push({ code: "model_disagrees", detail: `chose ${model}; also saw ${disagreeingModels.join(", ")}` });
  }

  const byTrust = (field: "firmware" | "serialNumber") => scored
    .filter((s) => (field === "firmware" ? cleanDeviceText(s.ev.firmware, 40) : cleanSerialNumber(s.ev.serialNumber)))
    .sort((a, b) => MODEL_TRUST[b.ev.source] - MODEL_TRUST[a.ev.source])[0];
  const firmwareFrom = byTrust("firmware");
  const serialFrom = byTrust("serialNumber");
  const firmware = firmwareFrom ? cleanDeviceText(firmwareFrom.ev.firmware, 40) : null;
  const serialNumber = serialFrom ? cleanSerialNumber(serialFrom.ev.serialNumber) : null;

  const statedType = scored.find((s) => s.ev.source === "vendor_cloud" && s.ev.deviceType && (DEVICE_TYPES as readonly string[]).includes(s.ev.deviceType));
  const deviceType: DeviceType = statedType?.ev.deviceType ?? classifyDeviceType(manufacturer, model);

  // Confidence.
  let score = 0;
  if (model && chosen) {
    score = MODEL_TRUST[chosen.ev.source];
    const agreeing = new Set(modelVotes.filter((s) => s.model === model).map((s) => s.ev.source));
    if (agreeing.size >= 2) score = Math.min(100, score + 10);
    if (oui.manufacturer !== "unknown" && oui.manufacturer === manufacturer) score = Math.min(100, score + 5);
  } else if (manufacturer !== "unknown") {
    score = makerVotes[0]?.ev.source === "mac_oui" ? 25 : 35;
  }
  if (conflicts.some((c) => c.code === "manufacturer_disagrees" || c.code === "model_disagrees")) score = Math.max(0, score - 25);
  const confidence: IdentificationConfidence =
    score >= 90 ? "confirmed" : score >= 70 ? "high" : score >= 50 ? "medium" : score > 0 ? "low" : "unknown";

  const identificationSources: IdentificationSourceSummary[] = scored.map((s) => {
    const contributed: IdentificationSourceSummary["contributed"] = [];
    if (s.maker === manufacturer && manufacturer !== "unknown") contributed.push("manufacturer");
    if (chosen === s) contributed.push("model");
    if (firmwareFrom === s) contributed.push("firmware");
    if (serialFrom === s) contributed.push("serialNumber");
    if (statedType === s) contributed.push("deviceType");
    return {
      source: s.ev.source,
      contributed,
      manufacturer: s.maker && s.maker !== "unknown" ? s.maker : null,
      model: s.model,
      observedAt: cleanDeviceText(s.ev.observedAt, 40),
    };
  });

  const readiness = (input.readiness ?? []).find((r) => r.manufacturer === manufacturer) ?? null;
  const capabilities = capabilitiesFor({ manufacturer, model, deviceType, readiness, cloud: input.cloud ?? null });

  return {
    valid: true,
    manufacturer,
    model,
    deviceType,
    deviceTypeLabel: describeDeviceType(deviceType),
    confidence,
    confidenceScore: score,
    mac: normalized,
    macFormatted: formatMac(normalized),
    ip,
    serialNumber,
    firmware,
    capabilities,
    identificationSources,
    conflicts,
    needsIdentifying: !model,
  };
}

/* ── duplicates ────────────────────────────────────────────────────────────── */

export type DiscoveryRecord = { mac: string; ip?: string | null; seenAt?: number | null; evidence?: IdentificationEvidence[] };
export type MergedDiscoveryRecord = { mac: string; ip: string | null; previousIps: string[]; seenAt: number | null; evidence: IdentificationEvidence[] };

/**
 * One physical device per hardware address, however many times and ways it was seen.
 * ⛔ The address is the identity, never the IP: a reset drops the lease and the phone
 * comes back somewhere else. The newest sighting's address wins; earlier ones are kept.
 */
export function mergeDiscoveryRecords(records: DiscoveryRecord[]): MergedDiscoveryRecord[] {
  const byMac = new Map<string, MergedDiscoveryRecord>();
  const order: string[] = [];
  const sorted = [...records].sort((a, b) => (a.seenAt ?? 0) - (b.seenAt ?? 0));
  for (const r of sorted) {
    const mac = normalizeMac(r.mac);
    if (!mac) continue;
    let merged = byMac.get(mac);
    if (!merged) {
      merged = { mac, ip: null, previousIps: [], seenAt: null, evidence: [] };
      byMac.set(mac, merged);
      order.push(mac);
    }
    const ip = IPV4.test(String(r.ip ?? "").trim()) ? String(r.ip).trim() : null;
    if (ip && ip !== merged.ip) {
      if (merged.ip && !merged.previousIps.includes(merged.ip)) merged.previousIps.push(merged.ip);
      merged.ip = ip;
    }
    merged.seenAt = r.seenAt ?? merged.seenAt;
    for (const ev of r.evidence ?? []) {
      const key = `${ev.source}|${canonicalModel(ev.model) ?? ""}|${String(ev.manufacturer ?? "").toLowerCase()}|${ev.firmware ?? ""}|${ev.serialNumber ?? ""}`;
      if (!merged.evidence.some((e) => `${e.source}|${canonicalModel(e.model) ?? ""}|${String(e.manufacturer ?? "").toLowerCase()}|${e.firmware ?? ""}|${e.serialNumber ?? ""}` === key)) {
        merged.evidence.push(ev);
      }
    }
  }
  return order.map((m) => byMac.get(m)!);
}

/* ── the label under the phone ─────────────────────────────────────────────── */

/**
 * The fallback when nothing on the network could name the device: what a barcode or QR
 * scanner typed, or what a person copied off the sticker. ⛔ Only what is really there is
 * returned — an unreadable label yields nulls, never a guess.
 */
export function parseDeviceLabel(text: unknown): {
  mac: string | null; serialNumber: string | null; model: string | null; manufacturer: Manufacturer;
} {
  const raw = String(text ?? "").slice(0, 600);
  const upper = raw.toUpperCase();

  let mac: string | null = null;
  const labelled = /\bMAC(?:\s*ADDRESS)?\s*[:#=]?\s*([0-9A-F]{2}(?:[:-]?[0-9A-F]{2}){5}|[0-9A-F]{4}\.[0-9A-F]{4}\.[0-9A-F]{4})\b/.exec(upper);
  const bare = /\b([0-9A-F]{2}([:-])[0-9A-F]{2}(?:\2[0-9A-F]{2}){4})\b/.exec(upper);
  const plain = /(?:^|[^0-9A-Z])([0-9A-F]{12})(?:$|[^0-9A-Z])/.exec(upper);
  for (const candidate of [labelled?.[1], bare?.[1], plain?.[1]]) {
    const parsed = candidate ? parseMacAddress(candidate) : null;
    if (parsed) { mac = parsed.normalized; break; }
  }

  const sn = /\b(?:S\/?N|SN|SERIAL(?:\s*(?:NO|NUMBER))?)\s*[:#=]?\s*([A-Z0-9][A-Z0-9-]{4,39})\b/.exec(upper);
  const serialNumber = sn ? cleanSerialNumber(sn[1]) : null;

  let model: string | null = null;
  const labelledModel = /\b(?:MODEL|P\/?N)\s*[:#=]?\s*([A-Z0-9][A-Z0-9 _-]{1,24})/.exec(upper);
  const candidates = [labelledModel?.[1], ...upper.split(/[\s;,|/]+/)];
  for (const c of candidates) {
    const m = canonicalModel(c);
    if (m && manufacturerFromModel(m)) { model = m; break; }
  }
  if (!model && labelledModel) model = canonicalModel(labelledModel[1]);

  const makerWord = /\b(GRANDSTREAM|YEALINK|FANVIL|POLYCOM|POLY)\b/.exec(upper)?.[1];
  const manufacturer = makerWord ? manufacturerFromText(makerWord) : manufacturerFromModel(model) ?? "unknown";
  return { mac, serialNumber, model, manufacturer };
}

/* ── status words ──────────────────────────────────────────────────────────── */

export const PROVISIONING_STATUSES = [
  "discovered", "identified", "claiming", "managed", "preparing", "provisioning", "rebooting",
  "waiting_for_device", "registering", "online", "failed", "conflict", "manual_action_required",
] as const;
export type ProvisioningStatus = (typeof PROVISIONING_STATUSES)[number];

export type VendorCloudState = "unchecked" | "not_found" | "claiming" | "managed" | "conflict" | "unavailable";

export function describeProvisioningStatus(status: ProvisioningStatus): string {
  switch (status) {
    case "discovered": return "Found on your network";
    case "identified": return "Identified";
    case "claiming": return "Registering with the maker";
    case "managed": return "Registered with the maker";
    case "preparing": return "Getting it ready";
    case "provisioning": return "Sending its settings";
    case "rebooting": return "Restarting";
    case "waiting_for_device": return "Waiting for it to come back";
    case "registering": return "Connecting to your phone system";
    case "online": return "Ready";
    case "failed": return "Could not be set up";
    case "conflict": return "Belongs to another account";
    case "manual_action_required": return "Needs a hand";
  }
}

/**
 * The detailed status shown on a card. ⛔ "online" comes ONLY from the phone system saying
 * the device is registered — never from a vendor API call having succeeded.
 */
export function provisioningStatusFor(input: {
  phoneState: PhoneState | string;
  vendorCloudState?: VendorCloudState | string | null;
  identityConfidence?: IdentificationConfidence | string | null;
  haltedReason?: string | null;
}): ProvisioningStatus {
  const cloud = String(input.vendorCloudState ?? "unchecked");
  switch (input.phoneState) {
    case "REGISTERED": return "online";
    case "FAILED": return "failed";
    case "NEEDS_ATTENTION": return cloud === "conflict" ? "conflict" : "manual_action_required";
    case "WAITING_FOR_REGISTRATION": return "registering";
    case "PROVISIONING": case "PROVISIONING_CONFIGURED": return "provisioning";
    case "WAITING_FOR_REBOOT": case "REDISCOVERING": return "rebooting";
    case "REDISCOVERED": return "waiting_for_device";
    case "PREPARING": case "RESET_AUTHORIZED": case "RESET_REQUESTED": return "preparing";
    default: break;
  }
  if (cloud === "conflict") return "conflict";
  if (cloud === "claiming") return "claiming";
  if (cloud === "managed") return "managed";
  const confidence = String(input.identityConfidence ?? "unknown");
  if (input.phoneState === "DISCOVERED" || confidence === "unknown") return "discovered";
  return "identified";
}

/* ── preparing a device ────────────────────────────────────────────────────── */

export type PreparationStep =
  | "validate_ownership" | "claim" | "reprovision" | "reboot" | "factory_reset" | "assign_sip" | "verify_registration";

export type PreparationPlan = {
  status: ProvisioningStatus;
  steps: Array<{ step: PreparationStep; via: CapabilityPath | "phone_system" | "person"; why: string }>;
  manualAction: { code: string; message: string } | null;
  resetNeeded: boolean;
  resetAuthorized: boolean;
};

/**
 * Identify → validate ownership → claim → FACTORY RESET → reprovision → restart → SIP → verify.
 *
 * ⛔⛔ RESET FIRST, EVERY TIME (Izzy's standing rule, restated 2026-09-14: "reset every time
 * you connect the phone"). Every phone being connected is factory reset BEFORE it is handed
 * its settings, whoever held it before and whatever the cloud could re-point. Ticking the
 * phone is the consent (`resetAuthorized`); a phone already cleared in this setup
 * (`resetAlreadyDone`) is not cleared twice.
 *
 * Never reset: a phone already registered to us (it is not being connected), a device
 * another account holds (not ours to wipe), a model we cannot name, and a model Loopcom
 * cannot send settings to — wiping that one erases the only configuration it can have.
 */
export function planDevicePreparation(input: {
  identification: DeviceIdentification;
  cloud?: CloudDeviceState | null;
  ownership: "ours" | "unclaimed" | "other_tenant" | "other_vendor_account" | "unknown";
  registeredToUs: boolean;
  /** Informational only since reset-first: it changes the wording, never whether the phone is cleared. */
  lockedByOtherProvider: boolean | null;
  resetAuthorized: boolean;
  /** The one reset for this phone in this setup has already been sent. */
  resetAlreadyDone: boolean;
}): PreparationPlan {
  const id = input.identification;
  const caps = id.capabilities;
  const cloud = input.cloud ?? UNCHECKED_CLOUD_STATE;
  const steps: PreparationPlan["steps"] = [];
  const plan = (status: ProvisioningStatus, manualAction: PreparationPlan["manualAction"], resetNeeded = false): PreparationPlan => ({
    status, steps, manualAction, resetNeeded, resetAuthorized: input.resetAuthorized,
  });

  if (!id.valid) return plan("failed", { code: "invalid_mac", message: "This device's hardware address could not be read." });
  if (input.registeredToUs) {
    steps.push({ step: "verify_registration", via: "phone_system", why: "the phone system already reports it registered" });
    return plan("online", null);
  }

  steps.push({ step: "validate_ownership", via: "phone_system", why: "never take a device another account holds" });
  if (input.ownership === "other_tenant" || input.ownership === "other_vendor_account" || cloud.ownedElsewhere === true) {
    return plan("conflict", {
      code: "device_ownership_conflict",
      message: "This device is registered to another account. Loopcom Support needs to release it before it can be set up.",
    });
  }
  if (!id.model) {
    return plan("manual_action_required", {
      code: "model_unknown",
      message: "We could not tell what this device is. Scan the label underneath it or pick the model.",
    });
  }

  if (caps.canClaim && cloud.managedByUs !== true) {
    if (caps.requiresSerialToClaim && !id.serialNumber) {
      return plan("manual_action_required", {
        code: "serial_required",
        message: "The maker needs this device's serial number. Scan the barcode on the label underneath it.",
      });
    }
    steps.push({ step: "claim", via: "vendor_cloud", why: "register the device to Loopcom with its maker" });
  }

  // ⛔ Checked BEFORE the reset: a model nothing can send settings to must never be wiped.
  if (!caps.canAssignSip) {
    return plan("manual_action_required", {
      code: "no_settings_profile",
      message: "Loopcom can't send settings to this model automatically yet. Loopcom Support can finish it.",
    });
  }

  const resetNeeded = !input.resetAlreadyDone;
  if (resetNeeded) {
    // ⛔ Nothing at all — not even the maker registration — happens to an unticked phone.
    if (!input.resetAuthorized) {
      return plan("manual_action_required", {
        code: "reset_authorization_required",
        message: "Tick this phone to set it up. Ticking it approves clearing it first.",
      }, true);
    }
    if (!caps.canFactoryReset) {
      // A maker cloud can clear a device only once it holds it: register first, then this
      // plan is decided again with the cloud's real capabilities.
      if (steps.some((s) => s.step === "claim")) return plan("identified", null, true);
      return plan("manual_action_required", {
        code: "reset_needs_hands_on",
        message: "Every phone is factory reset before it joins Loopcom, and this model can't be reset over the network. Reset it by hand once, then continue.",
      }, true);
    }
    const via = caps.paths.canFactoryReset?.includes("vendor_cloud") ? "vendor_cloud" : "local_http";
    steps.push({
      step: "factory_reset", via,
      why: input.lockedByOtherProvider === true
        ? "every phone is cleared first — this one still carries its previous provider's settings"
        : "every phone is cleared first, before it is handed its Loopcom settings",
    });
  }

  const cloudReprovision = caps.paths.canReprovision?.includes("vendor_cloud") ?? false;
  if (caps.canReprovision) {
    const via = cloudReprovision ? "vendor_cloud" : caps.paths.canReprovision?.includes("local_http") ? "local_http" : "local_pnp";
    steps.push({ step: "reprovision", via, why: "point the device at its Loopcom settings" });
  }
  if (caps.canReboot && steps.some((s) => s.step === "reprovision")) {
    const via = caps.paths.canReboot?.includes("vendor_cloud") ? "vendor_cloud" : "local_http";
    steps.push({ step: "reboot", via, why: "restart so the new settings take effect" });
  }
  steps.push({ step: "assign_sip", via: "pbx_record", why: "the phone system record carries its account" });
  steps.push({ step: "verify_registration", via: "phone_system", why: "only a registration proves it works" });

  return plan(cloud.managedByUs ? "managed" : "identified", null, resetNeeded);
}
