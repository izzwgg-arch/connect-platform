import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { createSipClient } from "../sip";
import { postCallQualityReport, postCallQualityPing, clearCallQualityPing, postWebrtcCallDebug } from "../api/client";
import { appendCallRecord } from "../storage/callHistory";
import type { CallDirection, CallState, CallRecord, ProvisioningBundle, SipRegistrationState } from "../types";
import type { SipAnswerTraceEvent, SipSessionInfo, SipAnswerDeadlineHandle, OutboundTraceEvent } from "../sip/types";
import { useAuth } from "./AuthContext";
import { logCallFlow, setCallFlowLastError } from "../debug/callFlowDebug";
import { rememberVmGreetingWake } from "../voicemail/vmGreetingWakeBridge";
import { audioRouteManager, getAudioDevicesSnapshot } from "../audio/audioRouteManager";
import {
  flightBeginCall,
  flightEndCall,
  flightRecord,
  flightSetSipState,
} from "../diagnostics/CallFlightRecorder";
import { ensureMicPermissionOrAlert } from "../sip/permissions";
import { showAppAlert } from "../components/ui/appAlert";
import {
  classifyOutboundSipFailure,
  normalizeMobileDialTarget,
} from "../sip/mobileOutboundDial";
import { shouldForceRestartOnWake } from "../sip/mobileWakeRegistration";

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
  dial: (
    target: string,
    options?: {
      displayTarget?: string;
      /**
       * Explicit opt-in for starting a call while another call is already
       * active (the "Add call" flow). When omitted/false and a call is in
       * progress, `dial` refuses and asks the user to confirm first — this
       * prevents accidental double-taps / two-button presses from silently
       * spawning multiple background calls.
       */
      allowSecond?: boolean;
    },
  ) => Promise<void>;
  answer: () => Promise<void>;
  answerIncomingInvite: (
    match: { inviteId?: string | null; fromNumber?: string | null; toExtension?: string | null; pbxCallId?: string | null; sipCallTarget?: string | null },
    timeoutMs?: number,
    onTrace?: (event: SipAnswerTraceEvent) => void,
    deadlineHandle?: SipAnswerDeadlineHandle,
  ) => Promise<boolean>;
  waitForIncomingInvite: (
    match: { inviteId?: string | null; fromNumber?: string | null; toExtension?: string | null; pbxCallId?: string | null; sipCallTarget?: string | null },
    deadlineHandle?: SipAnswerDeadlineHandle,
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
  /** Begin inbound WebRTC black-box capture at answer-tap. */
  beginInboundBlackbox: (inviteId: string | null | undefined, meta?: Record<string, unknown>) => void;
  /** Emit inbound black-box failure when pipeline aborts before SIP answer. */
  finalizeInboundBlackboxFailure: (input: {
    inviteId?: string | null;
    pbxCallId?: string | null;
    callerNumber?: string | null;
    calleeExtension?: string | null;
    failureReason: string;
    backendAccept?: Record<string, unknown> | null;
    uiState?: Record<string, unknown> | null;
    pushMeta?: Record<string, unknown> | null;
    forceRestart?: { decided?: boolean; reason?: string | null };
  }) => void;
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
    // SIP display name for inbound calls — ring group prefix / CNAM from the
    // From: header, e.g. "New Tires:Caller Name". Stored separately so
    // fromNumber in call history stays the actual phone number.
    remotePartyName: null as string | null,
  });

  // Ref tracking registration state for use inside AppState event callbacks
  // (closures capture stale state otherwise).
  const registrationStateRef = useRef<SipRegistrationState>("idle");

  // Mirror of callState read synchronously inside dial() so the
  // "already on a call" guard isn't fooled by a stale render closure.
  const callStateRef = useRef<CallState>("idle");

  // Re-entrancy lock for dial(). Held from the moment a dial begins until the
  // underlying client.dial() settles, so a rapid double-tap (or two different
  // call buttons pressed at once) can't fan out into several background calls.
  const dialInFlightRef = useRef(false);

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
      if ("setBlackboxContext" in clientRef.current) {
        clientRef.current.setBlackboxContext({
          authUsername: parsed.authUsername ?? parsed.sipUsername ?? null,
          sipUsername: parsed.sipUsername ?? null,
          extensionNumber: parsed.sipUsername?.replace(/_\d+$/, "") ?? null,
          client: {
            appVersion: Constants.expoConfig?.version ?? null,
            nativeBuild: Constants.nativeBuildVersion ?? null,
            deviceModel: Device.modelName ?? null,
          },
        });
      }
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
      const wasOutbound = callDirection === "outbound";
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
      if (wasOutbound && info.startMs) {
        void flightEndCall(info.answered ? "answered" : "failed");
      }
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
          fromName: info.direction === "inbound" ? (info.remotePartyName || null) : null,
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
          remotePartyName: null,
        };
      }

      const t = setTimeout(() => setCallState("idle"), 1200);
      return () => clearTimeout(t);
    }
  }, [callState, callDirection]);

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
    if ("onWebrtcCallDebug" in client || typeof client.onWebrtcCallDebug !== "undefined") {
      client.onWebrtcCallDebug = (payload: Record<string, unknown>) => {
        if (!authToken) return;
        postWebrtcCallDebug(authToken, payload).catch(() => {});
      };
    }
  }, [authToken]);

  // Keep registrationStateRef in sync so the AppState callback below
  // can check the current state without a stale closure.
  useEffect(() => {
    registrationStateRef.current = registrationState;
  }, [registrationState]);

  // Keep callStateRef in sync for the synchronous guard inside dial().
  useEffect(() => {
    callStateRef.current = callState;
  }, [callState]);

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
      onIncomingCall: (callerNumber: string, callerName?: string | null) => {
        const party = callerNumber || "Unknown";
        setCallDirection("inbound");
        setRemoteParty(party);
        callInfoRef.current = {
          direction: "inbound",
          answered: false,
          startMs: Date.now(),
          remoteParty: party,
          remotePartyName: callerName || null,
        };
        setCallState("ringing");
      },
      onError: (msg) => {
        setLastError(msg);
        setCallFlowLastError(msg);
      },

      onOutboundTrace: (event: OutboundTraceEvent) => {
        const severity =
          event.stage === "OUTBOUND_FAILED" ? "error" :
          event.stage === "OUTBOUND_ENDED" ? "info" : "info";
        const diagnosis =
          event.stage === "OUTBOUND_FAILED"
            ? classifyOutboundSipFailure({
                sipCode: event.sipCode,
                sipReason: event.sipReason,
                sipCause: event.sipCause,
              })
            : null;
        flightRecord("SIP", event.stage, {
          severity,
          payload: {
            dialedNumber: event.dialedNumber ?? null,
            normalizedNumber: event.normalizedNumber ?? null,
            registrationAgeMs: event.registrationAgeMs ?? null,
            sipCode: diagnosis?.sipCode ?? event.sipCode ?? null,
            sipReason: diagnosis?.sipReason ?? event.sipReason ?? null,
            sipCause: diagnosis?.sipCause ?? event.sipCause ?? null,
            failedOriginator: event.failedOriginator ?? null,
            diagnosisCategory: diagnosis?.category ?? null,
          },
        });
      },

      onIncomingInviteReceived: (info) => {
        flightRecord("SIP", "SIP_INVITE_RECEIVED", {
          payload: {
            sessionId: info.sessionId,
            from: info.from,
            to: info.to,
            callerName: info.callerName,
          },
        });
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

  // NOTE: A `@react-native-community/netinfo` connectivity-regain trigger
  // was here (introduced in e070c03). It was removed because netinfo is NOT
  // installed in this app — Metro baked require(undefined) into the Hermes
  // bundle, causing a fatal "Requiring unknown module 'undefined'" crash on
  // every startup. The same pattern was previously fixed in
  // NotificationsContext.tsx (see comment there). Reconnection on network
  // regain falls back to the 30-second keep-alive health check and the
  // backoff orchestrator above. Do NOT re-add require("@react-native-community/netinfo")
  // here unless the package is first added to apps/mobile/package.json AND
  // native-linked in a new prebuild.

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
  // Request the call-critical runtime permissions (microphone + Android 13+
  // notifications) in front of the user. Called on startup once SIP is ready
  // AND again right after a re-provision, so a freshly provisioned device (or
  // one whose permissions were revoked) always gets prompted before the next
  // incoming call rather than silently failing.
  const ensureCallPermissions = useCallback(async (reason: string) => {
    if (Platform.OS !== "android") return;
    try {
      const micGranted = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ).catch(() => false);
      if (!micGranted) {
        console.log(`[SIP_PERM] RECORD_AUDIO not granted (${reason}) — requesting`);
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
      }
    } catch (e) {
      console.warn('[SIP_PERM] RECORD_AUDIO request threw:', e);
    }

    // POST_NOTIFICATIONS only exists on Android 13 (API 33)+.
    const postNotif = (PermissionsAndroid.PERMISSIONS as any).POST_NOTIFICATIONS;
    if (postNotif) {
      try {
        const notifGranted = await PermissionsAndroid.check(postNotif).catch(() => false);
        if (!notifGranted) {
          console.log(`[SIP_PERM] POST_NOTIFICATIONS not granted (${reason}) — requesting`);
          const result = await PermissionsAndroid.request(postNotif, {
            title: 'Allow notifications',
            message:
              'Connect needs notification permission to ring and show incoming calls. Calls will not alert you without it.',
            buttonPositive: 'Allow',
            buttonNegative: 'Not now',
          });
          console.log('[SIP_PERM] POST_NOTIFICATIONS request result:', result);
        }
      } catch (e) {
        console.warn('[SIP_PERM] POST_NOTIFICATIONS request threw:', e);
      }
    }
  }, []);
  const ensureCallPermissionsRef = useRef(ensureCallPermissions);
  useEffect(() => { ensureCallPermissionsRef.current = ensureCallPermissions; }, [ensureCallPermissions]);

  const recordAudioRequestedRef = useRef<boolean>(false);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (!authToken || !hasProvisioning) return;
    if (recordAudioRequestedRef.current) return;
    recordAudioRequestedRef.current = true;
    void ensureCallPermissions('startup');
  }, [authToken, hasProvisioning, ensureCallPermissions]);

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
      flightRecord("PUSH", "WAKE_PUSH_RECEIVED", {
        pbxCallId,
        payload: { toExtension, fromNumber, appState },
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
      // Only forceRestart when the JsSIP stack is not actually connected+registered.
      // Tearing down a healthy UA during PSTN wake drops PBX INVITEs mid-flight.
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
      const needsForceRestart = shouldForceRestartOnWake({ sipConnected, sipRegistered });
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
      flightRecord("SIP", "WAKE_REGISTER_TRIGGERED", {
        pbxCallId,
        payload: { forceRestart: needsForceRestart, previousRegState: prevRegState },
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
        flightRecord("SIP", "WAKE_REGISTER_COMPLETE", {
          pbxCallId,
          payload: {
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
        flightRecord("SIP", "WAKE_REGISTER_FAILED", {
          pbxCallId,
          severity: "error",
          payload: { error: e?.message, regState: registrationStateRef.current },
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
  // We prompt whenever the user is authenticated + provisioned and the OS
  // still reports we are subject to battery optimization — on launch and on
  // every return to the foreground — so the customer always knows it is not
  // enabled and can fix it.
  //
  // Without this, the FGS keep-alive "works on paper" but gets killed
  // after ~16–24 s on Samsung, collapsing Stage 2 back to a cold start
  // on the next incoming call.
  // ─────────────────────────────────────────────────────────────────────
  // Re-prompt on EVERY foreground while the app is still subject to battery
  // optimization. Customers must clearly know it is not enabled and be able to
  // fix it — so we surface an in-app alert that launches the system exemption
  // dialog, rather than nagging silently once and giving up. A short cooldown
  // prevents an infinite loop while the system dialog itself is on screen
  // (which briefly backgrounds then re-foregrounds the app).
  const lastBatteryPromptAtRef = useRef<number>(0);
  const batteryPromptOpenRef = useRef<boolean>(false);
  const maybePromptBatteryOptimization = useCallback(async () => {
    if (Platform.OS !== "android") return;
    const mod: any = (NativeModules as any)?.IncomingCallUi;
    if (
      !mod ||
      typeof mod.isBatteryOptimizationIgnored !== "function" ||
      typeof mod.requestBatteryOptimizationExclusion !== "function"
    ) {
      console.warn('[BATT_OPT] bridge_missing — cannot request exemption');
      return;
    }
    if (batteryPromptOpenRef.current) return;
    // Cooldown: avoid re-prompting within 45s (covers the round-trip to the
    // system settings screen and back without looping).
    if (Date.now() - lastBatteryPromptAtRef.current < 45_000) return;
    try {
      const alreadyIgnored: boolean = await mod.isBatteryOptimizationIgnored();
      if (alreadyIgnored) {
        console.log('[BATT_OPT] already_ignored — no prompt needed');
        return;
      }
      lastBatteryPromptAtRef.current = Date.now();
      batteryPromptOpenRef.current = true;
      console.log('[BATT_OPT] not_exempt — prompting user');
      showAppAlert(
        "Turn off battery optimization",
        "Battery optimization is ON for Connect. Incoming calls may not ring reliably until you disable it. Tap Enable and choose \"Don't optimize\".",
        [
          {
            text: "Not now",
            style: "cancel",
            onPress: () => {
              batteryPromptOpenRef.current = false;
            },
          },
          {
            text: "Enable",
            onPress: async () => {
              try {
                await mod.requestBatteryOptimizationExclusion();
              } catch (e) {
                console.warn('[BATT_OPT] request_threw:', e);
              } finally {
                batteryPromptOpenRef.current = false;
              }
            },
          },
        ],
      );
    } catch (e) {
      batteryPromptOpenRef.current = false;
      console.warn('[BATT_OPT] flow_threw:', e);
    }
  }, []);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (!authToken || !hasProvisioning) return;
    void maybePromptBatteryOptimization();
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void maybePromptBatteryOptimization();
    });
    return () => sub.remove();
  }, [authToken, hasProvisioning, maybePromptBatteryOptimization]);

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
            console.log("[CONNECT_CALL_UI] active_call_notification_posted callerName=" + (remoteParty || "On a call"));
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
      // CRITICAL: only treat this as a real hangup when the call had actually
      // CONNECTED. A ring group forks the INVITE to several contacts and rapidly
      // CANCELs + re-INVITEs each fork; every time the last live fork CANCELs,
      // jssip emits onCallState("ended") (siblings=0) even though the caller is
      // still ringing and a replacement INVITE lands ~180ms later. The native
      // incoming ringtone is owned by the dedicated teardown authorities for an
      // UNANSWERED call (the SIP cancel-bridge fork-abandon timeout, the
      // INVITE_POLL killAll, and the INVITE_CANCELED / MISSED_CALL FCM). Calling
      // stopRingtone(null) here on a transient ringing→ended flap silenced the
      // ring ~330ms in ("ringtone didn't ring"). So the native-ringtone +
      // in-call-notification hangup cleanup runs ONLY for connected→ended.
      const wasConnectedCall = prev === "connected" || callConnectedAtRef.current != null;
      console.log(
        "[CONNECT_CALL_UI] remote_hangup_cleanup or local_hangup_cleanup — callState=ended prev=" +
          prev + " wasConnectedCall=" + wasConnectedCall,
      );
      logCallFlow("SIP_CALL_STATE_ENDED", {
        inviteId: null,
        extra: { previous: prev, wasConnectedCall },
      });
      // Final safety net: any native ringtone MUST be silenced on call end
      // even if earlier hooks missed it. This guarantees the user never
      // hears a leftover ringtone after hangup under any race — but ONLY for a
      // call that actually connected (see above; unanswered rings have their own
      // authoritative stop paths and must not be silenced on a fork flap).
      if (Platform.OS === "android" && wasConnectedCall) {
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
        // Native side calls stopForeground(REMOVE) before reposting idle to
        // atomically clear the lock-screen call chip.
        try {
          const mod = NativeModules.IncomingCallUi;
          if (mod && typeof mod.stopInCallNotification === "function") {
            console.log("[CONNECT_CALL_UI] active_call_notification_cleared — dispatching stopInCallNotification");
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
            console.log("[CONNECT_CALL_UI] local_hangup_cleanup — triggered via notification End button");
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
        // Re-provision is a fresh-device moment: prompt for the call-critical
        // permissions again in front of the user (mic + notifications).
        void ensureCallPermissionsRef.current('reprovision');
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
        const normalizedTarget = normalizeMobileDialTarget(target);
        if (!normalizedTarget) {
          throw new Error("Invalid dial target");
        }

        // ── Accidental multi-call safeguard ────────────────────────────────
        // A second outbound call must never start automatically. Two failure
        // modes are blocked here:
        //   1. A dial is already in flight (double-tap, or two different call
        //      buttons mashed at once) → ignore the duplicate outright.
        //   2. A call is already active (dialing/ringing/connected) → only
        //      proceed when the caller explicitly opted in (the "Add call"
        //      flow passes allowSecond) or the user confirms the prompt.
        const allowSecond = options?.allowSecond === true;
        if (dialInFlightRef.current) {
          flightRecord("USER", "OUTBOUND_DIAL_SUPPRESSED_DUPLICATE", {
            payload: { displayTarget, normalizedTarget },
          });
          return;
        }
        dialInFlightRef.current = true;
        try {
          const activeState = callStateRef.current;
          const alreadyInCall =
            activeState === "dialing" ||
            activeState === "ringing" ||
            activeState === "connected";
          if (alreadyInCall && !allowSecond) {
            const proceed = await new Promise<boolean>((resolve) => {
              let settled = false;
              const done = (v: boolean) => {
                if (!settled) {
                  settled = true;
                  resolve(v);
                }
              };
              showAppAlert(
                "Already on a call",
                `Start a new call to ${displayTarget}? Your current call will be kept.`,
                [
                  { text: "Cancel", style: "cancel", onPress: () => done(false) },
                  { text: "Add call", style: "default", onPress: () => done(true) },
                ],
              );
            });
            if (!proceed) {
              flightRecord("USER", "OUTBOUND_SECOND_CALL_DECLINED", {
                payload: { displayTarget, normalizedTarget, activeState },
              });
              return;
            }
          }

          const micOk = await ensureMicPermissionOrAlert();
          if (!micOk) {
            void flightBeginCall({
              callDirection: "outbound",
              dialedNumber: normalizedTarget,
              fromNumber: normalizedTarget,
            });
            flightRecord("USER", "OUTBOUND_PERMISSION_CHECK", {
              severity: "error",
              payload: { granted: false },
            });
            await flightEndCall("failed");
            throw new Error("Microphone permission required");
          }

          await ensureProvisioningLoaded();
          flightSetSipState(registrationStateRef.current);

          void flightBeginCall({
            callDirection: "outbound",
            dialedNumber: normalizedTarget,
            fromNumber: displayTarget,
          });
          flightRecord("USER", "OUTBOUND_CALL_START", {
            payload: {
              displayTarget,
              normalizedTarget,
              registrationState: registrationStateRef.current,
            },
          });
          flightRecord("USER", "OUTBOUND_PERMISSION_CHECK", {
            payload: { granted: true },
          });

          const client = clientRef.current as any;
          const connected = typeof client.isConnected === "function" ? client.isConnected() : false;
          const registered = typeof client.isRegistered === "function" ? client.isRegistered() : false;
          const registrationAgeMs =
            typeof client.getRegistrationAgeMs === "function" ? client.getRegistrationAgeMs() : null;

          if (!connected || !registered) {
            flightRecord("SIP", "OUTBOUND_REGISTER_START", {
              payload: { connected, registered, registrationAgeMs },
            });
          }

          setCallDirection("outbound");
          setRemoteParty(displayTarget);
          setLastError(null);
          setLastDialed(displayTarget);
          SecureStore.setItemAsync(LAST_DIALED_KEY, displayTarget).catch(() => {});
          callInfoRef.current = {
            direction: "outbound",
            answered: false,
            startMs: Date.now(),
            remoteParty: displayTarget,
            remotePartyName: null,
          };
          const snapshot = getAudioDevicesSnapshot();
          setAudioRoute(snapshot.bluetoothConnected ? "bluetooth" : "earpiece");

          try {
            await clientRef.current.dial(normalizedTarget);
            // Optimistically mark the call active so a tap that lands in the
            // gap before the client's state event re-renders React (and syncs
            // callStateRef) still trips the "already on a call" guard above.
            callStateRef.current = "dialing";
            if (typeof client.getRegistrationAgeMs === "function") {
              flightRecord("SIP", "OUTBOUND_REGISTERED", {
                payload: {
                  registrationAgeMs: client.getRegistrationAgeMs(),
                  registrationState: registrationStateRef.current,
                },
              });
            }
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            const diagnosis = classifyOutboundSipFailure({ localReason: msg });
            flightRecord("SIP", "OUTBOUND_FAILED", {
              severity: "error",
              payload: {
                message: msg,
                diagnosisCategory: diagnosis.category,
              },
            });
            await flightEndCall("failed");
            throw e instanceof Error ? e : new Error(msg);
          }
        } finally {
          dialInFlightRef.current = false;
        }
      },

      answer: async () => {
        await clientRef.current.answer();
      },

      answerIncomingInvite: async (match, timeoutMs = 5000, onTrace, deadlineHandle) => {
        setCallDirection("inbound");
        return clientRef.current.answerIncoming(match, timeoutMs, onTrace, deadlineHandle);
      },

      beginInboundBlackbox: (inviteId, meta) => {
        const client = clientRef.current as { beginInboundBlackbox?: typeof clientRef.current.answerIncoming };
        if (typeof client.beginInboundBlackbox === "function") {
          client.beginInboundBlackbox(inviteId, meta);
        }
      },

      finalizeInboundBlackboxFailure: (input) => {
        const client = clientRef.current as { finalizeInboundBlackboxFailure?: (i: typeof input) => void };
        if (typeof client.finalizeInboundBlackboxFailure === "function") {
          client.finalizeInboundBlackboxFailure(input);
        }
      },

      waitForIncomingInvite: async (match, deadlineHandle) => {
        return clientRef.current.waitForIncomingInvite(match, deadlineHandle);
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
