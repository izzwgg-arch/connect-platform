"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Activity, BarChart3, ListOrdered, Plus, RefreshCw, Tv, Users } from "lucide-react";
import { PermissionGate } from "../../../components/PermissionGate";
import { useAppContext } from "../../../hooks/useAppContext";
import { useUiLanguage } from "../../../hooks/useUiLanguage";
import { NewQueueDialog, NEW_QUEUE_PHRASES } from "./NewQueueDialog";
import {
  AGENT_STATE_META,
  describeStrategy,
  formatDuration,
  mergeAgentsAcrossQueues,
  useQueueBoard,
  type BoardQueue,
} from "./queueBoard";

/**
 * ⛔ Byte-exact. These strings are matched literally against what the screen
 * renders, so a curly apostrophe or an em-dash that differs by one character
 * never reaches Yiddish and silently falls back to English.
 */
const PHRASES = [
  "Queues", "New queue",
  "Who is waiting, who is free, and how each queue is coping — live from the phone system.",
  "Live", "Reconnecting", "Refresh", "Reports", "TV mode",
  "The live connection to the phone system is down, so waiting callers and agent states may be out of date. Queue names and membership below are still correct.",
  "Queues could not be loaded:", "Loading queues…",
  "This account has no call queues set up on the phone system. Queues are created in the PBX; once one exists it appears here automatically.",
  "Waiting now", "Longest wait", "Agents ready", "On calls",
  "On hold now", "Nobody is waiting.", "Caller", "Queue", "Position", "Waiting",
  "Unknown caller", "Agents on the queues", "Agent", "State", "On queues", "Calls taken",
  "Membership comes from the phone system's own queue configuration, so an agent who is switched off still appears here as offline rather than disappearing.",
  "Nobody available", "Ready", "Longest",
  "Waiting count is the phone system's running counter — it can drift after a restart until the next call arrives.",
  "On call", "Ringing", "Paused", "Offline",
  "rings everyone", "one at a time, in order", "least recently called",
  "fewest calls first", "random", "round robin", "round robin, in order", "weighted random",
  "agent", "agents", "rings",
  ...NEW_QUEUE_PHRASES,
] as string[];

/**
 * Queue status — the supervisor's screen.
 *
 * Distinct from the wall display on purpose: this one is operated (scrolled,
 * filtered, clicked through to reports), the wall one is only read. Merging
 * them would compromise both.
 */
