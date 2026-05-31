/** Right-rail collapsible section ordering for CRM contact workspace. */

export const RIGHT_RAIL_SECTION_IDS = [
  "right-rail-relationship",
  "right-rail-activity",
  "right-rail-outreach-rules",
  "right-rail-open-tasks",
  "right-rail-scratch-notes",
  "right-rail-business-profile",
  "right-rail-contact-info",
] as const;

export type RightRailSectionId = (typeof RIGHT_RAIL_SECTION_IDS)[number];

export const DEFAULT_RIGHT_RAIL_SECTION_ORDER: readonly RightRailSectionId[] = RIGHT_RAIL_SECTION_IDS;

export const RIGHT_RAIL_ORDER_STORAGE_KEY = "crm-contact-workspace-right-rail-order";

export function rightRailOrderStorageKey(userId?: string | null): string {
  return userId ? `${RIGHT_RAIL_ORDER_STORAGE_KEY}:${userId}` : RIGHT_RAIL_ORDER_STORAGE_KEY;
}

export function normalizeRightRailSectionOrder(
  stored: unknown,
  allowed: readonly RightRailSectionId[] = RIGHT_RAIL_SECTION_IDS,
): RightRailSectionId[] {
  if (!Array.isArray(stored)) return [...allowed];
  const allowedSet = new Set<RightRailSectionId>(allowed);
  const seen = new Set<RightRailSectionId>();
  const result: RightRailSectionId[] = [];

  for (const item of stored) {
    if (typeof item !== "string") continue;
    const id = item as RightRailSectionId;
    if (!allowedSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }

  for (const id of allowed) {
    if (!seen.has(id)) result.push(id);
  }

  return result;
}

export function moveRightRailSection(
  order: readonly RightRailSectionId[],
  activeId: RightRailSectionId,
  targetId: RightRailSectionId,
  position: "before" | "after",
): RightRailSectionId[] {
  if (activeId === targetId) return [...order];
  const without = order.filter((id) => id !== activeId);
  const targetIndex = without.indexOf(targetId);
  if (targetIndex < 0) return [...order];
  const insertAt = position === "after" ? targetIndex + 1 : targetIndex;
  const next = [...without];
  next.splice(insertAt, 0, activeId);
  return next;
}

function readStorage(): Storage | null {
  if (typeof globalThis.localStorage === "undefined") return null;
  return globalThis.localStorage;
}

export function loadRightRailSectionOrder(userId?: string | null): RightRailSectionId[] {
  const storage = readStorage();
  if (!storage) return [...DEFAULT_RIGHT_RAIL_SECTION_ORDER];
  try {
    const raw = storage.getItem(rightRailOrderStorageKey(userId));
    if (!raw) return [...DEFAULT_RIGHT_RAIL_SECTION_ORDER];
    return normalizeRightRailSectionOrder(JSON.parse(raw));
  } catch {
    return [...DEFAULT_RIGHT_RAIL_SECTION_ORDER];
  }
}

export function saveRightRailSectionOrder(order: readonly RightRailSectionId[], userId?: string | null): void {
  const storage = readStorage();
  if (!storage) return;
  const normalized = normalizeRightRailSectionOrder(order);
  storage.setItem(rightRailOrderStorageKey(userId), JSON.stringify(normalized));
}

export function resetRightRailSectionOrder(userId?: string | null): RightRailSectionId[] {
  readStorage()?.removeItem(rightRailOrderStorageKey(userId));
  return [...DEFAULT_RIGHT_RAIL_SECTION_ORDER];
}

export function isRightRailDragEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(pointer: coarse)").matches) return false;
  if (window.matchMedia("(max-width: 1279px)").matches) return false;
  return true;
}
