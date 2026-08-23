"use client";

/* Mockup 1 — This month. The morning screen: is billing on track, and if not, who. */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiPost } from "../../../../../services/apiClient";
import { ConnectSelect } from "../../../../../components/ConnectSelect";
import { BillingNav, Pill, asList, dateTime, errText, invoiceTone, money, shortDate, useApi } from "../_new/ui";
import "../customer/customerBilling.css";

type Overview = {
  mrrCents?: number;
  openCents?: number;
  counts?: Record<string, number>;
  tenantsWithoutCards?: number;
  recentFailures?: Array<{
    id: string;
    invoiceNumber: string;
    status: string;
    balanceDueCents: number;
    failedAt?: string | null;
    dueDate?: string | null;
    tenantId: string;
    tenant?: { name?: string } | null;
  }>;
};

type Run = {
  id: string;
  status: string;
  dryRun?: boolean;
  startedAt?: string;
  finishedAt?: string | null;
  totals?: any;
  errorMessage?: string | null;
};

type TenantRow = {
  id: string;
  name: string;
  balanceDueCents?: number;
  billingSettings?: { billingDayOfMonth?: number; autoBillingEnabled?: boolean } | null;
  paymentMethods?: Array<{ id: string; brand?: string | null; last4?: string | null }>;
};

/** Turn a billing run's stored totals into a sentence.

    ⛔ This used to render `JSON.stringify(r.totals).slice(0, 120)` — five rows
    of raw truncated data, mid-word, at the foot of the main billing screen.
    The sweep runs hourly and almost always has nothing to do, so it was five
    identical lines of gibberish. */
