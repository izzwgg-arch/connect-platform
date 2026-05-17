"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost, apiPut } from "../../../../../services/apiClient";
import { BillingActionToast, billingErrorMessage } from "../../../../../components/BillingActionToast";
import { BillingActionPanel } from "../../../../../components/billing/BillingActionPanel";
import {
  dollars,
  formatDateTime,
  humanizePricingStateMode,
  humanizeStoredPricingMode,
} from "../../../../../lib/billingUi";
import type { TenantDetail } from "./tenantBillingConfigForms";
import {
  AdminCurrentBillingPlanAssignCard,
  parseStoredPricingMode,
  type PricingModeUi,
} from "./tenantBillingConfigForms";
import type { BillingSettingsSection } from "./adminBillingLinks";

type TenantPricingDiagnostics = {
  mode: string;
  warnings?: string[];
  notices?: string[];
  billingPlanCurrent: { id: string; name: string; code: string; active: boolean } | null;
  billingPlanEffectiveForPreview: { id: string; name: string } | null;
  tenantStoredPricing: Record<string, number | boolean>;
  catalogBaselinePricing: Record<string, number | boolean> | null;
  effectiveInvoicePricing: Record<string, number | boolean>;
  differsFromPlan?: { tenantRowVsCurrentPlanFk?: Record<string, boolean> };
  pricingPreviewExplanation?: {
    tenantOverridesDetected?: boolean;
    scheduledPlanSummary?: string | null;
    explanationLines?: string[];
  };
  pricingState?: { warnings?: string[]; scheduledNext?: { plan: { name: string }; effectiveAt: string } | null };
};

type PricingFieldKey =
  | "extensionPriceCents"
  | "additionalPhoneNumberPriceCents"
  | "smsPriceCents"
  | "firstPhoneNumberFree";

const PRICING_ROWS: { key: PricingFieldKey; label: string; type: "money" | "bool" }[] = [
  { key: "extensionPriceCents", label: "Extensions", type: "money" },
  { key: "additionalPhoneNumberPriceCents", label: "Phone numbers", type: "money" },
  { key: "smsPriceCents", label: "SMS", type: "money" },
  { key: "firstPhoneNumberFree", label: "First number free", type: "bool" },
];

