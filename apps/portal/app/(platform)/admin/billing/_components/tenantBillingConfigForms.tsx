"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, apiPut } from "../../../../../services/apiClient";
import { DetailCard } from "../../../../../components/DetailCard";
import { BillingActionToast, billingErrorMessage } from "../../../../../components/BillingActionToast";
import { BillingActionPanel } from "../../../../../components/billing/BillingActionPanel";
import { humanizePricingStateMode, humanizeStoredPricingMode } from "../../../../../lib/billingUi";

export type TenantDetail = {
  tenant: { id: string; name: string; createdAt: string };
  settings: any;
  usage: any;
  preview: any;
  invoices: any[];
  paymentMethods: any[];
  taxProfiles: any[];
  sola: { configured: boolean; config: any | null; webhookUrl?: string | null; decryptFailed?: boolean };
};

function toDollars(cents: number | undefined | null) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function toCents(value: FormDataEntryValue | null) {
  const n = Number(String(value || "0").replace(/[^0-9. -]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function safeJsonBlock(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  } catch {
    return '"[unserializable]"';
  }
}

export type PricingModeUi = "legacy" | "catalog" | "custom";

export function parseStoredPricingMode(metadata: unknown): PricingModeUi {
  const m =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  if (m.billingPricingMode === "catalog") return "catalog";
  if (m.billingPricingMode === "custom") return "custom";
  return "legacy";
}

function badgeDisplay(key: string): string {
  if (key === "from_plan") return "From plan";
  if (key === "tenant_override") return "Custom row";
  return "Standard";
}

export function AdminTenantPricingSourceCard({
  detail,
  onSaved,
  previewPeriodMonth,
  previewPeriodYear,
}: {
  detail: TenantDetail;
  onSaved: () => void;
  /** Align reset/diagnostics preview with Admin Billing invoice preview period (optional). */
  previewPeriodMonth?: number;
  previewPeriodYear?: number;
}) {
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [resetOverlay, setResetOverlay] = useState(false);
  const [resetDiagLoading, setResetDiagLoading] = useState(false);
  const [resetPayload, setResetPayload] = useState<{
    resetToPlanPreview: {
      before: Record<string, unknown>;
      after: Record<string, unknown> | null;
      canReset: boolean;
    };
  } | null>(null);

  const settings = detail.settings || {};
  const pr = detail.preview?.pricingResolution as any;
  const expl = detail.preview?.pricingPreviewExplanation as any;
  const bp = settings.billingPlan;
  const mode = parseStoredPricingMode(settings.metadata);

  const operatorWarnings: string[] = [];
  if (mode === "catalog" && expl?.tenantOverridesDetected) {
    operatorWarnings.push(
      "Company row still has custom unit amounts while pricing is set to follow the billing plan. Invoices use the plan — reset to plan pricing if you want the row to match.",
    );
  }
  const nextBp = settings.nextBillingPlan;
  if (nextBp && settings.nextBillingPlanId && nextBp.active === false) {
    operatorWarnings.push("Scheduled next BillingPlan is inactive — the billing worker may refuse to apply it.");
  }

  async function saveMode(next: PricingModeUi) {
    setSaving(true);
    setToast(null);
    try {
      await apiPut(`/admin/billing/tenants/${detail.tenant.id}/settings`, {
        billingPricingMode: next === "legacy" ? null : next,
      });
      onSaved();
      setToast({ kind: "ok", text: "Pricing source updated." });
    } catch (err: unknown) {
      setToast({ kind: "err", text: billingErrorMessage(err, "Could not save pricing source.") });
    } finally {
      setSaving(false);
    }
  }

  async function openResetConfirmation() {
    setToast(null);
    setResetDiagLoading(true);
    setResetPayload(null);
    try {
      const periodQs =
        previewPeriodMonth != null && previewPeriodYear != null
          ? `?periodMonth=${encodeURIComponent(String(previewPeriodMonth))}&periodYear=${encodeURIComponent(String(previewPeriodYear))}`
          : "";
      const d = await apiGet<{
        resetToPlanPreview: { canReset: boolean; before: Record<string, unknown>; after: Record<string, unknown> | null };
      }>(`/admin/billing/platform/tenants/${detail.tenant.id}/pricing-diagnostics${periodQs}`);
      setResetPayload({ resetToPlanPreview: d.resetToPlanPreview });
      if (!d.resetToPlanPreview.canReset || !d.resetToPlanPreview.after) {
        setToast({ kind: "err", text: "Nothing to reset — tenant has no billingPlanId." });
        setResetDiagLoading(false);
        return;
      }
      setResetOverlay(true);
    } catch (err: unknown) {
      setToast({ kind: "err", text: billingErrorMessage(err, "Could not load reset preview.") });
    } finally {
      setResetDiagLoading(false);
    }
  }

  async function applyResetConfirmed() {
    setSaving(true);
    setToast(null);
    try {
      await apiPost(`/admin/billing/platform/tenants/${detail.tenant.id}/pricing/reset-to-plan`, {});
      setResetOverlay(false);
      setResetPayload(null);
      onSaved();
      setToast({ kind: "ok", text: "Prices aligned to the current billing plan. Pricing mode set to follow plan." });
    } catch (err: unknown) {
      setToast({ kind: "err", text: billingErrorMessage(err, "Reset failed — tenant may have no billingPlanId.") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <DetailCard title="How prices are calculated">
      <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12, lineHeight: 1.45 }}>
        <strong>Standard</strong> uses the historical blend of company row and plan defaults.{" "}
        <strong>Follow company billing plan</strong> always uses the active plan for the preview month (including scheduled plan changes).{" "}
        <strong>Custom company pricing</strong> locks amounts to the company row — use for negotiated deals.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }} role="radiogroup" aria-label="Pricing source">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: saving ? "default" : "pointer" }}>
          <input type="radio" name="pricingMode" checked={mode === "legacy"} disabled={saving} onChange={() => void saveMode("legacy")} />
          {humanizeStoredPricingMode("legacy")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: saving ? "default" : "pointer" }}>
          <input type="radio" name="pricingMode" checked={mode === "catalog"} disabled={saving} onChange={() => void saveMode("catalog")} />
          {humanizeStoredPricingMode("catalog")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: saving ? "default" : "pointer" }}>
          <input type="radio" name="pricingMode" checked={mode === "custom"} disabled={saving} onChange={() => void saveMode("custom")} />
          {humanizeStoredPricingMode("custom")}
        </label>
      </div>

      {operatorWarnings.map((w) => (
        <div key={w} className="billing-status-pill warn" style={{ marginBottom: 10, fontSize: 13, whiteSpace: "normal", lineHeight: 1.45 }}>
          {w}
        </div>
      ))}

      {mode === "custom" && pr?.banner?.toLowerCase().includes("override") ? (
        <div className="billing-status-pill warn" style={{ marginBottom: 12, fontSize: 13, whiteSpace: "normal", lineHeight: 1.45 }}>
          {pr.banner}
        </div>
      ) : null}

      {pr ? (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Where each amount comes from (preview month)</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <tbody>
              {(
                [
                  ["Extension price", "extensionPriceCents"],
                  ["Additional phone", "additionalPhoneNumberPriceCents"],
                  ["SMS package", "smsPriceCents"],
                  ["First number free", "firstPhoneNumberFree"],
                ] as const
              ).map(([label, key]) => (
                <tr key={key} style={{ borderBottom: "1px solid var(--border-light, #f3f4f6)" }}>
                  <td style={{ padding: "4px 6px" }}>{label}</td>
                  <td style={{ padding: "4px 6px", textAlign: "right" }}>
                    <span className="billing-status-pill" style={{ fontSize: 11 }}>
                      {badgeDisplay(String(pr.fieldBadges?.[key] || "legacy"))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {bp?.name ? (
            <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
              Linked plan: <strong>{bp.name}</strong>
              {pr.activePlanName && pr.activePlanName !== bp.name ? (
                <>
                  {" "}
                  · Effective for this preview: <strong>{pr.activePlanName}</strong>
                </>
              ) : null}
            </p>
          ) : (
            <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>No plan linked yet — following the plan mode will use catalog defaults until you assign one.</p>
          )}
        </div>
      ) : null}

      <div className="row-actions" style={{ flexWrap: "wrap", gap: 8 }}>
        <button
          className="btn ghost"
          type="button"
          data-testid="billing-admin-reset-plan-open"
          disabled={saving || resetDiagLoading || !bp}
          onClick={() => void openResetConfirmation()}
        >
          {resetDiagLoading ? "Loading preview…" : saving ? "Working…" : "Reset to plan pricing"}
        </button>
      </div>
      <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
        Resets to the currently linked plan only — copies the four unit prices from that plan (not a future scheduled plan) and switches pricing to{" "}
        <strong>follow company billing plan</strong>. Requires a linked plan. You confirm a before/after snapshot first.
      </p>
      {toast ? <BillingActionToast kind={toast.kind} text={toast.text} /> : null}

      {resetOverlay && resetPayload?.resetToPlanPreview.after ? (
        <BillingActionPanel
          layout="center"
          centerWidth="min(540px, 96vw)"
          variant="danger"
          onClose={() => { if (!saving) setResetOverlay(false); }}
          eyebrow={detail.tenant.name}
          title="Reset pricing to the linked plan?"
          subtitle={
            <>
              Copies the four catalog unit prices from the <strong>current</strong> linked plan (not a future scheduled plan) and switches pricing to{" "}
              <strong>follow company billing plan</strong>. No invoice is created.
            </>
          }
          warning="Queued invoices already used resolved pricing — this affects future previews and the next bill run."
          children={(
            <div data-testid="billing-admin-reset-plan-dialog">
            {(() => {
              const b = resetPayload.resetToPlanPreview.before;
              const a = resetPayload.resetToPlanPreview.after;
              const money = (c: unknown) => toDollars(Number(c ?? 0));
              const yn = (v: unknown) => (v === false ? "No" : "Yes");
              const rows: [string, string, string][] = [
                ["Pricing mode", String(b.pricingMode ?? ""), String(a!.pricingMode ?? "")],
                ["Extension (unit)", money(b.extensionPriceCents), money(a!.extensionPriceCents)],
                ["Additional phone (unit)", money(b.additionalPhoneNumberPriceCents), money(a!.additionalPhoneNumberPriceCents)],
                ["SMS package (unit)", money(b.smsPriceCents), money(a!.smsPriceCents)],
                ["First phone number free", yn(b.firstPhoneNumberFree), yn(a!.firstPhoneNumberFree)],
              ];
              return (
                <div style={{ marginBottom: 4 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>Unit pricing diff</div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 10 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--border, #e5e7eb)" }}>
                        <th style={{ textAlign: "left", padding: "6px 4px", fontWeight: 600 }}>Field</th>
                        <th style={{ textAlign: "right", padding: "6px 4px", fontWeight: 600 }}>Before</th>
                        <th style={{ textAlign: "right", padding: "6px 4px", fontWeight: 600 }}>After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(([label, bv, av]) => (
                        <tr key={label} style={{ borderBottom: "1px solid var(--border-light, #f3f4f6)" }}>
                          <td style={{ padding: "6px 4px" }}>{label}</td>
                          <td style={{ textAlign: "right", padding: "6px 4px", fontFamily: "ui-monospace, monospace" }}>{bv}</td>
                          <td style={{ textAlign: "right", padding: "6px 4px", fontFamily: "ui-monospace, monospace", fontWeight: 600 }}>{av}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <details style={{ fontSize: 12, color: "var(--muted)" }}>
                    <summary style={{ cursor: "pointer", marginBottom: 6 }}>Raw audit snapshot (JSON)</summary>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <pre style={{ fontSize: 11, overflow: "auto", maxHeight: 160, padding: 8, background: "var(--code-bg,#f8fafc)", borderRadius: 6 }}>
                        {safeJsonBlock(b)}
                      </pre>
                      <pre style={{ fontSize: 11, overflow: "auto", maxHeight: 160, padding: 8, background: "var(--code-bg,#f0fdf4)", borderRadius: 6 }}>
                        {safeJsonBlock(a)}
                      </pre>
                    </div>
                  </details>
                </div>
              );
            })()}
            </div>
          )}
          footer={(
            <>
              <button
                className="btn ghost"
                type="button"
                data-testid="billing-admin-reset-plan-cancel"
                disabled={saving}
                onClick={() => {
                  setResetOverlay(false);
                }}
              >
                Cancel
              </button>
              <button className="btn primary" type="button" disabled={saving} onClick={() => void applyResetConfirmed()}>
                {saving ? "Applying…" : "Apply reset"}
              </button>
            </>
          )}
        />
      ) : null}
    </DetailCard>
  );
}

/** Billing cycle, credits, and autopay — taxes live in AdminTaxesFeesWorkspace. */
export function AdminTenantBillingCycleForm({ detail, onSaved }: { detail: TenantDetail; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const settings = detail.settings || {};
  return (
    <DetailCard title="Billing cycle & credits" dataTestId="billing-admin-billing-cycle-card">
      <p className="muted" style={{ marginBottom: 12, fontSize: 13, lineHeight: 1.45 }}>
        Invoice timing, payment terms, and credits. Configure taxes under <strong>Taxes &amp; fees</strong>.
      </p>
      <form
        className="billing-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          try {
            const form = new FormData(event.currentTarget);
            await apiPut(`/admin/billing/tenants/${detail.tenant.id}/settings`, {
              autoBillingEnabled: form.get("autoBillingEnabled") === "on",
              billingDayOfMonth: Number(form.get("billingDayOfMonth") || 1),
              paymentTermsDays: Number(form.get("paymentTermsDays") || 15),
              billingEmail: String(form.get("billingEmail") || "") || null,
              creditsCents: toCents(form.get("credits")),
            });
            onSaved();
          } finally {
            setSaving(false);
          }
        }}
      >
        <label>
          Billing email
          <input name="billingEmail" type="text" defaultValue={settings.billingEmail || ""} placeholder="billing@tenant.com or a@b.com, c@d.com" />
          <span style={{ fontSize: 12, color: "#6b7280", display: "block", marginTop: 2 }}>
            Separate multiple addresses with commas — all will receive invoices.
          </span>
        </label>
        <label>
          Billing day <input name="billingDayOfMonth" type="number" min={1} max={28} defaultValue={settings.billingDayOfMonth || 1} />
        </label>
        <label>
          Payment terms <input name="paymentTermsDays" type="number" min={0} max={90} defaultValue={settings.paymentTermsDays || 15} />
        </label>
        <label>
          Credits this month <input name="credits" defaultValue={toDollars(settings.creditsCents)} />
        </label>
        <div className="billing-check-grid">
          <label>
            <input name="autoBillingEnabled" type="checkbox" defaultChecked={!!settings.autoBillingEnabled} /> Auto-charge monthly
          </label>
        </div>
        <button className="btn primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save billing cycle"}
        </button>
      </form>
    </DetailCard>
  );
}

export function AdminTenantMonthlyPricingForm({ detail, onSaved }: { detail: TenantDetail; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const settings = detail.settings || {};
  const meta = settings.metadata && typeof settings.metadata === "object" && !Array.isArray(settings.metadata) ? settings.metadata : {};
  const taxProviderId = String((meta as Record<string, unknown>).taxProviderId || "tax_profile_v1");
  const pricingMode = parseStoredPricingMode(settings.metadata);
  const catalogLocked = pricingMode === "catalog";
  const pr = detail.preview?.pricingResolution;
  const displayExtension = catalogLocked && pr ? pr.extensionPriceCents : settings.extensionPriceCents;
  const displayPhone = catalogLocked && pr ? pr.additionalPhoneNumberPriceCents : settings.additionalPhoneNumberPriceCents;
  const displaySms = catalogLocked && pr ? pr.smsPriceCents : settings.smsPriceCents;
  const displayFirstFree = catalogLocked && pr ? pr.firstPhoneNumberFree !== false : settings.firstPhoneNumberFree !== false;

  return (
    <DetailCard title="Monthly Pricing" key={`mp-${detail.tenant.id}-${pricingMode}-${String(settings.updatedAt ?? "")}`}>
      {catalogLocked ? (
        <div style={{ fontSize: 13, background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 6, padding: "8px 12px", marginBottom: 12 }}>
          <strong>Following billing plan:</strong> unit rates below mirror the active plan for the preview month (read-only here). Taxes, autopay, and credits can still be saved from this form.
          {pr?.banner ? (
            <div style={{ marginTop: 6, fontSize: 12 }}>
              {pr.banner}
            </div>
          ) : null}
        </div>
      ) : null}
      {catalogLocked && (detail.preview?.pricingPreviewExplanation as { tenantOverridesDetected?: boolean } | undefined)?.tenantOverridesDetected ? (
        <div className="billing-status-pill warn" style={{ marginBottom: 12, fontSize: 13, whiteSpace: "normal", lineHeight: 1.45 }}>
          Stored row amounts differ from the plan — invoices still follow the plan until you align or use reset to plan pricing.
        </div>
      ) : null}
      <div className="billing-status-pill warn" style={{ marginBottom: 12, textAlign: "left", whiteSpace: "normal", lineHeight: 1.45 }}>
        <strong>Tax / fees notice</strong>
        {" — "}
        Amounts use configurable Tax Profiles (manual rates) or the optional stub provider. This is not verified telecom tax software. For Orange County NY and other jurisdictions, rates and fee types must be confirmed with an accountant or certified telecom tax provider before relying on automated billing. Integrating an external tax engine via the provider setting is recommended for production telecom tax.
      </div>
      <form
        className="billing-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          try {
            const form = new FormData(event.currentTarget);
            const pricingPayload = catalogLocked
              ? {}
              : {
                  extensionPriceCents: toCents(form.get("extensionPrice")),
                  additionalPhoneNumberPriceCents: toCents(form.get("numberPrice")),
                  smsPriceCents: toCents(form.get("smsPrice")),
                  firstPhoneNumberFree: form.get("firstPhoneNumberFree") === "on",
                  billingPricingMode: "custom" as const,
                };
            await apiPut(`/admin/billing/tenants/${detail.tenant.id}/settings`, {
              ...pricingPayload,
              smsBillingEnabled: form.get("smsBillingEnabled") === "on",
              taxEnabled: form.get("taxEnabled") === "on",
              taxProfileId: String(form.get("taxProfileId") || "") || null,
              taxProviderId: String(form.get("taxProviderId") || "tax_profile_v1"),
              autoBillingEnabled: form.get("autoBillingEnabled") === "on",
              billingDayOfMonth: Number(form.get("billingDayOfMonth") || 1),
              paymentTermsDays: Number(form.get("paymentTermsDays") || 15),
              billingEmail: String(form.get("billingEmail") || "") || null,
              creditsCents: toCents(form.get("credits")),
            });
            onSaved();
          } finally {
            setSaving(false);
          }
        }}
      >
        <label>
          Per extension{" "}
          <input name="extensionPrice" readOnly={catalogLocked} defaultValue={toDollars(displayExtension)} />
        </label>
        <label>
          Additional phone number{" "}
          <input name="numberPrice" readOnly={catalogLocked} defaultValue={toDollars(displayPhone)} />
        </label>
        <label>
          SMS package{" "}
          <input name="smsPrice" readOnly={catalogLocked} defaultValue={toDollars(displaySms)} />
        </label>
        <label>
          Billing email
          <input name="billingEmail" type="text" defaultValue={settings.billingEmail || ""} placeholder="billing@tenant.com or a@b.com, c@d.com" />
          <span style={{ fontSize: 12, color: "#6b7280", display: "block", marginTop: 2 }}>
            Separate multiple addresses with commas — all will receive invoices.
          </span>
        </label>
        <label>
          Billing day <input name="billingDayOfMonth" type="number" min={1} max={28} defaultValue={settings.billingDayOfMonth || 1} />
        </label>
        <label>
          Payment terms <input name="paymentTermsDays" type="number" min={0} max={90} defaultValue={settings.paymentTermsDays || 15} />
        </label>
        <label>
          Credits this month <input name="credits" defaultValue={toDollars(settings.creditsCents)} />
        </label>
        <label>
          Tax profile
          <select name="taxProfileId" defaultValue={settings.taxProfileId || ""}>
            <option value="">No tax profile</option>
            {detail.taxProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tax calculation provider
          <select name="taxProviderId" defaultValue={taxProviderId}>
            <option value="tax_profile_v1">Tax profile (configurable rates in Connect)</option>
            <option value="external_telecom_stub">External telecom stub (no tax lines — placeholder)</option>
          </select>
        </label>
        <div className="billing-check-grid">
          <label>
            <input
              name="firstPhoneNumberFree"
              type="checkbox"
              disabled={catalogLocked}
              defaultChecked={displayFirstFree}
            />{" "}
            First number free
          </label>
          <label>
            <input name="smsBillingEnabled" type="checkbox" defaultChecked={!!settings.smsBillingEnabled} /> Bill SMS package
          </label>
          <label>
            <input name="taxEnabled" type="checkbox" defaultChecked={!!settings.taxEnabled} /> Apply taxes/fees
          </label>
          <label>
            <input name="autoBillingEnabled" type="checkbox" defaultChecked={!!settings.autoBillingEnabled} /> Auto-charge monthly
          </label>
        </div>
        <button className="btn primary" type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save Pricing"}
        </button>
      </form>
    </DetailCard>
  );
}

export function AdminTenantInvoiceBrandingForm({ detail, onSaved }: { detail: TenantDetail; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const settings = detail.settings || {};
  return (
    <DetailCard title="Invoice & email branding" dataTestId="billing-admin-invoice-branding-card">
      <p className="muted" style={{ marginBottom: 12 }}>
        HTTPS logo URL is used in HTML emails only. PDF uses a clean text header.
      </p>
      <form
        className="billing-form"
        data-testid="billing-admin-branding-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          try {
            const form = new FormData(event.currentTarget);
            await apiPut(`/admin/billing/tenants/${detail.tenant.id}/settings`, {
              invoiceCompanyName: String(form.get("invoiceCompanyName") || "").trim() || null,
              invoiceLogoUrl: String(form.get("invoiceLogoUrl") || "").trim() || null,
              invoiceSupportEmail: String(form.get("invoiceSupportEmail") || "").trim() || null,
              invoiceSupportPhone: String(form.get("invoiceSupportPhone") || "").trim() || null,
              invoiceFooterNote: String(form.get("invoiceFooterNote") || "").trim() || null,
              invoicePaymentInstructions: String(form.get("invoicePaymentInstructions") || "").trim() || null,
            });
            onSaved();
          } finally {
            setSaving(false);
          }
        }}
      >
        <label>
          Company display name <input name="invoiceCompanyName" defaultValue={settings.invoiceCompanyName || ""} />
        </label>
        <label>
          Logo URL (https) <input name="invoiceLogoUrl" type="url" defaultValue={settings.invoiceLogoUrl || ""} placeholder="https://…" />
        </label>
        <label>
          Support email <input name="invoiceSupportEmail" type="email" defaultValue={settings.invoiceSupportEmail || ""} />
        </label>
        <label>
          Support phone <input name="invoiceSupportPhone" defaultValue={settings.invoiceSupportPhone || ""} />
        </label>
        <label>
          Footer / legal note <textarea name="invoiceFooterNote" rows={2} defaultValue={settings.invoiceFooterNote || ""} />
        </label>
        <label>
          Payment instructions <textarea name="invoicePaymentInstructions" rows={2} defaultValue={settings.invoicePaymentInstructions || ""} />
        </label>
        <button className="btn primary" type="submit" data-testid="billing-admin-save-branding" disabled={saving}>
          {saving ? "Saving…" : "Save branding"}
        </button>
      </form>
    </DetailCard>
  );
}

