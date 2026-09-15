"use client";
/**
 * LoopCom Mobile — Lines. The product's core page: every line with its plan,
 * SIM identity (masked), per-service state, usage-vs-allowance and estimated
 * cycle charges. Row actions honor the tenant's member switches (the API
 * enforces them too). Gated by can_view_mobile_lines.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { EmptyState, LoadingCard, Modal, Note, PageHead, StatusPill, UsageBar, errText, gb, money } from "../MobileUi";

type Line = {
  id: string; label: string; status: string; phoneNumber: string | null;
  plan: { id: string; name: string; monthlyPriceCents: number; includedDataMb: number | null; dataOverageBehavior: string } | null;
  sim: { id: string; type: string; iccidLast4: string | null; esimInstallationStatus: string | null; hasActivationCode: boolean } | null;
  subscriber: { id: string; name: string } | null;
  suspendReason: string | null; activatedAt: string | null; e911Status: string;
  dataUsedMb: number; estimateCents: number;
};
type LinesResponse = {
  memberActions: { pause: boolean; changePlan: boolean; reportLost: boolean };
  plans: Array<{ id: string; name: string; monthlyPriceCents: number; includedDataMb: number | null }>;
  lines: Line[];
};

const FILTERS: Array<{ key: string; label: string; test: (l: Line) => boolean }> = [
  { key: "all", label: "All", test: () => true },
  { key: "active", label: "Active", test: (l) => l.status === "active" },
  { key: "pending", label: "Pending", test: (l) => l.status === "pending_activation" || l.status === "draft" },
  { key: "suspended", label: "Suspended", test: (l) => l.status === "suspended" || l.status === "lost" },
  { key: "terminated", label: "Closed", test: (l) => l.status === "terminated" },
  { key: "esim", label: "eSIM", test: (l) => l.sim?.type === "esim" },
  { key: "physical", label: "Physical SIM", test: (l) => l.sim?.type === "physical" },
];

export default function MobileLinesPage() {
  const router = useRouter();
  const [data, setData] = useState<LinesResponse | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [planFor, setPlanFor] = useState<Line | null>(null);
  const [planChoice, setPlanChoice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<LinesResponse>("/mobile-service/lines"));
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't load your lines.") });
      setData({ memberActions: { pause: false, changePlan: false, reportLost: false }, plans: [], lines: [] });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter) ?? FILTERS[0];
    const needle = q.trim().toLowerCase();
    return (data?.lines ?? []).filter((l) => f.test(l) && (!needle ||
      (l.phoneNumber ?? "").toLowerCase().includes(needle) ||
      l.label.toLowerCase().includes(needle) ||
      (l.subscriber?.name ?? "").toLowerCase().includes(needle)));
  }, [data, filter, q]);

  const act = async (line: Line, action: "suspend" | "resume" | "report-lost") => {
    if (action === "report-lost" && !window.confirm("Report this device lost or stolen? Service stops right away; the number is kept safe.")) return;
    setBusyId(line.id);
    setNote(null);
    try {
      await apiPost(`/mobile-service/lines/${line.id}/${action}`, action === "suspend" ? { reason: "Paused by the customer" } : {});
      setNote({ kind: "ok", text: action === "resume" ? "The line is being turned back on." : "The line is suspended. The number is safe." });
      await load();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "That didn't go through.") });
    } finally {
      setBusyId(null);
    }
  };

  const confirmPlanChange = async () => {
    if (!planFor || !planChoice) return;
    setBusyId(planFor.id);
    try {
      await apiPost(`/mobile-service/lines/${planFor.id}/change-plan`, { planId: planChoice });
      setNote({ kind: "ok", text: "Plan changed — the new allowance applies immediately and the invoice prorates by day." });
      setPlanFor(null);
      await load();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't change the plan.") });
    } finally {
      setBusyId(null);
    }
  };

  const counts = useMemo(() => {
    const all = data?.lines ?? [];
    return Object.fromEntries(FILTERS.map((f) => [f.key, all.filter(f.test).length]));
  }, [data]);
  const totalEstimate = (data?.lines ?? []).reduce((s, l) => s + l.estimateCents, 0);

  return (
    <PermissionGate permission="can_view_mobile_lines" fallback={<div className="lmx"><EmptyState title="No access to Lines" text="Ask your account owner to grant the Lines page in LoopCom Mobile." /></div>}>
      <div className="lmx">
        <PageHead title="Lines" subtitle="Each line is a number, a plan and a SIM. Tap a number for full detail, usage and history." />
        <Note note={note} />
        <div className="chips">
          <span className="searchwrap"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg><input className="linput" placeholder="Number, name…" value={q} onChange={(e) => setQ(e.target.value)} /></span>
          {FILTERS.map((f) => (
            <button key={f.key} className={`chip ${filter === f.key ? "on" : ""}`} onClick={() => setFilter(f.key)}>{f.label} <small>{counts[f.key] ?? 0}</small></button>
          ))}
        </div>

        {!data ? <LoadingCard rows={6} /> : rows.length === 0 ? (
          <EmptyState title={data.lines.length === 0 ? "No mobile lines yet" : "Nothing matches"} text={data.lines.length === 0 ? "When LoopCom sets up your first line it appears here with its eSIM install screen." : "Try a different filter or search."} />
        ) : (
          <div className="lcard" style={{ padding: 0, overflow: "hidden" }}>
            <div className="twrap" style={{ border: 0 }}>
              <table className="t">
                <thead><tr><th>Number</th><th>Subscriber</th><th>Plan</th><th>Status</th><th>SIM</th><th>Usage this cycle</th><th className="num">Est. charges</th><th></th></tr></thead>
                <tbody>
                  {rows.map((l) => {
                    const busy = busyId === l.id;
                    return (
                      <tr key={l.id}>
                        <td><span className="rowlink mono" onClick={() => router.push(`/mobile/lines/${l.id}`)}>{l.phoneNumber ?? l.label}</span>{l.phoneNumber ? <span className="sub">{l.label}</span> : <span className="sub">no number assigned yet</span>}</td>
                        <td>{l.subscriber?.name ?? <span className="dimtx">Unassigned</span>}</td>
                        <td>{l.plan ? `${l.plan.name}` : <span className="dimtx">—</span>}{l.plan ? <span className="sub">{money(l.plan.monthlyPriceCents)}/mo</span> : null}</td>
                        <td><StatusPill status={l.status} />{l.suspendReason && (l.status === "suspended" || l.status === "lost") ? <span className="sub">{l.suspendReason}</span> : null}</td>
                        <td>{l.sim ? <>{l.sim.type === "esim" ? "eSIM" : "Physical"}{l.sim.iccidLast4 ? <span className="sub mono">…{l.sim.iccidLast4}</span> : null}</> : <span className="dimtx">none</span>}</td>
                        <td><UsageBar used={l.dataUsedMb} included={l.plan?.includedDataMb ?? null} /></td>
                        <td className="num">{money(l.estimateCents)}</td>
                        <td>
                          <span className="row" style={{ gap: 6, flexWrap: "nowrap", justifyContent: "flex-end" }}>
                            {l.sim?.type === "esim" && l.sim.hasActivationCode && l.status === "pending_activation" ? (
                              <button className="lbtn sm primary" onClick={() => router.push("/mobile/devices")}>Install eSIM</button>
                            ) : null}
                            {l.status === "active" && data.memberActions.changePlan ? <button className="lbtn sm" disabled={busy} onClick={() => { setPlanFor(l); setPlanChoice(null); }}>Plan</button> : null}
                            {l.status === "active" && data.memberActions.pause ? <button className="lbtn sm" disabled={busy} onClick={() => void act(l, "suspend")}>Pause</button> : null}
                            {l.status === "active" && data.memberActions.reportLost ? <button className="lbtn sm danger" disabled={busy} onClick={() => void act(l, "report-lost")}>Lost</button> : null}
                            {(l.status === "suspended" || l.status === "lost") && data.memberActions.pause ? <button className="lbtn sm primary" disabled={busy} onClick={() => void act(l, "resume")}>Resume</button> : null}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot><tr><td colSpan={6}>{rows.length} line{rows.length === 1 ? "" : "s"}</td><td className="num">{money(totalEstimate)} est.</td><td></td></tr></tfoot>
              </table>
            </div>
          </div>
        )}

        {planFor ? (
          <Modal
            title={`Change plan on ${planFor.phoneNumber ?? planFor.label}`}
            onClose={() => setPlanFor(null)}
            footer={<><button className="lbtn ghost" onClick={() => setPlanFor(null)}>Cancel</button><button className="lbtn primary" disabled={!planChoice || busyId === planFor.id} onClick={() => void confirmPlanChange()}>Confirm change</button></>}
          >
            <p className="dimtx" style={{ fontSize: 13, marginBottom: 12 }}>The new allowance applies immediately; your invoice prorates by day, so you only pay for the days on each plan.</p>
            <div className="stack" style={{ gap: 8 }}>
              {(data?.plans ?? []).map((p) => (
                <div key={p.id} className="trow" style={{ cursor: "pointer", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 12px" }} onClick={() => setPlanChoice(p.id)}>
                  <div><b>{p.name}</b><span className="sub">{p.includedDataMb != null ? `${gb(p.includedDataMb)} data` : "No data"} · {money(p.monthlyPriceCents)}/mo</span></div>
                  <span className={`pill ${planChoice === p.id ? "info" : "dim"} nub`}>{planChoice === p.id ? "Selected" : planFor.plan?.id === p.id ? "Current" : "Choose"}</span>
                </div>
              ))}
            </div>
          </Modal>
        ) : null}
      </div>
    </PermissionGate>
  );
}
