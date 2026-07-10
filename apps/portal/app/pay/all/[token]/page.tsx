"use client";

import Image from "next/image";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Lock, ShieldCheck } from "lucide-react";
import { CardknoxIFieldsForm, type CardknoxBillingFields } from "../../../../components/billing/CardknoxIFieldsForm";
import { PaymentTrustBadge } from "../../../../components/billing/PaymentTrustBadge";
import { useAppContext } from "../../../../hooks/useAppContext";
import "./pay-invoice.css";

const apiBase = (process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api").replace(/\/$/, "");

type PayAllInvoice = { invoiceId: string; invoiceNumber: string; status: string; totalCents: number; balanceDueCents: number; dueDate: string | null };
type PayAllView = { companyName: string; currency: string; totalDueCents: number; invoiceCount: number; canPay: boolean; invoices: PayAllInvoice[] };
type PublicConfig = { ifieldsKey: string; ifieldsVersion: string; mode: string; canPay: boolean };
type PayTheme = "light" | "dark";

function dollars(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents || 0) / 100);
}
function billingXExp(billing: CardknoxBillingFields): string | null {
  const month = billing.expMonth.replace(/\D/g, "").padStart(2, "0").slice(-2);
  const yearDigits = billing.expYear.replace(/\D/g, "");
  const year = yearDigits.length >= 4 ? yearDigits.slice(-2) : yearDigits.padStart(2, "0");
  if (!/^(0[1-9]|1[0-2])$/.test(month) || !/^\d{2}$/.test(year)) return null;
  return `${month}${year}`;
}
function fmtDate(iso: string | null) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }); } catch { return iso; }
}
function normalizePayTheme(value: string | null | undefined): PayTheme | null {
  return value === "dark" || value === "light" ? value : null;
}

export default function PublicPayAllPage() {
  const params = useParams<{ token: string }>();
  const search = useSearchParams();
  const token = params?.token;
  const { theme } = useAppContext();
  const [systemTheme, setSystemTheme] = useState<PayTheme>("light");
  const payTheme = normalizePayTheme(search.get("theme")) ?? normalizePayTheme(theme) ?? systemTheme;
  const [view, setView] = useState<PayAllView | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loadError, setLoadError] = useState("");
  const [payError, setPayError] = useState("");
  const [paid, setPaid] = useState(false);
  const submitInFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoadError("");
    const [vRes, cRes] = await Promise.all([
      fetch(`${apiBase}/billing/platform/pay-all/${encodeURIComponent(token)}`),
      fetch(`${apiBase}/billing/platform/pay-all/${encodeURIComponent(token)}/public-config`),
    ]);
    const vJson = await vRes.json().catch(() => null);
    const cJson = await cRes.json().catch(() => null);
    if (!vRes.ok) { setLoadError(String(vJson?.error || "This payment link is invalid or has expired.")); return; }
    if (!cRes.ok || !cJson?.ifieldsKey) { setLoadError("Online payment is not available right now. Please contact billing support."); return; }
    setView(vJson as PayAllView);
    setConfig(cJson as PublicConfig);
    if ((vJson as PayAllView).totalDueCents <= 0) setPaid(true);
  }, [token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setSystemTheme(media.matches ? "dark" : "light");
    sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    const root = document.documentElement, body = document.body;
    root.style.overflow = "auto"; root.style.height = "auto"; body.style.overflow = "auto"; body.style.height = "auto";
  }, []);

  async function submitPayment(payload: { cardToken: string; billing: CardknoxBillingFields }) {
    if (!token || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setPayError("");
    try {
      const xExp = billingXExp(payload.billing);
      if (!xExp) { setPayError("Enter a valid expiration month and year."); return; }
      const res = await fetch(`${apiBase}/billing/platform/pay-all/${encodeURIComponent(token)}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          xSut: payload.cardToken, xExp,
          cardholderName: payload.billing.cardholderName,
          billingZip: payload.billing.billingZip,
          billingEmail: payload.billing.billingEmail,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setPayError(String(json?.error || "Payment could not be completed. Please try again or contact support.")); return; }
      const paidCount = Number(json?.paidCount || 0);
      const invoiceCount = Number(json?.invoiceCount || 0);
      if (paidCount >= invoiceCount && invoiceCount > 0) { setPaid(true); await load(); }
      else if (paidCount > 0) { setPayError(`${paidCount} of ${invoiceCount} invoices were paid. Please retry to pay the rest.`); await load(); }
      else { setPayError("Payment could not be completed. Please check your card and try again."); }
    } finally { submitInFlightRef.current = false; }
  }

  const amountDue = dollars(view?.totalDueCents || 0);

  return (
    <main className="billing-pay-page" data-pay-theme={payTheme}>
      <div className="billing-pay-bg" aria-hidden="true" />
      <div className="billing-pay-shell">
        <div className="billing-pay-logo" aria-label="Connect Communications">
          <Image src="/connect-logo.png" alt="Connect Communications" width={150} height={42} priority />
        </div>
        <section className="billing-pay-card" aria-label="Secure payment">
          <header className="billing-pay-header">
            <p className="billing-pay-eyebrow"><Lock size={14} /> Secure payment</p>
            <h1>{view?.companyName || "Payment"}</h1>
            {view ? (<p className="billing-pay-sub">{view.invoiceCount} unpaid invoice{view.invoiceCount === 1 ? "" : "s"}</p>) : null}
          </header>

          {paid ? (
            <section className="billing-pay-success">
              <CheckCircle2 size={26} />
              <div><h2>Payment received</h2><p>Thank you. Your outstanding balance is paid in full.</p>
              <p className="muted">A receipt will be emailed if a billing email is on file.</p></div>
            </section>
          ) : loadError ? (
            <section className="billing-pay-error"><p>{loadError}</p></section>
          ) : !view || !config ? (
            <section className="billing-pay-loading"><span /><p>Loading secure payment…</p></section>
          ) : !view.canPay ? (
            <section className="billing-pay-error"><p>There is no balance due on this account.</p></section>
          ) : (
            <>
              <section className="billing-pay-summary">
                <div className="billing-pay-amount"><span>Total due</span><strong>{amountDue}</strong></div>
                <div className="billing-pay-currency"><span>{view.currency || "USD"}</span><span>{amountDue}</span></div>
              </section>
              <ul style={{ listStyle: "none", padding: 0, margin: "0 0 12px", fontSize: 14, opacity: 0.85 }}>
                {view.invoices.map((inv) => (
                  <li key={inv.invoiceId} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid rgba(128,128,128,0.15)" }}>
                    <span>{inv.invoiceNumber}{inv.dueDate ? ` · Due ${fmtDate(inv.dueDate)}` : ""}</span>
                    <strong>{dollars(inv.balanceDueCents)}</strong>
                  </li>
                ))}
              </ul>
              <CardknoxIFieldsForm
                ifieldsKey={config.ifieldsKey}
                variant="customer"
                fieldTheme={payTheme}
                showBillingAddress
                showEmail
                submitLabel={`Pay ${amountDue}`}
                busyLabel="Processing…"
                errorMessage={payError}
                secureNote={(
                  <div className="billing-pay-secure-note">
                    <ShieldCheck size={20} />
                    <p>Connect Communications never stores your full card number or CVV.</p>
                  </div>
                )}
                onSubmitCardToken={submitPayment}
              />
            </>
          )}
          <PaymentTrustBadge theme={payTheme} />
        </section>
      </div>
    </main>
  );
}
