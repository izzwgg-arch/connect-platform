"use client";
/**
 * LoopCom Mobile — Usage. Leads with projection, not history: the pooled
 * KPIs say who will overage, the by-line table sorts by risk with the
 * estimated overage priced. Gated by can_view_mobile_usage.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet } from "../../../../services/apiClient";
import { EmptyState, LoadingCard, Note, PageHead, UsageBar, errText, fmtDate, gb, money } from "../MobileUi";

type Usage = {
  cycle: { start: string; end: string };
  totals: { dataMb: number; voiceSeconds: number; smsCount: number };
  daily: Array<{ day: string; dataMb: number; voiceSeconds: number; smsCount: number }>;
  perLine: Array<{ lineId: string; phoneNumber: string | null; label: string; subscriber: string | null; planName: string | null; includedDataMb: number | null; dataMb: number; voiceSeconds: number; smsCount: number; projectedDataMb: number; projectedOverageCents: number; risk: string }>;
  pastCycles: Array<{ start: string; end: string; dataMb: number; voiceSeconds: number; smsCount: number; invoice: { id: string; number: string; totalCents: number } | null }>;
};

export default function MobileUsagePage() {
  const router = useRouter();
  const [data, setData] = useState<Usage | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<Usage>("/mobile-service/usage"));
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't load usage.") });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const risky = data?.perLine.filter((l) => l.risk !== "on_track") ?? [];
  const projOverage = risky.reduce((s, l) => s + l.projectedOverageCents, 0);

  return (
    <PermissionGate permission="can_view_mobile_usage" fallback={<div className="lmx"><EmptyState title="No access to Usage" text="Ask your account owner to grant the Usage page in LoopCom Mobile." /></div>}>
      <div className="lmx">
        <PageHead title="Usage" subtitle={data ? `Cycle ${fmtDate(data.cycle.start)} – ${fmtDate(new Date(new Date(data.cycle.end).getTime() - 1))} · resets ${fmtDate(data.cycle.end)}` : "Data, talk and texts across every line, by billing cycle."} />
        <Note note={note} />
        {!data ? <><LoadingCard rows={2} /><LoadingCard rows={5} /></> : (
          <>
            <div className="kpis k3">
              <div className="kpi"><span className="lbl">Data</span><span className="val">{gb(data.totals.dataMb)}</span><span className={`sub ${risky.length ? "warn" : "pos"}`}>{risky.length ? `${risky.length} line${risky.length === 1 ? "" : "s"} at overage risk` : "Everyone on track"}</span></div>
              <div className="kpi"><span className="lbl">Talk</span><span className="val">{Math.round(data.totals.voiceSeconds / 60).toLocaleString()} <small>min</small></span><span className="sub">Included on all plans <span className="tag beta">carrier beta</span></span></div>
              <div className="kpi"><span className="lbl">Texts</span><span className="val">{data.totals.smsCount.toLocaleString()}</span><span className="sub"><span className="tag">coming with carrier registration</span></span></div>
            </div>

            <div className="lcard">
              <div className="lcard-h"><h3>Daily data — all lines</h3>{projOverage > 0 ? <span className="pill warn nub">≈ {money(projOverage)} projected overage</span> : null}</div>
              {data.daily.length === 0 ? (
                <EmptyState title="Nothing measured yet" text="Usage appears within minutes of your first eSIM going live. Install it and refresh.">
                  <button className="lbtn sm" onClick={() => router.push("/mobile/devices")}>Open install screen</button>
                </EmptyState>
              ) : (
                <DailyChart daily={data.daily} />
              )}
            </div>

            <div className="lcard">
              <div className="lcard-h"><h3>By line</h3><span className="dimtx small">Sorted by share of allowance used</span></div>
              {data.perLine.length === 0 ? <p className="dimtx small">No lines yet.</p> : (
                <div className="twrap">
                  <table className="t">
                    <thead><tr><th>Line</th><th>Plan</th><th>Data</th><th className="num">Talk</th><th className="num">Texts</th><th>Projection</th><th className="num">Overage (est.)</th></tr></thead>
                    <tbody>
                      {data.perLine.map((l) => (
                        <tr key={l.lineId}>
                          <td><span className="rowlink mono" onClick={() => router.push(`/mobile/lines/${l.lineId}`)}>{l.phoneNumber ?? l.label}</span>{l.subscriber ? <span className="sub">{l.subscriber}</span> : null}</td>
                          <td>{l.planName ?? <span className="dimtx">—</span>}</td>
                          <td><UsageBar used={l.dataMb} included={l.includedDataMb} width={110} /></td>
                          <td className="num">{Math.round(l.voiceSeconds / 60)} min</td>
                          <td className="num">{l.smsCount}</td>
                          <td>{l.risk === "over" ? <span className="pill bad">Over allowance</span> : l.risk === "will_overage" ? <span className="pill warn">Will overage ~{gb(Math.max(0, l.projectedDataMb - (l.includedDataMb ?? 0)))}</span> : <span className="pill ok">On track</span>}</td>
                          <td className="num">{money(l.projectedOverageCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot><tr><td colSpan={6}>Cycle to date</td><td className="num">{money(projOverage)} est.</td></tr></tfoot>
                  </table>
                </div>
              )}
            </div>

            <div className="lcard">
              <div className="lcard-h"><h3>Past cycles</h3></div>
              {data.pastCycles.length === 0 ? <p className="dimtx small">Your first full cycle will appear here at month end.</p> : (
                <div className="twrap">
                  <table className="t">
                    <thead><tr><th>Cycle</th><th className="num">Data</th><th className="num">Talk</th><th className="num">Texts</th><th>Invoice</th></tr></thead>
                    <tbody>
                      {data.pastCycles.map((c, i) => (
                        <tr key={i}>
                          <td>{fmtDate(c.start)} – {fmtDate(new Date(new Date(c.end).getTime() - 1))}</td>
                          <td className="num">{gb(c.dataMb)}</td>
                          <td className="num">{Math.round(c.voiceSeconds / 60)} min</td>
                          <td className="num">{c.smsCount}</td>
                          <td>{c.invoice ? <span className="rowlink" onClick={() => router.push(`/mobile/billing/${c.invoice!.id}`)}>{c.invoice.number} · {money(c.invoice.totalCents)}</span> : <span className="dimtx">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </PermissionGate>
  );
}

function DailyChart({ daily }: { daily: Array<{ day: string; dataMb: number }> }) {
  const days = daily.slice(-31);
  const max = Math.max(1, ...days.map((d) => d.dataMb));
  const W = 660;
  const H = 190;
  const left = 50;
  const bottom = 160;
  const top = 16;
  const bw = Math.max(6, Math.min(26, Math.floor((W - left - 20) / Math.max(1, days.length)) - 6));
  const gap = Math.floor((W - left - 20) / Math.max(1, days.length));
  return (
    <div style={{ width: "100%" }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily data usage" style={{ display: "block", width: "100%", height: "auto" }}>
        <line x1={left} y1={top} x2={left} y2={bottom} stroke="var(--border)" />
        <line x1={left} y1={bottom} x2={W - 10} y2={bottom} stroke="var(--border)" />
        <line x1={left} y1={(top + bottom) / 2} x2={W - 10} y2={(top + bottom) / 2} stroke="var(--border)" strokeDasharray="3 4" />
        <text x={left - 6} y={top + 4} textAnchor="end" fontSize="10" fill="var(--text-dim)">{gb(max)}</text>
        <text x={left - 6} y={(top + bottom) / 2 + 4} textAnchor="end" fontSize="10" fill="var(--text-dim)">{gb(max / 2)}</text>
        <text x={left - 6} y={bottom + 4} textAnchor="end" fontSize="10" fill="var(--text-dim)">0</text>
        {days.map((d, i) => {
          const h = Math.max(1, Math.round(((bottom - top) * d.dataMb) / max));
          const x = left + 8 + i * gap;
          const last = i === days.length - 1;
          return <rect key={d.day} x={x} y={bottom - h} width={bw} height={h} rx="3" fill={last ? "var(--accent-2)" : "var(--accent)"} opacity={last ? 1 : 0.85} />;
        })}
        {days.length > 0 ? (
          <>
            <text x={left + 8} y={bottom + 16} fontSize="10" fill="var(--text-dim)">{days[0].day.slice(5)}</text>
            <text x={left + 8 + (days.length - 1) * gap + bw} y={bottom + 16} textAnchor="end" fontSize="10" fill="var(--text-dim)">{days[days.length - 1].day.slice(5)}</text>
          </>
        ) : null}
      </svg>
    </div>
  );
}
