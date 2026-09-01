"use client";

/**
 * Live view of the automatic support agent — what it is doing, right now.
 *
 * ⛔ WHY THIS SCREEN EXISTS, in Izzy's words: "I can't be blind like this."
 * The watcher runs on a laptop and a real ticket takes ten-plus minutes. Before
 * this, that whole time looked identical to nothing happening, and the only
 * evidence lived in files on one machine.
 *
 * ⛔ THE MOST IMPORTANT THING ON THE PAGE IS THE RED BANNER. The failure that
 * has actually happened is the watcher being OFF — it sat off for three days and
 * three tickets went unseen, because "no new reports" and "a quiet week" look
 * the same. So a dead watcher is stated loudly at the top, never inferred from
 * an empty list.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../../../../services/apiClient";

/** The customer half of a run — was the person told, and what did they say. */
type CustomerLoop = {
  status: string;
  verdict: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  answeredAt: string | null;
  heldReason: string | null;
} | null;

type Run = {
  id: string;
  ticketRef: string;
  tenantName: string | null;
  requestSummary: string | null;
  lane: string;
  status: string;
  attempt: number;
  host: string | null;
  sessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  steps: number;
  elapsedMs: number;
  customer: CustomerLoop;
};

/** Everything on this list is waiting for a PERSON. */
type LoopHealth = {
  held: Array<{ ticketRef: string; heldReason: string | null; at: string }>;
  notFixed: Array<{ ticketRef: string; note: string | null; at: string }>;
  unreadReplies: Array<{ id: string; ticketRef: string | null; preview: string; at: string }>;
  neverTold: Array<{ ticketRef: string; tenantName: string | null; at: string | null }>;
};

type Step = { at: string; kind: string; text: string };
type RunDetail = Omit<Run, "steps"> & { steps: Step[]; report: string | null };

type Watcher = {
  host: string;
  state: string;
  currentTicket: string | null;
  usedToday: Record<string, number> | null;
  caps: Record<string, number> | null;
  lastError: string | null;
  tokenExpiresAt: string | null;
  version: string | null;
  lastBeatAt: string;
  ageMs: number;
  alive: boolean;
};

