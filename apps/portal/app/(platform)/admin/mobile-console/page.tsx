"use client";
/**
 * LoopCom Mobile — provider console (2026-09-15). Platform owner only (the
 * SUPER_ADMIN force line in navConfig + requireSuperAdmin on every
 * /admin/mobile-service route).
 *
 * This is the ONLY surface that can spend money: "Provision eSIM" purchases
 * an eSIM on the platform's Telnyx account and says so before it does it.
 * Purchases are never retried — a timeout says "run reconcile, don't re-click".
 */
import { useCallback, useEffect, useState } from "react";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { PageHeader } from "../../../../components/PageHeader";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiGet, apiPatch, apiPost } from "../../../../services/apiClient";

type Capability = { key: string; label: string; available: boolean; state: string; detail: string };
type StatusResp = {
  report: { checkedAt: string; configured: boolean; capabilities: Capability[] };
  counts: { lines: number; sims: number; plans: number; pendingWebhookEvents: number };
};
type Plan = {
  id: string; name: string; description: string | null; active: boolean; monthlyPriceCents: number;
  activationFeeCents: number; includedDataMb: number | null; includedVoiceMinutes: number | null;
  includedSms: number | null; dataOverageBehavior: string; dataOverageCentsPerGb: number;
  roamingEnabled: boolean; telnyxCostCentsEstimate: number; sortOrder: number;
};
type Line = {
  id: string; tenantId: string; tenantName: string | null; label: string; status: string;
  phoneNumber: string | null;
  plan: { id: string; name: string } | null;
  sim: { id: string; type: string; status: string | null; iccid: string | null; esimInstallationStatus: string | null; hasActivationCode: boolean } | null;
  needsReconcile: boolean; reconcileReason: string | null;
};

