"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  AGENT_STATE_META,
  formatDuration,
  mergeAgentsAcrossQueues,
  useQueueBoard,
} from "../queueBoard";

/**
 * The wall display — a TV in the office.
 *
 * Rendered as a fixed, full-viewport overlay rather than a normal page so it
 * covers the sidebar and app chrome on a screen nobody is going to navigate,
 * while still sitting inside the authenticated layout (a wall board that
 * bypassed sign-in would be a hole, not a feature).
 *
 * ⛔ Everything here must be legible from across a room and must never depend
 * on colour alone — every agent state carries a symbol and a word.
 */
export default function QueueWallPage() {
  const { queues, live, configError } = useQueueBoard();
  const [now, setNow] = useState<Date | null>(null);

  // Rendered client-side only: a server-rendered clock would hydrate mismatched.
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const agents = useMemo(() => mergeAgentsAcrossQueues(queues), [queues]);
  const waiting = useMemo(
    () => queues.flatMap((q) => q.waiting).sort((a, b) => b.waitingSec - a.waitingSec),
    [queues],
  );
  const totals = useMemo(() => {
    const waitingCount = queues.reduce((s, q) => s + q.waitingCount, 0);
    const longest = queues.reduce((s, q) => Math.max(s, q.longestWaitSec), 0);
    return {
      waiting: waitingCount,
      longest,
      ready: agents.filter((a) => a.state === "ready").length,
      onCall: agents.filter((a) => a.state === "on_call").length,
      total: agents.length,
    };
  }, [queues, agents]);

  return (
    <div className="qw-root">
      <header className="qw-top">
        <div>
          <div className="qw-brand">Queues</div>
          <div className="qw-sub">Live queue status</div>
        </div>
        <span className={`qw-live ${live ? "" : "is-stale"}`}>
          <span className="qw-pulse" aria-hidden />
          {live ? "LIVE" : "RECONNECTING"}
        </span>
        <div className="qw-clock">
          <div className="qw-time">{now ? now.toLocaleTimeString([], { hour12: false }) : "--:--:--"}</div>
          <div className="qw-date">
            {now ? now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }) : ""}
          </div>
        </div>
        <Link href="/queues" className="qw-close" aria-label="Leave wall display">
          <X size={20} aria-hidden />
        </Link>
      </header>

      {configError && <p className="qw-error">Queues could not be loaded: {configError}</p>}

      <section className="qw-kpis">
        <div className={`qw-kpi ${totals.waiting > 0 ? "is-warn" : "is-ok"}`}>
          <div className="qw-kpi-k">Waiting now</div>
          <div className="qw-kpi-v">{totals.waiting}</div>
        </div>
        <div
          className={`qw-kpi ${
            totals.longest >= 120 ? "is-crit" : totals.longest >= 45 ? "is-warn" : "is-ok"
          }`}
        >
          <div className="qw-kpi-k">Longest wait</div>
          <div className="qw-kpi-v">{totals.longest ? formatDuration(totals.longest) : "—"}</div>
        </div>
        <div className={`qw-kpi ${totals.ready === 0 ? "is-crit" : "is-ok"}`}>
          <div className="qw-kpi-k">Agents ready</div>
          <div className="qw-kpi-v">
            {totals.ready}
            <span className="qw-kpi-of">/{totals.total}</span>
          </div>
        </div>
        <div className="qw-kpi is-info">
          <div className="qw-kpi-k">On calls</div>
          <div className="qw-kpi-v">{totals.onCall}</div>
        </div>
      </section>

      <section className="qw-mid">
        <div className="qw-panel">
          <h2 className="qw-panel-h">
            Queues<span className="qw-c">{queues.length}</span>
          </h2>
          {queues.map((q) => (
            <div key={q.config.extension} className="qw-qrow">
              <div className="qw-qname">
                {q.config.name}
                <span className="qw-qmeta">
                  {q.config.extension} · {q.agents.length} agents
                  {q.noOneAvailable ? " · ⚠ nobody available" : ""}
                </span>
              </div>
              <div className="qw-qstat">
                <div className={`qw-qv ${q.waitingCount > 0 ? "is-warn" : ""}`}>{q.waitingCount}</div>
                <div className="qw-qk">Waiting</div>
              </div>
              <div className="qw-qstat">
                <div
                  className={`qw-qv ${
                    q.longestWaitSec >= 120 ? "is-crit" : q.longestWaitSec >= 45 ? "is-warn" : ""
                  }`}
                >
                  {q.longestWaitSec ? formatDuration(q.longestWaitSec) : "—"}
                </div>
                <div className="qw-qk">Longest</div>
              </div>
              <div className="qw-qstat">
                <div className={`qw-qv ${q.readyCount === 0 ? "is-crit" : "is-ok"}`}>{q.readyCount}</div>
                <div className="qw-qk">Ready</div>
              </div>
            </div>
          ))}
          {queues.length === 0 && <p className="qw-empty">No queues configured.</p>}
        </div>

        <div className="qw-panel">
          <h2 className="qw-panel-h">
            On hold<span className="qw-c">{waiting.length}</span>
          </h2>
          {waiting.length === 0 ? (
            <p className="qw-empty">Nobody waiting</p>
          ) : (
            waiting.slice(0, 8).map((c, i) => (
              <div key={c.id} className="qw-caller">
                <span className="qw-pos">{i + 1}</span>
                <span>
                  <span className="qw-cnum">{c.fromName || c.from || "Unknown"}</span>
                  <span className="qw-cq">{c.queueName}</span>
                </span>
                <span
                  className={`qw-ctime ${
                    c.waitingSec >= 120 ? "is-crit" : c.waitingSec >= 45 ? "is-warn" : ""
                  }`}
                >
                  {formatDuration(c.waitingSec)}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="qw-panel">
        <h2 className="qw-panel-h">
          Agents<span className="qw-c">{agents.length}</span>
        </h2>
        <div className="qw-agents">
          {agents.map((a) => {
            const meta = AGENT_STATE_META[a.state];
            return (
              <div key={a.extension} className={`qw-agent qw-s-${meta.tone}`}>
                <div className="qw-a-top">
                  <span className="qw-a-ext">{a.extension}</span>
                  <span className="qw-a-name">{a.name || ""}</span>
                </div>
                <div className="qw-a-state">
                  <span aria-hidden>{meta.symbol}</span> {meta.label}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
