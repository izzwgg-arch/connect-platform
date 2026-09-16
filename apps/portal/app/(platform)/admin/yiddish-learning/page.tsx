"use client";
/**
 * Yiddish Learning Engine — Learning Dashboard (mockup screen 1).
 *
 * Everything on this page is GET /admin/yiddish/dashboard (YcDashboardView).
 * ⛔ No figure is computed from anything but that payload: the governance
 * chart sums the audio hours the API reported per source, and nothing else on
 * the screen derives, estimates or fills in a number. When the call fails the
 * page says so and shows nothing in its place.
 *
 * Access: presentation gate only — the real fences are the SUPER_ADMIN force
 * line in navConfig.isNavItemVisibleForUser and requireSuperAdmin on the api.
 */
import { useMemo } from "react";
import Link from "next/link";
import { useAppContext } from "../../../../hooks/useAppContext";
import {
  Bars,
  Card,
  CustomerWallCard,
  EligibilityChip,
  EmptyState,
  GovernanceChip,
  Kpi,
  OwnerOnlyNotice,
  PageHead,
  Resource,
  ServingOnlyChip,
  TableWrap,
  YC_API_PREFIX,
  YiddishPage,
  fmtDateTime,
  hours,
  num,
  titleCase,
  useApi,
  type YcDashboardView,
} from "./YiddishUi";

const GOV_ORDER = ["PLATFORM", "EXTERNAL", "CUSTOMER_PRIVATE"] as const;

export default function YiddishLearningDashboardPage() {
  const { role } = useAppContext();
  const state = useApi<YcDashboardView>(`${YC_API_PREFIX}/dashboard`);

  if (role !== "SUPER_ADMIN") return <OwnerOnlyNotice title="Yiddish Learning" />;

  return (
    <YiddishPage>
      <PageHead
        title="Learning Dashboard"
        subtitle="What the engine knows, where it came from, and what it is allowed to use."
        actions={
          <button className="lbtn sm" onClick={state.reload}>
            Refresh
          </button>
        }
      />
      <Resource state={state} what="The learning dashboard" skeletonRows={5}>
        {(d) => <DashboardBody d={d} />}
      </Resource>
    </YiddishPage>
  );
}

