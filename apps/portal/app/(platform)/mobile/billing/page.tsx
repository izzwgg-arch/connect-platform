"use client";
/**
 * LoopCom Mobile — Billing. The SEPARATE mobile ledger (LM- series): balance,
 * the live next-invoice estimate ("builds like this"), and the invoice list.
 * Same visual language as the platform's billing, unmistakably its own
 * ledger. Gated by can_view_mobile_billing.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet } from "../../../../services/apiClient";
import { EmptyState, LoadingCard, Note, PageHead, errText, fmtDate, money } from "../MobileUi";

type Billing = {
  balanceCents: number;
  nextInvoice: { totalCents: number; lineCount: number; billsAt: string; items: Array<{ description: string; amountCents: number; kind: string }> };
  invoices: Array<{ id: string; number: string; periodStart: string; periodEnd: string; status: string; totalCents: number; issuedAt: string; paidAt: string | null }>;
  billingEmails: string[];
};

export default function MobileBillingPage() {
  const router = useRouter();
  const [data, setData] = useState<Billing | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<Billing>("/mobile-service/billing"));
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't load mobile billing.") });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const grouped = data ? groupItems(data.nextInvoice.items) : [];

  return (
    <PermissionGate permission="can_view_mobile_billing" fallback={<div className="lmx"><EmptyState title="No access to Mobile Billing" text="Ask your account owner to grant the Billing page in LoopCom Mobile." /></div>}>
      <div className="lmx">
        <PageHead title="Mobile Billing" subtitle="LoopCom Mobile bills separately from your phone-system service — same account, its own LM- invoice series." />
        <Note note={note} />
        {!data ? <><LoadingCard rows={2} /><LoadingCard rows={4} /></> : (
          <>
            <div className="kpis k3">
              <div className="kpi"><span className="lbl">Balance due</span><span className="val">{money(data.balanceCents)}</span><span className={`sub ${data.balanceCents === 0 ? "pos" : "warn"}`}>{data.balanceCents === 0 ? "Paid up — thank you" : "Open mobile invoices below"}</span></div>
              <div className="kpi"><span className="lbl">Next invoice (est.)</span><span className="val">{money(data.nextInvoice.totalCents)}</span><span className="sub">Bills {fmtDate(data.nextInvoice.billsAt)} · {data.nextInvoice.lineCount} line{data.nextInvoice.lineCount === 1 ? "" : "s"}</span></div>
              <div className="kpi"><span className="lbl">Invoice emails</span><span className="val" style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}>{data.billingEmails.length > 0 ? data.billingEmails.join(", ") : "Account billing contacts"}</span><span className="sub"><span className="rowlink" onClick={() => router.push("/mobile/settings")}>manage in Mobile Settings</span></span></div>
            </div>

            <div className="gmain">
              <div className="stack">
                <div className="lcard">
                  <div className="lcard-h"><h3>Invoices</h3><span className="dimtx small">LoopCom Mobile only — phone-system invoices stay under Billing</span></div>
                  {data.invoices.length === 0 ? (
                    <EmptyState title="No Mobile invoices yet" text="Your first LoopCom Mobile invoice is issued at the close of your first billing cycle. Estimates show here meanwhile." />
                  ) : (
                    <div className="twrap">
                      <table className="t">
                        <thead><tr><th>Invoice</th><th>Period</th><th className="num">Amount</th><th>Status</th><th></th></tr></thead>
                        <tbody>
                          {data.invoices.map((inv) => (
                            <tr key={inv.id}>
                              <td><span className="rowlink mono" onClick={() => router.push(`/mobile/billing/${inv.id}`)}>{inv.number}</span></td>
                              <td>{fmtDate(inv.periodStart)} – {fmtDate(new Date(new Date(inv.periodEnd).getTime() - 1))}</td>
                              <td className="num">{money(inv.totalCents)}</td>
                              <td>{inv.status === "paid" ? <span className="pill ok">Paid {inv.paidAt ? fmtDate(inv.paidAt) : ""}</span> : inv.status === "void" ? <span className="pill dim">Void</span> : <span className="pill info">Open</span>}</td>
                              <td><span className="rowlink" onClick={() => router.push(`/mobile/billing/${inv.id}`)}>View</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              <div className="stack">
                <div className="lcard">
                  <div className="lcard-h"><h3>Next invoice builds like this</h3><span className="pill info nub">Live estimate</span></div>
                  {grouped.length === 0 ? <p className="dimtx small">Nothing billable yet this cycle — charges appear as lines activate.</p> : (
                    <div className="twrap">
                      <table className="t"><tbody>
                        {grouped.map((g, i) => (
                          <tr key={i}><td>{g.label} {g.count > 1 ? <span className="sub">{g.count} items</span> : null}</td><td className="num">{money(g.amountCents)}</td></tr>
                        ))}
                        <tr><td><b>Estimated total</b></td><td className="num"><b>{money(data.nextInvoice.totalCents)}</b></td></tr>
                      </tbody></table>
                    </div>
                  )}
                  <p className="help" style={{ marginTop: 8 }}>Estimates recount live until the cycle closes — a paused line keeps its seat; a line added mid-month prorates by day; overage rounds up to the cent at close.</p>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </PermissionGate>
  );
}

function groupItems(items: Array<{ description: string; amountCents: number; kind: string }>): Array<{ label: string; amountCents: number; count: number }> {
  const labels: Record<string, string> = { plan: "Plan charges", activation: "Activation fees", data_overage: "Data overage (est.)" };
  const out = new Map<string, { label: string; amountCents: number; count: number }>();
  for (const it of items) {
    const key = it.kind;
    const slot = out.get(key) ?? { label: labels[key] ?? it.kind, amountCents: 0, count: 0 };
    slot.amountCents += it.amountCents;
    slot.count += 1;
    out.set(key, slot);
  }
  return [...out.values()];
}
