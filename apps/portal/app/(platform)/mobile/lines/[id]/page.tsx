"use client";
/**
 * LoopCom Mobile — Line detail. Provisioning stepper first ("where is my
 * line stuck" is the #1 question), then usage, facts, billing summary and
 * the tenant-visible audit slice. Uses the lines endpoints (page key
 * can_view_mobile_lines) — the detail/activity routes live under
 * /mobile-service/lines/*.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { apiGet, apiPost, apiPut } from "../../../../../services/apiClient";
import { EmptyState, LoadingCard, Modal, Note, StatusPill, errText, fmtDate, fmtDateTime, gb, money } from "../../MobileUi";

type Detail = {
  line: {
    id: string; label: string; status: string; phoneNumber: string | null;
    plan: { id: string; name: string; monthlyPriceCents: number; includedDataMb: number | null } | null;
    sim: { id: string; type: string; status: string | null; iccid: string | null; esimInstallationStatus: string | null; hasActivationCode: boolean } | null;
    activatedAt: string | null; suspendedAt: string | null; suspendReason: string | null; needsReconcile: boolean;
  };
  usage: Array<{ recordedAt: string; kind: string; quantity: number }>;
  totals: { dataMb: number; voiceSeconds: number; smsCount: number };
};

export default function MobileLineDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = String(params?.id ?? "");
  const [data, setData] = useState<Detail | null>(null);
  const [activity, setActivity] = useState<Array<{ action: string; createdAt: string; actorUser?: { email?: string | null; name?: string | null } | null }>>([]);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [e911Open, setE911Open] = useState(false);
  const [e911, setE911] = useState({ line1: "", line2: "", city: "", state: "NY", zip: "" });

  const load = useCallback(async () => {
    try {
      const [d, a] = await Promise.all([
        apiGet<Detail>(`/mobile-service/lines/${id}`),
        apiGet<{ activity: any[] }>(`/mobile-service/lines/${id}/activity`).catch(() => ({ activity: [] })),
      ]);
      setData(d);
      setActivity(a.activity ?? []);
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't load this line.") });
    }
  }, [id]);
  useEffect(() => { if (id) void load(); }, [id, load]);

  const act = async (action: "suspend" | "resume" | "report-lost") => {
    if (action === "report-lost" && !window.confirm("Report this device lost or stolen? Service stops right away; the number is kept safe.")) return;
    setBusy(true);
    try {
      await apiPost(`/mobile-service/lines/${id}/${action}`, action === "suspend" ? { reason: "Paused by the customer" } : {});
      setNote({ kind: "ok", text: action === "resume" ? "The line is being turned back on." : "The line is suspended. The number is safe." });
      await load();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "That didn't go through.") });
    } finally {
      setBusy(false);
    }
  };

  const saveE911 = async () => {
    setBusy(true);
    try {
      await apiPut(`/mobile-service/lines/${id}/e911`, { ...e911, line2: e911.line1 && e911.line2 ? e911.line2 : undefined });
      setNote({ kind: "ok", text: "Emergency address saved for this line." });
      setE911Open(false);
      await load();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't save the address.") });
    } finally {
      setBusy(false);
    }
  };

  const line = data?.line;
  const steps = line ? buildSteps(line) : [];

  return (
    <PermissionGate permission="can_view_mobile_lines" fallback={<div className="lmx"><EmptyState title="No access to Lines" text="Ask your account owner to grant the Lines page in LoopCom Mobile." /></div>}>
      <div className="lmx">
        <div className="lmx-crumb"><span className="link" onClick={() => router.push("/mobile/lines")}>Lines</span> / <b>{line?.phoneNumber ?? line?.label ?? "…"}</b></div>
        <div className="lmx-pagehead">
          <div>
            <div className="row"><h2 className="mono" style={{ fontSize: 22 }}>{line?.phoneNumber ?? line?.label ?? "Loading…"}</h2>{line ? <StatusPill status={line.status} /> : null}</div>
            {line ? <p className="muted">{line.label}{line.plan ? ` · ${line.plan.name}` : ""}{line.sim ? ` · ${line.sim.type === "esim" ? "eSIM" : "Physical SIM"}` : ""}{line.activatedAt ? ` · activated ${fmtDate(line.activatedAt)}` : ""}</p> : null}
          </div>
          {line ? (
            <div className="row">
              {line.status === "active" ? <><button className="lbtn" disabled={busy} onClick={() => void act("suspend")}>Pause line</button><button className="lbtn danger" disabled={busy} onClick={() => void act("report-lost")}>Report lost</button></> : null}
              {line.status === "suspended" || line.status === "lost" ? <button className="lbtn primary" disabled={busy} onClick={() => void act("resume")}>Resume</button> : null}
              {line.sim?.type === "esim" && line.sim.hasActivationCode && line.status === "pending_activation" ? <button className="lbtn primary" onClick={() => router.push("/mobile/devices")}>Install eSIM</button> : null}
            </div>
          ) : null}
        </div>
        <Note note={note} />

        {!data || !line ? <LoadingCard rows={5} /> : (
          <>
            <div className="lcard">
              <div className="lcard-h"><h3>Provisioning state</h3>{line.needsReconcile ? <span className="pill warn">Confirming with carrier…</span> : <span className="pill ok">In sync with carrier</span>}</div>
              <div className="stepper">
                {steps.map((s, i) => (
                  <div key={i} className={`step ${s.state}`}><span className="sdot">{s.state === "done" ? "✓" : s.state === "fail" ? "!" : s.state === "now" ? "●" : i + 1}</span><b>{s.label}</b><small>{s.sub}</small></div>
                ))}
              </div>
            </div>

            <div className="gmain" style={{ marginTop: 14 }}>
              <div className="stack">
                <div className="lcard">
                  <div className="lcard-h"><h3>Usage this cycle</h3><span className="dimtx small">{data.usage.length} recent record{data.usage.length === 1 ? "" : "s"}</span></div>
                  <div className="kpis k3" style={{ marginBottom: 0 }}>
                    <div className="kpi" style={{ minHeight: 70 }}><span className="lbl">Data</span><span className="val" style={{ fontSize: 21 }}>{gb(data.totals.dataMb)}</span>{line.plan?.includedDataMb ? <span className="sub">of {gb(line.plan.includedDataMb)}</span> : null}</div>
                    <div className="kpi" style={{ minHeight: 70 }}><span className="lbl">Talk</span><span className="val" style={{ fontSize: 21 }}>{Math.round(data.totals.voiceSeconds / 60)} <small>min</small></span><span className="sub"><span className="tag beta">carrier beta</span></span></div>
                    <div className="kpi" style={{ minHeight: 70 }}><span className="lbl">Texts</span><span className="val" style={{ fontSize: 21 }}>{data.totals.smsCount}</span><span className="sub"><span className="tag">coming</span></span></div>
                  </div>
                  {data.usage.length > 0 ? (
                    <div className="twrap" style={{ marginTop: 12 }}>
                      <table className="t">
                        <thead><tr><th>When</th><th>Kind</th><th className="num">Amount</th></tr></thead>
                        <tbody>
                          {data.usage.slice(0, 10).map((r, i) => (
                            <tr key={i}><td>{fmtDateTime(r.recordedAt)}</td><td style={{ textTransform: "capitalize" }}>{r.kind}</td><td className="num">{r.kind === "data" ? gb(r.quantity) : r.kind === "voice" ? `${Math.round(r.quantity / 60)} min` : r.quantity}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : <p className="dimtx small" style={{ marginTop: 10 }}>Usage appears within minutes of the eSIM going live.</p>}
                </div>

                <div className="lcard">
                  <div className="lcard-h"><h3>History</h3><span className="dimtx small">Every change to this line, who and when</span></div>
                  {activity.length === 0 ? <p className="dimtx small">Nothing yet.</p> : (
                    <div className="tl">
                      {activity.map((a, i) => (
                        <div key={i} className="tlrow">
                          <span className={`ti ${a.action.includes("lost") ? "warn" : a.action.includes("suspend") ? "bad" : "ok"}`}>•</span>
                          <div><b>{a.action.replace(/^mobile\./, "").replace(/[._]/g, " ")}</b>{a.actorUser?.email ? <span className="sub">{a.actorUser.name ?? a.actorUser.email}</span> : <span className="sub">system</span>}</div>
                          <time>{fmtDateTime(a.createdAt)}</time>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="stack">
                <div className="lcard">
                  <div className="lcard-h"><h3>Line facts</h3></div>
                  <dl className="dl" style={{ gridTemplateColumns: "1fr 1fr" }}>
                    <div><dt>Plan</dt><dd>{line.plan?.name ?? "—"}</dd></div>
                    <div><dt>Monthly</dt><dd>{line.plan ? money(line.plan.monthlyPriceCents) : "—"}</dd></div>
                    <div><dt>SIM</dt><dd>{line.sim ? (line.sim.type === "esim" ? "eSIM" : "Physical") : "none"}</dd></div>
                    <div><dt>ICCID</dt><dd className="mono">{line.sim?.iccid ? `…${String(line.sim.iccid).slice(-4)}` : "—"}</dd></div>
                    <div><dt>Data</dt><dd><span className="pill ok nub">On</span></dd></div>
                    <div><dt>Voice</dt><dd><span className="pill warn nub">Carrier beta</span></dd></div>
                    <div><dt>SMS</dt><dd><span className="pill dim nub">Not enabled</span></dd></div>
                    <div><dt>Install</dt><dd>{line.sim?.esimInstallationStatus ?? "—"}</dd></div>
                  </dl>
                </div>
                <div className="lcard">
                  <div className="lcard-h"><h3>Emergency address (E911)</h3>{(line as any).e911Status === "on_file" ? <span className="pill ok">On file</span> : <span className="pill warn">Missing</span>}</div>
                  <p className="dimtx" style={{ fontSize: 12.5 }}>911 needs to know where this line usually is. It takes a minute and applies immediately on our side.</p>
                  <button className="lbtn sm" style={{ marginTop: 10 }} onClick={() => setE911Open(true)}>{(line as any).e911Status === "on_file" ? "Update address" : "Add address"}</button>
                </div>
                <div className="lcard">
                  <div className="lcard-h"><h3>Need help with this line?</h3></div>
                  <button className="lbtn sm" onClick={() => router.push("/mobile/support")}>Run diagnostics in Mobile Support →</button>
                </div>
              </div>
            </div>
          </>
        )}

        {e911Open ? (
          <Modal title="Emergency address for this line" onClose={() => setE911Open(false)}
            footer={<><button className="lbtn ghost" onClick={() => setE911Open(false)}>Cancel</button><button className="lbtn primary" disabled={busy} onClick={() => void saveE911()}>Save address</button></>}>
            <div className="form">
              <div className="field full"><label>Street address</label><input className="linput" value={e911.line1} onChange={(e) => setE911({ ...e911, line1: e.target.value })} placeholder="241 Route 59" /></div>
              <div className="field full"><label>Suite / apt (optional)</label><input className="linput" value={e911.line2} onChange={(e) => setE911({ ...e911, line2: e.target.value })} /></div>
              <div className="field"><label>City</label><input className="linput" value={e911.city} onChange={(e) => setE911({ ...e911, city: e.target.value })} /></div>
              <div className="field"><label>State</label><input className="linput" maxLength={2} value={e911.state} onChange={(e) => setE911({ ...e911, state: e.target.value.toUpperCase() })} /></div>
              <div className="field"><label>ZIP</label><input className="linput" value={e911.zip} onChange={(e) => setE911({ ...e911, zip: e.target.value })} placeholder="10952" /></div>
            </div>
            <p className="help" style={{ marginTop: 10 }}>Use the municipality 911 knows, not the postal town. Carrier-side registration follows once the line has its number — mobile rules differ from fixed lines.</p>
          </Modal>
        ) : null}
      </div>
    </PermissionGate>
  );
}

function buildSteps(line: Detail["line"]): Array<{ label: string; sub: string; state: "done" | "now" | "fail" | "todo" }> {
  const created = { label: "Line created", sub: "", state: "done" as const };
  if (line.status === "terminated") {
    return [created, { label: "Closed", sub: line.suspendReason ?? "", state: "fail" }];
  }
  const hasSim = Boolean(line.sim);
  const installed = line.sim?.esimInstallationStatus && line.sim.esimInstallationStatus !== "released";
  const active = line.status === "active";
  const suspended = line.status === "suspended" || line.status === "lost";
  return [
    created,
    { label: line.sim?.type === "physical" ? "SIM assigned" : "eSIM issued", sub: "", state: hasSim ? "done" : line.status === "draft" ? "now" : "todo" },
    { label: "Installed on device", sub: "", state: installed ? "done" : hasSim ? "now" : "todo" },
    { label: "Registered on network", sub: "", state: active || suspended ? "done" : installed ? "now" : "todo" },
    suspended
      ? { label: line.status === "lost" ? "Suspended · lost" : "Paused", sub: "number held safe", state: "fail" }
      : { label: "In service", sub: active ? "today" : "", state: active ? "now" : "todo" },
  ];
}
