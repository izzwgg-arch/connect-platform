import { ApiError } from "../../services/apiClient";

type SavedEntity = { id?: unknown };

export function formatCrmSaveError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { detail?: unknown; issues?: Array<{ message?: string }> } | null;
    const detail = typeof body?.detail === "string" ? body.detail.trim() : "";
    const issue = body?.issues?.[0]?.message?.trim() ?? "";
    const parts = [err.message, detail, issue].filter(Boolean);
    if (parts.length > 0) return parts.join(" — ");
  }
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  return "Save failed. Please try again.";
}

export function requireSavedEntity<T extends SavedEntity>(
  entity: T | null | undefined,
  label: string,
): T {
  const id = typeof entity?.id === "string" ? entity.id.trim() : "";
  if (!id) {
    throw new Error(`Save did not return a ${label}. Please retry.`);
  }
  return entity as T;
}

export function requireSavedScript<T extends SavedEntity>(res: { script?: T | null }): T {
  return requireSavedEntity(res.script, "script");
}

export function requireSavedChecklist<T extends SavedEntity>(res: { checklist?: T | null }): T {
  return requireSavedEntity(res.checklist, "checklist");
}

type ChecklistLike = {
  id: string;
  name: string;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
  items?: Array<{
    id: string;
    label: string;
    required: boolean;
    sortOrder: number;
  }>;
};

export function normalizeChecklist<T extends ChecklistLike>(checklist: T): T & {
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  items: NonNullable<T["items"]>;
} {
  return {
    ...checklist,
    isActive: checklist.isActive ?? true,
    createdAt: checklist.createdAt ?? new Date().toISOString(),
    updatedAt: checklist.updatedAt ?? checklist.createdAt ?? new Date().toISOString(),
    items: checklist.items ?? [],
  };
}