function toDollars(cents: number | undefined | null) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function toCents(value: FormDataEntryValue | null) {
  const n = Number(String(value || "0").replace(/[^0-9. -]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function badgeFromFieldBadges(key: string, badges: Record<string, string> | undefined): "default" | "custom" {
  const b = String(badges?.[key] || "");
  if (b === "tenant_override") return "custom";
  return "default";
}

export function AdminPricingWorkspace({
  detail,
  onSaved,
  previewMonth,
  previewYear,
  settingsSectionHref,
  activeSection,
}: {
  detail: TenantDetail;
  onSaved: () => void;
  previewMonth: number;
  previewYear: number;
  settingsSectionHref: (section: BillingSettingsSection) => string;
  activeSection: "plans-pricing" | "tax-billing" | "gateway";
}) {
  const [diag, setDiag] = useState<TenantPricingDiagnostics | null>(null);
  const [diagLoading, setDiagLoading] = useState(true);
  const [modeSaving, setModeSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [priceSaving, setPriceSaving] = useState(false);
  const [advancedDiag, setAdvancedDiag] = useState<TenantPricingDiagnostics | null>(null);
  const [advancedLoading, setAdvancedLoading] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const openAssignRef = useRef<(() => void) | null>(null);

  const settings = detail.settings || {};
  const pricingMode = parseStoredPricingMode(settings.metadata);
  const catalogLocked = pricingMode === "catalog";
  const pr = detail.preview?.pricingResolution as Record<string, unknown> | undefined;
  const fieldBadges = (pr?.fieldBadges || {}) as Record<string, string>;

  const displayExtension = catalogLocked && pr ? Number(pr.extensionPriceCents) : Number(settings.extensionPriceCents);
  const displayPhone =
    catalogLocked && pr ? Number(pr.additionalPhoneNumberPriceCents) : Number(settings.additionalPhoneNumberPriceCents);
  const displaySms = catalogLocked && pr ? Number(pr.smsPriceCents) : Number(settings.smsPriceCents);
  const displayFirstFree =
    catalogLocked && pr ? pr.firstPhoneNumberFree !== false : settings.firstPhoneNumberFree !== false;

  const loadDiag = useCallback(async () => {
    setDiagLoading(true);
    try {
      const d = await apiGet<TenantPricingDiagnostics>(
        `/admin/billing/platform/tenants/${detail.tenant.id}/pricing-diagnostics?periodMonth=${previewMonth}&periodYear=${previewYear}`,
      );
      setDiag(d);
    } catch {
      setDiag(null);
    } finally {
      setDiagLoading(false);
    }
  }, [detail.tenant.id, previewMonth, previewYear]);

  useEffect(() => {
    void loadDiag();
  }, [loadDiag]);

  const overrideRows = useMemo(() => {
    if (!diag?.differsFromPlan?.tenantRowVsCurrentPlanFk) return [];
    const flags = diag.differsFromPlan.tenantRowVsCurrentPlanFk;
    return PRICING_ROWS.filter((r) => flags[r.key]).map((r) => {
      const stored = diag.tenantStoredPricing[r.key];
      const baseline = diag.catalogBaselinePricing?.[r.key];
      return {
        ...r,
        custom: r.type === "bool" ? (stored ? "Yes" : "No") : dollars(Number(stored ?? 0)),
        defaultVal: r.type === "bool" ? (baseline ? "Yes" : "No") : dollars(Number(baseline ?? 0)),
      };
    });
  }, [diag]);

  const overrideCount = overrideRows.length;

  async function saveMode(next: PricingModeUi) {
    setModeSaving(true);
    setToast(null);
    try {
      await apiPut(`/admin/billing/tenants/${detail.tenant.id}/settings`, {
        billingPricingMode: next === "legacy" ? null : next,
      });
      onSaved();
      void loadDiag();
      setToast({ kind: "ok", text: "Pricing mode updated." });
    } catch (err: unknown) {
      setToast({ kind: "err", text: billingErrorMessage(err, "Could not save pricing mode.") });
    } finally {
      setModeSaving(false);
    }
  }

  async function loadAdvancedDetails() {
    setAdvancedLoading(true);
    try {
      const d = await apiGet<TenantPricingDiagnostics>(
        `/admin/billing/platform/tenants/${detail.tenant.id}/pricing-diagnostics?periodMonth=${previewMonth}&periodYear=${previewYear}`,
      );
      setAdvancedDiag(d);
    } catch {
      setAdvancedDiag(null);
    } finally {
      setAdvancedLoading(false);
    }
  }

  function handleAdvancedToggle(open: boolean) {
    setAdvancedExpanded(open);
    if (open && !advancedDiag) void loadAdvancedDetails();
  }

  const planName = diag?.billingPlanCurrent?.name || settings.billingPlan?.name || "No plan linked";
  const planActive = diag?.billingPlanCurrent?.active !== false;
  const lastUpdated = settings.updatedAt ? formatDateTime(settings.updatedAt) : null;

  const taxBillingHref = settingsSectionHref("tax-billing");

  return (
    <div className="billing-pricing-page billing-p8-scope" data-testid="billing-admin-pricing-workspace">
      <header className="billing-pricing-page__head">
        <div>
          <h2>Pricing</h2>
          <p>Manage this company&apos;s billing plan and custom rates.</p>
        </div>
        <div className="billing-pricing-page__actions">
          <Link href="/admin/billing/plans" className="btn ghost" style={{ fontSize: 13 }}>
            Plan catalog
          </Link>
        </div>
      </header>

      <nav className="billing-pricing-tabs" aria-label="Billing settings sections">
        <Link href={settingsSectionHref("plans-pricing")} className={activeSection === "plans-pricing" ? "active" : ""}>
          Plans &amp; Pricing
        </Link>
        <Link href={settingsSectionHref("tax-billing")} className={activeSection === "tax-billing" ? "active" : ""}>
          Invoice Branding
        </Link>
        <Link href={settingsSectionHref("gateway")} className={activeSection === "gateway" ? "active" : ""}>
          Payment Gateway
        </Link>
      </nav>

      {toast ? <BillingActionToast kind={toast.kind} text={toast.text} /> : null}

      <div className="billing-pricing-grid-top">
        <article className="billing-pricing-card" data-testid="billing-pricing-current-plan">
          <div className="billing-pricing-card__label">Current billing plan</div>
          {diagLoading ? (
            <p className="billing-pricing-card__meta">Loading…</p>
          ) : (
            <>
              <h3 className="billing-pricing-card__title">{planName}</h3>
              <div className="billing-pricing-card__row">
                <span className={`billing-status-pill ${planActive && diag?.billingPlanCurrent ? "good" : ""}`} style={{ fontSize: 11 }}>
                  {diag?.billingPlanCurrent ? (planActive ? "Active" : "Inactive plan") : "No linked plan"}
                </span>
                <button
                  type="button"
                  className="btn ghost"
                  style={{ fontSize: 12 }}
                  data-testid="billing-admin-assign-plan-open"
                  onClick={() => openAssignRef.current?.()}
                >
                  Change plan
                </button>
              </div>
              <p className="billing-pricing-card__meta">
                {diag?.billingPlanEffectiveForPreview?.name &&
                diag.billingPlanCurrent &&
                diag.billingPlanEffectiveForPreview.id !== diag.billingPlanCurrent.id
                  ? `Preview month uses ${diag.billingPlanEffectiveForPreview.name}.`
                  : diag?.billingPlanCurrent
                    ? `Linked to ${diag.billingPlanCurrent.name}.`
                    : "Assign a plan from the catalog to enable plan-based pricing."}
              </p>
              <div className="billing-pricing-card__label" style={{ marginTop: 10 }}>
                Pricing mode
              </div>
              <div className="billing-pricing-mode-chips" role="radiogroup" aria-label="Pricing mode">
                {(["legacy", "catalog", "custom"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`billing-pricing-mode-chip${pricingMode === m ? " active" : ""}`}
                    disabled={modeSaving}
                    onClick={() => void saveMode(m)}
                  >
                    {humanizeStoredPricingMode(m)}
                  </button>
                ))}
              </div>
              <p className="billing-pricing-card__meta" style={{ marginBottom: 0 }}>
                {humanizePricingStateMode(diag?.mode || pricingMode)}
                {catalogLocked ? " · Unit rates follow the active plan." : null}
              </p>
            </>
          )}
        </article>

        <article className="billing-pricing-card" data-testid="billing-pricing-overrides-summary">
          <div className="billing-pricing-card__label">Pricing overrides</div>
          <h3 className="billing-pricing-card__title">{overrideCount === 0 ? "None" : `${overrideCount} custom`}</h3>
          <p className="billing-pricing-card__meta">
            {lastUpdated ? `Last saved ${lastUpdated}` : "No recent changes"}
          </p>
          <div className="billing-pricing-card__row">
            <span className="billing-pricing-rate__chip" style={{ marginTop: 0 }}>
              {overrideCount === 0 ? "Follows default plan" : "Row differs from plan"}
            </span>
            <button type="button" className="btn primary" style={{ fontSize: 12 }} onClick={() => setEditOpen(true)}>
              {catalogLocked ? "View rates" : "Edit pricing"}
            </button>
          </div>
        </article>
      </div>

      <div className="billing-pricing-rates">
        <article className="billing-pricing-rate">
          <div className="billing-pricing-rate__icon" aria-hidden>
            ☎
          </div>
          <div className="billing-pricing-rate__name">Extensions</div>
          <div className="billing-pricing-rate__unit">Per extension / month</div>
          <div className="billing-pricing-rate__price">${toDollars(displayExtension)}</div>
          <span className={`billing-pricing-rate__chip${badgeFromFieldBadges("extensionPriceCents", fieldBadges) === "custom" ? " custom" : ""}`}>
            {badgeFromFieldBadges("extensionPriceCents", fieldBadges) === "custom" ? "Custom" : "Uses default"}
          </span>
        </article>

        <article className="billing-pricing-rate billing-pricing-rate--disabled" title="Dedicated virtual extension pricing is not yet stored separately. Extension rates apply until a backend field is added.">
          <div className="billing-pricing-rate__icon" aria-hidden>
            ⊞
          </div>
          <div className="billing-pricing-rate__name">Virtual extensions</div>
          <div className="billing-pricing-rate__unit">Per virtual extension / month</div>
          <div className="billing-pricing-rate__price">—</div>
          <span className="billing-pricing-rate__chip planned">Planned — uses extension rate</span>
        </article>

        <article className="billing-pricing-rate">
          <div className="billing-pricing-rate__icon" aria-hidden>
            ✉
          </div>
          <div className="billing-pricing-rate__name">SMS</div>
          <div className="billing-pricing-rate__unit">SMS package / month</div>
          <div className="billing-pricing-rate__price">${toDollars(displaySms)}</div>
          <span className={`billing-pricing-rate__chip${badgeFromFieldBadges("smsPriceCents", fieldBadges) === "custom" ? " custom" : ""}`}>
            {badgeFromFieldBadges("smsPriceCents", fieldBadges) === "custom" ? "Custom" : "Uses default"}
          </span>
        </article>

        <article className="billing-pricing-rate">
          <div className="billing-pricing-rate__icon" aria-hidden>
            #
          </div>
          <div className="billing-pricing-rate__name">Phone numbers</div>
          <div className="billing-pricing-rate__unit">
            Additional number / month
            {displayFirstFree ? " · first free" : ""}
          </div>
          <div className="billing-pricing-rate__price">${toDollars(displayPhone)}</div>
          <span
            className={`billing-pricing-rate__chip${
              badgeFromFieldBadges("additionalPhoneNumberPriceCents", fieldBadges) === "custom" ||
              badgeFromFieldBadges("firstPhoneNumberFree", fieldBadges) === "custom"
                ? " custom"
                : ""
            }`}
          >
            {badgeFromFieldBadges("additionalPhoneNumberPriceCents", fieldBadges) === "custom" ||
            badgeFromFieldBadges("firstPhoneNumberFree", fieldBadges) === "custom"
              ? "Custom"
              : "Uses default"}
          </span>
        </article>
      </div>

      <p className="billing-pricing-footnote">
        Prices exclude taxes and regulatory fees.{" "}
        <Link href={taxBillingHref}>Taxes and invoice settings</Link> manage tax profiles and presentation.
      </p>

      <div className="billing-pricing-table-wrap" data-testid="billing-pricing-overrides-table">
        <div className="billing-pricing-table__head">
          <span>Item</span>
          <span>Type</span>
          <span>Custom</span>
          <span>Default</span>
          <span />
        </div>
        {overrideRows.length === 0 ? (
          <div className="billing-empty-state" style={{ padding: "20px 14px", border: "none", background: "transparent" }}>
            <p className="billing-empty-state__title" style={{ fontSize: 14 }}>
              No custom pricing yet
            </p>
            <p className="billing-empty-state__body" style={{ fontSize: 12 }}>
              This company follows the default billing plan.
            </p>
          </div>
        ) : (
          overrideRows.map((row) => (
            <div key={row.key} className="billing-pricing-table__row">
              <span>{row.label}</span>
              <span>{row.type === "bool" ? "Flag" : "Unit price"}</span>
              <span>{row.custom}</span>
              <span style={{ color: "var(--billing-muted, var(--text-dim))" }}>{row.defaultVal}</span>
              <button type="button" className="btn ghost" style={{ fontSize: 11, padding: "4px 8px" }} onClick={() => setEditOpen(true)}>
                Edit
              </button>
            </div>
          ))
        )}
      </div>

      <details
        className="billing-pricing-advanced"
        open={advancedExpanded}
        onToggle={(e) => handleAdvancedToggle((e.target as HTMLDetailsElement).open)}
        data-testid="billing-pricing-advanced-details"
      >
        <summary>Advanced pricing details</summary>
        <div className="billing-pricing-advanced__body">
          {(advancedDiag?.warnings || diag?.pricingState?.warnings || []).map((w) => (
            <div key={w} className="billing-status-pill warn">
              {w}
            </div>
          ))}
          {advancedLoading ? <p className="muted" style={{ fontSize: 13 }}>Loading…</p> : null}
          {advancedDiag && !advancedLoading ? (
            <>
              <p style={{ fontSize: 12, color: "var(--billing-muted)", margin: "0 0 10px" }}>
                Preview period: {previewMonth}/{previewYear} · Mode: {humanizePricingStateMode(advancedDiag.mode)}
              </p>
              {(advancedDiag.pricingPreviewExplanation?.explanationLines || []).length > 0 ? (
                <ul style={{ fontSize: 12, paddingLeft: 18, margin: "0 0 12px", color: "var(--billing-muted)" }}>
                  {advancedDiag.pricingPreviewExplanation!.explanationLines!.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              ) : null}
              <AdvancedPricingResetControl
                detail={detail}
                previewMonth={previewMonth}
                previewYear={previewYear}
                onSaved={() => {
                  onSaved();
                  void loadDiag();
                  void loadAdvancedDetails();
                }}
              />
              <button type="button" className="btn ghost" style={{ fontSize: 12, marginTop: 10 }} onClick={() => void loadAdvancedDetails()}>
                Refresh pricing details
              </button>
            </>
          ) : null}
        </div>
      </details>

      <div className="billing-pricing-embedded-assign" aria-hidden>
        <AdminCurrentBillingPlanAssignCard
          embedded
          tenantId={detail.tenant.id}
          tenantName={detail.tenant.name}
          previewMonth={previewMonth}
          previewYear={previewYear}
          onAssigned={() => {
            onSaved();
            void loadDiag();
          }}
          onRegisterOpenModal={(fn) => {
            openAssignRef.current = fn;
          }}
        />
      </div>

      {editOpen ? (
        <div
          className="billing-pricing-edit-overlay"
          role="dialog"
          aria-modal
          aria-labelledby="billing-pricing-edit-title"
          onClick={(e) => {
            if (e.target === e.currentTarget && !priceSaving) setEditOpen(false);
          }}
        >
          <div className="billing-pricing-edit-panel" onClick={(e) => e.stopPropagation()}>
            <h3 id="billing-pricing-edit-title">{catalogLocked ? "Company rates (read-only)" : "Edit company pricing"}</h3>
            <p>
              {catalogLocked
                ? "Rates follow the active billing plan. Switch to custom pricing to edit amounts here, or use Change plan."
                : "Unit prices stored on this company row. Taxes and autopay are under Taxes & invoices."}
            </p>
            <form
              className="billing-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (catalogLocked) {
                  setEditOpen(false);
                  return;
                }
                setPriceSaving(true);
                try {
                  const form = new FormData(event.currentTarget);
                  await apiPut(`/admin/billing/tenants/${detail.tenant.id}/settings`, {
                    extensionPriceCents: toCents(form.get("extensionPrice")),
                    additionalPhoneNumberPriceCents: toCents(form.get("numberPrice")),
                    smsPriceCents: toCents(form.get("smsPrice")),
                    firstPhoneNumberFree: form.get("firstPhoneNumberFree") === "on",
                    smsBillingEnabled: form.get("smsBillingEnabled") === "on",
                  });
                  onSaved();
                  void loadDiag();
                  setEditOpen(false);
                  setToast({ kind: "ok", text: "Pricing saved." });
                } catch (err: unknown) {
                  setToast({ kind: "err", text: billingErrorMessage(err, "Could not save pricing.") });
                } finally {
                  setPriceSaving(false);
                }
              }}
            >
              <label>
                Per extension
                <input name="extensionPrice" readOnly={catalogLocked} defaultValue={toDollars(displayExtension)} />
              </label>
              <label>
                Additional phone number
                <input name="numberPrice" readOnly={catalogLocked} defaultValue={toDollars(displayPhone)} />
              </label>
              <label>
                SMS package
                <input name="smsPrice" readOnly={catalogLocked} defaultValue={toDollars(displaySms)} />
              </label>
              <label className="billing-checkbox" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  name="firstPhoneNumberFree"
                  type="checkbox"
                  disabled={catalogLocked}
                  defaultChecked={displayFirstFree}
                />
                First phone number free
              </label>
              <label className="billing-checkbox" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input name="smsBillingEnabled" type="checkbox" defaultChecked={!!settings.smsBillingEnabled} />
                Bill SMS package
              </label>
              <div className="row-actions" style={{ marginTop: 12 }}>
                <button type="button" className="btn ghost" disabled={priceSaving} onClick={() => setEditOpen(false)}>
                  {catalogLocked ? "Close" : "Cancel"}
                </button>
                {!catalogLocked ? (
                  <button type="submit" className="btn primary" disabled={priceSaving}>
                    {priceSaving ? "Saving…" : "Save pricing"}
                  </button>
                ) : null}
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AdvancedPricingResetControl({
  detail,
  previewMonth,
  previewYear,
  onSaved,
}: {
  detail: TenantDetail;
  previewMonth: number;
  previewYear: number;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [payload, setPayload] = useState<{
    resetToPlanPreview: { before: Record<string, unknown>; after: Record<string, unknown> | null; canReset: boolean };
  } | null>(null);
  const bp = detail.settings?.billingPlan;

  async function openReset() {
    setBusy(true);
    try {
      const d = await apiGet<{
        resetToPlanPreview: { canReset: boolean; before: Record<string, unknown>; after: Record<string, unknown> | null };
      }>(
        `/admin/billing/platform/tenants/${detail.tenant.id}/pricing-diagnostics?periodMonth=${previewMonth}&periodYear=${previewYear}`,
      );
      setPayload({ resetToPlanPreview: d.resetToPlanPreview });
      if (d.resetToPlanPreview.canReset && d.resetToPlanPreview.after) setOverlay(true);
    } finally {
      setBusy(false);
    }
  }

  async function applyReset() {
    setBusy(true);
    try {
      await apiPost(`/admin/billing/platform/tenants/${detail.tenant.id}/pricing/reset-to-plan`, {});
      setOverlay(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn ghost" style={{ fontSize: 12 }} disabled={busy || !bp} onClick={() => void openReset()}>
        {busy ? "Loading…" : "Reset to plan pricing"}
      </button>
      {overlay && payload?.resetToPlanPreview.after ? (
        <BillingActionPanel
          layout="center"
          centerWidth="min(480px, 96vw)"
          variant="danger"
          onClose={() => {
            if (!busy) setOverlay(false);
          }}
          title="Reset to plan pricing?"
          subtitle="Copies unit prices from the linked plan and switches to follow company billing plan."
          footer={(
            <>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => setOverlay(false)}>
                Cancel
              </button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void applyReset()}>
                {busy ? "Applying…" : "Apply reset"}
              </button>
            </>
          )}
        />
      ) : null}
    </>
  );
}
