"use client";

/**
 * The customer's side of remote support: the prompt that asks permission, and
 * everything that happens once they say yes.
 *
 * ⛔ DESIGN RULES, all of them deliberate:
 *
 *  1. Nothing is shared until this component is told the customer pressed
 *     Allow. There is no auto-accept, no "remember this choice", and no
 *     standing permission. Every session is asked for.
 *
 *  2. The reason the support person typed is shown VERBATIM and prominently.
 *     A permission prompt the customer cannot understand is not consent.
 *
 *  3. Control is a SEPARATE tick box, off by default, and only offered when it
 *     was actually requested. Allowing someone to look is not allowing them to
 *     type.
 *
 *  4. The customer picks which screen. On a two-monitor machine, choosing for
 *     them risks sharing the one with their personal email open.
 *
 *  5. Once live, an always-on-top banner says so and can stop it. That banner
 *     is drawn by the Electron main process, not here, precisely so it cannot
 *     be hidden by this window being minimised.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  RemoteSupportPeer,
  answerConsent,
  desktopBridge,
  endSession,
  isDesktopShell,
  pendingForMe,
  reportInputCount,
  type RemoteSupportSession,
} from "../services/remoteSupport";
import { sanitizeIncomingInput } from "../lib/remoteSupportGuards";

type Screen = { id: string; name: string; thumbnailDataUrl: string; isScreen: boolean };

/** How often we ask whether anyone wants to connect. */
const PENDING_POLL_MS = 5_000;

