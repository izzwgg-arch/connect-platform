"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPatch, apiPost, ApiError } from "../../../../../services/apiClient";
import { DataTable } from "../../../../../components/DataTable";
import { DetailCard } from "../../../../../components/DetailCard";
import { ErrorState } from "../../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../../components/PageHeader";
import { billingErrorMessage } from "../../../../../components/BillingActionToast";
import { useAppContext } from "../../../../../hooks/useAppContext";
import { dollars } from "../../../../../lib/billingUi";

type BillingPlanCatalogRow = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  extensionPriceCents: number;
  additionalPhoneNumberPriceCents: number;
  smsPriceCents: number;
  firstPhoneNumberFree: boolean;
  currentTenantCount: number;
  scheduledTenantCount: number;
};

function planPriceSummary(p: Pick<BillingPlanCatalogRow, "extensionPriceCents" | "additionalPhoneNumberPriceCents" | "smsPriceCents" | "firstPhoneNumberFree">): string {
  const bits = [
    `${dollars(p.extensionPriceCents)}/ext`,
    `${dollars(p.additionalPhoneNumberPriceCents)}/phone`,
    `${dollars(p.smsPriceCents)}/SMS`,
  ];
  if (p.firstPhoneNumberFree) bits.push("1st phone free");
  return bits.join(" · ");
}

function deactivateBlockedHint(row: BillingPlanCatalogRow): string | null {
  if (row.scheduledTenantCount > 0) {
    return "Cannot deactivate while tenants have this plan scheduled for a future billing period.";
  }
  if (row.currentTenantCount > 0) {
    return "Cannot deactivate while tenants are assigned to this plan.";
  }
  return null;
}

function catalogApiErrorDetail(err: unknown): string {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    const body = err.body as { error?: string; message?: string };
    const code = body.error;
    if (code === "billing_plan_deactivate_blocked_scheduled") {
      return "Deactivate blocked: one or more tenants have this plan scheduled — reassign or cancel scheduled changes first.";
    }
    if (code === "billing_plan_deactivate_blocked_current") {
      return "Deactivate blocked: one or more tenants are on this plan — move them to another catalog plan first.";
    }
    if (code === "billing_plan_code_taken") return "That plan code is already in use. Pick another slug.";
    if (code === "billing_plan_inactive") return "Cannot use an inactive plan here.";
  }
  return billingErrorMessage(err, "Request failed.");
}

