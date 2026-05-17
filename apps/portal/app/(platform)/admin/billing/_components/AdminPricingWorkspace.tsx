"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost, apiPut } from "../../../../../services/apiClient";
import { BillingActionToast, billingErrorMessage } from "../../../../../components/BillingActionToast";
import { BillingActionPanel } from "../../../../../components/billing/BillingActionPanel";
import {
  activeExtensionsFlatRateFromMetadata,
  adminTenantStandingHeadline,
  computeTenantMonthlyEstimate,
  dollars,
  formatDateTime,
  humanizePricingStateMode,
  humanizeStoredPricingMode,
  parseBillingFlatRateFromMetadata,
  previewServiceSubtotalCents,
  worstNonTerminalInvoiceStatus,
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

type DraftPricing = {
  extensionPriceCents: number;
  additionalPhoneNumberPriceCents: number;
  smsPriceCents: number;
  firstPhoneNumberFree: boolean;
  smsBillingEnabled: boolean;
  flatRateEnabled: boolean;
  flatRateAmountCents: number;
};

function toDollars(cents: number | undefined | null) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function parseDollarsInput(value: string) {
  const n = Number(String(value || "0").replace(/[^0-9. -]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function badgeFromFieldBadges(key: string, badges: Record<string, string> | undefined): "default" | "custom" {
  const b = String(badges?.[key] || "");
  if (b === "tenant_override") return "custom";
  return "default";
}

function draftFromDetail(detail: TenantDetail, catalogLocked: boolean): DraftPricing {
  const settings = detail.settings || {};
  const pr = detail.preview?.pricingResolution as Record<string, unknown> | undefined;
  const flat = parseBillingFlatRateFromMetadata(settings.metadata);
  return {
    extensionPriceCents: Number(catalogLocked && pr ? pr.extensionPriceCents : settings.extensionPriceCents) || 0,
    additionalPhoneNumberPriceCents:
      Number(catalogLocked && pr ? pr.additionalPhoneNumberPriceCents : settings.additionalPhoneNumberPriceCents) || 0,
    smsPriceCents: Number(catalogLocked && pr ? pr.smsPriceCents : settings.smsPriceCents) || 0,
    firstPhoneNumberFree: catalogLocked && pr ? pr.firstPhoneNumberFree !== false : settings.firstPhoneNumberFree !== false,
    smsBillingEnabled: Boolean(detail.usage?.smsEnabled ?? settings.smsBillingEnabled),
    flatRateEnabled: flat?.enabled === true,
    flatRateAmountCents: flat?.amountCents ?? 0,
  };
}

function QuantityStepper({
  value,
  min,
  max,
  disabled,
  readOnly,
  onChange,
  testId,
}: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  readOnly?: boolean;
  onChange: (next: number) => void;
  testId?: string;
}) {
  const locked = disabled || readOnly;
  return (
    <div className="billing-item-stepper" data-testid={testId}>
      <button
        type="button"
        className="billing-item-stepper__btn"
        disabled={locked || value <= min}
        aria-label="Decrease quantity"
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        −
      </button>
      <span className="billing-item-stepper__value" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className="billing-item-stepper__btn"
        disabled={locked || value >= max}
        aria-label="Increase quantity"
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </button>
    </div>
  );
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
  const [priceSaving, setPriceSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [advancedDiag, setAdvancedDiag] = useState<TenantPricingDiagnostics | null>(null);
  const [advancedLoading, setAdvancedLoading] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [activeItemKey, setActiveItemKey] = useState<string | null>(null);
  const openAssignRef = useRef<(() => void) | null>(null);

  const settings = detail.settings || {};
  const usage = detail.usage || {};
  const preview = detail.preview || {};
  const pricingMode = parseStoredPricingMode(settings.metadata);
  const catalogLocked = pricingMode === "catalog";
  const pr = preview.pricingResolution as Record<string, unknown> | undefined;
  const fieldBadges = (pr?.fieldBadges || {}) as Record<string, string>;

  const savedDraft = useMemo(() => draftFromDetail(detail, catalogLocked), [detail, catalogLocked]);
  const [draft, setDraft] = useState<DraftPricing>(savedDraft);

  useEffect(() => {
    setDraft(savedDraft);
  }, [savedDraft]);

  const extensionCount = Number(usage.extensionCount || 0);
  const additionalPhoneCount = Number(usage.additionalPhoneNumberCount || 0);
  const phoneNumberCount = Number(usage.phoneNumberCount || 0);
  const smsQty = draft.smsBillingEnabled ? 1 : 0;

  const extensionsFlatActive =
    draft.flatRateEnabled && draft.flatRateAmountCents > 0 && extensionCount > 0;

  const isDirty = useMemo(() => {
    const flatDirty =
      draft.flatRateEnabled !== savedDraft.flatRateEnabled ||
      draft.flatRateAmountCents !== savedDraft.flatRateAmountCents;
    if (catalogLocked) {
      return draft.smsBillingEnabled !== savedDraft.smsBillingEnabled || flatDirty;
    }
    return (
      draft.extensionPriceCents !== savedDraft.extensionPriceCents ||
      draft.additionalPhoneNumberPriceCents !== savedDraft.additionalPhoneNumberPriceCents ||
      draft.smsPriceCents !== savedDraft.smsPriceCents ||
      draft.firstPhoneNumberFree !== savedDraft.firstPhoneNumberFree ||
      draft.smsBillingEnabled !== savedDraft.smsBillingEnabled ||
      flatDirty
    );
  }, [draft, savedDraft, catalogLocked]);

  const estimate = useMemo(() => {
    const addPhoneQty = draft.firstPhoneNumberFree === false ? phoneNumberCount : additionalPhoneCount;
    return computeTenantMonthlyEstimate({
      extensionCount,
      additionalPhoneNumberCount: addPhoneQty,
      smsEnabled: draft.smsBillingEnabled,
      extensionPriceCents: draft.extensionPriceCents,
      additionalPhoneNumberPriceCents: draft.additionalPhoneNumberPriceCents,
      smsPriceCents: draft.smsPriceCents,
      extensionsFlatRateCents: extensionsFlatActive ? draft.flatRateAmountCents : null,
      creditsCents: Number(settings.creditsCents || 0),
      discountPercent: Number(settings.discountPercent || 0),
      previewServiceSubtotalCents: previewServiceSubtotalCents(preview),
      previewTaxCents: Number(preview.taxCents || 0),
    });
  }, [draft, extensionCount, additionalPhoneCount, phoneNumberCount, settings, preview, extensionsFlatActive]);

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
      const qty =
        r.key === "extensionPriceCents"
          ? extensionCount
          : r.key === "additionalPhoneNumberPriceCents"
            ? additionalPhoneCount
            : r.key === "smsPriceCents"
              ? smsQty
              : 1;
      const unit =
        r.key === "extensionPriceCents"
          ? draft.extensionPriceCents
          : r.key === "additionalPhoneNumberPriceCents"
            ? draft.additionalPhoneNumberPriceCents
            : r.key === "smsPriceCents"
              ? draft.smsPriceCents
              : 0;
      return {
        ...r,
        quantity: qty,
        monthlySubtotal: r.type === "bool" ? "—" : dollars(qty * unit),
        custom: r.type === "bool" ? (stored ? "Yes" : "No") : dollars(Number(stored ?? 0)),
        defaultVal: r.type === "bool" ? (baseline ? "Yes" : "No") : dollars(Number(baseline ?? 0)),
      };
    });
  }, [diag, extensionCount, additionalPhoneCount, smsQty, draft]);

  const flatRateTableRow = extensionsFlatActive
    ? {
        key: "flat_rate_extensions",
        label: "Extensions",
        defaultVal: "Per-extension pricing",
        custom: "Flat monthly rate",
        quantity: extensionCount,
        monthlySubtotal: dollars(draft.flatRateAmountCents),
      }
    : null;

  const tableRows = flatRateTableRow ? [flatRateTableRow, ...overrideRows] : overrideRows;

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

  async function savePricing() {
    setPriceSaving(true);
    setToast(null);
    try {
      const payload: Record<string, unknown> = {
        smsBillingEnabled: draft.smsBillingEnabled,
        billingFlatRate: draft.flatRateEnabled
          ? {
              enabled: true,
              amountCents: draft.flatRateAmountCents,
              appliesTo: "extensions",
            }
          : {
              enabled: false,
              amountCents: draft.flatRateAmountCents,
              appliesTo: "extensions",
            },
      };
      if (!catalogLocked) {
        payload.extensionPriceCents = draft.extensionPriceCents;
        payload.additionalPhoneNumberPriceCents = draft.additionalPhoneNumberPriceCents;
        payload.smsPriceCents = draft.smsPriceCents;
        payload.firstPhoneNumberFree = draft.firstPhoneNumberFree;
      }
      await apiPut(`/admin/billing/tenants/${detail.tenant.id}/settings`, payload);
      onSaved();
      void loadDiag();
      setToast({ kind: "ok", text: "Pricing saved." });
    } catch (err: unknown) {
      setToast({ kind: "err", text: billingErrorMessage(err, "Could not save pricing.") });
    } finally {
      setPriceSaving(false);
    }
  }

  function resetDraft() {
    setDraft(savedDraft);
    setToast(null);
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
  const standing = worstNonTerminalInvoiceStatus(detail.invoices);
  const standingLabel = adminTenantStandingHeadline(standing);
  const taxBillingHref = settingsSectionHref("tax-billing");

  const savedFlatActive = activeExtensionsFlatRateFromMetadata(settings.metadata);

  const billingItems = [
    {
      key: "extensions",
      icon: "☎",
      title: "Extensions",
      quantity: extensionsFlatActive ? 1 : extensionCount,
      quantityAuto: true,
      quantityNote: extensionsFlatActive
        ? `${extensionCount} active · covered by flat rate`
        : `${extensionCount} active · billable`,
      unitCents: extensionsFlatActive ? draft.flatRateAmountCents : draft.extensionPriceCents,
      priceKey: extensionsFlatActive ? null : ("extensionPriceCents" as const),
      chip: extensionsFlatActive ? ("flat" as const) : badgeFromFieldBadges("extensionPriceCents", fieldBadges),
    },
    {
      key: "virtual",
      icon: "⊞",
      title: "Virtual extensions",
      quantity: null as number | null,
      quantityAuto: true,
      quantityNote: "Not billed separately",
      unitCents: draft.extensionPriceCents,
      priceKey: null,
      chip: "default" as const,
      planned: true,
    },
    {
      key: "phone_numbers",
      icon: "#",
      title: "Phone numbers",
      quantity: draft.firstPhoneNumberFree ? additionalPhoneCount : phoneNumberCount,
      quantityAuto: true,
      quantityNote: draft.firstPhoneNumberFree
        ? `${phoneNumberCount} total · ${additionalPhoneCount} billable`
        : `${phoneNumberCount} billable`,
      unitCents: draft.additionalPhoneNumberPriceCents,
      priceKey: "additionalPhoneNumberPriceCents" as const,
      chip:
        badgeFromFieldBadges("additionalPhoneNumberPriceCents", fieldBadges) === "custom" ||
        badgeFromFieldBadges("firstPhoneNumberFree", fieldBadges) === "custom"
          ? ("custom" as const)
          : ("default" as const),
    },
    {
      key: "sms",
      icon: "✉",
      title: "SMS packages",
      quantity: smsQty,
      quantityAuto: false,
      quantityNote: draft.smsBillingEnabled ? "Package billed monthly" : "SMS billing off",
      unitCents: draft.smsPriceCents,
      priceKey: "smsPriceCents" as const,
      chip: badgeFromFieldBadges("smsPriceCents", fieldBadges),
      smsToggle: true,
    },
  ];

  return (
    <div className="billing-pricing-page billing-p8-scope" data-testid="billing-admin-pricing-workspace">
      <header className="billing-pricing-page__head">
        <div>
          <h2>Pricing</h2>
          <p>Manage this company&apos;s billing setup, quantities, and pricing.</p>
        </div>
        <div className="billing-pricing-page__actions">
          <Link href="/admin/billing/plans" className="btn ghost billing-pricing-page__action">
            Plan catalog
          </Link>
          <button
            type="button"
            className="btn primary billing-pricing-page__action"
            data-testid="billing-admin-assign-plan-open"
            onClick={() => openAssignRef.current?.()}
          >
            Change plan
          </button>
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

      <section className="billing-pricing-profile" data-testid="billing-pricing-profile">
        <div className="billing-pricing-profile__segment">
          <span className="billing-pricing-profile__label">Plan</span>
          <strong>{diagLoading ? "…" : planName}</strong>
        </div>
        <div className="billing-pricing-profile__segment">
          <span className="billing-pricing-profile__label">Pricing mode</span>
          <strong>{humanizeStoredPricingMode(pricingMode)}</strong>
        </div>
        <div className="billing-pricing-profile__segment">
          <span className="billing-pricing-profile__label">Account</span>
          <strong>{standingLabel}</strong>
        </div>
        <div className="billing-pricing-profile__segment billing-pricing-profile__segment--estimate">
          <span className="billing-pricing-profile__label">Estimated monthly</span>
          <strong className="billing-pricing-profile__total" data-testid="billing-pricing-monthly-total">
            {dollars(estimate.totalCents)}
          </strong>
        </div>
        <div className="billing-pricing-profile__segment">
          <span className="billing-pricing-profile__label">Autopay</span>
          <strong>{settings.autoBillingEnabled ? "Enabled" : "Off"}</strong>
        </div>
        <div className="billing-pricing-profile__modes" role="radiogroup" aria-label="Pricing mode">
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
      </section>

      <section className="billing-flat-rate-card" data-testid="billing-flat-rate-card">
        <div className="billing-flat-rate-card__head">
          <div>
            <h3>Flat monthly rate for extensions</h3>
            <p>Charge one monthly rate for all active extensions.</p>
          </div>
          <label className="billing-flat-rate-card__toggle">
            <input
              type="checkbox"
              checked={draft.flatRateEnabled}
              onChange={(e) => setDraft((d) => ({ ...d, flatRateEnabled: e.target.checked }))}
            />
            <span>Enabled</span>
          </label>
        </div>
        <div className="billing-flat-rate-card__body">
          <label className="billing-flat-rate-card__amount">
            <span>Monthly flat rate</span>
            <div className="billing-item-card__price-input-wrap">
              <span className="billing-item-card__currency">$</span>
              <input
                type="text"
                inputMode="decimal"
                className="billing-item-card__price-input"
                disabled={!draft.flatRateEnabled}
                value={toDollars(draft.flatRateAmountCents)}
                onChange={(e) => setDraft((d) => ({ ...d, flatRateAmountCents: parseDollarsInput(e.target.value) }))}
              />
            </div>
          </label>
          <p className="billing-flat-rate-card__meta">
            {extensionCount} active extension{extensionCount === 1 ? "" : "s"}
            {savedFlatActive ? ` · Saved invoices use ${dollars(savedFlatActive.amountCents)}/mo` : ""}
          </p>
          {draft.flatRateEnabled ? <span className="billing-pricing-rate__chip custom">Flat rate</span> : null}
        </div>
      </section>

      <section className="billing-items-grid" aria-label="Billing items">
        {billingItems.map((item) => {
          const subtotal = item.planned || item.quantity == null ? 0 : item.quantity * item.unitCents;
          const isActive = activeItemKey === item.key;
          return (
            <article
              key={item.key}
              className={`billing-item-card${isActive ? " billing-item-card--active" : ""}${item.planned ? " billing-item-card--planned" : ""}`}
              data-testid={`billing-item-card-${item.key}`}
              onFocus={() => setActiveItemKey(item.key)}
              onMouseEnter={() => setActiveItemKey(item.key)}
            >
              <div className="billing-item-card__head">
                <span className="billing-item-card__icon" aria-hidden>
                  {item.icon}
                </span>
                <div className="billing-item-card__title-wrap">
                  <h3 className="billing-item-card__title">{item.title}</h3>
                  <p className="billing-item-card__qty-note">{item.quantityNote}</p>
                </div>
              </div>

              <div className="billing-item-card__qty-row">
                <span className="billing-item-card__field-label">Quantity</span>
                {item.planned ? (
                  <span className="billing-item-card__auto-qty">—</span>
                ) : item.smsToggle ? (
                  <QuantityStepper
                    testId="billing-item-sms-qty"
                    value={smsQty}
                    min={0}
                    max={1}
                    onChange={(n) => setDraft((d) => ({ ...d, smsBillingEnabled: n >= 1 }))}
                  />
                ) : (
                  <QuantityStepper value={item.quantity ?? 0} min={0} max={9999} readOnly onChange={() => {}} />
                )}
                {item.quantityAuto && !item.planned ? (
                  <span className="billing-item-card__auto-chip">Auto-calculated</span>
                ) : null}
              </div>

              <label className="billing-item-card__price-row">
                <span className="billing-item-card__field-label">Unit price</span>
                <div className="billing-item-card__price-input-wrap">
                  <span className="billing-item-card__currency">$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="billing-item-card__price-input"
                    readOnly={catalogLocked || item.planned || !item.priceKey}
                    value={toDollars(item.unitCents)}
                    onChange={(e) => {
                      if (!item.priceKey || catalogLocked) return;
                      const cents = parseDollarsInput(e.target.value);
                      setDraft((d) => ({ ...d, [item.priceKey!]: cents }));
                    }}
                  />
                </div>
              </label>

              <div className="billing-item-card__subtotal" data-testid={`billing-item-subtotal-${item.key}`}>
                <span>Monthly subtotal</span>
                <strong className="billing-item-card__subtotal-value">{item.planned ? "—" : dollars(subtotal)}</strong>
              </div>

              <span
                className={`billing-pricing-rate__chip${
                  item.chip === "custom" || item.chip === "flat" ? " custom" : ""
                }${item.planned ? " planned" : ""}`}
              >
                {item.planned
                  ? "Uses extension rate"
                  : item.chip === "flat"
                    ? "Flat rate"
                    : item.chip === "custom"
                      ? "Custom pricing"
                      : "Using plan default"}
              </span>
            </article>
          );
        })}
      </section>

      <section className="billing-monthly-summary" data-testid="billing-monthly-summary">
        <div className="billing-monthly-summary__head">
          <h3>Monthly estimate</h3>
          <p>Operational preview — not a finalized invoice. Taxes scale from current preview rules.</p>
        </div>
        <ul className="billing-monthly-summary__lines">
          {estimate.lines.map((line) => (
            <li key={line.key} className={line.omitted ? "billing-monthly-summary__line--muted" : undefined}>
              <span>
                {line.label}
                {line.autoQuantity ? <span className="billing-monthly-summary__auto"> · auto</span> : null}
              </span>
              <span className="billing-monthly-summary__amount">{line.omitted ? "—" : dollars(line.subtotalCents)}</span>
            </li>
          ))}
          {estimate.taxEstimateCents > 0 ? (
            <li>
              <span>Taxes &amp; fees (est.)</span>
              <span className="billing-monthly-summary__amount">{dollars(estimate.taxEstimateCents)}</span>
            </li>
          ) : (
            <li className="billing-monthly-summary__line--muted">
              <span>Taxes &amp; fees</span>
              <span>Per tax profile when enabled</span>
            </li>
          )}
        </ul>
        <div className="billing-monthly-summary__total">
          <span>Estimated total</span>
          <strong>{dollars(estimate.totalCents)}</strong>
        </div>
        <p className="billing-pricing-footnote">
          Quantities for extensions and phone numbers come from active workspace resources.{" "}
          <Link href={taxBillingHref}>Taxes &amp; invoice settings</Link> control tax profiles and presentation.
        </p>
      </section>

      <div className="billing-pricing-table-wrap" data-testid="billing-pricing-overrides-table">
        <div className="billing-pricing-table__head">
          <span>Item</span>
          <span>Default</span>
          <span>Override</span>
          <span>Qty</span>
          <span>Monthly</span>
        </div>
        {tableRows.length === 0 ? (
          <div className="billing-pricing-table__empty">This company follows the standard billing profile.</div>
        ) : (
          tableRows.map((row) => (
            <div key={row.key} className="billing-pricing-table__row">
              <span>{row.label}</span>
              <span className="billing-pricing-table__muted">{row.defaultVal}</span>
              <span>{row.custom}</span>
              <span>{row.quantity}</span>
              <span className="billing-pricing-table__amount">{row.monthlySubtotal}</span>
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
        <summary>Advanced</summary>
        <div className="billing-pricing-advanced__body">
          {(advancedDiag?.warnings || diag?.pricingState?.warnings || []).map((w) => (
            <div key={w} className="billing-status-pill warn">
              {w}
            </div>
          ))}
          {advancedLoading ? <p className="muted billing-pricing-advanced__meta">Loading…</p> : null}
          {advancedDiag && !advancedLoading ? (
            <>
              <p className="billing-pricing-advanced__meta">
                Preview {previewMonth}/{previewYear} · {humanizePricingStateMode(advancedDiag.mode)}
                {diag?.billingPlanCurrent ? ` · Linked plan ${diag.billingPlanCurrent.name}` : ""}
              </p>
              {(advancedDiag.pricingPreviewExplanation?.explanationLines || []).length > 0 ? (
                <ul className="billing-pricing-advanced__lines">
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
              <button type="button" className="btn ghost billing-pricing-advanced__refresh" onClick={() => void loadAdvancedDetails()}>
                Refresh diagnostics
              </button>
            </>
          ) : null}
          {settings.updatedAt ? (
            <p className="billing-pricing-advanced__meta">Last saved {formatDateTime(settings.updatedAt)}</p>
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

      {isDirty ? (
        <div className="billing-pricing-save-bar" data-testid="billing-pricing-save-bar">
          <span className="billing-pricing-save-bar__hint">Unsaved pricing changes</span>
          <div className="billing-pricing-save-bar__actions">
            <button type="button" className="btn ghost" disabled={priceSaving} onClick={resetDraft}>
              Reset changes
            </button>
            <button type="button" className="btn primary" disabled={priceSaving} onClick={() => void savePricing()}>
              {priceSaving ? "Saving…" : "Save pricing"}
            </button>
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
      <button type="button" className="btn ghost billing-pricing-advanced__reset" disabled={busy || !bp} onClick={() => void openReset()}>
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