export default function RemoteSupportConsent() {
  const [request, setRequest] = useState<RemoteSupportSession | null>(null);
  const [screens, setScreens] = useState<Screen[]>([]);
  const [chosenScreen, setChosenScreen] = useState<string | null>(null);
  const [allowControl, setAllowControl] = useState(false);
  const [live, setLive] = useState<RemoteSupportSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const peerRef = useRef<RemoteSupportPeer | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputCountRef = useRef(0);

  const bridge = desktopBridge();

  /** Everything torn down together — local first, server second. */
  const teardown = useCallback(async (sessionId?: string) => {
    try { peerRef.current?.stop(); } catch { /* already gone */ }
    peerRef.current = null;

    for (const track of streamRef.current?.getTracks() ?? []) {
      try { track.stop(); } catch { /* already stopped */ }
    }
    streamRef.current = null;

    try { await bridge?.remoteSupport?.disableControl?.(); } catch { /* not desktop */ }
    try { await bridge?.remoteSupport?.setBanner?.({ visible: false }); } catch { /* not desktop */ }

    if (sessionId) {
      // Flush the honest count of what was actually typed before closing out.
      if (inputCountRef.current > 0) {
        await reportInputCount(sessionId, inputCountRef.current).catch(() => {});
        inputCountRef.current = 0;
      }
      await endSession(sessionId).catch(() => {});
    }
    setLive(null);
  }, [bridge]);

  // Is anyone asking? This is the only polling the customer's machine does
  // while nothing is happening.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || live) return;
      try {
        const res = await pendingForMe();
        const waiting = res.sessions.find((s) => s.status === "REQUESTED");
        if (!cancelled) setRequest(waiting ?? null);
      } catch {
        /* offline or signed out — nothing to show */
      }
    };
    void tick();
    const timer = setInterval(tick, PENDING_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [live]);

  // Offer the screen list as soon as there is something to answer.
  useEffect(() => {
    if (!request || !bridge?.remoteSupport?.listScreens) return;
    let cancelled = false;
    bridge.remoteSupport
      .listScreens()
      .then((list: Screen[]) => {
        if (cancelled) return;
        setScreens(list);
        setChosenScreen(list.find((s) => s.isScreen)?.id ?? list[0]?.id ?? null);
      })
      .catch(() => { /* the browser picker is the fallback */ });
    return () => { cancelled = true; };
  }, [request, bridge]);

  // The banner's Stop button.
  useEffect(() => {
    const off = bridge?.remoteSupport?.onStopRequested?.(() => {
      void teardown(live?.id);
    });
    return () => { try { off?.(); } catch { /* nothing registered */ } };
  }, [bridge, live, teardown]);

  const decline = useCallback(async () => {
    if (!request) return;
    setBusy(true);
    try {
      await answerConsent(request.id, { allow: false });
      setRequest(null);
    } catch {
      setError("That could not be sent. The request may have already timed out.");
    } finally {
      setBusy(false);
    }
  }, [request]);

  const allow = useCallback(async () => {
    if (!request) return;
    setBusy(true);
    setError(null);

    try {
      // Tell Electron which screen before asking for it, or it picks one.
      if (chosenScreen && bridge?.remoteSupport?.setScreen) {
        await bridge.remoteSupport.setScreen(chosenScreen);
      }

      const machine = await bridge?.remoteSupport?.machineInfo?.().catch(() => null);
      const deviceLabel = machine
        ? `${machine.hostname} (${machine.platform} ${machine.release}, app ${machine.appVersion})`
        : undefined;

      const answer = await answerConsent(request.id, {
        allow: true,
        allowControl,
        deviceLabel,
      });
      if (!answer.allowed || !answer.session) throw new Error("consent_not_recorded");
      const session = answer.session;

      // ⛔ Audio is never captured. Support needs to see the screen, not listen
      // to the room the customer is sitting in.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      streamRef.current = stream;

      // If the customer stops sharing using the browser/OS control rather than
      // our banner, that must end the session too.
      for (const track of stream.getVideoTracks()) {
        track.addEventListener("ended", () => { void teardown(session.id); });
      }

      let controlActive = false;
      if (session.controlGranted && bridge?.remoteSupport?.enableControl) {
        controlActive = await bridge.remoteSupport.enableControl(session.id).catch(() => false);
        if (!controlActive) {
          // ⛔ Said out loud rather than swallowed. A control session where
          // nothing moves reads to both people as a broken product.
          setError(
            "Screen sharing has started, but controlling this computer is not available here, " +
            "so the support person can only look.",
          );
        }
      }

      const peer = new RemoteSupportPeer(session.id, "customer", {
        onInput: (raw) => {
          if (!controlActive) return;
          const command = sanitizeIncomingInput(raw);
          if (!command) return;
          inputCountRef.current += 1;
          bridge?.remoteSupport?.sendInput?.({ sessionId: session.id, command });
        },
        onClosed: () => { void teardown(session.id); },
      });
      peerRef.current = peer;
      await peer.start(stream);

      await bridge?.remoteSupport?.setBanner?.({
        visible: true,
        supportName: session.requestedByName || "Loopcom support",
        controlGranted: controlActive,
      });

      setLive({ ...session, controlGranted: controlActive });
      setRequest(null);
    } catch (err: any) {
      // A refused screen picker is the common case and is not an error worth
      // shouting about.
      const aborted = err?.name === "NotAllowedError" || err?.name === "AbortError";
      setError(
        aborted
          ? "Screen sharing was cancelled, so nothing was shared."
          : "The connection could not be started. Nothing has been shared.",
      );
      await teardown(request.id);
      setRequest(null);
    } finally {
      setBusy(false);
    }
  }, [request, chosenScreen, allowControl, bridge, teardown]);

  // Nothing to show.
  if (!request && !live && !error) return null;

  if (live) {
    // A small in-app reminder. The real, unmissable one is the always-on-top
    // banner drawn by the main process.
    return (
      <div className="rs-live" role="status">
        <span className="rs-live-dot" aria-hidden />
        <span>
          {live.requestedByName || "Loopcom support"} {live.controlGranted ? "can see and control" : "can see"} your screen
        </span>
        <button type="button" className="btn" onClick={() => void teardown(live.id)}>
          Stop sharing
        </button>
      </div>
    );
  }

  if (!request) {
    return error ? (
      <div className="rs-live rs-live--error" role="alert">
        <span>{error}</span>
        <button type="button" className="btn" onClick={() => setError(null)}>Close</button>
      </div>
    ) : null;
  }

  const askedForControl = request.controlRequested;

  return (
    <div className="rs-backdrop" role="dialog" aria-modal="true" aria-labelledby="rs-title">
      <div className="rs-card">
        <h2 id="rs-title" className="rs-title">
          {request.requestedByName || "Loopcom support"} would like to see your screen
        </h2>

        {/* The reason, verbatim. This is what makes it informed consent. */}
        <p className="rs-reason">“{request.requestReason}”</p>

        {screens.length > 0 && (
          <div className="rs-screens">
            <div className="rs-label">Choose what to share</div>
            <div className="rs-screen-grid">
              {screens.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`rs-screen${chosenScreen === s.id ? " is-chosen" : ""}`}
                  onClick={() => setChosenScreen(s.id)}
                  aria-pressed={chosenScreen === s.id}
                >
                  {s.thumbnailDataUrl ? (
                    <img src={s.thumbnailDataUrl} alt="" />
                  ) : (
                    <div className="rs-screen-blank" />
                  )}
                  <span>{s.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {askedForControl && (
          <label className="rs-control">
            <input
              type="checkbox"
              checked={allowControl}
              onChange={(e) => setAllowControl(e.target.checked)}
            />
            <span>
              <strong>Also let them control this computer.</strong>
              <br />
              They will be able to move your mouse and type. Leave this unticked and they can only watch.
            </span>
          </label>
        )}

        {!isDesktopShell() && (
          <p className="rs-note">
            You are signed in through a web browser, so the support person can only watch — controlling
            is only possible in the Connect desktop app.
          </p>
        )}

        {error && <p className="rs-error" role="alert">{error}</p>}

        <div className="rs-actions">
          <button type="button" className="btn" onClick={() => void decline()} disabled={busy}>
            No thanks
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void allow()} disabled={busy}>
            {busy ? "Starting…" : allowControl ? "Allow watching and control" : "Allow watching"}
          </button>
        </div>

        <p className="rs-footnote">You can stop this at any time, and they will be disconnected straight away.</p>
      </div>
    </div>
  );
}
