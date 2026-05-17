"use client";

import "../admin/billing/_components/billingPhase3.css";
import "../admin/billing/_components/billingPhase4.css";
import "../admin/billing/_components/billingPhase5.css";
import Link from "next/link";
import { useState } from "react";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiGet, apiPut } from "../../../services/apiClient";
import { DetailCard } from "../../../components/DetailCard";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";

/**
 * Tenant-facing billing preferences (invoice presentation only).
 * Payment processor / gateway configuration lives under Admin Billing → Company billing setup → Payment gateway.
 */
export function TenantBillingSettingsContent() {
  const [busy, setBusy] = useState("");
  const tenantBilling = useAsyncResource(() => apiGet<any>("/billing/settings"), []);
  const bs = tenantBilling.status === "success" ? tenantBilling.data : null;

  return (
    <PermissionGate permission="can_view_settings_billing" fallback={<div className="state-box">You do not have billing settings access.</div>}>
      <div className="stack compact-stack billing-p5-scope">
        <PageHeader
          title="Billing settings"
          subtitle="How invoices and customer emails look. Saved cards are managed under Payment methods — not on this page."
        />
        <div className="billing-p5-tenant-actions" style={{ marginTop: -8, marginBottom: 8 }}>
          <Link className="btn ghost" href="/billing">
            ← Billing overview
          </Link>
          <Link className="btn ghost" href="/billing/payments">
            Payment methods
          </Link>
        </div>
        <p className="billing-p5-muted-block">
          Connecting or changing how cards are processed is handled by your Connect service provider and is not available on this screen.
        </p>
        {tenantBilling.status === "loading" ? <LoadingSkeleton rows={4} /> : null}
        {tenantBilling.status === "error" ? <ErrorState message={tenantBilling.error} /> : null}

        {bs ? (
          <DetailCard title="Invoice & email presentation">
            <p className="muted" style={{ marginBottom: 14 }}>
              Shown on PDF invoices (text header) and billing emails. Logo URL must be <strong>https</strong> — used in HTML emails only, not embedded in PDFs.
            </p>
            <form
              className="billing-form"
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy("brand");
                try {
                  const form = new FormData(event.currentTarget);
                  await apiPut("/billing/settings/branding", {
                    invoiceCompanyName: String(form.get("invoiceCompanyName") || "").trim() || null,
                    invoiceLogoUrl: String(form.get("invoiceLogoUrl") || "").trim() || null,
                    invoiceSupportEmail: String(form.get("invoiceSupportEmail") || "").trim() || null,
                    invoiceSupportPhone: String(form.get("invoiceSupportPhone") || "").trim() || null,
                    invoiceFooterNote: String(form.get("invoiceFooterNote") || "").trim() || null,
                    invoicePaymentInstructions: String(form.get("invoicePaymentInstructions") || "").trim() || null,
                  });
                  window.location.reload();
                } finally {
                  setBusy("");
                }
              }}
            >
              <label>
                Company display name <input name="invoiceCompanyName" defaultValue={bs.invoiceCompanyName || ""} placeholder="Shown on invoice & emails" />
              </label>
              <label>
                Logo URL (https only) <input name="invoiceLogoUrl" type="url" defaultValue={bs.invoiceLogoUrl || ""} placeholder="https://cdn.example.com/logo.png" />
              </label>
              <label>
                Billing support email <input name="invoiceSupportEmail" type="email" defaultValue={bs.invoiceSupportEmail || ""} placeholder="billing-support@yourcompany.com" />
              </label>
              <label>
                Billing support phone <input name="invoiceSupportPhone" defaultValue={bs.invoiceSupportPhone || ""} placeholder="+1 …" />
              </label>
              <label>
                Invoice footer / legal note <textarea name="invoiceFooterNote" rows={3} defaultValue={bs.invoiceFooterNote || ""} placeholder="Plain text, shown on PDF and email footers" />
              </label>
              <label>
                Payment instructions <textarea name="invoicePaymentInstructions" rows={3} defaultValue={bs.invoicePaymentInstructions || ""} placeholder="Wire details, remittance notes, etc." />
              </label>
              <p className="muted" style={{ fontSize: "0.85rem" }}>
                Default due offset is <strong>{bs.paymentTermsDays ?? 15}</strong> days (operators set this in Admin Billing when needed). Emails include “Net N days” from that value.
              </p>
              <div className="row-actions">
                <button className="btn primary" type="submit" disabled={!!busy}>
                  {busy === "brand" ? "Saving…" : "Save presentation"}
                </button>
              </div>
            </form>
          </DetailCard>
        ) : null}
      </div>
    </PermissionGate>
  );
}