function parseMoneyToCents(raw: string): number {
  const n = Number.parseFloat(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

function centsInputValue(cents: number): string {
  return (Number(cents || 0) / 100).toFixed(2);
}

function openCreateDefaults() {
  return {
    createCode: "",
    createName: "",
    createExt: "0",
    createPhone: "0",
    createSms: "0",
    createFirstFree: true,
    createActive: true,
  };
}

export default function AdminBillingPlansPage() {
  const { can, backendJwtRole } = useAppContext();
  const canPlatformAdminBilling = backendJwtRole === "SUPER_ADMIN" && can("can_view_admin_billing");

  const [includeInactive, setIncludeInactive] = useState(false);
  const [plans, setPlans] = useState<BillingPlanCatalogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");

  const [panel, setPanel] = useState<"none" | "create" | "edit" | "clone">("none");
  const [focusPlan, setFocusPlan] = useState<BillingPlanCatalogRow | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const [createCode, setCreateCode] = useState("");
  const [createName, setCreateName] = useState("");
  const [createExt, setCreateExt] = useState("0");
  const [createPhone, setCreatePhone] = useState("0");
  const [createSms, setCreateSms] = useState("0");
  const [createFirstFree, setCreateFirstFree] = useState(true);
  const [createActive, setCreateActive] = useState(true);

  const [editName, setEditName] = useState("");
  const [editExt, setEditExt] = useState("0");
  const [editPhone, setEditPhone] = useState("0");
  const [editSms, setEditSms] = useState("0");
  const [editFirstFree, setEditFirstFree] = useState(true);
  const [editActive, setEditActive] = useState(true);

  const [cloneCode, setCloneCode] = useState("");
  const [cloneName, setCloneName] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setListError("");
    try {
      const q = includeInactive ? "?includeInactive=true" : "";
      const rows = await apiGet<BillingPlanCatalogRow[]>(`/admin/billing/platform/billing-plans${q}`);
      setPlans(rows);
    } catch (err: unknown) {
      setListError(billingErrorMessage(err, "Failed to load billing plans."));
    } finally {
      setLoading(false);
    }
  }, [includeInactive]);

  useEffect(() => {
    void load();
  }, [load]);

  const visiblePlans = useMemo(() => {
    if (includeInactive) return plans;
    return plans.filter((p) => p.active !== false);
  }, [plans, includeInactive]);

  function closePanel() {
    setPanel("none");
    setFocusPlan(null);
    setFormError("");
    const d = openCreateDefaults();
    setCreateCode(d.createCode);
    setCreateName(d.createName);
    setCreateExt(d.createExt);
    setCreatePhone(d.createPhone);
    setCreateSms(d.createSms);
    setCreateFirstFree(d.createFirstFree);
    setCreateActive(d.createActive);
    setCloneCode("");
    setCloneName("");
  }

  function startCreate() {
    const d = openCreateDefaults();
    setCreateCode(d.createCode);
    setCreateName(d.createName);
    setCreateExt(d.createExt);
    setCreatePhone(d.createPhone);
    setCreateSms(d.createSms);
    setCreateFirstFree(d.createFirstFree);
    setCreateActive(d.createActive);
    setFocusPlan(null);
    setFormError("");
    setPanel("create");
  }

  function startEdit(row: BillingPlanCatalogRow) {
    setFocusPlan(row);
    setEditName(row.name);
    setEditExt(centsInputValue(row.extensionPriceCents));
    setEditPhone(centsInputValue(row.additionalPhoneNumberPriceCents));
    setEditSms(centsInputValue(row.smsPriceCents));
    setEditFirstFree(row.firstPhoneNumberFree);
    setEditActive(row.active);
    setFormError("");
    setPanel("edit");
  }

  function startClone(row: BillingPlanCatalogRow) {
    setFocusPlan(row);
    setCloneCode("");
    setCloneName(`${row.name} (copy)`);
    setFormError("");
    setPanel("clone");
  }

  async function submitCreate() {
    setSaving(true);
    setFormError("");
    const ext = parseMoneyToCents(createExt);
    const ph = parseMoneyToCents(createPhone);
    const sms = parseMoneyToCents(createSms);
    if (!createCode.trim() || !createName.trim()) {
      setFormError("Code and name are required.");
      setSaving(false);
      return;
    }
    if ([ext, ph, sms].some((n) => !Number.isFinite(n) || n < 0)) {
      setFormError("Enter valid non‑negative dollar amounts for all prices.");
      setSaving(false);
      return;
    }
    try {
      await apiPost<BillingPlanCatalogRow>("/admin/billing/platform/billing-plans", {
        code: createCode.trim(),
        name: createName.trim(),
        extensionPriceCents: ext,
        additionalPhoneNumberPriceCents: ph,
        smsPriceCents: sms,
        firstPhoneNumberFree: createFirstFree,
        active: createActive,
      });
      closePanel();
      await load();
    } catch (err: unknown) {
      setFormError(catalogApiErrorDetail(err));
    } finally {
      setSaving(false);
    }
  }

  async function submitEdit() {
    if (!focusPlan) return;
    setSaving(true);
    setFormError("");
    const ext = parseMoneyToCents(editExt);
    const ph = parseMoneyToCents(editPhone);
    const sms = parseMoneyToCents(editSms);
    if (!editName.trim()) {
      setFormError("Name is required.");
      setSaving(false);
      return;
    }
    if ([ext, ph, sms].some((n) => !Number.isFinite(n) || n < 0)) {
      setFormError("Enter valid non‑negative dollar amounts for all prices.");
      setSaving(false);
      return;
    }
    const body: Record<string, unknown> = {
      name: editName.trim(),
      extensionPriceCents: ext,
      additionalPhoneNumberPriceCents: ph,
      smsPriceCents: sms,
      firstPhoneNumberFree: editFirstFree,
    };
    if (editActive !== focusPlan.active) {
      body.active = editActive;
    }
    try {
      await apiPatch<BillingPlanCatalogRow>(`/admin/billing/platform/billing-plans/${focusPlan.id}`, body);
      closePanel();
      await load();
    } catch (err: unknown) {
      setFormError(catalogApiErrorDetail(err));
    } finally {
      setSaving(false);
    }
  }

  async function submitClone() {
    if (!focusPlan) return;
    setSaving(true);
    setFormError("");
    if (!cloneCode.trim() || !cloneName.trim()) {
      setFormError("New code and name are required.");
      setSaving(false);
      return;
    }
    try {
      await apiPost<BillingPlanCatalogRow>(`/admin/billing/platform/billing-plans/${focusPlan.id}/clone`, {
        code: cloneCode.trim(),
        name: cloneName.trim(),
      });
      closePanel();
      await load();
    } catch (err: unknown) {
      setFormError(catalogApiErrorDetail(err));
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(row: BillingPlanCatalogRow) {
    setSaving(true);
    setFormError("");
    try {
      await apiPatch<BillingPlanCatalogRow>(`/admin/billing/platform/billing-plans/${row.id}`, { active: false });
      await load();
    } catch (err: unknown) {
      setFormError(catalogApiErrorDetail(err));
    } finally {
      setSaving(false);
    }
  }

  async function activatePlan(row: BillingPlanCatalogRow) {
    setSaving(true);
    setFormError("");
    try {
      await apiPatch<BillingPlanCatalogRow>(`/admin/billing/platform/billing-plans/${row.id}`, { active: true });
      await load();
    } catch (err: unknown) {
      setFormError(catalogApiErrorDetail(err));
    } finally {
      setSaving(false);
    }
  }

  if (!canPlatformAdminBilling) {
    return (
      <div className="state-box">
        Billing plan catalog is only available to platform administrators (JWT role SUPER_ADMIN) with billing access.
      </div>
    );
  }

  return (
    <div className="stack compact-stack billing-admin-shell">
      <PageHeader
        title="Admin Billing — Billing plans (catalog)"
        subtitle="Platform-wide plan definitions. Scheduled plan changes and per-company rates are edited in Company billing setup."
      />

      <div className="row-actions" style={{ flexWrap: "wrap", gap: 8 }}>
        <Link className="btn ghost" href="/admin/billing">
          ← Admin Billing overview
        </Link>
        <Link className="btn ghost" href="/admin/billing/settings">
          Company billing setup
        </Link>
        <button className="btn primary" type="button" data-testid="billing-admin-plans-open-create" onClick={startCreate}>
          Create plan
        </button>
      </div>

      <div style={{ fontSize: 12, background: "#fef3c7", border: "1px solid #f59e0b", borderRadius: 5, padding: "8px 12px", color: "#92400e" }}>
        <strong>Catalog changes apply to future cycles only.</strong> Editing a plan affects new invoice previews and invoices not yet issued; PDFs and totals on invoices already sent are fixed snapshots.
      </div>
      <div style={{ fontSize: 12, background: "#eff6ff", border: "1px solid #93c5fd", borderRadius: 5, padding: "8px 12px", color: "#1e40af" }}>
        Per-tenant extension, phone, and SMS amounts in <strong>Company billing setup</strong> can differ from these catalog defaults.
      </div>
      <div style={{ fontSize: 12, background: "#f9fafb", border: "1px solid var(--border, #e5e7eb)", borderRadius: 5, padding: "8px 12px", color: "var(--muted, #6b7280)" }}>
        Plans are never hard-deleted here. <strong>Plan code is immutable</strong> after create (use Clone for a new slug). <strong>Inactive plans</strong> stay out of the scheduled plan dropdown in Company billing setup.
      </div>

      <DetailCard title="Filters">
        <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Include inactive plans in the table
        </label>
        {!includeInactive ? (
          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            The list shows active catalog plans only. Turn on the toggle to audit retired plans.
          </p>
        ) : null}
      </DetailCard>

      {formError && panel === "none" ? (
        <div className="billing-toast billing-toast--err" role="alert">
          {formError}
        </div>
      ) : null}

      {loading ? <LoadingSkeleton rows={4} /> : null}
      {listError ? <ErrorState message={listError} /> : null}

      {!loading && !listError ? (
        <DetailCard title="Plans" dataTestId="billing-admin-plans-list-card">
          {visiblePlans.length === 0 ? (
            <p className="muted">No plans match the current filter.</p>
          ) : (
            <DataTable<BillingPlanCatalogRow>
              rows={visiblePlans}
              columns={[
                { key: "code", label: "Code", render: (r) => <code style={{ fontSize: 12 }}>{r.code}</code> },
                { key: "name", label: "Name", render: (r) => r.name },
                {
                  key: "active",
                  label: "Active",
                  render: (r) => (r.active ? <span className="billing-status-pill good">Yes</span> : <span className="billing-status-pill bad">No</span>),
                },
                { key: "prices", label: "Catalog prices", render: (r) => <span style={{ fontSize: 12 }}>{planPriceSummary(r)}</span> },
                {
                  key: "use",
                  label: "Tenants",
                  render: (r) => (
                    <span style={{ fontSize: 12 }}>
                      Current: <strong>{r.currentTenantCount}</strong>
                      {" · "}
                      Scheduled: <strong>{r.scheduledTenantCount}</strong>
                    </span>
                  ),
                },
                {
                  key: "actions",
                  label: "Actions",
                  render: (r) => {
                    const blocked = deactivateBlockedHint(r);
                    return (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                        <button className="btn ghost" type="button" style={{ fontSize: 12 }} onClick={() => startEdit(r)} disabled={saving}>
                          Edit
                        </button>
                        <button
                          className="btn ghost"
                          type="button"
                          data-testid={`billing-admin-plans-clone-${r.id}`}
                          style={{ fontSize: 12 }}
                          onClick={() => startClone(r)}
                          disabled={saving}
                        >
                          Clone
                        </button>
                        {r.active ? (
                          <span title={blocked || undefined}>
                            <button
                              className="btn ghost"
                              type="button"
                              style={{ fontSize: 12, color: "var(--danger, #dc2626)" }}
                              disabled={saving || !!blocked}
                              onClick={() => void deactivate(r)}
                            >
                              Deactivate
                            </button>
                          </span>
                        ) : (
                          <button
                            className="btn ghost"
                            type="button"
                            style={{ fontSize: 12 }}
                            disabled={saving}
                            onClick={() => void activatePlan(r)}
                          >
                            Activate
                          </button>
                        )}
                        {blocked ? (
                          <span style={{ fontSize: 11, color: "var(--muted, #6b7280)", maxWidth: 220 }}>
                            {blocked}
                          </span>
                        ) : null}
                      </div>
                    );
                  },
                },
              ]}
            />
          )}
        </DetailCard>
      ) : null}

      {panel === "create" ? (
        <DetailCard title="Create catalog plan" dataTestId="billing-admin-plans-panel-create">
          <div style={{ fontSize: 12, marginBottom: 12, color: "var(--muted)" }}>
            Use a stable slug/code (lowercase letters, numbers, hyphens, underscores — 2–64 chars). It cannot be changed later.
          </div>
          {formError ? <div style={{ color: "var(--danger)", marginBottom: 8 }}>{formError}</div> : null}
          <div className="billing-form" style={{ display: "grid", gap: 10, maxWidth: 480 }}>
            <label>
              Code (slug)
              <input className="input" value={createCode} onChange={(e) => setCreateCode(e.target.value)} placeholder="e.g. business-2026" autoComplete="off" />
            </label>
            <label>
              Display name
              <input className="input" value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="Business" />
            </label>
            <label>
              Extension ($/extension/mo)
              <input className="input" value={createExt} onChange={(e) => setCreateExt(e.target.value)} inputMode="decimal" />
            </label>
            <label>
              Additional phone ($/month each)
              <input className="input" value={createPhone} onChange={(e) => setCreatePhone(e.target.value)} inputMode="decimal" />
            </label>
            <label>
              SMS ($/segment or unit)
              <input className="input" value={createSms} onChange={(e) => setCreateSms(e.target.value)} inputMode="decimal" />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={createFirstFree} onChange={(e) => setCreateFirstFree(e.target.checked)} />
              First phone number free
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={createActive} onChange={(e) => setCreateActive(e.target.checked)} />
              Active (appears in schedule dropdown)
            </label>
            <div className="row-actions">
              <button className="btn primary" type="button" disabled={saving} onClick={() => void submitCreate()}>
                {saving ? "Saving…" : "Create plan"}
              </button>
              <button className="btn ghost" type="button" data-testid="billing-admin-plans-create-cancel" disabled={saving} onClick={closePanel}>
                Cancel
              </button>
            </div>
          </div>
        </DetailCard>
      ) : null}

      {panel === "edit" && focusPlan ? (
        <DetailCard title={`Edit plan — ${focusPlan.code}`}>
          <div style={{ fontSize: 12, marginBottom: 12, background: "#f9fafb", padding: 8, borderRadius: 4 }}>
            Code <code>{focusPlan.code}</code> is read-only. Use <strong>Clone</strong> to duplicate pricing under a new slug.
          </div>
          {formError ? <div style={{ color: "var(--danger)", marginBottom: 8 }}>{formError}</div> : null}
          <div className="billing-form" style={{ display: "grid", gap: 10, maxWidth: 480 }}>
            <label>
              Display name
              <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </label>
            <label>
              Extension ($/extension/mo)
              <input className="input" value={editExt} onChange={(e) => setEditExt(e.target.value)} inputMode="decimal" />
            </label>
            <label>
              Additional phone ($/month each)
              <input className="input" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} inputMode="decimal" />
            </label>
            <label>
              SMS ($/segment or unit)
              <input className="input" value={editSms} onChange={(e) => setEditSms(e.target.value)} inputMode="decimal" />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={editFirstFree} onChange={(e) => setEditFirstFree(e.target.checked)} />
              First phone number free
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} />
              Active (appears in schedule dropdown)
            </label>
            <div className="row-actions">
              <button className="btn primary" type="button" disabled={saving} onClick={() => void submitEdit()}>
                {saving ? "Saving…" : "Save changes"}
              </button>
              <button className="btn ghost" type="button" disabled={saving} onClick={closePanel}>
                Cancel
              </button>
            </div>
          </div>
        </DetailCard>
      ) : null}

      {panel === "clone" && focusPlan ? (
        <DetailCard title={`Clone plan — ${focusPlan.code}`} dataTestId="billing-admin-plans-panel-clone">
          <p style={{ fontSize: 13, color: "var(--muted)" }}>
            Copies catalog prices and &quot;first phone free&quot; from <strong>{focusPlan.name}</strong>. The new plan is created active.
          </p>
          {formError ? <div style={{ color: "var(--danger)", marginBottom: 8 }}>{formError}</div> : null}
          <div className="billing-form" style={{ display: "grid", gap: 10, maxWidth: 480 }}>
            <label>
              New code (slug)
              <input className="input" value={cloneCode} onChange={(e) => setCloneCode(e.target.value)} placeholder="e.g. business-2026-v2" autoComplete="off" />
            </label>
            <label>
              New display name
              <input className="input" value={cloneName} onChange={(e) => setCloneName(e.target.value)} />
            </label>
            <div className="row-actions">
              <button className="btn primary" type="button" disabled={saving} onClick={() => void submitClone()}>
                {saving ? "Cloning…" : "Clone plan"}
              </button>
              <button className="btn ghost" type="button" data-testid="billing-admin-plans-clone-cancel" disabled={saving} onClick={closePanel}>
                Cancel
              </button>
            </div>
          </div>
        </DetailCard>
      ) : null}
    </div>
  );
}
