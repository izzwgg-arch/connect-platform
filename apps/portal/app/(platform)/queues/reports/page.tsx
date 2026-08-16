"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, BarChart3 } from "lucide-react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiPost } from "../../../../services/apiClient";
import { formatDuration, formatDurationLong } from "../queueBoard";

/**
 * Queue reports — the detailed view.
 *
 * ⛔ The single most important behaviour on this screen is what it does when
 * the data ISN'T available. Queue history lives in the PBX's `asterisk` schema,
 * which Connect is not granted by default. If that read fails we must say so
 * in plain words. Rendering zeroes would read as "this customer had no calls",
 * which is a confident lie about a busy queue.
 */

type WaitBucket = { label: string; upToSec: number | null; count: number };

type QueueReport = {
  logName: string;
  extension: string;
  name: string;
  outcomes: {
    offered: number;
    answered: number;
    abandoned: number;
    timedOut: number;
    exitedWithKey: number;
    ringNoAnswer: number;
    answeredPct: number | null;
    abandonedPct: number | null;
    timedOutPct: number | null;
  };
  avgWaitSec: number | null;
  maxWaitSec: number | null;
  avgTalkSec: number | null;
  maxTalkSec: number | null;
  totalTalkSec: number;
  avgAbandonWaitSec: number | null;
  maxAbandonWaitSec: number | null;
  serviceLevelPct: number | null;
  serviceLevelTargetSec: number;
  serviceLevelTargetSource: "queue_config" | "default";
  answeredWaitBuckets: WaitBucket[];
  abandonWaitBuckets: WaitBucket[];
};

type AgentReport = {
  agent: string;
  logName: string;
  callsTaken: number;
  avgTalkSec: number | null;
  maxTalkSec: number | null;
  totalTalkSec: number;
  avgCallerWaitSec: number | null;
  sharePct: number | null;
  lastCallAt: string | null;
};

type TimeBucketRow = { bucket: string; offered: number; answered: number; abandoned: number };

type ReportsResponse =
  | {
      available: true;
      rangeStart: string;
      rangeEnd: string;
      queues: QueueReport[];
      agents: AgentReport[];
      byHour: TimeBucketRow[];
      byDate: TimeBucketRow[];
      byWeekday: TimeBucketRow[];
      idleMembers: Array<{ logName: string; extension: string; name: string | null }>;
    }
  | { available: false; reason: string; detail: string; queues: [] };

const RANGES = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

