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
import { useAppContext } from "../../../../hooks/useAppContext";
import {
  RemoteSupportPeer,
  endSession,
  getSession,
  listSessions,
  reportInputCount,
  requestSession,
  type RemoteSupportSession,
} from "../../../../services/remoteSupport";
import {
  elementPointToScreenFraction,
  keyEventToCommand,
  mouseButtonName,
  shouldSendMove,
  wheelDeltaToWindows,
} from "../../../../lib/remoteSupportInput";
import { apiGet } from "../../../../services/apiClient";

type TeamMember = { id: string; firstName?: string | null; lastName?: string | null; email: string };

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

  const [people, setPeople] = useState<TeamMember[]>([]);
  const [targetUserId, setTargetUserId] = useState("");
  const [reason, setReason] = useState("");
  const [wantControl, setWantControl] = useState(false);
  const [session, setSession] = useState<RemoteSupportSession | null>(null);
  const [history, setHistory] = useState<RemoteSupportSession[]>([]);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [controlOn, setControlOn] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<RemoteSupportPeer | null>(null);
  const lastMoveRef = useRef<{ x: number; y: number } | null>(null);
  const inputCountRef = useRef(0);

  useEffect(() => {
    apiGet<{ users?: TeamMember[] }>("/team/members")
      .then((r) => setPeople(r.users ?? []))
      .catch(() => setPeople([]));
    void refreshHistory();
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
          });
          peerRef.current = peer;
          await peer.start();
          setControlOn(fresh.controlGranted && mayControl);
        }
      } catch {
        /* transient — the next tick tries again */
      }
    }, 1_000);

    return () => { cancelled = true; clearInterval(timer); };
  }, [session, mayControl, refreshHistory]);

  useEffect(() => () => { try { peerRef.current?.stop(); } catch { /* noop */ } }, []);

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
            <select value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)}>
              <option value="">Choose a person…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {[p.firstName, p.lastName].filter(Boolean).join(" ") || p.email}
                </option>
              ))}
            </select>
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
        <section className="rs-stage">
          {status && <div className="rs-stage-status">{status}</div>}
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
          </footer>
        </section>
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
