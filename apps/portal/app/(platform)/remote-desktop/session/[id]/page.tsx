"use client";

/**
 * Screen 3 — the live Remote Desktop session (the connecting side).
 *
 * Full-window stage: the remote screen fills it, the toolbar is the whole
 * control surface. Sound and microphone are two switches that say where each
 * one is right now. Built to the approved mockup; the stage is dark in both
 * themes on purpose (its own visual world, like the IDE).
 *
 * Own-computer sessions log in first: the username and password typed on the
 * home page were handed here through sessionStorage for one read and travel to
 * the machine over the encrypted peer connection only. ⛔ Until the machine says
 * `login_result ok`, there is nothing to see — that is the design, not a delay.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  RemoteDesktopPeer,
  endSession,
  getSession,
  listEvents,
  reportAudio,
  reportInputCount,
  type DesktopSession,
  type LinkQuality,
  type MediaBudget,
  type SessionEvent,
} from "../../../../../services/remoteDesktop";
import { describeEnd, linkGrade, linkLabel, type MachineFrame } from "../../../../../lib/remoteDesktop";
import { elementPointToScreenFraction, keyEventToCommand, mouseButtonName, shouldSendMove, wheelDeltaToWindows } from "../../../../../lib/remoteSupportInput";

const LOGIN_HANDOFF_KEY = (sessionId: string) => `rd-login-${sessionId}`;

type Handoff = { username?: string; password?: string; monitor?: string; picture?: string; sound?: boolean; mic?: boolean; clipboard?: boolean };

export default function RemoteDesktopSessionPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const sessionId = String(params?.id || "");

  const [session, setSession] = useState<DesktopSession | null>(null);
  const [phase, setPhase] = useState<"connecting" | "login" | "live" | "ended">("connecting");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [endedText, setEndedText] = useState<string | null>(null);
  const [screens, setScreens] = useState<Array<{ id: string; name: string }>>([]);
  const [screenIdx, setScreenIdx] = useState(0);
  const [sound, setSound] = useState(true);
  const [mic, setMic] = useState(true);
  const [clipOn, setClipOn] = useState(true);
  const [fit, setFit] = useState<"fit" | "actual">("fit");
  const [fullscreen, setFullscreen] = useState(false);
  const [quality, setQuality] = useState<LinkQuality | null>(null);
  const [route, setRoute] = useState<"direct" | "relay" | null>(null);
  const [budget, setBudget] = useState<MediaBudget | null>(null);
  const [remoteOnCall, setRemoteOnCall] = useState(false);
  const [remoteLocked, setRemoteLocked] = useState(false);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [tab, setTab] = useState<"details" | "activity">("details");
  const [since, setSince] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);

  const peerRef = useRef<RemoteDesktopPeer | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const lastMoveRef = useRef<{ x: number; y: number } | null>(null);
  const inputCountRef = useRef(0);
  const handoffRef = useRef<Handoff | null>(null);
  const loginSentRef = useRef(false);
  const authRef = useRef(false);
  const wantedRef = useRef({ sound: true, mic: true });

  const granted = session?.capabilitiesGranted ?? [];
  const canControl = granted.includes("control");
  const canSound = granted.includes("sound");
  const canMic = granted.includes("mic");
  const canClip = granted.includes("clipboard");
  const controlOn = phase === "live" && canControl && !remoteLocked;

  // Read the one-time handoff from the home page.
  useEffect(() => {
    if (!sessionId) return;
    try {
      const raw = sessionStorage.getItem(LOGIN_HANDOFF_KEY(sessionId));
      if (raw) {
        sessionStorage.removeItem(LOGIN_HANDOFF_KEY(sessionId));
        const h: Handoff = JSON.parse(raw);
        handoffRef.current = h;
        if (typeof h.sound === "boolean") { setSound(h.sound); wantedRef.current.sound = h.sound; }
        if (typeof h.mic === "boolean") { setMic(h.mic); wantedRef.current.mic = h.mic; }
        if (typeof h.clipboard === "boolean") setClipOn(h.clipboard);
        if (h.picture === "smooth") setFit("fit");
      }
    } catch { /* ask instead */ }
  }, [sessionId]);

  const finish = useCallback((text: string) => {
    setPhase("ended");
    setEndedText(text);
    try { peerRef.current?.stop(); } catch { /* gone */ }
    peerRef.current = null;
    for (const t of micStreamRef.current?.getTracks() ?? []) { try { t.stop(); } catch { /* stopped */ } }
    micStreamRef.current = null;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, []);

  /** Apply the sound/mic switches: tell the machine, and route our side. */
  const pushAudio = useCallback(async (nextSound: boolean, nextMic: boolean) => {
    const peer = peerRef.current;
    wantedRef.current = { sound: nextSound, mic: nextMic };
    if (!peer || !authRef.current) return;
    const s = nextSound && canSound;
    const m = nextMic && canMic;
    if (videoRef.current) videoRef.current.muted = !s;
    if (m) {
      if (!micStreamRef.current) {
        try { micStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch { setMic(false); wantedRef.current.mic = false; }
      }
      await peer.attachMicrophone(micStreamRef.current);
    } else {
      await peer.attachMicrophone(null);
      for (const t of micStreamRef.current?.getTracks() ?? []) { try { t.stop(); } catch { /* stopped */ } }
      micStreamRef.current = null;
    }
    peer.sendFrame({ t: "audio", sound: s, mic: m && Boolean(micStreamRef.current) });
    void reportAudio(sessionId, s, m && Boolean(micStreamRef.current));
  }, [canSound, canMic, sessionId]);

  const sendLogin = useCallback((u: string, p: string) => {
    const peer = peerRef.current;
    if (!peer || !peer.controlChannelOpen) return false;
    setLoginBusy(true);
    setLoginError(null);
    return peer.sendFrame({ t: "login", username: u, password: p });
  }, []);

  const onMachineFrame = useCallback((frame: MachineFrame) => {
    switch (frame.t) {
      case "login_result":
        setLoginBusy(false);
        if (frame.ok) {
          authRef.current = true;
          setPhase("live");
          setPassword("");
          void pushAudio(wantedRef.current.sound, wantedRef.current.mic);
        } else {
          loginSentRef.current = false;
          setPhase("login");
          if (frame.lockedForMs && frame.lockedForMs > 0) {
            setLoginError(`Too many wrong passwords. That computer is locked for ${Math.ceil(frame.lockedForMs / 60_000)} minutes.`);
          } else {
            setLoginError(frame.attemptsLeft != null ? `Wrong username or password. ${frame.attemptsLeft} ${frame.attemptsLeft === 1 ? "try" : "tries"} left.` : "Wrong username or password.");
          }
        }
        return;
      case "ready":
        if (authRef.current) setPhase("live");
        return;
      case "screens":
        setScreens(frame.screens);
        return;
      case "clip":
        if (clipOn && canClip) navigator.clipboard?.writeText(frame.text).catch(() => {});
        return;
      case "locked":
        setRemoteLocked(frame.locked);
        return;
      case "phone":
        setRemoteOnCall(frame.onCall);
        return;
    }
  }, [pushAudio, clipOn, canClip]);

  // Build the peer once the session row is known.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      let row: DesktopSession;
      try {
        row = (await getSession(sessionId)).session;
      } catch (e: any) {
        if (!cancelled) finish(e?.body?.message || "That session could not be found.");
        return;
      }
      if (cancelled) return;
      setSession(row);
      if (row.status === "ENDED" || row.status === "DECLINED" || row.status === "EXPIRED") { finish(describeEnd(row.endedReason, row.endedBy)); return; }
      authRef.current = row.clientAuthenticated || !row.authRequired;

      const peer = new RemoteDesktopPeer(sessionId, "viewer", {
        onStream: (stream) => {
          const el = videoRef.current;
          if (!el) return;
          el.srcObject = stream;
          el.muted = !(wantedRef.current.sound && row.capabilitiesGranted.includes("sound"));
          el.play().catch(() => {});
          el.onloadedmetadata = () => setVideoSize({ w: el.videoWidth, h: el.videoHeight });
          if (authRef.current) setPhase("live");
        },
        onMachineFrame,
        onStateChange: (state) => {
          if (state === "connected") {
            // A share session is authenticated by the password the owner issued.
            if (authRef.current) { void pushAudio(wantedRef.current.sound, wantedRef.current.mic); return; }
            // Own computer: send the login the moment the channel opens.
            const wait = setInterval(() => {
              if (!peerRef.current?.controlChannelOpen) return;
              clearInterval(wait);
              const h = handoffRef.current;
              if (h?.username && h?.password && !loginSentRef.current) {
                loginSentRef.current = true;
                setUsername(h.username);
                if (!sendLogin(h.username, h.password)) { loginSentRef.current = false; setPhase("login"); }
              } else {
                setPhase("login");
              }
            }, 100);
            setTimeout(() => clearInterval(wait), 20_000);
          }
        },
        onClosed: (reason) => { if (!cancelled) void getSession(sessionId).then((r) => finish(describeEnd(r.session.endedReason, r.session.endedBy))).catch(() => finish(describeEnd(reason, null))); },
        onHeartbeat: ({ status, capabilities, mediaBudget, quality: q, locked }) => {
          if (q) setQuality(q);
          if (mediaBudget) setBudget(mediaBudget);
          if (typeof locked === "boolean") setRemoteLocked(locked);
          setSession((cur) => (cur ? { ...cur, status, capabilitiesGranted: capabilities } : cur));
          if (status === "ENDED" || status === "DECLINED" || status === "EXPIRED") void getSession(sessionId).then((r) => finish(describeEnd(r.session.endedReason, r.session.endedBy))).catch(() => finish("The session ended."));
        },
        onRoute: (r) => setRoute(r),
      });
      peerRef.current = peer;
      await peer.start().catch((e: any) => finish(e?.message || "Could not start the connection."));
      // The machine may not have been told yet; heartbeats carry `started`.
      setSince(Date.now());
    })();
    return () => { cancelled = true; try { peerRef.current?.stop(); } catch { /* gone */ } peerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // The activity rail and the timer.
  useEffect(() => {
    if (phase === "ended" || !sessionId) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    const ev = setInterval(() => { listEvents(sessionId).then((r) => setEvents(r.events)).catch(() => {}); }, 5000);
    listEvents(sessionId).then((r) => setEvents(r.events)).catch(() => {});
    return () => { clearInterval(t); clearInterval(ev); };
  }, [phase, sessionId]);

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Leaving the page ends the session honestly rather than leaving the machine
  // waiting for a heartbeat that never comes.
  useEffect(() => {
    const onUnload = () => { if (phase !== "ended") void endSession(sessionId).catch(() => {}); };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [phase, sessionId]);

  const disconnect = async () => {
    if (inputCountRef.current > 0) await reportInputCount(sessionId, inputCountRef.current).catch(() => {});
    await endSession(sessionId).catch(() => {});
    finish("You disconnected.");
  };

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

  const switchScreen = (idx: number) => {
    const s = screens[idx];
    if (!s) return;
    setScreenIdx(idx);
    peerRef.current?.sendFrame({ t: "monitor", sourceId: s.id });
  };

  const pasteToRemote = async () => {
    if (!canClip || !clipOn) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) peerRef.current?.sendFrame({ t: "clip", text: text.slice(0, 100_000) });
    } catch { /* clipboard refused */ }
  };

  const toggleFullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen().catch(() => {});
  };

  const elapsed = useMemo(() => {
    void tick;
    const start = session?.startedAt ? new Date(session.startedAt).getTime() : since;
    if (!start) return "";
    const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, [tick, session?.startedAt, since]);

  const grade = linkGrade(quality);
  const soundOn = phase === "live" && sound && canSound;
  const micOn = phase === "live" && mic && canMic && Boolean(micStreamRef.current);
  const machineName = session?.machineName || "Remote computer";

  return (
    <div className="rd-stage" ref={stageRef}>
      <div className="rd-tools" role="toolbar" aria-label="Remote Desktop controls">
        <div className="rd-grp"><span className="rd-livedot" aria-hidden="true" /><b>{machineName}</b><span className="rd-since">{phase === "live" ? `connected ${elapsed}` : phase === "login" ? "waiting for login" : phase === "ended" ? "ended" : "connecting…"}</span></div>
        <span className="rd-sep" />
        <div className="rd-grp">
          {screens.length > 1 ? (
            <button type="button" className="rd-tool" title="Switch monitor" onClick={() => switchScreen((screenIdx + 1) % screens.length)}>
              <MonitorIcon />Monitor {screenIdx + 1} <span className="rd-st">of {screens.length}</span>
            </button>
          ) : (
            <span className="rd-tool" aria-disabled="true"><MonitorIcon />Monitor 1</span>
          )}
          <button type="button" className="rd-tool" aria-pressed={soundOn} disabled={phase !== "live" || !canSound} title={canSound ? "Where the remote computer's sound plays" : "Sound was not allowed for this connection"} onClick={() => { const n = !sound; setSound(n); void pushAudio(n, mic); }}>
            <SoundIcon />Sound <span className={`rd-st${soundOn ? " rd-st--here" : ""}`}>{soundOn ? "→ here" : "→ there"}</span>
          </button>
          <button type="button" className="rd-tool" aria-pressed={micOn} disabled={phase !== "live" || !canMic} title={canMic ? "Where your microphone is used" : "Microphone was not allowed for this connection"} onClick={() => { const n = !mic; setMic(n); void pushAudio(sound, n); }}>
            <MicIcon />My mic <span className={`rd-st${micOn ? " rd-st--here" : ""}`}>{micOn ? "→ there" : "→ here"}</span>
          </button>
          <button type="button" className="rd-tool" aria-pressed={clipOn && canClip} disabled={phase !== "live" || !canClip} title={canClip ? "Send what you copied to the remote computer" : "Clipboard was not allowed for this connection"} onClick={() => void pasteToRemote()}>
            <ClipIcon />Clipboard
          </button>
          <button type="button" className="rd-tool" disabled title="Not in this version">Send a file</button>
          <button type="button" className="rd-tool" disabled title="Windows refuses remote input on administrator prompts">Ctrl+Alt+Del</button>
        </div>
        <span className="rd-sep" />
        <div className="rd-grp">
          <button type="button" className="rd-tool" aria-pressed={fit === "fit"} onClick={() => setFit(fit === "fit" ? "actual" : "fit")}>{fit === "fit" ? "Fit" : "Actual size"}</button>
          <button type="button" className="rd-tool" aria-pressed={fullscreen} onClick={toggleFullscreen}>{fullscreen ? "Exit full screen" : "Full screen"}</button>
        </div>
        <div className="rd-grp rd-grp--end">
          <span className={`rd-q rd-q--${grade}`} title={budget?.note || undefined}><span className="rd-bar" aria-hidden="true"><i /><i /><i /><i /></span><span>{linkLabel(quality, route)}</span></span>
          <button type="button" className="rd-tool rd-tool--danger" onClick={() => void (phase === "ended" ? router.push("/remote-desktop") : disconnect())}>{phase === "ended" ? "Back" : "Disconnect"}</button>
        </div>
      </div>

      <div className={`rd-stage-grid${fullscreen ? " rd-stage-grid--norail" : ""}`}>
        <div className="rd-desk">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            tabIndex={0}
            className={`rd-video${fit === "actual" ? " rd-video--actual" : ""}${controlOn ? " is-controllable" : ""}`}
            onMouseMove={(e) => { const p = pointFor(e); if (!p || !shouldSendMove(p, lastMoveRef.current)) return; lastMoveRef.current = p; send({ kind: "move", ...p }); }}
            onMouseDown={(e) => { const p = pointFor(e); if (p) send({ kind: "down", ...p, button: mouseButtonName(e.button) }); }}
            onMouseUp={(e) => { const p = pointFor(e); if (p) send({ kind: "up", ...p, button: mouseButtonName(e.button) }); }}
            onDoubleClick={(e) => { const p = pointFor(e); if (p) send({ kind: "click", ...p, button: mouseButtonName(e.button), double: true }); }}
            onContextMenu={(e) => { e.preventDefault(); const p = pointFor(e); if (p) send({ kind: "click", ...p, button: "right" }); }}
            onWheel={(e) => { const p = pointFor(e); const deltaY = wheelDeltaToWindows(e.deltaY, e.deltaMode); if (p && deltaY !== 0) send({ kind: "scroll", ...p, deltaY }); }}
            onKeyDown={(e) => { if (!controlOn) return; e.preventDefault(); const command = keyEventToCommand(e as any); if (command) send(command); }}
          />

          {phase === "connecting" && (
            <div className="rd-desk-overlay"><div className="rd-wait"><span className="rd-spinner" aria-hidden="true" /><b>Reaching {machineName}…</b><span>Its Loopcom app is picking up.</span></div></div>
          )}

          {phase === "login" && (
            <div className="rd-desk-overlay">
              <form className="rd-login" onSubmit={(e) => { e.preventDefault(); if (!loginBusy && username.trim() && password) { loginSentRef.current = true; if (!sendLogin(username.trim(), password)) { loginSentRef.current = false; setLoginError("Not connected yet — try again in a moment."); } } }}>
                <h3>Sign in to {machineName}</h3>
                <p>The username and password set on that computer. They are checked there and never sent to Loopcom.</p>
                <label className="rd-field"><span className="rd-label">Username for {machineName}</span><input className="rd-input rd-mono" autoFocus autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
                <label className="rd-field"><span className="rd-label">Password</span><input className="rd-input rd-mono" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
                {loginError && <p className="rd-error">{loginError}</p>}
                <div className="rd-acts">
                  <button type="button" className="rd-btn" onClick={() => void disconnect()}>Cancel</button>
                  <button type="submit" className="rd-btn rd-btn--primary" disabled={loginBusy || !username.trim() || !password}>{loginBusy ? "Checking…" : "Sign in"}</button>
                </div>
              </form>
            </div>
          )}

          {phase === "ended" && (
            <div className="rd-desk-overlay">
              <div className="rd-end">
                <h3>Session ended</h3>
                <p>{endedText || "The session ended."}</p>
                <button type="button" className="rd-btn" onClick={() => router.push("/remote-desktop")}>Back to Remote Desktop</button>
              </div>
            </div>
          )}

          {phase === "live" && remoteLocked && (
            <div className="rd-locked-note">Windows is locked on {machineName}. The picture stays black and typing is refused until someone unlocks it at the computer.</div>
          )}

          {phase === "live" && remoteOnCall && (soundOn || micOn) && (
            <div className="rd-audio-note">
              <span className="rd-ic" aria-hidden="true">♪</span>
              <span>
                <b>{soundOn && micOn ? "This call rings here, and your voice goes there." : soundOn ? "This call rings here." : "Your voice goes there."}</b>
                {soundOn ? `${machineName}’s sound is playing on this computer` : ""}{soundOn && micOn ? " and " : ""}{micOn ? "your microphone is its microphone" : ""}, so you can answer on the remote Loopcom from where you sit.
              </span>
            </div>
          )}
        </div>

        {!fullscreen && (
          <aside className="rd-rail">
            <div className="rd-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "details"} onClick={() => setTab("details")}>Details</button>
              <button type="button" role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>Activity</button>
            </div>
            <div className="rd-rail-body">
              {tab === "details" ? (
                <div className="rd-kv">
                  <span>Computer</span><span>{machineName}</span>
                  <span>Connected from</span><span>{session?.viewerLabel || "here"}</span>
                  <span>Since</span><span>{session?.startedAt ? `${new Date(session.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${elapsed}` : "—"}</span>
                  <span>Route</span><span>{route === "relay" ? "Through Loopcom’s relay" : route === "direct" ? "Direct (no relay)" : "Measuring…"}</span>
                  <span>Picture</span><span>{videoSize ? `${videoSize.w}×${videoSize.h}` : "—"}{budget ? ` · up to ${budget.maxHeight}p` : ""}</span>
                  <span>Sound</span><span>{!canSound ? "Not allowed" : soundOn ? "Playing here" : "Playing there"}</span>
                  <span>Microphone</span><span>{!canMic ? "Not allowed" : micOn ? "Yours, used there" : "Theirs"}</span>
                  <span>Clipboard</span><span>{canClip ? (clipOn ? "Shared" : "Off") : "Not allowed"}</span>
                  <span>Control</span><span>{canControl ? (remoteLocked ? "Paused — Windows is locked" : "Mouse and keyboard") : "Look only"}</span>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {events.length === 0 && <span className="rd-note">Nothing yet.</span>}
                  {events.map((ev) => (
                    <div className="rd-ev" key={ev.id}><time>{new Date(ev.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>{ev.body || ev.code}</div>
                  ))}
                </div>
              )}
              <p className="rd-note" style={{ borderTop: "1px solid #1f2a38", paddingTop: 10 }}>Nothing on this screen is recorded. Activity lists events only, never what was typed or shown.</p>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function MonitorIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>; }
function SoundIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /></svg>; }
function MicIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>; }
function ClipIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></svg>; }
