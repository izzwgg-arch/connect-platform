/** Query helpers for Admin Billing Phase 2 shell — no API/backend changes. */

export const OPS_TAB_QUERY = "opsTab";

export type AdminOpsTab = "invoices" | "transactions" | "reports" | "collections";

export const BILLING_SECTION_QUERY = "billingSection";

export type BillingSettingsSection =
  | "plans-pricing"
  | "collections"
  | "tax-billing"
  | "invoice-billing"
  | "gateway"
  | "preview"
  | "pricing-explanation";

/** Last-selected company for persisting context across catalog-only routes */
export const ADMIN_BILLING_TENANT_SESSION_KEY = "adminBillingTenantId";

export function isAdminOpsTab(v: string | null): v is AdminOpsTab {
  return v === "invoices" || v === "transactions" || v === "reports" || v === "collections";
}

export function isBillingSettingsSection(v: string | null): v is BillingSettingsSection {
  return (
    v === "plans-pricing" ||
    v === "collections" ||
    v === "tax-billing" ||
    v === "invoice-billing" ||
    v === "gateway" ||
    v === "preview" ||
    v === "pricing-explanation"
  );
}

/** Build `?tenantId=` for admin billing list/report APIs when a workspace is selected. */
export function adminBillingTenantQuery(
  tenantId: string | undefined,
  extra?: Record<string, string | number | null | undefined>,
): string {
  const p = new URLSearchParams();
  if (tenantId) p.set("tenantId", tenantId);
  if (extra) {
    for (const [k, val] of Object.entries(extra)) {
      if (val == null || val === "") continue;
      p.set(k, String(val));
    }
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Append or replace query params preserving existing unrelated keys except `except`. */
export function mergeSearchParams(base: URLSearchParams, patch: Record<string, string | null | undefined>): string {
  const next = new URLSearchParams(base.toString());
  for (const [k, val] of Object.entries(patch)) {
    if (val == null || val === "") next.delete(k);
    else next.set(k, val);
  }
  const s = next.toString();
  return s ? `?${s}` : "";
}
