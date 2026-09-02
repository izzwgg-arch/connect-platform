"use client";

/**
 * The computer being REACHED: everything that happens on the remote machine
 * while its owner (or someone with a Connect ID password) is connected.
 *
 * ⛔ DESIGN RULES, all deliberate:
 *
 *  1. It exists only inside the Loopcom Windows app, only in the FULL window
 *     (the one that runs the SIP engine — the mini and the coworker windows are
 *     proxies and must never run a second host), and only when the owner switched
 *     Remote Desktop on for THIS computer. That last part is the fleet gate: the
 *     preload publishes `connectDesktop.remoteDesktop` only behind the launch flag.
 *
 *  2. Nothing is shared at accept time. An own-computer session is accepted so
 *     the peer connection can be built, and the screen is attached ONLY after the
 *     username and password typed on the other side were verified HERE, by the
 *     main process, against the hash kept in this machine's settings. The server
 *     learns the verdict; it never sees the credentials.
 *
 *  3. A share-password session is authenticated by the password the owner
 *     issued; it shows the screen as soon as the channel is open.
 *
 *  4. The always-on-top banner is drawn by the main process and says who is
 *     connected, from where, and where the sound and microphone are. Stop on it
 *     ends the session, always, without asking anyone.
 *
 *  5. Sound and microphone follow the CONNECTING side's switches. "Sound → here"
 *     means this computer's audio is streamed to them; "mic → there" means their
 *     microphone becomes this phone's microphone (useSipPhone's
 *     setExternalMicrophoneStream), so they can answer a call on this Loopcom
 *     from where they sit.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MACHINE_POLL_MS,
  RemoteDesktopPeer,
  acceptSession,
  desktopBridge,
  endSession,
  pollMachine,
  registerMachine,
  reportInputCount,
  reportLoginResult,
  type DesktopSession,
} from "../services/remoteDesktop";
import { sanitizeIncomingInput } from "../lib/remoteSupportGuards";
import type { ViewerFrame } from "../lib/remoteDesktop";
import { hasBrowserAuthToken } from "../services/apiClient";
import { useOptionalSipPhone } from "../hooks/useSipPhone";

type Identity = {
  enabled: boolean;
  deviceId: string;
  machineKey: string;
  name: string;
  hostname: string;
  osLabel: string;
  appVersion: string;
  monitors: number;
  locked: boolean;
  login: { set: boolean; username: string | null; lockedForMs: number };
};

export default function RemoteDesktopHost() {
  const bridge = desktopBridge();
  /**
   * ⛔ THE PRODUCTION GATE. Mounted globally; without this every signed-in user
   * would register a machine and poll every five seconds the day the portal
   * deploys. The key exists only in the Windows app, only behind the tray switch.
   * And only the FULL window: the mini is a proxy with no phone engine.
   */
  const supported = Boolean(bridge?.remoteDesktop?.listScreens) && bridge?.windowKind === "full";

  const phone = useOptionalSipPhone();
  const onCall = phone?.callState === "connected" || phone?.callState === "ringing" || phone?.callState === "dialing";
  const onCallRef = useRef(onCall);
  onCallRef.current = onCall;
  const phoneRef = useRef(phone);
  phoneRef.current = phone;

  const [live, setLive] = useState<DesktopSession | null>(null);
  const identityRef = useRef<Identity | null>(null);
  const peerRef = useRef<RemoteDesktopPeer | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micWantedRef = useRef(false);
  const controlActiveRef = useRef(false);
  const authenticatedRef = useRef(false);
  const grantedRef = useRef<string[]>([]);
  const inputCountRef = useRef(0);
  const lockedRef = useRef(false);
  const startingRef = useRef<string | null>(null);
  const liveRef = useRef<DesktopSession | null>(null);
  liveRef.current = live;

  /** Everything torn down together — local first, server second. */
  const teardown = useCallback(async (sessionId?: string) => {
    try { peerRef.current?.stop(); } catch { /* gone */ }
    peerRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) { try { track.stop(); } catch { /* stopped */ } }
    streamRef.current = null;
    micStreamRef.current = null;
    micWantedRef.current = false;
    try { phoneRef.current?.setExternalMicrophoneStream(null); } catch { /* no phone */ }
    controlActiveRef.current = false;
    authenticatedRef.current = false;
    grantedRef.current = [];
    try { await bridge?.remoteDesktop?.disableControl?.(); } catch { /* not desktop */ }
    try { await bridge?.remoteDesktop?.allowAudio?.(sessionId || "", false); } catch { /* not desktop */ }
    try { await bridge?.remoteDesktop?.setBanner?.({ visible: false }); } catch { /* not desktop */ }
    if (sessionId && identityRef.current) {
      if (inputCountRef.current > 0) { await reportInputCount(sessionId, inputCountRef.current).catch(() => {}); inputCountRef.current = 0; }
      await endSession(sessionId, identityRef.current.machineKey).catch(() => {});
    }
    startingRef.current = null;
    setLive(null);
  }, [bridge]);

  const audioNote = useCallback((sound: boolean, mic: boolean, fromLabel: string) => {
    const bits: string[] = [];
    bits.push(sound ? `sound → ${fromLabel}` : "sound → here");
    bits.push(mic ? "mic → here" : "mic → theirs");
    return bits.join(" · ");
  }, []);

  const updateBanner = useCallback((session: DesktopSession, sound: boolean, mic: boolean, ask: { capability: string; text: string } | null = null) => {
    void bridge?.remoteDesktop?.setBanner?.({
      visible: true,
      mode: "desktop",
      supportName: session.requestedByName || "Someone",
      fromLabel: session.viewerLabel || undefined,
      controlGranted: controlActiveRef.current,
      audioNote: audioNote(sound, mic, session.viewerLabel || "their computer"),
      ask,
    });
  }, [bridge, audioNote]);

  /** Capture the chosen screen (and, when granted, the computer's sound) and send it. */
  const shareScreen = useCallback(async (session: DesktopSession, sourceId?: string) => {
    const peer = peerRef.current;
    if (!peer) return;
    const wantSound = grantedRef.current.includes("sound");
    try {
      if (sourceId && bridge?.remoteDesktop?.setScreen) await bridge.remoteDesktop.setScreen(sourceId);
      else if (bridge?.remoteDesktop?.listScreens) {
        const list = await bridge.remoteDesktop.listScreens().catch(() => []);
        const first = list.find((s: any) => s.isScreen) ?? list[0];
        if (first && bridge.remoteDesktop.setScreen) await bridge.remoteDesktop.setScreen(first.id);
      }
      await bridge?.remoteDesktop?.allowAudio?.(session.id, wantSound);
      // Electron's display-media handler picks the source we just named and adds
      // the loopback device only when allowAudio said so.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: wantSound });
      for (const track of streamRef.current?.getTracks() ?? []) { try { track.stop(); } catch { /* stopped */ } }
      streamRef.current = stream;
      for (const track of stream.getVideoTracks()) track.addEventListener("ended", () => { void teardown(session.id); });
      await peer.attachScreen(stream);
      peer.sendFrame({ t: "ready" });
      if (bridge?.remoteDesktop?.listScreens) {
        const list = await bridge.remoteDesktop.listScreens().catch(() => []);
        peer.sendFrame({ t: "screens", screens: list.filter((s: any) => s.isScreen).map((s: any) => ({ id: s.id, name: s.name })) });
      }
    } catch {
      // A refused picker or a capture failure: the connecting side is told by the
      // session ending rather than by a black frame that looks like a bug.
      await teardown(session.id);
    }
  }, [bridge, teardown]);

  /** After the login (or immediately for a share session): control, screen, banner. */
  const openUp = useCallback(async (session: DesktopSession) => {
    authenticatedRef.current = true;
    if (grantedRef.current.includes("control") && bridge?.remoteDesktop?.enableControl) {
      controlActiveRef.current = await bridge.remoteDesktop.enableControl(session.id).catch(() => false);
    }
    await shareScreen(session);
    updateBanner(session, grantedRef.current.includes("sound"), false);
  }, [bridge, shareScreen, updateBanner]);

  const applyMic = useCallback((wanted: boolean) => {
    micWantedRef.current = wanted;
    const stream = micStreamRef.current;
    try {
      phoneRef.current?.setExternalMicrophoneStream(wanted && stream && grantedRef.current.includes("mic") ? stream : null);
    } catch { /* no phone in this window */ }
  }, []);

  const startHost = useCallback(async (session: DesktopSession) => {
    const identity = identityRef.current;
    if (!identity || peerRef.current || startingRef.current === session.id) return;
    startingRef.current = session.id;
    try {
      const accepted = session.status === "REQUESTED" ? (await acceptSession(session.id, identity.machineKey)).session : session;
      grantedRef.current = accepted.capabilitiesGranted ?? [];
      authenticatedRef.current = accepted.clientAuthenticated;
      inputCountRef.current = 0;
      setLive(accepted);

      const peer = new RemoteDesktopPeer(accepted.id, "host", {
        onInput: (raw) => {
          if (!controlActiveRef.current || !authenticatedRef.current) return;
          const command = sanitizeIncomingInput(raw);
          if (!command) return;
          inputCountRef.current += 1;
          bridge?.remoteDesktop?.sendInput?.({ sessionId: accepted.id, command });
        },
        onMicStream: (stream) => {
          micStreamRef.current = stream;
          if (micWantedRef.current) applyMic(true);
        },
        onViewerFrame: (frame: ViewerFrame) => { void handleViewerFrame(accepted, frame); },
        onClosed: () => { void teardown(accepted.id); },
        onStateChange: (state) => {
          // A share session needs no login: the moment the channel is up, share.
          if (state === "connected" && accepted.clientAuthenticated && !streamRef.current) {
            const tick = setInterval(() => {
              if (peerRef.current?.controlChannelOpen) { clearInterval(tick); void openUp(accepted); }
            }, 100);
            setTimeout(() => clearInterval(tick), 15_000);
          }
        },
        onHeartbeat: ({ locked }) => { if (typeof locked === "boolean") lockedRef.current = locked; },
      }, identity.machineKey);
      peer.onCall = () => onCallRef.current;
      peer.isLocked = () => lockedRef.current;
      peerRef.current = peer;
      await peer.start();
      updateBanner(accepted, false, false);
    } catch {
      await teardown(session.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, teardown, openUp, applyMic, updateBanner]);

  const handleViewerFrame = useCallback(async (session: DesktopSession, frame: ViewerFrame) => {
    const peer = peerRef.current;
    const identity = identityRef.current;
    if (!peer || !identity) return;
    switch (frame.t) {
      case "login": {
        if (authenticatedRef.current) { peer.sendFrame({ t: "login_result", ok: true }); return; }
        // ⛔ Checked in the main process against this machine's own hash. The
        // renderer forwards the typed pair and gets a verdict; the server gets
        // the verdict only.
        const verdict = await bridge?.remoteDesktop?.verifyLogin?.(frame.username, frame.password).catch(() => null);
        if (!verdict) { peer.sendFrame({ t: "login_result", ok: false, attemptsLeft: 0 }); return; }
        if (verdict.ok) {
          await reportLoginResult(session.id, identity.machineKey, { ok: true }).catch(() => {});
          peer.sendFrame({ t: "login_result", ok: true });
          await openUp(session);
          return;
        }
        const locked = verdict.reason === "locked" || verdict.lockedForMs > 0;
        await reportLoginResult(session.id, identity.machineKey, { ok: false, attemptsLeft: verdict.attemptsLeft, locked }).catch(() => {});
        peer.sendFrame({ t: "login_result", ok: false, attemptsLeft: verdict.attemptsLeft, lockedForMs: verdict.lockedForMs });
        if (locked) await teardown(session.id);
        return;
      }
      case "audio": {
        if (!authenticatedRef.current) return;
        const sound = frame.sound && grantedRef.current.includes("sound");
        const mic = frame.mic && grantedRef.current.includes("mic");
        await peer.setSoundEnabled(sound);
        applyMic(mic);
        updateBanner(session, sound, mic);
        return;
      }
      case "monitor": {
        if (!authenticatedRef.current) return;
        await shareScreen(session, frame.sourceId);
        return;
      }
      case "clip": {
        if (!authenticatedRef.current || !grantedRef.current.includes("clipboard")) return;
        try { await navigator.clipboard.writeText(frame.text); } catch { /* clipboard refused */ }
        return;
      }
    }
  }, [bridge, openUp, applyMic, updateBanner, shareScreen, teardown]);

  // Identity, registration and the presence poll. The only network this machine
  // makes while nothing is happening, and only while the switch is on.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    let registered = false;

    const tick = async () => {
      if (cancelled || !hasBrowserAuthToken()) return;
      try {
        const identity: Identity = await bridge.remoteDesktopSetup.identity();
        identityRef.current = identity;
        if (!identity.enabled || !identity.deviceId || !identity.machineKey) return;
        lockedRef.current = identity.locked;
        if (!registered) {
          const reg = await registerMachine(identity.machineKey, {
            deviceId: identity.deviceId, name: identity.name, osLabel: identity.osLabel, monitors: identity.monitors,
            appVersion: identity.appVersion, unattendedEnabled: identity.enabled, hasAccessLogin: identity.login.set, locked: identity.locked,
          });
          registered = true;
          void bridge.remoteDesktopSetup.reportConnectId?.(reg.machine.connectId);
        }
        const res = await pollMachine(identity.machineKey, {
          deviceId: identity.deviceId, unattendedEnabled: identity.enabled, hasAccessLogin: identity.login.set,
          locked: identity.locked, monitors: identity.monitors,
        });
        if (cancelled) return;
        void bridge.remoteDesktopSetup.reportConnectId?.(res.connectId);
        if (!liveRef.current && !peerRef.current) {
          const waiting = res.sessions.find((s) => s.status === "REQUESTED");
          if (waiting) void startHost(waiting);
        } else if (liveRef.current && !res.sessions.some((s) => s.id === liveRef.current!.id)) {
          // The server no longer lists our session: it ended elsewhere (kill switch, owner, viewer).
          void teardown();
        }
      } catch (err: any) {
        const status = err?.status ?? err?.statusCode;
        // Removed from Remote Desktop, or this install is not the registered one.
        if (status === 410 || status === 403) registered = false;
      }
    };
    void tick();
    const timer = setInterval(tick, MACHINE_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  // The banner's Stop, the tray's Off, and the lock state.
  useEffect(() => {
    if (!supported) return;
    const offStop = bridge.remoteDesktop.onStopRequested?.(() => { void teardown(liveRef.current?.id); });
    const offLock = bridge.remoteDesktopSetup.onLockChanged?.((locked: boolean) => {
      lockedRef.current = locked;
      peerRef.current?.sendFrame({ t: "locked", locked });
    });
    return () => { try { offStop?.(); } catch { /* noop */ } try { offLock?.(); } catch { /* noop */ } };
  }, [supported, bridge, teardown]);

  // Tell the connecting side when a call starts or ends on this Loopcom.
  useEffect(() => {
    if (!supported) return;
    peerRef.current?.sendFrame({ t: "phone", onCall });
  }, [supported, onCall]);

  useEffect(() => () => { void teardown(); }, [teardown]);

  // ⛔ Not the Windows app with the switch on — render nothing, ever. The banner
  // is the visible surface; there is deliberately no in-app dialog to dismiss.
  return null;
}
