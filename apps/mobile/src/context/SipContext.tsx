import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { getSipClient } from "../sip/sipClientSingleton";
import { ensureSecondarySipRegistered, getSecondarySipClient, listSecondarySipClients } from "../sip/secondaryAccounts";
import { getSipAccountProvisioning, getFreshIceServers, postCallQualityReport, postCallQualityPing, clearCallQualityPing, postWebrtcCallDebug } from "../api/client";
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
import { waitForIosAudioSessionActivation } from "../sip/callkeep";
import { showAppAlert } from "../components/ui/appAlert";
import {
  classifyOutboundSipFailure,
  normalizeMobileDialTarget,
} from "../sip/mobileOutboundDial";
import { shouldForceRestartOnWake } from "../sip/mobileWakeRegistration";
import { getCallWakeNativeState } from "../diagnostics/callWakeDiagnostics";
import { evaluateKeepAliveHealth } from "../sip/keepAliveWatchdog";
import {
  loadKeepAliveGate,
  recordBackgroundDrop,
  recordBackgroundTimestamp,
  SLOW_WAKE_MS,
  type KeepAliveGateState,
} from "../sip/keepAliveGate";
import { BATTERY_OPT_ONBOARD_PROMPTED_KEY } from "../hooks/useBatteryOptimizationPrompt";
import { startTelecomActiveCall, terminateTelecomCall } from "../sip/telecom";
import { isStandingRegistrationEnabled } from "../config/featureFlags";

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
  /**
   * iOS-ONLY display fallback (2026-07-15): wall-clock ms timestamp of when
   * the current call reached "connected"; cleared when it ends. Used by the
   * in-call timer + ongoing-call banner when the multi-call session map has
   * no `answeredAt` (cold-answer re-INVITE session mismatch). Always null on
   * Android — the Android display path is intentionally untouched.
   */
  callConnectedAt: number | null;
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
      /**
       * Dial from an EXTRA SIP account (multi-tenant "second line") instead of
       * the primary extension. The secondary client registers on demand; the
       * primary registration is never touched. Omitted = primary line,
       * exactly as before.
       */
      accountId?: string | null;
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
  /** Synchronous probe: is a matching inbound INVITE already live on the UA? */
  hasMatchingIncomingInvite: (
    match: { inviteId?: string | null; fromNumber?: string | null; toExtension?: string | null; pbxCallId?: string | null; sipCallTarget?: string | null },
  ) => boolean;
  rejectIncomingInvite: (match?: {
    inviteId?: string | null;
    fromNumber?: string | null;
    toExtension?: string | null;
    pbxCallId?: string | null;
    sipCallTarget?: string | null;
  }) => Promise<boolean>;
  /**
   * Android-only inbound-answer latency optimization (Phase 1 / Option 2A).
   * Pre-acquire the mic during an incoming ring; no-op off Android and
   * best-effort. Pair with {@link releasePrewarmedMedia} on every non-answer /
   * terminal path so the mic is never held after a ring/call ends.
   */
  prewarmInboundMedia: () => void;
  releasePrewarmedMedia: (reason: string) => void;
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
  /**
   * Report that a background/cold incoming call could not be delivered over the
   * live SIP socket (e.g. the answer pipeline had to fall back to the backend
   * claim/requeue path because no INVITE arrived). This is proof THIS device
   * failed to hold its registration in the background, so it latches the
   * adaptive keep-alive gate — arming the persistent foreground service so the
   * next killed-state call keeps the process resident and connects instantly.
   */
  markBackgroundDeliveryFailure: (reason: string) => void;
};

const SipContext = createContext<SipState | undefined>(undefined);

