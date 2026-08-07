"use client";

/* Mockup 8 — Catalog, reports & setup. The things you set once: plans, tax
   profiles, reports and exports. */

import Link from "next/link";
import { BillingNav, Pill, asList, money, useApi } from "../_new/ui";
import "../customer/customerBilling.css";

type Plan = {
  id: string;
  name: string;
  active?: boolean;
  extensionPriceCents?: number | null;
  additionalPhoneNumberPriceCents?: number | null;
  smsPriceCents?: number | null;
  firstPhoneNumberFree?: boolean | null;
};

type TaxProfile = {
  id: string;
  name: string;
  ratePercent?: number | string | null;
  active?: boolean;
};

type TenantRow = { id: string; billingSettings?: { billingPlanId?: string | null; taxProfileId?: string | null } | null };

export default function BillingCatalogPage() {
  const plans = useApi<Plan[]>("/admin/billing/platform/billing-plans", (raw) => asList<Plan>(raw, "plans", "billingPlans"));
  const taxes = useApi<TaxProfile[]>("/admin/billing/tax-profiles", (raw) => asList<TaxProfile>(raw, "taxProfiles", "profiles"));
  const tenants = useApi<TenantRow[]>("/admin/billing/platform/tenants", (raw) => asList<TenantRow>(raw, "tenants"));

  const usageOfPlan = (id: string) =>
    (tenants.data || []).filter((t) => t.billingSettings?.billingPlanId === id).length;
  const usageOfTax = (id: string) =>
    (tenants.data || []).filter((t) => t.billingSettings?.taxProfileId === id).length;

  return (
    <div className="cbill">
      <BillingNav current="catalog" />
      <div className="cbill-head">
        <div>
          <h2>Catalog</h2>
          <div className="cbill-sub">
            <span>Plans, taxes and reports — the defaults every customer starts from</span>
          </div>
        </div>
        <div className="cbill-toolbar">
          <Link className="cbill-btn" href="/admin/billing/customers">Customers</Link>
          <Link className="cbill-btn" href="/admin/billing/plans">Edit plans</Link>
        </div>
      </div>

      {plans.error && <div className="cbill-banner bad">{plans.error}</div>}

      <section className="cbill-card">
        <div className="cbill-card-hd">
          <h3>Plans</h3>
          <span className="hint">a plan is the starting point; each customer can override any price</span>
        </div>
        <div className="cbill-table-wrap">
          <table className="cbill-table">
            <thead>
              <tr>
                <th>Plan</th><th className="r">Extension</th><th className="r">Extra number</th>
                <th className="r">Texting</th><th className="r">First number</th><th className="r">In use by</th>
              </tr>
            </thead>
            <tbody>
              {plans.loading && <tr><td colSpan={6} style={{ color: "var(--cb-muted)" }}>Loading…</td></tr>}
              {!plans.loading && (plans.data || []).length === 0 && (
                <tr><td colSpan={6} style={{ color: "var(--cb-muted)" }}>No plans defined.</td></tr>
              )}
              {(plans.data || []).map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.name} {p.active === false && <Pill tone="off">Inactive</Pill>}
                  </td>
                  <td className="r n">{money(p.extensionPriceCents ?? 0)}</td>
                  <td className="r n">{money(p.additionalPhoneNumberPriceCents ?? 0)}</td>
                  <td className="r n">{money(p.smsPriceCents ?? 0)}</td>
                  <td className="r">{p.firstPhoneNumberFree === false ? "Charged" : "Free"}</td>
                  <td className="r n">{usageOfPlan(p.id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cbill-card">
        <div className="cbill-card-hd">
          <h3>Tax profiles</h3>
          <span className="hint">assigned per customer on their billing page</span>
        </div>
        <div className="cbill-table-wrap">
          <table className="cbill-table">
            <thead>
              <tr><th>Profile</th><th className="r">Rate</th><th className="r">In use by</th></tr>
            </thead>
            <tbody>
              {taxes.loading && <tr><td colSpan={3} style={{ color: "var(--cb-muted)" }}>Loading…</td></tr>}
              {!taxes.loading && (taxes.data || []).length === 0 && (
                <tr><td colSpan={3} style={{ color: "var(--cb-muted)" }}>No tax profiles.</td></tr>
              )}
              {(taxes.data || []).map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="r n">{t.ratePercent != null ? `${Number(t.ratePercent)}%` : "—"}</td>
                  <td className="r n">{usageOfTax(t.id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cbill-card">
        <div className="cbill-card-hd">
          <h3>Reports &amp; exports</h3>
          <span className="hint">downloads open in a new tab</span>
        </div>
        <div className="cbill-actions">
          <a className="cbill-btn" href="/api/admin/billing/reports/aging" target="_blank" rel="noreferrer">Aging report</a>
          <a className="cbill-btn" href="/api/admin/billing/reports/failed-payments" target="_blank" rel="noreferrer">Failed payments</a>
          <a className="cbill-btn" href="/api/admin/billing/reports/aging/export" target="_blank" rel="noreferrer">Export aging CSV</a>
          <a className="cbill-btn" href="/api/admin/billing/reports/failed-payments/export" target="_blank" rel="noreferrer">Export failed payments CSV</a>
          <a className="cbill-btn" href="/api/admin/billing/reports/export/invoices" target="_blank" rel="noreferrer">Export invoices CSV</a>
          <a className="cbill-btn" href="/api/admin/billing/reports/export/transactions" target="_blank" rel="noreferrer">Export transactions CSV</a>
        </div>
      </section>

      <section className="cbill-card">
        <div className="cbill-card-hd">
          <h3>Gateway &amp; imports</h3>
          <span className="hint">these still live on the original screens</span>
        </div>
        <div className="cbill-actions">
          <Link className="cbill-btn" href="/admin/billing/settings">Payment gateway settings</Link>
          <Link className="cbill-btn" href="/admin/billing/sola-imports">Imported recurring schedules</Link>
          <Link className="cbill-btn" href="/admin/billing/methods">Saved cards</Link>
          <Link className="cbill-btn" href="/admin/billing/activity">Billing activity log</Link>
          <Link className="cbill-btn" href="/admin/billing/collections">Collections queue</Link>
        </div>
      </section>
    </div>
  );
}
