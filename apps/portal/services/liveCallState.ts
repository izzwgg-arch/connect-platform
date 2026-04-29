import type { LiveCall, LiveExtensionState } from "../types/liveCall";

type ExtensionRow = Record<string, unknown>;

export type PresenceState = "available" | "ringing" | "on_call" | "offline";

function readString(row: ExtensionRow, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function normalizeTenantName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

export function isValidTenantExtension(ext: string): boolean {
  // Match the telephony normalizer: 2-6 digit dialplan extensions. Previously
  // this was locked to exactly 3 digits which silently dropped 4-digit
  // extensions (e.g. 1001) from tenant-scoped live-call filtering.
  return /^\d{2,6}$/.test(ext);
}

export function isSystemExtensionName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized === "pbx user" ||
    /^pbx user\s+\d+$/.test(normalized) ||
    normalized.includes("invite lifecycle") ||
    normalized.includes("provisioning") ||
    normalized.includes("smoke") ||
    normalized.includes("system") ||
    normalized === "voice user" ||
    /^voice user\s+\d+$/.test(normalized)
  );
}

export function rowTenantMatches(row: ExtensionRow, tenantId: string | null | undefined, tenantName: string | null | undefined): boolean {
  if (!tenantId) return false;
  const selectedTenantName = normalizeTenantName(tenantName);
  const rowTenantName = normalizeTenantName(readString(row, ["tenantName", "tenant_name", "tenantDisplayName"]));
  if (selectedTenantName && rowTenantName) return rowTenantName === selectedTenantName;
  const directTenant = readString(row, ["tenantId", "tenant_id", "tenant", "platformTenantId", "platform_tenant_id"]);
  if (directTenant) return directTenant === tenantId;
  const nestedTenant = row.tenant;
  if (nestedTenant && typeof nestedTenant === "object") {
    const nestedId = readString(nestedTenant as ExtensionRow, ["id", "tenantId", "tenant_id"]);
    if (nestedId) return nestedId === tenantId;
  }
  return true;
}

function rowStrongTenantMatches(row: ExtensionRow, tenantId: string | null | undefined, tenantName: string | null | undefined): boolean {
  if (!tenantId) return false;
  const selectedTenantName = normalizeTenantName(tenantName);
  const rowTenantName = normalizeTenantName(readString(row, ["tenantName", "tenant_name", "tenantDisplayName"]));
  const directTenant = readString(row, ["tenantId", "tenant_id", "tenant", "platformTenantId", "platform_tenant_id"]);
  if (directTenant) {
    if (directTenant === tenantId) return true;
    // Super-admin tenant switching often uses synthetic VitalPBX ids such as
    // `vpbx:gesheft`, while extension rows carry the Connect tenant CUID.
    // In that mode the display name is the bridge between namespaces.
    return Boolean(selectedTenantName && rowTenantName && rowTenantName === selectedTenantName);
  }
  const nestedTenant = row.tenant;
  if (nestedTenant && typeof nestedTenant === "object") {
    const nestedId = readString(nestedTenant as ExtensionRow, ["id", "tenantId", "tenant_id"]);
    if (nestedId) {
      if (nestedId === tenantId) return true;
      return Boolean(selectedTenantName && rowTenantName && rowTenantName === selectedTenantName);
    }
  }
  return Boolean(selectedTenantName && rowTenantName && rowTenantName === selectedTenantName);
}

export function tenantExtensionSet(rows: ExtensionRow[], tenantId: string | null | undefined, tenantName: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (!rowStrongTenantMatches(row, tenantId, tenantName)) continue;
    const ext = readString(row, ["extension", "extNumber", "ext_number", "number", "sipExtension"]);
    if (ext && isValidTenantExtension(ext)) out.add(ext);
  }
  return out;
}

