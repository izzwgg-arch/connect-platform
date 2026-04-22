import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, DeviceEventEmitter, NativeModules, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { createSipClient } from "../sip";
import { postCallQualityReport, postCallQualityPing, clearCallQualityPing } from "../api/client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { appendCallRecord } from "../storage/callHistory";
import type { CallDirection, CallState, CallRecord, ProvisioningBundle, SipRegistrationState } from "../types";
import type { SipAnswerTraceEvent, SipSessionInfo } from "../sip/types";
import { useAuth } from "./AuthContext";
import { logCallFlow, setCallFlowLastError } from "../debug/callFlowDebug";

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
  dial: (target: string) => Promise<void>;
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
  const bluetoothAvailableRef = useRef(false);
  useEffect(() => {
    bluetoothAvailableRef.current = bluetoothAvailable;
  }, [bluetoothAvailable]);

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
      setAudioRoute("earpiece");

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
        const speakerOnNow = !!result?.speakerphoneOn;
        setBluetoothAvailable((prev) => (prev !== bt ? bt : prev));
        setAudioRoute((prev) => {
          if (speakerOnNow) return "speaker";
          if (bt && prev !== "speaker") return "bluetooth";
          if (!bt && prev === "bluetooth") return "earpiece";
          return prev;
        });
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
      }
    }
  }, [callState]);

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

      dial: async (target) => {
        setCallDirection("outbound");
        setRemoteParty(target);
        setLastError(null);
        // Persist last dialed number for "redial" feature
        setLastDialed(target);
        SecureStore.setItemAsync(LAST_DIALED_KEY, target).catch(() => {});
        // Track call info for local history
        callInfoRef.current = {
          direction: "outbound",
          answered: false,
          startMs: Date.now(),
          remoteParty: target,
        };
        setAudioRoute("earpiece");
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
        const next = !speakerOn;
        clientRef.current.setSpeaker(next);
        setSpeakerOn(next);
        setAudioRoute(next ? "speaker" : "earpiece");
      },

      cycleAudioRoute: () => {
        // Two-state cycle that adapts to the current output devices:
        //   • Bluetooth connected   → Speaker ⇄ Bluetooth
        //   • Bluetooth NOT present → Speaker ⇄ Earpiece
        //
        // On Android we drive AudioManager directly through the
        // IncomingCallUi native bridge. `chooseAudioRoute("BLUETOOTH")`
        // from react-native-incall-manager is unreliable on several
        // OEM builds (Samsung One UI in particular silently falls back
        // to earpiece), so we call startBluetoothSco() / setSpeakerphoneOn
        // ourselves — the same mechanism the stock phone app uses.
        //
        // On iOS we fall back to the original InCallManager toggle
        // because CallKit + the route picker own the BT selection UX.
        const btAvailable = bluetoothAvailableRef.current;
        const nativeAudio: any = (NativeModules as any)?.IncomingCallUi;
        const hasNativeRouter =
          Platform.OS === "android" &&
          nativeAudio &&
          typeof nativeAudio.routeAudioToBluetooth === "function" &&
          typeof nativeAudio.routeAudioToEarpiece === "function" &&
          typeof nativeAudio.routeAudioToSpeaker === "function";

        if (hasNativeRouter) {
          try {
            if (audioRoute === "speaker") {
              if (btAvailable) {
                nativeAudio.routeAudioToBluetooth();
                setSpeakerOn(false);
                setAudioRoute("bluetooth");
              } else {
                nativeAudio.routeAudioToEarpiece();
                setSpeakerOn(false);
                setAudioRoute("earpiece");
              }
            } else {
              // Going TO speaker from earpiece OR bluetooth. Stopping the
              // SCO link is the native side's responsibility — it's done
              // inside routeAudioToSpeaker().
              nativeAudio.routeAudioToSpeaker();
              setSpeakerOn(true);
              setAudioRoute("speaker");
            }
            return;
          } catch (e) {
            // Fall through to the InCallManager path if the native
            // router throws for any reason.
            console.warn("[SIP] native routeAudio failed:", e);
          }
        }

        // iOS / missing native router fallback.
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const ICMModule = require("react-native-incall-manager").default;
          if (audioRoute === "speaker") {
            try {
              if (typeof ICMModule.chooseAudioRoute === "function") {
                ICMModule.chooseAudioRoute(btAvailable ? "BLUETOOTH" : "EARPIECE");
              } else {
                ICMModule.setSpeakerphoneOn(false);
              }
            } catch { /* ignore */ }
            setSpeakerOn(false);
            setAudioRoute(btAvailable ? "bluetooth" : "earpiece");
          } else {
            try { ICMModule.setSpeakerphoneOn(true); } catch { /* ignore */ }
            setSpeakerOn(true);
            setAudioRoute("speaker");
          }
        } catch {
          const next = !speakerOn;
          clientRef.current.setSpeaker(next);
          setSpeakerOn(next);
          setAudioRoute(next ? "speaker" : "earpiece");
        }
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
