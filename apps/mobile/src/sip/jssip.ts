import type {
  SipAnswerTraceEvent,
  SipClient,
  SipEvents,
  SipMatch,
  SipSessionInfo,
  SipSessionState,
} from "./types";
import type { ProvisioningBundle } from "../types";
import { registerGlobals as registerWebRTCGlobals } from "react-native-webrtc";
import { Platform } from "react-native";
import JsSIP from "jssip";
import {
  startRingback,
  startRingtone,
  stopAllTelephonyAudio,
  initAudioSession,
  restoreAudioSession,
} from "../audio/telephonyAudio";
import {
  markCallLatency,
  linkCallLatencyIds,
} from "../debug/callLatency";

// Voice-optimised audio constraints — same profile as the browser softphone.
const VOICE_AUDIO_CONSTRAINTS = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: { ideal: 48_000 },
  } as MediaTrackConstraints,
  video: false,
};

/** Best-effort InCallManager helper — silently no-ops if the native module is absent. */
const ICM = {
  start(media: "audio" | "video" = "audio") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("react-native-incall-manager").default;
      // ringback: '' — we supply our own tones.
      // Do NOT pass auto:true — it auto-routes to speakerphone on Android.
      m.start({ media, ringback: "" });
    } catch { /* module not linked */ }
  },
  stop() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("react-native-incall-manager").default;
      m.stop();
    } catch { /* module not linked */ }
  },
  setSpeaker(on: boolean) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("react-native-incall-manager").default;
      m.setSpeakerphoneOn(on);
      // When speaker=false: Android routes to Bluetooth headset if one is
      // connected, otherwise earpiece — this is the expected behaviour.
    } catch { /* module not linked */ }
  },
  /** Explicitly route audio to a Bluetooth headset (Android only). */
  routeToBluetooth() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("react-native-incall-manager").default;
      if (typeof m.chooseAudioRoute === "function") {
        m.chooseAudioRoute("BLUETOOTH");
      }
    } catch { /* ignore */ }
  },
  /** Explicitly route audio to earpiece. */
  routeToEarpiece() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("react-native-incall-manager").default;
      if (typeof m.chooseAudioRoute === "function") {
        m.chooseAudioRoute("EARPIECE");
      } else {
        m.setSpeakerphoneOn(false);
      }
    } catch { /* ignore */ }
  },
};

export class JsSipClient implements SipClient {
  private events: SipEvents = {};
  private bundle: ProvisioningBundle | null = null;
  private ua: any = null;
  private session: any = null;
  private incomingSessions: any[] = [];
  /**
   * Multi-call session registry. Authoritative list of every JsSIP session
   * this client currently owns — ringing, dialing, connecting, connected, and
   * held. `this.session` remains a pointer to the "active" session for legacy
   * single-call callers (hold/hangup/setMute).
   *
   * Key = JsSIP `session.id` (string assigned at `newRTCSession`).
   */
  private sessionsById: Map<string, any> = new Map();
  /** Per-session tracked state, surfaced to the multi-call manager. */
  private sessionStates: Map<string, SipSessionState> = new Map();
  /** Per-session held flag (tracks last successful `hold()` / `unhold()`). */
  private heldSessions: Set<string> = new Set();
  /**
   * Maximum concurrent sessions per client. A 6th INVITE at the limit is
   * rejected locally with 486 Busy so the PBX routes to voicemail / next agent.
   * This matches legacy business phones (Cisco 7970, Polycom VVX).
   */
  private static readonly MAX_CONCURRENT_SESSIONS = 5;
  private registerPromise: Promise<void> | null = null;
  private callStartedAt: number | null = null;
  private callDirection: "outbound" | "inbound" = "outbound";
  private livePingInterval: ReturnType<typeof setInterval> | null = null;
  /** Timestamp when the session's `confirmed` event fired — used by ghost-dialog detection. */
  private sessionConfirmedAt: WeakMap<any, number> = new WeakMap();
  /**
   * Timestamp when we invoked session.answer() on the session — used by ghost-dialog
   * detection for the "answered-then-canceled-before-confirm" pattern (VitalPBX
   * often cancels the first INVITE right after we send 200 OK and before it
   * acknowledges it, then re-INVITEs with the bridged call).
   */
  private answerInvokedAt: WeakMap<any, number> = new WeakMap();
  /** Sessions that were identified as ghost-confirmed (PBX cancelled dialog) — they must not emit state transitions. */
  private ghostSessions: WeakSet<any> = new WeakSet();
  /**
   * Sessions the user explicitly terminated via `hangup()`. Tracked so the
   * subsequent `ended`/`failed` event never trips ghost-detection (a short,
   * intentional hangup must not trigger a ghost-retry poll that could later
   * auto-answer an unrelated future call).
   */
  private userTerminatedSessions: WeakSet<any> = new WeakSet();
  /**
   * Sessions we've already attempted to answer for the current user Answer action.
   * Cleared after the call fully ends. Prevents repeat-answering a failed dialog.
   */
  private answerAttemptedSessions: WeakSet<any> = new WeakSet();
  /** Last SipMatch passed to answerIncoming — used by the ghost auto-retry path. */
  private lastAnswerMatch: SipMatch | undefined;
  /** Callback(s) fired when a ghost session auto-retries onto a new session. */
  private ghostRetryCallbacks: Array<(result: "confirmed" | "failed") => void> = [];
  /** Callback for submitting quality reports — injected by the context layer. */
  onCallQualityReport?: (report: Record<string, unknown>) => void;
  /** Callback for sending live mid-call pings — injected by the context layer. */
  onCallQualityPing?: (snapshot: Record<string, unknown>) => void;

  configure(bundle: ProvisioningBundle) {
    this.bundle = bundle;
  }

  setEvents(events: SipEvents) {
    this.events = events;
  }