function QueuesPageInner() {
  const { queues, extensions, loading, configError, live, reload } = useQueueBoard();
  const { can } = useAppContext();
  const { t } = useUiLanguage(PHRASES);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // ⛔ The button checks the SAME key the route accepts, so it can never be a
  // visible control that 403s. `/voice/teams` takes can_create_queues OR the
  // IVR-management key; an IVR manager therefore still sees it.
  const canCreate = can("can_create_queues" as never) || can("can_manage_ivr_routing" as never);

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
            <ListOrdered size={22} aria-hidden /> {t("Queues")}
          </h1>
          <p className="qb-sub">
            {t("Who is waiting, who is free, and how each queue is coping — live from the phone system.")}
          </p>
        </div>
        <div className="qb-head-actions">
          <span className={`qb-livechip ${live ? "is-live" : "is-stale"}`}>
            <span className="qb-dot" aria-hidden />
            {live ? t("Live") : t("Reconnecting")}
          </span>
          <button type="button" className="qb-btn" onClick={reload}>
            <RefreshCw size={15} aria-hidden /> {t("Refresh")}
          </button>
          <Link href="/queues/reports" className="qb-btn">
            <BarChart3 size={15} aria-hidden /> {t("Reports")}
          </Link>
          <Link href="/queues/wall" className="qb-btn" target="_blank">
            <Tv size={15} aria-hidden /> {t("TV mode")}
          </Link>
          {canCreate && (
            <button type="button" className="qb-btn qb-btn-primary" onClick={() => setCreating(true)}>
              <Plus size={15} aria-hidden /> {t("New queue")}
            </button>
          )}
        </div>
      </header>

      {toast && <p className="qb-notice qb-notice-ok">{toast}</p>}

      {creating && (
        <NewQueueDialog
          extensions={extensions}
          onClose={() => setCreating(false)}
          onCreated={(msg) => { setToast(msg); reload(); }}
        />
      )}

      {!live && (
        <p className="qb-notice qb-notice-warn">
          <Activity size={15} aria-hidden />
          {t("The live connection to the phone system is down, so waiting callers and agent states may be out of date. Queue names and membership below are still correct.")}
        </p>
      )}

      {configError && (
        <p className="qb-notice qb-notice-warn">
          {t("Queues could not be loaded:")} {configError}
        </p>
      )}

      {loading && !queues.length && <p className="qb-empty">{t("Loading queues…")}</p>}

      {!loading && !configError && queues.length === 0 && (
        <p className="qb-empty">
          {t("This account has no call queues set up on the phone system. Queues are created in the PBX; once one exists it appears here automatically.")}
        </p>
      )}

      {queues.length > 0 && (
        <>
          <section className="qb-kpis" aria-label="Right now">
            <Kpi label={t("Waiting now")} value={String(totals.waiting)} tone={totals.waiting > 0 ? "warn" : "ok"} />
            <Kpi
              label={t("Longest wait")}
              value={totals.longest ? formatDuration(totals.longest) : "—"}
              tone={totals.longest >= 120 ? "crit" : totals.longest >= 45 ? "warn" : "ok"}
            />
            <Kpi label={t("Agents ready")} value={`${totals.ready}/${totals.agents}`} tone={totals.ready === 0 ? "crit" : "ok"} />
            <Kpi label={t("On calls")} value={String(totals.onCall)} tone="info" />
          </section>

          <section className="qb-grid" aria-label="Queues">
            {queues.map((q) => (
              <QueueCard key={q.config.extension} q={q} />
            ))}
          </section>

          <section className="qb-panel">
            <h2 className="qb-panel-h">
              {t("On hold now")}
              <span className="qb-count">{waitingAll.length}</span>
            </h2>
            {waitingAll.length === 0 ? (
              <p className="qb-empty qb-empty-inline">{t("Nobody is waiting.")}</p>
            ) : (
              <div className="qb-tablewrap">
                <table className="qb-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("Caller")}</th>
                      <th scope="col">{t("Queue")}</th>
                      <th scope="col" className="qb-r">{t("Position")}</th>
                      <th scope="col" className="qb-r">{t("Waiting")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {waitingAll.map((c) => (
                      <tr key={c.id}>
                        <td className="qb-num">{c.fromName || c.from || t("Unknown caller")}</td>
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
              <Users size={16} aria-hidden /> {t("Agents on the queues")}
              <span className="qb-count">{allAgents.length}</span>
            </h2>
            <div className="qb-tablewrap">
              <table className="qb-table">
                <thead>
                  <tr>
                    <th scope="col">{t("Agent")}</th>
                    <th scope="col">{t("State")}</th>
                    <th scope="col">{t("On queues")}</th>
                    <th scope="col" className="qb-r">{t("Calls taken")}</th>
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
                            <span aria-hidden>{meta.symbol}</span> {t(meta.label)}
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
              {t("Membership comes from the phone system's own queue configuration, so an agent who is switched off still appears here as offline rather than disappearing.")}
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
  const { t } = useUiLanguage();
  const c = q.config;
  const waitTone = q.longestWaitSec >= 120 ? "crit" : q.longestWaitSec >= 45 ? "warn" : "ok";
  return (
    <article className={`qb-card ${q.noOneAvailable ? "qb-card-alert" : ""}`}>
      <header className="qb-card-h">
        <div>
          <h3 className="qb-card-t">{c.name}</h3>
          <p className="qb-card-meta">
            {c.extension}
            {c.strategy ? ` · ${t(describeStrategy(c.strategy))}` : ""}
            {c.timeoutSec ? ` · ${t("rings")} ${c.timeoutSec}s` : ""}
            {` · ${c.members.length} ${c.members.length === 1 ? t("agent") : t("agents")}`}
          </p>
        </div>
        {q.noOneAvailable && (
          <span className="qb-badge qb-badge-crit">
            <span aria-hidden>⚠</span> {t("Nobody available")}
          </span>
        )}
      </header>

      <div className="qb-card-stats">
        <Stat label={t("Waiting")} value={String(q.waitingCount)} tone={q.waitingCount > 0 ? "warn" : "ok"} />
        <Stat
          label={t("Longest")}
          value={q.longestWaitSec ? formatDuration(q.longestWaitSec) : "—"}
          tone={waitTone}
        />
        <Stat label={t("Ready")} value={String(q.readyCount)} tone={q.readyCount === 0 ? "crit" : "ok"} />
        <Stat label={t("On calls")} value={String(q.onCallCount)} tone="info" />
      </div>

      {q.waitingCountIsApproximate && (
        <p className="qb-card-note">
          {t("Waiting count is the phone system's running counter — it can drift after a restart until the next call arrives.")}
        </p>
      )}

      <ul className="qb-agentchips">
        {q.agents.map((a) => {
          const meta = AGENT_STATE_META[a.state];
          return (
            <li key={a.extension} className={`qb-chip qb-chip-${meta.tone}`}>
              <span aria-hidden>{meta.symbol}</span>
              <span className="qb-chip-ext">{a.extension}</span>
              <span className="qb-chip-state">{t(meta.label)}</span>
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

/**
 * ⛔ The page gates itself. Hiding the sidebar item is presentation, not
 * access — without this a link, a bookmark or a typed URL would still render
 * the screen for somebody whose role has it switched off.
 */
export default function QueuesPage() {
  return (
    <PermissionGate
      permission={"can_view_queues" as never}
      fallback={
        <div className="qb-page">
          <p className="qb-notice qb-notice-warn">Queue status is switched off for your account.</p>
        </div>
      }
    >
      <QueuesPageInner />
    </PermissionGate>
  );
}