export function AdminTenantSolaGatewayForm({ detail, onSaved }: { detail: TenantDetail; onSaved: () => void }) {
  const [busy, setBusy] = useState("");
  const [webhookCopied, setWebhookCopied] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const config = detail.sola.config;
  const webhookUrl = detail.sola.webhookUrl || config?.webhookUrl || null;

  async function copyWebhookUrl() {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setWebhookCopied(true);
      window.setTimeout(() => setWebhookCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <DetailCard title="Payment gateway">
      {webhookUrl ? (
        <div className="muted" style={{ marginBottom: 16, lineHeight: 1.5 }}>
          <strong>Webhook/Postback URL</strong> — paste this exact URL into SOLA/Cardknox webhook or postback settings.
          <div className="row-actions" style={{ marginTop: 8, flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <code style={{ fontSize: "0.85rem", wordBreak: "break-all", flex: "1 1 240px" }}>{webhookUrl}</code>
            <button className="btn ghost" type="button" onClick={() => void copyWebhookUrl()}>
              {webhookCopied ? "Copied" : "Copy URL"}
            </button>
          </div>
        </div>
      ) : null}
      <form
        className="billing-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy("save");
          try {
            const form = new FormData(event.currentTarget);
            const mode = String(form.get("mode") || "sandbox");
            const simulate = mode === "prod" ? false : form.get("simulate") === "on";
            const apiKey = String(form.get("apiKey") || "").trim();
            if (!apiKey && !(config?.masked?.apiKey && String(config.masked.apiKey).includes("*"))) {
              window.alert("SOLA API Key (xKey) is required.");
              return;
            }
            const pin = String(form.get("webhookSecret") || "").trim();
            if (mode === "prod" && !pin && !(config?.masked?.webhookSecret === "********")) {
              window.alert("Production mode requires a Webhook Verification PIN (same value in Connect and in SOLA postback security).");
              return;
            }
            await apiPut(`/admin/billing/platform/tenants/${detail.tenant.id}/sola-config`, {
              mode,
              simulate,
              apiKey: apiKey || undefined,
              webhookSecret: pin || undefined,
              ifieldsKey: String(form.get("ifieldsKey") || "").trim() || undefined,
            });
            onSaved();
          } finally {
            setBusy("");
          }
        }}
      >
        <div className={`billing-status-pill ${config?.isEnabled ? "good" : config ? "warn" : "bad"}`}>
          {config?.isEnabled ? "Enabled" : config ? "Configured but disabled" : "Not configured"}
          {config?.status?.lastTestResult ? ` · Last test ${config.status.lastTestResult}` : ""}
        </div>
        <label>
          Mode (environment)
          <select name="mode" defaultValue={config?.mode || "sandbox"}>
            <option value="sandbox">Sandbox</option>
            <option value="prod">Production</option>
          </select>
        </label>
        <p className="muted" style={{ fontSize: "0.85rem", marginTop: -6 }}>
          Production requires a saved webhook PIN and disables simulated gateway responses.
        </p>
        <label>
          SOLA API Key (xKey) <input name="apiKey" autoComplete="off" placeholder={config?.masked?.apiKey || "From SOLA/Cardknox dashboard"} />
        </label>
        <label>
          iFields public key
          <input name="ifieldsKey" placeholder={config?.masked?.ifieldsKey || "Required for card capture — from Cardknox dashboard"} />
          {!config?.masked?.ifieldsKey ? (
            <span style={{ fontSize: 11, color: "#b45309", marginTop: 3 }}>
              Not set — card entry will not work until this key is saved.
            </span>
          ) : null}
        </label>
        <label>
          Webhook Verification PIN{" "}
          <input name="webhookSecret" type="password" autoComplete="new-password" placeholder={config?.masked?.webhookSecret || "Same PIN as SOLA postback / ck-signature"} />
        </label>
        <label className="billing-checkbox">
          <input name="simulate" type="checkbox" defaultChecked={!!config?.simulate && config?.mode !== "prod"} disabled={config?.mode === "prod"} /> Simulate gateway responses (sandbox only)
        </label>
        <div className="row-actions">
          <button className="btn primary" type="submit" disabled={!!busy}>
            {busy === "save" ? "Saving..." : "Save gateway"}
          </button>
          <button
            className="btn ghost"
            type="button"
            disabled={!config || !!busy}
            onClick={async () => {
              setBusy("test");
              setToast(null);
              try {
                const result = await apiPost<{ ok: boolean; simulated?: boolean }>(`/admin/billing/platform/tenants/${detail.tenant.id}/sola-config/test`, {});
                setToast({ kind: "ok", text: result.simulated ? "Gateway test passed (simulated)" : "Gateway test passed" });
                onSaved();
              } catch (err: unknown) {
                setToast({ kind: "err", text: billingErrorMessage(err, "Gateway test failed") });
              } finally {
                setBusy("");
              }
            }}
          >
            {busy === "test" ? "Testing..." : "Test configuration"}
          </button>
          {config?.isEnabled ? (
            <button
              className="btn danger"
              type="button"
              disabled={!!busy}
              onClick={async () => {
                setBusy("disable");
                setToast(null);
                try {
                  await apiPost(`/admin/billing/platform/tenants/${detail.tenant.id}/sola-config/disable`, {});
                  onSaved();
                } catch (err: unknown) {
                  setToast({ kind: "err", text: billingErrorMessage(err, "Could not disable gateway") });
                } finally {
                  setBusy("");
                }
              }}
            >
              Disable
            </button>
          ) : (
            <button
              className="btn ghost"
              type="button"
              disabled={!config || config?.status?.lastTestResult !== "SUCCESS" || !!busy}
              onClick={async () => {
                setBusy("enable");
                setToast(null);
                try {
                  await apiPost(`/admin/billing/platform/tenants/${detail.tenant.id}/sola-config/enable`, {});
                  onSaved();
                } catch (err: unknown) {
                  setToast({ kind: "err", text: billingErrorMessage(err, "Could not enable gateway") });
                } finally {
                  setBusy("");
                }
              }}
            >
              Enable
            </button>
          )}
        </div>
        {!config?.isEnabled ? (
          (() => {
            const reason = !config
              ? "Save an API key first"
              : config.status?.lastTestResult === "FAILED"
              ? "Last test failed — re-run Test configuration"
              : config.status?.lastTestResult !== "SUCCESS"
              ? "Run Test configuration first"
              : null;
            return reason ? (
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 6 }}>{reason}</p>
            ) : null;
          })()
        ) : null}
        {toast ? <BillingActionToast kind={toast.kind} text={toast.text} /> : null}
      </form>
    </DetailCard>
  );
}