function runOutcome(r: Run): string {
  if (r.errorMessage) return r.errorMessage;
  const t: any = r.totals || {};
  const results: any[] = Array.isArray(t.results) ? t.results : [];
  const n = (v: unknown) => Number(v) || 0;
  const created = n(t.invoicesCreated) || results.filter((x) => x?.invoiceId).length;
  const charged = n(t.charged) || results.filter((x) => x?.transactionId).length;
  const failed = n(t.failed) || results.filter((x) => x?.failed).length;
  const bits = [
    created ? `${created} invoice${created === 1 ? "" : "s"} created` : "",
    charged ? `${charged} card${charged === 1 ? "" : "s"} charged` : "",
    failed ? `${failed} failed` : "",
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : "Nothing was due";
}

/** Next occurrence of a billing day, so "coming up" is real rather than guessed. */
function nextChargeDate(day: number): Date {
  const now = new Date();
  const d = Math.max(1, Math.min(28, Number(day) || 1));
  let y = now.getFullYear();
  let m = now.getMonth();
  if (now.getDate() > d) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return new Date(y, m, d);
}

export default function BillingMonthPage() {
  const router = useRouter();
  const [composer, setComposer] = useState<"invoice" | "charge" | null>(null);
  const overview = useApi<Overview>("/admin/billing/overview");
  const runs = useApi<Run[]>("/admin/billing/runs/recent", (raw) => asList<Run>(raw, "runs"));
  const tenants = useApi<TenantRow[]>("/admin/billing/platform/tenants", (raw) => asList<TenantRow>(raw, "tenants"));

  const o = overview.data;
  const failures = o?.recentFailures || [];

  /** ⛔ `/admin/billing/overview` does not carry the company name on a failure,
      so every one of these rows read "Customer — payment failed" — six
      identical lines telling you everything except who to chase. The name is
      already on the page; the tenant list below has it. */
  const nameOf = useMemo(() => {
    const byId = new Map((tenants.data || []).map((t) => [t.id, t.name]));
    return (f: { tenantId: string; tenant?: { name?: string } | null }) =>
      f.tenant?.name || byId.get(f.tenantId) || "Unknown customer";
  }, [tenants.data]);

  const coming = useMemo(() => {
    const list = (tenants.data || []).filter((t) => t.billingSettings?.autoBillingEnabled);
    const soon = list
      .map((t) => {
        const day = Number(t.billingSettings?.billingDayOfMonth || 1);
        const charge = nextChargeDate(day);
        const invoice = new Date(charge.getTime() - 3 * 86400000);
        return { t, day, charge, invoice, hasCard: (t.paymentMethods || []).length > 0 };
      })
      .sort((a, b) => a.charge.getTime() - b.charge.getTime());
    return soon.slice(0, 12);
  }, [tenants.data]);

  const noCardCount = useMemo(
    () => (tenants.data || []).filter((t) => (t.paymentMethods || []).length === 0).length,
    [tenants.data],
  );

  const willFail = useMemo(
    () => coming.filter((c) => !c.hasCard),
    [coming],
  );

  const needsYou = failures.length + willFail.length;

  return (
    <div className="cbill">
      <BillingNav current="month" needsYouCount={needsYou} />
      <div className="cbill-head">
        <div>
          <h2>This month</h2>
          <div className="cbill-sub">
            <span>{(tenants.data || []).filter((t) => t.billingSettings?.autoBillingEnabled).length} customers being charged</span>
            <span>·</span>
            <span>each on their own day</span>
          </div>
        </div>
        {/* The old "Customers" and "Needs you" buttons sat directly under tabs
            of the same name — the toolbar is for things the tabs cannot do. */}
        <div className="cbill-toolbar">
          <button className="cbill-btn primary" onClick={() => setComposer(composer ? null : "invoice")}>
            New invoice
          </button>
          <button className="cbill-btn" onClick={() => setComposer(composer ? null : "charge")}>
            One-time charge
          </button>
        </div>
      </div>

      {composer && (
        <Composer
          kind={composer}
          tenants={(tenants.data || []).map((t) => ({ id: t.id, name: t.name }))}
          onClose={() => setComposer(null)}
          onCreated={(invoiceId) => {
            setComposer(null);
            if (invoiceId) router.push(`/admin/billing/invoice/${invoiceId}`);
            else void overview.reload();
          }}
        />
      )}

      {overview.error && <div className="cbill-banner bad">{overview.error}</div>}

      <div className="cbill-kpis">
        <div className="cbill-kpi good">
          <span className="k">Collected</span>
          <span className="v">{money(o?.mrrCents)}</span>
          <span className="s">{o?.counts?.paid ?? 0} invoices paid</span>
        </div>
        <div className="cbill-kpi">
          <span className="k">Still owed</span>
          <span className="v">{money(o?.openCents)}</span>
          <span className="s">{(o?.counts?.open ?? 0) + (o?.counts?.overdue ?? 0)} open invoices</span>
        </div>
        <div className={needsYou > 0 ? "cbill-kpi alert" : "cbill-kpi"}>
          <span className="k">Needs you</span>
          <span className="v">{needsYou}</span>
          <span className="s">
            {failures.length} failed · {willFail.length} will fail
          </span>
        </div>
        <div className={noCardCount > 0 ? "cbill-kpi alert" : "cbill-kpi"}>
          <span className="k">No card on file</span>
          <span className="v">{noCardCount}</span>
          <span className="s">cannot be charged at all</span>
        </div>
      </div>

      {failures.length > 0 && (
        <section className="cbill-card">
          <div className="cbill-card-hd">
            <h3>Needs you</h3>
            <Link className="cbill-btn" href="/admin/billing/needs-you">See all</Link>
          </div>
          {failures.slice(0, 6).map((f) => (
            <div className="cbill-att" key={f.id}>
              <div className="cbill-att-i bad">!</div>
              <div className="cbill-att-tx">
                <span className="h">{nameOf(f)}</span>
                <span className="d">
                  Payment failed · {money(f.balanceDueCents)} ·{" "}
                  {f.failedAt ? `failed ${shortDate(f.failedAt)}` : `due ${shortDate(f.dueDate)}`} ·{" "}
                  {f.invoiceNumber}
                </span>
              </div>
              <Pill tone="bad">{invoiceTone(f.status).label}</Pill>
              <Link className="cbill-btn" href={`/admin/billing/invoice/${f.id}`}>Open invoice</Link>
            </div>
          ))}
          {willFail.map((w) => (
            <div className="cbill-att" key={`nocard-${w.t.id}`}>
              <div className="cbill-att-i warn">?</div>
              <div className="cbill-att-tx">
                <span className="h">{w.t.name} — no card on file</span>
                <span className="d">
                  Cannot be charged on {shortDate(w.charge)} · a card is required
                </span>
              </div>
              <Pill tone="bad">Card missing</Pill>
              <Link className="cbill-btn" href={`/admin/billing/customer/${w.t.id}`}>Fix</Link>
            </div>
          ))}
        </section>
      )}

      <section className="cbill-card">
        <div className="cbill-card-hd">
          <h3>Coming up</h3>
          <span className="hint">the invoice is created three days before the charge</span>
        </div>
        <div className="cbill-table-wrap">
          <table className="cbill-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Invoice created</th>
                <th>Card charged</th>
                <th className="r">Card</th>
              </tr>
            </thead>
            <tbody>
              {coming.length === 0 && (
                <tr><td colSpan={4} style={{ color: "var(--cb-muted)" }}>Nothing scheduled.</td></tr>
              )}
              {coming.map((c) => (
                <tr key={c.t.id}>
                  <td><Link href={`/admin/billing/customer/${c.t.id}`}>{c.t.name}</Link></td>
                  <td className="n">{shortDate(c.invoice)}</td>
                  <td className="n">{shortDate(c.charge)}</td>
                  <td className="r">
                    {c.hasCard ? <Pill tone="ok">On file</Pill> : <Pill tone="bad">None</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cbill-card">
        <div className="cbill-card-hd">
          <h3>Recent billing runs</h3>
          <span className="hint">every run is recorded</span>
        </div>
        <div className="cbill-table-wrap">
          <table className="cbill-table">
            <thead>
              <tr><th>Started</th><th>Result</th><th>Outcome</th></tr>
            </thead>
            <tbody>
              {(runs.data || []).length === 0 && (
                <tr><td colSpan={3} style={{ color: "var(--cb-muted)" }}>No runs recorded yet.</td></tr>
              )}
              {(runs.data || []).slice(0, 8).map((r) => (
                <tr key={r.id}>
                  <td className="n">{dateTime(r.startedAt)}</td>
                  <td>
                    {r.status === "COMPLETED" ? (
                      <Pill tone="ok">Completed</Pill>
                    ) : r.status === "FAILED" ? (
                      <Pill tone="bad">Failed</Pill>
                    ) : (
                      <Pill tone="info">Running</Pill>
                    )}
                    {r.dryRun ? " (dry run)" : ""}
                  </td>
                  <td style={{ color: "var(--cb-muted)", fontSize: 12.5 }}>{runOutcome(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/** Build a custom invoice, or put a one-time charge on someone's account.
    A custom invoice is never charged automatically — you collect it yourself. */
function Composer({
  kind,
  tenants,
  onClose,
  onCreated,
}: {
  kind: "invoice" | "charge";
  tenants: Array<{ id: string; name: string }>;
  onClose: () => void;
  onCreated: (invoiceId?: string) => void;
}) {
  const [tenantId, setTenantId] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(
    new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10),
  );
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    const cents = Math.round(Number(String(amount).replace(/[^0-9.]/g, "")) * 100);
    if (!tenantId) { setErr("Pick a customer."); return; }
    if (!description.trim()) { setErr("Say what this is for."); return; }
    if (!Number.isFinite(cents) || cents < 1) { setErr("Enter an amount."); return; }
    setBusy(true); setErr("");
    try {
      if (kind === "charge") {
        await apiPost(`/admin/billing/platform/tenants/${tenantId}/one-time-charges`, {
          description: description.trim(),
          amountCents: cents,
          chargeMode: "none",
          ...(memo.trim() ? { invoiceMemo: memo.trim() } : {}),
        });
        onCreated();
      } else {
        const now = new Date();
        const res: any = await apiPost(`/admin/billing/invoices/manual`, {
          tenantId,
          periodStart: now.toISOString(),
          periodEnd: new Date(now.getTime() + 30 * 86400000).toISOString(),
          dueDate: new Date(`${dueDate}T12:00:00Z`).toISOString(),
          lineItems: [
            {
              type: "CUSTOM",
              description: description.trim(),
              quantity: 1,
              unitPriceCents: cents,
              taxable: false,
            },
          ],
          ...(memo.trim() ? { notes: memo.trim() } : {}),
          status: "OPEN",
        });
        onCreated(res?.id || res?.invoice?.id);
      }
    } catch (e: any) {
      setErr(errText(e, "Could not create that."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cbill-card">
      <div className="cbill-card-hd">
        <h3>{kind === "invoice" ? "New custom invoice" : "One-time charge"}</h3>
        <div className="cbill-toolbar">
          <span className="hint">
            {kind === "invoice"
              ? "Never charged automatically — you collect it yourself"
              : "Added to their account as a charge"}
          </span>
          <button className="cbill-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
      <div className="cbill-card-bd">
        {err && <div className="cbill-banner bad" style={{ margin: "10px 0" }}>{err}</div>}
        <div className="cbill-row">
          <div className="cbill-label"><span className="t">Customer</span></div>
          <ConnectSelect
            style={{ minWidth: 220 }}
            value={tenantId}
            onChange={setTenantId}
            ariaLabel="Customer"
            options={[
              { value: "", label: "Choose a customer…" },
              ...tenants.map((t) => ({ value: t.id, label: t.name })),
            ]}
          />
        </div>
        <div className="cbill-row">
          <div className="cbill-label">
            <span className="t">What is it for</span>
            <span className="h">This is the wording the customer sees</span>
          </div>
          <input className="cbill-input text" value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Replacement handset" aria-label="Description" />
        </div>
        <div className="cbill-row">
          <div className="cbill-label"><span className="t">Amount</span></div>
          <input className="cbill-input" value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00" aria-label="Amount" />
        </div>
        {kind === "invoice" && (
          <div className="cbill-row">
            <div className="cbill-label"><span className="t">Due by</span></div>
            <input className="cbill-input" style={{ width: 150 }} type="date" value={dueDate}
              onChange={(e) => setDueDate(e.target.value)} aria-label="Due date" />
          </div>
        )}
        <div className="cbill-row">
          <div className="cbill-label"><span className="t">Memo</span><span className="h">Optional</span></div>
          <input className="cbill-input text" value={memo} onChange={(e) => setMemo(e.target.value)} aria-label="Memo" />
        </div>
        <div className="cbill-row">
          <div className="cbill-label" />
          <button className="cbill-btn primary" disabled={busy} onClick={() => void submit()}>
            {busy ? "Creating…" : kind === "invoice" ? "Create invoice" : "Add the charge"}
          </button>
        </div>
      </div>
    </section>
  );
}
