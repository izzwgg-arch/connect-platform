"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Activity, BarChart3, ListOrdered, RefreshCw, Tv, Users } from "lucide-react";
import {
  AGENT_STATE_META,
  describeStrategy,
  formatDuration,
  mergeAgentsAcrossQueues,
  useQueueBoard,
  type BoardQueue,
} from "./queueBoard";

/**
 * Queue status — the supervisor's screen.
 *
 * Distinct from the wall display on purpose: this one is operated (scrolled,
 * filtered, clicked through to reports), the wall one is only read. Merging
 * them would compromise both.
 */
export default function QueuesPage() {
  const { queues, loading, configError, live, reload } = useQueueBoard();

  const allAgents = useMemo(() => mergeAgentsAcrossQueues(queues), [queues]);
  const totals = useMemo(() => {
    const waiting = queues.reduce((s, q) => s + q.waitingCount, 0);
    const longest = queues.reduce((s, q) => Math.max(s, q.longestWaitSec), 0);
    const ready = allAgents.filter((a) => a.state === "ready").length;
    const onCall = allAgents.filter((a) => a.state === "on_call").length;
    return { waiting, longest, ready, onCall, agents: allAgents.length };
  }, [queues, allAgents]);

  const waitingAll = useMemo(
    () =>
      queues
        .flatMap((q) => q.waiting)
        .sort((a, b) => b.waitingSec - a.waitingSec),
    [queues],
  );

  return (
    <div className="qb-page">
      <header className="qb-head">
        <div className="qb-head-main">
          <h1 className="qb-title">
            <ListOrdered size={22} aria-hidden /> Queues
          </h1>
          <p className="qb-sub">
            Who is waiting, who is free, and how each queue is coping — live from the phone system.
          </p>
        </div>
        <div className="qb-head-actions">
          <span className={`qb-livechip ${live ? "is-live" : "is-stale"}`}>
            <span className="qb-dot" aria-hidden />
            {live ? "Live" : "Reconnecting"}
          </span>
          <button type="button" className="qb-btn" onClick={reload}>
            <RefreshCw size={15} aria-hidden /> Refresh
          </button>
          <Link href="/queues/reports" className="qb-btn">
            <BarChart3 size={15} aria-hidden /> Reports
          </Link>
          <Link href="/queues/wall" className="qb-btn qb-btn-primary" target="_blank">
            <Tv size={15} aria-hidden /> Wall display
          </Link>
        </div>
      </header>

      {!live && (
        <p className="qb-notice qb-notice-warn">
          <Activity size={15} aria-hidden />
          The live connection to the phone system is down, so waiting callers and agent states may be
          out of date. Queue names and membership below are still correct.
        </p>
      )}

      {configError && (
        <p className="qb-notice qb-notice-warn">
          Queues could not be loaded: {configError}
        </p>
      )}

      {loading && !queues.length && <p className="qb-empty">Loading queues…</p>}

      {!loading && !configError && queues.length === 0 && (
        <p className="qb-empty">
          This account has no call queues set up on the phone system. Queues are created in the PBX;
          once one exists it appears here automatically.
        </p>
      )}

      {queues.length > 0 && (
        <>
          <section className="qb-kpis" aria-label="Right now">
            <Kpi label="Waiting now" value={String(totals.waiting)} tone={totals.waiting > 0 ? "warn" : "ok"} />
            <Kpi
              label="Longest wait"
              value={totals.longest ? formatDuration(totals.longest) : "—"}
              tone={totals.longest >= 120 ? "crit" : totals.longest >= 45 ? "warn" : "ok"}
            />
            <Kpi label="Agents ready" value={`${totals.ready}/${totals.agents}`} tone={totals.ready === 0 ? "crit" : "ok"} />
            <Kpi label="On calls" value={String(totals.onCall)} tone="info" />
          </section>

          <section className="qb-grid" aria-label="Queues">
            {queues.map((q) => (
              <QueueCard key={q.config.extension} q={q} />
            ))}
          </section>

          <section className="qb-panel">
            <h2 className="qb-panel-h">
              On hold now
              <span className="qb-count">{waitingAll.length}</span>
            </h2>
            {waitingAll.length === 0 ? (
              <p className="qb-empty qb-empty-inline">Nobody is waiting. </p>
            ) : (
              <div className="qb-tablewrap">
                <table className="qb-table">
                  <thead>
                    <tr>
                      <th scope="col">Caller</th>
                      <th scope="col">Queue</th>
                      <th scope="col" className="qb-r">Position</th>
                      <th scope="col" className="qb-r">Waiting</th>
                    </tr>
                  </thead>
                  <tbody>
                    {waitingAll.map((c) => (
                      <tr key={c.id}>
                        <td className="qb-num">{c.fromName || c.from || "Unknown caller"}</td>
                        <td>{c.queueName}</td>
                        <td className="qb-num qb-r">{c.position}</td>
                        <td
                          className={`qb-num qb-r qb-strong ${
                            c.waitingSec >= 120 ? "qb-crit" : c.waitingSec >= 45 ? "qb-warn" : ""
                          }`}
                        >
                          {formatDuration(c.waitingSec)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="qb-panel">
            <h2 className="qb-panel-h">
              <Users size={16} aria-hidden /> Agents on the queues
              <span className="qb-count">{allAgents.length}</span>
            </h2>
            <div className="qb-tablewrap">
              <table className="qb-table">
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col">State</th>
                    <th scope="col">On queues</th>
                    <th scope="col" className="qb-r">Calls taken</th>
                  </tr>
                </thead>
                <tbody>
                  {allAgents.map((a) => {
                    const meta = AGENT_STATE_META[a.state];
                    return (
                      <tr key={a.extension}>
                        <td>
                          <span className="qb-ext">{a.extension}</span>
                          {a.name && <span className="qb-dim"> {a.name}</span>}
                        </td>
                        <td>
                          {/* symbol + word, never colour alone */}
                          <span className={`qb-state qb-state-${meta.tone}`}>
                            <span aria-hidden>{meta.symbol}</span> {meta.label}
                          </span>
                        </td>
                        <td className="qb-num qb-dim">{a.onQueues.join(", ")}</td>
                        <td className="qb-num qb-r">{a.callsTaken ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="qb-foot">
              Membership comes from the phone system&rsquo;s own queue configuration, so an agent who is
              switched off still appears here as offline rather than disappearing.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "crit" | "info" }) {
  return (
    <div className={`qb-kpi qb-kpi-${tone}`}>
      <div className="qb-kpi-k">{label}</div>
      <div className="qb-kpi-v">{value}</div>
    </div>
  );
}

function QueueCard({ q }: { q: BoardQueue }) {
  const c = q.config;
  const waitTone = q.longestWaitSec >= 120 ? "crit" : q.longestWaitSec >= 45 ? "warn" : "ok";
  return (
    <article className={`qb-card ${q.noOneAvailable ? "qb-card-alert" : ""}`}>
      <header className="qb-card-h">
        <div>
          <h3 className="qb-card-t">{c.name}</h3>
          <p className="qb-card-meta">
            {c.extension}
            {c.strategy ? ` · ${describeStrategy(c.strategy)}` : ""}
            {c.timeoutSec ? ` · rings ${c.timeoutSec}s` : ""}
            {` · ${c.members.length} ${c.members.length === 1 ? "agent" : "agents"}`}
          </p>
        </div>
        {q.noOneAvailable && (
          <span className="qb-badge qb-badge-crit">
            <span aria-hidden>⚠</span> Nobody available
          </span>
        )}
      </header>

      <div className="qb-card-stats">
        <Stat label="Waiting" value={String(q.waitingCount)} tone={q.waitingCount > 0 ? "warn" : "ok"} />
        <Stat
          label="Longest"
          value={q.longestWaitSec ? formatDuration(q.longestWaitSec) : "—"}
          tone={waitTone}
        />
        <Stat label="Ready" value={String(q.readyCount)} tone={q.readyCount === 0 ? "crit" : "ok"} />
        <Stat label="On calls" value={String(q.onCallCount)} tone="info" />
      </div>

      {q.waitingCountIsApproximate && (
        <p className="qb-card-note">
          Waiting count is the phone system&rsquo;s running counter — it can drift after a restart until
          the next call arrives.
        </p>
      )}

      <ul className="qb-agentchips">
        {q.agents.map((a) => {
          const meta = AGENT_STATE_META[a.state];
          return (
            <li key={a.extension} className={`qb-chip qb-chip-${meta.tone}`}>
              <span aria-hidden>{meta.symbol}</span>
              <span className="qb-chip-ext">{a.extension}</span>
              <span className="qb-chip-state">{meta.label}</span>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="qb-stat">
      <div className={`qb-stat-v qb-${tone}`}>{value}</div>
      <div className="qb-stat-k">{label}</div>
    </div>
  );
}
