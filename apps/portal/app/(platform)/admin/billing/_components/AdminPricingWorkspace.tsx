"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost, apiPut } from "../../../../../services/apiClient";
import { BillingActionToast, billingErrorMessage } from "../../../../../components/BillingActionToast";
import { BillingActionPanel } from "../../../../../components/billing/BillingActionPanel";
import {
  activeExtensionsFlatRateFromMetadata,
  adminTenantStandingHeadline,
  buildBillingQuantityOverridesPayload,
  computeTenantMonthlyEstimate,
  defaultQuantityOverrideDraft,
  dollars,
  formatDateTime,
  humanizePricingStateMode,
  humanizeStoredPricingMode,
  parseBillingFlatRateFromMetadata,
  previewServiceSubtotalCents,
  parseTollFreeDidPriceCentsFromMetadata,
  resolveBillingQuantitiesForPortal,
  resolveTollFreeDidPriceCentsForPortal,
  worstNonTerminalInvoiceStatus,
  type BillingQuantityOverrideKey,
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
  quantityOverrides: Record<BillingQuantityOverrideKey, { mode: "auto" | "manual"; quantity: number }>;
  tollFreeDidPriceCents: number;
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
  const usage = detail.usage || {};
  const pr = detail.preview?.pricingResolution as Record<string, unknown> | undefined;
  const flat = parseBillingFlatRateFromMetadata(settings.metadata);
  const firstPhoneNumberFree =
    catalogLocked && pr ? pr.firstPhoneNumberFree !== false : settings.firstPhoneNumberFree !== false;
  const smsBillingEnabled = Boolean(usage.smsEnabled ?? settings.smsBillingEnabled);
  const localPhoneNumberCount = Number(
    usage.localPhoneNumberCount ?? usage.phoneNumberCount ?? 0,
  );
  const tollFreePhoneNumberCount = Number(usage.tollFreePhoneNumberCount ?? 0);
  const localBillable = Number(
    usage.localBillablePhoneNumberCount ??
      Math.max(0, localPhoneNumberCount - (firstPhoneNumberFree ? 1 : 0)),
  );
  const tollFreeBillable = Number(usage.tollFreeBillablePhoneNumberCount ?? tollFreePhoneNumberCount);
  const suggested = {
    extensions: Number(usage.extensionCount || 0),
    virtualExtensions: 0,
    phoneNumbersBillable: localBillable,
    phoneNumbersTotal: localPhoneNumberCount,
    phoneNumbersIncluded: firstPhoneNumberFree ? 1 : 0,
    tollFreeNumbersBillable: tollFreeBillable,
    tollFreeNumbersTotal: tollFreePhoneNumberCount,
    smsPackages: smsBillingEnabled ? 1 : 0,
  };
  const localDidPrice =
    Number(catalogLocked && pr ? pr.additionalPhoneNumberPriceCents : settings.additionalPhoneNumberPriceCents) || 0;
  return {
    extensionPriceCents: Number(catalogLocked && pr ? pr.extensionPriceCents : settings.extensionPriceCents) || 0,
    additionalPhoneNumberPriceCents: localDidPrice,
    tollFreeDidPriceCents: resolveTollFreeDidPriceCentsForPortal(settings.metadata, localDidPrice),
    smsPriceCents: Number(catalogLocked && pr ? pr.smsPriceCents : settings.smsPriceCents) || 0,
    firstPhoneNumberFree,
    smsBillingEnabled,
    flatRateEnabled: flat?.enabled === true,
    flatRateAmountCents: flat?.amountCents ?? 0,
    quantityOverrides: defaultQuantityOverrideDraft(settings.metadata, suggested),
  };
}