export function callBelongsToTenant(
  call: LiveCall,
  tenantId: string | null,
  tenantExtensions: Set<string>,
  tenantName?: string | null,
): boolean {
  if (tenantId === null) return true;
  if (call.tenantId === tenantId) return true;
  const selectedTenantName = normalizeTenantName(tenantName);
  const callTenantName = normalizeTenantName(call.tenantName);
  if (selectedTenantName && callTenantName && selectedTenantName === callTenantName) return true;
  if (call.tenantId && call.tenantId !== tenantId) return false;
  return (call.extensions ?? []).some((ext) => tenantExtensions.has(ext));
}

export function callsForTenant(calls: LiveCall[], tenantId: string | null, extensionRows: ExtensionRow[], tenantName?: string | null): LiveCall[] {
  if (tenantId === null) return calls;
  const tenantExtensions = tenantExtensionSet(extensionRows, tenantId, tenantName);
  return calls.filter((call) => callBelongsToTenant(call, tenantId, tenantExtensions, tenantName));
}

export function involvedExtensionsFromCall(call: LiveCall): string[] {
  const out = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (isValidTenantExtension(trimmed)) out.add(trimmed);
  };

  for (const ext of call.extensions ?? []) add(ext);
  // Some PBX event paths produce a visible live call before `extensions[]` is
  // populated. Dashboard still shows that call from `from`/`to`, so BLF must
  // derive from those same fields too or the two surfaces will disagree.
  add(call.from);
  add(call.to);
  add(call.connectedLine);

  return [...out];
}

export function extensionSetsFromCalls(calls: LiveCall[]): { activeExts: Set<string>; ringingExts: Set<string> } {
  const activeExts = new Set<string>();
  const ringingExts = new Set<string>();
  for (const call of calls) {
    const exts = involvedExtensionsFromCall(call);
    if (call.state === "up" || call.state === "held") exts.forEach((ext) => activeExts.add(ext));
    else if (call.state === "ringing" || call.state === "dialing") exts.forEach((ext) => ringingExts.add(ext));
  }
  return { activeExts, ringingExts };
}

export function presenceFromLiveCalls(rawState: string, ext: string, activeExts: Set<string>, ringingExts: Set<string>): PresenceState {
  // Live calls are the authoritative source of On-Call / Ringing. If an
  // extension appears in a live call, that wins unconditionally.
  if (ringingExts.has(ext)) return "ringing";
  if (activeExts.has(ext)) return "on_call";

  const state = (rawState || "").toLowerCase();

  // Registered / idle → Available. Empty or unknown rawState is treated as
  // offline so BLF doesn't display "Available" for extensions we have no
  // state for at all.
  if (state === "not_inuse" || state === "idle" || state === "registered" || state === "0") {
    return "available";
  }

  // AMI sometimes reports "inuse"/"ringing"/"busy" without a matching live
  // call (event ordering, missed AMI event, stale hint). When there is no
  // corresponding live call we REFUSE to call the extension busy — otherwise
  // BLF/Team Directory go out of sync with Dashboard Live Calls, which is
  // the ground truth. Show Available instead.
  if (state === "inuse" || state === "busy" || state === "onhold" || state === "ringing" ||
      state === "1" || state === "2" || state === "3") {
    return "available";
  }

  return "offline";
}

export function liveExtensionForTenant(
  extensions: LiveExtensionState[],
  extension: string,
  tenantId: string | null | undefined,
): LiveExtensionState | undefined {
  // Strict tenant match first (avoids cross-tenant leak when two tenants
  // share the same extension number). Fall back to a tenantless entry only
  // if no tenant-specific state exists, since a tenantless row is usually an
  // unresolved AMI event and is better than nothing.
  if (tenantId) {
    const strict = extensions.find((entry) => entry.extension === extension && entry.tenantId === tenantId);
    if (strict) return strict;
    const untagged = extensions.find((entry) => entry.extension === extension && !entry.tenantId);
    return untagged;
  }
  return extensions.find((entry) => entry.extension === extension);
}