function QueueReportsPageInner() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<ReportsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    apiPost<ReportsResponse>("/voice/queues/reports", { days })
      .then(setData)
      .catch((e: any) => setError(e?.body?.detail || e?.message || "Could not load queue reports."))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const available = data?.available === true ? data : null;

  return (
    <div className="qb-page">
      <header className="qb-head">
        <div className="qb-head-main">
          <h1 className="qb-title">
            <BarChart3 size={22} aria-hidden /> Queue reports
          </h1>
          <p className="qb-sub">
            {available
              ? `${available.rangeStart} to ${available.rangeEnd} · times shown on the phone system's own clock`
              : "How each queue and each agent has been performing."}
          </p>
        </div>
        <div className="qb-head-actions">
          <div className="qb-segmented" role="group" aria-label="Report range">
            {RANGES.map((r) => (
              <button
                key={r.days}
                type="button"
                className={`qb-seg ${days === r.days ? "is-on" : ""}`}
                aria-pressed={days === r.days}
                onClick={() => setDays(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <Link href="/queues" className="qb-btn">
            <ArrowLeft size={15} aria-hidden /> Live view
          </Link>
        </div>
      </header>

      {loading && <p className="qb-empty">Loading reports…</p>}
      {error && <p className="qb-notice qb-notice-warn">{error}</p>}

      {!loading && data && data.available === false && <Unavailable reason={data.reason} detail={data.detail} />}

      {available && (
        <>
          {available.queues.map((q) => (
            <QueueReportCard key={q.logName} q={q} />
          ))}

          {available.idleMembers.length > 0 && (
            <section className="qb-panel qb-panel-alert">
              <h2 className="qb-panel-h">
                <AlertTriangle size={16} aria-hidden /> On a queue, but answered nothing
                <span className="qb-count">{available.idleMembers.length}</span>
              </h2>
              <p className="qb-foot qb-foot-top">
                These extensions are configured members of a queue but took no calls from it in this
                period. They are members on paper only.
              </p>
              <ul className="qb-idle">
                {available.idleMembers.map((m) => (
                  <li key={`${m.logName}:${m.extension}`}>
                    <span className="qb-ext">{m.extension}</span>
                    {m.name && <span className="qb-dim"> {m.name}</span>}
                    <span className="qb-dim"> — {m.logName.replace(/^T\d+_Q/, "queue ")}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <AgentTable agents={available.agents} queues={available.queues} />

          <HourChart rows={available.byHour} />

          <TrendTable title="By day" rows={available.byDate} />
          <TrendTable title="By day of the week" rows={available.byWeekday} />
        </>
      )}
    </div>
  );
}

function Unavailable({ reason, detail }: { reason: string; detail: string }) {
  const isGrant = reason === "queue_log_access_denied";
  return (
    <section className="qb-panel qb-panel-alert">
      <h2 className="qb-panel-h">
        <AlertTriangle size={16} aria-hidden /> Queue history isn&rsquo;t connected yet
      </h2>
      <p className="qb-foot qb-foot-top">{detail}</p>
      {isGrant && (
        <>
          <p className="qb-foot">
            Live queue status works without this — only the historical reports need it. Nothing is
            broken and no calls are missing; Connect simply hasn&rsquo;t been given permission to read
            the phone system&rsquo;s queue log.
          </p>
          <pre className="qb-code">
{`GRANT SELECT ON \`asterisk\`.\`queues_log\`
  TO 'connect_read'@'45.14.194.179';
FLUSH PRIVILEGES;`}
          </pre>
        </>
      )}
      <p className="qb-foot">
        <Link href="/queues" className="qb-link">Back to live queue status</Link>
      </p>
    </section>
  );
}

function QueueReportCard({ q }: { q: QueueReport }) {
  const o = q.outcomes;
  const tone = (o.answeredPct ?? 0) >= 85 ? "ok" : (o.answeredPct ?? 0) >= 60 ? "warn" : "crit";
  const health =
    tone === "ok" ? { symbol: "✓", label: "Healthy" }
    : tone === "warn" ? { symbol: "⚠", label: "Needs attention" }
    : { symbol: "⚠", label: "Losing callers" };

  return (
    <section className="qb-panel">
      <h2 className="qb-panel-h">
        {q.name}
        <span className="qb-dim qb-panel-sub">{q.extension}</span>
        <span className={`qb-badge qb-badge-${tone} qb-badge-end`}>
          <span aria-hidden>{health.symbol}</span> {health.label}
        </span>
      </h2>

      <div className="qb-report-top">
        <div className="qb-meterblock">
          <div className="qb-meterlabel">
            <span>Answered</span>
            <span className="qb-meterpct">{o.answeredPct != null ? `${o.answeredPct}%` : "—"}</span>
          </div>
          <div className="qb-meter">
            <div className={`qb-meter-fill qb-fill-${tone}`} style={{ width: `${o.answeredPct ?? 0}%` }} />
          </div>
          <p className="qb-meterfoot">
            {o.answered.toLocaleString()} answered of {o.offered.toLocaleString()} offered
            {o.timedOut > 0 && <> · <strong className="qb-crit">{o.timedOut.toLocaleString()} timed out</strong></>}
            {o.abandoned > 0 && <> · {o.abandoned.toLocaleString()} hung up</>}
            {o.exitedWithKey > 0 && <> · {o.exitedWithKey} pressed a key to leave</>}
          </p>
        </div>

        <dl className="qb-facts">
          <Fact k="Average wait" v={q.avgWaitSec != null ? formatDurationLong(q.avgWaitSec) : "—"} />
          <Fact k="Average talk" v={q.avgTalkSec != null ? formatDurationLong(q.avgTalkSec) : "—"} />
          <Fact k="Total talk time" v={formatDurationLong(q.totalTalkSec)} />
          <Fact
            k={`Answered within ${q.serviceLevelTargetSec}s`}
            v={q.serviceLevelPct != null ? `${q.serviceLevelPct}%` : "—"}
            note={q.serviceLevelTargetSource === "default" ? "Connect's default target — this queue has none set" : "target set on the queue"}
          />
          <Fact
            k="Average wait before hanging up"
            v={q.avgAbandonWaitSec != null ? formatDurationLong(q.avgAbandonWaitSec) : "—"}
          />
          <Fact
            k="Longest wait"
            v={q.maxWaitSec != null ? formatDurationLong(q.maxWaitSec) : "—"}
            note="a single outlier can dominate this — see the spread below"
          />
        </dl>
      </div>

      <div className="qb-buckets">
        <BucketBar title="How long answered callers waited" buckets={q.answeredWaitBuckets} tone="ok" />
        <BucketBar title="How long callers waited before hanging up" buckets={q.abandonWaitBuckets} tone="crit" />
      </div>

      {o.ringNoAnswer > 0 && (
        <p className="qb-foot">
          {o.ringNoAnswer.toLocaleString()} unanswered rings were logged. This is normal and is{" "}
          <strong>not</strong> a count of missed calls: when a queue rings everyone at once, every
          agent who doesn&rsquo;t get there first logs one on every call.
        </p>
      )}
    </section>
  );
}

function Fact({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <div className="qb-fact">
      <dt>{k}</dt>
      <dd>
        {v}
        {note && <span className="qb-factnote">{note}</span>}
      </dd>
    </div>
  );
}

function BucketBar({ title, buckets, tone }: { title: string; buckets: WaitBucket[]; tone: string }) {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  return (
    <div className="qb-bucketblock">
      <h3 className="qb-bucket-t">{title}</h3>
      {total === 0 ? (
        <p className="qb-empty qb-empty-inline">None in this period.</p>
      ) : (
        <ul className="qb-bucketlist">
          {buckets.map((b) => {
            const pctOf = total > 0 ? Math.round((b.count / total) * 100) : 0;
            return (
              <li key={b.label}>
                <span className="qb-bucket-k">{b.label}</span>
                <span className="qb-bucket-track">
                  <span className={`qb-bucket-fill qb-fill-${tone}`} style={{ width: `${pctOf}%` }} />
                </span>
                <span className="qb-bucket-v">
                  {b.count.toLocaleString()}
                  <span className="qb-dim"> ({pctOf}%)</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AgentTable({ agents, queues }: { agents: AgentReport[]; queues: QueueReport[] }) {
  const queueName = useMemo(() => {
    const m = new Map(queues.map((q) => [q.logName, q.name]));
    return (logName: string) => m.get(logName) ?? logName;
  }, [queues]);

  if (agents.length === 0) {
    return (
      <section className="qb-panel">
        <h2 className="qb-panel-h">Agents</h2>
        <p className="qb-empty qb-empty-inline">No agent answered a queue call in this period.</p>
      </section>
    );
  }

  return (
    <section className="qb-panel">
      <h2 className="qb-panel-h">
        Agents<span className="qb-count">{agents.length}</span>
      </h2>
      <div className="qb-tablewrap">
        <table className="qb-table">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Queue</th>
              <th scope="col" className="qb-r">Calls taken</th>
              <th scope="col" className="qb-r">Avg talk</th>
              <th scope="col" className="qb-r">Longest call</th>
              <th scope="col" className="qb-r">Total on calls</th>
              <th scope="col" className="qb-r">Avg wait before pickup</th>
              <th scope="col">Share of queue</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={`${a.logName}:${a.agent}`}>
                <td><span className="qb-ext">{a.agent}</span></td>
                <td className="qb-dim">{queueName(a.logName)}</td>
                <td className="qb-num qb-r qb-strong">{a.callsTaken.toLocaleString()}</td>
                <td className="qb-num qb-r">{formatDuration(a.avgTalkSec)}</td>
                <td className="qb-num qb-r">{formatDuration(a.maxTalkSec)}</td>
                <td className="qb-num qb-r">{formatDurationLong(a.totalTalkSec)}</td>
                <td className="qb-num qb-r">{formatDuration(a.avgCallerWaitSec)}</td>
                <td>
                  <span className="qb-inlinemeter">
                    <span className="qb-meter qb-meter-sm">
                      <span
                        className={`qb-meter-fill ${(a.sharePct ?? 0) >= 40 ? "qb-fill-warn" : "qb-fill-info"}`}
                        style={{ width: `${a.sharePct ?? 0}%` }}
                      />
                    </span>
                    <span className="qb-num">{a.sharePct != null ? `${a.sharePct}%` : "—"}</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="qb-foot">
        A share far above the others means one person is carrying the queue — worth knowing before
        they take a day off.
      </p>
    </section>
  );
}

function HourChart({ rows }: { rows: TimeBucketRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.offered));
  if (rows.length === 0) return null;
  return (
    <section className="qb-panel">
      <h2 className="qb-panel-h">Calls by hour of the day</h2>
      <p className="qb-foot qb-foot-top">
        When the calls actually arrive. Staffing that is flat across the day will show up here as
        waits that build at the peak.
      </p>
      <div className="qb-chart">
        {rows.map((r) => {
          const h = Math.round((r.offered / max) * 100);
          return (
            <div key={r.bucket} className="qb-barcol" title={`${r.bucket} — ${r.offered} offered, ${r.answered} answered`}>
              <span className="qb-barv">{r.offered}</span>
              <span className="qb-bar" style={{ height: `${Math.max(2, h)}%` }} />
              <span className="qb-barx">{r.bucket}</span>
            </div>
          );
        })}
      </div>
      <details className="qb-details">
        <summary>Show these figures as a table</summary>
        <div className="qb-tablewrap">
          <table className="qb-table">
            <thead>
              <tr>
                <th scope="col">Hour</th>
                <th scope="col" className="qb-r">Offered</th>
                <th scope="col" className="qb-r">Answered</th>
                <th scope="col" className="qb-r">Hung up</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.bucket}>
                  <td className="qb-num">{r.bucket}</td>
                  <td className="qb-num qb-r">{r.offered}</td>
                  <td className="qb-num qb-r">{r.answered}</td>
                  <td className="qb-num qb-r">{r.abandoned}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function TrendTable({ title, rows }: { title: string; rows: TimeBucketRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="qb-panel">
      <h2 className="qb-panel-h">{title}</h2>
      <div className="qb-tablewrap">
        <table className="qb-table">
          <thead>
            <tr>
              <th scope="col">{title === "By day" ? "Date" : "Day"}</th>
              <th scope="col" className="qb-r">Offered</th>
              <th scope="col" className="qb-r">Answered</th>
              <th scope="col" className="qb-r">Hung up</th>
              <th scope="col" className="qb-r">Answered %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = r.offered > 0 ? Math.round((r.answered / r.offered) * 1000) / 10 : null;
              return (
                <tr key={r.bucket}>
                  <td className="qb-num">{r.bucket}</td>
                  <td className="qb-num qb-r">{r.offered}</td>
                  <td className="qb-num qb-r">{r.answered}</td>
                  <td className="qb-num qb-r">{r.abandoned}</td>
                  <td className={`qb-num qb-r ${pct != null && pct < 60 ? "qb-crit" : ""}`}>
                    {pct != null ? `${pct}%` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * ⛔ The page gates itself. Hiding the sidebar item is presentation, not
 * access — without this a link, a bookmark or a typed URL would still render
 * the screen for somebody whose role has it switched off.
 */
export default function QueueReportsPage() {
  return (
    <PermissionGate
      permission={"can_view_queue_reports" as never}
      fallback={
        <div className="qb-page">
          <p className="qb-notice qb-notice-warn">Queue reports are switched off for your account.</p>
        </div>
      }
    >
      <QueueReportsPageInner />
    </PermissionGate>
  );
}