function errText(e: any, fallback: string): string {
  return e?.body?.message || e?.body?.error || e?.message || fallback;
}
function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function MobileConsolePage() {
  const { role } = useAppContext();
  const isOwner = role === "SUPER_ADMIN";

  const [status, setStatus] = useState<StatusResp | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [events, setEvents] = useState<Array<{ id: string; eventType: string; status: string; error: string | null; receivedAt: string }>>([]);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [diag, setDiag] = useState<any>(null);

  // create-plan form
  const [planName, setPlanName] = useState("");
  const [planPrice, setPlanPrice] = useState("");
  const [planDataGb, setPlanDataGb] = useState("");
  // create-line form
  const [lineTenantId, setLineTenantId] = useState("");
  const [lineLabel, setLineLabel] = useState("");
  const [linePlanId, setLinePlanId] = useState("");

  const ok = (text: string) => setNote({ kind: "ok", text });
  const bad = (e: any, fallback: string) => setNote({ kind: "bad", text: errText(e, fallback) });

  const loadStatus = useCallback(async () => {
    try { setStatus(await apiGet<StatusResp>("/admin/mobile-service/status")); } catch (e: any) { bad(e, "Couldn't load status."); }
  }, []);
  const loadPlans = useCallback(async () => {
    try { setPlans((await apiGet<{ plans: Plan[] }>("/admin/mobile-service/plans")).plans ?? []); } catch (e: any) { bad(e, "Couldn't load plans."); }
  }, []);
  const loadLines = useCallback(async (search?: string) => {
    try { setLines((await apiGet<{ lines: Line[] }>(`/admin/mobile-service/lines${search ? `?q=${encodeURIComponent(search)}` : ""}`)).lines ?? []); } catch (e: any) { bad(e, "Couldn't load lines."); }
  }, []);
  const loadEvents = useCallback(async () => {
    try { setEvents((await apiGet<{ events: any[] }>("/admin/mobile-service/webhook-events")).events ?? []); } catch { /* panel-local */ }
  }, []);

  useEffect(() => {
    if (!isOwner) return;
    void loadStatus(); void loadPlans(); void loadLines(); void loadEvents();
  }, [isOwner, loadStatus, loadPlans, loadLines, loadEvents]);

  const createPlan = async () => {
    setNote(null);
    const priceCents = Math.round(parseFloat(planPrice) * 100);
    const dataGb = planDataGb.trim() === "" ? null : parseFloat(planDataGb);
    if (!planName.trim() || !Number.isFinite(priceCents) || priceCents < 0) return bad(null, "Enter a plan name and a monthly price.");
    try {
      await apiPost("/admin/mobile-service/plans", {
        name: planName.trim(),
        monthlyPriceCents: priceCents,
        includedDataMb: dataGb != null && Number.isFinite(dataGb) ? Math.round(dataGb * 1024) : null,
      });
      setPlanName(""); setPlanPrice(""); setPlanDataGb("");
      ok("Plan created.");
      await loadPlans();
    } catch (e: any) { bad(e, "Couldn't create the plan."); }
  };

  const togglePlan = async (plan: Plan) => {
    try {
      await apiPatch(`/admin/mobile-service/plans/${plan.id}`, { active: !plan.active });
      await loadPlans();
    } catch (e: any) { bad(e, "Couldn't update the plan."); }
  };

  const createLine = async () => {
    setNote(null);
    if (!lineTenantId.trim() || !lineLabel.trim()) return bad(null, "Enter the tenant id and a line label.");
    try {
      await apiPost("/admin/mobile-service/lines", { tenantId: lineTenantId.trim(), label: lineLabel.trim(), planId: linePlanId || null });
      setLineLabel("");
      ok("Line created (draft). Provision an eSIM to move it forward.");
      await loadLines(q);
    } catch (e: any) { bad(e, "Couldn't create the line."); }
  };

  const provisionEsim = async (line: Line) => {
    if (!window.confirm(
      `PROVISION eSIM for "${line.label}" (${line.tenantName ?? line.tenantId})?\n\nThis PURCHASES 1 eSIM on the platform's Telnyx account (Telnyx bills per eSIM + a monthly SIM fee) and brands it "LoopCom". It cannot be un-bought.\n\nProceed?`,
    )) return;
    setBusy(line.id); setNote(null);
    try {
      await apiPost(`/admin/mobile-service/lines/${line.id}/provision-esim`, { confirm: true });
      ok("eSIM purchased and attached. The customer's page now has the install QR.");
      await loadLines(q); await loadStatus();
    } catch (e: any) {
      if (e?.body?.error === "unknown_outcome") bad(e, "Outcome unknown — run Reconcile before trying again.");
      else bad(e, "Provisioning failed.");
    } finally { setBusy(null); }
  };

  const lineAction = async (line: Line, action: "suspend" | "resume" | "terminate") => {
    setBusy(line.id); setNote(null);
    try {
      if (action === "suspend") await apiPost(`/admin/mobile-service/lines/${line.id}/suspend`, { reason: "Suspended from the Mobile Console" });
      else if (action === "resume") await apiPost(`/admin/mobile-service/lines/${line.id}/resume`, {});
      else {
        if (!window.confirm(`Terminate "${line.label}"? Service ends; the SIM is disabled (not deleted).`)) { setBusy(null); return; }
        await apiPost(`/admin/mobile-service/lines/${line.id}/terminate`, { confirm: true, reason: "Terminated from the Mobile Console" });
      }
      ok("Done.");
      await loadLines(q);
    } catch (e: any) { bad(e, "Action failed."); } finally { setBusy(null); }
  };

  const runDiagnostics = async (line: Line) => {
    setNote(null);
    try { setDiag(await apiGet(`/admin/mobile-service/diagnostics/${line.id}`)); } catch (e: any) { bad(e, "Diagnostics failed."); }
  };

  const runMaintenance = async (kind: "reconcile" | "usage-sync" | "capabilities/refresh") => {
    setNote(null);
    try {
      const out: any = await apiPost(`/admin/mobile-service/${kind}`, {});
      ok(kind === "reconcile"
        ? "Reconcile ran."
        : kind === "usage-sync"
          ? `Usage sync ran${typeof out?.ingested === "number" ? ` (${out.ingested} new records)` : ""}.`
          : "Capability report refreshed.");
      await loadStatus(); await loadLines(q);
    } catch (e: any) { bad(e, "Run failed."); }
  };

  if (!isOwner) {
    return (
      <div className="mc-wrap">
        <McStyles />
        <PageHeader title="Mobile Console" subtitle="This page is for the platform owner." />
      </div>
    );
  }

  return (
    <div className="mc-wrap">
      <McStyles />
      <PageHeader title="Mobile Console" subtitle="LoopCom Mobile on Telnyx wireless — plans, fleet, provisioning" />
      {note ? <div className={`mc-note ${note.kind}`}>{note.text}</div> : null}

      <section className="mc-card">
        <div className="mc-row-between">
          <h3 className="mc-h3">Carrier capabilities</h3>
          <div className="mc-row">
            <button className="mc-btn" onClick={() => void runMaintenance("capabilities/refresh")}>Re-check</button>
            <button className="mc-btn" onClick={() => void runMaintenance("reconcile")}>Reconcile now</button>
            <button className="mc-btn" onClick={() => void runMaintenance("usage-sync")}>Sync usage now</button>
          </div>
        </div>
        {status ? (
          <>
            <div className="mc-dim mc-small">
              {status.counts.lines} lines · {status.counts.sims} SIMs · {status.counts.plans} plans · {status.counts.pendingWebhookEvents} unprocessed webhook events · checked {new Date(status.report.checkedAt).toLocaleTimeString()}
            </div>
            <table className="mc-table">
              <thead><tr><th>Capability</th><th>State</th><th>Detail</th></tr></thead>
              <tbody>
                {status.report.capabilities.map((c) => (
                  <tr key={c.key}>
                    <td>{c.label}</td>
                    <td><span className={`mc-pill st-${c.state}`}>{c.state}</span></td>
                    <td className="mc-dim">{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : <div className="mc-dim">Loading…</div>}
      </section>

      <section className="mc-card">
        <h3 className="mc-h3">Plans</h3>
        <table className="mc-table">
          <thead><tr><th>Name</th><th>Retail</th><th>Data</th><th>Overage</th><th>Est. cost</th><th>Margin</th><th>Active</th></tr></thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{money(p.monthlyPriceCents)}/mo</td>
                <td>{p.includedDataMb != null ? `${(p.includedDataMb / 1024).toFixed(1)} GB` : "—"}</td>
                <td>{p.dataOverageBehavior === "charge" ? `${money(p.dataOverageCentsPerGb)}/GB` : "blocked at limit"}</td>
                <td className="mc-dim">{money(p.telnyxCostCentsEstimate)}</td>
                <td className="mc-dim">{money(p.monthlyPriceCents - p.telnyxCostCentsEstimate)}</td>
                <td><button className="mc-btn" onClick={() => void togglePlan(p)}>{p.active ? "Deactivate" : "Activate"}</button></td>
              </tr>
            ))}
            {plans.length === 0 ? <tr><td colSpan={7} className="mc-dim">No plans yet — create the first one below.</td></tr> : null}
          </tbody>
        </table>
        <div className="mc-row" style={{ marginTop: 10 }}>
          <input className="mc-input" placeholder="Plan name" value={planName} onChange={(e) => setPlanName(e.target.value)} />
          <input className="mc-input" placeholder="Monthly price (e.g. 25.00)" value={planPrice} onChange={(e) => setPlanPrice(e.target.value)} />
          <input className="mc-input" placeholder="Included data GB (blank = none)" value={planDataGb} onChange={(e) => setPlanDataGb(e.target.value)} />
          <button className="mc-btn primary" onClick={() => void createPlan()}>Create plan</button>
        </div>
      </section>

      <section className="mc-card">
        <div className="mc-row-between">
          <h3 className="mc-h3">Lines (all customers)</h3>
          <div className="mc-row">
            <input className="mc-input" placeholder="Search number / ICCID / customer" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="mc-btn" onClick={() => void loadLines(q)}>Search</button>
          </div>
        </div>
        <table className="mc-table">
          <thead><tr><th>Customer</th><th>Line</th><th>Number</th><th>Status</th><th>SIM</th><th>Plan</th><th>Actions</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td>{l.tenantName ?? l.tenantId}</td>
                <td>{l.label}{l.needsReconcile ? <div className="mc-small" style={{ color: "var(--bad)" }}>{l.reconcileReason ?? "needs reconcile"}</div> : null}</td>
                <td>{l.phoneNumber ?? <span className="mc-dim">—</span>}</td>
                <td><span className={`mc-pill s-${l.status}`}>{l.status.replace(/_/g, " ")}</span></td>
                <td className="mc-dim">{l.sim ? `${l.sim.type} ${l.sim.status ?? ""}${l.sim.esimInstallationStatus ? ` (${l.sim.esimInstallationStatus})` : ""}` : "none"}</td>
                <td>{l.plan?.name ?? <span className="mc-dim">—</span>}</td>
                <td className="mc-actions">
                  {!l.sim && l.status !== "terminated" ? (
                    <button className="mc-btn primary" disabled={busy === l.id} onClick={() => void provisionEsim(l)}>Provision eSIM ($)</button>
                  ) : null}
                  {l.status === "active" ? <button className="mc-btn" disabled={busy === l.id} onClick={() => void lineAction(l, "suspend")}>Suspend</button> : null}
                  {l.status === "suspended" || l.status === "lost" ? <button className="mc-btn" disabled={busy === l.id} onClick={() => void lineAction(l, "resume")}>Resume</button> : null}
                  {l.status !== "terminated" ? <button className="mc-btn danger" disabled={busy === l.id} onClick={() => void lineAction(l, "terminate")}>Terminate</button> : null}
                  <button className="mc-btn" onClick={() => void runDiagnostics(l)}>Diagnostics</button>
                </td>
              </tr>
            ))}
            {lines.length === 0 ? <tr><td colSpan={7} className="mc-dim">No lines yet.</td></tr> : null}
          </tbody>
        </table>
        <div className="mc-row" style={{ marginTop: 10 }}>
          <input className="mc-input" placeholder="Tenant id (Admin → Tenants)" value={lineTenantId} onChange={(e) => setLineTenantId(e.target.value)} />
          <input className="mc-input" placeholder="Line label (e.g. Moshe's phone)" value={lineLabel} onChange={(e) => setLineLabel(e.target.value)} />
          <ConnectSelect
            value={linePlanId}
            onChange={(v) => setLinePlanId(v)}
            options={[{ value: "", label: "No plan yet" }, ...plans.filter((p) => p.active).map((p) => ({ value: p.id, label: p.name }))]}
          />
          <button className="mc-btn primary" onClick={() => void createLine()}>Create line (free)</button>
        </div>
      </section>

      {diag ? (
        <section className="mc-card">
          <div className="mc-row-between">
            <h3 className="mc-h3">Diagnostics — {diag?.line?.label}</h3>
            <button className="mc-btn" onClick={() => setDiag(null)}>Close</button>
          </div>
          <ul className="mc-findings">
            {(diag?.findings ?? []).map((f: string, i: number) => <li key={i}>{f}</li>)}
          </ul>
          <pre className="mc-pre">{JSON.stringify({ line: diag?.line, provider: diag?.provider, lastUsage: diag?.lastUsage, lastWebhook: diag?.lastWebhook }, null, 2)}</pre>
        </section>
      ) : null}

      <section className="mc-card">
        <h3 className="mc-h3">Webhook events</h3>
        <table className="mc-table">
          <thead><tr><th>When</th><th>Event</th><th>Status</th><th>Error</th></tr></thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}><td>{new Date(e.receivedAt).toLocaleString()}</td><td>{e.eventType}</td><td><span className={`mc-pill st-${e.status}`}>{e.status}</span></td><td className="mc-dim">{e.error ?? ""}</td></tr>
            ))}
            {events.length === 0 ? <tr><td colSpan={4} className="mc-dim">None yet. The door is /webhooks/telnyx/mobile (Ed25519-verified; needs the public key saved on /apps/telnyx).</td></tr> : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function McStyles() {
  return (
    <style jsx global>{`
      .mc-wrap { --pnl: #fff; --ln: #e3e6ec; --tx: #17202b; --dim: #64708a; --ac: #2563eb; --ok: #157347; --bad: #b42318; color: var(--tx); }
      :root[data-theme="dark"] .mc-wrap { --pnl: #151a22; --ln: #2a3140; --tx: #e8ecf3; --dim: #8b96ab; --ac: #5b8def; --ok: #4ade80; --bad: #f87171; }
      .mc-card { background: var(--pnl); border: 1px solid var(--ln); border-radius: 12px; padding: 16px; margin-top: 14px; }
      .mc-h3 { margin: 0 0 10px; font-size: 15px; }
      .mc-dim { color: var(--dim); }
      .mc-small { font-size: 12px; }
      .mc-note { border-radius: 10px; padding: 10px 12px; margin-top: 12px; border: 1px solid var(--ln); }
      .mc-note.ok { color: var(--ok); }
      .mc-note.bad { color: var(--bad); }
      .mc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .mc-table th { text-align: left; color: var(--dim); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--ln); }
      .mc-table td { padding: 7px 8px; border-bottom: 1px solid var(--ln); vertical-align: top; }
      .mc-pill { display: inline-block; border: 1px solid var(--ln); border-radius: 999px; padding: 1px 8px; font-size: 11.5px; }
      .mc-pill.st-live, .mc-pill.s-active, .mc-pill.st-processed { color: var(--ok); border-color: var(--ok); }
      .mc-pill.st-blocked, .mc-pill.s-suspended, .mc-pill.s-lost, .mc-pill.st-failed, .mc-pill.st-dead_letter { color: var(--bad); border-color: var(--bad); }
      .mc-pill.st-beta, .mc-pill.st-unconfigured, .mc-pill.s-pending_activation { color: var(--ac); border-color: var(--ac); }
      .mc-btn { border: 1px solid var(--ln); background: transparent; color: var(--tx); border-radius: 8px; padding: 5px 11px; cursor: pointer; font-size: 12.5px; }
      .mc-btn.primary { background: var(--ac); border-color: var(--ac); color: #fff; font-weight: 600; }
      .mc-btn.danger { color: var(--bad); border-color: var(--bad); }
      .mc-btn:disabled { opacity: 0.5; cursor: default; }
      .mc-actions { display: flex; gap: 5px; flex-wrap: wrap; }
      .mc-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .mc-row-between { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; align-items: center; }
      .mc-input { border: 1px solid var(--ln); background: transparent; color: var(--tx); border-radius: 8px; padding: 6px 10px; font-size: 13px; min-width: 180px; }
      .mc-findings { margin: 0 0 10px; padding-left: 18px; }
      .mc-pre { background: rgba(127,127,127,0.09); border-radius: 8px; padding: 10px; font-size: 11.5px; overflow: auto; max-height: 320px; }
    `}</style>
  );
}