function BillingQuantityOverrideControl({
  suggestedLabel,
  billingQuantity,
  mode,
  onModeChange,
  onQuantityChange,
  testId,
}: {
  suggestedLabel: string;
  billingQuantity: number;
  mode: "auto" | "manual";
  onModeChange: (mode: "auto" | "manual") => void;
  onQuantityChange: (qty: number) => void;
  testId?: string;
}) {
  return (
    <div className="billing-qty-override" data-testid={testId}>
      <p className="billing-qty-override__suggested">
        <span className="billing-qty-override__suggested-label">Suggested</span>
        {suggestedLabel}
      </p>
      <div className="billing-qty-override__modes" role="radiogroup" aria-label="Quantity mode">
        <button
          type="button"
          className={`billing-qty-override__mode${mode === "auto" ? " active" : ""}`}
          onClick={() => onModeChange("auto")}
        >
          Auto
        </button>
        <button
          type="button"
          className={`billing-qty-override__mode${mode === "manual" ? " active" : ""}`}
          onClick={() => onModeChange("manual")}
        >
          Manual
        </button>
        <span className={`billing-pricing-rate__chip${mode === "manual" ? " custom" : ""}`}>
          {mode === "manual" ? "Manual override" : "Auto"}
        </span>
      </div>
      <label className="billing-qty-override__billing">
        <span className="billing-item-card__field-label">Billing quantity</span>
        <input
          type="number"
          min={0}
          max={100000}
          className="billing-qty-override__input"
          disabled={mode === "auto"}
          value={billingQuantity}
          onChange={(e) => onQuantityChange(Math.max(0, Math.min(100000, Math.round(Number(e.target.value) || 0))))}
        />
      </label>
      <p className="billing-qty-override__hint">
        Auto uses active resources. Manual uses your entered billing quantity.
      </p>
    </div>
  );
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
  activeSection: "plans-pricing" | "tax-billing" | "invoice-billing" | "gateway";
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
  const localPhoneNumberCount = Number(usage.localPhoneNumberCount ?? usage.phoneNumberCount ?? 0);
  const tollFreePhoneNumberCount = Number(usage.tollFreePhoneNumberCount ?? 0);
  const localBillableSuggested = Number(
    usage.localBillablePhoneNumberCount ??
      Math.max(0, localPhoneNumberCount - (draft.firstPhoneNumberFree ? 0 : 1)),
  );
  const tollFreeBillableSuggested = Number(
    usage.tollFreeBillablePhoneNumberCount ?? tollFreePhoneNumberCount,
  );

  const resolvedQuantities = useMemo(
    () =>
      resolveBillingQuantitiesForPortal({
        extensionCount,
        localPhoneNumberCount,
        localBillablePhoneNumberCount: localBillableSuggested,
        tollFreePhoneNumberCount,
        tollFreeBillablePhoneNumberCount: tollFreeBillableSuggested,
        smsEnabled: draft.smsBillingEnabled,
        firstPhoneNumberFree: draft.firstPhoneNumberFree,
        overrides: buildBillingQuantityOverridesPayload(draft.quantityOverrides),
      }),
    [
      extensionCount,
      localPhoneNumberCount,
      tollFreePhoneNumberCount,
      localBillableSuggested,
      tollFreeBillableSuggested,
      draft.smsBillingEnabled,
      draft.firstPhoneNumberFree,
      draft.quantityOverrides,
    ],
  );

  const billingExtensionCount = resolvedQuantities.billing.extensions;
  const billingLocalPhoneCount = resolvedQuantities.billing.phoneNumbers;
  const billingTollFreeCount = resolvedQuantities.billing.tollFreeNumbers;
  const billingSmsCount = resolvedQuantities.billing.smsPackages;
  const billingVirtualCount = resolvedQuantities.billing.virtualExtensions;

  const extensionsFlatActive =
    draft.flatRateEnabled && draft.flatRateAmountCents > 0 && billingExtensionCount > 0;

  const quantityOverridesDirty = useMemo(() => {
    const keys: BillingQuantityOverrideKey[] = ["extensions", "virtualExtensions", "phoneNumbers", "tollFreeNumbers", "smsPackages"];
    return keys.some((k) => {
      const a = draft.quantityOverrides[k];
      const b = savedDraft.quantityOverrides[k];
      return a.mode !== b.mode || a.quantity !== b.quantity;
    });
  }, [draft.quantityOverrides, savedDraft.quantityOverrides]);

  const isDirty = useMemo(() => {
    const flatDirty =
      draft.flatRateEnabled !== savedDraft.flatRateEnabled ||
      draft.flatRateAmountCents !== savedDraft.flatRateAmountCents ||
      draft.tollFreeDidPriceCents !== savedDraft.tollFreeDidPriceCents;
    if (catalogLocked) {
      return draft.smsBillingEnabled !== savedDraft.smsBillingEnabled || flatDirty || quantityOverridesDirty;
    }
    return (
      draft.extensionPriceCents !== savedDraft.extensionPriceCents ||
      draft.additionalPhoneNumberPriceCents !== savedDraft.additionalPhoneNumberPriceCents ||
      draft.tollFreeDidPriceCents !== savedDraft.tollFreeDidPriceCents ||
      draft.smsPriceCents !== savedDraft.smsPriceCents ||
      draft.firstPhoneNumberFree !== savedDraft.firstPhoneNumberFree ||
      draft.smsBillingEnabled !== savedDraft.smsBillingEnabled ||
      flatDirty ||
      quantityOverridesDirty
    );
  }, [draft, savedDraft, catalogLocked, quantityOverridesDirty]);

  const estimate = useMemo(() => {
    return computeTenantMonthlyEstimate({
      extensionCount,
      additionalPhoneNumberCount: localBillableSuggested,
      smsEnabled: draft.smsBillingEnabled,
      extensionPriceCents: draft.extensionPriceCents,
      additionalPhoneNumberPriceCents: draft.additionalPhoneNumberPriceCents,
      tollFreeDidPriceCents: draft.tollFreeDidPriceCents,
      smsPriceCents: draft.smsPriceCents,
      billingExtensionCount,
      billingVirtualExtensionCount: billingVirtualCount,
      billingLocalPhoneNumberCount: billingLocalPhoneCount,
      billingTollFreePhoneNumberCount: billingTollFreeCount,
      billingSmsPackageCount: billingSmsCount,
      extensionsFlatRateCents: extensionsFlatActive ? draft.flatRateAmountCents : null,
      creditsCents: Number(settings.creditsCents || 0),
      discountPercent: Number(settings.discountPercent || 0),
      previewServiceSubtotalCents: previewServiceSubtotalCents(preview),
      previewTaxCents: Number(preview.taxCents || 0),
    });
  }, [
    draft,
    extensionCount,
    localBillableSuggested,
    settings,
    preview,
    extensionsFlatActive,
    billingExtensionCount,
    billingVirtualCount,
    billingLocalPhoneCount,
    billingTollFreeCount,
    billingSmsCount,
  ]);

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
          ? billingExtensionCount
          : r.key === "additionalPhoneNumberPriceCents"
            ? billingLocalPhoneCount
            : r.key === "smsPriceCents"
              ? billingSmsCount
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
  }, [diag, billingExtensionCount, billingLocalPhoneCount, billingSmsCount, draft]);

  const manualQtyTableRows = useMemo(() => {
    const rows: Array<{ key: string; label: string; defaultVal: string; custom: string; quantity: string; monthlySubtotal: string }> = [];
    const add = (key: BillingQuantityOverrideKey, label: string, suggested: number, billing: number, unitCents: number) => {
      if (resolvedQuantities.modes[key] !== "manual") return;
      rows.push({
        key: `qty-${key}`,
        label,
        defaultVal: `Suggested ${suggested}`,
        custom: "Manual billing qty",
        quantity: String(billing),
        monthlySubtotal: dollars(billing * unitCents),
      });
    };
    add("extensions", "Extensions", extensionCount, billingExtensionCount, extensionsFlatActive ? draft.flatRateAmountCents : draft.extensionPriceCents);
    add("virtualExtensions", "Virtual extensions", 0, billingVirtualCount, draft.extensionPriceCents);
    add("phoneNumbers", "Local phone numbers", resolvedQuantities.suggested.phoneNumbersBillable, billingLocalPhoneCount, draft.additionalPhoneNumberPriceCents);
    add("tollFreeNumbers", "Toll-free phone numbers", resolvedQuantities.suggested.tollFreeNumbersBillable, billingTollFreeCount, draft.tollFreeDidPriceCents);
    add("smsPackages", "SMS packages", resolvedQuantities.suggested.smsPackages, billingSmsCount, draft.smsPriceCents);
    return rows;
  }, [resolvedQuantities, extensionCount, billingExtensionCount, billingVirtualCount, billingLocalPhoneCount, billingTollFreeCount, billingSmsCount, draft, extensionsFlatActive]);

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

  const tableRows = [
    ...(flatRateTableRow ? [flatRateTableRow] : []),
    ...manualQtyTableRows,
    ...overrideRows,
  ];

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
        billingQuantityOverrides: buildBillingQuantityOverridesPayload(draft.quantityOverrides),
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
        payload.tollFreeDidPriceCents = draft.tollFreeDidPriceCents;
        payload.smsPriceCents = draft.smsPriceCents;
        payload.firstPhoneNumberFree = draft.firstPhoneNumberFree;
      } else {
        payload.tollFreeDidPriceCents = draft.tollFreeDidPriceCents;
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
      quantity: extensionsFlatActive ? 1 : billingExtensionCount,
      billingQty: billingExtensionCount,
      qtyOverrideKey: "extensions" as const,
      suggestedLabel: `${extensionCount} active extension${extensionCount === 1 ? "" : "s"}${
        extensionsFlatActive ? " · flat monthly rate applies" : ""
      }`,
      unitCents: extensionsFlatActive ? draft.flatRateAmountCents : draft.extensionPriceCents,
      priceKey: extensionsFlatActive ? null : ("extensionPriceCents" as const),
      chip: extensionsFlatActive ? ("flat" as const) : badgeFromFieldBadges("extensionPriceCents", fieldBadges),
    },
    {
      key: "virtual",
      icon: "⊞",
      title: "Virtual extensions",
      quantity: billingVirtualCount,
      billingQty: billingVirtualCount,
      qtyOverrideKey: "virtualExtensions" as const,
      suggestedLabel: "0 tracked in system · not auto-counted",
      unitCents: draft.extensionPriceCents,
      priceKey: null,
      chip: resolvedQuantities.modes.virtualExtensions === "manual" ? ("custom" as const) : ("default" as const),
    },
    {
      key: "local_phone_numbers",
      icon: "#",
      title: "Local phone numbers",
      quantity: billingLocalPhoneCount,
      billingQty: billingLocalPhoneCount,
      qtyOverrideKey: "phoneNumbers" as const,
      suggestedLabel: draft.firstPhoneNumberFree
        ? `${localPhoneNumberCount} active · ${resolvedQuantities.suggested.phoneNumbersIncluded} included · ${resolvedQuantities.suggested.phoneNumbersBillable} billable`
        : `${localPhoneNumberCount} active · all billable`,
      unitCents: draft.additionalPhoneNumberPriceCents,
      priceKey: "additionalPhoneNumberPriceCents" as const,
      chip:
        badgeFromFieldBadges("additionalPhoneNumberPriceCents", fieldBadges) === "custom" ||
        badgeFromFieldBadges("firstPhoneNumberFree", fieldBadges) === "custom" ||
        resolvedQuantities.modes.phoneNumbers === "manual"
          ? ("custom" as const)
          : ("default" as const),
    },
    {
      key: "toll_free_phone_numbers",
      icon: "☎",
      title: "Toll-free phone numbers",
      quantity: billingTollFreeCount,
      billingQty: billingTollFreeCount,
      qtyOverrideKey: "tollFreeNumbers" as const,
      suggestedLabel: `${tollFreePhoneNumberCount} active toll-free · all billable`,
      unitCents: draft.tollFreeDidPriceCents,
      priceKey: "tollFreeDidPriceCents" as const,
      chip:
        parseTollFreeDidPriceCentsFromMetadata(settings.metadata) != null ||
        resolvedQuantities.modes.tollFreeNumbers === "manual"
          ? ("custom" as const)
          : ("default" as const),
    },
    {
      key: "sms",
      icon: "✉",
      title: "SMS packages",
      quantity: billingSmsCount,
      billingQty: billingSmsCount,
      qtyOverrideKey: "smsPackages" as const,
      suggestedLabel: draft.smsBillingEnabled
        ? "1 package (SMS billing enabled)"
        : "0 packages (SMS billing off)",
      unitCents: draft.smsPriceCents,
      priceKey: "smsPriceCents" as const,
      chip:
        badgeFromFieldBadges("smsPriceCents", fieldBadges) === "custom" ||
        resolvedQuantities.modes.smsPackages === "manual"
          ? ("custom" as const)
          : ("default" as const),
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
          Taxes &amp; fees
        </Link>
        <Link href={settingsSectionHref("invoice-billing")} className={activeSection === "invoice-billing" ? "active" : ""}>
          Invoice &amp; billing
        </Link>
        <Link href={settingsSectionHref("gateway")} className={activeSection === "gateway" ? "active" : ""}>
          Payment gateway
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
          const subtotal = item.quantity * item.unitCents;
          const isActive = activeItemKey === item.key;
          const overrideKey = item.qtyOverrideKey;
          const overrideRow = draft.quantityOverrides[overrideKey];
          return (
            <article
              key={item.key}
              className={`billing-item-card${isActive ? " billing-item-card--active" : ""}`}
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
                </div>
              </div>

              <BillingQuantityOverrideControl
                testId={`billing-qty-override-${item.key}`}
                suggestedLabel={item.suggestedLabel}
                mode={overrideRow.mode}
                billingQuantity={overrideRow.mode === "auto" ? item.billingQty : overrideRow.quantity}
                onModeChange={(mode) => {
                  setDraft((d) => {
                    const suggested =
                      overrideKey === "extensions"
                        ? extensionCount
                        : overrideKey === "virtualExtensions"
                          ? 0
                          : overrideKey === "phoneNumbers"
                            ? resolvedQuantities.suggested.phoneNumbersBillable
                            : overrideKey === "tollFreeNumbers"
                              ? resolvedQuantities.suggested.tollFreeNumbersBillable
                              : d.smsBillingEnabled
                                ? 1
                                : 0;
                    return {
                      ...d,
                      quantityOverrides: {
                        ...d.quantityOverrides,
                        [overrideKey]: {
                          mode,
                          quantity: mode === "auto" ? suggested : d.quantityOverrides[overrideKey].quantity,
                        },
                      },
                    };
                  });
                }}
                onQuantityChange={(quantity) =>
                  setDraft((d) => ({
                    ...d,
                    quantityOverrides: {
                      ...d.quantityOverrides,
                      [overrideKey]: { mode: "manual", quantity },
                    },
                  }))
                }
              />

              {item.smsToggle ? (
                <label className="billing-item-card__sms-toggle">
                  <input
                    type="checkbox"
                    checked={draft.smsBillingEnabled}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setDraft((d) => ({
                        ...d,
                        smsBillingEnabled: enabled,
                        quantityOverrides: {
                          ...d.quantityOverrides,
                          smsPackages: {
                            mode: d.quantityOverrides.smsPackages.mode,
                            quantity:
                              d.quantityOverrides.smsPackages.mode === "auto"
                                ? enabled
                                  ? 1
                                  : 0
                                : d.quantityOverrides.smsPackages.quantity,
                          },
                        },
                      }));
                    }}
                  />
                  <span>SMS billing enabled (affects suggested quantity when Auto)</span>
                </label>
              ) : null}

              <label className="billing-item-card__price-row">
                <span className="billing-item-card__field-label">Unit price</span>
                <div className="billing-item-card__price-input-wrap">
                  <span className="billing-item-card__currency">$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="billing-item-card__price-input"
                    readOnly={!item.priceKey || (catalogLocked && item.priceKey !== "tollFreeDidPriceCents")}
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
                <strong className="billing-item-card__subtotal-value">{dollars(subtotal)}</strong>
              </div>

              <span
                className={`billing-pricing-rate__chip${
                  item.chip === "custom" || item.chip === "flat" ? " custom" : ""
                }`}
              >
                {item.chip === "flat"
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
          Suggested quantities come from active resources; billing quantities follow Auto or Manual overrides saved on this company.{" "}
          <Link href={taxBillingHref}>Taxes &amp; fees</Link> control tax profiles, E911, and regulatory fees.
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