  async register(options?: { forceRestart?: boolean }) {
    if (!this.bundle) throw new Error("Missing provisioning bundle");
    const forceRestart = options?.forceRestart === true;

    if (this.registerPromise) {
      return this.registerPromise;
    }

    // Never tear down the UA when an incoming SIP INVITE is in progress.
    // A force-restart would stop the UA and reject the pending INVITE.
    // This guard fires regardless of forceRestart — the AppState "active"
    // listener in SipContext triggers forceRestart when the user answers from
    // the lock screen (bringing the app to foreground), which would otherwise
    // kill the INVITE that just arrived.
    if (this.ua && this.incomingSessions.length > 0) {
      console.log('[SIP] Skipping re-register — active incoming session protects UA' + (forceRestart ? ' (force-restart suppressed)' : ''));
      return;
    }

    // If the UA is already registered and connected, skip the expensive
    // stop/restart cycle. A UA that is registered responds correctly to
    // incoming INVITEs without needing a fresh connection.
    if (!forceRestart && this.ua && this.ua.isRegistered?.()) {
      console.log('[SIP] Already registered, skipping re-register');
      return;
    }

    if (forceRestart) {
      console.log('[SIP] Force re-register requested');
    }

    // Tear down any existing UA before creating a new one. Tag the old
    // UA as "replaced" so any late-firing `disconnected` / `unregistered`
    // events coming out of JsSIP's async WebSocket close don't trigger
    // the reconnect orchestrator — the new UA below is the replacement.
    if (this.ua) {
      try {
        (this.ua as any).__jsSipClientReplaced = true;
        this.ua.stop();
      } catch { /* ignore */ }
      this.ua = null;
    }

    this.events.onRegistrationState?.("registering");
    console.log('[SIP] Registering to', this.bundle.sipDomain, 'via', this.bundle.sipWsUrl);

    // Register WebRTC globals (static import — avoids Metro bundler hoisting issues)
    try {
      registerWebRTCGlobals();
      console.log('[SIP] WebRTC globals registered OK');
    } catch (e) {
      console.warn('[SIP] WebRTC registerGlobals() failed:', e);
    }

    const socket = new (JsSIP as any).WebSocketInterface(this.bundle.sipWsUrl);

    const iceServers = this.bundle.iceServers?.length
      ? this.bundle.iceServers
      : [{ urls: "stun:stun.l.google.com:19302" }];

    // authUsername = the PJSIP auth object name (e.g. "T2_103_1" in VitalPBX 4).
    // This goes into the SIP Authorization header and MUST match what the PBX expects.
    // It is often different from the SIP URI user (extension number).
    const authUsername = this.bundle.authUsername || this.bundle.sipUsername;
    console.log('[SIP] URI user:', this.bundle.sipUsername, '| Auth user:', authUsername);

    const uaConfig: Record<string, unknown> = {
      sockets: [socket],
      uri: `sip:${this.bundle.sipUsername}@${this.bundle.sipDomain}`,
      authorization_user: authUsername,
      password: this.bundle.sipPassword,
      register: true,
      session_timers: false,
      pcConfig: {
        iceServers,
        iceTransportPolicy: "all",
      },
    };

    if (this.bundle.outboundProxy) {
      uaConfig.outbound_proxy_set = this.bundle.outboundProxy;
    }

    this.ua = new (JsSIP as any).UA(uaConfig);

    this.registerPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (cb: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        this.registerPromise = null;
        cb();
      };
      const timeoutId = setTimeout(() => {
        const msg = "SIP registration timed out";
        console.warn("[SIP] Registration timeout");
        settle(() => reject(new Error(msg)));
      }, 20_000);

      this.ua.on("registered", () => {
        console.log('[SIP] Registered successfully');
        this.events.onRegistrationState?.("registered");
        settle(() => resolve());
      });

      this.ua.on("registrationFailed", (e: any) => {
        const code = e?.response?.status_code;
        const cause = e?.cause || "unknown";
        const msg = code ? `SIP reg failed (${code}): ${cause}` : `SIP reg failed: ${cause}`;
        console.warn('[SIP] Registration failed:', msg);
        this.events.onRegistrationState?.("failed");
        this.events.onError?.(msg);
        settle(() => reject(new Error(msg)));
      });
    });

    this.ua.on("newRTCSession", (e: any) => {
      // ---- multi-call: enforce the per-user concurrent session limit ---------
      // Reject with 486 Busy BEFORE registering the session. This keeps the UI
      // scannable and matches legacy desk-phone norms (1 active + 4 held). The
      // user's existing calls are untouched.
      if (
        e.originator === "remote" &&
        this.sessionsById.size >= JsSipClient.MAX_CONCURRENT_SESSIONS
      ) {
        console.warn(
          "[MULTICALL] max_concurrent_sessions_reached current=" +
            this.sessionsById.size +
            " — rejecting new INVITE with 486 Busy"
        );
        try {
          e.session?.terminate?.({ status_code: 486, reason_phrase: "Busy Here" });
        } catch (err) {
          console.warn("[MULTICALL] failed to send 486 on overflow INVITE:", err);
        }
        return;
      }

      this.session = e.session;
      console.log('[SIP] New RTC session, originator:', e.originator);

      const sipSessionId: string = String(e.session?.id || `local-${Date.now()}`);
      (e.session as any)._multicallId = sipSessionId;
      this.sessionsById.set(sipSessionId, e.session);

      if (e.originator === "remote") {
        this.callDirection = "inbound";
        const callerNumber = this.getSessionFrom(e.session);
        const toUser = this.getSessionTo(e.session);
        const inviteArrivedAt = Date.now();
        (e.session as any)._inviteArrivedAt = inviteArrivedAt;
        console.log('[SIP] Incoming SIP INVITE —', JSON.stringify({
          from: callerNumber, to: toUser,
          incomingSessionsBefore: this.incomingSessions.length,
          sessionsById: this.sessionsById.size,
          ts: inviteArrivedAt,
        }));
        this.incomingSessions.push(e.session);
        // JsSIP automatically sends 100 Trying + 180 Ringing after newRTCSession fires.
        // No manual call needed — the PBX will see 180 Ringing within milliseconds.

        this.setSessionState(e.session, "ringing");
        this.events.onIncomingCall?.(callerNumber);
        this.events.onCallState?.("ringing");
        this.emitSessionAdded(e.session);
        // Android inbound ringing is owned by the native incoming-call service.
        // Starting JS ringtone here causes late or duplicate ringing once the app opens.
        if (Platform.OS !== "android") {
          initAudioSession().then(() => startRingtone()).catch(() => undefined);
        } else {
          console.log("[SIP] Android inbound INVITE received — leaving ringtone to native incoming-call flow");
        }
      } else {
        // Outbound — dialing state will be set via `progress` handler shortly.
        this.setSessionState(e.session, "dialing");
        this.emitSessionAdded(e.session);
      }
      this.bindSession(this.session);
    });

    // ── Stage 1: transport-level events ───────────────────────────────────
    // JsSIP emits `connecting` / `connected` / `disconnected` at the
    // WebSocket transport layer and `registered` / `unregistered` /
    // `registrationFailed` at the SIP layer. We surface both so the
    // reconnect orchestrator in SipContext can drive state transitions
    // without inspecting JsSIP internals.
    this.ua.on("connecting", () => {
      console.log('[SIP_SOCKET] UA connecting');
    });
    this.ua.on("connected", () => {
      console.log('[SIP_SOCKET] UA connected');
      try { this.events.onSocketConnected?.(); } catch (err) {
        console.warn('[SIP_SOCKET] onSocketConnected threw:', err);
      }
    });
    // Capture the UA created in THIS register() call. The handlers below
    // only fire reconnect signals when they are attached to the UA that
    // `this.ua` still points at — if the UA has been replaced (another
    // register({forceRestart}) ran, or unregister()) these event closures
    // keep firing against the old instance but we want them to be inert.
    const thisUa = this.ua;
    const isCurrentUa = () => this.ua === thisUa && !(thisUa as any).__jsSipClientReplaced;
    this.ua.on("disconnected", (e: any) => {
      const code = e?.code;
      const reason = e?.reason || e?.cause || "unknown";
      const current = isCurrentUa();
      console.warn(
        '[SIP_SOCKET] UA disconnected',
        JSON.stringify({ code: code ?? null, reason, current }),
      );
      // Suppress if this event is coming from a UA we already replaced
      // (async WebSocket close fires after ua.stop()) — the caller has
      // already moved on.
      if (!current) return;
      try {
        this.events.onRegistrationState?.("disconnected");
        this.events.onSocketDisconnected?.(String(reason));
      } catch (err) {
        console.warn('[SIP_SOCKET] onSocketDisconnected threw:', err);
      }
    });
    this.ua.on("unregistered", (e: any) => {
      const code = e?.response?.status_code;
      const cause = e?.cause || "unknown";
      const current = isCurrentUa();
      console.warn(
        '[SIP_REGISTER] unregistered',
        JSON.stringify({ code: code ?? null, cause, current }),
      );
      if (current) {
        this.events.onRegistrationState?.("disconnected");
      }
    });

    this.ua.start();
    console.log('[SIP] UA started');
    return this.registerPromise;
  }

  // ── Stage 1 health probes ───────────────────────────────────────────────
  // Sync reads used by the SipContext keep-alive timer. Guarded against
  // every failure mode of the JsSIP internals we poke at — these helpers
  // must never throw; callers rely on them for the reconnect decision.
  isConnected(): boolean {
    try {
      const transport = (this.ua as any)?._transport;
      if (!transport) return false;
      if (typeof transport.isConnected === "function") {
        return !!transport.isConnected();
      }
      // Fallback for JsSIP builds without the public accessor.
      return transport.status === 1; /* WebSocketInterface.STATUS_READY */
    } catch {
      return false;
    }
  }

  isRegistered(): boolean {
    try {
      return !!this.ua && this.ua.isRegistered?.() === true;
    } catch {
      return false;
    }
  }

  hasActiveSession(): boolean {
    try {
      if (this.incomingSessions.length > 0) return true;
      if (this.sessionsById.size > 0) return true;
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Window after `confirmed` during which an `ended`/`failed` is treated as a
   * "ghost" — i.e. PBX ACKed our 200 OK and then immediately BYE'd because the
   * dialog was already cancelled by the parallel claim re-INVITE. When this
   * happens we silently auto-retry on the newer answerable session so the
   * user's UI never sees the transient connected→ended flash.
   */
  private static readonly GHOST_WINDOW_MS = 2000;

  private bindSession(session: any) {
    session.on("progress", (e: any) => {
      const code = e?.response?.status_code;
      console.log('[CALL_EVENT] progress status=' + code);
      // Inbound sessions stay "ringing"; outbound sessions transition from
      // "dialing" to "ringing" once the remote side is alerting (180).
      if (this.callDirection === "outbound") {
        this.setSessionState(session, "ringing");
      }
      this.events.onCallState?.("ringing");
    });

    session.on("confirmed", () => {
      console.log('[CALL_EVENT] session_confirmed');
      this.sessionConfirmedAt.set(session, Date.now());
      if (this.ghostSessions.has(session)) {
        console.warn('[CALL_EVENT] session_confirmed ignored — marked as ghost');
        return;
      }
      stopAllTelephonyAudio().catch(() => undefined);
      ICM.start("audio");
      setTimeout(() => ICM.routeToEarpiece(), 150);
      if (!this.callStartedAt) this.callStartedAt = Date.now();
      this.setSessionState(session, "connected");
      this.events.onCallState?.("connected");
      this.startLivePing(session);
      // Any ghost-retry waiter is now satisfied.
      this.flushGhostRetryCallbacks("confirmed");
    });

    // Hold / unhold tracking — JsSIP emits these when the peer (or us) sends
    // a re-INVITE with sendonly / sendrecv. We update per-session state so the
    // multi-call manager can visually reflect it and resume via `unholdSession`.
    session.on("hold", (e: any) => {
      const originator = e?.originator || "local";
      console.log("[MULTICALL_HOLD] session_hold_event originator=" + originator);
      this.markHeld(session, true);
    });
    session.on("unhold", (e: any) => {
      const originator = e?.originator || "local";
      console.log("[MULTICALL_RESUME] session_unhold_event originator=" + originator);
      this.markHeld(session, false);
    });

    session.on("ended", (e: any) => {
      const cause = e?.cause || "normal";
      console.log('[CALL_EVENT] session_ended cause=' + cause);
      this.incomingSessions = this.incomingSessions.filter((x) => x !== session);
      const becameGhost = this.handleGhostOrEnded(session);
      if (becameGhost) {
        console.warn('[CALL_STATE] suppressing_ended — ghost-confirm detected, auto-retrying on newer session');
        return;
      }
      // Multi-call aware cleanup: only run the global/audio teardown when
      // THIS was the last live SIP dialog. If other sessions (active /
      // held) are still alive, wiping audio routing + firing a global
      // onCallState("ended") would cut audio for the survivors and flash
      // the ActiveCallScreen into a "Call Ended" state even though the
      // user still has calls in flight.
      //
      // IMPORTANT: sessionsById can hold zombie entries from the
      // `answer_then_cancel` ghost-retry path — the aborted original
      // session sometimes lingers (status=8/TERMINATED) until the next
      // sweep. A naive `size - 1` count then reports phantom siblings
      // and we'd skip teardown, stranding the ActiveCallScreen + audio
      // even though the only real call just ended. Count only dialogs
      // that are still genuinely alive.
      const liveSiblings = this.countLiveSiblingSessions(session);
      const isLastLiveSession = liveSiblings === 0;
      console.log(
        "[MULTICALL] session_ended_cleanup id=" + this.getSessionIdSafe(session) +
          " siblingsRemaining=" + liveSiblings +
          " rawMapSize=" + this.sessionsById.size +
          " last=" + isLastLiveSession,
      );
      if (isLastLiveSession) {
        stopAllTelephonyAudio().catch(() => undefined);
        this.stopLivePing();
        ICM.stop();
        restoreAudioSession().catch(() => undefined);
      }
      this.collectAndSubmitQualityReport(cause).catch(() => {});
      if (this.session === session) this.session = null;
      if (this.incomingSessions.length === 0) this.lastAnswerMatch = undefined;
      this.setSessionState(session, "ended");
      this.removeSession(session);
      if (isLastLiveSession) {
        this.events.onCallState?.("ended");
      }
      this.flushGhostRetryCallbacks("failed");
    });

    session.on("failed", (e: any) => {
      const cause = e?.cause || "unknown";
      const code = e?.response?.status_code;
      const msg = code ? `Call failed (${code}): ${cause}` : `Call failed: ${cause}`;
      console.warn('[CALL_EVENT] session_failed', msg);
      this.incomingSessions = this.incomingSessions.filter((x) => x !== session);
      const becameGhost = this.handleGhostOrEnded(session);
      if (becameGhost) {
        console.warn('[CALL_STATE] suppressing_failed — ghost-confirm detected, auto-retrying on newer session');
        return;
      }
      // See the "ended" handler above — same multi-call-aware gating so a
      // failing held/sibling session doesn't tear down the rest of the
      // user's calls. Count only live siblings so zombie ghost-retry
      // entries can't keep the audio/screen stuck after a real call ends.
      const liveSiblings = this.countLiveSiblingSessions(session);
      const isLastLiveSession = liveSiblings === 0;
      console.log(
        "[MULTICALL] session_failed_cleanup id=" + this.getSessionIdSafe(session) +
          " siblingsRemaining=" + liveSiblings +
          " rawMapSize=" + this.sessionsById.size +
          " last=" + isLastLiveSession,
      );
      if (isLastLiveSession) {
        stopAllTelephonyAudio().catch(() => undefined);
        this.stopLivePing();
        ICM.stop();
        restoreAudioSession().catch(() => undefined);
      }
      this.collectAndSubmitQualityReport(cause).catch(() => {});
      if (this.session === session) this.session = null;
      if (this.incomingSessions.length === 0) this.lastAnswerMatch = undefined;
      this.setSessionState(session, "ended");
      this.removeSession(session);
      if (isLastLiveSession) {
        this.events.onCallState?.("ended");
      }
      this.events.onError?.(msg);
      this.flushGhostRetryCallbacks("failed");
    });

    // ─── Latency instrumentation ────────────────────────────────────────────
    // JsSIP fires `peerconnection` synchronously when the RTCPeerConnection
    // is constructed inside `session.answer()` / `session.connect()`. This
    // is our only reliable hook for ICE/media lifecycle events — the app
    // never constructs the PC itself. All marks below are keyed by the
    // SIP session id; the answer pipeline links that id to the invite id
    // so all events land on the same timeline.
    this.bindLatencyProbes(session);
  }

  /**
   * Subscribe timing probes to a session's RTCPeerConnection for the
   * `callLatency` pipeline. Runs once per session and is a total no-op
   * when the latency feature flag is off (the `mark` calls short-circuit
   * on `isCallLatencyEnabled()`).
   *
   * We capture:
   *   • MEDIA_SETUP_START — when the PC is first handed to us. Gap from
   *     SESSION_ACCEPT_START shows how long JsSIP spent inside its own
   *     `answer` bookkeeping before WebRTC bring-up began.
   *   • ICE_GATHERING_START / ICE_CONNECTED / ICE_COMPLETED — via the
   *     native PC's standard event listeners. These are the single
   *     biggest source of "answer → audio" latency in our setup because
   *     TURN relays add RTT per candidate pair.
   *   • FIRST_AUDIO_PACKET — polled `getStats()` every 120 ms looking
   *     for an inbound-rtp entry with packetsReceived > 0. This fires
   *     up to 5 s after accept; after that we give up so the poll
   *     doesn't stay alive on a silent channel.
   *   • AUDIO_OUTPUT_STARTED — the SIP `confirmed` handler already
   *     starts InCallManager audio output, so we mark it from here
   *     (the confirmed handler above stays focused on actual audio
   *     wiring; this mark is latency-only).
   */
  private bindLatencyProbes(session: any) {
    if (!session || typeof session.on !== "function") return;
    session.on("peerconnection", (e: any) => {
      const pc: any = e?.peerconnection ?? session?.connection ?? null;
      const sid = this.getSessionIdSafe(session);
      markCallLatency(sid, "MEDIA_SETUP_START", {
        direction: this.callDirection,
        pcPresent: !!pc,
      });
      if (!pc) return;
      let iceGatheringStartMarked = false;
      const markGatheringOnce = () => {
        if (iceGatheringStartMarked) return;
        iceGatheringStartMarked = true;
        markCallLatency(sid, "ICE_GATHERING_START", {
          state: pc.iceGatheringState ?? null,
        });
      };
      // Some RN-WebRTC builds surface `addEventListener`, others only
      // the legacy `on<event>` property setters. Try both so we stay
      // portable across react-native-webrtc major versions.
      const addListener = (name: string, fn: (ev?: any) => void) => {
        try {
          if (typeof pc.addEventListener === "function") {
            pc.addEventListener(name, fn);
          } else {
            pc[`on${name}`] = fn;
          }
        } catch { /* ignore */ }
      };
      addListener("icegatheringstatechange", () => {
        const st = pc.iceGatheringState;
        if (st === "gathering") markGatheringOnce();
      });
      addListener("icecandidate", (ev: any) => {
        // First local candidate arrival implies gathering has begun even
        // if the state event didn't fire (common on RN-WebRTC < 118).
        if (ev?.candidate) markGatheringOnce();
      });
      addListener("iceconnectionstatechange", () => {
        const st = pc.iceConnectionState;
        if (st === "connected") {
          markCallLatency(sid, "ICE_CONNECTED", { state: st });
        } else if (st === "completed") {
          markCallLatency(sid, "ICE_COMPLETED", { state: st });
        } else if (st === "failed") {
          markCallLatency(sid, "CALL_FAILED", { reason: "ice_failed" });
        }
      });
      // First-RTP probe — poll getStats for an inbound audio track.
      // Stops as soon as we see packets or after 5 s so we don't leak
      // an interval on stalled calls.
      if (typeof pc.getStats === "function") {
        const startedAt = Date.now();
        const POLL_MS = 120;
        const TIMEOUT_MS = 5_000;
        const poll = setInterval(async () => {
          if (Date.now() - startedAt > TIMEOUT_MS) {
            clearInterval(poll);
            return;
          }
          try {
            const stats = await pc.getStats();
            let gotAudio = false;
            // Stats can be a Map (standard) or an array (older libs).
            const iterate = (cb: (r: any) => void) => {
              if (stats && typeof (stats as any).forEach === "function") {
                (stats as any).forEach(cb);
              } else if (Array.isArray(stats)) {
                stats.forEach(cb);
              }
            };
            iterate((report: any) => {
              if (gotAudio) return;
              const isInboundAudio =
                report?.type === "inbound-rtp" &&
                (report.kind === "audio" || report.mediaType === "audio");
              if (
                isInboundAudio &&
                typeof report.packetsReceived === "number" &&
                report.packetsReceived > 0
              ) {
                gotAudio = true;
              }
            });
            if (gotAudio) {
              clearInterval(poll);
              markCallLatency(sid, "FIRST_AUDIO_PACKET", {
                afterAcceptMs: Date.now() - startedAt,
              });
            }
          } catch { /* getStats may throw on very early poll */ }
        }, POLL_MS);
      }
    });

    // The `confirmed` handler above flips audio routing to earpiece via
    // InCallManager. The mark fires AFTER that setTimeout so the "audio
    // output actually playing" stamp reflects when ICM has finished its
    // route change, not just when signaling completed.
    session.once("confirmed", () => {
      const sid = this.getSessionIdSafe(session);
      // 160 ms > the 150 ms routeToEarpiece delay in the confirmed
      // handler; callback runs after ICM has had time to apply it.
      setTimeout(() => {
        markCallLatency(sid, "AUDIO_OUTPUT_STARTED");
      }, 160);
    });
  }

  // === Multi-call helpers ====================================================

  private getSessionIdSafe(session: any): string | null {
    if (!session) return null;
    const existing = (session as any)._multicallId;
    if (typeof existing === "string") return existing;
    if (typeof session.id === "string") return session.id;
    return null;
  }

  private buildSessionInfo(session: any): SipSessionInfo | null {
    const id = this.getSessionIdSafe(session);
    if (!id) return null;
    const state = this.sessionStates.get(id) ?? "ringing";
    const direction: "inbound" | "outbound" = this.incomingSessions.includes(session)
      ? "inbound"
      : session === this.session && this.callDirection === "inbound"
      ? "inbound"
      : "outbound";
    return {
      sessionId: id,
      direction,
      // Prefer the SIP URI user (the actual number/extension) so upstream
      // correlation against CallInvite.fromNumber works. Fall back to the
      // display name only when the URI user is empty.
      callerNumber:
        this.getSessionFromUser(session) || this.getSessionFrom(session) || "",
      callerDisplayName: this.getSessionFromDisplayName(session) || null,
      state,
      isHeld: this.heldSessions.has(id),
    };
  }

  private emitSessionAdded(session: any) {
    try {
      const info = this.buildSessionInfo(session);
      if (info) this.events.onSessionAdded?.(info);
    } catch (err) {
      console.warn("[MULTICALL] emitSessionAdded failed:", err);
    }
  }

  private emitSessionStateChanged(session: any) {
    try {
      const info = this.buildSessionInfo(session);
      if (info) this.events.onSessionStateChanged?.(info);
    } catch (err) {
      console.warn("[MULTICALL] emitSessionStateChanged failed:", err);
    }
  }

  private setSessionState(session: any, state: SipSessionState) {
    const id = this.getSessionIdSafe(session);
    if (!id) return;
    const prev = this.sessionStates.get(id);
    if (prev === state) return;
    this.sessionStates.set(id, state);
    console.log(
      "[MULTICALL_STATE] session=" + id + " " + (prev ?? "∅") + " -> " + state,
    );
    this.emitSessionStateChanged(session);
  }

  private markHeld(session: any, held: boolean) {
    const id = this.getSessionIdSafe(session);
    if (!id) return;
    if (held) {
      this.heldSessions.add(id);
      this.setSessionState(session, "held");
    } else {
      this.heldSessions.delete(id);
      // After unhold, session goes back to connected (media flowing).
      this.setSessionState(session, "connected");
    }
  }

  private removeSession(session: any) {
    const id = this.getSessionIdSafe(session);
    if (!id) return;
    if (this.sessionsById.has(id)) {
      this.sessionsById.delete(id);
      this.sessionStates.delete(id);
      this.heldSessions.delete(id);
      this.events.onSessionRemoved?.(id);
    }
  }

  /** Used by the multi-call bridge to find a specific session. */
  private findSessionById(id: string): any | null {
    return this.sessionsById.get(id) ?? null;
  }

  listSessions(): SipSessionInfo[] {
    const out: SipSessionInfo[] = [];
    for (const session of this.sessionsById.values()) {
      const info = this.buildSessionInfo(session);
      if (info) out.push(info);
    }
    return out;
  }

  holdSession(sessionId: string): boolean {
    const s = this.findSessionById(sessionId);
    if (!s) {
      console.warn("[MULTICALL_HOLD] session_not_found id=" + sessionId);
      return false;
    }
    if (this.heldSessions.has(sessionId)) {
      console.log("[MULTICALL_HOLD] session_already_held id=" + sessionId + " — no-op");
      return true;
    }
    try {
      s.hold({
        useUpdate: false,
        eventHandlers: {
          failed: (e: any) => {
            console.warn("[MULTICALL_HOLD] reinvite_failed id=" + sessionId + " cause=" + e?.cause);
          },
          succeeded: () => {
            console.log("[MULTICALL_HOLD] reinvite_ok id=" + sessionId);
          },
        },
      });
      // Optimistic: JsSIP fires the `hold` event on success, which will call
      // markHeld() and update state. Set it locally now so the UI reflects
      // the requested state immediately.
      this.markHeld(s, true);
      return true;
    } catch (e) {
      console.warn("[MULTICALL_HOLD] threw id=" + sessionId + " err=" + String(e));
      return false;
    }
  }

  unholdSession(sessionId: string): boolean {
    const s = this.findSessionById(sessionId);
    if (!s) {
      console.warn("[MULTICALL_RESUME] session_not_found id=" + sessionId);
      return false;
    }
    if (!this.heldSessions.has(sessionId)) {
      console.log("[MULTICALL_RESUME] session_not_held id=" + sessionId + " — treating as no-op");
      return true;
    }
    try {
      s.unhold({
        useUpdate: false,
        eventHandlers: {
          failed: (e: any) => {
            console.warn("[MULTICALL_RESUME] reinvite_failed id=" + sessionId + " cause=" + e?.cause);
          },
          succeeded: () => {
            console.log("[MULTICALL_RESUME] reinvite_ok id=" + sessionId);
          },
        },
      });
      this.markHeld(s, false);
      // Resumed session becomes the legacy "active pointer".
      this.session = s;
      return true;
    } catch (e) {
      console.warn("[MULTICALL_RESUME] threw id=" + sessionId + " err=" + String(e));
      return false;
    }
  }

  hangupSession(sessionId: string): boolean {
    const s = this.findSessionById(sessionId);
    if (!s) {
      console.warn("[MULTICALL] hangup_session_not_found id=" + sessionId);
      // Nothing to hang up, but still emit a synthetic removed event so the
      // CallSessionManager prunes any stale CallSession row for this id.
      this.events.onSessionRemoved?.(sessionId);
      return false;
    }
    console.log("[MULTICALL] hangup_session id=" + sessionId);
    this.userTerminatedSessions.add(s);
    let threw = false;
    try {
      s.terminate?.();
    } catch (err) {
      threw = true;
      console.warn("[MULTICALL] hangup_session_threw id=" + sessionId + " err=" + String(err));
    }
    // If terminate threw OR the session is already in a terminated state
    // (JsSIP STATUS_TERMINATED = 8) the 'ended'/'failed' event will never
    // fire for this session — so we'd leak a phantom CallSession in the UI.
    // Force-remove from our registry to guarantee cleanup.
    const statusCode = (s as any)?._status;
    if (threw || statusCode === 8 /* STATUS_TERMINATED */) {
      console.log(
        "[MULTICALL] hangup_session_force_remove id=" + sessionId +
          " threw=" + threw + " status=" + statusCode,
      );
      this.setSessionState(s, "ended");
      this.removeSession(s);
    }
    // NB: the `ended`/`failed` handler cleans up the session registry in the normal path.
    return true;
  }

  /**
   * Blind-transfer this SIP session to `target` via the REFER method.
   * Once the remote party accepts the REFER, the PBX will bridge the call
   * to `target` and our session will be torn down normally (ended event).
   *
   * Returns true iff the REFER was dispatched — does NOT wait for the
   * transfer to complete. Transfer completion is observed via the session
   * eventually ending.
   */
  transferSession(sessionId: string, target: string): boolean {
    const s = this.findSessionById(sessionId);
    if (!s) {
      console.warn("[MULTICALL] transfer_session_not_found id=" + sessionId);
      return false;
    }
    const clean = String(target ?? "").trim();
    if (!clean) {
      console.warn("[MULTICALL] transfer_session_empty_target id=" + sessionId);
      return false;
    }
    const domain = this.bundle?.sipDomain || "";
    const refTarget = clean.includes("@") ? clean : (domain ? `sip:${clean}@${domain}` : `sip:${clean}`);
    console.log("[MULTICALL] transfer_session id=" + sessionId + " target=" + refTarget);
    try {
      s.refer?.(refTarget);
      return true;
    } catch (err) {
      console.warn("[MULTICALL] transfer_session_threw id=" + sessionId + " err=" + String(err));
      return false;
    }
  }

  /**
   * Return true iff this sessionId is still tracked AND not in a terminated
   * state. Used by CallSessionManager's stale-session sweep to detect
   * CallSession rows whose underlying SIP session has quietly died (ghost /
   * terminated without event).
   */
  isSessionAlive(sessionId: string): boolean {
    const s = this.findSessionById(sessionId);
    if (!s) return false;
    const status = (s as any)?._status;
    // JsSIP RTCSession._status codes (see lib/RTCSession.js):
    //   NULL=0, INVITE_SENT=1, 1XX_RECEIVED=2, INVITE_RECEIVED=3,
    //   WAITING_FOR_ANSWER=4, ANSWERED=5, WAITING_FOR_ACK=6,
    //   CANCELED=7, TERMINATED=8, CONFIRMED=9.
    // ONLY status 8 (TERMINATED) means the dialog is dead. Status 9 is
    // a fully-established call — treating >=8 as dead killed every
    // confirmed call whenever sweepStaleCallSessions() ran.
    if (status === 8) return false;
    return true;
  }

  /**
   * Count how many sessions currently tracked in sessionsById are still
   * alive, excluding `self`. Used by the session-ended/failed handlers
   * to decide whether to run global teardown (audio, onCallState("ended")).
   *
   * Why not `sessionsById.size - 1`? The ghost-retry path (answer_then_cancel)
   * leaves the aborted session sitting in the map with status=TERMINATED
   * until it's swept. A raw count then sees phantom siblings and skips
   * teardown, which keeps ActiveCallScreen + audio routing stuck after
   * the real call ends.
   */
  private countLiveSiblingSessions(self: any): number {
    let n = 0;
    this.sessionsById.forEach((s) => {
      if (s === self) return;
      const status = (s as any)?._status;
      if (status === 8 /* TERMINATED */) return;
      n += 1;
    });
    return n;
  }

  async answerSession(
    sessionId: string,
    timeoutMs: number = 5000,
    onTrace?: (event: SipAnswerTraceEvent) => void,
  ): Promise<boolean> {
    const deadline = Date.now() + Math.max(500, timeoutMs);
    while (Date.now() < deadline) {
      const s = this.findSessionById(sessionId);
      if (s && this.isAnswerableIncoming(s)) {
        // Point the "active" slot at the session we're answering. answerIncoming()
        // will pick it as the newest answerable candidate and route it through
        // the ghost-dialog-aware pipeline, so siblings (held calls) stay intact.
        this.session = s;
        return this.answerIncoming(
          { inviteId: (s as any)._multicallId || null },
          timeoutMs,
          onTrace,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    console.warn("[MULTICALL] answerSession_timeout id=" + sessionId);
    return false;
  }

  getSessionState(sessionId: string): SipSessionState | null {
    return this.sessionStates.get(sessionId) ?? null;
  }

  setActiveSession(sessionId: string): boolean {
    const s = this.findSessionById(sessionId);
    if (!s) return false;
    this.session = s;
    return true;
  }
  // === end multi-call helpers ================================================

  /**
   * Wait window (ms) after detecting a ghost for a new PBX re-INVITE to
   * arrive. In practice the VitalPBX / Asterisk post-claim re-INVITE lands
   * 40–200 ms after the ghost dialog terminates.
   */
  private static readonly GHOST_REINVITE_WAIT_MS = 1500;

  /** Active ghost-dialog recovery poll, if any. */
  private ghostPollInterval: ReturnType<typeof setInterval> | null = null;
  private ghostPollDeadline = 0;

  /**
   * Returns true if this ended/failed should be suppressed because the session
   * was a ghost dialog: the PBX ACKed our 200 OK and immediately BYE'd because
   * a parallel claim re-INVITE had already superseded it. In that case we wait
   * for the new PBX INVITE (up to GHOST_REINVITE_WAIT_MS) and answer it
   * silently, so the JS layer never sees a connected→ended flash.
   */
  private handleGhostOrEnded(session: any): boolean {
    // Only treat as ghost if we actually answered this session.
    const weAnswered = this.answerAttemptedSessions.has(session);
    if (!weAnswered) return false;

    // Never treat a user-initiated hangup as a ghost. The user ended the
    // call intentionally; if the resulting ended/failed happens within the
    // ghost window (e.g. a short 1-second test call) we would otherwise
    // spuriously start a 1500ms poll that could auto-answer an unrelated
    // future incoming call if the JS timer is delayed by background
    // throttling, which is exactly the Call-2 regression we saw in logs.
    if (this.userTerminatedSessions.has(session)) {
      return false;
    }

    const now = Date.now();

    // Case A: session confirmed then ended very quickly (classic ghost — PBX
    // ACK'd our 200 OK, then immediately BYE'd because a parallel claim re-INVITE
    // superseded it).
    const confirmedAt = this.sessionConfirmedAt.get(session);
    const isShortLivedConfirm =
      typeof confirmedAt === "number" &&
      now - confirmedAt < JsSipClient.GHOST_WINDOW_MS;

    // Case B: session never confirmed — we sent 200 OK but PBX canceled before
    // ACK (fires `failed` with cause="Canceled" shortly after our answer). This
    // is the dominant pattern on VitalPBX / Asterisk when the backend claim
    // races ahead of SIP. Without this case, the UI briefly sees `ended` which
    // hides the ActiveCall controls and flashes "Call Ended" before the retry
    // confirms on the replacement INVITE.
    const answeredAt = this.answerInvokedAt.get(session);
    const isShortLivedAnswer =
      typeof answeredAt === "number" &&
      now - answeredAt < JsSipClient.GHOST_WINDOW_MS;

    if (!isShortLivedConfirm && !isShortLivedAnswer) return false;

    // Mark as ghost — we will suppress the state transition and either answer
    // a newer session now (sync) or wait for one (async poll).
    this.ghostSessions.add(session);

    const newer = this.findSuitableNewer(session);
    if (newer) {
      this.performGhostRetry(newer);
      return true;
    }

    console.warn(
      '[CALL_NATIVE] ghost_detected kind=' +
      (isShortLivedConfirm ? 'confirm_then_end' : 'answer_then_cancel') +
      ' — no newer invite yet, polling up to ' + JsSipClient.GHOST_REINVITE_WAIT_MS + 'ms'
    );
    this.startGhostPoll(session);
    return true;
  }

  private findSuitableNewer(oldSession: any): any | null {
    const candidate = this.findIncoming(this.lastAnswerMatch);
    if (!candidate || candidate === oldSession) return null;
    if (!this.isAnswerableIncoming(candidate)) return null;
    if (this.answerAttemptedSessions.has(candidate)) return null;
    return candidate;
  }

  private startGhostPoll(oldSession: any) {
    this.clearGhostPoll();
    this.ghostPollDeadline = Date.now() + JsSipClient.GHOST_REINVITE_WAIT_MS;
    this.ghostPollInterval = setInterval(() => {
      const now = Date.now();
      // Check deadline FIRST. Android RN suspends setInterval callbacks when
      // the app is backgrounded, so this interval can fire many seconds (or
      // minutes) late. If we matched a newer session first, a completely
      // unrelated incoming call that arrived long after the ghost window
      // would be silently auto-answered — that is exactly the "Call 2 auto-
      // answered without user tapping" bug observed in the field.
      if (now >= this.ghostPollDeadline) {
        this.clearGhostPoll();
        console.warn('[CALL_NATIVE] ghost_poll_timeout — no newer invite arrived within window, surfacing ended state');
        stopAllTelephonyAudio().catch(() => undefined);
        this.stopLivePing();
        ICM.stop();
        restoreAudioSession().catch(() => undefined);
        if (this.session === oldSession) this.session = null;
        if (this.incomingSessions.length === 0) this.lastAnswerMatch = undefined;
        this.events.onCallState?.("ended");
        this.flushGhostRetryCallbacks("failed");
        return;
      }
      const newer = this.findSuitableNewer(oldSession);
      if (newer) {
        // Second safety check: the candidate must have arrived before the
        // ghost deadline. A legitimate PBX re-INVITE after a ghost arrives
        // 40–200ms later; anything outside the window is a fresh call.
        const arrivedAt = (newer as any)._inviteArrivedAt as number | undefined;
        if (typeof arrivedAt === "number" && arrivedAt > this.ghostPollDeadline) {
          console.warn('[CALL_NATIVE] ghost_poll_candidate_rejected — newer invite arrived after ghost window, not a re-INVITE');
          return;
        }
        this.clearGhostPoll();
        this.performGhostRetry(newer);
        return;
      }
    }, 40);
  }

  private clearGhostPoll() {
    if (this.ghostPollInterval !== null) {
      clearInterval(this.ghostPollInterval);
      this.ghostPollInterval = null;
    }
  }

  private performGhostRetry(newer: any): void {
    this.answerAttemptedSessions.add(newer);
    this.answerInvokedAt.set(newer, Date.now());
    this.session = newer;
    const age = Date.now() - ((newer as any)._inviteArrivedAt || Date.now());
    console.warn('[CALL_NATIVE] ghost_retry_answer — answering newer session, age(ms)=' + age);
    try {
      newer.answer({ mediaConstraints: VOICE_AUDIO_CONSTRAINTS });
    } catch (err: any) {
      console.error('[CALL_NATIVE] ghost_retry_answer failed:', err?.message || err);
      // If the synchronous answer throws, the newer session will fire 'failed'
      // which routes through the normal bindSession path.
    }
  }

  private flushGhostRetryCallbacks(result: "confirmed" | "failed") {
    if (this.ghostRetryCallbacks.length === 0) return;
    const cbs = this.ghostRetryCallbacks;
    this.ghostRetryCallbacks = [];
    for (const cb of cbs) {
      try {
        cb(result);
      } catch {
        /* ignore */
      }
    }
  }

  private normalizeNumber(v: string | undefined): string {
    return String(v || "").replace(/[^0-9+]/g, "");
  }

  private getSessionFrom(session: any): string {
    return String(
      session?.remote_identity?.display_name ||
      session?.remote_identity?.uri?.user ||
      ""
    );
  }

  private getSessionFromUser(session: any): string {
    return String(session?.remote_identity?.uri?.user || "");
  }

  private getSessionFromDisplayName(session: any): string {
    return String(session?.remote_identity?.display_name || "");
  }

  private getSessionTo(session: any): string {
    return String(
      session?._request?.to?.uri?.user ||
      session?._request?.ruri?.user ||
      this.bundle?.sipUsername ||
      session?.local_identity?.uri?.user ||
      "",
    );
  }

  private describeIncomingSession(session: any) {
    return {
      from: this.getSessionFrom(session),
      fromUser: this.getSessionFromUser(session),
      fromDisplayName: this.getSessionFromDisplayName(session),
      fromNormalized: this.normalizeNumber(this.getSessionFrom(session)),
      to: this.getSessionTo(session),
      status: session?._status ?? null,
      hasAnswer: typeof session?.answer === "function",
    };
  }

  private isAnswerableIncoming(session: any): boolean {
    const status = session?._status;
    // JsSIP incoming sessions are answerable while waiting for answer (4) and
    // sometimes very briefly in answered/waiting-for-ack states before confirm.
    // Never select terminated/canceled sessions.
    return (
      typeof session?.answer === "function" &&
      status !== 8 && // STATUS_TERMINATED
      status !== 7 && // STATUS_CANCELED
      status !== 9 // STATUS_CONFIRMED
    );
  }

  private matchesIncoming(session: any, match?: SipMatch): boolean {
    if (!match) return true;
    const targetFrom = this.normalizeNumber(match.fromNumber || "");
    if (targetFrom) {
      const candidates = [
        this.normalizeNumber(this.getSessionFromUser(session)),
        this.normalizeNumber(this.getSessionFromDisplayName(session)),
        this.normalizeNumber(this.getSessionFrom(session)),
      ].filter(Boolean);
      const fromMatches = candidates.some(
        (candidate) => candidate === targetFrom || candidate.endsWith(targetFrom) || targetFrom.endsWith(candidate),
      );
      if (candidates.length > 0 && !fromMatches) return false;
    }
    const to = String(this.getSessionTo(session));
    const toExt = String(match.toExtension || "");
    if (toExt && to) {
      // VitalPBX multi-tenant SIP usernames come in several formats:
      //   "103_1"  → extension 103, device index 1  (sipUsername format)
      //   "T2_103" → tenant T2, extension 103        (authUsername prefix format)
      // The push invite always stores just the short extension ("103").
      // Accept the match if:
      //   - exact match:           "103"    === "103"  ✓
      //   - starts with ext + "_": "103_1"  starts with "103_"  ✓
      //   - ends with "_" + ext:   "T2_103" ends with  "_103"   ✓
      const matches =
        to === toExt ||
        to.startsWith(toExt + "_") ||
        to.endsWith("_" + toExt);
      if (!matches) return false;
    }
    return true;
  }

  private findIncoming(match?: SipMatch): any | null {
    const sessions = [...this.incomingSessions];
    if (this.session && !sessions.includes(this.session)) {
      sessions.push(this.session);
    }

    // Prefer the newest still-answerable incoming session first. PBX retries can
    // create a second INVITE before the old one is fully cleaned up; choosing the
    // oldest session here answers the stale INVITE and causes random CANCELs.
    for (const s of [...sessions].reverse()) {
      if (!this.isAnswerableIncoming(s)) continue;
      if (this.matchesIncoming(s, match)) return s;
    }

    const answerableSessions = [...sessions].reverse().filter((session) => this.isAnswerableIncoming(session));

    if (match && answerableSessions.length === 1) {
      const fallback = answerableSessions[0];
      console.warn(
        "[SIP] findIncoming: using single-session fallback after match miss",
        JSON.stringify({
          expectedFrom: this.normalizeNumber(match.fromNumber || ""),
          expectedToExtension: String(match.toExtension || ""),
          inviteId: match.inviteId || null,
          session: this.describeIncomingSession(fallback),
        }),
      );
      return fallback;
    }

    if (match && answerableSessions.length > 0) {
      console.warn(
        "[SIP] findIncoming: no incoming session matched",
        JSON.stringify({
          expectedFrom: this.normalizeNumber(match.fromNumber || ""),
          expectedToExtension: String(match.toExtension || ""),
          inviteId: match.inviteId || null,
          candidateCount: answerableSessions.length,
          candidates: answerableSessions.map((session) => this.describeIncomingSession(session)),
        }),
      );
    }

    return null;
  }

  async unregister() {
    // Tag the UA as replaced so any async `disconnected` / `unregistered`
    // events fired by the closing WebSocket don't trigger the reconnect
    // orchestrator (via onSocketDisconnected). This is the user-initiated
    // teardown path — logout, explicit re-provisioning, diagnostics.
    if (this.ua) {
      try { (this.ua as any).__jsSipClientReplaced = true; } catch { /* ignore */ }
    }
    try {
      this.ua?.stop();
    } finally {
      this.ua = null;
      this.events.onRegistrationState?.("idle");
    }
  }

  async dial(target: string) {
    if (!this.ua || !this.bundle) throw new Error("SIP UA not registered");
    const dest = `sip:${target}@${this.bundle.sipDomain}`;
    console.log('[SIP] Dialing:', dest);
    this.callDirection = "outbound";
    this.callStartedAt = Date.now();
    this.events.onCallState?.("dialing");
    // Start InCallManager early so there is always a matching stop() later.
    // On Android this sets MODE_IN_COMMUNICATION; expo-av ringback audio will
    // play through the earpiece, which is correct behaviour for a VoIP call.
    ICM.start("audio");
    initAudioSession().then(() => startRingback()).catch(() => undefined);
    try {
      this.session = this.ua.call(dest, {
        mediaConstraints: VOICE_AUDIO_CONSTRAINTS,
        pcConfig: this.ua._configuration?.pcConfig ?? {},
      });
      // NOTE: do NOT call bindSession here — ua.call() fires newRTCSession
      // synchronously, which already calls bindSession. Calling it again here
      // would double-attach all event listeners, causing confirmed/ended/failed
      // to fire twice and every state update to run twice.
      console.log('[SIP] INVITE sent');
    } catch (e: any) {
      stopAllTelephonyAudio().catch(() => undefined);
      ICM.stop();
      const msg = e?.message || "dial failed";
      console.error('[SIP] Dial error:', msg);
      this.events.onError?.(`Dial error: ${msg}`);
      this.events.onCallState?.("ended");
    }
  }

  async answer() {
    stopAllTelephonyAudio().catch(() => undefined); // Stop ringtone on answer
    ICM.start("audio");
    setTimeout(() => ICM.routeToEarpiece(), 150);
    this.session?.answer?.({ mediaConstraints: VOICE_AUDIO_CONSTRAINTS });
  }

  async answerIncoming(
    match?: SipMatch,
    timeoutMs = 5000,
    onTrace?: (event: SipAnswerTraceEvent) => void,
  ): Promise<boolean> {
    const answerStartAt = Date.now();
    const until = answerStartAt + Math.max(500, timeoutMs);
    const MAX_ATTEMPTS = 3;
    let attempt = 0;
    this.lastAnswerMatch = match;
    console.log('[CALL_EVENT] answer_pipeline_start at=' + answerStartAt + ' timeoutMs=' + timeoutMs);

    // IMPORTANT: `attempt` counts real `session.answer()` invocations only.
    // A poll iteration that finds no incoming session yet (cold-start race where
    // SIP is registered but the INVITE hasn't arrived) must NOT consume an
    // attempt slot — we just wait inside the overall time budget.
    // PERF: poll interval lowered from 50ms → 15ms. On cold-start answers
    // the PBX sends SIP INVITE ~300–450 ms after our REGISTER completes;
    // during that window this loop was idle-sleeping in 50 ms chunks,
    // stretching total answer latency by up to an extra ~50 ms per call.
    // 15 ms still costs ≤ 0.1 % CPU and shaves tail latency off every
    // inbound call.
    const POLL_MS = 15;
    // Fine-grained sub-phase split of SESSION_ACCEPT_START → MEDIA_SETUP_START.
    // Fired once per pipeline invocation on the FIRST time findIncoming returns
    // a usable session — i.e. the moment the PBX's INVITE has actually arrived
    // at our UA. Gap SESSION_ACCEPT_START→SIP_INVITE_FOUND is pure poll-wait
    // for the PBX; gap SIP_ANSWER_INVOKED→MEDIA_SETUP_START is JsSIP+WebRTC
    // native work (getUserMedia, PC construction, SDP).
    let inviteFoundMarked = false;
    const inviteIdForLatency = match?.inviteId ?? null;
    while (Date.now() < until) {
      const session = this.findIncoming(match);
      if (!session) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
      if (!inviteFoundMarked) {
        inviteFoundMarked = true;
        markCallLatency(inviteIdForLatency, "SIP_INVITE_FOUND", {
          waitedMs: Date.now() - answerStartAt,
        });
      }
      if (this.answerAttemptedSessions.has(session)) {
        // Already tried this one. Wait for ghost-retry to complete or a newer
        // session to arrive. Do not consume an attempt slot here.
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }
      if (attempt >= MAX_ATTEMPTS) {
        console.warn('[CALL_EVENT] answer_attempts_exhausted_on_fresh_session attempts=' + attempt);
        break;
      }
      attempt++;
      const inviteAge = answerStartAt - ((session as any)._inviteArrivedAt || answerStartAt);
      console.log('[CALL_EVENT] answer_attempt n=' + attempt + ' inviteAge=' + inviteAge + 'ms waited=' + (Date.now() - answerStartAt) + 'ms');
      this.answerAttemptedSessions.add(session);
      this.session = session;
      stopAllTelephonyAudio().catch(() => undefined);
      ICM.start("audio");
      setTimeout(() => ICM.routeToEarpiece(), 150);

      const outcome = await new Promise<"confirmed" | "ghost" | "failed">((resolve) => {
        const ANSWER_TIMEOUT_MS = Math.max(500, until - Date.now());
        let settled = false;
        const answerTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          console.warn('[CALL_EVENT] answer_timeout after ' + ANSWER_TIMEOUT_MS + 'ms');
          resolve("failed");
        }, ANSWER_TIMEOUT_MS);

        const finalize = (v: "confirmed" | "ghost" | "failed") => {
          if (settled) return;
          settled = true;
          clearTimeout(answerTimer);
          resolve(v);
        };

        const awaitGhostRetry = () => {
          // bindSession's handleGhostOrEnded may have queued an auto-retry on a
          // newer session. Wait for its outcome before we decide to fail.
          const remaining = Math.max(500, until - Date.now());
          const waitTimer = setTimeout(() => finalize("failed"), remaining);
          this.ghostRetryCallbacks.push((result) => {
            clearTimeout(waitTimer);
            finalize(result === "confirmed" ? "confirmed" : "failed");
          });
        };

        session.once?.("confirmed", () => {
          if (settled) return;
          if (this.ghostSessions.has(session)) {
            console.warn('[CALL_EVENT] answer_confirmed_on_ghost — ignoring and awaiting retry');
            awaitGhostRetry();
            return;
          }
          console.log('[CALL_EVENT] answer_confirmed attempt=' + attempt);
          onTrace?.({ phase: "confirmed", timestamp: Date.now() });
          finalize("confirmed");
        });

        session.once?.("failed", (e: any) => {
          if (settled) return;
          const cause = e?.cause || "unknown";
          const code = e?.response?.status_code;
          console.warn('[CALL_EVENT] answer_failed attempt=' + attempt + ' code=' + (code ?? "n/a") + ' cause=' + cause);
          if (this.ghostSessions.has(session)) {
            awaitGhostRetry();
            return;
          }
          onTrace?.({
            phase: "failed",
            timestamp: Date.now(),
            code: typeof code === "number" ? code : null,
            reason: String(cause || "unknown"),
            message: code ? `failed:${code}` : String(cause || "unknown"),
          });
          finalize("failed");
        });
        session.once?.("ended", () => {
          if (settled) return;
          // If bindSession identified this as a ghost dialog, wait for the retry.
          if (this.ghostSessions.has(session)) {
            console.warn('[CALL_EVENT] answer_ended_as_ghost attempt=' + attempt + ' — awaiting retry');
            awaitGhostRetry();
            return;
          }
          console.log('[CALL_EVENT] answer_ended_before_confirmed attempt=' + attempt);
          onTrace?.({
            phase: "failed",
            timestamp: Date.now(),
            reason: "ended_before_confirmed",
            message: "ended_before_confirmed",
          });
          finalize("failed");
        });

        try {
          console.log('[CALL_NATIVE] answer_invoked attempt=' + attempt);
          this.answerInvokedAt.set(session, Date.now());
          // Stitch the inviteId (from the caller) to the SIP session
          // id so every mark emitted from `bindLatencyProbes` lands on
          // the same timeline the UI layer opened under `invite.id`.
          const sid = this.getSessionIdSafe(session);
          const inviteId = match?.inviteId;
          if (inviteId && sid) linkCallLatencyIds(inviteId, sid);
          // Sub-phase: we are about to enter session.answer() which runs
          // synchronously on the JS thread but does heavy native work
          // (RTCPeerConnection construction, getUserMedia for mic,
          // applyRemoteDescription, createAnswer, setLocalDescription).
          // Gap SIP_ANSWER_INVOKED → MEDIA_SETUP_START tells us whether
          // peer-connection prewarm would actually help.
          const answerInvokedAt = Date.now();
          markCallLatency(inviteId ?? sid, "SIP_ANSWER_INVOKED", {
            sinceAnswerStartMs: answerInvokedAt - answerStartAt,
          });
          session.answer({ mediaConstraints: VOICE_AUDIO_CONSTRAINTS });
          const answerReturnedAt = Date.now();
          markCallLatency(inviteId ?? sid, "SIP_ANSWER_RETURNED", {
            answerInternalMs: answerReturnedAt - answerInvokedAt,
          });
          onTrace?.({ phase: "sent", timestamp: Date.now() });
        } catch (e: any) {
          console.error('[CALL_NATIVE] answer_threw attempt=' + attempt + ' error=' + (e?.message || e));
          onTrace?.({
            phase: "failed",
            timestamp: Date.now(),
            reason: "answer_threw",
            message: e?.message || String(e),
          });
          finalize("failed");
        }
      });

      if (outcome === "confirmed") {
        console.log('[CALL_EVENT] answer_pipeline_success attempts=' + attempt);
        return true;
      }
      if (outcome === "ghost") {
        // ghost-retry already happened inside bindSession; loop to re-check state.
        continue;
      }
      // failed — try next iteration if the loop still has time budget.
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    console.warn('[CALL_EVENT] answer_pipeline_exhausted attempts=' + attempt);
    onTrace?.({
      phase: "failed",
      timestamp: Date.now(),
      reason: attempt >= MAX_ATTEMPTS ? "max_attempts" : "session_not_found_timeout",
      message: attempt >= MAX_ATTEMPTS ? "max_attempts" : "session_not_found_timeout",
    });
    return false;
  }

  async rejectIncoming(match?: SipMatch): Promise<boolean> {
    const session = this.findIncoming(match);
    if (!session) return false;
    stopAllTelephonyAudio().catch(() => undefined); // Stop ringtone on reject
    try {
      session.terminate?.();
    } catch {}
    this.incomingSessions = this.incomingSessions.filter((x) => x !== session);
    if (this.session === session) this.session = null;
    return true;
  }

  async hangup() {
    console.log('[SIP] Hanging up');
    // Mark the session as user-terminated BEFORE terminate() fires so the
    // resulting `ended`/`failed` event skips ghost detection. Without this,
    // a short confirmed call (<2s) ended by the user was being flagged as
    // a ghost and starting a recovery poll that, if delayed by Android
    // background timer throttling, would later auto-answer an unrelated
    // future incoming call.
    const s = this.session;
    if (s) this.userTerminatedSessions.add(s);
    // Also cancel any in-flight ghost poll — once the user has hung up we
    // do not want to auto-answer anything for this dialog's recovery.
    this.clearGhostPoll();
    stopAllTelephonyAudio().catch(() => undefined);
    this.stopLivePing();
    await this.collectAndSubmitQualityReport("user_hangup").catch(() => {});
    ICM.stop();
    restoreAudioSession().catch(() => undefined);
    try {
      this.session?.terminate?.();
    } catch (e) {
      console.warn('[SIP] Hangup error:', e);
    }
    // onCallState("ended") will be fired by the session "ended"/"failed" event.
    // Only fire it directly here if session terminate doesn't produce an event.
    setTimeout(() => {
      if (this.session === null) {
        this.events.onCallState?.("ended");
      }
    }, 500);
  }

  setMute(mute: boolean) {
    if (mute) {
      this.session?.mute?.({ audio: true });
    } else {
      this.session?.unmute?.({ audio: true });
    }
  }

  setSpeaker(speakerOn: boolean) {
    ICM.setSpeaker(speakerOn);
    console.log('[SIP] Speaker', speakerOn ? 'on' : 'off');
  }

  hold() {
    if (!this.session) return;
    try {
      this.session.hold({
        useUpdate: false,
        eventHandlers: {
          failed: (e: any) => {
            console.warn('[SIP] Hold failed:', e?.cause);
          },
        },
      });
      console.log('[SIP] Hold sent');
    } catch (e) {
      console.warn('[SIP] Hold error:', e);
    }
  }

  unhold() {
    if (!this.session) return;
    try {
      this.session.unhold({
        useUpdate: false,
        eventHandlers: {
          failed: (e: any) => {
            console.warn('[SIP] Unhold failed:', e?.cause);
          },
        },
      });
      console.log('[SIP] Unhold sent');
    } catch (e) {
      console.warn('[SIP] Unhold error:', e);
    }
  }

  sendDtmf(digit: string) {
    this.session?.sendDTMF?.(digit);
  }

  private stopLivePing() {
    if (this.livePingInterval !== null) {
      clearInterval(this.livePingInterval);
      this.livePingInterval = null;
    }
    // Tell dashboard the call is gone
    this.onCallQualityPing?.({ _clear: true });
  }

  private startLivePing(session: any) {
    this.stopLivePing();
    this.livePingInterval = setInterval(async () => {
      if (!this.onCallQualityPing) return;
      const durationMs = this.callStartedAt ? Date.now() - this.callStartedAt : 0;
      const snapshot: Record<string, unknown> = {
        platform: "ANDROID",
        durationMs,
        direction: this.callDirection,
      };

      // Collect audio route
      let audioRoute: string | null = null;
      try {
        const ICMModule = require('react-native-incall-manager').default || require('react-native-incall-manager');
        audioRoute = ICMModule?.currentRoute?.() || null;
      } catch { /* ignore */ }
      if (audioRoute) snapshot.audioRoute = audioRoute;

      // Network type — @react-native-community/netinfo is optional telemetry,
      // omitted here to avoid a require(undefined) crash if not bundled.

      // WebRTC stats
      try {
        const pc: RTCPeerConnection | null = session?.connection ?? null;
        if (pc && typeof pc.getStats === "function") {
          const stats = await pc.getStats();
          const localCandidates = new Map<string, string>();
          stats.forEach((r: any) => {
            if (r.type === "local-candidate") localCandidates.set(r.id, r.candidateType || "");
          });
          stats.forEach((r: any) => {
            if (r.type === "inbound-rtp" && r.kind === "audio") {
              if (typeof r.packetsLost === "number") snapshot.packetsLost = r.packetsLost;
              if (typeof r.packetsReceived === "number") snapshot.packetsReceived = r.packetsReceived;
              if (typeof r.jitter === "number") snapshot.jitterMs = Math.round(r.jitter * 1000);
              if (typeof r.bytesReceived === "number") snapshot.bytesReceived = r.bytesReceived;
            }
            if (r.type === "outbound-rtp" && r.kind === "audio") {
              if (typeof r.packetsSent === "number") snapshot.packetsSent = r.packetsSent;
              if (typeof r.bytesSent === "number") snapshot.bytesSent = r.bytesSent;
            }
            if (r.type === "candidate-pair" && r.nominated === true) {
              if (typeof r.currentRoundTripTime === "number") snapshot.rttMs = Math.round(r.currentRoundTripTime * 1000);
              const ct = localCandidates.get(r.localCandidateId);
              if (ct) { snapshot.candidateType = ct; snapshot.isUsingRelay = ct === "relay"; }
            }
          });
        }
      } catch { /* ignore */ }

      // Compute quality grade
      const rtt = typeof snapshot.rttMs === "number" ? snapshot.rttMs : 999;
      const jitter = typeof snapshot.jitterMs === "number" ? snapshot.jitterMs : 0;
      const lost = typeof snapshot.packetsLost === "number" ? snapshot.packetsLost : 0;
      const recv = typeof snapshot.packetsReceived === "number" ? snapshot.packetsReceived : 0;
      const lossRate = recv > 0 ? (lost / (lost + recv)) * 100 : 0;
      if (rtt <= 100 && jitter <= 10 && lossRate < 0.5) snapshot.qualityGrade = "excellent";
      else if (rtt <= 200 && jitter <= 25 && lossRate < 1) snapshot.qualityGrade = "good";
      else if (rtt <= 350 && jitter <= 50 && lossRate < 3) snapshot.qualityGrade = "fair";
      else snapshot.qualityGrade = "poor";

      this.onCallQualityPing(snapshot);
    }, 10_000);
  }

  private async collectAndSubmitQualityReport(endReason: string) {
    if (!this.callStartedAt) return;
    const durationMs = Date.now() - this.callStartedAt;
    if (durationMs < 1000) return;

    // Collect device/network metadata for RCA
    let deviceModel: string | null = null;
    let networkType: string | null = null;
    try {
      const { Platform } = require("react-native");
      deviceModel = Platform.OS === "android" ? `Android ${Platform.Version}` : `iOS ${Platform.Version}`;
    } catch { /* ignore */ }
    // Network type via @react-native-community/netinfo omitted —
    // package is not in the bundle; omitting prevents require(undefined) crash.

    const report: Record<string, unknown> = {
      platform: "ANDROID",
      durationMs,
      direction: this.callDirection,
      endReason,
      deviceModel,
      networkType,
    };

    try {
      const pc: RTCPeerConnection | null = this.session?.connection ?? null;
      if (pc && typeof pc.getStats === "function") {
        const stats = await pc.getStats();
        const localCandidates = new Map<string, string>();
        let audioCodec: string | null = null;
        const codecIds = new Map<string, string>();
        stats.forEach((r: any) => {
          if (r.type === "local-candidate" && typeof r.candidateType === "string") {
            localCandidates.set(r.id, r.candidateType);
          }
          if (r.type === "codec" && typeof r.mimeType === "string") {
            codecIds.set(r.id, r.mimeType.replace(/^audio\//, ""));
          }
        });
        stats.forEach((r: any) => {
          if (r.type === "inbound-rtp" && r.kind === "audio") {
            if (typeof r.packetsLost === "number") report.packetsLost = r.packetsLost;
            if (typeof r.packetsReceived === "number") report.packetsReceived = r.packetsReceived;
            if (typeof r.jitter === "number") report.jitterMs = Math.round(r.jitter * 1000);
            if (r.codecId && codecIds.has(r.codecId)) audioCodec = codecIds.get(r.codecId) ?? null;
          }
          if (r.type === "candidate-pair" && r.nominated === true) {
            if (typeof r.currentRoundTripTime === "number") {
              report.rttMs = Math.round(r.currentRoundTripTime * 1000);
            }
            const ct = localCandidates.get(r.localCandidateId);
            if (ct) {
              report.candidateType = ct;
              report.isUsingRelay = ct === "relay";
            }
          }
        });
        if (audioCodec) report.audioCodec = audioCodec;
      }
    } catch {
      // getStats may not be available on all RN-WebRTC versions
    }

    // Compute quality grade
    const rtt = typeof report.rttMs === "number" ? (report.rttMs as number) : 999;
    const jitter = typeof report.jitterMs === "number" ? (report.jitterMs as number) : 0;
    const lost = typeof report.packetsLost === "number" ? (report.packetsLost as number) : 0;
    const received = typeof report.packetsReceived === "number" ? (report.packetsReceived as number) : 0;
    const lossRate = received > 0 ? (lost / (lost + received)) * 100 : 0;

    if (rtt <= 100 && jitter <= 10 && lossRate < 0.5) report.qualityGrade = "excellent";
    else if (rtt <= 200 && jitter <= 25 && lossRate < 1) report.qualityGrade = "good";
    else if (rtt <= 350 && jitter <= 50 && lossRate < 3) report.qualityGrade = "fair";
    else report.qualityGrade = "poor";

    this.callStartedAt = null;
    this.onCallQualityReport?.(report);
  }
}
