"use client";
/**
 * LoopCom Mobile — provider console (rebuilt 2026-09-16 to the approved
 * 13-view design). Platform owner only (the SUPER_ADMIN force line in
 * navConfig + requireSuperAdmin on every /admin/mobile-service route).
 *
 * ONE sidebar item, 13 views inside it (the PBX-Console pattern):
 * Overview · Subscribers · Lines · Plans · Inventory · Porting ·
 * Usage Analytics · Invoicing · Carrier Status · Diagnostics · Webhooks ·
 * Compliance · Settings & Controls.
 *
 * This is the ONLY surface that can spend money: "Provision eSIM" purchases
 * an eSIM on the platform's Telnyx account and says so before it does it
 * (PURCHASES 1 eSIM — cannot be un-bought). Purchases are never retried — a
 * timeout says "run reconcile, don't re-click". Invoice generation writes
 * the separate LM- ledger only and is idempotent per tenant+period.
 */
import { useCallback, useEffect, useState } from "react";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { PageHeader } from "../../../../components/PageHeader";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiGet, apiPatch, apiPost, apiPut } from "../../../../services/apiClient";
import "../../mobile/mobile.css";

type Note = { kind: "ok" | "bad"; text: string } | null;
type Capability = { key: string; label: string; available: boolean; state: string; detail: string };
type StatusResp = {
  report: { checkedAt: string; configured: boolean; capabilities: Capability[] };
  counts: { lines: number; sims: number; plans: number; pendingWebhookEvents: number };
};
type Plan = {
  id: string; name: string; description: string | null; active: boolean; monthlyPriceCents: number;
  activationFeeCents: number; simFeeCents: number; esimFeeCents: number; includedDataMb: number | null;
  includedVoiceMinutes: number | null; includedSms: number | null; dataOverageBehavior: string;
  dataOverageCentsPerGb: number; roamingEnabled: boolean; telnyxCostCentsEstimate: number; sortOrder: number;
};
type Line = {
  id: string; tenantId: string; tenantName: string | null; label: string; status: string;
  phoneNumber: string | null;
  plan: { id: string; name: string } | null;
  sim: { id: string; type: string; status: string | null; iccid: string | null; esimInstallationStatus: string | null; hasActivationCode: boolean } | null;
  needsReconcile: boolean; reconcileReason: string | null;
};
type Overview = {
  subscribers: number;
  counts: { total: number; active: number; pending: number; suspended: number; draft: number; terminated: number; needsReconcile: number };
  simMix: { esim: number; physical: number };
  portsOpen: number; fleetDataMbMtd: number;
  money: { revenueCents: number; costCents: number; planCostCents: number; meteredCostCents: number; marginPct: number | null };
  balance: { balanceCents: number | null; currency: string | null } | null;
  platform: { balanceFloorCents: number };
  actionItems: Array<{ severity: string; title: string; detail: string; go: string }>;
};

