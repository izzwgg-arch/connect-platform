/**
 * How a phone row carries its identification between requests.
 *
 * ⛔ Evidence is stored ONE ENTRY PER SOURCE, newest wins: each source reports its
 * current view of the device, so a person correcting the model replaces their own earlier
 * answer instead of arguing with it. Every value is re-cleaned on the way IN and on the
 * way OUT — stored JSON is still attacker-influenced text from a device.
 * ⛔ A piece of evidence that names a different hardware address, or an address that
 * cannot be read, is dropped — never re-attached to this device.
 */
import {
  cleanDeviceText,
  cleanSerialNumber,
  DEVICE_TYPES,
  IDENTIFICATION_SOURCES,
  identifyDevice,
  normalizeMac,
  type CloudDeviceState,
  type DeviceIdentification,
  type DeviceType,
  type IdentificationEvidence,
  type IdentificationSource,
  type ProviderReadiness,
  type VendorCloudState,
} from "@connect/shared";

export const MAX_STORED_EVIDENCE = 16;

/** The identity sources the office machine may claim for what it read. */
export const REPORTABLE_IDENTITY_SOURCES = ["http_banner", "sip_user_agent", "http_device_api", "none"] as const;
export type ReportedIdentitySource = (typeof REPORTABLE_IDENTITY_SOURCES)[number];

export function sanitizeEvidence(raw: unknown): IdentificationEvidence | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const source = String(r.source ?? "");
  if (!(IDENTIFICATION_SOURCES as readonly string[]).includes(source) || source === "mac_oui") return null;
  let mac: string | null = null;
  if (r.mac !== undefined && r.mac !== null && r.mac !== "") {
    mac = normalizeMac(r.mac);
    if (!mac) return null;
  }
  const deviceType = typeof r.deviceType === "string" && (DEVICE_TYPES as readonly string[]).includes(r.deviceType)
    ? (r.deviceType as DeviceType)
    : null;
  const ev: IdentificationEvidence = {
    source: source as IdentificationSource,
    manufacturer: cleanDeviceText(r.manufacturer, 40),
    model: cleanDeviceText(r.model, 40),
    firmware: cleanDeviceText(r.firmware, 40),
    serialNumber: cleanSerialNumber(r.serialNumber),
    deviceType,
    mac,
    observedAt: cleanDeviceText(r.observedAt, 40),
  };
  if (!ev.manufacturer && !ev.model && !ev.firmware && !ev.serialNumber && !ev.deviceType) return null;
  return ev;
}

export function readStoredEvidence(value: unknown): IdentificationEvidence[] {
  let list: unknown = value;
  if (typeof value === "string") {
    try { list = JSON.parse(value); } catch { list = []; }
  }
  if (!Array.isArray(list)) return [];
  const out: IdentificationEvidence[] = [];
  for (const item of list.slice(0, MAX_STORED_EVIDENCE * 2)) {
    const ev = sanitizeEvidence(item);
    if (ev) out.push(ev);
  }
  return addEvidence([], out);
}

/** One entry per source; a later observation from the same source replaces the earlier. */
export function addEvidence(existing: IdentificationEvidence[], additions: Array<IdentificationEvidence | null>): IdentificationEvidence[] {
  const bySource = new Map<string, IdentificationEvidence>();
  for (const ev of [...existing, ...additions]) {
    const clean = sanitizeEvidence(ev);
    if (!clean) continue;
    bySource.delete(clean.source);
    bySource.set(clean.source, clean);
  }
  return [...bySource.values()].slice(-MAX_STORED_EVIDENCE);
}

/** What the office machine said about a device, as evidence. */
export function reportedEvidence(p: {
  vendor?: string | null;
  model?: string | null;
  firmware?: string | null;
  serialNumber?: string | null;
  identitySource?: string | null;
}, observedAt: string): IdentificationEvidence | null {
  if (p.identitySource === "none") return null;
  const source: IdentificationSource = p.identitySource === "http_banner" || p.identitySource === "sip_user_agent" || p.identitySource === "http_device_api"
    ? p.identitySource
    : "device_banner";
  const vendor = p.vendor && p.vendor.toLowerCase() !== "unknown" ? p.vendor : null;
  return sanitizeEvidence({ source, manufacturer: vendor, model: p.model, firmware: p.firmware, serialNumber: p.serialNumber, observedAt });
}

/**
 * The evidence a row is judged on. A row written before identification existed has none
 * stored, so what it already says about itself is read as existing inventory — at the
 * low trust that deserves.
 */
export function evidenceForRow(row: { identityEvidence?: unknown; vendor?: string | null; model?: string | null; firmware?: string | null }): IdentificationEvidence[] {
  const stored = readStoredEvidence(row.identityEvidence);
  if (stored.length) return stored;
  const legacy = sanitizeEvidence({ source: "existing_inventory", manufacturer: row.vendor, model: row.model, firmware: row.firmware });
  return legacy ? [legacy] : [];
}

export function identityColumns(input: {
  mac: string;
  ip?: string | null;
  evidence: IdentificationEvidence[];
  readiness?: ProviderReadiness[];
  cloud?: CloudDeviceState | null;
}): { identification: DeviceIdentification; data: Record<string, unknown> } {
  const evidence = addEvidence([], input.evidence);
  const identification = identifyDevice({
    mac: input.mac,
    ip: input.ip ?? null,
    evidence,
    readiness: input.readiness,
    cloud: input.cloud ?? null,
  });
  const data: Record<string, unknown> = {
    deviceType: identification.deviceType,
    identityConfidence: identification.confidence,
    identityEvidence: evidence,
  };
  if (identification.serialNumber) data.serialNumber = identification.serialNumber;
  return { identification, data };
}

export function vendorCloudStateFor(state: CloudDeviceState): VendorCloudState {
  if (!state.checked) return "unchecked";
  if (state.ownedElsewhere === true) return "conflict";
  if (state.managedByUs === true) return "managed";
  return "not_found";
}

/** The cloud state a row last recorded, as the capability rules read it. */
export function cloudStateFromRow(row: { vendorCloudState?: string | null }): CloudDeviceState {
  switch (row.vendorCloudState) {
    case "managed": return { checked: true, found: true, managedByUs: true, ownedElsewhere: false, online: null };
    case "conflict": return { checked: true, found: null, managedByUs: false, ownedElsewhere: true, online: null };
    case "not_found": return { checked: true, found: false, managedByUs: false, ownedElsewhere: null, online: null };
    default: return { checked: false, found: null, managedByUs: null, ownedElsewhere: null, online: null };
  }
}
