"use client";
/**
 * LoopCom Mobile — Invoice detail. The LM- document: same visual frame as
 * the Voice invoice (wordmark, Loopcom LLC, billed-to grid, uppercase table
 * header, tabular numerals) with the Mobile submark. Every line item names
 * its line. Gated by can_view_mobile_billing.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { apiGet } from "../../../../../services/apiClient";
import { EmptyState, LoadingCard, Note, errText, fmtDate, money } from "../../MobileUi";

type Invoice = {
  invoice: {
    id: string; number: string; periodStart: string; periodEnd: string; status: string;
    totalCents: number; items: Array<{ description: string; quantity: number; unitPriceCents: number; amountCents: number; kind: string; lineId?: string }>;
    note: string | null; issuedAt: string; paidAt: string | null;
  };
  tenantName: string | null;
};

export default function MobileInvoicePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = String(params?.id ?? "");
  const [data, setData] = useState<Invoice | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<Invoice>(`/mobile-service/billing/invoices/${id}`));
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't load this invoice.") });
    }
  }, [id]);
  useEffect(() => { if (id) void load(); }, [id, load]);

  const inv = data?.invoice;

  return (
    <PermissionGate permission="can_view_mobile_billing" fallback={<div className="lmx"><EmptyState title="No access to Mobile Billing" text="Ask your account owner to grant the Billing page in LoopCom Mobile." /></div>}>
      <div className="lmx">
        <div className="lmx-crumb"><span className="link" onClick={() => router.push("/mobile/billing")}>Mobile Billing</span> / <b>{inv?.number ?? "…"}</b></div>
        <div className="lmx-pagehead">
          <div><h2>Invoice {inv?.number ?? ""}</h2>{inv ? <p className="muted">{fmtDate(inv.periodStart)} – {fmtDate(new Date(new Date(inv.periodEnd).getTime() - 1))} · {inv.status === "paid" ? `paid ${inv.paidAt ? fmtDate(inv.paidAt) : ""}` : inv.status}</p> : null}</div>
          <div className="row"><button className="lbtn" onClick={() => window.print()}>Print / save PDF</button></div>
        </div>
        <Note note={note} />
        {!inv ? <LoadingCard rows={6} /> : (
          <div className="lcard" style={{ maxWidth: 840, padding: "28px 30px" }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", paddingBottom: 18, borderBottom: "2px solid var(--border)" }}>
              <div className="row" style={{ gap: 10 }}>
                <span style={{ width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, var(--accent), var(--accent-2))", display: "grid", placeItems: "center", color: "#fff", fontWeight: 800, fontSize: 14 }}>L</span>
                <div><b style={{ fontSize: 17 }}>LoopCom <span style={{ color: "var(--accent)" }}>Mobile</span></b><div className="dimtx small">Loopcom LLC · billing@loopcom.net</div></div>
              </div>
              <div style={{ textAlign: "right", fontSize: 12.5, color: "var(--text-dim)" }}>
                <b style={{ color: "var(--text)", fontSize: 15, display: "block" }}>Invoice {inv.number}</b>
                Service period {fmtDate(inv.periodStart)} – {fmtDate(new Date(new Date(inv.periodEnd).getTime() - 1))}<br />
                Issued {fmtDate(inv.issuedAt)} · {inv.status === "paid" ? <span className="pill ok" style={{ verticalAlign: "1px" }}>Paid</span> : inv.status === "void" ? <span className="pill dim" style={{ verticalAlign: "1px" }}>Void</span> : <span className="pill info" style={{ verticalAlign: "1px" }}>Open</span>}
              </div>
            </div>
            <div className="g2" style={{ padding: "16px 0", fontSize: 13 }}>
              <div><div className="seclbl">Billed to</div>{data?.tenantName ?? "Your company"}</div>
              <div style={{ textAlign: "right" }}><div className="seclbl">Product</div>LoopCom Mobile — separate from phone-system billing</div>
            </div>
            <div className="twrap">
              <table className="t">
                <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Amount</th></tr></thead>
                <tbody>
                  {inv.items.map((it, i) => (
                    <tr key={i}><td>{it.description}</td><td className="num">{it.quantity}</td><td className="num">{money(it.amountCents)}</td></tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan={2} style={{ fontSize: 14 }}>Total <span className="sub">taxes included in your all-in pricing where advertised</span></td><td className="num" style={{ fontSize: 15 }}>{money(inv.totalCents)}</td></tr>
                </tfoot>
              </table>
            </div>
            {inv.note ? <p className="dimtx small" style={{ marginTop: 12 }}>{inv.note}</p> : null}
            <p className="help" style={{ marginTop: 14 }}>Questions about this invoice? Open Mobile Support — every line item names the line it came from.</p>
          </div>
        )}
      </div>
    </PermissionGate>
  );
}
