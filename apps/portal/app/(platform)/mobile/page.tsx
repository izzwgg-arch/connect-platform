"use client";
/**
 * LoopCom Mobile — the customer page (2026-09-15).
 *
 * Branded mobile service on Telnyx wireless: lines, eSIM install (QR),
 * cycle usage, suspend/resume, lost-device, port-in drafts. Gated by
 * can_view_workspace_mobile (in NO default bucket — granting the key is the
 * launch). Everything here is tenant-scoped server-side on /mobile-service/*;
 * nothing on this page can spend money — provisioning lives on the owner's
 * Mobile Console.
 */
import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../services/apiClient";

type LineRow = {
  id: string;
  label: string;
  status: string;
  phoneNumber: string | null;
  plan: { id: string; name: string; monthlyPriceCents: number; includedDataMb: number | null } | null;
  sim: { id: string; type: string; status: string | null; iccid: string | null; esimInstallationStatus: string | null; hasActivationCode: boolean } | null;
  suspendReason: string | null;
  activatedAt: string | null;
};

type Overview = {
  lines: LineRow[];
  cycle: { start: string; totals: { dataMb: number; voiceSeconds: number; smsCount: number }; byLine: Record<string, { dataMb: number }> };
};

type PlanRow = { id: string; name: string; description: string | null; monthlyPriceCents: number; includedDataMb: number | null; includedVoiceMinutes: number | null; includedSms: number | null; roamingEnabled: boolean };

