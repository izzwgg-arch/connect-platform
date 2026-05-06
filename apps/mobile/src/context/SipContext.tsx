import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { createSipClient } from "../sip";
import { postCallQualityReport, postCallQualityPing, clearCallQualityPing } from "../api/client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { appendCallRecord } from "../storage/callHistory";
import type { CallDirection, CallState, CallRecord, ProvisioningBundle, SipRegistrationState } from "../types";
import type { SipAnswerTraceEvent, SipSessionInfo } from "../sip/types";
import { useAuth } from "./AuthContext";
import { logCallFlow, setCallFlowLastError } from "../debug/callFlowDebug";
import { rememberVmGreetingWake } from "../voicemail/vmGreetingWakeBridge";
import { audioRouteManager, getAudioDevicesSnapshot } from "../audio/audioRouteManager";

const PROVISION_KEY = "cc_mobile_provision";
const LAST_DIALED_KEY = "cc_mobile_last_dialed";

type AudioRoute = "earpiece" | "speaker" | "bluetooth";

type SipState = {
  registrationState: SipRegistrationState;
  callState: CallState;
  callDirection: CallDirection;
  remoteParty: string | null;
  muted: boolean;
  speakerOn: boolean;
  onHold: boolean;
  hasProvisioning: boolean;
  lastError: string | null;
  /** Last number the user dialed outbound — persisted across restarts */
  lastDialed: string | null;
  /** Current audio output route during a call */
  audioRoute: AudioRoute;
  saveProvisioning: (bundle: ProvisioningBundle) => Promise<void>;
  register: (options?: { forceRestart?: boolean }) => Promise<void>;
  unregister: () => Promise<void>;
  dial: (target: string, options?: { displayTarget?: string }) => Promise<void>;
  answer: () => Promise<void>;
  answerIncomingInvite: (
    match: { inviteId?: string | null; fromNumber?: string | null; toExtension?: string | null; pbxCallId?: string | null; sipCallTarget?: string | null },
    timeoutMs?: number,
    onTrace?: (event: SipAnswerTraceEvent) => void,
  ) => Promise<boolean>;
  rejectIncomingInvite: (match?: {
    inviteId?: string | null;
    fromNumber?: string | null;
    toExtension?: string | null;
    pbxCallId?: string | null;
    sipCallTarget?: string | null;
  }) => Promise<boolean>;
  hangup: () => Promise<void>;
  toggleMute: () => void;
  toggleSpeaker: () => void;
  /** Cycle audio route: earpiece → speaker → bluetooth (if available) → earpiece */
  cycleAudioRoute: () => void;
  toggleHold: () => void;
  sendDtmf: (digit: string) => void;

  // ---- Multi-call primitives (exposed for CallSessionManager) ----
  /**
   * Subscribe to raw per-session SIP events. Returns an unsubscribe fn.
   * Only one active listener is supported (the CallSessionManager);
   * calling this a second time replaces the previous listener.
   */
  registerMultiCallListener: (listener: {
    onSessionAdded?: (info: SipSessionInfo) => void;
    onSessionStateChanged?: (info: SipSessionInfo) => void;
    onSessionRemoved?: (sessionId: string) => void;
  }) => () => void;
  /** Enumerate every tracked SIP session (ringing, active, held, dialing). */
  listSipSessions: () => SipSessionInfo[];
  /** Put a specific SIP session on hold via re-INVITE sendonly. */
  holdSipSession: (sessionId: string) => boolean;
  /** Resume a specific held SIP session via re-INVITE sendrecv. */
  unholdSipSession: (sessionId: string) => boolean;
  /** Hangup a specific SIP session without disturbing siblings. */
  hangupSipSession: (sessionId: string) => boolean;
  /** True iff this SIP session is still tracked and not in a terminated state. */
  isSipSessionAlive: (sessionId: string) => boolean;
  /** Blind-transfer a SIP session to the given target number via REFER. */
  transferSipSession: (sessionId: string, target: string) => boolean;
  /** Answer a specific incoming SIP session by its id. */
  answerSipSession: (
    sessionId: string,
    timeoutMs?: number,
    onTrace?: (event: SipAnswerTraceEvent) => void,
  ) => Promise<boolean>;
  /** Repoint legacy single-session methods (hold/hangup/setMute) at a session. */
  setActiveSipSession: (sessionId: string) => boolean;
};

const SipContext = createContext<SipState | undefined>(undefined);