type TenantPricingDiagApi = {
  mode: string;
  billingPlanCurrent: { id: string; code: string; name: string; active: boolean } | null;
  scheduledPlanChange: { nextBillingPlanId: string; nextPlanName: string; effectiveAt: string } | null;
  pricingState: {
    mode: string;
    warnings: string[];
    flags: { tenantRowDiffersFromLinkedPlan: boolean };
    scheduledNext: { plan: { name: string }; effectiveAt: string } | null;
    activePlanForPeriod: { id: string; name: string } | null;
    currentPlan: { id: string; name: string; active: boolean } | null;
  };
};

type BillingPlanPickerRow = {
  id: string;
  code: string;
  name: string;
  active: boolean;
};

function pricingModeBadgeStyle(mode: string): CSSProperties {
  const base: CSSProperties = { fontSize: 11, padding: "2px 10px", borderRadius: 999, fontWeight: 600 };
  if (mode === "catalog") return { ...base, background: "#dcfce7", color: "#166534", border: "1px solid #86efac" };
  if (mode === "custom") return { ...base, background: "#fef9c3", color: "#854d0e", border: "1px solid #facc15" };
  return { ...base, background: "#f1f5f9", color: "#334155", border: "1px solid #cbd5e1" };
}

/** Uses `pricing-diagnostics.pricingState.warnings` (normalized billing pricing flags). */
export function AdminBillingPricingWarningsBanner({
  tenantId,
  previewMonth,
  previewYear,
}: {
  tenantId: string;
  previewMonth: number;
  previewYear: number;
}) {
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const qs = `?periodMonth=${encodeURIComponent(String(previewMonth))}&periodYear=${encodeURIComponent(String(previewYear))}`;
        const d = await apiGet<TenantPricingDiagApi>(`/admin/billing/platform/tenants/${tenantId}/pricing-diagnostics${qs}`);
        if (!cancelled) setWarnings(d.pricingState?.warnings ?? []);
      } catch {
        if (!cancelled) setWarnings([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [tenantId, previewMonth, previewYear]);

  if (loading || warnings.length === 0) return null;

  return (
    <div style={{ marginBottom: 14 }}>
      {warnings.map((w) => (
        <div key={w} className="billing-status-pill warn" style={{ marginBottom: 8, fontSize: 13, whiteSpace: "normal", lineHeight: 1.45 }}>
          {w}
        </div>
      ))}
    </div>
  );
}

type AssignPlanPreviewApi = {
  simulation: { copyPlanPrices: boolean; applyPricingMode: string | null };
  tenantPricingQuad: {
    before: { extensionPriceCents: number; additionalPhoneNumberPriceCents: number; smsPriceCents: number; firstPhoneNumberFree: boolean };
    after: { extensionPriceCents: number; additionalPhoneNumberPriceCents: number; smsPriceCents: number; firstPhoneNumberFree: boolean };
  };
  invoiceTotals: { before: { totalCents: number }; after: { totalCents: number } };
  notes: string[];
  scheduledPlanActiveForPreviewPeriod: boolean;
};

function narrowAssignPlanPreview(data: AssignPlanPreviewApi & Record<string, unknown>): AssignPlanPreviewApi {
  return {
    simulation: data.simulation,
    tenantPricingQuad: data.tenantPricingQuad,
    invoiceTotals: data.invoiceTotals,
    notes: data.notes,
    scheduledPlanActiveForPreviewPeriod: data.scheduledPlanActiveForPreviewPeriod,
  };
}

export function AdminCurrentBillingPlanAssignCard({
  tenantId,
  tenantName,
  previewMonth,
  previewYear,
  onAssigned,
  embedded = false,
  onRegisterOpenModal,
}: {
  tenantId: string;
  tenantName?: string | null;
  previewMonth: number;
  previewYear: number;
  onAssigned: () => void;
  /** When true, only modal + assign API — UI lives in AdminPricingWorkspace. */
  embedded?: boolean;
  onRegisterOpenModal?: (open: () => void) => void;
}) {
  const [diag, setDiag] = useState<TenantPricingDiagApi | null>(null);
  const [diagLoading, setDiagLoading] = useState(true);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [plans, setPlans] = useState<BillingPlanPickerRow[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [pricingModeOption, setPricingModeOption] = useState<"unchanged" | "catalog" | "custom">("unchanged");
  const [copyPlanPrices, setCopyPlanPrices] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<AssignPlanPreviewApi | null>(null);
  const [saving, setSaving] = useState(false);

  const loadDiag = useCallback(async () => {
    setDiagLoading(true);
    setToast(null);
    try {
      const qs = `?periodMonth=${encodeURIComponent(String(previewMonth))}&periodYear=${encodeURIComponent(String(previewYear))}`;
      setDiag(await apiGet<TenantPricingDiagApi>(`/admin/billing/platform/tenants/${tenantId}/pricing-diagnostics${qs}`));
    } catch (err: unknown) {
      setDiag(null);
      setToast({ kind: "err", text: billingErrorMessage(err, "Could not load billing diagnostics.") });
    } finally {
      setDiagLoading(false);
    }
  }, [tenantId, previewMonth, previewYear]);

  useEffect(() => {
    void loadDiag();
  }, [loadDiag]);

  const openModal = useCallback(async () => {
    setToast(null);
    setPreviewData(null);
    setModalOpen(true);
    setPricingModeOption("unchanged");
    setCopyPlanPrices(false);
    try {
      const rows = await apiGet<BillingPlanPickerRow[]>("/admin/billing/platform/billing-plans");
      const active = rows.filter((p) => p.active !== false);
      setPlans(active);
      const initial =
        diag?.billingPlanCurrent?.id && active.some((p) => p.id === diag.billingPlanCurrent!.id)
          ? diag.billingPlanCurrent!.id
          : active[0]?.id || "";
      setSelectedPlanId(initial);
    } catch (err: unknown) {
      setToast({ kind: "err", text: billingErrorMessage(err, "Could not load billing plans.") });
    }
  }, [diag?.billingPlanCurrent?.id]);

  const refreshPreview = useCallback(async () => {
    if (!selectedPlanId) return;
    setPreviewLoading(true);
    setToast(null);
    try {
      const qs = new URLSearchParams({
        billingPlanId: selectedPlanId,
        periodMonth: String(previewMonth),
        periodYear: String(previewYear),
      });
      if (copyPlanPrices) qs.set("copyPlanPrices", "true");
      if (pricingModeOption === "catalog") qs.set("applyPricingMode", "catalog");
      if (pricingModeOption === "custom") qs.set("applyPricingMode", "custom");
      const data = await apiGet<AssignPlanPreviewApi>(
        `/admin/billing/platform/tenants/${tenantId}/assign-plan-preview?${qs.toString()}`,
      );
      setPreviewData(narrowAssignPlanPreview(data as AssignPlanPreviewApi & Record<string, unknown>));
    } catch (err: unknown) {
      setPreviewData(null);
      setToast({ kind: "err", text: billingErrorMessage(err, "Preview failed — check plan selection.") });
    } finally {
      setPreviewLoading(false);
    }
  }, [tenantId, selectedPlanId, previewMonth, previewYear, copyPlanPrices, pricingModeOption]);

  useEffect(() => {
    if (!modalOpen || !selectedPlanId) return;
    const t = setTimeout(() => void refreshPreview(), 200);
    return () => clearTimeout(t);
  }, [modalOpen, selectedPlanId, refreshPreview]);

  useEffect(() => {
    if (!embedded || !onRegisterOpenModal) return;
    onRegisterOpenModal(() => void openModal());
  }, [embedded, onRegisterOpenModal, openModal]);

  async function confirmAssign() {
    if (!selectedPlanId) return;
    setSaving(true);
    setToast(null);
    try {
      await apiPost(`/admin/billing/platform/tenants/${tenantId}/assign-current-plan`, {
        billingPlanId: selectedPlanId,
        copyPlanPrices,
        ...(pricingModeOption !== "unchanged" ? { applyPricingMode: pricingModeOption } : {}),
      });
      setModalOpen(false);
      setPreviewData(null);
      onAssigned();
      void loadDiag();
      setToast({ kind: "ok", text: "Current billing plan updated." });
    } catch (err: unknown) {
      setToast({ kind: "err", text: billingErrorMessage(err, "Assign failed.") });
    } finally {
      setSaving(false);
    }
  }

  const ps = diag?.pricingState;
  const matchBadge = !diag?.billingPlanCurrent ? (
    <span className="billing-status-pill" style={{ fontSize: 11 }}>
      No linked plan
    </span>
  ) : ps?.flags?.tenantRowDiffersFromLinkedPlan === false ? (
    <span className="billing-status-pill good" style={{ fontSize: 11 }}>
      Tenant row matches linked plan
    </span>
  ) : (
    <span className="billing-status-pill warn" style={{ fontSize: 11 }}>
      Tenant row differs from linked plan
    </span>
  );

  const assignModal = modalOpen ? (
        <BillingActionPanel
          layout="center"
          centerWidth="min(580px, 96vw)"
          onClose={() => { if (!saving) setModalOpen(false); }}
          eyebrow={tenantName || undefined}
          title="Change billing plan"
          subtitle="Updates the linked plan immediately. Optionally copy catalog prices to the company row and/or change how prices are calculated. The scheduled next plan is not changed here. No invoice is created."
          warning="Invoice preview totals below may use the scheduled plan for the selected month — assigning still only updates the current plan pointer."
          children={(
            <div data-testid="billing-admin-assign-plan-dialog" style={{ maxHeight: "min(70vh, 640px)", overflowY: "auto" }}>
            <label style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
              Catalog plan
              <select
                value={selectedPlanId}
                onChange={(e) => setSelectedPlanId(e.target.value)}
                style={{ fontSize: 13 }}
              >
                {plans.length === 0 ? <option value="">No active plans</option> : null}
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.code})
                  </option>
                ))}
              </select>
            </label>

            <div style={{ fontSize: 13, marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Pricing mode</div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <input type="radio" name="apm" checked={pricingModeOption === "unchanged"} onChange={() => setPricingModeOption("unchanged")} />
                Leave unchanged
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <input type="radio" name="apm" checked={pricingModeOption === "catalog"} onChange={() => setPricingModeOption("catalog")} />
                Follow company billing plan
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="radio" name="apm" checked={pricingModeOption === "custom"} onChange={() => setPricingModeOption("custom")} />
                Custom company pricing
              </label>
            </div>

            <label className="billing-checkbox" style={{ fontSize: 13, marginBottom: 12, display: "block" }}>
              <input type="checkbox" checked={copyPlanPrices} onChange={(e) => setCopyPlanPrices(e.target.checked)} />
              Copy plan pricing into tenant row (all four fields)
            </label>

            {previewLoading ? <p className="muted" style={{ fontSize: 13 }}>Updating preview…</p> : null}


            {previewData?.notes?.length ? (
              <ul style={{ fontSize: 12, color: "var(--muted)", paddingLeft: 18, margin: "0 0 12px" }}>
                {previewData.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}

            {previewData ? (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>Tenant row pricing (preview)</div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border, #e5e7eb)" }}>
                      <th style={{ textAlign: "left", padding: 4 }}>Field</th>
                      <th style={{ textAlign: "right", padding: 4 }}>Before</th>
                      <th style={{ textAlign: "right", padding: 4 }}>After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ["Extension", "extensionPriceCents"],
                        ["Phone add-on", "additionalPhoneNumberPriceCents"],
                        ["SMS", "smsPriceCents"],
                      ] as const
                    ).map(([label, key]) => (
                      <tr key={key} style={{ borderBottom: "1px solid var(--border-light,#f3f4f6)" }}>
                        <td style={{ padding: 4 }}>{label}</td>
                        <td style={{ textAlign: "right", padding: 4 }}>{toDollars(previewData.tenantPricingQuad.before[key])}</td>
                        <td style={{ textAlign: "right", padding: 4, fontWeight: 600 }}>{toDollars(previewData.tenantPricingQuad.after[key])}</td>
                      </tr>
                    ))}
                    <tr style={{ borderBottom: "1px solid var(--border-light,#f3f4f6)" }}>
                      <td style={{ padding: 4 }}>1st phone free</td>
                      <td style={{ textAlign: "right", padding: 4 }}>{previewData.tenantPricingQuad.before.firstPhoneNumberFree ? "Yes" : "No"}</td>
                      <td style={{ textAlign: "right", padding: 4, fontWeight: 600 }}>
                        {previewData.tenantPricingQuad.after.firstPhoneNumberFree ? "Yes" : "No"}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
                  Invoice totals (preview): before {toDollars(previewData.invoiceTotals.before.totalCents)} · after{" "}
                  {toDollars(previewData.invoiceTotals.after.totalCents)}
                </p>
              </div>
            ) : null}
            </div>
          )}
          footer={(
            <>
              <button
                className="btn ghost"
                type="button"
                data-testid="billing-admin-assign-plan-cancel"
                disabled={saving}
                onClick={() => setModalOpen(false)}
              >
                Cancel
              </button>
              <button
                className="btn ghost"
                type="button"
                disabled={!selectedPlanId || previewLoading || saving}
                onClick={() => void refreshPreview()}
              >
                Refresh preview
              </button>
              <button className="btn primary" type="button" disabled={!selectedPlanId || saving || previewLoading} onClick={() => void confirmAssign()}>
                {saving ? "Saving…" : "Confirm assign"}
              </button>
            </>
          )}
        />
      ) : null;

  if (embedded) {
    return (
      <>
        {toast ? <BillingActionToast kind={toast.kind} text={toast.text} /> : null}
        {assignModal}
      </>
    );
  }

  return (
    <DetailCard title="Current Billing Plan" dataTestId="billing-admin-current-plan-card">
      {diagLoading ? <p className="muted" style={{ fontSize: 13 }}>Loading…</p> : null}
      {!diagLoading && diag ? (
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <span style={pricingModeBadgeStyle(ps?.mode || "legacy")}>{humanizePricingStateMode(ps?.mode || "legacy")}</span>
            {matchBadge}
          </div>
          <p style={{ margin: "0 0 8px" }}>
            Linked plan:{" "}
            <strong>{diag.billingPlanCurrent ? `${diag.billingPlanCurrent.name} (${diag.billingPlanCurrent.code})` : "—"}</strong>
            {diag.billingPlanCurrent && diag.billingPlanCurrent.active === false ? (
              <span style={{ color: "#b45309", marginLeft: 8 }}>(inactive)</span>
            ) : null}
          </p>
          <p style={{ margin: "0 0 8px", color: "var(--muted)", fontSize: 12 }}>
            Active plan for preview period:{" "}
            <strong>{ps?.activePlanForPeriod?.name || "—"}</strong>
            {ps?.scheduledNext ? (
              <>
                {" "}
                · Scheduled next: <strong>{ps.scheduledNext.plan.name}</strong> effective {new Date(ps.scheduledNext.effectiveAt).toLocaleDateString()}
              </>
            ) : (
              <> · No scheduled plan change</>
            )}
          </p>
          <button
            className="btn primary"
            type="button"
            style={{ fontSize: 13 }}
            data-testid="billing-admin-assign-plan-open"
            onClick={() => void openModal()}
          >
            Change plan
          </button>
        </div>
      ) : null}

      {toast ? <BillingActionToast kind={toast.kind} text={toast.text} /> : null}
      {assignModal}
    </DetailCard>
  );
}

