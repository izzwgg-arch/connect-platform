"use client";

import { useState } from "react";
import { apiPost, apiPut } from "../../../../../services/apiClient";
import { DetailCard } from "../../../../../components/DetailCard";
import { BillingActionToast, billingErrorMessage } from "../../../../../components/BillingActionToast";

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
  if (key === "tenant_override") return "Tenant override";
  return "Legacy";
}

export function AdminTenantPricingSourceCard({ detail, onSaved }: { detail: TenantDetail; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const settings = detail.settings || {};
  const pr = detail.preview?.pricingResolution;
  const bp = settings.billingPlan;
  const mode = parseStoredPricingMode(settings.metadata);

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

  async function resetToPlan() {
    setSaving(true);
    setToast(null);
    try {
      await apiPost(`/admin/billing/platform/tenants/${detail.tenant.id}/pricing/reset-to-plan`, {});
      onSaved();
      setToast({ kind: "ok", text: "Prices reset to current BillingPlan and mode set to Catalog." });
    } catch (err: unknown) {
      setToast({ kind: "err", text: billingErrorMessage(err, "Reset failed — tenant may have no billingPlanId.") });
    } finally {
      setSaving(false);
    }
  }

  return (
    <DetailCard title="Billing pricing source">
      <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12, lineHeight: 1.45 }}>
        <strong>Legacy</strong> matches historical behavior (tenant row can shadow catalog). <strong>Catalog</strong> always bills the active plan for the preview period
        (including scheduled future plans). <strong>Custom</strong> uses only the tenant row — specify when you need negotiated rates.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }} role="radiogroup" aria-label="Pricing source">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: saving ? "default" : "pointer" }}>
          <input type="radio" name="pricingMode" checked={mode === "legacy"} disabled={saving} onChange={() => void saveMode("legacy")} />
          Legacy (historical resolution)
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: saving ? "default" : "pointer" }}>
          <input type="radio" name="pricingMode" checked={mode === "catalog"} disabled={saving} onChange={() => void saveMode("catalog")} />
          Use catalog billing plan pricing
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: saving ? "default" : "pointer" }}>
          <input type="radio" name="pricingMode" checked={mode === "custom"} disabled={saving} onChange={() => void saveMode("custom")} />
          Use custom tenant pricing
        </label>
      </div>

      {mode === "custom" && pr?.banner?.toLowerCase().includes("override") ? (
        <div className="billing-status-pill warn" style={{ marginBottom: 12, fontSize: 13, whiteSpace: "normal", lineHeight: 1.45 }}>
          {pr.banner}
        </div>
      ) : null}

      {pr ? (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Per-field source (current month preview)</div>
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
              Current plan FK: <strong>{bp.name}</strong>
              {pr.activePlanName && pr.activePlanName !== bp.name ? (
                <>
                  {" "}
                  · Preview active plan: <strong>{pr.activePlanName}</strong>
                </>
              ) : null}
            </p>
          ) : (
            <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>No billingPlanId on tenant — catalog mode uses defaults until a plan is linked.</p>
          )}
        </div>
      ) : null}

      <div className="row-actions" style={{ flexWrap: "wrap", gap: 8 }}>
        <button className="btn ghost" type="button" disabled={saving || !bp} onClick={() => void resetToPlan()}>
          {saving ? "Working…" : "Reset to plan pricing"}
        </button>
      </div>
      <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
        Reset copies all four unit-pricing fields from the tenant&apos;s current <code>billingPlanId</code> and sets mode to Catalog. Requires a linked plan.
      </p>
      {toast ? <BillingActionToast kind={toast.kind} text={toast.text} /> : null}
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
          <strong>Catalog pricing mode:</strong> unit rates below reflect the active billing plan for the invoice preview period (read-only). Taxes, autopay, and credits still save from this form.
          {pr?.banner ? (
            <div style={{ marginTop: 6, fontSize: 12 }}>
              {pr.banner}
            </div>
          ) : null}
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
          Billing email <input name="billingEmail" type="email" defaultValue={settings.billingEmail || ""} placeholder="billing@tenant.com" />
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
    <DetailCard title="Invoice & email branding">
      <p className="muted" style={{ marginBottom: 12 }}>
        HTTPS logo URL is used in HTML emails only. PDF uses a clean text header.
      </p>
      <form
        className="billing-form"
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
        <button className="btn primary" type="submit" disabled={saving}>
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
    <DetailCard title="SOLA Gateway">
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
          iFields public key (optional) <input name="ifieldsKey" placeholder={config?.masked?.ifieldsKey || "For tenant Billing → Payments"} />
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
            {busy === "save" ? "Saving..." : "Save SOLA"}
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
                setToast({ kind: "ok", text: result.simulated ? "SOLA configuration test passed (simulated)" : "SOLA configuration test passed" });
                onSaved();
              } catch (err: unknown) {
                setToast({ kind: "err", text: billingErrorMessage(err, "SOLA test failed") });
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
                  setToast({ kind: "err", text: billingErrorMessage(err, "Could not disable SOLA") });
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
                  setToast({ kind: "err", text: billingErrorMessage(err, "Could not enable SOLA") });
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