function errText(e: any, fallback: string): string {
  return e?.body?.message || e?.body?.error || e?.message || fallback;
}
function money(cents: number | null | undefined): string {
  return `$${(Number(cents ?? 0) / 100).toFixed(2)}`;
}
function gb(mb: number | null | undefined): string {
  if (mb == null) return "—";
  const n = Number(mb);
  return n >= 1024 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)} GB` : `${Math.round(n)} MB`;
}
function when(d: string | Date | null | undefined): string {
  return d ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
}
function day(d: string | Date | null | undefined): string {
  return d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
}

const VIEWS = [
  ["overview", "Overview"], ["subscribers", "Subscribers"], ["lines", "Lines"], ["plans", "Plans"],
  ["inventory", "Inventory"], ["porting", "Porting"], ["usage", "Usage Analytics"], ["invoicing", "Invoicing"],
  ["carrier", "Carrier Status"], ["diagnostics", "Diagnostics"], ["webhooks", "Webhooks"],
  ["compliance", "Compliance"], ["settings", "Settings & Controls"],
] as const;
type ViewKey = (typeof VIEWS)[number][0];

const LINE_PILL: Record<string, string> = { active: "ok", pending_activation: "info", suspended: "bad", lost: "bad", draft: "dim", terminated: "dim" };
const PORT_PILL: Record<string, string> = { draft: "dim", submitted: "info", pending: "info", foc: "ok", action_required: "warn", completed: "ok", rejected: "bad", cancelled: "dim" };

export default function MobileConsolePage() {
  const { role } = useAppContext();
  const isOwner = role === "SUPER_ADMIN";
  const [view, setView] = useState<ViewKey>("overview");
  const [note, setNote] = useState<Note>(null);
  const ok = (text: string) => setNote({ kind: "ok", text });
  const bad = (e: any, fallback: string) => setNote({ kind: "bad", text: errText(e, fallback) });

  if (!isOwner) {
    return (
      <div className="lmx">
        <PageHeader title="Mobile Console" subtitle="This page is for the platform owner." />
      </div>
    );
  }

  return (
    <div className="lmx">
      <PageHeader title="Mobile Console" subtitle="LoopCom Mobile on Telnyx wireless — fleet, money, carrier health" />
      <div className="chips" style={{ marginTop: 12 }}>
        {VIEWS.map(([key, label]) => (
          <button key={key} className={`chip ${view === key ? "on" : ""}`} onClick={() => { setView(key); setNote(null); }}>{label}</button>
        ))}
      </div>
      {note ? <div className={`note ${note.kind}`}>{note.text}</div> : null}
      {view === "overview" ? <OverviewView go={setView} bad={bad} /> : null}
      {view === "subscribers" ? <SubscribersView bad={bad} /> : null}
      {view === "lines" ? <LinesView ok={ok} bad={bad} /> : null}
      {view === "plans" ? <PlansView ok={ok} bad={bad} /> : null}
      {view === "inventory" ? <InventoryView bad={bad} /> : null}
      {view === "porting" ? <PortingView ok={ok} bad={bad} /> : null}
      {view === "usage" ? <UsageView bad={bad} /> : null}
      {view === "invoicing" ? <InvoicingView ok={ok} bad={bad} /> : null}
      {view === "carrier" ? <CarrierView ok={ok} bad={bad} /> : null}
      {view === "diagnostics" ? <DiagnosticsView ok={ok} bad={bad} /> : null}
      {view === "webhooks" ? <WebhooksView bad={bad} /> : null}
      {view === "compliance" ? <ComplianceView bad={bad} /> : null}
      {view === "settings" ? <SettingsView ok={ok} bad={bad} /> : null}
    </div>
  );
}

/* ═══════════════ Overview ═══════════════ */
function OverviewView({ go, bad }: { go: (v: ViewKey) => void; bad: (e: any, f: string) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  useEffect(() => {
    apiGet<Overview>("/admin/mobile-service/overview").then(setData).catch((e) => bad(e, "Couldn't load the overview."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!data) return <div className="lcard"><div className="skel" style={{ height: 90 }} /></div>;
  const m = data.money;
  const lowBalance = data.balance?.balanceCents != null && data.balance.balanceCents < data.platform.balanceFloorCents;
  return (
    <>
      {lowBalance ? (
        <div className="banner bad" style={{ marginBottom: 14 }}>
          <div><b>Telnyx balance {money(data.balance!.balanceCents)} is below the {money(data.platform.balanceFloorCents)} floor.</b>
            <div className="sub">eSIM purchases will start failing — top up in the Telnyx portal or enable auto-recharge.</div></div>
          <button className="lbtn sm" style={{ marginLeft: "auto" }} onClick={() => go("carrier")}>Carrier Status</button>
        </div>
      ) : null}
      <div className="kpis k5">
        <div className="kpi"><span className="lbl">Subscribers</span><span className="val">{data.subscribers}</span></div>
        <div className="kpi"><span className="lbl">Lines</span><span className="val">{data.counts.total}</span><span className="sub">{data.counts.active} active · {data.counts.pending} pending · {data.counts.suspended} susp.</span></div>
        <div className="kpi"><span className="lbl">SIM mix</span><span className="val">{data.simMix.esim} <small>eSIM</small></span><span className="sub">{data.simMix.physical} physical</span></div>
        <div className="kpi"><span className="lbl">Open ports</span><span className="val">{data.portsOpen}</span></div>
        <div className="kpi"><span className="lbl">Fleet data MTD</span><span className="val">{gb(data.fleetDataMbMtd)}</span></div>
      </div>
      <div className="kpis k3">
        <div className="kpi"><span className="lbl">MTD est. revenue</span><span className="val">{money(m.revenueCents)}</span><span className="sub">plans + fees + overage (recount)</span></div>
        <div className="kpi"><span className="lbl">MTD est. Telnyx cost</span><span className="val">{money(m.costCents)}</span><span className="sub">{money(m.planCostCents)} plan est. + {money(m.meteredCostCents)} metered</span></div>
        <div className="kpi"><span className="lbl">Gross margin</span><span className="val">{m.marginPct != null ? `${m.marginPct}%` : "—"}</span><span className={`sub ${m.marginPct != null && m.marginPct >= 55 ? "pos" : m.marginPct != null ? "warn" : ""}`}>{m.marginPct != null ? money(m.revenueCents - m.costCents) : "no billable lines yet"}</span></div>
      </div>
      <div className="lcard">
        <div className="lcard-h"><h3>Action required</h3>{data.actionItems.length ? <span className="pill warn nub">{data.actionItems.length} item{data.actionItems.length === 1 ? "" : "s"}</span> : <span className="pill ok nub">All clear</span>}</div>
        {data.actionItems.length === 0 ? <p className="dimtx small">Nothing needs you. Provisioning, webhooks, ports and balance are all healthy.</p> : (
          <div className="alist">
            {data.actionItems.map((a, i) => (
              <div key={i} className="aitem">
                <span className="sev" style={{ background: a.severity === "danger" ? "var(--danger)" : "var(--warning)" }} />
                <div><b>{a.title}</b><span className="sub">{a.detail}</span></div>
                <button className="lbtn sm" onClick={() => go(a.go as ViewKey)}>Open</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/* ═══════════════ Subscribers / accounts ═══════════════ */
function SubscribersView({ bad }: { bad: (e: any, f: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    apiGet<{ tenants: any[] }>("/admin/mobile-service/tenants").then((o) => setRows(o.tenants ?? [])).catch((e) => { bad(e, "Couldn't load accounts."); setRows([]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!rows) return <div className="lcard"><div className="skel" style={{ height: 120 }} /></div>;
  return (
    <div className="lcard" style={{ padding: 0, overflow: "hidden" }}>
      <div className="twrap" style={{ border: 0 }}>
        <table className="t">
          <thead><tr><th>Tenant</th><th className="num">Subs</th><th className="num">Lines</th><th className="num">Active</th><th className="num">Bill (MTD est.)</th><th className="num">Cost est.</th><th className="num">Margin</th><th className="num">Data MTD</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={8} className="dimtx">No tenants have mobile lines yet.</td></tr> : rows.map((t) => (
              <tr key={t.tenantId}>
                <td><b>{t.name}</b></td>
                <td className="num">{t.subscribers}</td>
                <td className="num">{t.lines}</td>
                <td className="num">{t.active}</td>
                <td className="num">{money(t.billCents)}</td>
                <td className="num">{money(t.costCents)}</td>
                <td className="num" style={{ color: t.marginPct == null ? undefined : t.marginPct >= 55 ? "var(--success)" : "var(--warning)" }}>{t.marginPct != null ? `${t.marginPct}%` : "—"}</td>
                <td className="num">{gb(t.dataMbMtd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ═══════════════ Lines (fleet) ═══════════════ */
function LinesView({ ok, bad }: { ok: (t: string) => void; bad: (e: any, f: string) => void }) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [lineTenantId, setLineTenantId] = useState("");
  const [lineLabel, setLineLabel] = useState("");
  const [linePlanId, setLinePlanId] = useState("");

  const load = useCallback(async (search?: string) => {
    try { setLines((await apiGet<{ lines: Line[] }>(`/admin/mobile-service/lines${search ? `?q=${encodeURIComponent(search)}` : ""}`)).lines ?? []); }
    catch (e: any) { bad(e, "Couldn't load lines."); setLines([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void load();
    apiGet<{ plans: Plan[] }>("/admin/mobile-service/plans").then((o) => setPlans(o.plans ?? [])).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const provisionEsim = async (line: Line) => {
    if (!window.confirm(
      `PROVISION eSIM for "${line.label}" (${line.tenantName ?? line.tenantId})?\n\nThis PURCHASES 1 eSIM on the platform's Telnyx account (Telnyx bills per eSIM + a monthly SIM fee) and brands it "LoopCom". It cannot be un-bought.\n\nProceed?`,
    )) return;
    setBusy(line.id);
    try {
      await apiPost(`/admin/mobile-service/lines/${line.id}/provision-esim`, { confirm: true });
      ok("eSIM purchased and attached. The customer's Devices page now has the install QR, and they were emailed the install link.");
      await load(q);
    } catch (e: any) {
      if (e?.body?.error === "unknown_outcome") bad(e, "Outcome unknown — run Reconcile before trying again. Do not re-click.");
      else bad(e, "Provisioning failed.");
    } finally { setBusy(null); }
  };

  const lineAction = async (line: Line, action: "suspend" | "resume" | "terminate") => {
    if (action === "terminate" && !window.confirm(`Terminate "${line.label}"? Service ends; the SIM is disabled (not deleted).`)) return;
    setBusy(line.id);
    try {
      if (action === "suspend") await apiPost(`/admin/mobile-service/lines/${line.id}/suspend`, { reason: "Suspended from the Mobile Console" });
      else if (action === "resume") await apiPost(`/admin/mobile-service/lines/${line.id}/resume`, {});
      else await apiPost(`/admin/mobile-service/lines/${line.id}/terminate`, { confirm: true, reason: "Terminated from the Mobile Console" });
      ok("Done. The customer was notified by email.");
      await load(q);
    } catch (e: any) { bad(e, "Action failed."); } finally { setBusy(null); }
  };

  const changePlan = async (line: Line, planId: string) => {
    if (!planId || planId === line.plan?.id) return;
    setBusy(line.id);
    try {
      await apiPost(`/admin/mobile-service/lines/${line.id}/change-plan`, { planId });
      ok("Plan changed — the invoice prorates by day, and the customer was emailed.");
      await load(q);
    } catch (e: any) { bad(e, "Couldn't change the plan."); } finally { setBusy(null); }
  };

  const createLine = async () => {
    if (!lineTenantId.trim() || !lineLabel.trim()) return bad(null, "Enter the tenant id and a line label.");
    try {
      await apiPost("/admin/mobile-service/lines", { tenantId: lineTenantId.trim(), label: lineLabel.trim(), planId: linePlanId || null });
      setLineLabel("");
      ok("Line created (draft, free). Provision an eSIM to move it forward.");
      await load(q);
    } catch (e: any) { bad(e, "Couldn't create the line."); }
  };

  return (
    <>
      <div className="lcard">
        <div className="lcard-h">
          <h3>Fleet — every line, every tenant</h3>
          <span className="row">
            <input className="linput" style={{ minWidth: 220, height: 32 }} placeholder="Number / ICCID / customer…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void load(q); }} />
            <button className="lbtn sm" onClick={() => void load(q)}>Search</button>
          </span>
        </div>
        {!lines ? <div className="skel" style={{ height: 120 }} /> : (
          <div className="twrap">
            <table className="t">
              <thead><tr><th>Tenant</th><th>Line</th><th>Status</th><th>SIM / carrier state</th><th>Plan</th><th>Actions</th></tr></thead>
              <tbody>
                {lines.length === 0 ? <tr><td colSpan={6} className="dimtx">No lines yet — create the first one below (free).</td></tr> : lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.tenantName ?? l.tenantId}</td>
                    <td><b className="mono">{l.phoneNumber ?? l.label}</b><span className="sub">{l.phoneNumber ? l.label : "no number yet"}</span></td>
                    <td><span className={`pill ${LINE_PILL[l.status] ?? "dim"}`}>{l.status.replace(/_/g, " ")}</span>{l.needsReconcile ? <span className="sub" style={{ color: "var(--danger)" }}>{l.reconcileReason ?? "needs reconcile"}</span> : null}</td>
                    <td className="dimtx">{l.sim ? `${l.sim.type} · ${l.sim.status ?? "?"}${l.sim.esimInstallationStatus ? ` · ${l.sim.esimInstallationStatus}` : ""}` : "none"}</td>
                    <td style={{ minWidth: 150 }}>
                      <ConnectSelect size="sm" ariaLabel={`Plan for ${l.label}`} value={l.plan?.id ?? ""} onChange={(v: string) => void changePlan(l, v)}
                        options={[{ value: "", label: "No plan" }, ...plans.filter((p) => p.active || p.id === l.plan?.id).map((p) => ({ value: p.id, label: p.name }))]} />
                    </td>
                    <td>
                      <span className="row" style={{ gap: 5 }}>
                        {!l.sim && l.status !== "terminated" ? <button className="lbtn sm primary" disabled={busy === l.id} onClick={() => void provisionEsim(l)}>Provision eSIM ($)</button> : null}
                        {l.status === "active" ? <button className="lbtn sm" disabled={busy === l.id} onClick={() => void lineAction(l, "suspend")}>Suspend</button> : null}
                        {l.status === "suspended" || l.status === "lost" ? <button className="lbtn sm" disabled={busy === l.id} onClick={() => void lineAction(l, "resume")}>Resume</button> : null}
                        {l.status !== "terminated" ? <button className="lbtn sm danger" disabled={busy === l.id} onClick={() => void lineAction(l, "terminate")}>Terminate</button> : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <input className="linput" style={{ minWidth: 200 }} placeholder="Tenant id (Admin → Tenants)" value={lineTenantId} onChange={(e) => setLineTenantId(e.target.value)} />
          <input className="linput" style={{ minWidth: 180 }} placeholder="Line label (e.g. Moshe's phone)" value={lineLabel} onChange={(e) => setLineLabel(e.target.value)} />
          <ConnectSelect ariaLabel="Plan for the new line" value={linePlanId} onChange={(v: string) => setLinePlanId(v)}
            options={[{ value: "", label: "No plan yet" }, ...plans.filter((p) => p.active).map((p) => ({ value: p.id, label: p.name }))]} />
          <button className="lbtn primary" onClick={() => void createLine()}>Create line (free)</button>
        </div>
      </div>
    </>
  );
}

/* ═══════════════ Plans ═══════════════ */
function PlansView({ ok, bad }: { ok: (t: string) => void; bad: (e: any, f: string) => void }) {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [edit, setEdit] = useState<Partial<Plan> & { isNew?: boolean } | null>(null);
  const load = useCallback(async () => {
    try { setPlans((await apiGet<{ plans: Plan[] }>("/admin/mobile-service/plans")).plans ?? []); }
    catch (e: any) { bad(e, "Couldn't load plans."); setPlans([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!edit) return;
    const body: any = {
      name: edit.name, description: edit.description ?? null, active: edit.active ?? true,
      monthlyPriceCents: edit.monthlyPriceCents ?? 0, activationFeeCents: edit.activationFeeCents ?? 0,
      simFeeCents: edit.simFeeCents ?? 0, esimFeeCents: edit.esimFeeCents ?? 0,
      includedDataMb: edit.includedDataMb ?? null, includedVoiceMinutes: edit.includedVoiceMinutes ?? null,
      includedSms: edit.includedSms ?? null, dataOverageBehavior: edit.dataOverageBehavior ?? "block",
      dataOverageCentsPerGb: edit.dataOverageCentsPerGb ?? 0, roamingEnabled: edit.roamingEnabled ?? false,
      telnyxCostCentsEstimate: edit.telnyxCostCentsEstimate ?? 0, sortOrder: edit.sortOrder ?? 0,
    };
    if (!body.name || !String(body.name).trim()) return bad(null, "The plan needs a name.");
    try {
      if (edit.isNew) await apiPost("/admin/mobile-service/plans", body);
      else await apiPatch(`/admin/mobile-service/plans/${edit.id}`, body);
      ok(edit.isNew ? "Plan created." : "Plan saved.");
      setEdit(null);
      await load();
    } catch (e: any) { bad(e, "Couldn't save the plan."); }
  };

  const cents = (v: string) => { const n = Math.round(parseFloat(v || "0") * 100); return Number.isFinite(n) && n >= 0 ? n : 0; };
  const dollars = (c: number | null | undefined) => c != null ? (c / 100).toFixed(2) : "";

  return (
    <>
      <div className="lcard">
        <div className="lcard-h"><h3>Plans — retail, wholesale cost & margin</h3><button className="lbtn primary sm" onClick={() => setEdit({ isNew: true, active: true, dataOverageBehavior: "block" })}>New plan</button></div>
        {!plans ? <div className="skel" style={{ height: 120 }} /> : (
          <div className="twrap">
            <table className="t">
              <thead><tr><th>Plan</th><th className="num">Retail</th><th className="num">Telnyx cost est.</th><th className="num">Margin</th><th className="num">Activation</th><th>Overage</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {plans.length === 0 ? <tr><td colSpan={8} className="dimtx">No plans yet — create the first one.</td></tr> : plans.map((p) => {
                  const marginPct = p.monthlyPriceCents > 0 ? Math.round(((p.monthlyPriceCents - p.telnyxCostCentsEstimate) / p.monthlyPriceCents) * 1000) / 10 : null;
                  return (
                    <tr key={p.id}>
                      <td><b>{p.name}</b><span className="sub">{p.includedDataMb != null ? `${gb(p.includedDataMb)} data` : "no data"}{p.roamingEnabled ? " · roaming" : ""}</span></td>
                      <td className="num">{money(p.monthlyPriceCents)}</td>
                      <td className="num">{money(p.telnyxCostCentsEstimate)}</td>
                      <td className="num" style={{ color: marginPct != null && marginPct >= 55 ? "var(--success)" : "var(--warning)" }}>{marginPct != null ? `${marginPct}%` : "—"}</td>
                      <td className="num">{money(p.activationFeeCents)}</td>
                      <td>{p.dataOverageBehavior === "charge" ? `${money(p.dataOverageCentsPerGb)}/GB` : "slows at limit"}</td>
                      <td>{p.active ? <span className="pill ok">Active</span> : <span className="pill dim">Retired</span>}</td>
                      <td><button className="lbtn sm" onClick={() => setEdit({ ...p })}>Edit</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="help" style={{ marginTop: 8 }}>Retail prices are all-inclusive (taxes inside, the platform rule). Customers never see the cost or margin columns. Retiring a plan never touches existing lines — it only stops new ones.</p>
      </div>

      {edit ? (
        <div className="lcard">
          <div className="lcard-h"><h3>{edit.isNew ? "New plan" : `Edit — ${edit.name}`}</h3><button className="lbtn sm" onClick={() => setEdit(null)}>Close</button></div>
          <div className="form">
            <div className="field"><label>Name</label><input className="linput" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="field"><label>Retail price / line / month ($)</label><input className="linput" defaultValue={dollars(edit.monthlyPriceCents)} onBlur={(e) => setEdit({ ...edit, monthlyPriceCents: cents(e.target.value) })} /></div>
            <div className="field"><label>Included data (GB, blank = none)</label><input className="linput" defaultValue={edit.includedDataMb != null ? String(edit.includedDataMb / 1024) : ""} onBlur={(e) => { const v = e.target.value.trim(); setEdit({ ...edit, includedDataMb: v === "" ? null : Math.round(parseFloat(v) * 1024) || 0 }); }} /></div>
            <div className="field"><label>Data overage</label>
              <ConnectSelect ariaLabel="Overage behavior" value={edit.dataOverageBehavior ?? "block"} onChange={(v: string) => setEdit({ ...edit, dataOverageBehavior: v })}
                options={[{ value: "block", label: "Slow / stop at the limit (no charge)" }, { value: "charge", label: "Bill per GB over" }]} />
            </div>
            {edit.dataOverageBehavior === "charge" ? <div className="field"><label>Overage per GB ($, rounds up to the cent)</label><input className="linput" defaultValue={dollars(edit.dataOverageCentsPerGb)} onBlur={(e) => setEdit({ ...edit, dataOverageCentsPerGb: cents(e.target.value) })} /></div> : null}
            <div className="field"><label>Activation fee ($)</label><input className="linput" defaultValue={dollars(edit.activationFeeCents)} onBlur={(e) => setEdit({ ...edit, activationFeeCents: cents(e.target.value) })} /></div>
            <div className="field"><label>Physical SIM fee ($)</label><input className="linput" defaultValue={dollars(edit.simFeeCents)} onBlur={(e) => setEdit({ ...edit, simFeeCents: cents(e.target.value) })} /></div>
            <div className="field"><label>Telnyx cost estimate ($ — margin column only, never shown to customers)</label><input className="linput" defaultValue={dollars(edit.telnyxCostCentsEstimate)} onBlur={(e) => setEdit({ ...edit, telnyxCostCentsEstimate: cents(e.target.value) })} /></div>
            <div className="field"><label>Roaming</label>
              <ConnectSelect ariaLabel="Roaming" value={edit.roamingEnabled ? "yes" : "no"} onChange={(v: string) => setEdit({ ...edit, roamingEnabled: v === "yes" })}
                options={[{ value: "no", label: "Not included" }, { value: "yes", label: "Included" }]} />
            </div>
            <div className="field"><label>Availability</label>
              <ConnectSelect ariaLabel="Availability" value={edit.active === false ? "retired" : "active"} onChange={(v: string) => setEdit({ ...edit, active: v === "active" })}
                options={[{ value: "active", label: "Active — new lines may choose it" }, { value: "retired", label: "Retired — existing lines keep it" }]} />
            </div>
            <div className="field full"><label>Description (customers see this)</label><input className="linput" value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
          </div>
          <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
            <button className="lbtn ghost" onClick={() => setEdit(null)}>Cancel</button>
            <button className="lbtn primary" onClick={() => void save()}>{edit.isNew ? "Create plan" : "Save plan"}</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ═══════════════ Inventory ═══════════════ */
function InventoryView({ bad }: { bad: (e: any, f: string) => void }) {
  const [data, setData] = useState<any | null>(null);
  useEffect(() => {
    apiGet<any>("/admin/mobile-service/inventory").then(setData).catch((e) => bad(e, "Couldn't load inventory."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!data) return <div className="lcard"><div className="skel" style={{ height: 120 }} /></div>;
  return (
    <>
      <div className="kpis">
        <div className="kpi"><span className="lbl">Physical SIMs in stock</span><span className="val">{data.physical.inStock}</span><span className={`sub ${data.physical.inStock < data.physical.reorderFloor ? "warn" : ""}`}>{data.physical.inStock < data.physical.reorderFloor ? `Below the ${data.physical.reorderFloor} floor — reorder` : `Floor ${data.physical.reorderFloor}`}</span></div>
        <div className="kpi"><span className="lbl">Physical assigned</span><span className="val">{data.physical.assigned}</span></div>
        <div className="kpi"><span className="lbl">eSIMs issued</span><span className="val">{data.esim.issued}</span><span className="sub">{data.esim.installed} installed · {data.esim.pending} pending install</span></div>
        <div className="kpi"><span className="lbl">Stale eSIMs</span><span className="val">{data.staleEsims.length}</span><span className="sub">issued, never installed</span></div>
      </div>
      <div className="g2">
        <div className="lcard">
          <div className="lcard-h"><h3>Stale eSIMs — issued, never installed</h3></div>
          {data.staleEsims.length === 0 ? <p className="dimtx small">None — every issued eSIM found a phone.</p> : (
            <div className="twrap"><table className="t">
              <thead><tr><th>Line</th><th>Tenant</th><th>Issued</th><th className="num">Age</th></tr></thead>
              <tbody>{data.staleEsims.map((s: any) => (
                <tr key={s.simId}><td className="mono">{s.line?.phoneNumber ?? s.line?.label ?? "—"}</td><td>{s.line?.tenantName ?? "—"}</td><td>{day(s.issuedAt)}</td><td className="num">{s.ageDays} d</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
        <div className="lcard">
          <div className="lcard-h"><h3>SIM orders</h3></div>
          {data.orders.length === 0 ? <p className="dimtx small">No physical-SIM orders yet. Ordering goes through the carrier's free cost preview first — the confirm states the real charge before anything is placed.</p> : (
            <div className="twrap"><table className="t">
              <thead><tr><th>Order</th><th className="num">Qty</th><th className="num">Cost</th><th>Status</th><th>Placed</th></tr></thead>
              <tbody>{data.orders.map((o: any) => (
                <tr key={o.id}><td className="mono">{o.telnyxOrderId?.slice(0, 12) ?? o.id.slice(0, 8)}…</td><td className="num">{o.quantity}</td><td className="num">{o.costAmount ? `${o.costAmount} ${o.costCurrency ?? ""}` : "—"}</td><td>{o.status ?? "—"}</td><td>{day(o.createdAt)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </div>
    </>
  );
}

/* ═══════════════ Porting ═══════════════ */
function PortingView({ ok, bad }: { ok: (t: string) => void; bad: (e: any, f: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [sel, setSel] = useState<any | null>(null);
  const [patch, setPatch] = useState<{ status: string; carrier: string; focDate: string; note: string; telnyxPortingOrderId: string }>({ status: "", carrier: "", focDate: "", note: "", telnyxPortingOrderId: "" });
  const load = useCallback(async () => {
    try {
      const out = await apiGet<{ portRequests: any[] }>("/admin/mobile-service/port-requests");
      setRows(out.portRequests ?? []);
    } catch (e: any) { bad(e, "Couldn't load port requests."); setRows([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void load(); }, [load]);

  const open = (r: any) => {
    setSel(r);
    setPatch({ status: r.status, carrier: r.carrier ?? "", focDate: r.focDate ? String(r.focDate).slice(0, 10) : "", note: "", telnyxPortingOrderId: r.telnyxPortingOrderId ?? "" });
  };
  const save = async () => {
    if (!sel) return;
    try {
      const body: any = {};
      if (patch.status && patch.status !== sel.status) body.status = patch.status;
      if (patch.carrier !== (sel.carrier ?? "")) body.carrier = patch.carrier || null;
      if (patch.telnyxPortingOrderId !== (sel.telnyxPortingOrderId ?? "")) body.telnyxPortingOrderId = patch.telnyxPortingOrderId || null;
      if (patch.focDate) body.focDate = new Date(`${patch.focDate}T12:00:00Z`).toISOString(); else if (sel.focDate) body.focDate = null;
      if (patch.note.trim()) body.note = patch.note.trim();
      await apiPatch(`/admin/mobile-service/port-requests/${sel.id}`, body);
      ok(body.status ? "Saved — the customer was emailed the status change." : "Saved.");
      setSel(null);
      await load();
    } catch (e: any) { bad(e, "Couldn't save."); }
  };

  if (!rows) return <div className="lcard"><div className="skel" style={{ height: 120 }} /></div>;
  return (
    <div className="gmain">
      <div className="lcard" style={{ padding: 0, overflow: "hidden" }}>
        <div className="twrap" style={{ border: 0 }}>
          <table className="t">
            <thead><tr><th>Number</th><th>Tenant</th><th>Status</th><th>FOC</th><th>PIN</th><th></th></tr></thead>
            <tbody>
              {rows.length === 0 ? <tr><td colSpan={6} className="dimtx">No port requests yet.</td></tr> : rows.map((r) => (
                <tr key={r.id} style={sel?.id === r.id ? { background: "color-mix(in srgb, var(--accent) 7%, transparent)" } : undefined}>
                  <td className="mono">{r.phoneNumber}</td>
                  <td>{r.tenant?.name ?? r.tenant?.id}</td>
                  <td><span className={`pill ${PORT_PILL[r.status] ?? "dim"}`}>{r.status.replace(/_/g, " ")}</span></td>
                  <td>{r.focDate ? day(r.focDate) : "—"}</td>
                  <td>{r.pinOnFile ? <span className="pill ok nub">on file</span> : <span className="pill warn nub">missing</span>}</td>
                  <td><button className="lbtn sm" onClick={() => open(r)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {sel ? (
        <div className="lcard">
          <div className="lcard-h"><h3>{sel.phoneNumber} · {sel.tenant?.name}</h3><button className="lbtn sm" onClick={() => setSel(null)}>Close</button></div>
          <dl className="dl" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div><dt>Holder</dt><dd>{sel.holderName ?? "—"}</dd></div>
            <div><dt>Account #</dt><dd className="mono">{sel.accountNumberLast4 ? `…${sel.accountNumberLast4}` : "—"}</dd></div>
            <div><dt>Created</dt><dd>{day(sel.createdAt)}</dd></div>
            <div><dt>Carrier order</dt><dd className="mono">{sel.telnyxPortingOrderId ?? "not filed"}</dd></div>
          </dl>
          <div className="form" style={{ marginTop: 12 }}>
            <div className="field"><label>Status (mirrors what you did at the carrier)</label>
              <ConnectSelect ariaLabel="Port status" value={patch.status} onChange={(v: string) => setPatch({ ...patch, status: v })}
                options={["draft", "submitted", "pending", "foc", "action_required", "completed", "rejected", "cancelled"].map((s) => ({ value: s, label: s.replace(/_/g, " ") }))} />
            </div>
            <div className="field"><label>Losing carrier</label><input className="linput" value={patch.carrier} onChange={(e) => setPatch({ ...patch, carrier: e.target.value })} /></div>
            <div className="field"><label>FOC date</label><input className="linput" type="date" value={patch.focDate} onChange={(e) => setPatch({ ...patch, focDate: e.target.value })} /></div>
            <div className="field"><label>Carrier order id</label><input className="linput mono" value={patch.telnyxPortingOrderId} onChange={(e) => setPatch({ ...patch, telnyxPortingOrderId: e.target.value })} /></div>
            <div className="field full"><label>Internal note</label><input className="linput" value={patch.note} onChange={(e) => setPatch({ ...patch, note: e.target.value })} placeholder="e.g. refiled with corrected holder name" /></div>
          </div>
          {Array.isArray(sel.notes) && sel.notes.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="seclbl">Notes</div>
              <div className="tl">{sel.notes.slice().reverse().map((n: any, i: number) => (
                <div key={i} className="tlrow"><span className="ti">•</span><div><b>{n.text}</b><span className="sub">{n.by}</span></div><time>{when(n.at)}</time></div>
              ))}</div>
            </div>
          ) : null}
          <div className="banner info" style={{ marginTop: 12 }}><div>⛔ Nothing here files with the carrier — filing/refiling is your act at Telnyx; this screen records it and <b>emails the customer on every status change</b>.</div></div>
          <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}><button className="lbtn primary" onClick={() => void save()}>Save</button></div>
        </div>
      ) : (
        <div className="lcard"><p className="dimtx small">Open a request to update its status, FOC date, carrier ids and internal notes. Status changes email the customer automatically.</p></div>
      )}
    </div>
  );
}

/* ═══════════════ Usage Analytics ═══════════════ */
function UsageView({ bad }: { bad: (e: any, f: string) => void }) {
  const [data, setData] = useState<any | null>(null);
  useEffect(() => {
    apiGet<any>("/admin/mobile-service/usage-analytics").then(setData).catch((e) => bad(e, "Couldn't load usage analytics."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!data) return <div className="lcard"><div className="skel" style={{ height: 120 }} /></div>;
  const totalMb = (data.daily ?? []).reduce((s: number, d: any) => s + d.dataMb, 0);
  return (
    <>
      <div className="kpis k3">
        <div className="kpi"><span className="lbl">Fleet data this cycle</span><span className="val">{gb(totalMb)}</span></div>
        <div className="kpi"><span className="lbl">Tenants consuming</span><span className="val">{(data.byTenant ?? []).length}</span></div>
        <div className="kpi"><span className="lbl">Lines at overage risk</span><span className="val">{(data.overageRisk ?? []).length}</span><span className="sub">projected past their allowance</span></div>
      </div>
      <div className="g2">
        <div className="lcard">
          <div className="lcard-h"><h3>By tenant (data, MTD)</h3></div>
          {(data.byTenant ?? []).length === 0 ? <p className="dimtx small">No usage recorded yet — rows appear with the first live SIM.</p> : (
            <div className="twrap"><table className="t">
              <thead><tr><th>Tenant</th><th className="num">Data</th></tr></thead>
              <tbody>{data.byTenant.map((t: any) => <tr key={t.tenantId}><td>{t.name}</td><td className="num">{gb(t.dataMb)}</td></tr>)}</tbody>
            </table></div>
          )}
        </div>
        <div className="lcard">
          <div className="lcard-h"><h3>Overage risk</h3><span className="dimtx small">projection = straight-line to cycle end</span></div>
          {(data.overageRisk ?? []).length === 0 ? <p className="dimtx small">Nobody is projected to overage.</p> : (
            <div className="twrap"><table className="t">
              <thead><tr><th>Line</th><th>Tenant</th><th className="num">Used</th><th className="num">Projected</th><th className="num">Est. overage</th></tr></thead>
              <tbody>{data.overageRisk.map((r: any) => (
                <tr key={r.lineId}><td className="mono">{r.phoneNumber ?? r.label}</td><td>{r.tenantName}</td><td className="num">{gb(r.usedMb)} / {gb(r.includedMb)}</td><td className="num">{gb(r.projectedMb)}</td><td className="num">{r.behavior === "charge" ? money(r.projectedOverageCents) : "slows"}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </div>
    </>
  );
}

/* ═══════════════ Invoicing ═══════════════ */
function InvoicingView({ ok, bad }: { ok: (t: string) => void; bad: (e: any, f: string) => void }) {
  const [invoices, setInvoices] = useState<any[] | null>(null);
  const [tenants, setTenants] = useState<any[]>([]);
  const [preview, setPreview] = useState<any | null>(null);
  const [previewTenant, setPreviewTenant] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setInvoices((await apiGet<{ invoices: any[] }>("/admin/mobile-service/invoices")).invoices ?? []); }
    catch (e: any) { bad(e, "Couldn't load invoices."); setInvoices([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void load();
    apiGet<{ tenants: any[] }>("/admin/mobile-service/tenants").then((o) => setTenants(o.tenants ?? [])).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runPreview = async (tenantId: string) => {
    if (!tenantId) return;
    try { setPreview({ tenantId, ...(await apiGet<any>(`/admin/mobile-service/billing-preview/${tenantId}`)) }); }
    catch (e: any) { bad(e, "Preview failed."); }
  };
  const generate = async () => {
    if (!window.confirm("Generate LM- invoices for the PREVIOUS month (closed period)?\n\nThis writes LoopCom Mobile's OWN invoice ledger and emails each tenant that gets one. It never touches the Voice billing engine, and running it twice cannot double-bill (tenant+period is unique).\n\nProceed?")) return;
    setBusy(true);
    try {
      const out = await apiPost<any>("/admin/mobile-service/invoices/generate", { confirm: true });
      const made = (out.results ?? []).filter((r: any) => r.number && !r.skipped);
      const skipped = (out.results ?? []).filter((r: any) => r.skipped);
      ok(`Run complete: ${made.length} invoice${made.length === 1 ? "" : "s"} generated, ${skipped.length} tenant${skipped.length === 1 ? "" : "s"} skipped (${skipped.map((s: any) => s.reason).filter((v: any, i: number, a: any[]) => a.indexOf(v) === i).join(", ") || "nothing billable"}).`);
      await load();
    } catch (e: any) { bad(e, "Generation failed — nothing was written."); } finally { setBusy(false); }
  };
  const setStatus = async (inv: any, status: string) => {
    try { await apiPatch(`/admin/mobile-service/invoices/${inv.id}`, { status }); ok(`Invoice ${inv.number} marked ${status}.`); await load(); }
    catch (e: any) { bad(e, "Couldn't update the invoice."); }
  };

  if (!invoices) return <div className="lcard"><div className="skel" style={{ height: 120 }} /></div>;
  return (
    <>
      <div className="lcard">
        <div className="lcard-h">
          <div><h3>LM- invoice ledger</h3><div className="sub">LoopCom Mobile's own series — separate from Voice billing by design</div></div>
          <button className="lbtn primary" disabled={busy} onClick={() => void generate()}>Generate last month's invoices</button>
        </div>
        {invoices.length === 0 ? <p className="dimtx small">No mobile invoices yet. Generation covers the previous (closed) month only, is idempotent per tenant+period, and emails each tenant per their notification settings.</p> : (
          <div className="twrap"><table className="t">
            <thead><tr><th>Invoice</th><th>Tenant</th><th>Period</th><th className="num">Total</th><th>Status</th><th></th></tr></thead>
            <tbody>{invoices.map((inv) => (
              <tr key={inv.id}>
                <td className="mono">{inv.number}</td>
                <td>{inv.tenant?.name}</td>
                <td>{day(inv.periodStart)} – {day(new Date(new Date(inv.periodEnd).getTime() - 1))}</td>
                <td className="num">{money(inv.totalCents)}</td>
                <td>{inv.status === "paid" ? <span className="pill ok">Paid</span> : inv.status === "void" ? <span className="pill dim">Void</span> : <span className="pill info">Open</span>}</td>
                <td><span className="row" style={{ gap: 5 }}>
                  {inv.status === "open" ? <button className="lbtn sm" onClick={() => void setStatus(inv, "paid")}>Mark paid</button> : null}
                  {inv.status === "open" ? <button className="lbtn sm danger" onClick={() => void setStatus(inv, "void")}>Void</button> : null}
                  {inv.status === "paid" ? <button className="lbtn sm" onClick={() => void setStatus(inv, "open")}>Reopen</button> : null}
                </span></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <div className="lcard">
        <div className="lcard-h"><h3>Recount preview — current month, any tenant</h3></div>
        <div className="row">
          <ConnectSelect ariaLabel="Tenant to preview" value={previewTenant} onChange={(v: string) => { setPreviewTenant(v); void runPreview(v); }} placeholder="Pick a tenant…"
            options={tenants.map((t) => ({ value: t.tenantId, label: t.name }))} />
        </div>
        {preview ? (
          <div className="twrap" style={{ marginTop: 12 }}><table className="t">
            <thead><tr><th>Item</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {(preview.items ?? []).map((it: any, i: number) => <tr key={i}><td>{it.description}</td><td className="num">{money(it.amountCents)}</td></tr>)}
              {(preview.items ?? []).length === 0 ? <tr><td colSpan={2} className="dimtx">Nothing billable this cycle.</td></tr> : null}
            </tbody>
            <tfoot><tr><td>Total (est., recounts live until close)</td><td className="num">{money(preview.totalCents)}</td></tr></tfoot>
          </table></div>
        ) : null}
        <p className="help" style={{ marginTop: 8 }}>The preview is the same deterministic recount generation uses — run it twice, same result. A paused line keeps its seat; mid-month lines prorate by day; overage rounds up to the cent.</p>
      </div>
    </>
  );
}

/* ═══════════════ Carrier Status ═══════════════ */
function CarrierView({ ok, bad }: { ok: (t: string) => void; bad: (e: any, f: string) => void }) {
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const load = useCallback(async (force = false) => {
    try {
      if (force) await apiPost("/admin/mobile-service/capabilities/refresh", {});
      const [s, o] = await Promise.all([
        apiGet<StatusResp>("/admin/mobile-service/status"),
        apiGet<Overview>("/admin/mobile-service/overview").catch(() => null),
      ]);
      setStatus(s);
      if (o) setOverview(o);
      if (force) ok("Capability report refreshed.");
    } catch (e: any) { bad(e, "Couldn't load carrier status."); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!status) return <div className="lcard"><div className="skel" style={{ height: 120 }} /></div>;
  const balance = overview?.balance;
  const lowBalance = balance?.balanceCents != null && overview && balance.balanceCents < overview.platform.balanceFloorCents;
  return (
    <>
      <div className="kpis">
        <div className="kpi"><span className="lbl">API</span><span className="val" style={{ fontSize: 18, color: status.report.configured ? "var(--success)" : "var(--danger)" }}>{status.report.configured ? "Connected" : "Not configured"}</span><span className="sub">checked {when(status.report.checkedAt)}</span></div>
        <div className="kpi"><span className="lbl">Account balance</span><span className="val" style={{ color: lowBalance ? "var(--danger)" : undefined }}>{balance?.balanceCents != null ? money(balance.balanceCents) : "—"}</span><span className={`sub ${lowBalance ? "neg" : ""}`}>{lowBalance ? `below the ${money(overview!.platform.balanceFloorCents)} floor` : overview ? `floor ${money(overview.platform.balanceFloorCents)}` : ""}</span></div>
        <div className="kpi"><span className="lbl">Fleet</span><span className="val">{status.counts.lines} <small>lines</small></span><span className="sub">{status.counts.sims} SIMs · {status.counts.plans} plans</span></div>
        <div className="kpi"><span className="lbl">Webhook backlog</span><span className="val">{status.counts.pendingWebhookEvents}</span><span className="sub">unprocessed events</span></div>
      </div>
      <div className="lcard">
        <div className="lcard-h"><h3>Capabilities — what the carrier lets this account do</h3><button className="lbtn sm" onClick={() => void load(true)}>Re-probe now</button></div>
        <div className="twrap"><table className="t">
          <thead><tr><th>Capability</th><th>State</th><th>Detail</th></tr></thead>
          <tbody>{status.report.capabilities.map((c) => (
            <tr key={c.key}>
              <td>{c.label}</td>
              <td><span className={`pill ${c.state === "live" ? "ok" : c.state === "beta" || c.state === "unconfigured" ? "warn" : "bad"}`}>{c.state}</span></td>
              <td className="dimtx">{c.detail}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="help" style={{ marginTop: 8 }}>Customer pages gray their features from this same report — fixing something here un-grays it everywhere. The webhook door is /webhooks/telnyx/mobile (Ed25519, fail-closed); the signing key is saved on /apps/telnyx. The 15-minute sweeps converge state even with webhooks off.</p>
      </div>
    </>
  );
}

/* ═══════════════ Diagnostics ═══════════════ */
function DiagnosticsView({ ok, bad }: { ok: (t: string) => void; bad: (e: any, f: string) => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [pick, setPick] = useState("");
  const [diag, setDiag] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiGet<{ lines: Line[] }>("/admin/mobile-service/lines").then((o) => setLines(o.lines ?? [])).catch(() => undefined);
  }, []);
  const run = async (lineId: string) => {
    if (!lineId) return;
    try { setDiag(await apiGet<any>(`/admin/mobile-service/diagnostics/${lineId}`)); } catch (e: any) { bad(e, "Diagnostics failed."); }
  };
  const maintenance = async (kind: "reconcile" | "usage-sync" | "capabilities/refresh") => {
    setBusy(true);
    try {
      const out: any = await apiPost(`/admin/mobile-service/${kind}`, {});
      ok(kind === "reconcile" ? `Reconcile ran${out?.skipped ? " (nothing to do)" : ""}.` : kind === "usage-sync" ? `Usage sync ran${typeof out?.ingested === "number" ? ` — ${out.ingested} new records` : ""}.` : "Capability report refreshed.");
      if (pick) await run(pick);
    } catch (e: any) { bad(e, "Run failed."); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="lcard">
        <div className="lcard-h"><h3>Look one line in the eye</h3>
          <span className="row">
            <button className="lbtn sm" disabled={busy} onClick={() => void maintenance("reconcile")}>Reconcile all</button>
            <button className="lbtn sm" disabled={busy} onClick={() => void maintenance("usage-sync")}>Re-run usage sync</button>
          </span>
        </div>
        <div className="row">
          <ConnectSelect ariaLabel="Line to diagnose" value={pick} onChange={(v: string) => { setPick(v); void run(v); }} placeholder="Pick a line…"
            options={lines.map((l) => ({ value: l.id, label: `${l.phoneNumber ?? l.label} · ${l.tenantName ?? l.tenantId}` }))} />
        </div>
        <p className="help" style={{ marginTop: 8 }}>Every tool is read-then-converge — nothing re-sends a purchase. Orphan eSIMs (bought but never saved) are recovered by reconcile via their line tags.</p>
      </div>
      {diag ? (
        <div className="lcard">
          <div className="lcard-h"><h3>{diag.line?.phoneNumber ?? diag.line?.label} · {diag.tenant?.name}</h3><button className="lbtn sm" onClick={() => setDiag(null)}>Close</button></div>
          <div className="seclbl">Findings</div>
          <div className="tl">{(diag.findings ?? []).map((f: string, i: number) => (
            <div key={i} className="tlrow"><span className={`ti ${f === "No problems found." ? "ok" : "warn"}`}>{f === "No problems found." ? "✓" : "!"}</span><div><b>{f}</b></div></div>
          ))}</div>
          <div className="g2" style={{ marginTop: 12 }}>
            <div>
              <div className="seclbl">Our record</div>
              <dl className="dl" style={{ gridTemplateColumns: "1fr" }}>
                <div><dt>Status</dt><dd>{diag.line?.status}</dd></div>
                <div><dt>SIM</dt><dd>{diag.line?.sim ? `${diag.line.sim.type} · ${diag.line.sim.status ?? "?"}` : "none"}</dd></div>
                <div><dt>needsReconcile</dt><dd style={{ color: diag.line?.needsReconcile ? "var(--danger)" : undefined }}>{String(Boolean(diag.line?.needsReconcile))}{diag.line?.reconcileReason ? ` — ${diag.line.reconcileReason}` : ""}</dd></div>
                <div><dt>Last usage</dt><dd>{diag.lastUsage ? `${diag.lastUsage.kind} · ${when(diag.lastUsage.recordedAt)}` : "none"}</dd></div>
                <div><dt>Last webhook</dt><dd>{diag.lastWebhook ? `${diag.lastWebhook.eventType} · ${when(diag.lastWebhook.receivedAt)}` : "none"}</dd></div>
              </dl>
            </div>
            <div>
              <div className="seclbl">Carrier record (live)</div>
              {diag.provider ? (
                <dl className="dl" style={{ gridTemplateColumns: "1fr" }}>
                  <div><dt>SIM status</dt><dd>{diag.provider.status ?? "?"}</dd></div>
                  <div><dt>Install</dt><dd>{diag.provider.esimInstallationStatus ?? "—"}</dd></div>
                  <div><dt>Live data session</dt><dd>{diag.provider.liveDataSession ?? "none"}</dd></div>
                  <div><dt>Period data</dt><dd>{gb(diag.provider.currentPeriodDataMb)}</dd></div>
                  <div><dt>IMEI seen</dt><dd className="mono">{diag.provider.currentImei ? `…${String(diag.provider.currentImei).slice(-6)}` : "—"}</dd></div>
                </dl>
              ) : <p className="dimtx small">No provider record (no SIM, or the carrier no longer lists it).</p>}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ═══════════════ Webhooks ═══════════════ */
function WebhooksView({ bad }: { bad: (e: any, f: string) => void }) {
  const [events, setEvents] = useState<any[] | null>(null);
  const [payload, setPayload] = useState<any | null>(null);
  useEffect(() => {
    apiGet<{ events: any[] }>("/admin/mobile-service/webhook-events").then((o) => setEvents(o.events ?? [])).catch((e) => { bad(e, "Couldn't load webhook events."); setEvents([]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const openPayload = async (id: string) => {
    try { setPayload((await apiGet<{ event: any }>(`/admin/mobile-service/webhook-events/${id}`)).event); }
    catch (e: any) { bad(e, "Couldn't load the payload."); }
  };
  if (!events) return <div className="lcard"><div className="skel" style={{ height: 120 }} /></div>;
  return (
    <div className="gmain">
      <div className="lcard" style={{ padding: 0, overflow: "hidden" }}>
        <div className="twrap" style={{ border: 0 }}>
          <table className="t">
            <thead><tr><th>When</th><th>Event</th><th>Status</th><th>Error</th><th></th></tr></thead>
            <tbody>
              {events.length === 0 ? <tr><td colSpan={5} className="dimtx">None yet. The door is /webhooks/telnyx/mobile — Ed25519-verified, fail-closed; the signing key is saved on /apps/telnyx, and the sweeps converge state either way.</td></tr> : events.map((e) => (
                <tr key={e.id}>
                  <td>{when(e.receivedAt)}</td>
                  <td>{e.eventType}</td>
                  <td><span className={`pill ${e.status === "processed" ? "ok" : e.status === "duplicate" ? "dim" : e.status === "received" ? "info" : "bad"}`}>{e.status.replace(/_/g, " ")}</span></td>
                  <td className="dimtx">{e.error ?? ""}</td>
                  <td><button className="lbtn sm" onClick={() => void openPayload(e.id)}>Payload</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {payload ? (
        <div className="lcard">
          <div className="lcard-h"><h3>{payload.eventType}</h3><button className="lbtn sm" onClick={() => setPayload(null)}>Close</button></div>
          <pre style={{ background: "var(--lmx-chip)", borderRadius: 10, padding: 12, fontSize: 11.5, overflow: "auto", maxHeight: 420 }}>{JSON.stringify(payload.payload, null, 2)}</pre>
        </div>
      ) : (
        <div className="lcard"><p className="dimtx small">The ledger shows every decision the door made — verified, refused, duplicate-dropped, dead-lettered. Every event is stored verbatim; open one to read the raw payload.</p></div>
      )}
    </div>
  );
}

/* ═══════════════ Compliance ═══════════════ */
function ComplianceView({ bad }: { bad: (e: any, f: string) => void }) {
  const [data, setData] = useState<any | null>(null);
  useEffect(() => {
    apiGet<any>("/admin/mobile-service/compliance").then(setData).catch((e) => bad(e, "Couldn't load compliance."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!data) return <div className="lcard"><div className="skel" style={{ height: 120 }} /></div>;
  const covPct = data.e911.totalLines > 0 ? Math.round((data.e911.covered / data.e911.totalLines) * 100) : 100;
  return (
    <>
      <div className="kpis k3">
        <div className="kpi"><span className="lbl">E911 coverage</span><span className="val">{data.e911.covered}<small>/{data.e911.totalLines}</small></span><span className="bar" style={{ marginTop: 4 }}><i className={covPct < 90 ? "warn" : ""} style={{ width: `${covPct}%` }} /></span><span className="sub">test dial is 933, never 911</span></div>
        <div className="kpi"><span className="lbl">Mobile Voice</span><span className="val" style={{ fontSize: 16, color: "var(--warning)" }}>Carrier beta</span><span className="sub">no cellular-voice promises made</span></div>
        <div className="kpi"><span className="lbl">Messaging / 10DLC</span><span className="val" style={{ fontSize: 16, color: "var(--danger)" }}>Not registered</span><span className="sub">SMS stays off until done</span></div>
      </div>
      <div className="g2">
        <div className="lcard">
          <div className="lcard-h"><h3>E911 gaps by tenant</h3></div>
          {(data.e911.byTenant ?? []).length === 0 ? <p className="dimtx small">Every non-terminated line has an address on file.</p> : (
            <div className="twrap"><table className="t">
              <thead><tr><th>Tenant</th><th className="num">Lines</th><th className="num">Missing</th><th>Oldest gap</th></tr></thead>
              <tbody>{data.e911.byTenant.map((t: any) => (
                <tr key={t.tenantId}><td>{t.name}</td><td className="num">{t.lines}</td><td className="num" style={{ color: "var(--danger)" }}>{t.missing}</td><td>{t.oldest ? day(t.oldest) : "—"}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          <div className="banner" style={{ marginTop: 12 }}><div><b>Mobile E911 differs from fixed VoIP</b> — nomadic rules apply, addresses must follow the person, and the test dial is <b>933, never 911</b>.</div></div>
        </div>
        <div className="lcard">
          <div className="lcard-h"><h3>Secret reads — eSIM activation codes</h3><span className="dimtx small">every view is audited</span></div>
          {(data.secretReads ?? []).length === 0 ? <p className="dimtx small">No activation-code views yet.</p> : (
            <div className="tl">{data.secretReads.slice(0, 12).map((r: any, i: number) => (
              <div key={i} className="tlrow"><span className="ti warn">🔑</span><div><b>{r.tenant?.name ?? r.tenantId}</b><span className="sub">{r.actorUser?.email ?? "system"} · SIM {String(r.entityId).slice(0, 8)}…</span></div><time>{when(r.createdAt)}</time></div>
            ))}</div>
          )}
        </div>
      </div>
      <div className="lcard">
        <div className="lcard-h"><h3>Audit — every mobile action, every actor</h3></div>
        <div className="twrap"><table className="t">
          <thead><tr><th>When</th><th>Tenant</th><th>Actor</th><th>Action</th></tr></thead>
          <tbody>{(data.audit ?? []).slice(0, 30).map((a: any, i: number) => (
            <tr key={i}><td>{when(a.createdAt)}</td><td>{a.tenant?.name ?? "—"}</td><td>{a.actorUser?.email ?? "system"}</td><td className="mono" style={{ fontSize: 12 }}>{a.action}</td></tr>
          ))}</tbody>
        </table></div>
      </div>
    </>
  );
}

/* ═══════════════ Settings & Controls ═══════════════ */
function SettingsView({ ok, bad }: { ok: (t: string) => void; bad: (e: any, f: string) => void }) {
  const [s, setS] = useState<any | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiGet<{ settings: any }>("/admin/mobile-service/platform-settings").then((o) => setS(o.settings)).catch((e) => bad(e, "Couldn't load settings."));
    apiGet<{ plans: Plan[] }>("/admin/mobile-service/plans").then((o) => setPlans(o.plans ?? [])).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const save = async (patch: Record<string, unknown>) => {
    if (!s) return;
    const prev = s;
    setS({ ...s, ...patch });
    setBusy(true);
    try {
      const out = await apiPut<{ settings: any }>("/admin/mobile-service/platform-settings", patch);
      setS(out.settings);
      ok("Saved.");
    } catch (e: any) { setS(prev); bad(e, "Couldn't save."); } finally { setBusy(false); }
  };
  if (!s) return <div className="lcard"><div className="skel" style={{ height: 120 }} /></div>;

  const NumField = ({ k, label, sub, money: isMoney }: { k: string; label: string; sub?: string; money?: boolean }) => (
    <div className="trow">
      <div><b>{label}</b>{sub ? <span className="sub">{sub}</span> : null}</div>
      <input className="linput" style={{ width: 110 }} defaultValue={isMoney ? (s[k] / 100).toFixed(2) : String(s[k])}
        onBlur={(e) => {
          const raw = parseFloat(e.target.value);
          if (!Number.isFinite(raw)) return;
          const v = isMoney ? Math.round(raw * 100) : k === "anomalyMultiplier" ? raw : Math.round(raw);
          if (v !== s[k]) void save({ [k]: v });
        }} />
    </div>
  );
  const BoolField = ({ k, label, sub }: { k: string; label: string; sub?: string }) => (
    <div className="trow">
      <div><b>{label}</b>{sub ? <span className="sub">{sub}</span> : null}</div>
      <span className={`sw ${s[k] ? "on" : ""}`} role="switch" aria-checked={Boolean(s[k])} onClick={() => !busy && void save({ [k]: !s[k] })} />
    </div>
  );

  return (
    <>
      <div className="seclbl">Master controls</div>
      <div className="gatecards" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(235px, 1fr))", gap: 12, marginBottom: 16 }}>
        <div className="lcard" style={{ padding: "14px 16px", borderColor: "color-mix(in srgb, var(--success) 42%, var(--border))" }}>
          <div className="row" style={{ justifyContent: "space-between" }}><b style={{ fontSize: 13.5 }}>LoopCom Mobile product</b><span className="sw on lock" title="Live — turn off per tenant/role via permissions" /></div>
          <span className="dimtx small">Live for every role granted the section's keys — the permission editors are the per-tenant switch.</span>
        </div>
        <div className="lcard" style={{ padding: "14px 16px", borderStyle: "dashed" }}>
          <div className="row" style={{ justifyContent: "space-between" }}><b style={{ fontSize: 13.5 }}>Cellular voice</b><span className="sw lock" /></div>
          <span className="dimtx small">Locked — carrier beta. Unlocks only after a real call on a voice-enabled SIM proves it.</span>
        </div>
        <div className="lcard" style={{ padding: "14px 16px", borderStyle: "dashed" }}>
          <div className="row" style={{ justifyContent: "space-between" }}><b style={{ fontSize: 13.5 }}>SMS on mobile lines</b><span className="sw lock" /></div>
          <span className="dimtx small">Locked — 10DLC not registered. Compliance tracks the checklist.</span>
        </div>
        <div className="lcard" style={{ padding: "14px 16px", borderStyle: "dashed" }}>
          <div className="row" style={{ justifyContent: "space-between" }}><b style={{ fontSize: 13.5 }}>Auto-suspend on anomaly</b><span className="sw lock" /></div>
          <span className="dimtx small">Deliberately locked off — usage anomalies are detection-only; a human decides.</span>
        </div>
      </div>

      <div className="g2">
        <div className="stack">
          <div className="lcard">
            <div className="lcard-h"><h3>Provisioning</h3></div>
            <div className="trow">
              <div><b>Default plan for new lines</b></div>
              <div style={{ minWidth: 170 }}>
                <ConnectSelect size="sm" ariaLabel="Default plan" value={s.defaultPlanId ?? ""} onChange={(v: string) => void save({ defaultPlanId: v || null })}
                  options={[{ value: "", label: "None" }, ...plans.filter((p) => p.active).map((p) => ({ value: p.id, label: p.name }))]} />
              </div>
            </div>
            <div className="trow">
              <div><b>Whitelabel carrier name (SPN)</b><span className="sub">what the phone's status bar shows</span></div>
              <input className="linput" style={{ width: 140 }} defaultValue={s.spnName} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.spnName) void save({ spnName: v }); }} />
            </div>
            <NumField k="staleEsimNudgeDays" label="Stale-eSIM threshold" sub="days uninstalled before Inventory flags it" />
          </div>
          <div className="lcard">
            <div className="lcard-h"><h3>Alert thresholds</h3></div>
            <NumField k="balanceFloorCents" label="Telnyx balance floor ($)" sub="Overview goes red below this" money />
            <NumField k="anomalyMultiplier" label="Usage anomaly multiplier" sub="× trailing average, 1 GB floor" />
            <NumField k="simReorderFloor" label="Physical SIM reorder floor" />
            <BoolField k="deadLetterAlert" label="Dead-letter alert" sub="surface every new dead letter on the Overview" />
          </div>
          <div className="lcard">
            <div className="lcard-h"><h3>Billing & invoicing</h3></div>
            <div className="trow"><div><b>Invoice series prefix</b></div>
              <input className="linput" style={{ width: 90 }} defaultValue={s.invoicePrefix} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.invoicePrefix) void save({ invoicePrefix: v }); }} /></div>
            <div className="trow"><div><b>Ledger</b><span className="sub">mobile invoices live in their own LM- ledger</span></div><span className="pill ok nub">Separate from Voice billing</span></div>
          </div>
        </div>
        <div className="stack">
          <div className="lcard">
            <div className="lcard-h"><h3>Fraud controls</h3></div>
            <NumField k="maxLinesPerTenant" label="Max lines per tenant without review" />
            <NumField k="maxEsimReplacementsPer30" label="Max eSIM replacements / line / 30 d" />
            <NumField k="codeReadAlertPerHour" label="Activation-code read alert" sub="flag > N reads/hour/tenant" />
          </div>
          <div className="lcard">
            <div className="lcard-h"><h3>Customer feature gates</h3></div>
            <BoolField k="selfServeLines" label="Customer self-serve line creation" sub="off = lines are created by LoopCom" />
            <BoolField k="topUpsEnabled" label="Data top-up purchases" sub="off = the top-up product stays hidden" />
          </div>
          <div className="lcard">
            <div className="lcard-h"><h3>Access & visibility</h3></div>
            <div className="trow"><div><b>Customer section "LoopCom Mobile"</b><span className="sub">one key per page — grant on /admin/permissions and in custom roles</span></div><span className="pill dim nub">Permission editors</span></div>
            <div className="trow"><div><b>Mobile Console</b><span className="sub">platform staff only</span></div><span className="pill dim nub">Locked · SUPER_ADMIN</span></div>
          </div>
        </div>
      </div>
    </>
  );
}
