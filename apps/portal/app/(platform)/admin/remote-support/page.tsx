"use client";

/**
 * The support side: ask to connect, then watch (and optionally drive) the
 * customer's screen.
 *
 * ⛔ A Next.js App Router page file may ONLY default-export a component. A
 * named export here fails the production build with "does not match the
 * required types of a Next.js Page" — and `tsc --noEmit` does NOT catch it, so
 * it passes every local check and dies in the deploy. Helpers belong in a
 * sibling module.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { useAppContext } from "../../../../hooks/useAppContext";
import {
  RemoteSupportPeer,
  endSession,
  getSession,
  listEvents,
  listSessions,
  reportInputCount,
  requestCapability,
  requestSession,
  sendChat,
  type LinkQuality,
  type MediaBudget,
  type RemoteCapability,
  type RemoteSupportSession,
  type SessionEvent,
} from "../../../../services/remoteSupport";
import {
  elementPointToScreenFraction,
  keyEventToCommand,
  mouseButtonName,
  shouldSendMove,
  wheelDeltaToWindows,
} from "../../../../lib/remoteSupportInput";
import { apiGet } from "../../../../services/apiClient";

type Person = { id: string; name: string; email: string; tenantId: string | null; tenantName: string | null };

export default function RemoteSupportPage() {
  return (
    <PermissionGate
      permission={"can_remote_support" as any}
      fallback={
        <div className="card" style={{ margin: 24, padding: 24 }}>
          <h2>Remote support</h2>
          <p>You do not have permission to start a remote support session.</p>
        </div>
      }
    >
      <RemoteSupportConsole />
    </PermissionGate>
  );
}

function RemoteSupportConsole() {
  const { can } = useAppContext();
  const mayControl = can("can_control_remote_support" as any);

  const [people, setPeople] = useState<Person[]>([]);
  const manyTenants = new Set(people.map((p) => p.tenantId)).size > 1;
  const [targetUserId, setTargetUserId] = useState("");
  const [reason, setReason] = useState("");
  const [wantControl, setWantControl] = useState(false);
  const [session, setSession] = useState<RemoteSupportSession | null>(null);
  const [history, setHistory] = useState<RemoteSupportSession[]>([]);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [controlOn, setControlOn] = useState(false);

  /* ── the rail: what we hold, what we asked for, what the link looks like ── */
  const [granted, setGranted] = useState<RemoteCapability[]>([]);
  const [pendingCap, setPendingCap] = useState<RemoteCapability | null>(null);
  const [quality, setQuality] = useState<LinkQuality | null>(null);
  const [budget, setBudget] = useState<MediaBudget | null>(null);
  const [onCall, setOnCall] = useState(false);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [rail, setRail] = useState<"chat" | "activity">("chat");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  /**
   * The customer's picture has stopped arriving. Chromium raises `mute` on the
   * remote video track when frames stop — which is exactly what happens when
   * the customer shared ONE WINDOW and then minimised it. Without this the
   * viewer shows the last frame forever with a green "Good connection" beside
   * it, and reads as frozen (2026-09-02, first live session).
   */
  const [pictureStalled, setPictureStalled] = useState(false);
  const peerRef = useRef<RemoteSupportPeer | null>(null);
  const lastMoveRef = useRef<{ x: number; y: number } | null>(null);
  const inputCountRef = useRef(0);
  const railBodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // ⛔ `/remote-support/people` — the SAME scoping the request route applies
    // (super admin: every approved customer; anyone else: own company). This
    // used to ask `/team/members`, a route that does not exist, and the swallowed
    // 404 left "Choose a person…" empty for everyone.
    apiGet<{ people?: Person[] }>("/remote-support/people")
      .then((r) => setPeople(r.people ?? []))
      .catch(() => setPeople([]));
    void refreshHistory();
  }, []);

  // Full screen is on the STAGE, not the <video>: the browser's own video
  // fullscreen would take the keyboard and the footer away from the session.
  useEffect(() => {
    const onChange = () => setIsFullscreen(stageRef.current !== null && document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen().catch(() => {});
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const r = await listSessions(25);
      setHistory(r.sessions);
    } catch {
      /* the list is a convenience, not the feature */
    }
  }, []);

  const stop = useCallback(async () => {
    try { peerRef.current?.stop(); } catch { /* already gone */ }
    peerRef.current = null;
    if (session?.id) {
      if (inputCountRef.current > 0) {
        await reportInputCount(session.id, inputCountRef.current).catch(() => {});
        inputCountRef.current = 0;
      }
      await endSession(session.id).catch(() => {});
    }
    setSession(null);
    setControlOn(false);
    setStatus("");
    setGranted([]);
    setPendingCap(null);
    setQuality(null);
    setBudget(null);
    setOnCall(false);
    setEvents([]);
    void refreshHistory();
  }, [session, refreshHistory]);

  const ask = useCallback(async () => {
    setError(null);
    if (!targetUserId) return setError("Choose who you want to connect to.");
    if (reason.trim().length < 3) return setError("Say why you need to connect — they will see this.");

    try {
      const res = await requestSession({
        targetUserId,
        reason: reason.trim(),
        requestControl: wantControl && mayControl,
      });
      setSession(res.session);
      setStatus("Waiting for them to accept…");
    } catch (err: any) {
      // The server sends a real sentence; print it rather than the slug.
      setError(err?.body?.message || err?.message || "That could not be sent.");
    }
  }, [targetUserId, reason, wantControl, mayControl]);

  // Wait for consent, then connect.
  useEffect(() => {
    if (!session || peerRef.current) return;
    if (session.status !== "REQUESTED" && session.status !== "CONSENTED") return;

    let cancelled = false;
    const timer = setInterval(async () => {
      if (cancelled) return;
      try {
        const { session: fresh } = await getSession(session.id);
        if (cancelled) return;

        if (fresh.status === "DECLINED") {
          setStatus("They said no.");
          setSession(null);
          clearInterval(timer);
          void refreshHistory();
          return;
        }
        if (fresh.status === "EXPIRED" || fresh.status === "ENDED") {
          setStatus(fresh.status === "EXPIRED" ? "Nobody answered." : "The session ended.");
          setSession(null);
          clearInterval(timer);
          void refreshHistory();
          return;
        }

        if ((fresh.status === "CONSENTED" || fresh.status === "ACTIVE") && !peerRef.current) {
          clearInterval(timer);
          setSession(fresh);
          setStatus("Connecting…");

          const peer = new RemoteSupportPeer(fresh.id, "support", {
            onStream: (stream) => {
              if (videoRef.current) videoRef.current.srcObject = stream;
              setStatus("");
              setPictureStalled(false);
              for (const track of stream.getVideoTracks()) {
                track.addEventListener("mute", () => setPictureStalled(true));
                track.addEventListener("unmute", () => setPictureStalled(false));
              }
            },
            onStateChange: (state) => {
              if (state === "connected") setStatus("");
              if (state === "connecting") setStatus("Connecting…");
            },
            onClosed: () => {
              setStatus("The session ended.");
              setSession(null);
              peerRef.current = null;
              void refreshHistory();
            },
            onHeartbeat: ({ quality: q, mediaBudget, callInProgress }) => {
              setQuality(q);
              if (mediaBudget) setBudget(mediaBudget);
              setOnCall(Boolean(callInProgress));
            },
          });
          peerRef.current = peer;
          await peer.start();
          setControlOn(fresh.controlGranted && mayControl);
          setGranted((fresh.capabilitiesGranted ?? []) as RemoteCapability[]);
        }
      } catch {
        /* transient — the next tick tries again */
      }
    }, 1_000);

    return () => { cancelled = true; clearInterval(timer); };
  }, [session, mayControl, refreshHistory]);

  useEffect(() => () => { try { peerRef.current?.stop(); } catch { /* noop */ } }, []);

  /*
   * The transcript, and with it the answer to "did they say yes to the extra
   * thing I asked for".
   *
   * ⛔ `capabilitiesGranted` from the SERVER is the only thing that flips a tool
   * on. `requestCapability` deliberately returns `granted` unchanged, so the
   * rail cannot draw a tool as available merely because it was asked for — that
   * is the whole point of keeping requested and granted apart.
   */
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let since: string | undefined;

    const tick = async () => {
      if (cancelled) return;
      try {
        const { events: fresh } = await listEvents(session.id, since);
        if (cancelled || fresh.length === 0) return;
        since = fresh[fresh.length - 1]!.at;
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          return [...prev, ...fresh.filter((e) => !seen.has(e.id))];
        });
      } catch {
        /* the transcript is a readout; a missed poll costs nothing */
      }
      try {
        const { session: fresh } = await getSession(session.id);
        if (cancelled) return;
        const g = (fresh.capabilitiesGranted ?? []) as RemoteCapability[];
        setGranted(g);
        setControlOn(fresh.controlGranted && mayControl);
        // The answer arrived — stop showing the question as outstanding.
        setPendingCap((p) => (p && g.includes(p) ? null : p));
      } catch {
        /* transient */
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), 3_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [session, mayControl]);

  /** Keep the newest message in view without yanking the page around. */
  useEffect(() => {
    const el = railBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, rail]);

  const askFor = useCallback(async (capability: RemoteCapability) => {
    if (!session) return;
    setError(null);
    try {
      const res = await requestCapability(session.id, capability);
      // ⛔ Reflect the SERVER's answer, never the optimistic one.
      setGranted(res.granted as RemoteCapability[]);
      setPendingCap(res.granted.includes(capability) ? null : capability);
    } catch (err: any) {
      setError(err?.body?.message || err?.message || "That request could not be sent.");
    }
  }, [session]);

  const say = useCallback(async () => {
    const body = draft.trim();
    if (!session || body.length === 0) return;
    setDraft("");
    try {
      await sendChat(session.id, body);
    } catch (err: any) {
      setDraft(body); // put their words back rather than losing them
      setError(err?.body?.message || err?.message || "That message did not send.");
    }
  }, [session, draft]);

  /** Where on the customer's screen a browser event points. Null in the letterbox. */
  const pointFor = useCallback((e: { clientX: number; clientY: number }) => {
    const el = videoRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return elementPointToScreenFraction(
      { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top },
      { width: rect.width, height: rect.height },
      { width: el.videoWidth, height: el.videoHeight },
    );
  }, []);

  const send = useCallback((command: any) => {
    if (!controlOn) return;
    if (peerRef.current?.sendInput(command)) inputCountRef.current += 1;
  }, [controlOn]);

  const live = Boolean(session && peerRef.current);

  return (
    <div className="rs-console">
      <header className="rs-console-head">
        <h1>Remote support</h1>
        {live && (
          <button type="button" className="btn" onClick={() => void stop()}>
            End session
          </button>
        )}
      </header>

      {!live && (
        <section className="card rs-ask">
          <h2>Connect to someone</h2>

          <label className="rs-field">
            <span>Who</span>
            <ConnectSelect
              value={targetUserId}
              onChange={(v) => setTargetUserId(v)}
              style={{ width: "100%" }}
              options={[
                { value: "", label: "Choose a person…" },
                ...people.map((p) => ({
                  value: p.id,
                  // The company is named only when the list spans more than one,
                  // i.e. for a super admin — a technician inside one company
                  // gains nothing from seeing their own name repeated on every row.
                  label: manyTenants && p.tenantName ? `${p.name} — ${p.tenantName}` : p.name,
                })),
              ]}
            />
          </label>

          <label className="rs-field">
            <span>Why you need to connect</span>
            <input
              type="text"
              value={reason}
              maxLength={300}
              placeholder="e.g. Your desk phone will not register"
              onChange={(e) => setReason(e.target.value)}
            />
            <small>They see this exactly as you type it, before they decide.</small>
          </label>

          {mayControl ? (
            <label className="rs-checkbox">
              <input type="checkbox" checked={wantControl} onChange={(e) => setWantControl(e.target.checked)} />
              <span>Also ask to control their computer (they still have to agree separately)</span>
            </label>
          ) : (
            <p className="rs-note">You can watch screens, but you are not allowed to request control.</p>
          )}

          {error && <p className="rs-error" role="alert">{error}</p>}
          {status && <p className="rs-status">{status}</p>}

          <button type="button" className="btn btn-primary" onClick={() => void ask()}>
            Ask to connect
          </button>
        </section>
      )}

      {live && (
        <div className="rs-live-grid">
        <section className={`rs-stage${isFullscreen ? " is-fullscreen" : ""}`} ref={stageRef}>
          {status && <div className="rs-stage-status">{status}</div>}
          {pictureStalled && !status && (
            <div className="rs-stage-status rs-stage-status--stalled">
              Their picture has paused. They probably minimised the window they are sharing, or the screen is locked.
              It resumes by itself when the window is back; sharing the whole screen avoids this.
            </div>
          )}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            tabIndex={0}
            className={`rs-video${controlOn ? " is-controllable" : ""}`}
            onMouseMove={(e) => {
              const p = pointFor(e);
              if (!p || !shouldSendMove(p, lastMoveRef.current)) return;
              lastMoveRef.current = p;
              send({ kind: "move", ...p });
            }}
            onMouseDown={(e) => {
              const p = pointFor(e);
              if (p) send({ kind: "down", ...p, button: mouseButtonName(e.button) });
            }}
            onMouseUp={(e) => {
              const p = pointFor(e);
              if (p) send({ kind: "up", ...p, button: mouseButtonName(e.button) });
            }}
            onDoubleClick={(e) => {
              const p = pointFor(e);
              if (p) send({ kind: "click", ...p, button: mouseButtonName(e.button), double: true });
            }}
            onContextMenu={(e) => {
              // Otherwise the browser's own menu opens over the customer's screen.
              e.preventDefault();
              const p = pointFor(e);
              if (p) send({ kind: "click", ...p, button: "right" });
            }}
            onWheel={(e) => {
              const p = pointFor(e);
              const deltaY = wheelDeltaToWindows(e.deltaY, e.deltaMode);
              if (p && deltaY !== 0) send({ kind: "scroll", ...p, deltaY });
            }}
            onKeyDown={(e) => {
              if (!controlOn) return;
              // Keep the browser out of it — Ctrl+W would close this tab and
              // drop the session rather than reaching the customer.
              e.preventDefault();
              const command = keyEventToCommand(e as any);
              if (command) send(command);
            }}
          />
          <footer className="rs-stage-foot">
            <span>
              {session?.targetUserName ? `${session.targetUserName}’s screen` : "Customer screen"}
              {session?.deviceLabel ? ` — ${session.deviceLabel}` : ""}
            </span>
            <span className={controlOn ? "rs-badge rs-badge--control" : "rs-badge"}>
              {controlOn ? "You can control this computer" : "Watching only"}
            </span>
            {controlOn && <span className="rs-hint">Click the screen first, then type.</span>}
            <button type="button" className="btn btn-secondary btn-sm rs-fullscreen" onClick={toggleFullscreen}>
              {isFullscreen ? "Exit full screen" : "Full screen"}
            </button>
            <span className="rs-link" title={linkTitle(quality, budget)}>
              <i className={`rs-link-dot is-${linkGrade(quality)}`} aria-hidden />
              {linkLabel(quality)}
            </span>
          </footer>
        </section>

        {/* ── the rail ─────────────────────────────────────────────────── */}
        <aside className="rs-rail">
          {/*
            ⛔ EVERY TOOL DRAWS FROM `granted`, WHICH ONLY THE CUSTOMER CAN FILL.
            Asking is a button; being allowed is a fact that arrives from the
            server. Nothing here may enable itself on click.
          */}
          <div className="rs-rail-tools">
            <h3>Tools</h3>
            {onCall && (
              <p className="rs-rail-yield">
                They are on a phone call — the picture is using less bandwidth until it ends.
              </p>
            )}
            {(["clipboard", "files", "admin"] as RemoteCapability[]).map((cap) => {
              const have = granted.includes(cap);
              const waiting = pendingCap === cap;
              return (
                <button
                  key={cap}
                  type="button"
                  className={`rs-tool${have ? " is-on" : ""}`}
                  disabled={have || waiting}
                  onClick={() => void askFor(cap)}
                >
                  <span className="rs-tool-t">
                    {cap === "clipboard" ? "Shared clipboard" : cap === "files" ? "Send a file" : "Administrator access"}
                  </span>
                  <span className="rs-tool-h">
                    {have
                      ? cap === "admin" ? "Allowed — Windows prompts (UAC) still need them" : "Allowed"
                      : waiting
                        ? cap === "admin" ? "Waiting — Windows is asking them to confirm…" : "Waiting for them to answer…"
                        : cap === "admin" ? "Ask them for this — they will see a Windows prompt" : "Ask them for this"}
                  </span>
                </button>
              );
            })}
            {/*
              Administrator access (2026-09-02) is an askable tool above. What it
              still cannot do is the UAC prompt itself and the lock screen — those
              run on Windows' secure desktop, which only SYSTEM may drive — so the
              "Allowed" line says the customer still answers those.
            */}
          </div>

          <div className="rs-rail-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={rail === "chat"}
              className={rail === "chat" ? "is-on" : ""}
              onClick={() => setRail("chat")}
            >
              Chat
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rail === "activity"}
              className={rail === "activity" ? "is-on" : ""}
              onClick={() => setRail("activity")}
            >
              Activity
            </button>
          </div>

          <div className="rs-rail-body" ref={railBodyRef}>
            {visibleEvents(events, rail).length === 0 ? (
              <p className="rs-rail-empty">
                {rail === "chat" ? "No messages yet." : "Nothing has happened yet."}
              </p>
            ) : (
              visibleEvents(events, rail).map((e) => (
                <div key={e.id} className={`rs-ev is-${e.kind} is-${e.actorRole.toLowerCase()}`}>
                  {e.kind === "chat" ? (
                    <>
                      <b>{e.actorRole === "ADMIN" ? "You" : session?.targetUserName || "Them"}</b>
                      {/*
                        ⛔ Rendered as TEXT. The body is sanitised server-side, and
                        this is the second half of that promise — a transcript that
                        interprets markup is a transcript somebody can write into.
                      */}
                      <span>{e.body}</span>
                    </>
                  ) : (
                    <span className="rs-ev-sys">{e.body || e.code}</span>
                  )}
                  <time dateTime={e.at}>{new Date(e.at).toLocaleTimeString()}</time>
                </div>
              ))
            )}
          </div>

          {rail === "chat" && (
            <form
              className="rs-rail-say"
              onSubmit={(e) => { e.preventDefault(); void say(); }}
            >
              <input
                type="text"
                value={draft}
                maxLength={2000}
                placeholder="Type a message to them…"
                onChange={(e) => setDraft(e.target.value)}
              />
              <button type="submit" className="btn btn-primary" disabled={draft.trim().length === 0}>
                Send
              </button>
            </form>
          )}
        </aside>
        </div>
      )}

      <section className="card rs-history">
        <h2>Recent sessions</h2>
        {history.length === 0 ? (
          <p>No remote support sessions yet.</p>
        ) : (
          <table className="rs-table">
            <thead>
              <tr>
                <th>When</th><th>Who</th><th>By</th><th>Reason</th><th>Result</th><th>Typed</th>
              </tr>
            </thead>
            <tbody>
              {history.map((s) => (
                <tr key={s.id}>
                  <td>{new Date(s.createdAt).toLocaleString()}</td>
                  <td>{s.targetUserName || s.targetUserId}</td>
                  <td>{s.requestedByName || s.requestedByUserId}</td>
                  <td>{s.requestReason}</td>
                  <td>{describeOutcome(s)}</td>
                  {/* The honest answer to "did they touch anything". */}
                  <td>{s.controlGranted ? `${s.inputEventCount} actions` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/**
 * Chat shows only what people said; Activity shows everything.
 *
 * ⛔ Activity is not filtered down to "interesting" events. It is the record of
 * what happened, and the whole value of a record is that it is complete.
 */
function visibleEvents(events: SessionEvent[], rail: "chat" | "activity"): SessionEvent[] {
  return rail === "chat" ? events.filter((e) => e.kind === "chat") : events;
}

/**
 * The link, in words rather than numbers.
 *
 * ⛔ "Measuring…" is a THIRD state and must never be drawn as "good". Stats need
 * two samples before loss means anything, so the first seconds of every session
 * legitimately know nothing — and a green light that means "we have not looked
 * yet" is the reading a technician would trust while a customer struggles.
 */
function linkGrade(q: LinkQuality | null): "unknown" | "good" | "fair" | "poor" {
  if (!q || (q.packetLoss == null && q.roundTripMs == null)) return "unknown";
  const loss = q.packetLoss ?? 0;
  const rtt = q.roundTripMs ?? 0;
  if (loss >= 0.03 || rtt >= 300) return "poor";
  if (loss >= 0.01 || rtt >= 150) return "fair";
  return "good";
}

function linkLabel(q: LinkQuality | null): string {
  const grade = linkGrade(q);
  if (grade === "unknown") return "Measuring…";
  if (grade === "good") return "Good connection";
  if (grade === "fair") return "Connection is a bit slow";
  return "Poor connection";
}

/** The numbers, for the hover, for whoever wants them. */
function linkTitle(q: LinkQuality | null, budget: MediaBudget | null): string {
  const bits: string[] = [];
  if (q?.roundTripMs != null) bits.push(`${q.roundTripMs} ms round trip`);
  if (q?.packetLoss != null) bits.push(`${(q.packetLoss * 100).toFixed(1)}% packet loss`);
  if (q?.kbps != null) bits.push(`${q.kbps} kbps`);
  if (budget?.note) bits.push(budget.note);
  return bits.length > 0 ? bits.join(" · ") : "Still measuring the connection";
}

function describeOutcome(s: RemoteSupportSession): string {
  if (s.status === "DECLINED") return "Declined";
  if (s.status === "EXPIRED") return "No answer";
  if (s.status === "ACTIVE" || s.status === "CONSENTED") return "In progress";
  if (s.status === "ENDED") {
    if (s.endedReason === "customer_disconnected") return "Customer disconnected";
    if (s.endedReason === "support_disconnected") return "Support disconnected";
    if (s.endedReason === "max_duration") return "Hit the time limit";
    if (s.endedBy === "customer") return "Customer ended it";
    return "Finished";
  }
  return s.status;
}