const mins = (ms: number) => Math.floor(ms / 60000);
const clock = (ms: number) => `${mins(ms)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const ago = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : `${mins(ms)} min ago`);

export default function SupportAgentRuns() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [health, setHealth] = useState<LoopHealth | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sentNote, setSentNote] = useState("");
  const stepsEnd = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, w, h] = await Promise.all([
        apiGet<{ runs: Run[] }>("/admin/support/agent-runs?take=40"),
        apiGet<{ watchers: Watcher[] }>("/admin/support/agent-watcher"),
        apiGet<LoopHealth>("/admin/support/loop-health").catch(() => null),
      ]);
      setRuns(r.runs ?? []);
      setWatchers(w.watchers ?? []);
      if (h) setHealth(h);
      setError(null);
    } catch (e: any) {
      setError(e?.body?.message ?? e?.message ?? "Could not load the agent runs.");
    } finally {
      setLoaded(true);
    }
  }, []);

  /** Message the customer straight from the run — same route the desk uses. */
  const sendToCustomer = useCallback(async () => {
    const text = draft.trim();
    if (!text || !detail || sending) return;
    setSending(true);
    setSentNote("");
    try {
      await apiPost(`/admin/support/escalations/${encodeURIComponent(detail.ticketRef)}/message`, { message: text });
      setDraft("");
      setSentNote("Sent — they get a notification beside their assistant bubble.");
    } catch (e: any) {
      setSentNote(e?.body?.message ?? "Could not send it — try from the desk tab.");
    } finally {
      setSending(false);
    }
  }, [draft, detail, sending]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const out = await apiGet<{ run: RunDetail }>(`/admin/support/agent-runs/${encodeURIComponent(id)}`);
      setDetail(out.run);
    } catch {
      /* the list still stands; the detail simply does not refresh */
    }
  }, []);

  // ⛔ Poll FAST while something is running and slowly otherwise. A dashboard
  // that refreshes every 30s during a live run is not a live view; one that
  // polls every 3s forever is a needless load on the api all night.
  const anyRunning = runs.some((r) => r.status === "running");
  useEffect(() => {
    load();
    const t = window.setInterval(load, anyRunning ? 4000 : 20000);
    return () => window.clearInterval(t);
  }, [load, anyRunning]);

  useEffect(() => {
    if (!openId) return;
    loadDetail(openId);
    const live = detail?.status === "running";
    const t = window.setInterval(() => loadDetail(openId), live ? 3000 : 20000);
    return () => window.clearInterval(t);
  }, [openId, loadDetail, detail?.status]);

  // Follow the stream the way a log tail does, so the newest step is in view.
  useEffect(() => {
    if (detail?.status === "running") stepsEnd.current?.scrollIntoView({ block: "end" });
  }, [detail?.steps?.length, detail?.status]);

  const w = watchers[0] ?? null;
  const usedC = w?.usedToday?.customer ?? 0;
  const capC = w?.caps?.customer ?? 0;
  const tokenDays = w?.tokenExpiresAt
    ? Math.floor((new Date(w.tokenExpiresAt).getTime() - Date.now()) / 86400000)
    : null;

  return (
    <div className="sar-root">
      {/* ── is it even running ─────────────────────────────────────────── */}
      {loaded && (!w || !w.alive) ? (
        <div className="sar-banner sar-dead">
          <strong>The agent watcher is not running.</strong>
          <span>
            {w
              ? `Last heard from ${w.host} ${ago(w.ageMs)}.`
              : "It has never reported in from any machine."}{" "}
            New tickets are not being picked up. Start it on the machine that runs it:{" "}
            <code>Start-ScheduledTask -TaskName &quot;Loopcom support ticket watcher&quot;</code>
          </span>
        </div>
      ) : null}

      {w && w.alive ? (
        <div className="sar-banner sar-live">
          <span className="sar-dot" aria-hidden />
          <strong>
            {w.state === "working" && w.currentTicket
              ? `Working on ${w.currentTicket}`
              : w.state === "poll_failed"
                ? "Running, but the last check failed"
                : "Running, waiting for tickets"}
          </strong>
          <span className="sar-meta">
            {w.host} · heartbeat {ago(w.ageMs)} · today {usedC}
            {capC ? `/${capC}` : ""} customer
            {w.usedToday?.platform != null ? `, ${w.usedToday.platform}${w.caps?.platform ? `/${w.caps.platform}` : ""} alarm` : ""}
            {tokenDays != null ? ` · token ${tokenDays}d` : ""}
          </span>
          {tokenDays != null && tokenDays <= 7 ? (
            <span className="sar-warn">Token expires in {tokenDays} days — re-mint it or this stops.</span>
          ) : null}
          {w.lastError ? <span className="sar-warn">{w.lastError}</span> : null}
        </div>
      ) : null}

      {error ? <div className="sar-banner sar-dead">{error}</div> : null}

      {/* ── waiting for a PERSON — nothing automatic will move these ───── */}
      {health && (health.held.length || health.notFixed.length || health.unreadReplies.length || health.neverTold.length) ? (
        <div className="sar-needs">
          <b>Needs a person</b>
          {health.unreadReplies.map((r) => (
            <span key={r.id} className="sar-need sar-need-bad">
              {r.ticketRef ?? "message"}: customer replied — &ldquo;{r.preview.slice(0, 60)}&rdquo;
            </span>
          ))}
          {health.notFixed.map((n) => (
            <span key={`nf-${n.ticketRef}-${n.at}`} className="sar-need sar-need-bad">
              {n.ticketRef}: customer says still not right{n.note ? ` — “${String(n.note).slice(0, 50)}”` : ""}
            </span>
          ))}
          {health.held.map((h) => (
            <span key={`h-${h.ticketRef}`} className="sar-need sar-need-warn">
              {h.ticketRef}: reply held by the safety gate{h.heldReason ? ` — ${h.heldReason.slice(0, 60)}` : ""}
            </span>
          ))}
          {health.neverTold.map((n) => (
            <span key={`nt-${n.ticketRef}`} className="sar-need sar-need-warn">
              {n.ticketRef}: report done, customer never told — open it and message them
            </span>
          ))}
        </div>
      ) : null}

      <div className="sar-body">
        {/* ── the runs ──────────────────────────────────────────────────── */}
        <aside className="sar-list">
          <h3>
            Agent runs <span>{runs.length}</span>
          </h3>
          {loaded && !runs.length ? (
            <p className="sar-empty">No agent has run yet. A run appears here within a minute of a ticket arriving.</p>
          ) : null}
          {runs.map((r) => (
            <button
              key={r.id}
              className={`sar-item${openId === r.id ? " on" : ""}${r.status === "running" ? " running" : ""}`}
              onClick={() => {
                setOpenId(r.id);
                setDetail(null);
                setDraft("");
                setSentNote("");
              }}
            >
              <div className="sar-item-top">
                <span className="sar-ref">{r.ticketRef}</span>
                <span className={`sar-pill sar-${r.status}`}>
                  {r.status === "running" ? clock(r.elapsedMs) : r.status}
                </span>
              </div>
              <div className="sar-who">
                {r.tenantName ?? "—"}
                {r.lane === "platform" ? <span className="sar-lane">alarm</span> : null}
                {r.attempt > 1 ? <span className="sar-lane">retry {r.attempt}</span> : null}
              </div>
              <div className="sar-ask">{r.requestSummary ?? ""}</div>
              <div className="sar-sub">
                {new Date(r.startedAt).toLocaleString()} · {r.steps} steps
                {r.status !== "running" ? ` · took ${clock(r.elapsedMs)}` : ""}
              </div>
              {(() => {
                // The loop chip: the difference between "the agent worked" and
                // "the person was told". Absence of an update on a finished
                // customer run is itself the finding.
                if (r.lane !== "customer" || r.status === "running") return null;
                const c = r.customer;
                const chip = !c
                  ? r.status === "done"
                    ? { cls: "warn", text: "customer never told" }
                    : null
                  : c.status === "held"
                    ? { cls: "warn", text: "reply held by the gate" }
                    : c.status === "answered"
                      ? c.verdict === "fixed"
                        ? { cls: "ok", text: "customer confirmed: working" }
                        : { cls: "bad", text: "customer: still not right" }
                      : c.readAt
                        ? { cls: "ok", text: "read by the customer" }
                        : c.deliveredAt
                          ? { cls: "ok", text: "delivered to the customer" }
                          : { cls: "dim", text: "reply waiting to be seen" };
                return chip ? <div className={`sar-cchip sar-cchip-${chip.cls}`}>{chip.text}</div> : null;
              })()}
            </button>
          ))}
        </aside>

        {/* ── what it is doing ──────────────────────────────────────────── */}
        <section className="sar-detail">
          {!openId ? (
            <p className="sar-empty">Pick a run to watch what the agent is doing, step by step.</p>
          ) : !detail ? (
            <p className="sar-empty">Loading…</p>
          ) : (
            <>
              <header className="sar-detail-head">
                <div>
                  <h3>
                    {detail.ticketRef} — {detail.tenantName ?? "—"}
                  </h3>
                  <p>{detail.requestSummary}</p>
                </div>
                <div className="sar-detail-meta">
                  <span className={`sar-pill sar-${detail.status}`}>
                    {detail.status === "running" ? `running ${clock(detail.elapsedMs)}` : detail.status}
                  </span>
                  {detail.host ? <span>{detail.host}</span> : null}
                </div>
              </header>

              {detail.error ? <div className="sar-banner sar-dead">{detail.error}</div> : null}

              <div className="sar-steps">
                {detail.steps.length ? (
                  detail.steps.map((s, i) => (
                    <div key={i} className={`sar-step sar-k-${s.kind}`}>
                      <span className="sar-step-t">{new Date(s.at).toLocaleTimeString()}</span>
                      <span className="sar-step-k">{s.kind}</span>
                      <span className="sar-step-x">{s.text}</span>
                    </div>
                  ))
                ) : (
                  <p className="sar-empty">Starting…</p>
                )}
                <div ref={stepsEnd} />
              </div>

              {detail.report ? (
                <details className="sar-report" open={detail.status !== "running"}>
                  <summary>The report</summary>
                  <pre>{detail.report}</pre>
                </details>
              ) : null}

              {/* Message the person about this ticket, right from the run —
                  the same notified channel the desk uses. */}
              {detail.lane === "customer" ? (
                <div className="sar-msgrow">
                  <input
                    value={draft}
                    placeholder={`Message ${detail.tenantName ?? "the customer"} about ${detail.ticketRef}…`}
                    disabled={sending}
                    onChange={(e) => { setDraft(e.target.value); setSentNote(""); }}
                    onKeyDown={(e) => (e.key === "Enter" ? void sendToCustomer() : null)}
                  />
                  <button disabled={sending || !draft.trim()} onClick={() => void sendToCustomer()}>
                    Send
                  </button>
                  {sentNote ? <span className="sar-sent">{sentNote}</span> : null}
                </div>
              ) : null}

              {detail.sessionId ? (
                <p className="sar-resume">
                  Open the agent&apos;s own chat on that machine:{" "}
                  <code>claude --resume {detail.sessionId}</code>
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