export function SipProvider({ children }: { children: React.ReactNode }) {
  const { token: authToken } = useAuth();
  const clientRef = useRef(createSipClient());
  const [registrationState, setRegistrationState] = useState<SipRegistrationState>("idle");
  const [callState, setCallState] = useState<CallState>("idle");
  const [callDirection, setCallDirection] = useState<CallDirection>(null);
  const [remoteParty, setRemoteParty] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [onHold, setOnHold] = useState(false);
  const [hasProvisioning, setHasProvisioning] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastDialed, setLastDialed] = useState<string | null>(null);
  const [audioRoute, setAudioRoute] = useState<AudioRoute>("earpiece");
  /**
   * Is a Bluetooth headset currently connected and available to us for call
   * audio? Fed by `react-native-incall-manager`'s `onAudioDeviceChanged`
   * event plus a 2 s `currentAudioDevice()` / `currentRoute()` poll while
   * a call is live. When true, the speaker button cycles
   * Speaker ↔ Bluetooth; when false, Speaker ↔ Earpiece.
   */
  const [bluetoothAvailable, setBluetoothAvailable] = useState<boolean>(false);

  // Refs for call record tracking — updated synchronously, read when call ends
  const callInfoRef = useRef({
    direction: "outbound" as "inbound" | "outbound",
    answered: false,
    startMs: null as number | null,
    remoteParty: null as string | null,
  });

  // Ref tracking registration state for use inside AppState event callbacks
  // (closures capture stale state otherwise).
  const registrationStateRef = useRef<SipRegistrationState>("idle");

  // Multi-call event bridge. CallSessionManager registers a listener at
  // mount; SipContext forwards onSessionAdded/Changed/Removed into it.
  const multiCallListenerRef = useRef<{
    onSessionAdded?: (info: SipSessionInfo) => void;
    onSessionStateChanged?: (info: SipSessionInfo) => void;
    onSessionRemoved?: (sessionId: string) => void;
  } | null>(null);

  const ensureProvisioningLoaded = useCallback(async () => {
    const raw = await SecureStore.getItemAsync(PROVISION_KEY).catch(() => null);
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw) as ProvisioningBundle;
      clientRef.current.configure(parsed);
      setHasProvisioning(true);
      return true;
    } catch (e) {
      console.warn("[SIP] Failed to load provisioning:", e);
      return false;
    }
  }, []);

  // Auto-reset callState from 'ended' back to 'idle' after a short pause so
  // the UI can show a graceful ended state without feeling like a restart.
  useEffect(() => {
    if (callState === "ended") {
      setCallDirection(null);
      setOnHold(false);
      setMuted(false);
      setSpeakerOn(false);
      setAudioRoute("earpiece");
      // Per-call user override is cleared inside the route manager when
      // the SIP client fires its end handler — this just keeps the React
      // state in sync.

      // Save call record locally — this is the reliable path for call history
      const info = callInfoRef.current;
      if (info.startMs) {
        const durationSec = info.answered
          ? Math.max(0, Math.round((Date.now() - info.startMs) / 1000))
          : 0;
        const disposition = info.answered
          ? "answered"
          : info.direction === "inbound"
          ? "missed"
          : "canceled";
        const record: CallRecord = {
          id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          direction: info.direction === "inbound" ? "inbound" : "outbound",
          fromNumber: info.direction === "inbound" ? (info.remoteParty ?? "") : "",
          toNumber: info.direction === "outbound" ? (info.remoteParty ?? "") : "",
          startedAt: new Date(info.startMs).toISOString(),
          durationSec,
          disposition,
        };
        appendCallRecord(record).catch(() => {});
        // Reset so next call gets a fresh record
        callInfoRef.current = {
          direction: "outbound",
          answered: false,
          startMs: null,
          remoteParty: null,
        };
      }

      const t = setTimeout(() => setCallState("idle"), 1200);
      return () => clearTimeout(t);
    }
  }, [callState]);

  // Wire the quality report callback — fires at end of each call
  // Wire the live ping callback — fires every ~10 s during a call
  useEffect(() => {
    const client = clientRef.current as any;
    if ("onCallQualityReport" in client || typeof client.onCallQualityReport !== "undefined") {
      client.onCallQualityReport = (report: Record<string, unknown>) => {
        if (!authToken) return;
        postCallQualityReport(authToken, report).catch(() => {
          // Non-fatal — telemetry loss acceptable
        });
      };
    }
    if ("onCallQualityPing" in client || typeof client.onCallQualityPing !== "undefined") {
      client.onCallQualityPing = (snapshot: Record<string, unknown>) => {
        if (!authToken) return;
        if (snapshot._clear) {
          clearCallQualityPing(authToken).catch(() => {});
        } else {
          postCallQualityPing(authToken, snapshot).catch(() => {});
        }
      };
    }
  }, [authToken]);

  // Keep registrationStateRef in sync so the AppState callback below
  // can check the current state without a stale closure.
  useEffect(() => {
    registrationStateRef.current = registrationState;
  }, [registrationState]);

  // ── Bluetooth-headset availability watcher ─────────────────────────────
  // Active only during a live call. Uses the native AudioManager on
  // Android via our IncomingCallUi bridge (`getAudioDevices`) — the JS
  // `react-native-incall-manager` library does NOT expose a reliable
  // audio-device enumerator on v4.x, so the previous
  // `getAudioDeviceList()` / `onAudioDeviceChanged` probe never fired
  // and BT was perpetually reported as absent. AudioManager directly
  // enumerates every output (BT A2DP / SCO, wired, hearing aid,
  // speaker…) which is the authoritative source the telephony service
  // itself uses.
  //
  // Surfaced state:
  //   • `bluetoothAvailable` — drives the Speaker button cycling policy:
  //       BT connected   → Speaker ⇄ Bluetooth (never earpiece)
  //       BT disconnected → Speaker ⇄ Earpiece
  //   • `audioRoute` mirrors the current sink so the button label /
  //     icon stays accurate when the OS reroutes on plug/unplug.
  useEffect(() => {
    const isCallLive =
      callState === "connected" ||
      callState === "ringing" ||
      callState === "dialing";
    if (!isCallLive) {
      if (bluetoothAvailable) setBluetoothAvailable(false);
      return;
    }

    if (Platform.OS !== "android") {
      // iOS relies on CallKit + the route picker for BT selection; skip
      // the custom watcher there.
      return;
    }

    let cancelled = false;
    const mod: any = (NativeModules as any)?.IncomingCallUi;
    if (!mod || typeof mod.getAudioDevices !== "function") {
      console.warn("[SIP] IncomingCallUi.getAudioDevices missing — BT routing unavailable");
      return;
    }

    const probe = () => {
      if (cancelled) return;
      try {
        const result = mod.getAudioDevices();
        const bt = !!result?.bluetoothConnected;
        const wired = !!result?.wiredHeadsetConnected;
        const speakerOnNow = !!result?.speakerphoneOn;
        setBluetoothAvailable((prev) => (prev !== bt ? bt : prev));
        // Feed the durable audio route manager. It re-evaluates the chosen
        // sink on every change and re-applies it (e.g. BT plug-back during
        // a call returns to BT unless the user explicitly chose speaker).
        const changed = audioRouteManager.refreshDevices({
          bluetoothConnected: bt,
          wiredHeadsetConnected: wired,
          speakerphoneOn: speakerOnNow,
        });
        if (changed) {
          // Mirror the manager's chosen route into the React state so the
          // speaker button label/icon stays accurate.
          const next = audioRouteManager.getCurrentRoute();
          setAudioRoute((prev) => (
            prev === next ? prev :
            next === "wired" ? "earpiece" : // UI only knows earpiece/speaker/bluetooth
            next
          ));
        }
      } catch (e) {
        // Swallow — watcher is best-effort; SIP call is not affected.
      }
    };

    probe();
    const interval = setInterval(probe, 1500);

    // React to external route changes (e.g. WiredHeadset unplug fires the
    // standard DeviceEventEmitter event) — kick a fresh probe instead of
    // waiting up to 1.5s.
    const sub = DeviceEventEmitter.addListener("WiredHeadset", probe);

    return () => {
      cancelled = true;
      sub.remove();
      clearInterval(interval);
    };
  }, [callState, bluetoothAvailable]);

  // ══════════════════════════════════════════════════════════════════════════
  // STAGE 1 — KEEP-ALIVE / AUTO-RECONNECT ORCHESTRATOR
  //
  // Goal: while the JS process is alive, keep a SIP REGISTER + WebSocket
  // open so every incoming INVITE is delivered over an already-open socket.
  // This is the foreground half of the VitalPBX-parity fix; Stage 2
  // (native persistent SIP service) covers the killed/backgrounded case.
  //
  // Owned here because SipContext already has:
  //   • auth token (know when to stop)
  //   • AppState listener (detect foreground)
  //   • registration state signal (single source of truth)
  //
  // The orchestrator has ONE job: whenever the UA should be registered but
  // is not, heal it. Everything else (who disconnected us, why) is pushed
  // up as an event and funneled into scheduleReconnect().
  //
  // Strategy:
  //   • Backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap). Reset on successful registration.
  //   • Single-flight: at most one pending reconnect timer and one in-flight
  //     register() promise; subsequent disconnect signals are coalesced.
  //   • Active-call safety: `hasActiveSession()` guard — reconnect never
  //     forceRestarts during a live call. The existing register() guard
  //     in JsSipClient is a second line of defence.
  //   • Health check: every 30 s verify isConnected() && isRegistered().
  //     If the UA silently went stale (socket idle-killed by a NAT /
  //     carrier without firing `disconnected`), this catches it.
  //   • NetInfo: on connectivity regain, fire an immediate reconnect
  //     attempt (cancels any pending backoff).
  // ══════════════════════════════════════════════════════════════════════════
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectInFlightRef = useRef(false);
  const keepAliveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const keepAliveFailureStreakRef = useRef(0);
  const hasProvisioningRef = useRef(false);
  useEffect(() => { hasProvisioningRef.current = hasProvisioning; }, [hasProvisioning]);

  const cancelPendingReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const runReconnect = useCallback(async (reason: string) => {
    if (reconnectInFlightRef.current) {
      console.log('[SIP_RECONNECT] skip_inflight reason=' + reason);
      return;
    }
    if (!hasProvisioningRef.current) {
      console.log('[SIP_RECONNECT] skip_no_provisioning reason=' + reason);
      return;
    }
    const client = clientRef.current as any;
    if (typeof client.hasActiveSession === "function" && client.hasActiveSession()) {
      // Never tear down during a live call — the JsSIP UA guard catches
      // this too, but we want to avoid even queueing the promise.
      console.log('[SIP_RECONNECT] skip_active_session reason=' + reason);
      return;
    }
    reconnectInFlightRef.current = true;
    const attempt = reconnectAttemptRef.current + 1;
    reconnectAttemptRef.current = attempt;
    setRegistrationState("retrying");
    console.log('[SIP_RECONNECT] start', JSON.stringify({ reason, attempt }));
    const t0 = Date.now();
    try {
      await clientRef.current.register({ forceRestart: true });
      console.log(
        '[SIP_RECONNECT] success',
        JSON.stringify({ reason, attempt, tookMs: Date.now() - t0 }),
      );
      reconnectAttemptRef.current = 0;
      keepAliveFailureStreakRef.current = 0;
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        '[SIP_RECONNECT] failure',
        JSON.stringify({ reason, attempt, tookMs: Date.now() - t0, error: msg }),
      );
      // Schedule the next retry with exponential backoff + jitter.
      const base = Math.min(30_000, 1_000 * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 500);
      const delay = base + jitter;
      console.log(
        '[SIP_RECONNECT] schedule_next',
        JSON.stringify({ reason, attempt, nextInMs: delay }),
      );
      cancelPendingReconnect();
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        void runReconnect(reason + ":backoff");
      }, delay);
    } finally {
      reconnectInFlightRef.current = false;
    }
  }, [cancelPendingReconnect]);

  const scheduleReconnect = useCallback((reason: string) => {
    // Debounce: if a timer is already pending OR an attempt is in flight,
    // we've already queued the heal — just log and bail.
    if (reconnectInFlightRef.current) {
      console.log('[SIP_RECONNECT] coalesced_inflight reason=' + reason);
      return;
    }
    if (reconnectTimerRef.current) {
      console.log('[SIP_RECONNECT] coalesced_pending reason=' + reason);
      return;
    }
    // First attempt fires ~250 ms later — enough debounce to collapse
    // a flurry of disconnect events but small enough to feel instant
    // on a spurious socket blip.
    const delay = 250;
    console.log('[SIP_RECONNECT] schedule', JSON.stringify({ reason, firstAttemptInMs: delay }));
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      void runReconnect(reason);
    }, delay);
  }, [runReconnect]);

  const triggerImmediateReconnect = useCallback((reason: string) => {
    // Used by NetInfo regain — skip the debounce and run now.
    cancelPendingReconnect();
    if (reconnectInFlightRef.current) {
      console.log('[SIP_RECONNECT] immediate_skip_inflight reason=' + reason);
      return;
    }
    console.log('[SIP_RECONNECT] immediate_start reason=' + reason);
    void runReconnect(reason);
  }, [cancelPendingReconnect, runReconnect]);

  useEffect(() => {
    clientRef.current.setEvents({
      onRegistrationState: setRegistrationState,
      onSocketDisconnected: (reason) => {
        console.log('[SIP_SOCKET] onSocketDisconnected reason=' + reason);
        scheduleReconnect('socket_disconnected:' + reason);
      },
      onSocketConnected: () => {
        console.log('[SIP_SOCKET] onSocketConnected');
      },
      onCallState: (state) => {
        if (state === "connected") {
          callInfoRef.current.answered = true;
        }
        setCallState(state);
      },
      onIncomingCall: (callerNumber: string) => {
        const party = callerNumber || "Unknown";
        setCallDirection("inbound");
        setRemoteParty(party);
        callInfoRef.current = {
          direction: "inbound",
          answered: false,
          startMs: Date.now(),
          remoteParty: party,
        };
        setCallState("ringing");
      },
      onError: (msg) => {
        setLastError(msg);
        setCallFlowLastError(msg);
      },

      // ---- Multi-call event bridge ----
      // These forward per-session SIP events into the CallSessionManager so
      // the multi-call state store can track ringing/held siblings without
      // interfering with the legacy single-call path above.
      onSessionAdded: (info) => {
        try {
          multiCallListenerRef.current?.onSessionAdded?.(info);
        } catch (err) {
          console.warn("[MULTICALL] listener.onSessionAdded threw:", err);
        }
      },
      onSessionStateChanged: (info) => {
        try {
          multiCallListenerRef.current?.onSessionStateChanged?.(info);
        } catch (err) {
          console.warn("[MULTICALL] listener.onSessionStateChanged threw:", err);
        }
      },
      onSessionRemoved: (id) => {
        try {
          multiCallListenerRef.current?.onSessionRemoved?.(id);
        } catch (err) {
          console.warn("[MULTICALL] listener.onSessionRemoved threw:", err);
        }
      },
    });

    (async () => {
      // PERF: provisioning load + register gate the inbound-answer latency
      // on every cold start. Start them BEFORE the non-critical
      // last-dialed restore, and run that restore in parallel so it
      // cannot delay SIP boot.
      void SecureStore.getItemAsync(LAST_DIALED_KEY)
        .then((v) => { if (v) setLastDialed(v); })
        .catch(() => undefined);

      const loaded = await ensureProvisioningLoaded();
      if (!loaded) return;
      // Auto-register on boot — the deep-link answer path awaits the
      // same in-flight promise so there is no duplicate work.
      await clientRef.current.register().catch((e) => {
        console.warn("[SIP] Auto-register failed:", e?.message);
      });
    })();

    const sub = AppState.addEventListener("change", async (nextState) => {
      console.log('[SipContext] AppState changed to', nextState, '| sipReg=', registrationStateRef.current);
      if (nextState === "active") {
        const loaded = await ensureProvisioningLoaded();
        if (!loaded) return;
        // Only force-restart if SIP is actually broken (not registered or not registering).
        // If SIP is already registered the UA is healthy — force-restarting would tear down
        // the active UA and reject any incoming SIP INVITE that is being answered.
        // This is the main cause of lock-screen answer failures (app coming to foreground
        // via bringAppToForeground triggers this handler while a SIP INVITE is in flight).
        const regState = registrationStateRef.current;
        const needsForceRestart = regState !== "registered" && regState !== "registering";
        console.log('[SipContext] AppState active: regState=' + regState + ' needsForceRestart=' + needsForceRestart);
        await clientRef.current.register({ forceRestart: needsForceRestart }).catch(() => undefined);
      }
    });

    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Stage 1 keep-alive watchdog ─────────────────────────────────────────
  // Every 30 s, verify the UA is both socket-connected AND SIP-registered.
  // If either check fails while provisioning exists and there is no live
  // call, trigger a reconnect. This catches silent staleness that
  // JsSIP's `disconnected` event might miss (idle NAT kill, carrier
  // transparent reset, etc.) without waiting for the next incoming call
  // to discover it.
  useEffect(() => {
    if (!hasProvisioning) return;
    // Any throw inside an effect body crashes the whole provider tree and
    // unmounts into the ErrorBoundary. Wrap everything so the keep-alive
    // watchdog can never take down the app even if JsSIP internals mutate
    // between builds.
    let interval: ReturnType<typeof setInterval> | null = null;
    let primer: ReturnType<typeof setTimeout> | null = null;
    try {
      const KEEPALIVE_INTERVAL_MS = 30_000;
      const MAX_FAILURE_STREAK = 2;
      const tick = () => {
        const client = clientRef.current as any;
        try {
          const connected = typeof client.isConnected === "function" ? !!client.isConnected() : null;
          const registered = typeof client.isRegistered === "function" ? !!client.isRegistered() : null;
          const hasCall = typeof client.hasActiveSession === "function" ? !!client.hasActiveSession() : false;
          const healthy = connected === true && registered === true;
          if (healthy) {
            keepAliveFailureStreakRef.current = 0;
            console.log('[SIP_KEEPALIVE] healthy', JSON.stringify({ connected, registered, hasCall }));
            return;
          }
          keepAliveFailureStreakRef.current += 1;
          console.warn(
            '[SIP_KEEPALIVE] stale',
            JSON.stringify({
              connected,
              registered,
              hasCall,
              streak: keepAliveFailureStreakRef.current,
            }),
          );
          if (hasCall) {
            // Don't attempt reconnect mid-call — the call itself is the
            // authoritative signal that the socket is alive enough.
            return;
          }
          if (keepAliveFailureStreakRef.current >= MAX_FAILURE_STREAK) {
            scheduleReconnect('keepalive_stale');
          }
        } catch (e) {
          console.warn('[SIP_KEEPALIVE] tick_threw:', e);
        }
      };
      interval = setInterval(tick, KEEPALIVE_INTERVAL_MS);
      keepAliveTimerRef.current = interval;
      // Also fire once shortly after mount — catches a stale UA that
      // was brought into the process via a killed-state push.
      primer = setTimeout(tick, 5_000);
    } catch (e) {
      console.warn('[SIP_KEEPALIVE] mount_threw:', e);
    }
    return () => {
      try {
        if (interval) clearInterval(interval);
        if (primer) clearTimeout(primer);
        if (interval && keepAliveTimerRef.current === interval) keepAliveTimerRef.current = null;
      } catch { /* ignore */ }
    };
  }, [hasProvisioning, scheduleReconnect]);

  // ── Stage 1 NetInfo connectivity-regain trigger ─────────────────────────
  // When the device regains network connectivity (wifi flip, cellular
  // handover, airplane-mode off, tunnel exit), immediately attempt a
  // reconnect. This is the single biggest real-world trigger for
  // "I walked out of the elevator and missed a call" — today's
  // stack waits for the next REGISTER refresh cycle (~60 s), Stage 1
  // heals on the next tick.
  useEffect(() => {
    if (!hasProvisioning) return;
    // NetInfo is an optional dependency. Resolve it defensively — some
    // Metro/Hermes release bundles resolve `.default` to undefined even
    // when the module is installed. Fall back to the module namespace
    // itself, and require `addEventListener` to be a function before
    // wiring it up so a broken/rebundled build can never crash the
    // SipProvider mount.
    let sub: any = null;
    try {
      let NI: any = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod: any = require("@react-native-community/netinfo");
        NI = (mod && mod.default) ? mod.default : mod;
      } catch {
        console.warn('[SIP_RECONNECT] netinfo_require_failed — connectivity-regain trigger disabled');
        return;
      }
      if (!NI || typeof NI.addEventListener !== "function") {
        console.warn(
          '[SIP_RECONNECT] netinfo_addEventListener_missing — connectivity-regain trigger disabled',
          JSON.stringify({ hasNI: !!NI, typeofAEL: NI ? typeof NI.addEventListener : 'n/a' }),
        );
        return;
      }
      let lastReachable: boolean | null = null;
      sub = NI.addEventListener((state: any) => {
        try {
          const reachable =
            state?.isInternetReachable === true ||
            (state?.isInternetReachable == null && state?.isConnected === true);
          const wasReachable = lastReachable;
          lastReachable = reachable;
          if (wasReachable === null) return; // first emission, nothing to compare
          if (!wasReachable && reachable) {
            const client = clientRef.current as any;
            const healthy =
              typeof client.isConnected === "function" &&
              typeof client.isRegistered === "function" &&
              client.isConnected() === true &&
              client.isRegistered() === true;
            console.log(
              '[SIP_RECONNECT] netinfo_regain',
              JSON.stringify({
                type: state?.type ?? null,
                healthy,
                decision: healthy ? 'skip' : 'reconnect',
              }),
            );
            if (!healthy) triggerImmediateReconnect('netinfo_regain');
          } else if (wasReachable && !reachable) {
            console.log(
              '[SIP_SOCKET] netinfo_lost',
              JSON.stringify({ type: state?.type ?? null }),
            );
          }
        } catch (e) {
          console.warn('[SIP_RECONNECT] netinfo_listener_threw:', e);
        }
      });
    } catch (e) {
      console.warn('[SIP_RECONNECT] netinfo_mount_threw:', e);
    }
    return () => {
      try {
        if (typeof sub === "function") sub();
        else if (sub && typeof sub.remove === "function") sub.remove();
      } catch { /* ignore */ }
    };
  }, [hasProvisioning, triggerImmediateReconnect]);

  // ── Stage 1 teardown on logout ──────────────────────────────────────────
  // When the auth token is cleared, the user has logged out. Stop the
  // orchestrator and tell the UA to unregister cleanly so the next
  // login starts from a known state.
  useEffect(() => {
    if (authToken) return;
    // authToken went null → logout. Defensive wrap: a throw here on first
    // mount (when there is no UA yet) would otherwise take the whole
    // provider down via the ErrorBoundary.
    try {
      console.log('[SIP_RECONNECT] logout_teardown');
      cancelPendingReconnect();
      reconnectAttemptRef.current = 0;
      keepAliveFailureStreakRef.current = 0;
      const client = clientRef.current as any;
      if (client && typeof client.unregister === "function") {
        void client.unregister().catch(() => undefined);
      }
    } catch (e) {
      console.warn('[SIP_RECONNECT] logout_teardown_threw:', e);
    }
  }, [authToken, cancelPendingReconnect]);

  // ── Stage 2 native SIP keep-alive foreground service ───────────────────
  // When we have both an auth token AND loaded provisioning, start the
  // native foreground service so Android cannot kill our WebSocket or
  // freeze our JS timers while the screen is off. When either goes
  // false (logout, or provisioning cleared), stop the service so the
  // user is not left with a persistent notification after signing out.
  //
  // This is the actual "VitalPBX-parity" fix. Stage 1 (auto-reconnect)
  // only helps while the process is alive; Stage 2 is what keeps the
  // process alive in the first place.
  const keepAliveWantedRef = useRef<boolean>(false);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const mod: any = (NativeModules as any)?.IncomingCallUi;
    if (!mod || typeof mod.setKeepAliveEnabled !== "function") {
      // Bridge not available (older native build, or iOS). Stage 1 is
      // the best we can do in this build.
      console.warn('[SIP_KEEPALIVE_FGS] bridge_missing — native keep-alive disabled');
      return;
    }
    const want = !!(authToken && hasProvisioning);
    if (keepAliveWantedRef.current === want) return;
    keepAliveWantedRef.current = want;
    try {
      console.log('[SIP_KEEPALIVE_FGS]', want ? 'start_requested' : 'stop_requested');
      mod.setKeepAliveEnabled(want);
    } catch (e) {
      console.warn('[SIP_KEEPALIVE_FGS] bridge_threw:', e);
    }
  }, [authToken, hasProvisioning]);

  // ── Proactive RECORD_AUDIO permission preflight ────────────────────────
  // Until now this was only requested from KeypadTab on the dial-out path.
  // Inbound calls that arrived before the user ever made an outbound call
  // would hit `session.answer({ mediaConstraints: { audio: true } })` without
  // the runtime permission, JsSIP's internal `getUserMedia` would throw
  // (or silently produce a no-track local SDP), and the call would briefly
  // appear to answer then drop — exactly the Samsung Galaxy S25 symptom
  // ("call rang, I tapped answer, it disconnected and never connected").
  //
  // Request RECORD_AUDIO once when SIP is ready (auth + provisioning
  // loaded) so the user grants it during a low-stakes UI moment rather
  // than mid-incoming-call. This effect fires only once per process
  // lifetime per ready transition; if the user denies we surface that
  // via callReadiness for diagnostics but do not nag again — the answer
  // pipeline still has a defensive re-request as last-line-of-defense.
  const recordAudioRequestedRef = useRef<boolean>(false);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (!authToken || !hasProvisioning) return;
    if (recordAudioRequestedRef.current) return;
    recordAudioRequestedRef.current = true;
    void (async () => {
      try {
        const already = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ).catch(() => false);
        if (already) {
          console.log('[SIP_PERM] RECORD_AUDIO already granted at startup');
          return;
        }
        console.log('[SIP_PERM] RECORD_AUDIO not yet granted — requesting proactively');
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Microphone access',
            message:
              'Connect needs microphone access so you can be heard on calls. Without this, incoming calls will disconnect immediately when you answer.',
            buttonPositive: 'Allow',
            buttonNegative: 'Not now',
          },
        );
        console.log('[SIP_PERM] RECORD_AUDIO request result:', result);
      } catch (e) {
        console.warn('[SIP_PERM] RECORD_AUDIO request threw:', e);
      }
    })();
  }, [authToken, hasProvisioning]);

  // ── Push-wake (Option 2) — react to native Sip.WakeRegister event ───────
  // Native IncomingCallFirebaseService fires this event when an
  // INCOMING_CALL_WAKE FCM data message arrives. We force-register the SIP
  // UA so the device is online before the PBX dialplan dials in ~6 seconds,
  // and POST telemetry events so the backend timeline shows every step.
  //
  // Suppression: ignore duplicate wake events for the same pbxCallId within
  // 30 seconds. The PBX dialplan only fires the wake hook once per call, but
  // FCM may rarely re-deliver, and we don't want to thrash the UA.
  const lastHandledWakeRef = useRef<{ pbxCallId: string; ts: number } | null>(null);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (!authToken) return; // can't POST telemetry without auth

    const sub = DeviceEventEmitter.addListener("Sip.WakeRegister", async (raw: any) => {
      const t0 = Date.now();
      const pbxCallId = String(raw?.pbxCallId || "").trim();
      const toExtension = String(raw?.toExtension || "");
      const fromNumber = String(raw?.fromNumber || "");
      const wakeRequestedAt = String(raw?.wakeRequestedAt || "");
      const appState = String(raw?.appState || "");

      console.log(
        "[CALL_WAKE] Sip.WakeRegister received",
        JSON.stringify({ pbxCallId, toExtension, fromNumber, wakeRequestedAt, appState }),
      );

      if (!pbxCallId) {
        console.warn("[CALL_WAKE] Sip.WakeRegister missing pbxCallId — ignoring");
        return;
      }

      // Duplicate suppression.
      const last = lastHandledWakeRef.current;
      if (last && last.pbxCallId === pbxCallId && t0 - last.ts < 30_000) {
        console.log("[CALL_WAKE] duplicate wake event suppressed", JSON.stringify({ pbxCallId, ageMs: t0 - last.ts }));
        return;
      }
      lastHandledWakeRef.current = { pbxCallId, ts: t0 };

      if (fromNumber === "vm-greeting" || pbxCallId.startsWith("vm-greeting-record")) {
        void rememberVmGreetingWake(pbxCallId, fromNumber || "vm-greeting").catch(() => undefined);
      }

      // Lazy-load the API helper to avoid a top-level cycle.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { postWakeEvent } = require("../api/client") as typeof import("../api/client");

      // Stage A — DEVICE_PUSH_RECEIVED.
      void postWakeEvent(authToken, {
        pbxCallId,
        stage: "DEVICE_PUSH_RECEIVED",
        details: {
          toExtension,
          fromNumber,
          wakeRequestedAt,
          appState,
          jsBootedAtMs: t0,
        },
      });

      // Ensure provisioning is loaded — we may have been dead-cold and JS
      // only just started. ensureProvisioningLoaded is idempotent.
      try {
        const loaded = await ensureProvisioningLoaded();
        if (!loaded) {
          console.warn("[CALL_WAKE] no provisioning available — wake aborted (user not signed in?)");
          await postWakeEvent(authToken, {
            pbxCallId,
            stage: "DEVICE_REGISTER_FAILED",
            details: { reason: "no_provisioning" },
          });
          return;
        }
      } catch (e: any) {
        console.warn("[CALL_WAKE] ensureProvisioningLoaded threw:", e?.message);
        await postWakeEvent(authToken, {
          pbxCallId,
          stage: "DEVICE_REGISTER_FAILED",
          details: { reason: "provisioning_threw", error: e?.message },
        });
        return;
      }

      // Stage B — DEVICE_REGISTER_TRIGGERED.
      // For VM-greeting recording wakes: skip forceRestart only when the JsSIP
      // stack is *actually* connected + registered. React's registrationStateRef
      // can say "registered" while the WebSocket is dead (no DISCONNECTED event),
      // which would make us skip restart and leave Asterisk with no contact.
      // When the stack is healthy, skipping restart avoids a race where Dial()
      // runs before a fresh 200 OK after a needless UA teardown.
      // For all other wakes (normal incoming PSTN): always forceRestart.
      const isVmGreetingWake = fromNumber === "vm-greeting";
      const prevRegState = registrationStateRef.current;
      let sipConnected = false;
      let sipRegistered = false;
      try {
        sipConnected = clientRef.current.isConnected();
        sipRegistered = clientRef.current.isRegistered();
      } catch {
        sipConnected = false;
        sipRegistered = false;
      }
      const sipStackHealthy = sipConnected && sipRegistered;
      const needsForceRestart = !(isVmGreetingWake && sipStackHealthy);
      const triggeredAt = Date.now();
      await postWakeEvent(authToken, {
        pbxCallId,
        stage: "DEVICE_REGISTER_TRIGGERED",
        details: {
          forceRestart: needsForceRestart,
          previousRegState: prevRegState,
          sipConnected,
          sipRegistered,
          sipStackHealthy,
          appState,
          latencySinceWakeMs: triggeredAt - t0,
        },
      });

      try {
        await clientRef.current.register({ forceRestart: needsForceRestart });
        const completedAt = Date.now();
        console.log(
          "[CALL_WAKE] register({forceRestart:" + needsForceRestart + "}) resolved",
          JSON.stringify({
            pbxCallId,
            registerLatencyMs: completedAt - triggeredAt,
            totalLatencyMs: completedAt - t0,
            regState: registrationStateRef.current,
          }),
        );
        await postWakeEvent(authToken, {
          pbxCallId,
          stage: "DEVICE_REGISTER_COMPLETE",
          details: {
            registerLatencyMs: completedAt - triggeredAt,
            totalLatencyMs: completedAt - t0,
            regState: registrationStateRef.current,
          },
        });
      } catch (e: any) {
        console.warn("[CALL_WAKE] register({forceRestart:" + needsForceRestart + "}) threw:", e?.message);
        await postWakeEvent(authToken, {
          pbxCallId,
          stage: "DEVICE_REGISTER_FAILED",
          details: { error: e?.message, regState: registrationStateRef.current },
        });
      }
    });

    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authToken]);

  // ─────────────────────────────────────────────────────────────────────
  // Stage 2 prerequisite — request battery-optimization exemption.
  //
  // Samsung / Xiaomi / OPPO / Huawei OEM skins routinely kill foreground
  // services under memory pressure even when foregroundServiceType is
  // "phoneCall". The single reliable knob that stops this is the system
  // "Not optimized" / "Don't optimize battery" toggle for our package.
  //
  // We prompt the user exactly once, the first time they are both
  // authenticated and provisioned, and only if the OS says we are still
  // subject to battery optimization. The result is persisted in
  // AsyncStorage so we don't nag on every launch; if the user declines
  // we will re-prompt in the app's Settings screen (future work).
  //
  // Without this, the FGS keep-alive "works on paper" but gets killed
  // after ~16–24 s on Samsung, collapsing Stage 2 back to a cold start
  // on the next incoming call.
  // ─────────────────────────────────────────────────────────────────────
  const batteryPromptAttemptedRef = useRef<boolean>(false);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (!authToken || !hasProvisioning) return;
    if (batteryPromptAttemptedRef.current) return;
    batteryPromptAttemptedRef.current = true;

    const mod: any = (NativeModules as any)?.IncomingCallUi;
    if (
      !mod ||
      typeof mod.isBatteryOptimizationIgnored !== "function" ||
      typeof mod.requestBatteryOptimizationExclusion !== "function"
    ) {
      console.warn('[BATT_OPT] bridge_missing — cannot request exemption');
      return;
    }

    const PROMPT_KEY = "cc_mobile_batt_opt_prompted_v1";
    let cancelled = false;
    (async () => {
      try {
        const alreadyIgnored: boolean = await mod.isBatteryOptimizationIgnored();
        if (cancelled) return;
        if (alreadyIgnored) {
          console.log('[BATT_OPT] already_ignored — no prompt needed');
          return;
        }
        const previouslyPrompted = await AsyncStorage.getItem(PROMPT_KEY);
        if (cancelled) return;
        if (previouslyPrompted === "1") {
          console.log('[BATT_OPT] previously_prompted_and_declined — skipping this launch');
          return;
        }
        console.log('[BATT_OPT] requesting_exemption — launching system dialog');
        try {
          await mod.requestBatteryOptimizationExclusion();
        } catch (e) {
          console.warn('[BATT_OPT] request_threw:', e);
        }
        try {
          await AsyncStorage.setItem(PROMPT_KEY, "1");
        } catch {
          // ignore — non-critical
        }
      } catch (e) {
        console.warn('[BATT_OPT] flow_threw:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authToken, hasProvisioning]);

  const prevCallStateRef = useRef<CallState>("idle");
  // Anchor for the in-call notification chronometer. Set when the call
  // first transitions to "connected" so the live timer in the persistent
  // notification reflects the true wall-clock duration even after re-renders.
  const callConnectedAtRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevCallStateRef.current;
    prevCallStateRef.current = callState;
    if (callState === "connected" && prev !== "connected") {
      logCallFlow("SIP_CALL_STATE_CONNECTED", {
        inviteId: null,
        extra: { previous: prev },
      });
      // Safety net: stop native ringtone the moment telephony reports a
      // confirmed connection. Lock-screen path: the in-app "Answer" button
      // tap has already issued dismissNativeIncomingUi, but if that bridge
      // call is swallowed (module missing, app paused mid-transition, etc.)
      // the native MediaPlayer would otherwise keep ringing during and past
      // the call. Hooking the authoritative SIP "confirmed" state guarantees
      // we stop the ringtone exactly when the audio path goes live.
      if (Platform.OS === "android") {
        try {
          const mod = NativeModules.IncomingCallUi;
          if (mod && typeof mod.stopRingtone === "function") {
            console.log("[NATIVE_DISMISS] stopRingtone on SIP_CONNECTED");
            mod.stopRingtone(null);
          }
        } catch (e) {
          console.warn("[NATIVE_DISMISS] stopRingtone on connect threw:", String(e));
        }
        // Promote SipKeepAliveService to in-call mode so:
        //   • foreground-service type ladder includes MICROPHONE — Android 14+
        //     stops muting WebRTC capture when the app backgrounds (the
        //     remote-party-hears-silence bug)
        //   • the persistent notification swaps to a CallStyle.forOngoingCall
        //     surface with End / Speaker / Mute action buttons + a live timer
        callConnectedAtRef.current = Date.now();
        try {
          const mod = NativeModules.IncomingCallUi;
          if (mod && typeof mod.startInCallNotification === "function") {
            mod.startInCallNotification(
              remoteParty || "On a call",
              callConnectedAtRef.current,
              speakerOn,
              muted,
            );
          }
        } catch (e) {
          console.warn("[IN_CALL_NOTIF] startInCallNotification threw:", String(e));
        }
      }
    }
    if (callState === "ended" && prev !== "ended") {
      logCallFlow("SIP_CALL_STATE_ENDED", {
        inviteId: null,
        extra: { previous: prev },
      });
      // Final safety net: any native ringtone MUST be silenced on call end
      // even if earlier hooks missed it. This guarantees the user never
      // hears a leftover ringtone after hangup under any race.
      if (Platform.OS === "android") {
        try {
          const mod = NativeModules.IncomingCallUi;
          if (mod && typeof mod.stopRingtone === "function") {
            console.log("[NATIVE_DISMISS] stopRingtone on SIP_ENDED");
            mod.stopRingtone(null);
          }
        } catch (e) {
          console.warn("[NATIVE_DISMISS] stopRingtone on end threw:", String(e));
        }
        // Drop SipKeepAliveService back to idle mode — the FGS goes from
        // MICROPHONE-typed back to PHONE_CALL|DATA_SYNC, and the notification
        // returns to the minimal "Ready to receive calls" surface.
        try {
          const mod = NativeModules.IncomingCallUi;
          if (mod && typeof mod.stopInCallNotification === "function") {
            mod.stopInCallNotification();
          }
        } catch (e) {
          console.warn("[IN_CALL_NOTIF] stopInCallNotification threw:", String(e));
        }
        callConnectedAtRef.current = null;
      }
    }
  }, [callState, remoteParty, speakerOn, muted]);

  // Refresh the in-call notification's Speaker / Mute toggle visuals when
  // the underlying audio routing flips mid-call. Skipped while idle so we
  // don't spam the bridge.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (callState !== "connected") return;
    try {
      const mod = NativeModules.IncomingCallUi;
      if (mod && typeof mod.updateInCallNotification === "function") {
        mod.updateInCallNotification(speakerOn, muted);
      }
    } catch (e) {
      console.warn("[IN_CALL_NOTIF] updateInCallNotification threw:", String(e));
    }
  }, [speakerOn, muted, callState]);

  // Subscribe to taps on the in-call notification's End / Speaker / Mute
  // action buttons. The native side updates its own snapshot synchronously
  // so the icon flips immediately; we mirror the change in JS state and
  // call into the JsSIP / ICM bridges so the actual call actually changes.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = DeviceEventEmitter.addListener(
      "Sip.InCallNotificationAction",
      (evt: { action?: string; value?: boolean }) => {
        const action = evt?.action;
        const value = evt?.value;
        console.log("[IN_CALL_NOTIF] action received", { action, value });
        switch (action) {
          case "hangup": {
            clientRef.current.hangup().catch((err) => {
              console.warn("[IN_CALL_NOTIF] hangup from notification failed:", String(err));
            });
            break;
          }
          case "toggle_speaker": {
            const next = typeof value === "boolean" ? value : !speakerOn;
            try { clientRef.current.setSpeaker(next); } catch {}
            setSpeakerOn(next);
            setAudioRoute(next ? "speaker" : "earpiece");
            break;
          }
          case "toggle_mute": {
            const next = typeof value === "boolean" ? value : !muted;
            try { clientRef.current.setMute(next); } catch {}
            setMuted(next);
            break;
          }
        }
      },
    );
    return () => { sub.remove(); };
  }, [speakerOn, muted]);

  const value = useMemo<SipState>(
    () => ({
      registrationState,
      callState,
      remoteParty,
      callDirection,
      muted,
      speakerOn,
      onHold,
      hasProvisioning,
      lastError,
      lastDialed,
      audioRoute,

      saveProvisioning: async (bundle) => {
        await SecureStore.setItemAsync(PROVISION_KEY, JSON.stringify(bundle));
        clientRef.current.configure(bundle);
        setHasProvisioning(true);
        // Immediately re-register with the new credentials
        await clientRef.current.register({ forceRestart: true }).catch((e) => {
          console.warn("[SIP] Re-register after provisioning failed:", e?.message);
        });
      },

      register: async (options) => {
        await ensureProvisioningLoaded();
        await clientRef.current.register(options);
      },

      unregister: async () => {
        await clientRef.current.unregister();
      },

      dial: async (target, options) => {
        const displayTarget = options?.displayTarget || target;
        setCallDirection("outbound");
        setRemoteParty(displayTarget);
        setLastError(null);
        // Persist last dialed number for "redial" feature
        setLastDialed(displayTarget);
        SecureStore.setItemAsync(LAST_DIALED_KEY, displayTarget).catch(() => {});
        // Track call info for local history
        callInfoRef.current = {
          direction: "outbound",
          answered: false,
          startMs: Date.now(),
          remoteParty: displayTarget,
        };
        // Initial UI hint — the audio route manager (called from JsSipClient)
        // will overwrite this with the real route (Bluetooth if available)
        // before the first ringback tone is heard.
        const snapshot = getAudioDevicesSnapshot();
        setAudioRoute(snapshot.bluetoothConnected ? "bluetooth" : "earpiece");
        await clientRef.current.dial(target);
      },

      answer: async () => {
        await clientRef.current.answer();
      },

      answerIncomingInvite: async (match, timeoutMs = 5000, onTrace) => {
        setCallDirection("inbound");
        return clientRef.current.answerIncoming(match, timeoutMs, onTrace);
      },

      rejectIncomingInvite: async (match) => {
        return clientRef.current.rejectIncoming(match);
      },

      hangup: async () => {
        await clientRef.current.hangup();
      },

      toggleMute: () => {
        const next = !muted;
        clientRef.current.setMute(next);
        setMuted(next);
      },

      toggleSpeaker: () => {
        // Delegate to the route manager so the call audio sink follows a
        // single, durable policy (user override > BT > wired > earpiece).
        // Toggling speaker on sets a per-call override; toggling speaker off
        // clears the override so BT comes back automatically.
        audioRouteManager.refreshDevices(getAudioDevicesSnapshot());
        const nextRoute = audioRouteManager.toggleSpeaker();
        const isSpeaker = nextRoute === "speaker";
        setSpeakerOn(isSpeaker);
        setAudioRoute(isSpeaker ? "speaker" : nextRoute === "bluetooth" ? "bluetooth" : "earpiece");
      },

      cycleAudioRoute: () => {
        // Single-tap toggle between speaker and the best non-speaker route
        // (BT if connected, else wired, else earpiece). Implementation lives
        // in the route manager so every code path agrees on which sink wins.
        audioRouteManager.refreshDevices(getAudioDevicesSnapshot());
        const nextRoute = audioRouteManager.cycleSpeakerRoute();
        const isSpeaker = nextRoute === "speaker";
        setSpeakerOn(isSpeaker);
        setAudioRoute(isSpeaker ? "speaker" : nextRoute === "bluetooth" ? "bluetooth" : "earpiece");
      },

      toggleHold: () => {
        if (onHold) {
          clientRef.current.unhold();
          setOnHold(false);
        } else {
          clientRef.current.hold();
          setOnHold(true);
        }
      },

      sendDtmf: (digit) => {
        clientRef.current.sendDtmf(digit);
      },

      // ---- Multi-call passthrough ----
      registerMultiCallListener: (listener) => {
        multiCallListenerRef.current = listener;
        return () => {
          if (multiCallListenerRef.current === listener) {
            multiCallListenerRef.current = null;
          }
        };
      },
      listSipSessions: () => clientRef.current.listSessions(),
      holdSipSession: (id) => clientRef.current.holdSession(id),
      unholdSipSession: (id) => clientRef.current.unholdSession(id),
      hangupSipSession: (id) => clientRef.current.hangupSession(id),
      isSipSessionAlive: (id) => clientRef.current.isSessionAlive(id),
      transferSipSession: (id, target) => clientRef.current.transferSession(id, target),
      answerSipSession: (id, timeoutMs, onTrace) =>
        clientRef.current.answerSession(id, timeoutMs, onTrace),
      setActiveSipSession: (id) => clientRef.current.setActiveSession(id),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registrationState, callState, callDirection, remoteParty, muted, speakerOn, onHold, hasProvisioning, lastError, lastDialed, audioRoute, ensureProvisioningLoaded],
  );

  return <SipContext.Provider value={value}>{children}</SipContext.Provider>;
}

export function useSip() {
  const ctx = useContext(SipContext);
  if (!ctx) throw new Error("useSip must be used within SipProvider");
  return ctx;
}
