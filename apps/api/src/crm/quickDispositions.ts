/** Tenant quick disposition labels for one-click agent workflow. */

export const DEFAULT_QUICK_DISPOSITIONS = [
  "No Answer",
  "Left Voicemail",
  "Interested",
  "Follow Up",
  "Call Back",
  "Wrong Number",
  "Not Interested",
  "Do Not Call",
  "Appointment Set",
] as const;

export type StoredCustomQuickDisposition = {
  id: string;
  label: string;
  sortOrder: number;
  enabled?: boolean;
};

export type QuickDispositionItem = {
  id: string;
  label: string;
  sortOrder: number;
  isDefault: boolean;
};

function defaultId(label: string): string {
  return `default:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export function buildDefaultQuickDispositionItems(): QuickDispositionItem[] {
  return DEFAULT_QUICK_DISPOSITIONS.map((label, index) => ({
    id: defaultId(label),
    label,
    sortOrder: index,
    isDefault: true,
  }));
}

export function parseStoredCustomQuickDispositions(raw: unknown): StoredCustomQuickDisposition[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredCustomQuickDisposition[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    const label = typeof rec.label === "string" ? rec.label.trim() : "";
    const sortOrder = Number(rec.sortOrder);
    if (!id || !label || !Number.isFinite(sortOrder)) continue;
    out.push({
      id,
      label: label.slice(0, 100),
      sortOrder,
      enabled: rec.enabled === false ? false : true,
    });
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

export function mergeQuickDispositionItems(
  custom: StoredCustomQuickDisposition[],
): QuickDispositionItem[] {
  const defaults = buildDefaultQuickDispositionItems();
  const customItems = custom
    .filter((row) => row.enabled !== false)
    .map((row) => ({
      id: row.id,
      label: row.label,
      sortOrder: defaults.length + row.sortOrder,
      isDefault: false,
    }));
  return [...defaults, ...customItems].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

export function normalizeCustomQuickDispositionInput(
  rows: StoredCustomQuickDisposition[],
): StoredCustomQuickDisposition[] {
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  const normalized: StoredCustomQuickDisposition[] = [];
  for (const [index, row] of rows.entries()) {
    const id = row.id.trim();
    const label = row.label.trim().slice(0, 100);
    if (!id || !label) continue;
    const labelKey = label.toLowerCase();
    if (seenIds.has(id) || seenLabels.has(labelKey)) continue;
    if (DEFAULT_QUICK_DISPOSITIONS.some((d) => d.toLowerCase() === labelKey)) continue;
    seenIds.add(id);
    seenLabels.add(labelKey);
    normalized.push({
      id,
      label,
      sortOrder: Number.isFinite(row.sortOrder) ? row.sortOrder : index,
      enabled: row.enabled !== false,
    });
  }
  return normalized.sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

export function canManageQuickDispositions(
  platformRole: string | undefined,
  crmAccessRole: string | null | undefined,
): boolean {
  const platform = String(platformRole || "").trim().toUpperCase();
  if (platform === "ADMIN" || platform === "TENANT_ADMIN" || platform === "SUPER_ADMIN") return true;
  const crm = String(crmAccessRole || "").trim().toUpperCase();
  return crm === "MANAGER" || crm === "ADMIN";
}
