"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { apiPut } from "../../../../../services/apiClient";
import { BillingActionToast, billingErrorMessage } from "../../../../../components/BillingActionToast";
import {
  buildTelecomFeesPayload,
  computeTelecomFeesEstimate,
  formatJurisdiction,
  mergeTelecomFeesDraft,
  parseBillingTelecomFeesFromMetadata,
  TELECOM_FEE_KEYS,
  type BillingTelecomFeesConfig,
  type TelecomFeeBasis,
  type TelecomFeeItemConfig,
  type TelecomFeeKey,
} from "../../../../../lib/billingTelecomFees";
import {
  activeExtensionsFlatRateFromMetadata,
  parseBillingQuantityOverridesFromMetadata,
  previewServiceSubtotalCents,
  resolveBillingQuantitiesForPortal,
  resolveTollFreeDidPriceCentsForPortal,
} from "../../../../../lib/billingUi";
import {
  applyJurisdictionTemplate,
  detectJurisdictionFromTenant,
  getJurisdictionTemplate,
  JURISDICTION_TEMPLATES,
  type JurisdictionKey,
} from "../../../../../lib/billingTaxSuggestions";
import type { TenantDetail } from "./tenantBillingConfigForms";
import "./billingTaxFees.css";

function dollars(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

type Props = {
  detail: TenantDetail;
  onSaved: () => void;
  settingsSectionHref: (section: "plans-pricing" | "tax-billing" | "invoice-billing" | "gateway") => string;
  activeSection: string;
};

export function AdminTaxesFeesWorkspace({ detail, onSaved, settingsSectionHref, activeSection }: Props) {
  const settings = detail.settings || {};
  const usage = detail.usage || {};
  const meta = settings.metadata && typeof settings.metadata === "object" && !Array.isArray(settings.metadata) ? settings.metadata : {};
  const taxProviderId = String((meta as Record<string, unknown>).taxProviderId || "tax_profile_v1");

  const assignedProfile = useMemo(() => {
    const id = settings.taxProfileId;
    if (!id) return null;
    return (detail.taxProfiles || []).find((p: { id: string }) => p.id === id) || settings.taxProfile || null;
  }, [detail.taxProfiles, settings.taxProfile, settings.taxProfileId]);

  const initialFees = useMemo(
    () =>
      mergeTelecomFeesDraft(
        parseBillingTelecomFeesFromMetadata(settings.metadata),
        assignedProfile,
      ),
    [assignedProfile, settings.metadata],
  );

  const [fees, setFees] = useState<BillingTelecomFeesConfig>(initialFees);
  const [taxEnabled, setTaxEnabled] = useState(!!settings.taxEnabled);
  const [taxProfileId, setTaxProfileId] = useState<string>(settings.taxProfileId || "");
  const [providerId, setProviderId] = useState(taxProviderId);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Jurisdiction suggestion state
  const detectedJurisdiction = useMemo(
    () => detectJurisdictionFromTenant(settings, assignedProfile),
    [settings, assignedProfile],
  );
  const defaultTemplateKey: JurisdictionKey = detectedJurisdiction ?? JURISDICTION_TEMPLATES[0]!.key;
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<JurisdictionKey>(defaultTemplateKey);
  const [lastAppliedTemplate, setLastAppliedTemplate] = useState<JurisdictionKey | null>(null);

  const applyTemplate = useCallback(() => {
    const template = getJurisdictionTemplate(selectedTemplateKey);
    if (!template) return;
    setFees((prev) => applyJurisdictionTemplate(template, prev));
    setTaxEnabled(true);
    setLastAppliedTemplate(selectedTemplateKey);
  }, [selectedTemplateKey]);

  const jurisdiction = formatJurisdiction(assignedProfile, settings.serviceAddress);

  const quantities = useMemo(() => {
    const overrides = parseBillingQuantityOverridesFromMetadata(settings.metadata);
    const firstFree = settings.firstPhoneNumberFree !== false;
    return resolveBillingQuantitiesForPortal({
      extensionCount: Number(usage.extensionCount ?? 0),
      localPhoneNumberCount: Number(usage.localPhoneNumberCount ?? usage.phoneNumberCount ?? 0),
      localBillablePhoneNumberCount: Number(
        usage.localBillablePhoneNumberCount ?? usage.additionalPhoneNumberCount ?? 0,
      ),
      tollFreePhoneNumberCount: Number(usage.tollFreePhoneNumberCount ?? 0),
      tollFreeBillablePhoneNumberCount: Number(
        usage.tollFreeBillablePhoneNumberCount ?? usage.tollFreePhoneNumberCount ?? 0,
      ),
      smsEnabled: !!usage.smsEnabled,
      firstPhoneNumberFree: firstFree,
      overrides,
    });
  }, [settings, usage]);

  const taxableSubtotalCents = useMemo(() => {
    // Prefer API-computed taxable subtotal (most accurate — accounts for flat rate, overrides, etc.)
    const fromApiPreview = Number((detail.preview as any)?.taxableSubtotalCents || 0);
    if (fromApiPreview > 0) return fromApiPreview;
    // Secondary: sum service line items from preview (older API without taxableSubtotalCents)
    const fromPreview = previewServiceSubtotalCents(detail.preview);
    if (fromPreview > 0) return fromPreview;
    // Fallback: compute from billing quantities + configured prices
    // Include flat rate when enabled (estimate even without live extensions for migrating tenants)
    const flatRate = activeExtensionsFlatRateFromMetadata(settings.metadata);
    const extCents =
      flatRate?.enabled && flatRate.amountCents > 0
        ? flatRate.amountCents
        : quantities.billing.extensions * Number(settings.extensionPriceCents || 0);
    const local = quantities.billing.phoneNumbers;
    const tf = quantities.billing.tollFreeNumbers;
    const tfPrice = resolveTollFreeDidPriceCentsForPortal(
      settings.metadata,
      Number(settings.additionalPhoneNumberPriceCents || 0),
    );
    return extCents + local * Number(settings.additionalPhoneNumberPriceCents || 0) + tf * tfPrice;
  }, [detail.preview, quantities, settings]);

  const estimate = useMemo(
    () =>
      computeTelecomFeesEstimate({
        fees,
        taxableSubtotalCents,
        extensionCount: quantities.billing.extensions,
        localDidCount: quantities.billing.phoneNumbers,
        tollFreeDidCount: quantities.billing.tollFreeNumbers,
        taxEnabled,
      }),
    [fees, taxableSubtotalCents, quantities, taxEnabled],
  );

  const dirty = useMemo(() => {
    return (
      taxEnabled !== !!settings.taxEnabled ||
      taxProfileId !== (settings.taxProfileId || "") ||
      providerId !== taxProviderId ||
      JSON.stringify(buildTelecomFeesPayload(fees)) !== JSON.stringify(buildTelecomFeesPayload(initialFees))
    );
  }, [fees, initialFees, providerId, settings, taxEnabled, taxProfileId, taxProviderId]);

  const patchFee = useCallback((key: TelecomFeeKey, patch: Partial<TelecomFeeItemConfig>) => {
    setFees((prev) => ({
      ...prev,
      [key]: { ...prev[key]!, ...patch },
    }));
  }, []);

  async function save() {
    setSaving(true);
    setToast(null);
    try {
      await apiPut(`/admin/billing/tenants/${detail.tenant.id}/settings`, {
        taxEnabled,
        taxProfileId: taxProfileId || null,
        taxProviderId: providerId,
        billingTelecomFees: buildTelecomFeesPayload(fees),
      });
      onSaved();
      setToast({ kind: "ok", text: "Taxes and fees saved." });
    } catch (err: unknown) {
      setToast({ kind: "err", text: billingErrorMessage(err, "Could not save taxes and fees.") });
    } finally {
      setSaving(false);
    }
  }

  function renderFeeCard(key: TelecomFeeKey) {
    const fee = fees[key];
    if (!fee) return null;
    const isPercent = fee.mode === "ratePercent";
    return (
      <article
        key={key}
        className={`billing-tax-fee-card${fee.enabled ? "" : " billing-tax-fee-card--disabled"}`}
        data-testid={`billing-tax-fee-${key}`}
      >
        <div className="billing-tax-fee-card__head">
          <div>
            <h4 className="billing-tax-fee-card__title">
              {fee.label}
              {fee.suggested ? <span className="billing-tax-fee-tag billing-tax-fee-tag--suggested"> Suggested</span> : null}
            </h4>
            {fee.description ? <p className="billing-tax-fee-card__desc">{fee.description}</p> : null}
          </div>
        </div>
        <div className="billing-tax-fee-card__toggles">
          <label>
            <input
              type="checkbox"
              checked={fee.enabled}
              onChange={(e) => patchFee(key, { enabled: e.target.checked })}
            />{" "}
            Enabled
          </label>
          <label>
            <input
              type="checkbox"
              checked={fee.customerVisible}
              onChange={(e) => patchFee(key, { customerVisible: e.target.checked })}
            />{" "}
            Customer-visible
          </label>
        </div>
        <div className="billing-tax-fee-card__fields">
          <label>
            Billing mode
            <select
              value={fee.mode}
              onChange={(e) => patchFee(key, { mode: e.target.value as "ratePercent" | "amountCents" })}
            >
              <option value="ratePercent">Rate %</option>
              <option value="amountCents">Amount $</option>
            </select>
          </label>
          <label>
            Basis
            <select
              value={fee.basis}
              onChange={(e) => patchFee(key, { basis: e.target.value as TelecomFeeBasis })}
            >
              <option value="invoice_subtotal">Invoice subtotal</option>
              <option value="per_extension">Per extension</option>
              <option value="per_did">Per local DID</option>
              <option value="per_toll_free_did">Per toll-free DID</option>
              <option value="per_line">Per line (ext + DIDs)</option>
              <option value="flat_monthly">Flat monthly</option>
            </select>
          </label>
          {isPercent ? (
            <label style={{ gridColumn: "1 / -1" }}>
              Rate (%)
              <input
                type="number"
                step="0.001"
                min={0}
                max={100}
                value={((fee.ratePercent ?? 0) * 100).toFixed(3)}
                onChange={(e) => patchFee(key, { ratePercent: Number(e.target.value) / 100 })}
              />
            </label>
          ) : (
            <label style={{ gridColumn: "1 / -1" }}>
              Amount ($)
              <input
                type="number"
                step="0.01"
                min={0}
                value={((fee.amountCents ?? 0) / 100).toFixed(2)}
                onChange={(e) => patchFee(key, { amountCents: Math.round(Number(e.target.value) * 100) })}
              />
            </label>
          )}
        </div>
      </article>
    );
  }

  const suggestedKeys: TelecomFeeKey[] = ["salesTax", "e911", "regulatory"];
  const telecomKeys: TelecomFeeKey[] = ["telecomSurcharge", "usfRecovery", "customFee"];

  return (
    <div className="billing-tax-fees-page billing-p8-scope billing-pricing-page" data-testid="billing-taxes-fees-workspace">
      <header className="billing-tax-fees-page__head billing-pricing-page__head">
        <div>
          <h2>Taxes &amp; fees</h2>
          <p>Configure taxes, E911, and telecom-related billing fees for <strong>{detail.tenant.name}</strong>.</p>
          <div className="billing-tax-fees-chips">
            <span className="billing-tax-fees-chip billing-tax-fees-chip--accent">{jurisdiction}</span>
            <span className="billing-tax-fees-chip">
              {taxEnabled ? "Taxes on" : "Taxes off"}
            </span>
            {assignedProfile ? (
              <span className="billing-tax-fees-chip">Profile: {assignedProfile.name}</span>
            ) : (
              <span className="billing-tax-fees-chip">No tax profile assigned</span>
            )}
          </div>
        </div>
      </header>

      <nav className="billing-pricing-tabs" aria-label="Billing settings sections">
        <Link href={settingsSectionHref("plans-pricing")}>Plans &amp; pricing</Link>
        <Link href={settingsSectionHref("tax-billing")} className={activeSection === "tax-billing" ? "active" : ""}>
          Taxes &amp; fees
        </Link>
        <Link href={settingsSectionHref("invoice-billing")}>Invoice &amp; billing</Link>
        <Link href={settingsSectionHref("gateway")}>Payment gateway</Link>
      </nav>

      {/* Jurisdiction quick-start suggestion panel */}
      <div className="billing-tax-suggestion-panel" data-testid="billing-tax-suggestion-panel">
        <div className="billing-tax-suggestion-panel__head">
          <div>
            <strong className="billing-tax-suggestion-panel__title">
              {detectedJurisdiction
                ? `Detected jurisdiction: ${getJurisdictionTemplate(detectedJurisdiction)?.label ?? detectedJurisdiction}`
                : "Apply suggested tax rates"}
            </strong>
            {lastAppliedTemplate ? (
              <span className="billing-tax-fees-chip billing-tax-fees-chip--accent" style={{ marginLeft: 10, fontSize: 10 }}>
                Last applied: {getJurisdictionTemplate(lastAppliedTemplate)?.label}
              </span>
            ) : null}
          </div>
          <p className="billing-tax-suggestion-panel__hint">
            Suggested starting rates only. Confirm with your tax advisor before billing customers.
          </p>
        </div>
        <div className="billing-tax-suggestion-panel__body">
          <label className="billing-tax-suggestion-panel__label">
            Jurisdiction template
            <select
              value={selectedTemplateKey}
              onChange={(e) => setSelectedTemplateKey(e.target.value as JurisdictionKey)}
              className="billing-tax-suggestion-panel__select"
            >
              {JURISDICTION_TEMPLATES.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn primary billing-tax-suggestion-panel__btn"
            onClick={applyTemplate}
            data-testid="billing-tax-apply-suggestion"
          >
            Apply suggested {getJurisdictionTemplate(selectedTemplateKey)?.label ?? "rates"}
          </button>
        </div>
        <p className="billing-tax-suggestion-panel__summary">
          Sales tax: 8.125% · E911: $3.00 flat monthly · Regulatory: 1.000% · Federal USF: off · Surcharge: off
        </p>
      </div>

      <p className="billing-tax-fees-estimate__hint" style={{ marginBottom: 14 }}>
        Saving updates tenant metadata and syncs sales tax, E911, and regulatory fields on the assigned shared TaxProfile when one is selected.
      </p>

      <section className="billing-tax-fees-section">
        <h3>Tax setup</h3>
        <div className="billing-tax-fee-card">
          <div className="billing-tax-fee-card__toggles">
            <label>
              <input type="checkbox" checked={taxEnabled} onChange={(e) => setTaxEnabled(e.target.checked)} /> Apply taxes
              and fees on invoices
            </label>
          </div>
          <div className="billing-tax-fee-card__fields" style={{ marginTop: 10 }}>
            <label style={{ gridColumn: "1 / -1" }}>
              Tax profile (jurisdiction template)
              <select value={taxProfileId} onChange={(e) => setTaxProfileId(e.target.value)}>
                <option value="">No tax profile</option>
                {detail.taxProfiles.map((profile: { id: string; name: string }) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </section>

      <section className="billing-tax-fees-section">
        <h3>Suggested taxes</h3>
        <div className="billing-tax-fee-grid">{suggestedKeys.map(renderFeeCard)}</div>
      </section>

      <section className="billing-tax-fees-section">
        <h3>Telecom &amp; E911 fees</h3>
        <div className="billing-tax-fee-grid">{telecomKeys.map(renderFeeCard)}</div>
      </section>

      <section className="billing-tax-fees-section">
        <h3>Customer-visible invoice fees</h3>
        <div className="billing-tax-fees-visibility">
          <strong>Preview — what customers would see</strong>
          <p style={{ margin: "6px 0 0", color: "var(--billing-muted, var(--text-dim))" }}>
            Only enabled fees marked customer-visible appear below. Final PDFs follow invoice engine rules; surcharge/USF
            lines are estimate-only until Phase B.
          </p>
          <ul>
            {estimate.lines
              .filter((l) => l.enabled && l.customerVisible && l.amountCents > 0)
              .map((l) => (
                <li key={l.key}>
                  {l.label}: {dollars(l.amountCents)}
                  {l.quantity != null && l.unitCents != null && l.quantity > 1
                    ? ` (${l.quantity} × ${dollars(l.unitCents)})`
                    : null}
                </li>
              ))}
            {!estimate.lines.some((l) => l.enabled && l.customerVisible && l.amountCents > 0) ? (
              <li>No customer-visible fees with a positive amount.</li>
            ) : null}
          </ul>
        </div>
      </section>

      <section className="billing-tax-fees-section billing-tax-fees-estimate" data-testid="billing-tax-fees-estimate">
        <h3 className="billing-tax-fees-estimate__title">Estimated taxes &amp; fees</h3>
        <p className="billing-tax-fees-estimate__hint">Preview only — final invoice totals may vary.</p>
        <div className="billing-tax-fees-estimate__rows">
          <div className="billing-tax-fees-estimate__row">
            <span>Taxable service subtotal</span>
            <span>{dollars(taxableSubtotalCents)}</span>
          </div>
          {estimate.lines
            .filter((l) => l.enabled && l.amountCents > 0)
            .map((l) => (
              <div key={l.key} className="billing-tax-fees-estimate__row">
                <span>
                  {l.label}
                  {l.suggested ? " (suggested)" : ""}
                </span>
                <span>{dollars(l.amountCents)}</span>
              </div>
            ))}
        </div>
        <div className="billing-tax-fees-estimate__total">
          <span>Total estimated taxes &amp; fees</span>
          <span>{dollars(estimate.totalCents)}</span>
        </div>
        <p className="billing-tax-fees-estimate__hint" style={{ marginTop: 10, marginBottom: 0 }}>
          Customer-visible subtotal: {dollars(estimate.customerVisibleTotalCents)}
        </p>
      </section>

      <details className="billing-tax-fees-advanced">
        <summary>Advanced tax settings</summary>
        <div className="billing-tax-fees-advanced__body">
          <label style={{ fontSize: 13 }}>
            Tax calculation provider
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)} style={{ display: "block", marginTop: 6, width: "100%" }}>
              <option value="tax_profile_v1">Tax profile (Connect manual rates)</option>
              <option value="external_telecom_stub">External stub (no tax lines)</option>
            </select>
          </label>
          {assignedProfile ? (
            <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.45 }}>
              Assigned profile is shared by state/county ({assignedProfile.state}
              {assignedProfile.county ? ` / ${assignedProfile.county}` : ""}). Saving fee cards updates that profile for
              all tenants linked to it.
            </p>
          ) : null}
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            API preview tax: {dollars(Number(detail.preview?.taxCents || 0))} (from last invoice preview when taxes enabled).
          </p>
        </div>
      </details>

      {dirty ? (
        <div className="billing-tax-fees-sticky">
          <span className="billing-tax-fees-sticky__hint">Unsaved tax &amp; fee changes</span>
          <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save taxes & fees"}
          </button>
        </div>
      ) : null}

      {toast ? <BillingActionToast kind={toast.kind} text={toast.text} /> : null}
    </div>
  );
}