function DashboardBody({ d }: { d: YcDashboardView }) {
  const c = d.corpus ?? ({} as YcDashboardView["corpus"]);
  const sources = Array.isArray(d.sources) ? d.sources : [];
  const walled = Array.isArray(d.walled) ? d.walled : [];
  const queue = Array.isArray(d.queue) ? d.queue : [];
  const findings = Array.isArray(d.recentFindings) ? d.recentFindings : [];
  const series = Array.isArray(d.series) ? d.series : [];

  /** Hours per governance class — a sum of the per-source hours the API gave. */
  const govRows = useMemo(() => {
    const totals = new Map<string, number>();
    for (const s of sources) totals.set(s.governanceClass, (totals.get(s.governanceClass) ?? 0) + Number(s.audioHours ?? 0));
    for (const w of walled) if (w.hours != null) totals.set("CUSTOMER_PRIVATE", (totals.get("CUSTOMER_PRIVATE") ?? 0) + Number(w.hours));
    return GOV_ORDER.filter((k) => totals.has(k)).map((k) => ({
      label: k === "CUSTOMER_PRIVATE" ? "Customer-private (walled)" : titleCase(k),
      value: totals.get(k) ?? 0,
      display: hours(totals.get(k) ?? 0),
      tone: k === "CUSTOMER_PRIVATE" ? ("bad" as const) : undefined,
    }));
  }, [sources, walled]);

  /** The metric lines the API actually sent, latest value per metric. */
  const seriesMetrics = useMemo(() => {
    const byMetric = new Map<string, { day: string; value: number }[]>();
    for (const p of series) {
      const list = byMetric.get(p.metric) ?? [];
      list.push({ day: p.day, value: Number(p.value) });
      byMetric.set(p.metric, list);
    }
    return [...byMetric.entries()].map(([metric, pts]) => {
      const sorted = pts.slice().sort((a, b) => a.day.localeCompare(b.day));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      return { metric, points: sorted.length, first, last, delta: last && first ? last.value - first.value : null };
    });
  }, [series]);

  return (
    <>
      <div className="kpis k6">
        <Kpi label="Corpus items" value={num(c.items)} sub={`${hours(c.audioHours)} of audio`} />
        <Kpi label="Transcripts" value={num(c.transcripts)} sub={`${num(c.translations)} translations`} />
        <Kpi label="Aligned pairs" value={num(c.pairs)} />
        <Kpi label="Lexemes" value={num(c.lexemes)} sub={`${num(c.observations)} observations`} />
        <Kpi label="Rules" value={num(c.rules)} sub={`${num(c.openConflicts)} open conflicts`} tone={Number(c.openConflicts) > 0 ? "warn" : undefined} />
        <Kpi label="Speaker clusters" value={num(c.speakerClusters)} sub={`${num(c.benchmarkCases)} benchmark cases`} />
      </div>

      <div className="g2">
        <Card
          title="Audio hours by governance class"
          sub="Summed from what each source reported. Customer-private hours are counted here and read nowhere."
        >
          {govRows.length === 0 ? (
            <EmptyState
              title="No audio hours reported"
              text="No source has reported any audio hours yet. This is the engine's answer, not a placeholder."
            />
          ) : (
            <Bars rows={govRows} />
          )}
        </Card>

        <Card title="Worker" sub="Bulk analysis, alignment and clustering run off the call server.">
          {d.worker ? (
            <>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className={`pill ${d.worker.alive ? "ok" : "bad"}`}>{d.worker.alive ? "Alive" : "Not running"}</span>
                <span className="dimtx small">Last tick {fmtDateTime(d.worker.lastTickAt)}</span>
                <span className="dimtx small">· {num(d.worker.leasedJobs)} leased jobs</span>
              </div>
              {d.worker.note ? <div className="small dimtx" style={{ lineHeight: 1.6 }}>{d.worker.note}</div> : null}
            </>
          ) : (
            <span className="dimtx small">The dashboard payload carried no worker heartbeat.</span>
          )}

          <div className="seclbl" style={{ marginTop: 14 }}>
            Processing queue
          </div>
          {queue.length === 0 ? (
            <span className="dimtx small">The queue is empty — no jobs in any state.</span>
          ) : (
            <TableWrap>
              <table className="t">
                <thead>
                  <tr>
                    <th>State</th>
                    <th className="num">Items</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((q) => (
                    <tr key={q.state}>
                      <td>{titleCase(q.state)}</td>
                      <td className="num">{num(q.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>
      </div>

      <div className="g2" style={{ marginTop: 14 }}>
        <Card
          title="Sources"
          sub="Every record inherits its source's governance class and training eligibility."
          right={
            <Link className="lbtn sm" href="/admin/yiddish-learning/sources">
              Manage sources
            </Link>
          }
        >
          {sources.length === 0 ? (
            <EmptyState title="No sources registered" text="The engine has no source adapters registered yet." />
          ) : (
            <TableWrap>
              <table className="t">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Class</th>
                    <th>Training use</th>
                    <th className="num">Items</th>
                    <th className="num">Audio</th>
                    <th>Audio stages</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.key}>
                      <td>
                        <b>{s.name}</b>
                        <span className="sub">{s.key}</span>
                      </td>
                      <td>
                        <GovernanceChip value={s.governanceClass} />
                      </td>
                      <td>
                        <EligibilityChip value={s.trainingExportEligibility} />
                        {s.key.includes("yiddishlabs") || s.key === "voicelab" ? (
                          <div style={{ marginTop: 4 }}>
                            <ServingOnlyChip />
                          </div>
                        ) : null}
                      </td>
                      <td className="num">{num(s.itemCount)}</td>
                      <td className="num">{hours(s.audioHours)}</td>
                      <td>
                        {s.audioBlockedReason ? (
                          <span className="pill bad" title={s.audioBlockedReason}>
                            Blocked
                          </span>
                        ) : (
                          <span className="pill ok">Permitted</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <CustomerWallCard rows={walled} />
      </div>

      <div className="g2" style={{ marginTop: 14 }}>
        <Card title="Learning over time" sub="From the engine's own metric snapshots — one line per metric it records.">
          {seriesMetrics.length === 0 ? (
            <EmptyState
              title="No snapshots recorded yet"
              text="The engine has written no metric snapshots, so there is nothing to plot. No curve is drawn from an assumption."
            />
          ) : (
            <TableWrap>
              <table className="t">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th className="num">Points</th>
                    <th>First</th>
                    <th>Latest</th>
                    <th className="num">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {seriesMetrics.map((m) => (
                    <tr key={m.metric}>
                      <td>{titleCase(m.metric)}</td>
                      <td className="num">{num(m.points)}</td>
                      <td className="dimtx small">
                        {m.first ? `${m.first.day} · ${num(m.first.value)}` : "—"}
                      </td>
                      <td>{m.last ? `${m.last.day} · ${num(m.last.value)}` : "—"}</td>
                      <td className="num">{m.delta == null ? "—" : (m.delta >= 0 ? "+" : "") + num(m.delta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Card>

        <Card
          title="Current voice profile"
          sub="From the Voice Lab evaluation module."
          right={
            <Link className="lbtn sm" href="/admin/yiddish-learning/benchmark">
              Benchmark
            </Link>
          }
        >
          {d.profile ? (
            <dl className="dl">
              <div>
                <dt>Profile</dt>
                <dd>{d.profile.key}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>v{num(d.profile.version)}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <span className="pill dim">{titleCase(d.profile.status)}</span>
                </dd>
              </div>
              <div>
                <dt>Mean human rating</dt>
                <dd>
                  {d.profile.meanRating == null ? (
                    <span className="dimtx">Not rated</span>
                  ) : (
                    `${d.profile.meanRating.toFixed(2)} (n=${num(d.profile.n)})`
                  )}
                </dd>
              </div>
            </dl>
          ) : (
            <EmptyState
              title="No voice profile is in use"
              text="Nothing has been frozen as a profile version yet, so there is no baseline to compare against."
            />
          )}
        </Card>
      </div>

      <Card
        title="Recent discoveries"
        sub="Statements the engine has proposed. A discovery is an observation, never an applied rule."
        className=""
      >
        {findings.length === 0 ? (
          <EmptyState
            title="No discoveries yet"
            text="The engine has recorded no findings. Discoveries come from processed evidence; none has been produced."
          />
        ) : (
          <TableWrap>
            <table className="t">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Statement</th>
                  <th>Status</th>
                  <th>Recorded</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f) => (
                  <tr key={f.id}>
                    <td>{titleCase(f.kind)}</td>
                    <td>{f.statement}</td>
                    <td>
                      <span className="pill dim">{titleCase(f.status)}</span>
                    </td>
                    <td className="dimtx small">{fmtDateTime(f.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
