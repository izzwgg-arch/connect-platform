"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2, Moon, Sun, Tv, X } from "lucide-react";
import { PermissionGate } from "../../../../components/PermissionGate";
import {
  AGENT_STATE_META,
  formatDuration,
  mergeAgentsAcrossQueues,
  useQueueBoard,
} from "../queueBoard";

/**
 * TV mode — the wall display.
 *
 * Rendered as a fixed, full-viewport overlay so it covers the sidebar and app
 * chrome on a screen nobody is going to navigate, while still sitting inside
 * the authenticated layout (a wall board that bypassed sign-in would be a hole,
 * not a feature).
 *
 * Three things a TV needs that an app page doesn't:
 *   • real fullscreen, so the browser's own chrome goes away too;
 *   • a screen wake lock, or the panel sleeps and the board is useless;
 *   • controls that get out of the way — they fade after a few seconds of no
 *     mouse, because a permanent row of buttons on a wall is just clutter.
 *
 * ⛔ The theme choice is applied as token overrides scoped to `.qw-root`, NOT
 * by writing `data-theme` on <html>. The app context owns that attribute and
 * would fight us for it, and leaving TV mode could strand the whole portal in
 * the wrong theme.
 */

type TvTheme = "app" | "dark" | "light";
const TV_THEME_KEY = "cc-queue-wall-theme";

function QueueWallPageInner() {
  const { queues, live, configError } = useQueueBoard();
  const [now, setNow] = useState<Date | null>(null);
  const [tvTheme, setTvTheme] = useState<TvTheme>("app");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakeLock = useRef<any>(null);

  // Rendered client-side only: a server-rendered clock hydrates mismatched.
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(TV_THEME_KEY) as TvTheme | null;
      if (saved === "dark" || saved === "light" || saved === "app") setTvTheme(saved);
    } catch { /* private mode — the default is fine */ }
  }, []);

  const chooseTheme = useCallback((t: TvTheme) => {
    setTvTheme(t);
    try { window.localStorage.setItem(TV_THEME_KEY, t); } catch { /* non-fatal */ }
  }, []);

  // ── Screen wake lock ─────────────────────────────────────────────────────
  // Released by the browser whenever the tab is hidden, so it must be
  // re-acquired on every return to visibility or the TV sleeps overnight.
  useEffect(() => {
    let cancelled = false;
    const acquire = async () => {
      try {
        const anyNav = navigator as any;
        if (!anyNav.wakeLock?.request) return; // unsupported — not an error
        if (document.visibilityState !== "visible") return;
        wakeLock.current = await anyNav.wakeLock.request("screen");
      } catch { /* denied or unsupported; the board still works */ }
    };
    const onVisible = () => { if (!cancelled && document.visibilityState === "visible") void acquire(); };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      try { wakeLock.current?.release?.(); } catch { /* already gone */ }
      wakeLock.current = null;
    };
  }, []);

  // ── Fullscreen ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* blocked without a user gesture — button press supplies one */ }
  }, []);

  // ── Auto-hiding controls ─────────────────────────────────────────────────
  useEffect(() => {
    const show = () => {
      setControlsVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setControlsVisible(false), 4000);
    };
    show();
    window.addEventListener("mousemove", show);
    window.addEventListener("touchstart", show);
    window.addEventListener("keydown", show);
    return () => {
      window.removeEventListener("mousemove", show);
      window.removeEventListener("touchstart", show);
      window.removeEventListener("keydown", show);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
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
    <div className="qw-root" data-tv-theme={tvTheme}>
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

        <div className={`qw-controls ${controlsVisible ? "" : "is-hidden"}`}>
          <div className="qw-themeswitch" role="group" aria-label="Wall display theme">
            <button
              type="button" className={tvTheme === "app" ? "is-on" : ""}
              aria-pressed={tvTheme === "app"} onClick={() => chooseTheme("app")}
              title="Follow the app theme"
            >
              <Tv size={15} aria-hidden /><span className="qw-sr">Follow app</span>
            </button>
            <button
              type="button" className={tvTheme === "dark" ? "is-on" : ""}
              aria-pressed={tvTheme === "dark"} onClick={() => chooseTheme("dark")}
              title="Always dark — easiest on a wall panel"
            >
              <Moon size={15} aria-hidden /><span className="qw-sr">Dark</span>
            </button>
            <button
              type="button" className={tvTheme === "light" ? "is-on" : ""}
              aria-pressed={tvTheme === "light"} onClick={() => chooseTheme("light")}
              title="Always light"
            >
              <Sun size={15} aria-hidden /><span className="qw-sr">Light</span>
            </button>
          </div>
          <button
            type="button" className="qw-ctl" onClick={toggleFullscreen}
            title={isFullscreen ? "Leave fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? <Minimize2 size={18} aria-hidden /> : <Maximize2 size={18} aria-hidden />}
            <span className="qw-sr">{isFullscreen ? "Leave fullscreen" : "Fullscreen"}</span>
          </button>
          <Link href="/queues" className="qw-ctl" aria-label="Leave wall display">
            <X size={18} aria-hidden />
          </Link>
        </div>
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

/**
 * ⛔ The page gates itself. Hiding the sidebar item is presentation, not
 * access — without this a link, a bookmark or a typed URL would still render
 * the screen for somebody whose role has it switched off.
 */
export default function QueueWallPage() {
  return (
    <PermissionGate
      permission={"can_view_queue_wallboard" as never}
      fallback={
        <div className="qb-page">
          <p className="qb-notice qb-notice-warn">The wall display is switched off for your account.</p>
        </div>
      }
    >
      <QueueWallPageInner />
    </PermissionGate>
  );
}
