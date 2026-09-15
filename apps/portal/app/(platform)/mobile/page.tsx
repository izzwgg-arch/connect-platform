"use client";
/**
 * LoopCom Mobile — Mobile Dashboard (2026-09-16, the approved full build).
 *
 * The section's front door: hero with cycle progress + primary actions,
 * iconized KPI row, the needs-your-attention queue, quick actions, line
 * cards, activity and the next-invoice estimate — all live from
 * /mobile-service/dashboard. Gated by can_view_workspace_mobile (the
 * original launch key, deliberately kept — see navConfig).
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeftRight, BarChart3, CheckCircle2, CreditCard, LifeBuoy, Plus, Smartphone } from "lucide-react";
import { PermissionGate } from "../../../components/PermissionGate";
import { useAppContext } from "../../../hooks/useAppContext";
import { apiGet } from "../../../services/apiClient";
import { EmptyState, LoadingCard, Note, PageHead, StatusPill, errText, fmtDateTime, gb, money } from "./MobileUi";

type Dashboard = {
  cycle: { start: string; end: string; totals: { dataMb: number; voiceSeconds: number; smsCount: number }; byLine: Record<string, { dataMb: number }>; pooledIncludedMb: number };
  counts: { active: number; pending: number; suspended: number; draft: number; terminated: number };
  lines: Array<{ id: string; label: string; status: string; phoneNumber: string | null; plan: { id: string; name: string; monthlyPriceCents: number; includedDataMb: number | null } | null; sim: { type: string; esimInstallationStatus: string | null; hasActivationCode: boolean } | null; subscriber: { name: string } | null; dataUsedMb: number }>;
  attention: Array<{ kind: string; severity: string; title: string; detail: string; action: string; lineId?: string }>;
  activity: Array<{ action: string; entityType: string; entityId: string; createdAt: string; metadata?: any }>;
  nextInvoice: { totalCents: number; lineCount: number; billsAt: string; items: Array<{ description: string; amountCents: number; kind: string }> };
  settings: { usageWarnPct: number };
};

const ACTIVITY_LABEL: Record<string, string> = {
  "mobile.esim.provisioned": "eSIM issued",
  "mobile.esim.code_viewed": "eSIM install screen opened",
  "mobile.line.created": "Line created",
  "mobile.line.suspend": "Line paused",
  "mobile.line.reported_lost": "Device reported lost",
  "mobile.line.resume": "Line resumed",
  "mobile.line.plan_changed": "Plan changed",
  "mobile.line.terminate": "Line closed",
  "mobile.line.e911_saved": "Emergency address saved",
  "mobile.port.draft_created": "Number transfer started",
  "mobile.port.details_updated": "Transfer details updated",
  "mobile.subscriber.created": "Subscriber added",
  "mobile.settings.updated": "Mobile settings changed",
  "mobile.usage.spike": "Unusual usage flagged",
  "mobile.invoice.generated": "Invoice issued",
};

function activityLabel(action: string): string {
  if (ACTIVITY_LABEL[action]) return ACTIVITY_LABEL[action];
  if (action.startsWith("mobile.email.")) return "Notification emailed";
  if (action.startsWith("mobile.port.status_")) return `Transfer ${action.slice("mobile.port.status_".length).replace(/_/g, " ")}`;
  return action.replace(/^mobile\./, "").replace(/[._]/g, " ");
}

export default function MobileDashboardPage() {
  const router = useRouter();
  const { user } = useAppContext() as any;
  const [data, setData] = useState<Dashboard | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<Dashboard>("/mobile-service/dashboard"));
      setNote(null);
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't load your mobile service.") });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const firstName = String(user?.name ?? user?.email ?? "").split(/[\s@]/)[0] || "there";
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <PermissionGate permission="can_view_workspace_mobile" fallback={<div className="lmx"><EmptyState title="LoopCom Mobile isn't on for this account" text="Ask your account owner, or LoopCom, to switch it on — the whole section appears at once." /></div>}>
      <div className="lmx">
        <Note note={note} />
        {!data ? (
          <><LoadingCard rows={2} /><LoadingCard rows={4} /></>
        ) : (
          <DashboardBody data={data} greeting={greeting} firstName={firstName} go={(p) => router.push(p)} />
        )}
      </div>
    </PermissionGate>
  );
}

function DashboardBody({ data, greeting, firstName, go }: { data: Dashboard; greeting: string; firstName: string; go: (path: string) => void }) {
  const { cycle, counts, lines, attention, activity, nextInvoice } = data;
  const start = new Date(cycle.start);
  const end = new Date(cycle.end);
  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));
  const dayPct = Math.min(100, Math.round(((now.getTime() - start.getTime()) / (end.getTime() - start.getTime())) * 100));
  const pooled = cycle.pooledIncludedMb;
  const dataPct = pooled > 0 ? Math.min(100, Math.round((cycle.totals.dataMb / pooled) * 100)) : 0;
  const activeLines = lines.filter((l) => l.status !== "terminated");
  const healthBits: string[] = [];
  if (counts.active > 0) healthBits.push(`${counts.active} line${counts.active === 1 ? " is" : "s are"} active`);
  if (counts.pending > 0) healthBits.push(`${counts.pending} waiting on an eSIM install`);
  if (counts.suspended > 0) healthBits.push(`${counts.suspended} paused with the number held safe`);
  const health = healthBits.length ? `${healthBits.join(", ")}.` : "No mobile lines yet — when LoopCom sets one up it appears here.";

  return (
    <>
      <div className="hero">
        <div className="hero-glow" />
        <div>
          <div className="hero-eyebrow">LoopCom Mobile</div>
          <h2>{greeting}, {firstName}</h2>
          <p className="hero-sub">{health}</p>
          <div className="hero-cycle">
            <div className="hero-cycle-top">
              <span>Billing cycle · {start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – {new Date(end.getTime() - 1).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
              <span>{daysLeft} day{daysLeft === 1 ? "" : "s"} left</span>
            </div>
            <div className="progress"><i style={{ width: `${pooled > 0 ? dataPct : dayPct}%` }} /><em style={{ left: `${dayPct}%` }} title="Today" /></div>
            <div className="hero-cycle-bottom">
              <span>{pooled > 0 ? `${gb(cycle.totals.dataMb)} of ${gb(pooled)} pooled data used` : `${gb(cycle.totals.dataMb)} data used this cycle`}</span>
              <span>Next invoice est. <b style={{ color: "var(--text)" }}>{money(nextInvoice.totalCents)}</b> · bills {new Date(nextInvoice.billsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
            </div>
          </div>
        </div>
        <div className="hero-side">
          <button className="lbtn primary lg" onClick={() => go("/mobile/billing")}><CreditCard size={15} /> Billing · {money(nextInvoice.totalCents)}</button>
          <button className="lbtn lg" onClick={() => go("/mobile/lines")}><Smartphone size={15} /> Your lines</button>
          <button className="lbtn lg" onClick={() => go("/mobile/usage")}><BarChart3 size={15} /> View usage</button>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi"><span className="kico ok"><CheckCircle2 /></span><span className="lbl">Active lines</span><span className="val">{counts.active}</span><span className={`sub ${counts.active > 0 ? "pos" : ""}`}>{counts.active > 0 ? "Registered on network" : "None yet"}</span></div>
        <div className="kpi"><span className="kico"><Smartphone /></span><span className="lbl">Pending activation</span><span className="val">{counts.pending}</span><span className="sub">{counts.pending > 0 ? "eSIMs waiting to be installed" : "Nothing waiting"}</span></div>
        <div className="kpi"><span className="kico bad"><AlertTriangle /></span><span className="lbl">Suspended</span><span className="val">{counts.suspended}</span><span className={`sub ${counts.suspended > 0 ? "neg" : ""}`}>{counts.suspended > 0 ? "Numbers held safe" : "None"}</span></div>
        <div className="kpi"><span className="kico warn"><BarChart3 /></span><span className="lbl">Data this cycle</span><span className="val">{gb(cycle.totals.dataMb)}</span>{pooled > 0 ? <><span className="bar" style={{ marginTop: 4 }}><i className={dataPct >= 90 ? "bad" : dataPct >= 75 ? "warn" : ""} style={{ width: `${dataPct}%` }} /></span><span className="sub">{dataPct}% of {gb(pooled)} pooled</span></> : <span className="sub">across all lines</span>}</div>
      </div>

      <div className="gmain">
        <div className="stack">
          {attention.length > 0 ? (
            <div className="lcard">
              <div className="lcard-h"><h3>Needs your attention</h3><span className="pill warn nub">{attention.length} item{attention.length === 1 ? "" : "s"}</span></div>
              <div className="alist">
                {attention.map((a, i) => (
                  <div key={i} className="aitem">
                    <span className="sev" style={{ background: a.severity === "danger" ? "var(--danger)" : a.severity === "warning" ? "var(--warning)" : "var(--accent)" }} />
                    <div><b>{a.title}</b><span className="sub">{a.detail}</span></div>
                    <button className="lbtn sm" onClick={() => go(a.action === "open_porting" ? "/mobile/porting" : a.action === "install_esim" ? "/mobile/devices" : a.lineId ? `/mobile/lines/${a.lineId}` : "/mobile/lines")}>
                      {a.action === "change_plan" ? "Change plan" : a.action === "install_esim" ? "Install eSIM" : a.action === "open_porting" ? "Open porting" : "Open"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="lcard">
            <div className="lcard-h"><h3>Quick actions</h3></div>
            <div className="qa">
              <button onClick={() => go("/mobile/users")}><span className="qi"><Plus /></span>Add a line</button>
              <button onClick={() => go("/mobile/porting")}><span className="qi"><ArrowLeftRight /></span>Bring a number</button>
              <button onClick={() => go("/mobile/devices")}><span className="qi"><Smartphone /></span>Activate eSIM</button>
              <button onClick={() => go("/mobile/usage")}><span className="qi"><BarChart3 /></span>View usage</button>
              <button onClick={() => go("/mobile/billing")}><span className="qi"><CreditCard /></span>Billing</button>
              <button onClick={() => go("/mobile/support")}><span className="qi"><LifeBuoy /></span>Get help</button>
            </div>
          </div>

          <div className="lcard">
            <div className="lcard-h">
              <div><h3>Your lines</h3><div className="sub">{activeLines.length} line{activeLines.length === 1 ? "" : "s"} · tap a card for detail</div></div>
              <button className="lbtn sm" onClick={() => go("/mobile/lines")}>All lines →</button>
            </div>
            {activeLines.length === 0 ? (
              <EmptyState title="No mobile lines yet" text="When LoopCom sets up your first line it appears here with its eSIM install screen — usually the same day.">
                <button className="lbtn sm primary" onClick={() => go("/mobile/support")}>Talk to us about lines</button>
              </EmptyState>
            ) : (
              <div className="lcards">
                {activeLines.slice(0, 8).map((l) => {
                  const included = l.plan?.includedDataMb ?? null;
                  const pct = included && included > 0 ? Math.min(100, Math.round((l.dataUsedMb / included) * 100)) : null;
                  const color = pct == null ? "var(--accent)" : pct >= 95 ? "var(--danger)" : pct >= 80 ? "var(--warning)" : "var(--accent)";
                  return (
                    <div key={l.id} className="linecard" onClick={() => go(`/mobile/lines/${l.id}`)} role="link" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") go(`/mobile/lines/${l.id}`); }}>
                      <div className="top">
                        <div><div className="num">{l.phoneNumber ?? l.label}</div><div className="who">{l.subscriber?.name ?? "Unassigned"}</div></div>
                        <StatusPill status={l.status} />
                      </div>
                      <div className="row" style={{ gap: 10 }}>
                        <span className="ring" data-v={pct == null ? gb(l.dataUsedMb) : `${pct}%`} style={{ background: `conic-gradient(${color} ${(pct ?? 0)}%, var(--lmx-chip) 0)` }} />
                        <div><b style={{ fontSize: 12.5 }}>{l.plan?.name ?? "No plan"}</b><div className="dimtx small">{gb(l.dataUsedMb)} used · {l.sim?.type === "esim" ? "eSIM" : l.sim?.type === "physical" ? "SIM" : "no SIM"}</div></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="stack">
          <div className="lcard">
            <div className="lcard-h"><h3>Next invoice</h3><span className="pill info nub">Estimate</span></div>
            <div style={{ fontSize: 26, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{money(nextInvoice.totalCents)}</div>
            <div className="dimtx small" style={{ marginTop: 2 }}>Bills {new Date(nextInvoice.billsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · {nextInvoice.lineCount} billable line{nextInvoice.lineCount === 1 ? "" : "s"}</div>
            {nextInvoice.items.length > 0 ? (
              <div className="twrap" style={{ marginTop: 12 }}>
                <table className="t"><tbody>
                  {nextInvoice.items.slice(0, 6).map((it, i) => (
                    <tr key={i}><td style={{ fontSize: 12.5 }}>{it.description}</td><td className="num">{money(it.amountCents)}</td></tr>
                  ))}
                </tbody></table>
              </div>
            ) : <p className="dimtx small" style={{ marginTop: 10 }}>Nothing billable yet this cycle.</p>}
            <div className="row" style={{ marginTop: 12 }}><button className="lbtn sm" onClick={() => go("/mobile/billing")}>Billing →</button></div>
          </div>

          <div className="lcard">
            <div className="lcard-h"><h3>Recent activity</h3></div>
            {activity.length === 0 ? (
              <p className="dimtx small">Activity on your mobile service shows here — installs, pauses, plan changes, transfers.</p>
            ) : (
              <div className="tl">
                {activity.slice(0, 8).map((a, i) => (
                  <div key={i} className="tlrow">
                    <span className={`ti ${a.action.includes("lost") || a.action.includes("spike") ? "warn" : a.action.includes("suspend") || a.action.includes("terminate") ? "bad" : "ok"}`}>•</span>
                    <div><b>{activityLabel(a.action)}</b></div>
                    <time>{fmtDateTime(a.createdAt)}</time>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