export function SipProvider({ children }: { children: React.ReactNode }) {
  const { token: authToken, isLoading: authLoading } = useAuth();
  // Throttle for the ICE-server freshness overlay (see ensureProvisioningLoaded).
  const lastIceRefreshAtRef = useRef(0);

  // Fresh-ICE injection the moment the auth token is available. The cold-boot
  // configure paths (module singleton + provisioning cache) run BEFORE auth
  // hydrates, so they can't fetch fresh TURN credentials themselves — and
  // cached creds expire in 24h (the fleet-wide relay-dead root cause). This
  // effect closes that gap: token arrives → fetch fresh servers → live-update
  // the client (per-call config; next call uses them, no re-register).
  useEffect(() => {
    if (!authToken) return;
    let cancelled = false;
    void (async () => {
      const fresh = await getFreshIceServers(authToken);
      if (cancelled || !fresh) return;
      lastIceRefreshAtRef.current = Date.now();
      (clientRef.current as any)?.updateIceServers?.(fresh);
      (callClientRef.current as any)?.updateIceServers?.(fresh);
      // Persist so even an offline next boot starts with the newest known set.
      try {
        const raw = await SecureStore.getItemAsync(PROVISION_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          parsed.iceServers = fresh;
          await SecureStore.setItemAsync(PROVISION_KEY, JSON.stringify(parsed));
        }
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [authToken]);
  // Shared process-wide client so a registration the headless push task
  // established during ring is the SAME UA that answers here (see
  // sipClientSingleton.ts). createSipClient() previously made a fresh UA per
  // mount, which is why killed-app answers cold-registered and stalled.
  const clientRef = useRef(getSipClient());
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

  // Auth token mirror for use inside the memoised dial() (the value memo's dep
  // list intentionally omits authToken, so read it through a ref).
  const authTokenRef = useRef<string | null>(null);
  useEffect(() => { authTokenRef.current = authToken ?? null; }, [authToken]);

  // iOS ONLY — prime the microphone permission ONCE at first signed-in launch
  // (2026-07-30, "microphone not working" on the first standalone install).
  // The prompt previously fired only on the first OUTBOUND dial; if the very
  // first call on a fresh install was an incoming CallKit answer, the mic had
  // never been requested and the call connected with a dead mic.
  //
  // MUST use expo-av's permission request — a PERMISSIONS-ONLY prompt.
  // Build 22 used the WebRTC getUserMedia probe (ensureMicPermission) here and
  // it KILLED ALL CALL AUDIO both ways: opening the WebRTC capture unit at
  // launch, outside any call, left the iOS audio session wedged, and when
  // CallKit later activated the real call the audio unit could not start (no
  // mic, no speaker). Never touch WebRTC/getUserMedia outside the immediate
  // dial/answer path on iOS.
  const micPrimedRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== "ios" || !authToken || micPrimedRef.current) return;
    micPrimedRef.current = true;
    try {
      // Lazy require keeps expo-av out of surfaces that never touch audio.
      const { Audio } = require("expo-av");
      Audio.requestPermissionsAsync()
        .then((res: { granted?: boolean }) => {
          if (!res?.granted) {
            console.warn("[mic-perm] first-launch mic permission not granted — incoming answers will have no mic until enabled in Settings");
          } else {
            console.log("[mic-perm] first-launch mic permission granted (permissions-only prompt)");
          }
        })
        .catch(() => undefined);
    } catch {
      /* expo-av unavailable — the dial-time preflight still covers outbound */
    }
  }, [authToken]);

  // Mirror of callState read synchronously inside dial() so the
  // "already on a call" guard isn't fooled by a stale render closure.
  const callStateRef = useRef<CallState>("idle");

  // Re-entrancy lock for dial(). Held from the moment a dial begins until the
  // underlying client.dial() settles, so a rapid double-tap (or two different
  // call buttons pressed at once) can't fan out into several background calls.
  const dialInFlightRef = useRef(false);

  // The client that owns the CURRENT call. Defaults to the primary singleton;
  // switched to a secondary-account client while a "second line" call is live,
  // so hangup/mute/hold/DTMF hit the right UA. Reset to primary on idle.
  const callClientRef = useRef(clientRef.current);

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
      // Overlay FRESH ICE servers onto the cached bundle. The cached TURN
      // credentials expire 24h after provisioning, which left the whole
      // fleet relay-dead (iceHasTurn:false everywhere, 2026-07-29 root
      // cause). Throttled; offline keeps the cached set (calls still work
      // direct, exactly as before).
      const tok = authTokenRef.current;
      if (tok && Date.now() - lastIceRefreshAtRef.current > 5 * 60 * 1000) {
        const fresh = await getFreshIceServers(tok);
        if (fresh) {
          lastIceRefreshAtRef.current = Date.now();
          parsed.iceServers = fresh;
          void SecureStore.setItemAsync(PROVISION_KEY, JSON.stringify(parsed)).catch(() => undefined);
          console.log(`[SIP] iceServers refreshed (${fresh.length} entries)`);
        } else {
          console.warn("[SIP] iceServers refresh failed — using cached set (relay may be stale)");
        }
      }
      clientRef.current.configure(parsed);
      if ("setBlackboxContext" in clientRef.current) {
        clientRef.current.setBlackboxContext?.({
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
    // Assign unconditionally. The old feature-detection guard
    // (`"onCallQualityReport" in client || typeof ... !== "undefined"`) was
    // always FALSE: these are bare optional class fields with no initializer,
    // so the bundler strips them and the property does not exist at runtime
    // until assigned — the guard itself prevented the assignment. Result:
    // NO Android call-quality report was ever submitted (verified 2026-07-28:
    // zero platform=ANDROID CALL_QUALITY_REPORT rows in VoiceDiagEvent).
    // Assignment is safe on any client version — an older client that never
    // calls the callback simply ignores it.
    client.onCallQualityReport = (report: Record<string, unknown>) => {
      if (!authToken) return;
      postCallQualityReport(authToken, report).catch(() => {
        // Non-fatal — telemetry loss acceptable
      });
    };
    client.onCallQualityPing = (snapshot: Record<string, unknown>) => {
      if (!authToken) return;
      if (snapshot._clear) {
        clearCallQualityPing(authToken).catch(() => {});
      } else {
        postCallQualityPing(authToken, snapshot).catch(() => {});
      }
    };
    client.onWebrtcCallDebug = (payload: Record<string, unknown>) => {
      if (!authToken) return;
      postWebrtcCallDebug(authToken, payload).catch(() => {});
    };
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

  // When no call is live, call-control routes back to the primary client.
  useEffect(() => {
    if (callState === "idle") callClientRef.current = clientRef.current;
  }, [callState]);

  /**
   * Event wiring for a secondary-account ("second line") client. Drives the
   * SAME call-state UI as the primary client, with two deliberate omissions:
   *   • onRegistrationState — the header/registration UI always shows the
   *     PRIMARY line's state; a second line registering must not repaint it.
   *   • The wake/keep-alive orchestration — secondary lines have none.
   */
  const buildSecondaryClientEvents = useCallback((accountId: string) => ({
    onCallState: (state: CallState) => {
      if (state === "connected") {
        callInfoRef.current.answered = true;
      }
      setCallState(state);
    },
    onIncomingCall: (callerNumber: string, callerName?: string | null) => {
      // Foreground-only inbound on a second line: route answer/hangup at this
      // client and present the normal incoming UI.
      const party = callerNumber || "Unknown";
      const acctClient = getSecondarySipClient(accountId);
      if (acctClient) callClientRef.current = acctClient;
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
    onError: (msg: string) => {
      setLastError(msg);
      setCallFlowLastError(msg);
    },
    onOutboundTrace: (event: OutboundTraceEvent) => {
      flightRecord("SIP", event.stage, {
        severity: event.stage === "OUTBOUND_FAILED" ? "error" : "info",
        payload: {
          dialedNumber: event.dialedNumber ?? null,
          normalizedNumber: event.normalizedNumber ?? null,
          sipCode: event.sipCode ?? null,
          sipReason: event.sipReason ?? null,
          sipCause: event.sipCause ?? null,
          secondLineAccountId: accountId,
        },
      });
    },
    onSessionAdded: (info: SipSessionInfo) => {
      try { multiCallListenerRef.current?.onSessionAdded?.(info); } catch { /* ignore */ }
    },
    onSessionStateChanged: (info: SipSessionInfo) => {
      try { multiCallListenerRef.current?.onSessionStateChanged?.(info); } catch { /* ignore */ }
    },
    onSessionRemoved: (id: string) => {
      try { multiCallListenerRef.current?.onSessionRemoved?.(id); } catch { /* ignore */ }
    },
  }), []);

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

    // Probe is ASYNC — the sync getAudioDevices() blocks the JS thread for
    // the whole AudioManager.getDevices round-trip (observed: seconds on
    // Samsung with BT/Telecom busy), and this poll ran it every 1.5s during
    // calls — the root cause of laggy taps / 2s speaker toggles (2026-07-28).
    let probeInFlight = false;
    const probe = async () => {
      if (cancelled || probeInFlight) return;
      probeInFlight = true;
      try {
        const result =
          typeof mod.getAudioDevicesAsync === "function"
            ? await mod.getAudioDevicesAsync()
            : mod.getAudioDevices();
        if (cancelled) return;
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
        // Continuous drift guard: compare the ACTUAL native output device
        // (communicationDevice — truthful under Telecom) against the chosen
        // route and re-apply on mismatch. Fixes "call fell back to earpiece
        // though the UI shows Speaker" without any user action.
        void audioRouteManager.verifyAndEnforce("probe");
      } catch (e) {
        // Swallow — watcher is best-effort; SIP call is not affected.
      } finally {
        probeInFlight = false;
      }
    };

    void probe();
    const interval = setInterval(() => { void probe(); }, 1500);

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

  // ── Speaker loudness boost (2026-07-28) ─────────────────────────────────
  // Samsung caps the in-call VOICE_CALL stream ceiling well below the stock
  // dialer's speakerphone loudness. While the user is on speaker apply a
  // software receive gain on the remote audio track; earpiece/BT stay at
  // 1.0 (natural level, AEC unstressed). Re-applies on route or call change.
  // Speakerphone loudness. The old plain 2.0x sample multiplication CLIPPED
  // loud peaks — that was the "scratchy" speakerphone (Izzy 2026-07-29).
  // Now: a mild 1.4x software gain (below the clipping zone) as the floor,
  // PLUS Android's native LoudnessEnhancer (+5 dB with limiter — louder
  // WITHOUT distortion) on devices that honor global-mix audio effects.
  // Logcat tag: [SPEAKER_BOOST] shows which layers are active.
  // 2026-07-29 tuning round 2 (Izzy: "louder than the speaker can handle,
  // staticky"): the raw 1.4x pre-boost pushed the driver into strain. Ease the
  // raw multiplier down; the limiter-protected native gain carries the
  // loudness. Native side also adds a gentle bass lift (strength 150).
  // Round 4: limiter-only loudness on BOTH built-in routes (Izzy: "make it
  // louder again, earpiece too, keep it from scratching"). The limiter caps
  // peaks so higher drive stays clean; earpiece gets a gentler push (tiny
  // driver). Bluetooth/wired stay untouched (their own hardware volume).
  // Native side also shapes voice: bass 80 + presence lift (+2 dB @ ~2.5 kHz)
  // so the caller sounds close to the mic, not across the room.
  // Round 5 (emergency): earpiece boost SUSPENDED — it shipped in the same
  // build as a mic-dead-on-incoming report and never had a supervised
  // incoming test. Speaker keeps the proven limiter+bass chain.
  const SPEAKER_NATIVE_GAIN_MB = 900;
  const EARPIECE_NATIVE_GAIN_MB = 0;
  useEffect(() => {
    const nativeMod: any = (NativeModules as any)?.IncomingCallUi;
    const setNative = (gainMb: number) =>
      nativeMod?.setSpeakerLoudnessBoost?.(gainMb)?.catch?.(() => undefined);
    if (callState !== "connected") {
      void setNative(0);
      return;
    }
    const client: any = callClientRef.current ?? clientRef.current;
    const setSoft = (g: number) => {
      if (typeof client?.setReceiveVolume === "function") client.setReceiveVolume(g);
    };
    setSoft(1.0); // raw multiplication stays OFF — it was the scratch source
    const gain =
      audioRoute === "speaker" ? SPEAKER_NATIVE_GAIN_MB :
      audioRoute === "earpiece" ? EARPIECE_NATIVE_GAIN_MB :
      0;
    void (async () => {
      try {
        const ok = gain > 0 ? await nativeMod?.setSpeakerLoudnessBoost?.(gain) : await setNative(0);
        console.log(`[SPEAKER_BOOST] route=${audioRoute} native=${gain > 0 && ok ? `${gain}mB` : gain > 0 ? "unavailable" : "off"}`);
      } catch {
        console.log(`[SPEAKER_BOOST] route=${audioRoute} native=failed`);
      }
    })();
  }, [audioRoute, callState]);

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
    // Don't tear down a registration that is already healthy. A transient
    // socket blip during call teardown (e.g. the WSS momentarily flapping while
    // BYE traffic + audio-focus changes settle right after a hangup) can fire
    // onSocketDisconnected and schedule a reconnect; but by the time this runs
    // JsSIP's own fast recovery has often already restored the socket. Doing a
    // forceRestart here would then tear down a perfectly good UA and mint a new
    // rotated Contact, kicking off the exact backoff storm (1+2+4+8+16s ≈ 32s of
    // "not registered") observed after back-to-back inbound calls. If we are
    // already connected AND registered, the reconnect is spurious — clear the
    // attempt counter and skip. This can only ever PREVENT an unnecessary
    // teardown; a genuinely dropped socket still fails both checks and proceeds.
    try {
      const connected = typeof client.isConnected === "function" ? !!client.isConnected() : false;
      const registered = typeof client.isRegistered === "function" ? !!client.isRegistered() : false;
      if (connected && registered) {
        console.log('[SIP_RECONNECT] skip_already_healthy reason=' + reason);
        reconnectAttemptRef.current = 0;
        keepAliveFailureStreakRef.current = 0;
        setRegistrationState("registered");
        return;
      }
    } catch {
      /* health probe threw — fall through and reconnect as before */
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
    // Hydrate from the singleton's ACTUAL state before wiring events. On a
    // wake-push boot the background registrar registers the UA before this
    // context mounts, so the "registered" event has already fired and the UI
    // would sit on "idle" ("Not Registered" header) forever despite a healthy
    // registration — seen live 2026-07-28 right after a call ended.
    try {
      if (clientRef.current.isRegistered()) {
        setRegistrationState("registered");
      }
    } catch { /* leave as-is; events will drive it */ }
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

    // ── Live-call hydration after a UI-tree remount ─────────────────────────
    // A recents-swipe destroys the activity and unmounts this provider while
    // the call lives on in the singleton client. When the user comes back
    // (in-call notification tap), the fresh tree boots with callState=idle —
    // RootNavigator then sees no active call, the ActiveCall screen dismisses
    // to the tabs, and the user has no way back to their own live call
    // (live failure 2026-07-28 08:36). Rebuild the legacy single-call state
    // and replay every live session into CallSessionManager.
    try {
      const liveSessions = clientRef.current
        .listSessions()
        .filter((s) => s.state === "connected" || s.state === "held" || s.isHeld);
      if (liveSessions.length > 0) {
        const primary =
          liveSessions.find((s) => s.state === "connected" && !s.isHeld) ?? liveSessions[0];
        console.log(
          "[SIP_HYDRATE] live call on mount — rehydrating UI",
          JSON.stringify({ sessions: liveSessions.length, primary: primary.sessionId }),
        );
        const party = primary.callerNumber || primary.callerDisplayName || "Unknown";
        callInfoRef.current = {
          direction: primary.direction,
          answered: true,
          startMs: primary.confirmedAtMs ?? Date.now(),
          remoteParty: party,
          remotePartyName: primary.callerDisplayName ?? null,
        };
        setCallDirection(primary.direction);
        setRemoteParty(party);
        setOnHold(primary.isHeld || primary.state === "held");
        setCallState("connected");
        // Replay sessions into CallSessionManager on the next tick — its
        // listener registers in a child effect (which React runs before this
        // parent effect), but the tick makes the ordering airtight.
        setTimeout(() => {
          try {
            for (const info of clientRef.current.listSessions()) {
              multiCallListenerRef.current?.onSessionAdded?.(info);
            }
          } catch (err) {
            console.warn("[SIP_HYDRATE] session replay failed:", err);
          }
        }, 0);
      }
    } catch (err) {
      console.warn("[SIP_HYDRATE] hydration check failed:", err);
    }

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
            // Self-heal the header state: the UA can be registered while the
            // context missed the event (wake-boot race) — never show "Not
            // Registered" against a provably healthy stack.
            if (registrationStateRef.current !== "registered") {
              setRegistrationState("registered");
            }
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
            // A stale SIP socket while backgrounded is the classic symptom of
            // the OS having frozen/killed the process the FGS should have
            // protected. Re-verify (and re-arm) the keep-alive FGS in lockstep
            // so the next reconnect lands in a protected process.
            try { verifyAndArmKeepAliveRef.current?.('keepalive_stale'); } catch { /* ignore */ }
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
    // CRITICAL: do NOT tear down while auth is still LOADING. On a cold
    // wake-boot the runtime starts with authToken=null until SecureStore
    // resolves; firing logout_teardown here would unregister the UA that the
    // wake registrar just brought online (and which is holding the live
    // INVITE) → the SIP fork is abandoned and the caller hears voicemail while
    // the phone still rings. Only a RESOLVED logged-out state (auth loaded,
    // no token) is a real logout.
    if (authLoading) {
      console.log('[SIP_RECONNECT] logout_teardown skipped — auth still loading (cold boot)');
      return;
    }
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
  }, [authToken, authLoading, cancelPendingReconnect]);

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

  // ── Adaptive activation gate ─────────────────────────────────────────────
  // The keep-alive FGS does NOT run on every device. It starts dormant and
  // latches on only after THIS device proves (at runtime) that it fails to
  // deliver / hold registration in the background — see keepAliveGate.ts. A
  // phone whose FCM wake works fine never trips a trigger, so it never shows
  // the persistent notification. `keepAliveNeeded` drives the enable effect;
  // the ref lets event callbacks read/flip it without stale closures.
  const [keepAliveNeeded, setKeepAliveNeeded] = useState<boolean>(false);
  const keepAliveNeededRef = useRef<boolean>(false);
  useEffect(() => { keepAliveNeededRef.current = keepAliveNeeded; }, [keepAliveNeeded]);

  // Load the persisted latch once on mount (survives process death). If this
  // device already proved it needs keep-alive in a prior session, arm immediately.
  useEffect(() => {
    let cancelled = false;
    loadKeepAliveGate()
      .then((s: KeepAliveGateState) => {
        if (cancelled) return;
        if (s.needed && !keepAliveNeededRef.current) {
          console.log('[SIP_KEEPALIVE_GATE] restored latch', JSON.stringify({ reason: s.reason, dropCount: s.dropCount }));
          keepAliveNeededRef.current = true;
          setKeepAliveNeeded(true);
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // Record one confirmed background-delivery failure. Flips the gate on (and
  // persists it) once the threshold is reached, which re-runs the enable effect
  // and starts the FGS. No-op cost once already latched.
  const triggerKeepAliveDrop = useCallback((reason: string) => {
    recordBackgroundDrop(reason)
      .then((s) => {
        if (s.needed && !keepAliveNeededRef.current) {
          console.warn('[SIP_KEEPALIVE_GATE] latched ON', JSON.stringify({ reason, dropCount: s.dropCount }));
          flightRecord("SIP", "KEEPALIVE_GATE_LATCHED", {
            severity: "warn",
            payload: { reason, dropCount: s.dropCount },
          });
          keepAliveNeededRef.current = true;
          setKeepAliveNeeded(true);
        } else {
          console.log('[SIP_KEEPALIVE_GATE] drop recorded', JSON.stringify({ reason, dropCount: s.dropCount, alreadyNeeded: s.needed }));
        }
      })
      .catch(() => undefined);
  }, []);
  const triggerKeepAliveDropRef = useRef(triggerKeepAliveDrop);
  useEffect(() => { triggerKeepAliveDropRef.current = triggerKeepAliveDrop; }, [triggerKeepAliveDrop]);

  // ── H2: FGS watchdog / re-arm state ──────────────────────────────────────
  // Number of re-arms performed in the current unhealthy streak. Reset to 0 the
  // moment we observe a healthy keep-alive so a later drop gets a fresh budget.
  const keepAliveRearmStreakRef = useRef<number>(0);
  // Guards against overlapping verify passes (each schedules its own re-check).
  const keepAliveVerifyInFlightRef = useRef<boolean>(false);

  /**
   * Read the AUTHORITATIVE native keep-alive state and decide whether the
   * foreground service truly armed. If it did not (service never created, or
   * startForeground never landed, or it is not running) we re-arm via the
   * native bridge — up to MAX_REARMS times per unhealthy streak — and report
   * the failure so the backend device dashboard can show it. We NEVER treat a
   * `serviceCreatedAtMs=0` / `isRunning=false` / no-foreground-landed snapshot
   * as healthy.
   */
  const verifyAndArmKeepAlive = useCallback((reason: string) => {
    if (Platform.OS !== "android") return;
    if (!keepAliveWantedRef.current) return; // keep-alive not wanted (logged out)
    if (keepAliveVerifyInFlightRef.current) return;
    const mod: any = (NativeModules as any)?.IncomingCallUi;
    if (!mod || typeof mod.getCallWakeDiagnostics !== "function") return;

    const MAX_REARMS = 3;
    keepAliveVerifyInFlightRef.current = true;
    try {
      const state = getCallWakeNativeState();
      const health = evaluateKeepAliveHealth(state);
      if (health.healthy) {
        if (keepAliveRearmStreakRef.current !== 0) {
          console.log('[SIP_KEEPALIVE_FGS] recovered', JSON.stringify({ reason, process: health.process, rearmCount: health.rearmCount }));
        }
        keepAliveRearmStreakRef.current = 0;
        flightRecord("SIP", "KEEPALIVE_FGS_HEALTHY", {
          payload: { reason, process: health.process, rearmCount: health.rearmCount },
        });
        return;
      }

      console.warn(
        '[SIP_KEEPALIVE_FGS] unhealthy',
        JSON.stringify({
          reason,
          healthReason: health.reason,
          process: health.process,
          streak: keepAliveRearmStreakRef.current,
          isRunning: health.isRunning,
          foregroundLanded: health.foregroundLanded,
          serviceCreated: health.serviceCreated,
        }),
      );
      flightRecord("SIP", "KEEPALIVE_FGS_UNHEALTHY", {
        severity: "error",
        payload: {
          reason,
          healthReason: health.reason,
          process: health.process,
          rearmStreak: keepAliveRearmStreakRef.current,
          lastForegroundResult: state.keepAliveLastForegroundResult,
          lastForegroundErrorClass: state.keepAliveLastForegroundErrorClass,
        },
      });

      if (keepAliveRearmStreakRef.current >= MAX_REARMS) {
        // Out of budget — stop hammering. The FGS genuinely cannot foreground on
        // this device/OS right now (e.g. One UI hard refusal). Stage 1 + FCM
        // wake remain the fallback; the backend now has the unhealthy report.
        console.warn('[SIP_KEEPALIVE_FGS] rearm_budget_exhausted', JSON.stringify({ reason, healthReason: health.reason }));
        return;
      }

      if (typeof mod.restartKeepAlive === "function") {
        keepAliveRearmStreakRef.current += 1;
        const attempt = keepAliveRearmStreakRef.current;
        console.log('[SIP_KEEPALIVE_FGS] rearm', JSON.stringify({ reason, attempt }));
        Promise.resolve(mod.restartKeepAlive())
          .catch(() => undefined)
          .finally(() => {
            // Re-verify after the OS has had time to (re)create + foreground the
            // service. Backoff grows with each attempt so a hostile OEM is not
            // hammered: ~4s, 8s, 12s.
            const delay = 4_000 * attempt;
            setTimeout(() => verifyAndArmKeepAlive(reason + ":rearm" + attempt), delay);
          });
      }
    } catch (e) {
      console.warn('[SIP_KEEPALIVE_FGS] verify_threw:', e);
    } finally {
      keepAliveVerifyInFlightRef.current = false;
    }
  }, []);
  const verifyAndArmKeepAliveRef = useRef(verifyAndArmKeepAlive);
  useEffect(() => { verifyAndArmKeepAliveRef.current = verifyAndArmKeepAlive; }, [verifyAndArmKeepAlive]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const mod: any = (NativeModules as any)?.IncomingCallUi;
    if (!mod || typeof mod.setKeepAliveEnabled !== "function") {
      // Bridge not available (older native build, or iOS). Stage 1 is
      // the best we can do in this build.
      console.warn('[SIP_KEEPALIVE_FGS] bridge_missing — native keep-alive disabled');
      return;
    }
    // Keep-alive arming policy.
    //
    // We arm the FGS PROACTIVELY: as soon as the user is logged in + provisioned,
    // regardless of the adaptive `keepAliveNeeded` latch. Rationale (decided
    // 2026-06-19 after on-device validation): the adaptive gate only latched
    // AFTER one slow background/swiped-away call proved the device drops calls,
    // and that latch is wiped on every (re)install — so on aggressive OEMs
    // (Samsung One UI) the FGS was never running at the moment the task was
    // swiped, the process sat at adj 905 (cached) and was killed on "remove
    // task", and the next call cold-booted (~2s). Arming on launch keeps the
    // process resident from the first call. The persistent notification is the
    // quietest the platform allows (IMPORTANCE_MIN, VISIBILITY_SECRET).
    //
    // `keepAliveNeeded` / the gate plumbing is retained for diagnostics + flight
    // records but no longer gates whether the FGS runs.
    const KEEPALIVE_PROACTIVE = true;
    const want = !!(authToken && hasProvisioning) && (KEEPALIVE_PROACTIVE || keepAliveNeeded);
    if (keepAliveWantedRef.current === want) return;
    keepAliveWantedRef.current = want;
    try {
      console.log('[SIP_KEEPALIVE_FGS]', want ? 'start_requested' : 'stop_requested');
      mod.setKeepAliveEnabled(want);
      if (want) {
        // H2: verify the service actually reached foreground state. Give the OS
        // a few seconds to create + foreground the service, then check the
        // authoritative native snapshot and re-arm if it did not land.
        keepAliveRearmStreakRef.current = 0;
        setTimeout(() => verifyAndArmKeepAliveRef.current('post_enable'), 3_500);
      } else {
        keepAliveRearmStreakRef.current = 0;
      }
    } catch (e) {
      console.warn('[SIP_KEEPALIVE_FGS] bridge_threw:', e);
    }
  }, [authToken, hasProvisioning, keepAliveNeeded]);

  // ── H3: network-regain SIP reconnect (netinfo-free) ──────────────────────
  // Replaces the removed @react-native-community/netinfo trigger with a core-
  // Android ConnectivityManager callback bridged via IncomingCallUiModule
  // (event "Sip.NetworkChanged"). On connectivity regain we fire a debounced
  // reconnect AND re-verify the keep-alive FGS (a network change often
  // coincides with the OS having frozen/thawed our process). No JS dependency
  // is required, so the Hermes "Requiring unknown module 'undefined'" crash
  // that killed the old netinfo path cannot recur.
  const lastNetworkRegainAtRef = useRef<number>(0);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = DeviceEventEmitter.addListener(
      "Sip.NetworkChanged",
      (evt: { available?: boolean; transport?: string }) => {
        const available = !!evt?.available;
        const transport = String(evt?.transport || "");
        console.log('[SIP_NETWORK] change', JSON.stringify({ available, transport }));
        if (!available) return;
        // Debounce rapid Wi-Fi⇄LTE flaps: at most one regain-driven reconnect
        // per 3s. scheduleReconnect itself is single-flight, but this stops a
        // handover storm from queueing many redundant heals.
        const now = Date.now();
        if (now - lastNetworkRegainAtRef.current < 3_000) {
          console.log('[SIP_NETWORK] regain_debounced');
          return;
        }
        lastNetworkRegainAtRef.current = now;
        flightRecord("SIP", "NETWORK_REGAINED", { payload: { transport } });
        // Mid-call Wi-Fi ⇄ LTE/5G handoff (standing-registration flag only):
        // an active call's RTP path just lost its interface. Renegotiate with
        // an ICE restart so media moves to the new network instead of dying.
        // The reconnect orchestrator below intentionally skips mid-call, so
        // without this the call had no recovery path at all. Failures fall
        // through silently to today's behavior.
        if (isStandingRegistrationEnabled()) {
          try {
            const client: any = clientRef.current;
            if (
              typeof client.hasActiveSession === "function" &&
              client.hasActiveSession() &&
              typeof client.tryIceRestart === "function"
            ) {
              const n = client.tryIceRestart('network_changed:' + transport);
              flightRecord("SIP", "ICE_RESTART_ATTEMPTED", { payload: { transport, sessions: n } });
            }
          } catch (e) {
            console.warn('[SIP_ICE_RESTART] network-change hook threw:', String(e));
          }
        }
        scheduleReconnect('network_regained:' + transport);
        verifyAndArmKeepAliveRef.current('network_regained');
      },
    );
    return () => sub.remove();
  }, [scheduleReconnect]);

  // ── H3 instrumentation: app background / foreground transitions ──────────
  // Records a background timestamp (surfaced in logs + flight recorder) and, on
  // return to foreground, re-verifies the keep-alive FGS. The SIP re-register
  // on foreground is handled by the AppState listener in the main boot effect;
  // here we only add the keep-alive re-verification + instrumentation so the
  // two concerns stay independent.
  const lastBackgroundAtRef = useRef<number>(0);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background" || next === "inactive") {
        lastBackgroundAtRef.current = Date.now();
        console.log('[SIP_LIFECYCLE] backgrounded', JSON.stringify({ at: lastBackgroundAtRef.current }));
        flightRecord("SIP", "APP_BACKGROUNDED", { payload: { at: lastBackgroundAtRef.current } });
        // Persist for the adaptive gate so a cold FCM-wake process can reason
        // about how long we were backgrounded before a call arrived.
        void recordBackgroundTimestamp(lastBackgroundAtRef.current);
      } else if (next === "active") {
        const bgMs = lastBackgroundAtRef.current ? Date.now() - lastBackgroundAtRef.current : 0;
        console.log('[SIP_LIFECYCLE] foregrounded', JSON.stringify({ backgroundedForMs: bgMs }));
        flightRecord("SIP", "APP_FOREGROUNDED", { payload: { backgroundedForMs: bgMs } });
        // Re-verify keep-alive on resume — Android may have killed the FGS while
        // we were away, and process-resume is the earliest safe moment to heal.
        verifyAndArmKeepAliveRef.current('app_foregrounded');
      }
    });
    return () => sub.remove();
  }, []);

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
        // Adaptive gate: a real incoming call arrived and our standing
        // registration was NOT alive (we had to (re)register on the wake push).
        // If recovering it took long enough that the caller likely gave up, this
        // device is not delivering calls reliably in the background — latch the
        // keep-alive FGS on. A healthy phone whose wake register lands quickly
        // (well under SLOW_WAKE_MS) does not trip this.
        const wakeTotalMs = completedAt - t0;
        if (!sipStackHealthy && wakeTotalMs > SLOW_WAKE_MS) {
          triggerKeepAliveDropRef.current('wake_register_slow:' + wakeTotalMs + 'ms');
        }
        // Cold FCM wake spawns a fresh main process; confirm the keep-alive FGS
        // re-armed in it so the registration we just refreshed stays protected.
        try { verifyAndArmKeepAliveRef.current?.('fcm_wake'); } catch { /* ignore */ }
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
        // Adaptive gate: an incoming-call wake could not re-register at all —
        // the clearest possible proof this device drops calls in the background.
        // Latch the keep-alive FGS on so the next background spell is protected.
        triggerKeepAliveDropRef.current('wake_register_failed');
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
    // First-run is owned by useBatteryOptimizationPrompt (a clean one-time
    // setup popup). Defer to it until it has run — only take over the recurring
    // "still optimized" reminder afterwards, so the two never double-prompt.
    const onboardPrompted = await AsyncStorage.getItem(BATTERY_OPT_ONBOARD_PROMPTED_KEY).catch(() => null);
    if (!onboardPrompted) return;
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
  // Answer-time Telecom anchor id (standing-registration flag only). Non-null
  // while the OS holds an ACTIVE self-managed Connection for the current call
  // — that Connection is what keeps the process alive across a recents-swipe.
  const telecomAnchorIdRef = useRef<string | null>(null);
  // COWORK iOS fix (2026-07-15): reactive twin of callConnectedAtRef for the
  // UI layer. On a cold-answer re-delivery the call bridges on a re-INVITE'd
  // session whose id differs from the one the multi-call session map tracks,
  // so that session never flips to "active" and `answeredAt` stays null —
  // the in-call timer sticks at 0:00 and the ongoing-call banner has nothing
  // to show. This state is an authoritative SIP-level fallback for display.
  // iOS-ONLY by explicit owner directive (2026-07-15): on Android this effect
  // returns immediately and the value stays null forever. Display-only;
  // provably isolated from the answer/register path.
  const [iosCallConnectedAt, setIosCallConnectedAt] = useState<number | null>(null);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (callState === "connected") {
      setIosCallConnectedAt((cur) => cur ?? Date.now());
    } else if (callState === "ended" || callState === "idle") {
      setIosCallConnectedAt((cur) => (cur == null ? cur : null));
    }
  }, [callState]);
  useEffect(() => {
    const prev = prevCallStateRef.current;
    prevCallStateRef.current = callState;
    // ── OUTBOUND: dispatch the Telecom anchor at DIAL time ──────────────────
    // Root fix for the audio-route "jumping" at connect (Izzy 2026-07-29,
    // proven by live-call capture): the anchor used to be created seconds
    // AFTER audio was already flowing. The app's pre-anchor code had set up
    // Bluetooth via AudioManager; when the late anchor activated, Telecom
    // tore that link down and rebuilt it as its own — an audible
    // earpiece-dip + Bluetooth cycle mid-call. Creating the anchor while the
    // call is still dialing gives Telecom sole ownership of routing BEFORE
    // any audio exists: Bluetooth comes up once, during ringback, and the
    // route never changes hands at connect. Outbound + standing-mode only;
    // inbound keeps its proven answer-time anchoring untouched.
    if (
      (callState === "dialing" || callState === "ringing") &&
      callDirection === "outbound" &&
      prev !== "dialing" &&
      prev !== "ringing" &&
      Platform.OS === "android" &&
      isStandingRegistrationEnabled() &&
      !telecomAnchorIdRef.current
    ) {
      const anchorId = `tc-anchor-${Date.now()}`;
      telecomAnchorIdRef.current = anchorId;
      void startTelecomActiveCall({
        inviteId: anchorId,
        callerNumber: "",
        callerName: remoteParty || "On a call",
      }).then((ok) => {
        if (!ok) {
          if (telecomAnchorIdRef.current === anchorId) telecomAnchorIdRef.current = null;
          return; // connected-time block below re-dispatches as fallback
        }
        console.log("[TELECOM] dial-time anchor up — applying desired route early");
        // Route the (not-yet-audible) call audio to the desired sink now, so
        // Bluetooth SCO is negotiated during ringback and the connect moment
        // changes nothing. Conditional/no-op-safe: routeViaTelecom skips when
        // already on the requested route.
        setTimeout(() => audioRouteManager.applyDesiredRouteEarly("dial_time_anchor"), 250);
      });
    }
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
        // Answer-time Telecom anchor (standing-registration flag only).
        // Registers this already-connected call with the OS as an ACTIVE
        // self-managed call so the process survives a recents-swipe for the
        // call's duration. Fire-and-forget: a false/failed dispatch leaves the
        // call exactly as it is today (FGS-only protection). Flag off ⇒ this
        // block is a no-op and nothing about the legacy flow changes.
        if (isStandingRegistrationEnabled() && !telecomAnchorIdRef.current) {
          const anchorId = `tc-anchor-${Date.now()}`;
          telecomAnchorIdRef.current = anchorId;
          void startTelecomActiveCall({
            inviteId: anchorId,
            callerNumber: "",
            callerName: remoteParty || "On a call",
          }).then((ok) => {
            if (!ok && telecomAnchorIdRef.current === anchorId) {
              telecomAnchorIdRef.current = null;
              return;
            }
            // The anchor flips ACTIVE ~250ms-1s after dispatch, at which point
            // Telecom takes over audio routing and asserts ITS default route
            // (earpiece) — stomping a speaker/BT route the user picked during
            // ringback. Re-assert the JS-selected route once the anchor is
            // plausibly ACTIVE; routing now flows through
            // Connection.setAudioRoute so it sticks.
            // Immediate + rapid re-asserts: the anchor stomps a pre-connect
            // speaker choice for the ~600ms gap the old timers left — audible
            // as "speaker dips to earpiece then returns" (Izzy 2026-07-29).
            // 2026-07-29 rework: the old 9-shot re-assert barrage here is GONE.
            // Each blind re-assert re-ran Telecom's pending-route machinery
            // (restarting Bluetooth SCO negotiation on every shot) — the cure
            // WAS the audible on/off/on route "jumping" Izzy reported. The
            // activation stomp is now fixed at the source, natively:
            // routeViaTelecom() no-ops when already on the requested route,
            // and ConnectIncomingConnection applies the app's chosen route
            // the moment the anchor's first ACTIVE audio state arrives.
            // What remains here: one immediate assert (covers the pre-anchor
            // AudioManager window) and two conditional drift checks that only
            // touch routing when actual ≠ desired, after SCO has settled.
            audioRouteManager.reassertRoute("telecom_anchor_dispatch");
            setTimeout(() => void audioRouteManager.verifyAndEnforce("post_anchor_800"), 800);
            setTimeout(() => void audioRouteManager.verifyAndEnforce("post_anchor_2500"), 2500);
          });
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
        // Release the answer-time Telecom anchor (if one was dispatched) so
        // the OS drops the active-call state and process protection with it.
        if (telecomAnchorIdRef.current) {
          const anchorId = telecomAnchorIdRef.current;
          telecomAnchorIdRef.current = null;
          terminateTelecomCall(anchorId, "other");
        }
      }
    }
  }, [callState, remoteParty, speakerOn, muted]);

  // Answer-time Telecom anchor: if the OS disconnects the anchor Connection
  // out from under us (system abort, user hangup from another Telecom surface
  // like Android Auto / a Bluetooth HFP button routed through Telecom), hang
  // up the SIP call so audio doesn't keep flowing behind a dead OS call.
  // Anchor ids are namespaced (tc-anchor-*) and owned exclusively here —
  // NotificationsContext's Telecom handlers ignore them.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = DeviceEventEmitter.addListener(
      "Telecom.Disconnect",
      (p: { inviteId?: string; reason?: string }) => {
        const id = String(p?.inviteId || "");
        if (!id || id !== telecomAnchorIdRef.current) return;
        console.log(`[TELECOM] anchor disconnected by OS (${p?.reason || "unknown"}) — hanging up SIP`);
        telecomAnchorIdRef.current = null;
        clientRef.current.hangup().catch((err) => {
          console.warn("[TELECOM] hangup after anchor disconnect failed:", String(err));
        });
      },
    );
    return () => sub.remove();
  }, []);

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

  // Mirror in-call notification action taps (End / Speaker / Mute) into React
  // state so the in-app UI stays in sync while mounted. The ACTUAL call
  // control (client.hangup/setSpeaker/setMute) is owned by the module-scope
  // listener in sip/inCallNotificationActions.ts — a recents-swipe unmounts
  // this whole tree (and this listener with it) while the call lives on, so
  // anything that must keep working from the notification cannot live here
  // (live failure 2026-07-28: hangup button dead after swipe-away).
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = DeviceEventEmitter.addListener(
      "Sip.InCallNotificationAction",
      (evt: { action?: string; value?: boolean }) => {
        const action = evt?.action;
        const value = evt?.value;
        console.log("[IN_CALL_NOTIF] action received (ui mirror)", { action, value });
        switch (action) {
          case "hangup": {
            console.log("[CONNECT_CALL_UI] local_hangup_cleanup — triggered via notification End button");
            break;
          }
          case "toggle_speaker": {
            const next = typeof value === "boolean" ? value : !speakerOn;
            setSpeakerOn(next);
            setAudioRoute(next ? "speaker" : "earpiece");
            break;
          }
          case "toggle_mute": {
            const next = typeof value === "boolean" ? value : !muted;
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
      callConnectedAt: iosCallConnectedAt,

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

      // Latches the adaptive keep-alive gate when a cold/background call had to
      // be rescued via the backend claim path (no SIP INVITE arrived on a live
      // socket). Uses the ref so this method stays stable across renders and
      // does not need to be a useMemo dependency.
      markBackgroundDeliveryFailure: (reason: string) => {
        try {
          triggerKeepAliveDropRef.current?.(reason);
        } catch {
          /* never let diagnostics latch crash the call path */
        }
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
          console.warn('[DIAL] SUPPRESSED — a dial is already in flight, this tap was dropped');
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
            console.warn('[DIAL] already-in-call prompt shown (activeState=' + activeState + ')');
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

          // ── Optimistic screen presentation ─────────────────────────────────
          // Show the ActiveCall screen ("Dialing…") the INSTANT the user taps,
          // before the mic-permission check, provisioning load, and SIP
          // registration preflight run below. Those steps are quick when warm
          // but each crosses a native bridge (PermissionsAndroid, SecureStore,
          // UA state) and were previously all awaited before the very first
          // callState="dialing" (fired deep inside clientRef.dial), so the
          // call screen only appeared after the whole pipeline finished — the
          // perceptible lag the user reported. Flipping callState here drives
          // RootNavigator's outbound-dial effect immediately. Every failure
          // path below sets callState="ended", which auto-resets to idle and
          // pops the screen back, so an optimistic present is always undone
          // if the call can't actually start.
          //
          // Only present optimistically for the FIRST call (not "Add call",
          // which already has a live call on screen).
          const presentOptimistically = !allowSecond;
          if (presentOptimistically) {
            setCallDirection("outbound");
            setRemoteParty(displayTarget);
            setLastError(null);
            callStateRef.current = "dialing";
            setCallState("dialing");
          }

          const micOk = await ensureMicPermissionOrAlert();
          if (!micOk) {
            console.warn('[DIAL] mic permission denied — call aborted');
            if (presentOptimistically) setCallState("ended");
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

          // These were already set above when presenting optimistically; set
          // them (again) for the "Add call" path, which skips the optimistic
          // present, and record the last-dialed number for both.
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

          // ── Second-line dial (extra SIP account from another tenant) ─────
          // Fully isolated path: registers the secondary client on demand and
          // never touches the primary UA or its registration.
          const secondLineAccountId = options?.accountId || null;
          if (secondLineAccountId) {
            try {
              const token = authTokenRef.current;
              if (!token) throw new Error("Not signed in");
              flightRecord("SIP", "OUTBOUND_SECOND_LINE_START", {
                payload: { accountId: secondLineAccountId, normalizedTarget },
              });
              const secondary = await ensureSecondarySipRegistered(
                secondLineAccountId,
                async () => {
                  const out = await getSipAccountProvisioning(token, secondLineAccountId);
                  return out.provisioning as ProvisioningBundle;
                },
                buildSecondaryClientEvents(secondLineAccountId),
              );
              callClientRef.current = secondary;
              await secondary.dial(normalizedTarget);
              callStateRef.current = "dialing";
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              flightRecord("SIP", "OUTBOUND_FAILED", {
                severity: "error",
                payload: { message: msg, secondLine: true, accountId: secondLineAccountId },
              });
              callClientRef.current = clientRef.current;
              if (presentOptimistically) setCallState("ended");
              await flightEndCall("failed");
              throw e instanceof Error ? e : new Error(msg);
            }
            return;
          }

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
            console.warn('[DIAL] SIP client dial FAILED: ' + msg);
            const diagnosis = classifyOutboundSipFailure({ localReason: msg });
            flightRecord("SIP", "OUTBOUND_FAILED", {
              severity: "error",
              payload: {
                message: msg,
                diagnosisCategory: diagnosis.category,
              },
            });
            // client.dial can throw BEFORE it ever fires onCallState("dialing")
            // (e.g. ensureOutboundSipRegistration times out), so the optimistic
            // "dialing" state above would otherwise leave the screen stranded.
            // Force it to "ended" so the screen pops back to the origin tab.
            if (presentOptimistically) setCallState("ended");
            await flightEndCall("failed");
            throw e instanceof Error ? e : new Error(msg);
          }
        } finally {
          dialInFlightRef.current = false;
        }
      },

      answer: async () => {
        // callClientRef points at the client whose call is live (primary by
        // default; a secondary "second line" client when its call is ringing).
        await callClientRef.current.answer();
      },

      answerIncomingInvite: async (match, timeoutMs = 5000, onTrace, deadlineHandle) => {
        setCallDirection("inbound");
        // iOS DEAD-MIC FIX (2026-07-30, proven on-device: outbound mic fine,
        // CallKit-answered incoming mic silent): release builds answered fast
        // enough that getUserMedia opened the capture unit BEFORE CallKit's
        // didActivateAudioSession handoff, so the mic recorded silence.
        // Wait for the handoff before opening the mic — it lands ~100-300ms
        // after the answer tap, inside the existing answer budget. Fail-open
        // at 1200ms so a missing activation can never block the answer.
        // Foreground in-app answers (app active, no CallKit handoff pending)
        // skip the wait entirely, keeping the proven-instant path untouched.
        if (Platform.OS === "ios" && AppState.currentState !== "active") {
          const t0 = Date.now();
          const seen = await waitForIosAudioSessionActivation(1200);
          console.log(
            "[CALLKEEP_AUDIO] answer gated on audio-session activation: seen=" +
            String(seen) + " waitedMs=" + String(Date.now() - t0),
          );
        }
        return clientRef.current.answerIncoming(match, timeoutMs, onTrace, deadlineHandle);
      },

      beginInboundBlackbox: (inviteId, meta) => {
        clientRef.current.beginInboundBlackbox?.(inviteId, meta);
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

      hasMatchingIncomingInvite: (match) => {
        try {
          return clientRef.current.hasMatchingIncomingInvite(match) === true;
        } catch {
          return false;
        }
      },

      rejectIncomingInvite: async (match) => {
        return clientRef.current.rejectIncoming(match);
      },

      prewarmInboundMedia: () => {
        const client = clientRef.current as { prewarmInboundMedia?: () => void };
        client.prewarmInboundMedia?.();
      },

      releasePrewarmedMedia: (reason: string) => {
        const client = clientRef.current as { releasePrewarmedMedia?: (r: string) => void };
        client.releasePrewarmedMedia?.(reason);
      },

      hangup: async () => {
        await callClientRef.current.hangup();
      },

      toggleMute: () => {
        const next = !muted;
        callClientRef.current.setMute(next);
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
          callClientRef.current.unhold();
          setOnHold(false);
        } else {
          callClientRef.current.hold();
          setOnHold(true);
        }
      },

      sendDtmf: (digit) => {
        callClientRef.current.sendDtmf(digit);
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
      // Session-level ops search the primary client first, then any live
      // second-line clients — session ids are unique across UAs.
      listSipSessions: () => [
        ...clientRef.current.listSessions(),
        ...listSecondarySipClients().flatMap((c) => { try { return c.listSessions(); } catch { return []; } }),
      ],
      holdSipSession: (id) =>
        clientRef.current.holdSession(id) ||
        listSecondarySipClients().some((c) => { try { return c.holdSession(id); } catch { return false; } }),
      unholdSipSession: (id) =>
        clientRef.current.unholdSession(id) ||
        listSecondarySipClients().some((c) => { try { return c.unholdSession(id); } catch { return false; } }),
      hangupSipSession: (id) =>
        clientRef.current.hangupSession(id) ||
        listSecondarySipClients().some((c) => { try { return c.hangupSession(id); } catch { return false; } }),
      isSipSessionAlive: (id) =>
        clientRef.current.isSessionAlive(id) ||
        listSecondarySipClients().some((c) => { try { return c.isSessionAlive(id); } catch { return false; } }),
      transferSipSession: (id, target) =>
        clientRef.current.transferSession(id, target) ||
        listSecondarySipClients().some((c) => { try { return c.transferSession(id, target); } catch { return false; } }),
      answerSipSession: async (id, timeoutMs, onTrace) => {
        // If a second-line client currently owns this session, answer there;
        // otherwise delegate to the primary client with its original
        // wait-for-INVITE semantics untouched.
        for (const c of listSecondarySipClients()) {
          try {
            if (c.isSessionAlive(id)) {
              const ok = await c.answerSession(id, timeoutMs, onTrace);
              if (ok) callClientRef.current = c;
              return ok;
            }
          } catch { /* try next client */ }
        }
        return clientRef.current.answerSession(id, timeoutMs, onTrace);
      },
      setActiveSipSession: (id) =>
        clientRef.current.setActiveSession(id) ||
        listSecondarySipClients().some((c) => { try { return c.setActiveSession(id); } catch { return false; } }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registrationState, callState, callDirection, remoteParty, muted, speakerOn, onHold, hasProvisioning, lastError, lastDialed, audioRoute, iosCallConnectedAt, ensureProvisioningLoaded],
  );

  return <SipContext.Provider value={value}>{children}</SipContext.Provider>;
}

export function useSip() {
  const ctx = useContext(SipContext);
  if (!ctx) throw new Error("useSip must be used within SipProvider");
  return ctx;
}