function errText(e: any, fallback: string): string {
  return e?.body?.message || e?.body?.error || e?.message || fallback;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function gb(mb: number | null | undefined): string {
  if (mb == null) return "—";
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${Math.round(mb)} MB`;
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Being set up",
  pending_activation: "Ready to install",
  active: "Active",
  suspended: "Suspended",
  lost: "Suspended (lost device)",
  terminated: "Closed",
};

export default function LoopcomMobilePage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busyLineId, setBusyLineId] = useState<string | null>(null);
  const [esim, setEsim] = useState<{ lineId: string; code: string; instructions: string[] } | null>(null);
  const [portNumber, setPortNumber] = useState("");
  const [portRequests, setPortRequests] = useState<Array<{ id: string; phoneNumber: string; status: string; createdAt: string }>>([]);

  const load = useCallback(async () => {
    try {
      const [ov, pl, pr] = await Promise.all([
        apiGet<Overview>("/mobile-service/overview"),
        apiGet<{ plans: PlanRow[] }>("/mobile-service/plans"),
        apiGet<{ portRequests: Array<{ id: string; phoneNumber: string; status: string; createdAt: string }> }>("/mobile-service/port-requests"),
      ]);
      setOverview(ov);
      setPlans(pl.plans ?? []);
      setPortRequests(pr.portRequests ?? []);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(errText(e, "Couldn't load your mobile service."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (lineId: string, action: "suspend" | "resume" | "report-lost", body?: any) => {
    setBusyLineId(lineId);
    setNote(null);
    try {
      await apiPost(`/mobile-service/lines/${lineId}/${action}`, body ?? {});
      setNote({ kind: "ok", text: action === "resume" ? "The line is being turned back on." : "The line is suspended. Your number is safe." });
      await load();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "That didn't go through.") });
    } finally {
      setBusyLineId(null);
    }
  };

  const showEsim = async (lineId: string) => {
    setNote(null);
    try {
      const out = await apiGet<{ activationCode: string; instructions: string[] }>(`/mobile-service/lines/${lineId}/esim`);
      setEsim({ lineId, code: out.activationCode, instructions: out.instructions ?? [] });
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't fetch the eSIM install code.") });
    }
  };

  const startPort = async () => {
    setNote(null);
    try {
      const out = await apiPost<{ message: string }>("/mobile-service/port-requests", { phoneNumber: portNumber });
      setPortNumber("");
      setNote({ kind: "ok", text: out.message ?? "Port request saved." });
      await load();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't save the port request.") });
    }
  };

  return (
    <PermissionGate permission="can_view_workspace_mobile" fallback={<div className="state-box">You do not have access to LoopCom Mobile.</div>}>
      <div className="lm-wrap">
        <LmStyles />
        <PageHeader title="LoopCom Mobile" subtitle="Your mobile lines, eSIMs and usage" />
        {note ? <div className={`lm-note ${note.kind}`}>{note.text}</div> : null}
        {loadError ? <div className="lm-note bad">{loadError}</div> : null}

        <section className="lm-card">
          <h3 className="lm-h3">Your lines</h3>
          {!overview ? (
            <div className="lm-dim">Loading…</div>
          ) : overview.lines.length === 0 ? (
            <div className="lm-dim">
              No mobile lines yet. When LoopCom sets one up for you, it appears here with its eSIM install screen.
            </div>
          ) : (
            <table className="lm-table">
              <thead>
                <tr><th>Line</th><th>Number</th><th>Status</th><th>Plan</th><th>Data this cycle</th><th></th></tr>
              </thead>
              <tbody>
                {overview.lines.map((line) => {
                  const used = overview.cycle.byLine[line.id]?.dataMb ?? 0;
                  const included = line.plan?.includedDataMb ?? null;
                  const busy = busyLineId === line.id;
                  return (
                    <tr key={line.id}>
                      <td>{line.label}</td>
                      <td>{line.phoneNumber ?? <span className="lm-dim">not assigned yet</span>}</td>
                      <td>
                        <span className={`lm-pill s-${line.status}`}>{STATUS_LABEL[line.status] ?? line.status}</span>
                        {line.suspendReason && (line.status === "suspended" || line.status === "lost") ? (
                          <div className="lm-dim lm-small">{line.suspendReason}</div>
                        ) : null}
                      </td>
                      <td>{line.plan ? `${line.plan.name} (${money(line.plan.monthlyPriceCents)}/mo)` : <span className="lm-dim">—</span>}</td>
                      <td>{gb(used)}{included != null ? <span className="lm-dim"> of {gb(included)}</span> : null}</td>
                      <td className="lm-actions">
                        {line.sim?.type === "esim" && line.sim.hasActivationCode && line.status === "pending_activation" ? (
                          <button className="lm-btn primary" onClick={() => void showEsim(line.id)}>Install eSIM</button>
                        ) : null}
                        {line.status === "active" ? (
                          <>
                            <button className="lm-btn" disabled={busy} onClick={() => void act(line.id, "suspend", { reason: "Paused by the customer" })}>Pause</button>
                            <button className="lm-btn danger" disabled={busy} onClick={() => {
                              if (window.confirm("Report this device lost or stolen? Service stops right away; your number is kept safe.")) {
                                void act(line.id, "report-lost");
                              }
                            }}>Lost device</button>
                          </>
                        ) : null}
                        {line.status === "suspended" || line.status === "lost" ? (
                          <button className="lm-btn primary" disabled={busy} onClick={() => void act(line.id, "resume")}>Resume</button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        {esim ? (
          <section className="lm-card">
            <h3 className="lm-h3">Install your eSIM</h3>
            <div className="lm-esim">
              <div className="lm-qr"><QRCodeSVG value={esim.code} size={196} /></div>
              <div>
                <ol className="lm-steps">
                  {esim.instructions.map((step, i) => (<li key={i}>{step}</li>))}
                </ol>
                <div className="lm-dim lm-small">Manual entry code (if the camera can't scan):</div>
                <code className="lm-code">{esim.code}</code>
                <div style={{ marginTop: 10 }}>
                  <button className="lm-btn" onClick={() => setEsim(null)}>Done</button>
                </div>
              </div>
            </div>
          </section>
        ) : null}

        <section className="lm-card">
          <h3 className="lm-h3">Plans</h3>
          {plans.length === 0 ? (
            <div className="lm-dim">Plans are being finalized — LoopCom will publish them here.</div>
          ) : (
            <div className="lm-plans">
              {plans.map((p) => (
                <div key={p.id} className="lm-plan">
                  <div className="lm-plan-name">{p.name}</div>
                  <div className="lm-plan-price">{money(p.monthlyPriceCents)}<span className="lm-dim">/mo</span></div>
                  <div className="lm-dim">{p.includedDataMb != null ? `${gb(p.includedDataMb)} data` : "No data"}{p.includedVoiceMinutes != null ? ` · ${p.includedVoiceMinutes} min` : ""}{p.includedSms != null ? ` · ${p.includedSms} texts` : ""}</div>
                  {p.description ? <div className="lm-dim lm-small">{p.description}</div> : null}
                </div>
              ))}
            </div>
          )}
          <div className="lm-dim lm-small" style={{ marginTop: 8 }}>To add a line or change a plan, contact LoopCom support — it takes minutes.</div>
        </section>

        <section className="lm-card">
          <h3 className="lm-h3">Bring your number</h3>
          <p className="lm-dim">Keep your existing mobile number: enter it and LoopCom will handle the transfer with your current carrier (you'll be asked for the account number and transfer PIN before anything moves).</p>
          <div className="lm-row">
            <input className="lm-input" placeholder="(555) 555-0123" value={portNumber} onChange={(e) => setPortNumber(e.target.value)} />
            <button className="lm-btn primary" disabled={!portNumber.trim()} onClick={() => void startPort()}>Start transfer</button>
          </div>
          {portRequests.length > 0 ? (
            <table className="lm-table" style={{ marginTop: 10 }}>
              <thead><tr><th>Number</th><th>Status</th><th>Requested</th></tr></thead>
              <tbody>
                {portRequests.map((r) => (
                  <tr key={r.id}><td>{r.phoneNumber}</td><td><span className={`lm-pill s-${r.status}`}>{r.status.replace(/_/g, " ")}</span></td><td>{new Date(r.createdAt).toLocaleDateString()}</td></tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      </div>
    </PermissionGate>
  );
}

function LmStyles() {
  return (
    <style jsx global>{`
      .lm-wrap { --pnl: #fff; --ln: #e3e6ec; --tx: #17202b; --dim: #64708a; --ac: #2563eb; --ok: #157347; --bad: #b42318; color: var(--tx); }
      :root[data-theme="dark"] .lm-wrap { --pnl: #151a22; --ln: #2a3140; --tx: #e8ecf3; --dim: #8b96ab; --ac: #5b8def; --ok: #4ade80; --bad: #f87171; }
      .lm-card { background: var(--pnl); border: 1px solid var(--ln); border-radius: 12px; padding: 16px; margin-top: 14px; }
      .lm-h3 { margin: 0 0 10px; font-size: 15px; }
      .lm-dim { color: var(--dim); }
      .lm-small { font-size: 12px; }
      .lm-note { border-radius: 10px; padding: 10px 12px; margin-top: 12px; border: 1px solid var(--ln); }
      .lm-note.ok { color: var(--ok); }
      .lm-note.bad { color: var(--bad); }
      .lm-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
      .lm-table th { text-align: left; color: var(--dim); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--ln); }
      .lm-table td { padding: 8px; border-bottom: 1px solid var(--ln); vertical-align: top; }
      .lm-pill { display: inline-block; border: 1px solid var(--ln); border-radius: 999px; padding: 2px 9px; font-size: 12px; }
      .lm-pill.s-active { color: var(--ok); border-color: var(--ok); }
      .lm-pill.s-suspended, .lm-pill.s-lost { color: var(--bad); border-color: var(--bad); }
      .lm-pill.s-pending_activation { color: var(--ac); border-color: var(--ac); }
      .lm-btn { border: 1px solid var(--ln); background: transparent; color: var(--tx); border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
      .lm-btn.primary { background: var(--ac); border-color: var(--ac); color: #fff; font-weight: 600; }
      .lm-btn.danger { color: var(--bad); border-color: var(--bad); }
      .lm-btn:disabled { opacity: 0.5; cursor: default; }
      .lm-actions { display: flex; gap: 6px; flex-wrap: wrap; }
      .lm-esim { display: flex; gap: 20px; flex-wrap: wrap; align-items: flex-start; }
      .lm-qr { background: #fff; padding: 12px; border-radius: 10px; border: 1px solid var(--ln); }
      .lm-steps { margin: 0 0 10px; padding-left: 18px; }
      .lm-steps li { margin-bottom: 4px; }
      .lm-code { display: inline-block; background: rgba(127,127,127,0.12); border-radius: 6px; padding: 4px 8px; font-size: 12px; word-break: break-all; max-width: 460px; }
      .lm-plans { display: flex; gap: 12px; flex-wrap: wrap; }
      .lm-plan { border: 1px solid var(--ln); border-radius: 10px; padding: 12px 14px; min-width: 180px; }
      .lm-plan-name { font-weight: 600; }
      .lm-plan-price { font-size: 20px; font-weight: 700; margin: 2px 0; }
      .lm-row { display: flex; gap: 8px; flex-wrap: wrap; }
      .lm-input { border: 1px solid var(--ln); background: transparent; color: var(--tx); border-radius: 8px; padding: 7px 10px; font-size: 13.5px; min-width: 220px; }
    `}</style>
  );
}
