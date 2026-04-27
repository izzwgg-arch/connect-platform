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
  return /^\d{3}$/.test(ext);
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
  const directTenant = readString(row, ["tenantId", "tenant_id", "tenant", "platformTenantId", "platform_tenant_id"]);
  if (directTenant) return directTenant === tenantId;
  const nestedTenant = row.tenant;
  if (nestedTenant && typeof nestedTenant === "object") {
    const nestedId = readString(nestedTenant as ExtensionRow, ["id", "tenantId", "tenant_id"]);
    if (nestedId) return nestedId === tenantId;
  }
  const selectedTenantName = normalizeTenantName(tenantName);
  const rowTenantName = normalizeTenantName(readString(row, ["tenantName", "tenant_name", "tenantDisplayName"]));
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

export function callBelongsToTenant(call: LiveCall, tenantId: string | null, tenantExtensions: Set<string>): boolean {
  if (tenantId === null) return true;
  if (call.tenantId === tenantId) return true;
  if (call.tenantId && call.tenantId !== tenantId) return false;
  return (call.extensions ?? []).some((ext) => tenantExtensions.has(ext));
}

export function callsForTenant(calls: LiveCall[], tenantId: string | null, extensionRows: ExtensionRow[], tenantName?: string | null): LiveCall[] {
  if (tenantId === null) return calls;
  const tenantExtensions = tenantExtensionSet(extensionRows, tenantId, tenantName);
  return calls.filter((call) => callBelongsToTenant(call, tenantId, tenantExtensions));
}

export function extensionSetsFromCalls(calls: LiveCall[]): { activeExts: Set<string>; ringingExts: Set<string> } {
  const activeExts = new Set<string>();
  const ringingExts = new Set<string>();
  for (const call of calls) {
    const exts = (call.extensions ?? []).filter(isValidTenantExtension);
    if (call.state === "up" || call.state === "held") exts.forEach((ext) => activeExts.add(ext));
    else if (call.state === "ringing" || call.state === "dialing") exts.forEach((ext) => ringingExts.add(ext));
  }
  return { activeExts, ringingExts };
}

export function presenceFromLiveCalls(rawState: string, ext: string, activeExts: Set<string>, ringingExts: Set<string>): PresenceState {
  if (ringingExts.has(ext)) return "ringing";
  if (activeExts.has(ext)) return "on_call";
  const state = rawState.toLowerCase();
  if (state === "not_inuse" || state === "idle" || state === "registered" || state === "0") return "available";
  if (state === "ringing" || state === "2") return "ringing";
  if (state === "inuse" || state === "busy" || state === "onhold" || state === "1" || state === "3") return "on_call";
  return "offline";
}

export function liveExtensionForTenant(
  extensions: LiveExtensionState[],
  extension: string,
  tenantId: string | null | undefined,
): LiveExtensionState | undefined {
  return extensions.find((entry) => entry.extension === extension && (!tenantId || !entry.tenantId || entry.tenantId === tenantId));
}
