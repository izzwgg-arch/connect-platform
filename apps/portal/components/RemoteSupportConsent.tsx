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
  answerCapability,
  answerConsent,
  desktopBridge,
  endSession,
  getSession,
  isDesktopShell,
  pendingForMe,
  reportInputCount,
  type RemoteCapability,
  type RemoteSupportSession,
} from "../services/remoteSupport";
import { sanitizeIncomingInput } from "../lib/remoteSupportGuards";
import { hasBrowserAuthToken } from "../services/apiClient";
import { useOptionalSipPhone } from "../hooks/useSipPhone";

type Screen = { id: string; name: string; thumbnailDataUrl: string; isScreen: boolean };

/** How often we ask whether anyone wants to connect. */
const PENDING_POLL_MS = 5_000;

export default function RemoteSupportConsent() {
  const [request, setRequest] = useState<RemoteSupportSession | null>(null);
  const [screens, setScreens] = useState<Screen[]>([]);
  const [chosenScreen, setChosenScreen] = useState<string | null>(null);
  const [allowControl, setAllowControl] = useState(false);
  /**
   * ⛔ The extras the customer has ticked, and it starts EMPTY every time.
   * There is no "remember this choice" and no standing consent — a session is
   * agreed to one at a time, every time.
   */
  const [allowCaps, setAllowCaps] = useState<RemoteCapability[]>([]);
  const [live, setLive] = useState<RemoteSupportSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** True while the server has clamped the picture because a call is up. */
  const [yieldingToCall, setYieldingToCall] = useState(false);
  /** A mid-session ask the technician has made and this person has not answered. */
  const [capAsk, setCapAsk] = useState<RemoteCapability | null>(null);

  const peerRef = useRef<RemoteSupportPeer | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputCountRef = useRef(0);

  /**
   * ⛔ `useOptionalSipPhone`, never `useSipPhone`. This component is mounted
   * globally — including on pages that render OUTSIDE the SIP provider — and
   * chrome must never crash the whole app over a missing provider. Null here
   * simply means "this window has no phone", which is not the same as "no call
   * is happening" but is the best this window can honestly say.
   */
  const phone = useOptionalSipPhone();
  const onCall = phone?.callState === "connected" || phone?.callState === "ringing";
  const onCallRef = useRef(onCall);
  onCallRef.current = onCall;

  const bridge = desktopBridge();

  /**
   * ⛔ THE PRODUCTION GATE. This component is mounted globally, so without this
   * check EVERY signed-in user — every customer, in every browser and in the
   * Connect desktop app — would poll for support requests every few seconds
   * the moment the portal deploys.
   *
   * Remote support only exists in the separate "Loopcom Support" app, which is
   * the only build that exposes `connectDesktop.remoteSupport`. The Connect
   * desktop app deliberately does not, so it and every browser fall through
   * here and do nothing at all: no polling, no network traffic, no UI.
   *
   * ⛔ Adding a `remoteSupport` key to the Connect app's preload would silently
   * switch this on for the entire customer base. Do not, until that is the
   * decision being made.
   */
  const supported = Boolean(bridge?.remoteSupport?.listScreens);

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
    if (!supported) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || live) return;
      // Signed out — on /login, or after the api refused our session and the
      // token was cleared — there is nobody to ask. Every 5-second probe would
      // be a guaranteed 401, and 60 of those in five minutes is the nginx ban.
      if (!hasBrowserAuthToken()) return;
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
  }, [live, supported]);

  /*
   * ⛔ THE OTHER HALF OF "ASK FOR MORE", AND WITHOUT IT THE FEATURE IS A LIE.
   *
   * A technician can ask mid-session for the clipboard or file transfer. The
   * server records that ask and puts it on this screen — but only if this screen
   * looks. Until it did, the request landed nowhere, the customer was never
   * asked, and the technician's rail sat on "Waiting for them to answer…"
   * forever. The permission model was sound and simply unreachable.
   *
   * The question is derived, never pushed: anything REQUESTED that is not yet
   * GRANTED is outstanding. That means a refresh, a reconnect or a second window
   * all arrive at the same answer, and a dropped message cannot lose the ask.
   */
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || !hasBrowserAuthToken()) return;
      try {
        const { session } = await getSession(live.id);
        if (cancelled) return;
        const asked = (session.capabilitiesRequested ?? []) as RemoteCapability[];
        const has = new Set(session.capabilitiesGranted ?? []);
        // ⛔ `view` and `control` were settled by the consent dialog. Re-asking
        // for them here would be a second, weaker prompt for a decision that
        // was already made properly.
        setCapAsk(asked.find((c) => c !== "view" && c !== "control" && !has.has(c)) ?? null);
      } catch {
        /* transient — the next tick asks again */
      }
    };
    void tick();
    const timer = setInterval(tick, PENDING_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [live]);

  const answerCap = useCallback(async (capability: RemoteCapability, allow: boolean) => {
    if (!live) return;
    setCapAsk(null); // the question is answered the moment they press, not when the network agrees
    // ⛔ ADMINISTRATOR ACCESS IS DELIVERED BEFORE IT IS RECORDED. The elevated
    // helper is started first — Windows shows the UAC prompt now — and only a
    // helper that is really running lets the grant reach the server. A declined
    // prompt records a refusal, so the technician never sees "Allowed" for
    // something that cannot act.
    if (capability === "admin" && allow) {
      const up = await bridge?.remoteSupport?.enableElevatedControl?.(live.id).catch(() => false);
      if (!up) {
        setError(
          "Administrator access was not turned on. If a Windows prompt appeared, it was closed or declined; " +
          "the support person can ask again.",
        );
        allow = false;
      }
    }
    try {
      await answerCapability(live.id, capability, allow);
    } catch {
      // ⛔ A failed NO must not silently become a yes. Nothing was granted —
      // the server only ever grants on an explicit allow — so putting the
      // question back is the honest recovery.
      if (!allow) setCapAsk(capability);
    }
  }, [live]);

  // Offer the screen list as soon as there is something to answer.
  useEffect(() => {
    if (!request || !bridge?.remoteSupport?.listScreens) return;
    let cancelled = false;
    bridge.remoteSupport
      .listScreens()
      .then((list: Screen[]) => {
        if (cancelled) return;
        // Whole screens first. A single window is offered, but it stops
        // updating the moment it is minimised — the technician sees a frozen
        // picture and both people conclude the session broke (2026-09-02).
        const ordered = [...list].sort((a, b) => Number(b.isScreen) - Number(a.isScreen));
        setScreens(ordered);
        setChosenScreen(ordered.find((s) => s.isScreen)?.id ?? ordered[0]?.id ?? null);
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

      // Administrator access ticked at consent time: the Windows prompt comes
      // first, and a declined prompt simply removes the tick before anything is
      // recorded. (Ordinary control is not affected either way.)
      let allowCapsFinal = allowCaps;
      if (allowCaps.includes("admin") && allowControl && bridge?.remoteSupport?.enableElevatedControl) {
        // Control must be enabled first — elevation upgrades a control session.
        const plain = await bridge.remoteSupport.enableControl(request.id).catch(() => false);
        const up = plain ? await bridge.remoteSupport.enableElevatedControl(request.id).catch(() => false) : false;
        if (!up) {
          allowCapsFinal = allowCaps.filter((c) => c !== "admin");
          setError("Administrator access was not turned on (the Windows prompt was declined or closed). Everything else you allowed still applies.");
        }
      }

      const machine = await bridge?.remoteSupport?.machineInfo?.().catch(() => null);
      const deviceLabel = machine
        ? `${machine.hostname} (${machine.platform} ${machine.release}, app ${machine.appVersion})`
        : undefined;

      const answer = await answerConsent(request.id, {
        allow: true,
        allowControl,
        // ⛔ Sent as what the CUSTOMER ticked. The server still requires that the
        // technician asked for each one and holds the control key right now, so
        // this list can only ever narrow what is granted, never widen it.
        allowCapabilities: allowCapsFinal,
        deviceLabel,
        deviceId: machine?.deviceId || undefined,
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
        onHeartbeat: ({ callInProgress }) => setYieldingToCall(Boolean(callInProgress)),
      });
      // ⛔ Non-negotiable rule 15: remote support yields to a phone call. The
      // customer's machine is the ONLY side that knows a call is up, so it is
      // the only side that can answer this — and until it did, the server's
      // on-call budget could never be chosen. Read through a REF so a call that
      // starts mid-session is seen: the closure is built once, the ref is not.
      peer.onCall = () => onCallRef.current;
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

  // ⛔ Not the support app — render nothing, ever. Belt and braces alongside the
  // polling gate above, so a future edit that reorders the effects still cannot
  // put a dialog in front of a customer.
  if (!supported) return null;

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
          {/*
            ⛔ Say WHY the picture got softer. Without this the customer sees
            their screen share degrade at the exact moment a call connects and
            reasonably concludes that remote support broke their phone. It is
            the opposite: the sharing stepped aside so the call keeps its
            bandwidth.
          */}
          {yieldingToCall && (
            <em className="rs-live-note"> — using less of your internet while you are on a call</em>
          )}
        </span>
        <button type="button" className="btn" onClick={() => void teardown(live.id)}>
          Stop sharing
        </button>

        {/*
          ⛔ The mid-session ask. It sits INSIDE the always-visible banner rather
          than in a popup on purpose: a popup can be behind another window, and a
          permission question the customer never sees is one they cannot refuse.

          ⛔ "No" is a real, equal button — not a dismissal, not an X in a corner.
          Nothing is granted unless this person presses Allow.
        */}
        {capAsk && (
          <div className="rs-live-ask" role="alert">
            <span>
              {live.requestedByName || "Loopcom support"} is asking to{" "}
              {CAPABILITY_ASK_TEXT[capAsk] ?? capAsk}.
            </span>
            <button type="button" className="btn" onClick={() => void answerCap(capAsk, false)}>
              No
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void answerCap(capAsk, true)}>
              Allow
            </button>
          </div>
        )}
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
  const askedFor = new Set(request.capabilitiesRequested ?? []);
  const canControlHere = isDesktopShell();

  const toggleCap = (cap: RemoteCapability) => {
    setAllowCaps((prev) => (prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]));
  };
  // Administrator access can only be delivered by the desktop app, and only as
  // an upgrade of control — so its tick is live only when both hold.
  const canElevateHere = canControlHere && Boolean(bridge?.remoteSupport?.enableElevatedControl);
  const canTick = (cap: RemoteCapability) => (cap === "admin" ? canElevateHere && allowControl : canControlHere);

  return (
    <div className="rs-backdrop" role="dialog" aria-modal="true" aria-labelledby="rs-title">
      <div className="rs-card">
        <div className="rs-brand">
          <span className="rs-brand-mark" aria-hidden />
          Loopcom Technical Support
        </div>

        <h2 id="rs-title" className="rs-title">
          {request.requestedByName || "Loopcom support"} is asking to connect to this computer
        </h2>

        {/* The reason, verbatim. This is what makes it informed consent. */}
        <p className="rs-reason">“{request.requestReason}”</p>

        {/*
          ⛔ EVERY CAPABILITY IS ITS OWN TICK, AND EVERY ONE STARTS OFF.
          Seeing the screen is the only thing implied by allowing at all; control
          does not imply clipboard, and clipboard does not imply files. The rows
          shown are exactly what was ASKED for, so the dialog can never offer
          something the technician was not allowed to request.
        */}
        <div className="rs-label">What {request.requestedByName || "they"} are asking for</div>
        <div className="rs-caps">
          <div className="rs-cap is-locked">
            <span className="rs-cap-box" aria-hidden>✓</span>
            <span>
              <span className="rs-cap-t">See my screen</span>
              <span className="rs-cap-h">Required. They see only the screen you pick below.</span>
            </span>
          </div>

          {askedForControl && (
            <label className={`rs-cap${allowControl ? " is-on" : ""}${canControlHere ? "" : " is-dis"}`}>
              <input
                type="checkbox"
                className="rs-cap-input"
                checked={allowControl}
                disabled={!canControlHere}
                onChange={(e) => setAllowControl(e.target.checked)}
              />
              <span className="rs-cap-box" aria-hidden>{allowControl ? "✓" : ""}</span>
              <span>
                <span className="rs-cap-t">Use my mouse and keyboard</span>
                <span className="rs-cap-h">
                  {canControlHere
                    ? "They can click and type on this computer. Yours always wins."
                    : "Not available in a web browser — only in the Loopcom desktop app."}
                </span>
              </span>
            </label>
          )}

          {CAPABILITY_ROWS.filter((row) => askedFor.has(row.id)).map((row) => (
            <label
              key={row.id}
              className={`rs-cap${allowCaps.includes(row.id) ? " is-on" : ""}${canTick(row.id) ? "" : " is-dis"}`}
            >
              <input
                type="checkbox"
                className="rs-cap-input"
                checked={allowCaps.includes(row.id)}
                disabled={!canTick(row.id)}
                onChange={() => toggleCap(row.id)}
              />
              <span className="rs-cap-box" aria-hidden>{allowCaps.includes(row.id) ? "✓" : ""}</span>
              <span>
                <span className="rs-cap-t">{row.title}</span>
                <span className="rs-cap-h">{row.hint}</span>
              </span>
            </label>
          ))}

          {/*
            Administrator access (2026-09-02) renders through CAPABILITY_ROWS
            like the rest. It is offered only where it can really be delivered —
            the Connect desktop app on Windows, with control allowed — because
            elevation is an upgrade of control, never a way to obtain it.
          */}
        </div>

        {screens.length > 0 && (
          <div className="rs-screens">
            <div className="rs-label">Which screen</div>
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
                  <span>{s.isScreen ? `${s.name} — whole screen` : s.name}</span>
                </button>
              ))}
            </div>
            {screens.some((s) => !s.isScreen) && (
              <p className="rs-note">
                Sharing the whole screen is the safe choice. If you share one window, the picture stops for the
                support person whenever that window is minimised.
              </p>
            )}
          </div>
        )}

        {!canControlHere && (
          <p className="rs-note">
            You are signed in through a web browser, so the support person can only watch — anything
            beyond that is only possible in the Loopcom desktop app.
          </p>
        )}

        {error && <p className="rs-error" role="alert">{error}</p>}

        <div className="rs-actions">
          <button type="button" className="btn" onClick={() => void decline()} disabled={busy}>
            Not now
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void allow()} disabled={busy}>
            {busy ? "Starting…" : "Allow for this session"}
          </button>
        </div>

        <p className="rs-footnote">
          You can stop this at any time. Loopcom does not record your screen, and nothing you share is
          stored on our servers.
        </p>
      </div>
    </div>
  );
}

/**
 * The extra capabilities a customer can tick, in the order they appear.
 *
 * ⛔ Wording is written for a person who is not technical and who is being asked
 * to let a stranger onto their computer. "Share clipboard text" says what it
 * does; "enable clipboard synchronisation" does not.
 */
const CAPABILITY_ROWS: Array<{ id: RemoteCapability; title: string; hint: string }> = [
  {
    id: "clipboard",
    title: "Share clipboard text",
    hint: "Copy and paste between their machine and yours.",
  },
  {
    id: "files",
    title: "Send and receive files",
    hint: "Files arrive in Documents → Loopcom Support.",
  },
  {
    id: "admin",
    title: "Administrator access",
    hint: "Lets them work in windows that need administrator rights. Windows will show its own prompt — click Yes to allow it.",
  },
];

/** What a live mid-session ask says, per capability, in the customer's words. */
const CAPABILITY_ASK_TEXT: Record<string, string> = {
  clipboard: "share your clipboard",
  files: "send you a file",
  admin: "use administrator access on this computer. Windows will show its own prompt — click Yes to allow it",
};
