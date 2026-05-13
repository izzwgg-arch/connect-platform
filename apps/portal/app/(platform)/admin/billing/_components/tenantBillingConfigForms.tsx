"use client";

import { useState } from "react";
import { apiPost, apiPut } from "../../../../../services/apiClient";
import { DetailCard } from "../../../../../components/DetailCard";

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

export function AdminTenantMonthlyPricingForm({ detail, onSaved }: { detail: TenantDetail; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const settings = detail.settings || {};
  const meta = settings.metadata && typeof settings.metadata === "object" && !Array.isArray(settings.metadata) ? settings.metadata : {};
  const taxProviderId = String((meta as Record<string, unknown>).taxProviderId || "tax_profile_v1");
  return (
    <DetailCard title="Monthly Pricing">
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
            await apiPut(`/admin/billing/tenants/${detail.tenant.id}/settings`, {
              extensionPriceCents: toCents(form.get("extensionPrice")),
              additionalPhoneNumberPriceCents: toCents(form.get("numberPrice")),
              smsPriceCents: toCents(form.get("smsPrice")),
              firstPhoneNumberFree: form.get("firstPhoneNumberFree") === "on",
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
          Per extension <input name="extensionPrice" defaultValue={toDollars(settings.extensionPriceCents)} />
        </label>
        <label>
          Additional phone number <input name="numberPrice" defaultValue={toDollars(settings.additionalPhoneNumberPriceCents)} />
        </label>
        <label>
          SMS package <input name="smsPrice" defaultValue={toDollars(settings.smsPriceCents)} />
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
            <input name="firstPhoneNumberFree" type="checkbox" defaultChecked={settings.firstPhoneNumberFree !== false} /> First number free
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
              try {
                await apiPost(`/admin/billing/platform/tenants/${detail.tenant.id}/sola-config/test`, {});
                onSaved();
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
                try {
                  await apiPost(`/admin/billing/platform/tenants/${detail.tenant.id}/sola-config/disable`, {});
                  onSaved();
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
                try {
                  await apiPost(`/admin/billing/platform/tenants/${detail.tenant.id}/sola-config/enable`, {});
                  onSaved();
                } finally {
                  setBusy("");
                }
              }}
            >
              Enable
            </button>
          )}
        </div>
      </form>
    </DetailCard>
  );
}
