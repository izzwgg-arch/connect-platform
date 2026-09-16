"use client";
/**
 * Creative Studio — the platform console. SUPER_ADMIN only.
 *
 * Follows the Mobile Console pattern: one sidebar item, chip tabs, one view
 * component per tab, everything read from /admin/creative/*. It shows counts,
 * cost and timings across every company — and deliberately never a customer's
 * prompt, picture or project.
 */
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../../../components/PageHeader";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiGet, apiPatch, apiPost, apiPut } from "../../../../services/apiClient";
import { Card, EmptyState, LoadingCard, Note, Pill, errText, fmtWhen, money } from "../../creative/CreativeUi";

const TABS = ["Overview", "Engines", "Workers", "Jobs", "Usage", "Limits", "Audit"] as const;
type Tab = (typeof TABS)[number];

export default function CreativeConsolePage() {
  const { role } = useAppContext() as any;
  const [tab, setTab] = useState<Tab>("Overview");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  const endpoint: Record<Tab, string> = {
    Overview: "/admin/creative/overview",
    Engines: "/admin/creative/engines",
    Workers: "/admin/creative/workers",
    Jobs: "/admin/creative/jobs?limit=60",
    Usage: "/admin/creative/usage",
    Limits: "/admin/creative/quotas",
    Audit: "/admin/creative/audit?limit=80",
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await apiGet(endpoint[tab]);
      setData(res);
      setErr("");
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  if (role !== "SUPER_ADMIN") {
    return (
      <div className="cse">
        <PageHeader title="Creative Console" subtitle="Platform staff only." />
        <EmptyState title="This screen is for Loopcom staff" text="It shows every company's jobs and spend." />
      </div>
    );
  }

  const toggleEngine = async (id: string, body: any) => {
    try {
      await apiPatch(`/admin/creative/engines/${id}`, body);
      setNote("Saved.");
      load();
    } catch (e: any) {
      // The licence gate answers here when an engine may not be sold with.
      setErr(errText(e));
    }
  };

  const retry = async (id: string) => {
    try {
      await apiPost(`/admin/creative/jobs/${id}/retry`, {});
      load();
    } catch (e: any) {
      setErr(errText(e));
    }
  };

  const saveQuota = async (tenantId: string, quota: any) => {
    try {
      await apiPut(`/admin/creative/quotas/${tenantId}`, quota);
      setNote("Limits saved.");
      load();
    } catch (e: any) {
      setErr(errText(e));
    }
  };

  return (
    <div className="cse">
      <PageHeader title="Creative Console" subtitle="Jobs, engines, workers, spend and the audit trail, across every company." />

      <div className="cse-chips" style={{ margin: "12px 0" }}>
        {TABS.map((t) => (
          <button key={t} type="button" className={`cse-chip ${tab === t ? "on" : ""}`} onClick={() => { setTab(t); setNote(""); setErr(""); }}>
            {t}
          </button>
        ))}
      </div>

      {err ? <Note kind="bad">{err}</Note> : null}
      {note ? <Note kind="ok">{note}</Note> : null}

      {loading ? (
        <LoadingCard rows={4} />
      ) : tab === "Overview" ? (
        <>
          <div className="cse-kpis" style={{ marginBottom: 14 }}>
            {[
              ["Jobs today", String(data?.jobs?.today ?? 0), `${data?.jobs?.running ?? 0} running, ${data?.jobs?.queued ?? 0} queued`],
              ["Spend this month", money(data?.spend?.monthMicros), `${money(data?.spend?.todayMicros)} today`],
              ["Median render", `${Math.round((data?.timing?.medianMs || 0) / 100) / 10}s`, `95th: ${Math.round((data?.timing?.p95Ms || 0) / 100) / 10}s`],
              ["Failed today", String(data?.jobs?.failedToday ?? 0), `${Math.round((data?.jobs?.failureRate || 0) * 1000) / 10}% of jobs`],
            ].map(([l, v, d]) => (
              <div key={l} className="cse-kpi">
                <span className="l">{l}</span>
                <span className="v">{v}</span>
                <span className="d">{d}</span>
              </div>
            ))}
          </div>
          <div className="cse-grid g2">
            <Card title="Engines">
              <div className="cse-stack" style={{ gap: 7 }}>
                {(data?.engines || []).map((e: any) => (
                  <div key={e.id} className="cse-row">
                    <Pill kind={e.enabled ? "ok" : "nub"}>{e.enabled ? "on" : "off"}</Pill>
                    <b style={{ fontSize: 12.5, flex: 1 }}>{e.label}</b>
                    <span className="cse-help">{e.placement}</span>
                  </div>
                ))}
              </div>
            </Card>
            <Card title="Needs a look">
              {(data?.recentFailures || []).length ? (
                <div className="cse-stack" style={{ gap: 7 }}>
                  {data.recentFailures.map((f: any) => (
                    <div key={f.id} className="cse-row" style={{ alignItems: "flex-start" }}>
                      <Pill kind="bad">{f.errorCode || "failed"}</Pill>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12.5 }}>{f.capability}</div>
                        <div className="cse-help">{f.error}</div>
                      </div>
                      <span className="cse-help">{fmtWhen(f.finishedAt)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title="Nothing failing" text="No failed jobs in the last day." />
              )}
            </Card>
          </div>
        </>
      ) : tab === "Engines" ? (
        <Card title="Engines and providers" sub="An engine whose licence forbids commercial use cannot be switched on at all">
          <div className="cse-twrap">
            <table className="cse-t">
              <thead>
                <tr><th>Engine</th><th>Does</th><th>Licence</th><th>Sell with it?</th><th className="r">Runs (30d)</th><th className="r">Avg</th><th className="r">Cost</th><th>On</th><th>Default</th></tr>
              </thead>
              <tbody>
                {(data?.engines || []).map((e: any) => (
                  <tr key={e.id}>
                    <td><b>{e.label}</b><div className="cse-help cse-mono">{e.model}</div></td>
                    <td className="cse-muted">{(e.capabilities || []).join(", ")}</td>
                    <td className="cse-muted">{e.license}</td>
                    <td>{e.commercialOk ? <Pill kind="ok">Yes</Pill> : <Pill kind="bad">No</Pill>}</td>
                    <td className="r">{e.stats?.runs ?? 0}</td>
                    <td className="r">{e.stats?.avgMs ? `${Math.round(e.stats.avgMs / 100) / 10}s` : "—"}</td>
                    <td className="r">{money(e.stats?.costMicros)}</td>
                    <td>
                      <button type="button" className={`cse-btn sm ${e.enabled ? "" : "ghost"}`} disabled={!e.commercialOk} onClick={() => toggleEngine(e.id, { enabled: !e.enabled })}>
                        {e.enabled ? "On" : "Off"}
                      </button>
                    </td>
                    <td>{e.isDefault ? <Pill kind="info">Default</Pill> : <button type="button" className="cse-btn sm ghost" disabled={!e.enabled} onClick={() => toggleEngine(e.id, { isDefault: true })}>Make default</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : tab === "Workers" ? (
        <div className="cse-grid g3">
          {(data?.workers || []).map((w: any) => (
            <Card key={w.id} title={w.id} sub={`${w.pool} · ${w.kind}`} end={<Pill kind={w.live ? "ok" : "bad"}>{w.live ? "alive" : "silent"}</Pill>}>
              <div className="cse-stack" style={{ gap: 6, fontSize: 12.5 }}>
                <div className="cse-row"><span className="cse-muted">Heartbeat</span><span style={{ marginLeft: "auto" }}>{fmtWhen(w.lastHeartbeatAt)}</span></div>
                <div className="cse-row"><span className="cse-muted">Doing</span><span style={{ marginLeft: "auto" }}>{w.currentJobId || "nothing"}</span></div>
                <div className="cse-row"><span className="cse-muted">Version</span><span className="cse-mono" style={{ marginLeft: "auto" }}>{String(w.version || "—").slice(0, 12)}</span></div>
              </div>
            </Card>
          ))}
          {!(data?.workers || []).length ? <EmptyState title="No workers yet" text="The API registers itself as a worker on boot." /> : null}
        </div>
      ) : tab === "Jobs" ? (
        <Card title="Jobs" sub="Every company">
          <div className="cse-twrap">
            <table className="cse-t">
              <thead><tr><th>Job</th><th>Company</th><th>Kind</th><th>State</th><th>Where</th><th className="r">Cost</th><th></th></tr></thead>
              <tbody>
                {(data?.jobs || []).map((j: any) => (
                  <tr key={j.id}>
                    <td className="cse-mono">{j.id.slice(-6)}</td>
                    <td>{j.tenantName}</td>
                    <td className="cse-muted">{j.capability}</td>
                    <td><Pill kind={j.status === "succeeded" ? "ok" : j.status === "failed" ? "bad" : j.status === "queued" ? "warn" : "info"}>{j.status}</Pill></td>
                    <td className="cse-muted">{j.note || (j.error ? j.error.slice(0, 40) : `${j.progress}%`)}</td>
                    <td className="r">{money(j.costMicros)}</td>
                    <td className="r">{["failed", "cancelled"].includes(j.status) ? <button type="button" className="cse-btn sm" onClick={() => retry(j.id)}>Retry</button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : tab === "Usage" ? (
        <div className="cse-grid g2">
          <Card title="By company" sub={`Period ${data?.period || ""}`}>
            <div className="cse-twrap">
              <table className="cse-t">
                <thead><tr><th>Company</th><th className="r">Events</th><th className="r">Cost</th></tr></thead>
                <tbody>
                  {(data?.byTenant || []).map((t: any) => (
                    <tr key={t.tenantId}><td>{t.tenantName}</td><td className="r">{t.events}</td><td className="r">{money(t.costMicros)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="What we counted">
            <div className="cse-twrap">
              <table className="cse-t">
                <thead><tr><th>Measure</th><th className="r">Quantity</th><th className="r">Cost</th></tr></thead>
                <tbody>
                  {(data?.byMeasure || []).map((m: any) => (
                    <tr key={m.measure}><td>{m.measure.replace(/_/g, " ")}</td><td className="r">{Math.round(m.quantity)}</td><td className="r">{money(m.costMicros)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Note kind="info"><div>Wasted on cancels and retries: <b>{money(data?.wastedMicros)}</b>.</div></Note>
          </Card>
        </div>
      ) : tab === "Limits" ? (
        <Card title="What each company may use each month" sub="No row means the platform default">
          <div className="cse-twrap">
            <table className="cse-t">
              <thead><tr><th>Company</th><th className="r">Video seconds</th><th className="r">Used</th><th className="r">Images</th><th className="r">At once</th><th>Premium</th><th></th></tr></thead>
              <tbody>
                {(data?.tenants || []).map((t: any) => (
                  <QuotaRow key={t.tenantId} t={t} onSave={saveQuota} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <Card title="Audit" sub="People and the Coworker alike, successes and refusals">
          <div className="cse-twrap">
            <table className="cse-t">
              <thead><tr><th>When</th><th>Who</th><th>Company</th><th>What</th><th>Result</th></tr></thead>
              <tbody>
                {(data?.events || []).map((e: any) => (
                  <tr key={e.id}>
                    <td className="cse-muted">{fmtWhen(e.createdAt)}</td>
                    <td>{e.actorType === "coworker" ? <Pill kind="info">Coworker</Pill> : e.actorType}</td>
                    <td className="cse-muted">{e.tenantName}</td>
                    <td>{e.action}</td>
                    <td><Pill kind={e.result === "ok" ? "ok" : "bad"}>{e.result === "ok" ? "done" : "refused"}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function QuotaRow({ t, onSave }: { t: any; onSave: (tenantId: string, quota: any) => void }) {
  const [q, setQ] = useState(t.quota);
  const changed = JSON.stringify(q) !== JSON.stringify(t.quota);
  return (
    <tr>
      <td><b>{t.tenantName}</b></td>
      <td className="r">
        <input className="cse-input cse-num" style={{ width: 80, textAlign: "right" }} value={q.videoSeconds} onChange={(e) => setQ({ ...q, videoSeconds: Number(e.target.value) || 0 })} />
      </td>
      <td className="r">{t.used?.videoSeconds || 0}</td>
      <td className="r">
        <input className="cse-input cse-num" style={{ width: 90, textAlign: "right" }} value={q.images} onChange={(e) => setQ({ ...q, images: Number(e.target.value) || 0 })} />
      </td>
      <td className="r">
        <input className="cse-input cse-num" style={{ width: 60, textAlign: "right" }} value={q.maxConcurrent} onChange={(e) => setQ({ ...q, maxConcurrent: Number(e.target.value) || 1 })} />
      </td>
      <td>
        <button type="button" className={`cse-btn sm ${q.premiumEngines ? "" : "ghost"}`} onClick={() => setQ({ ...q, premiumEngines: !q.premiumEngines })}>
          {q.premiumEngines ? "Allowed" : "No"}
        </button>
      </td>
      <td className="r">
        <button type="button" className="cse-btn sm primary" disabled={!changed} onClick={() => onSave(t.tenantId, { videoSeconds: q.videoSeconds, images: q.images, storageGb: q.storageGb, maxConcurrent: q.maxConcurrent, premiumEngines: q.premiumEngines })}>
          Save
        </button>
      </td>
    </tr>
  );
}
