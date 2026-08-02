import type {
  SipAnswerTraceEvent,
  SipClient,
  SipEvents,
  SipMatch,
  SipSessionInfo,
  SipSessionState,
} from "./types";
import type { ProvisioningBundle } from "../types";
import { registerGlobals as registerWebRTCGlobals, mediaDevices } from "react-native-webrtc";
import { Platform, NativeModules, DeviceEventEmitter } from "react-native";
import JsSIP from "jssip";
import {
  startRingback,
  startRingtone,
  stopAllTelephonyAudio,
  initAudioSession,
  restoreAudioSession,
} from "../audio/telephonyAudio";
import { audioRouteManager, getAudioDevicesSnapshot } from "../audio/audioRouteManager";
import {
  markCallLatency,
  linkCallLatencyIds,
  isCallLatencyEnabled,
} from "../debug/callLatency";
import {
  MOBILE_SIP_ANSWER_INITIAL_WAIT_MS,
  MOBILE_SIP_ANSWER_POLL_MS,
  createSipAnswerDeadline,
  type SipAnswerDeadlineHandle,
} from "./mobileAnswerTiming";
import {
  ensureOutboundSipRegistration,
  normalizeMobileDialTarget,
} from "./mobileOutboundDial";
import {
  extractJsSipFailureFields,
  isWebrtcSdpRejection,
} from "@connect/shared/webrtcBlackbox";
import { MobileWebrtcBlackboxRecorder } from "./webrtcBlackboxRecorder";
import { buildVoiceAudioConstraints } from "./voiceAudioConstraints";
import { preferOpusInSdp, preferOpusOnlyOffer } from "./preferOpusSdp";
import * as SecureStore from "expo-secure-store";
import { isStandingRegistrationEnabled, isForceTurnRelayEnabled, getFeatureFlags, isOpusSdpDisabled } from "../config/featureFlags";
import { NativeSipSocket, isNativeSipSocketAvailable } from "./nativeSipSocket";

// -- iOS stable SIP instance id (RFC 5626 outbound de-dup) ----------------------
// iOS cannot hold a persistent SIP socket, so the app spins up a fresh JsSIP UA
// on every wake/reconnect. When instance_id is unset, JsSIP mints a NEW random
// +sip.instance per UA (see jssip UA.js), so the PBX registrar treats each wake
// as a brand-new device and STACKS a new AOR contact. Inbound calls then fork to
// stale contacts the app is no longer answering on -> voicemail. Pinning a
// persisted per-install UUID makes every re-register carry the SAME
// reg-id=1;+sip.instance, so the registrar REPLACES the one binding. Per-install
// (NOT per-extension) so multiple phones on one extension keep distinct bindings
// and all ring. iOS-only; Android keeps one long-lived UA and is untouched.
// v1 key persisted with SecureStore's DEFAULT keychain accessibility
// (WHEN_UNLOCKED). That default is the reason build 15 showed no change: an
// inbound call wakes the app via VoIP push while the iPhone is still LOCKED, so
// a WHEN_UNLOCKED keychain item is unreadable, getItemAsync fails, and the code
// below used to fall through to genUuidV4() — minting a FRESH instance_id on
// every locked wake. The registrar then saw a brand-new device each time and
// stacked a new contact (the observed non-deduplicated fresh contact). The v2
// key is written with AFTER_FIRST_UNLOCK so it is readable during a background
// wake on a locked device (the phone has been unlocked at least once since
// boot in normal use), giving us a genuinely STABLE +sip.instance across wakes.
const SIP_INSTANCE_ID_KEY_V1 = "cc_sip_instance_id";
const SIP_INSTANCE_ID_KEY = "cc_sip_instance_id_v2";
// Keychain items are only accessible when readable in the current lock state.
// AFTER_FIRST_UNLOCK keeps the item readable after the first post-boot unlock,
// including while the screen is subsequently locked (i.e. during a VoIP wake).
const SIP_INSTANCE_KEYCHAIN_OPTS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
} as const;
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let cachedSipInstanceId: string | null = null;
function genUuidV4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
async function readSecure(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    // Thrown when the item exists but is not accessible in the current lock
    // state (e.g. a stale WHEN_UNLOCKED item read during a locked wake).
    return null;
  }
}
async function getStableSipInstanceId(): Promise<string> {
  if (cachedSipInstanceId && UUID_V4_RE.test(cachedSipInstanceId)) {
    return cachedSipInstanceId;
  }
  // Prefer the v2 (AFTER_FIRST_UNLOCK) item.
  let id = await readSecure(SIP_INSTANCE_ID_KEY);
  let needsPersist = false;
  // Migrate a valid v1 value forward so existing installs keep the same
  // identity (only readable while unlocked — best effort).
  if (!id || !UUID_V4_RE.test(id)) {
    const legacy = await readSecure(SIP_INSTANCE_ID_KEY_V1);
    if (legacy && UUID_V4_RE.test(legacy)) {
      id = legacy;
    } else {
      id = genUuidV4();
    }
    needsPersist = true;
  }
  if (needsPersist) {
    try {
      await SecureStore.setItemAsync(
        SIP_INSTANCE_ID_KEY,
        id,
        SIP_INSTANCE_KEYCHAIN_OPTS,
      );
    } catch {
      // best-effort persistence; a non-persisted id still de-dups within a run
    }
  }
  cachedSipInstanceId = id;
  return id;
}
import { getDnd } from "./dndStore";

const VOICE_AUDIO_CONSTRAINTS = buildVoiceAudioConstraints();

// TEMP DIAGNOSTIC (2026-07-27): every SIP wss connect on this device dies at the
// 4 s watchdog while curl from the phone shell reaches the PBX fine. This probe
// isolates the failing layer from INSIDE the app process: raw WebSocket with the
// sip subprotocol, raw WebSocket without it, and a plain HTTPS fetch to the same
// host/port. Runs once per JS runtime, logs [WS_PROBE] timings. Remove when done.
let __wsProbeRan = false;
function runWsProbeOnce(server: string) {
  if (__wsProbeRan) return;
  __wsProbeRan = true;
  const started = Date.now();
  const log = (tag: string, extra?: Record<string, unknown>) =>
    console.log(`[WS_PROBE] ${tag}`, JSON.stringify({ ms: Date.now() - started, ...extra }));
  log("start", { server });
  try {
    const wsA = new WebSocket(server, "sip");
    wsA.onopen = () => { log("A_sip_proto_open"); try { wsA.close(); } catch {} };
    wsA.onerror = (e: any) => log("A_sip_proto_error", { msg: String(e?.message ?? e) });
    wsA.onclose = (e: any) => log("A_sip_proto_close", { code: e?.code, reason: e?.reason });
  } catch (e) {
    log("A_ctor_throw", { msg: String(e) });
  }
  try {
    const wsB = new WebSocket(server);
    wsB.onopen = () => { log("B_no_proto_open"); try { wsB.close(); } catch {} };
    wsB.onerror = (e: any) => log("B_no_proto_error", { msg: String(e?.message ?? e) });
    wsB.onclose = (e: any) => log("B_no_proto_close", { code: e?.code, reason: e?.reason });
  } catch (e) {
    log("B_ctor_throw", { msg: String(e) });
  }
  const httpsUrl = server.replace(/^wss:/, "https:");
  fetch(httpsUrl, { method: "GET" })
    .then((r) => log("C_https_fetch_done", { status: r.status }))
    .catch((e) => log("C_https_fetch_error", { msg: String(e?.message ?? e) }));
  fetch("https://app.connectcomunications.com/api/health")
    .then((r) => log("D_api_fetch_done", { status: r.status }))
    .catch((e) => log("D_api_fetch_error", { msg: String(e?.message ?? e) }));
}

// [RUNTIME_PROOF / Step 0] Per-JS-runtime identity + counters. These are
// module-scope, so each React runtime that evaluates this bundle gets its OWN
// __JS_RUNTIME_TAG and resets these counters. If two DISTINCT __JS_RUNTIME_TAG
// values (or registerGlobals count=1 logged twice with different tags) appear
// in one PID, a duplicate React runtime booted (the 2026-06-19 regression).
const __JS_RUNTIME_TAG = Math.random().toString(36).slice(2, 8);
let __registerGlobalsCount = 0;
let __uaCreateCount = 0;
let __registeredOkCount = 0;

/**
 * Bridge the inbound SIP-leg lifecycle to the native incoming-call service so
 * it can stop the ringtone at voicemail / answered-elsewhere even when the app
 * is backgrounded and the floating/full-screen native UI is shown instead of
 * the React incoming-call screen (where INVITE_POLL / SIP_CANCEL_BRIDGE run).
 * JsSIP event callbacks keep firing in the background; JS timers do not — so
 * the debounce that distinguishes a real teardown from a ring-group fork
 * handoff lives natively. No-op off Android / when the module is absent.
 */
function notifyNativeInboundLeg(state: "gone" | "alive"): void {
  if (Platform.OS !== "android") return;
  try {
    const mod = (NativeModules as any)?.IncomingCallUi;
    if (!mod) return;
    if (state === "gone") {
      if (typeof mod.notifyInboundLegGone === "function") mod.notifyInboundLegGone();
    } else if (typeof mod.notifyInboundLegAlive === "function") {
      mod.notifyInboundLegAlive();
    }
  } catch {
    /* ignore — native bridge best-effort */
  }
}

/**
 * Native end-of-call cleanup that must NOT depend on the React tree: clear
 * the in-call foreground notification and release any Telecom anchor
 * Connection (tc-anchor-*). SipContext's call-ended effect normally does
 * both, but after a recents-swipe the tree is unmounted while the call (and
 * this module) live on — a remote hangup then left a stale "in call"
 * notification and an ACTIVE phantom Telecom call. Both native calls are
 * idempotent, so running alongside SipContext's cleanup is harmless.
 */
function nativeCallEndedCleanup(reason: string, noLiveSessions?: () => boolean): void {
  // ── iOS: tear down an orphaned CallKit call ───────────────────────────────
  // (Izzy 2026-08-02: "that green pill on top is back. There is no active
  // phone call." / "the lock-screen active call screen somehow also comes
  // active. I have to hang it up separately.")
  //
  // This whole function was Android-only, so iOS had NO last-session-ended
  // safety net: when the SIP session died without CallKit being told, the
  // system call stayed up forever — green pill, live lock-screen call UI, and
  // an AVAudioSession the OS still believes is in a call.
  //
  // Fires only when the LAST live session ended, and re-verifies liveness
  // after a short settle so a back-to-back inbound call is never killed.
  if (Platform.OS === "ios") {
    // VERIFIED teardown (2026-08-02, Izzy: "when I hang up the Connect, I have
    // to go separately and hang up the native active call screen for the green
    // pill to go away"). This used to be ONE unverified shot: end the CallKit
    // calls at 1.2s and assume it worked. When that single end did not take,
    // the system call — and the pill — survived the whole Connect call, and the
    // only way out was hanging up a second time by hand.
    //
    // Now it re-checks and re-issues. Every pass re-evaluates `noLiveSessions()`
    // FIRST (the standing rule from the build-43 zombie-call regression: a
    // deferred call action must re-verify its precondition at fire time), so a
    // back-to-back inbound call is never torn down by a previous call's cleanup.
    //
    // ⛔ The FIRST pass stays at 1200ms on purpose. On iOS the CallKit call is
    // reported from the VoIP push BEFORE the SIP session exists, so a shorter
    // settle can see "no live sessions" for a call that is legitimately arriving
    // and kill its ring. Do not shorten it — the retries below are what make the
    // teardown reliable, not an earlier first attempt.
    const ATTEMPT_DELAYS_MS = [1200, 800, 800];
    let elapsed = 0;
    ATTEMPT_DELAYS_MS.forEach((gap, index) => {
      elapsed += gap;
      setTimeout(() => {
        try {
          if (noLiveSessions && !noLiveSessions()) return; // a new call is up — leave it alone
          console.log(
            `[CALLKIT_ORPHAN] no live SIP session after ${reason} — ending stale CallKit calls (pass ${index + 1}/${ATTEMPT_DELAYS_MS.length})`,
          );
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const ck = require("./callkeep") as typeof import("./callkeep");
          ck.endAllNativeCalls();
        } catch {
          /* best effort */
        }
      }, elapsed);
    });
    return;
  }
  if (Platform.OS !== "android") return;
  try {
    const mod = (NativeModules as any)?.IncomingCallUi;
    if (!mod) return;
    console.log(`[IN_CALL_NOTIF] nativeCallEndedCleanup reason=${reason}`);
    if (typeof mod.stopInCallNotification === "function") mod.stopInCallNotification();
    if (typeof mod.telecomTerminateAnchors === "function") mod.telecomTerminateAnchors();
    // Post-call audio-state watchdog: catch a stranded MODE_IN_COMMUNICATION
    // (blocks other apps' recording, degrades the next call's audio path).
    // Delayed so the deferred native Connection.destroy() settles first; the
    // native EXIT_CALL path re-checks at 2.5s/8s as well.
    if (typeof mod.resetCallAudioState === "function") {
      setTimeout(() => {
        try { mod.resetCallAudioState(); } catch { /* best effort */ }
      }, 1200);
    }
  } catch {
    /* ignore — native bridge best-effort */
  }
}

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
      if (Platform.OS === "ios") {
        // iOS: setSpeakerphoneOn is an Android-only no-op. The cross-platform
        // API is setForceSpeakerphoneOn — true forces the loudspeaker, false
        // releases the override so iOS routes to Bluetooth (if connected) or
        // the earpiece. Without this, the speaker button does nothing on iOS.
        m.setForceSpeakerphoneOn(on);
      } else {
        m.setSpeakerphoneOn(on);
        // When speaker=false: Android routes to Bluetooth headset if one is
        // connected, otherwise earpiece — this is the expected behaviour.
      }
    } catch { /* module not linked */ }
  },
  /** Explicitly route audio to a Bluetooth headset. */
  routeToBluetooth() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("react-native-incall-manager").default;
      if (Platform.OS === "ios") {
        // iOS auto-selects a connected Bluetooth HFP device once the speaker
        // override is released. There is no explicit "choose BT" on iOS.
        m.setForceSpeakerphoneOn(false);
      } else if (typeof m.chooseAudioRoute === "function") {
        m.chooseAudioRoute("BLUETOOTH");
      }
    } catch { /* ignore */ }
  },
  /** Explicitly route audio to earpiece. */
  routeToEarpiece() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("react-native-incall-manager").default;
      if (Platform.OS === "ios") {
        m.setForceSpeakerphoneOn(false);
      } else if (typeof m.chooseAudioRoute === "function") {
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
  /**
   * Epoch ms when the in-flight register attempt started. Together with the
   * transport state this detects a STUCK attempt: WebSocket dialing for
   * seconds with no `connected` event (observed live 2026-07-27: a single
   * ws connect hung 10.6 s after a swipe-kill restart, and every caller —
   * including the user's Answer — silently queued behind it).
   */
  private registerAttemptStartedAtMs = 0;
  /** Monotonic id per register attempt — guards settle() from clobbering a newer attempt's promise. */
  private registerAttemptSeq = 0;
  /** Settles (rejects) the current in-flight attempt when we abandon it for a fresh UA. */
  private abortRegisterAttempt: ((reason: string) => void) | null = null;
  /**
   * If the ws transport hasn't connected this long into an attempt, the
   * attempt is torn down and rejected so callers retry on a FRESH WebSocket.
   *
   * MUST be > 10 s. RN Android's WebSocketModule uses OkHttp with a fixed 10 s
   * connect timeout PER ROUTE, tried sequentially. On IPv6-only carriers
   * (T-Mobile: DNS64/NAT64), the synthesized IPv6 route to the PBX's
   * non-443 wss port blackholes (verified live 2026-07-27: curl -6 to
   * m.connectcomunications.com:8089 times out, curl -4 connects instantly),
   * so EVERY cold connect legitimately takes ~10.4 s: 10 s dead-v6 timeout,
   * then instant IPv4 fallback. A 4 s watchdog killed every attempt before
   * the fallback could run — the app could never register on cellular.
   */
  private static readonly REGISTER_CONNECT_WATCHDOG_MS = 12_000;
  /**
   * An in-flight attempt older than this with no socket is "stuck" — new
   * register() calls rebuild instead of queueing. Must also exceed the 10 s
   * carrier fallback window, otherwise an answer-time register() tears down a
   * connect that was about to succeed at ~10.4 s.
   */
  private static readonly REGISTER_ATTEMPT_STUCK_MS = 12_500;
  /**
   * Standing-mode NAT keepalive: SIP OPTIONS ping over the registered wss
   * socket. T-Mobile's CGNAT silently killed an idle standing socket within
   * ~5 min of the last traffic (live 2026-07-27: keepalive healthy at 01:57,
   * socket already dead when the 02:00 call rang — the caller then paid a
   * ~10 s cold reconnect before the INVITE could even arrive). A cheap
   * OPTIONS round-trip every 45 s holds the carrier's mapping open AND
   * detects a silently-dead socket within a minute instead of at ring time.
   * A short register_expires can't do this job: the PBX enforces
   * minimum_expiration=600.
   */
  private optionsKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Per-call RTCPeerConnection config (iceServers incl. TURN, transport
   * policy, candidate pool). Built at UA construction and passed EXPLICITLY
   * to ua.call() / session.answer() — JsSIP discards UA-level pcConfig, so
   * relying on `ua._configuration.pcConfig` shipped every call with an empty
   * config (no STUN/TURN at all) since forever. See 2026-07-29 audio saga.
   */
  private callPcConfig: Record<string, unknown> | null = null;
  private static readonly OPTIONS_KEEPALIVE_INTERVAL_MS = 45_000;
  /** Set by hangup() — lets an in-flight answer wait exit immediately instead of running out its deadline. */
  private answerWaitAbortedAtMs = 0;
  /** Answer-pipeline start marker; answer waits ignore aborts requested before this. */
  private answerFlowStartedAtMs = 0;
  /** Epoch ms of the most recent successful SIP REGISTER. */
  private registeredAtMs: number | null = null;
  /** Epoch ms of the last refresh REGISTER written by sendRegisterRefresh(). */
  private lastRefreshSentAtMs = 0;
  /** Epoch ms of the most recent inbound INVITE (newRTCSession, remote). */
  private lastIncomingInviteAtMs = 0;
  /**
   * How long after an inbound INVITE the singleton UA is protected from
   * teardown / replacement. A wake push can register this UA and receive the
   * INVITE before SipContext mounts; when SipContext then mounts / the app
   * foregrounds, its register / unregister paths must ATTACH to this UA rather
   * than restart it (which abandons the SIP fork → "rings then voicemail").
   * Covers the brief gap between an initial INVITE and a fork re-INVITE too.
   */
  private static readonly INVITE_ANSWER_WINDOW_MS = 20_000;
  private callStartedAt: number | null = null;
  /** Last outbound dial target (normalized) for flight-recorder correlation. */
  private lastOutboundDialTarget: string | null = null;
  private callDirection: "outbound" | "inbound" = "outbound";
  /**
   * Phase 1 / Option 2A — Android-only inbound-answer mic prewarm.
   * Mic MediaStream acquired during the incoming ring so JsSIP `answer()`
   * can skip its internal getUserMedia. Owned by this client and released on
   * every terminal / no-answer path — never held after a call ends. At most
   * one stream is warmed at a time (prewarm only fires when no session exists).
   */
  private prewarmedInboundStream: MediaStream | null = null;
  /**
   * Mid-call network handoff queued while the WSS transport was down.
   * Set by tryIceRestart() during break-before-make handovers; flushed by the
   * UA "connected" handler once the socket is back. Null = nothing pending.
   */
  private pendingIceRestartReason: string | null = null;

  /**
   * Ringback staleness token. dial() starts the local ringback via an async
   * continuation; if the call confirms/ends/fails (or early media arrives)
   * BEFORE that continuation runs, the ringback must NOT start — on Android it
   * is a native looping tone that nothing would ever stop (live bug
   * 2026-07-28: ringback kept playing over a connected call, doubled with the
   * carrier's early-media ringback). Every teardown/connect path bumps the
   * generation; the deferred start only fires if its generation is current.
   */
  private ringbackGen = 0;

  /** Invalidate any pending/current local ringback, then stop call audio. */
  private stopCallAudioAndRingback(): void {
    this.ringbackGen += 1;
    stopAllTelephonyAudio().catch(() => undefined);
  }

  /**
   * Software receive gain on the remote audio track(s) (react-native-webrtc
   * `_setVolume`, linear, >1 amplifies). Android caps the VOICE_CALL stream
   * ceiling below the stock dialer's speakerphone loudness; SipContext applies
   * a >1 gain while the user is on speaker and 1.0 otherwise (earpiece stays
   * natural, AEC unstressed). Applied per receiver — safe to call repeatedly.
   */
  setReceiveVolume(gain: number): void {
    try {
      const pcs = new Set<any>();
      for (const s of this.sessionsById.values()) {
        if ((s as any)?.connection) pcs.add((s as any).connection);
      }
      if ((this.session as any)?.connection) pcs.add((this.session as any).connection);
      let applied = 0;
      for (const pc of pcs) {
        const receivers = typeof pc.getReceivers === "function" ? pc.getReceivers() : [];
        for (const r of receivers) {
          const t = r?.track;
          if (t && t.kind === "audio" && typeof (t as any)._setVolume === "function") {
            (t as any)._setVolume(gain);
            applied += 1;
          }
        }
      }
      if (applied > 0) console.log(`[SIP_AUDIO] receive gain=${gain} applied to ${applied} track(s)`);
    } catch (e) {
      console.warn('[SIP_AUDIO] setReceiveVolume failed:', e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Most recent live-ping stats snapshot that carried real RTP numbers.
   * Fallback source for the end-of-call quality report when the peer
   * connection is already closed (see startLivePing / collectAndSubmit).
   * Reset at the start of every call.
   */
  private lastLivePingStats: Record<string, unknown> | null = null;

  /** Guards against overlapping getUserMedia prewarm acquisitions. */
  private prewarmInFlight = false;
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
  /** Incremented on each answerIncoming() — stale pipelines bail without side effects. */
  private activeAnswerEpoch = 0;
  /** Callback for submitting quality reports — injected by the context layer. */
  onCallQualityReport?: (report: Record<string, unknown>) => void;
  /** Callback for sending live mid-call pings — injected by the context layer. */
  onCallQualityPing?: (snapshot: Record<string, unknown>) => void;
  /** Redacted WebRTC/SIP failure capture — posts to /voice/diag/webrtc-sdp-debug. */
  onWebrtcCallDebug?: (payload: Record<string, unknown>) => void;
  private outboundBlackbox: MobileWebrtcBlackboxRecorder | null = null;
  private inboundBlackbox: MobileWebrtcBlackboxRecorder | null = null;
  private blackboxIdentity: Record<string, unknown> = {};

  configure(bundle: ProvisioningBundle) {
    this.bundle = bundle;
    this.blackboxIdentity = {
      sipUsername: bundle.sipUsername ?? null,
      authUsername: bundle.authUsername ?? null,
      extensionNumber: bundle.sipUsername?.replace(/_\d+$/, "") ?? null,
    };
  }

  setBlackboxContext(ctx: Record<string, unknown>) {
    this.blackboxIdentity = { ...this.blackboxIdentity, ...ctx };
  }

  /** Start inbound black-box at answer-tap (before SIP poll) with push/UI timeline. */
  beginInboundBlackbox(inviteId: string | null | undefined, meta?: Record<string, unknown>) {
    const key = inviteId ?? undefined;
    if (!this.inboundBlackbox || this.inboundBlackbox.correlationId !== key) {
      this.inboundBlackbox = new MobileWebrtcBlackboxRecorder(key);
      this.inboundBlackbox.setIdentity(this.blackboxIdentity as any);
      this.inboundBlackbox.setClient(this.buildBlackboxClient());
      this.inboundBlackbox.setRegistration({
        registrationState: this.isRegistered() ? "registered" : "not_registered",
        registrationAgeMs: this.registeredAtMs ? Date.now() - this.registeredAtMs : null,
        wssConnected: this.isConnected(),
        sipStackHealthy: this.isConnected() && this.isRegistered(),
      });
    }
    if (meta && Object.keys(meta).length > 0) {
      this.inboundBlackbox.setInboundMeta(meta);
    }
  }

  /** Emit inbound failure when answer pipeline aborts outside answerIncoming(). */
  finalizeInboundBlackboxFailure(input: {
    inviteId?: string | null;
    pbxCallId?: string | null;
    callerNumber?: string | null;
    calleeExtension?: string | null;
    failureReason: string;
    backendAccept?: Record<string, unknown> | null;
    uiState?: Record<string, unknown> | null;
    pushMeta?: Record<string, unknown> | null;
    forceRestart?: { decided?: boolean; reason?: string | null };
  }) {
    this.beginInboundBlackbox(input.inviteId, {
      pushMeta: input.pushMeta ?? undefined,
      uiState: input.uiState ?? undefined,
      backendAccept: input.backendAccept ?? undefined,
      forceRestart: input.forceRestart ?? undefined,
      answer_failure: { reason: input.failureReason, tsMs: Date.now() },
    });
    const payload = this.inboundBlackbox!.buildInboundFailurePayload({
      inviteId: input.inviteId ?? null,
      pbxCallId: input.pbxCallId ?? null,
      callerNumber: input.callerNumber ?? null,
      calleeExtension: input.calleeExtension ?? null,
      failureReason: input.failureReason,
      backendAccept: input.backendAccept ?? null,
      uiState: input.uiState ?? null,
      pushMeta: input.pushMeta ?? null,
      forceRestart: input.forceRestart ?? undefined,
      incomingSessionSnapshot: this.buildIncomingSessionSnapshot(
        {
          inviteId: input.inviteId,
          fromNumber: input.callerNumber,
          toExtension: input.calleeExtension,
          pbxCallId: input.pbxCallId,
        },
        { failureReason: input.failureReason },
      ),
      sipAnswer: { attempted: false, sent: false, confirmed: false },
    });
    this.emitWebrtcCallDebug(payload);
  }

  private buildBlackboxClient(): Record<string, unknown> {
    return {
      platform: Platform.OS,
      ...(this.blackboxIdentity.client as Record<string, unknown> | undefined),
    };
  }

  setEvents(events: SipEvents) {
    this.events = events;
  }

  /**
   * PUBLIC register — strictly serialized. ROOT CAUSE of the ghost double
   * registration (quad-notification incident, 2026-07-29): at app start
   * several paths (SipContext mount, singleton auto-register, wake handler)
   * call register() concurrently. The in-flight dedupe below only engages
   * once `registerPromise` is assigned, which happens AFTER several awaits —
   * two callers entering in the same tick both saw no UA and BOTH built one.
   * The loser's UA was orphaned but stayed alive, registered, and refreshing
   * forever → a second PBX contact → every inbound call forked/rang twice
   * (or more, one ghost per race). Serializing makes the race impossible:
   * caller B runs only after caller A's attempt fully settles, then hits the
   * "already registered" fast path.
   */
  private registerSerial: Promise<unknown> = Promise.resolve();

  async register(options?: { forceRestart?: boolean }) {
    // A forceRestart register is the incoming-call wake path — a caller is
    // literally waiting. It must NOT queue patiently behind an in-flight
    // attempt whose socket is still dialing: serialization made the Luxure
    // 2026-07-30 wake register take 27.2s (two stacked 12s connect watchdogs
    // before its own attempt even started) while the PBX dialed a dead AOR
    // and the caller went to voicemail. Abort the stalled attempt NOW so the
    // wake's own attempt starts on a fresh socket immediately. A connected
    // socket mid-REGISTER is left alone — that exchange settles in <1s and
    // aborting it would only add work.
    //
    // ⛔ ANDROID ONLY (owner directive, Izzy 2026-07-31). This abort belongs to
    // the ANDROID registration-drop work and was never meant to run on iOS —
    // it reached iPhone only because it landed in shared code. The platforms
    // have fundamentally different reachability models:
    //
    //   Android must hold a standing SIP registration, because that socket is
    //   how a call reaches the phone. A stalled connect there = a missed call,
    //   so aborting and restarting is the right trade.
    //
    //   iOS does NOT need to be registered between calls. An incoming call
    //   arrives as an APNs VoIP push, which wakes the app and reports the call
    //   to CallKit whether or not SIP happened to be up. Aborting and rebuilding
    //   the socket on iOS therefore buys nothing and costs a great deal: it
    //   tore the UA down and rebuilt it every 20-60s (a new contact URI each
    //   time, live-observed 2026-07-31), so a call landing in one of those gaps
    //   found the AOR dead and went to voicemail after ~9s.
    //
    // Keep the platforms separate. iOS keeps the pre-existing serialized
    // behaviour that was working.
    if (
      Platform.OS === "android" &&
      options?.forceRestart === true &&
      this.registerPromise &&
      !this.isConnected()
    ) {
      this.abortRegisterAttempt?.("superseded: forceRestart wake register");
    }
    const run = this.registerSerial.then(() => this.registerInner(options));
    this.registerSerial = run.catch(() => undefined);
    return run;
  }

  private async registerInner(options?: { forceRestart?: boolean }) {
    if (!this.bundle) throw new Error("Missing provisioning bundle");
    const forceRestart = options?.forceRestart === true;

    if (this.registerPromise) {
      // A register attempt is already in flight. Normally we dedupe onto it,
      // BUT if its WebSocket has been dialing for several seconds with no
      // `connected` event the attempt is presumed stuck (dead TCP path) —
      // queueing behind it just inherits the stall (live failure 2026-07-27:
      // answer register waited 7.4 s on a maintenance attempt whose ws
      // connect hung 10.6 s). Tear it down and build a fresh UA + socket.
      const attemptAgeMs = Date.now() - this.registerAttemptStartedAtMs;
      const stuck =
        !this.isConnected() &&
        attemptAgeMs > JsSipClient.REGISTER_ATTEMPT_STUCK_MS;
      if (!stuck) {
        return this.registerPromise;
      }
      console.warn(
        `[SIP] register: in-flight attempt stuck (ws connecting ${attemptAgeMs}ms, no socket) — rebuilding UA on a fresh WebSocket`,
      );
      this.abortRegisterAttempt?.(
        `superseded: ws connect stuck ${attemptAgeMs}ms`,
      );
      // abortRegisterAttempt() settles the old promise and clears state; fall
      // through to the normal (re)build path below.
    }

    // Never tear down the UA during the inbound-INVITE answer window.
    // A force-restart would stop the UA and reject the pending INVITE.
    // This guard fires regardless of forceRestart — SipContext's mount
    // auto-register, the AppState "active" listener (foreground), the wake
    // handler and the reconnect orchestrator all funnel through here. When a
    // wake push has already registered this singleton UA and the INVITE has
    // arrived (or is about to re-deliver on a fork), any of those would
    // otherwise clobber the UA holding the INVITE → the caller hears voicemail
    // while the phone still rings. `inInviteAnswerWindow()` also covers the
    // brief gap between an initial INVITE and its fork re-INVITE.
    if (this.ua && this.inInviteAnswerWindow()) {
      console.log('[SIP] register: attaching to existing UA — inbound INVITE window active' + (forceRestart ? ' (force-restart suppressed)' : ''));
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
    runWsProbeOnce(this.bundle.sipWsUrl);

    // Register WebRTC globals (static import — avoids Metro bundler hoisting issues)
    try {
      registerWebRTCGlobals();
      __registerGlobalsCount += 1;
      console.log('[SIP] WebRTC globals registered OK');
      console.log(`[RUNTIME_PROOF] registerGlobals count=${__registerGlobalsCount} jsRuntimeTag=${__JS_RUNTIME_TAG}`);
    } catch (e) {
      console.warn('[SIP] WebRTC registerGlobals() failed:', e);
    }

    // Native OkHttp socket (IPv4-first DNS, 6 s connect timeout, native-thread
    // pings) — fixes the ~10.5 s IPv6 blackhole every fresh connect paid on
    // T-Mobile's IPv6-only network via RN's built-in WebSocket. Falls back to
    // the stock WebSocketInterface where the native module is absent (iOS).
    let socket: unknown;
    if (isNativeSipSocketAvailable()) {
      console.log('[SIP_SOCKET] using native OkHttp socket (ipv4-first)');
      socket = new NativeSipSocket(this.bundle.sipWsUrl);
    } else {
      socket = new (JsSIP as any).WebSocketInterface(this.bundle.sipWsUrl);
    }

    const iceServers = this.bundle.iceServers?.length
      ? this.bundle.iceServers
      : [{ urls: "stun:stun.l.google.com:19302" }];

    // authUsername = the PJSIP auth object name (e.g. "T2_103_1" in VitalPBX 4).
    // This goes into the SIP Authorization header and MUST match what the PBX expects.
    // It is often different from the SIP URI user (extension number).
    const authUsername = this.bundle.authUsername || this.bundle.sipUsername;
    console.log('[SIP] URI user:', this.bundle.sipUsername, '| Auth user:', authUsername);

    // ── Per-call RTCPeerConnection config ─────────────────────────────────
    // CRITICAL (2026-07-29): JsSIP DISCARDS `pcConfig` passed at UA
    // construction — `ua._configuration.pcConfig` is undefined (verified
    // against the installed jssip). The old `this.ua._configuration?.pcConfig
    // ?? {}` pattern therefore sent EVERY call out with an EMPTY config: no
    // STUN, no TURN, no candidate pool — calls survived on peer-reflexive
    // luck, which is exactly the fragility Izzy felt on 5G. This object is
    // now stored on the client and passed EXPLICITLY to ua.call() and
    // session.answer().
    this.callPcConfig = {
      iceServers,
      // Server-controlled per-device experiment: "relay" forces media
      // through the TURN server (cleaner path on lossy cellular direct
      // routes); default "all". Flag arrives via /mobile/devices/register
      // featureFlags; telemetry decides winners.
      iceTransportPolicy: isForceTurnRelayEnabled() ? "relay" : "all",
      // Pre-gather ICE candidates (incl. TURN allocations) the moment the
      // RTCPeerConnection is created — for inbound calls that is at INVITE
      // arrival, DURING the ring, so the answer SDP is ready instantly at tap.
      iceCandidatePoolSize: 1,
    };
    console.log(
      `[SIP] pcConfig: iceServers=${iceServers.length} policy=${(this.callPcConfig as any).iceTransportPolicy}`,
    );

    const uaConfig: Record<string, unknown> = {
      sockets: [socket],
      uri: `sip:${this.bundle.sipUsername}@${this.bundle.sipDomain}`,
      authorization_user: authUsername,
      password: this.bundle.sipPassword,
      register: true,
      session_timers: false,
    };

    // NOTE: a short register_expires was tried as a NAT keepalive but the PBX
    // enforces minimum_expiration=600, so sub-10-min refreshes get rejected.
    // Standing-mode keepalive is instead the OPTIONS ping loop
    // (startOptionsKeepalive), which needs no PBX cooperation.

    if (this.bundle.outboundProxy) {
      uaConfig.outbound_proxy_set = this.bundle.outboundProxy;
    }

    // Pin a persisted per-install instance id so the registrar de-dups our
    // AOR binding across wakes instead of stacking a new random contact each
    // time (the root cause of cold-answer -> voicemail).
    //  - iOS: always on (shipped earlier).
    //  - Android: only when the server-controlled standingRegistration flag is
    //    on for this device. Random-per-UA contacts are what made the PBX
    //    re-INVITE dead sockets after every UA rebuild; a stable +sip.instance
    //    makes each re-register REPLACE the previous binding. Flag off ⇒
    //    JsSIP default (today's behaviour), untouched.
    const wantStableInstanceId =
      Platform.OS === "ios" ||
      (Platform.OS === "android" && isStandingRegistrationEnabled());
    if (wantStableInstanceId) {
      try {
        uaConfig.instance_id = await getStableSipInstanceId();
        console.log(`[SIP] stable instance_id (${Platform.OS}):`, uaConfig.instance_id);
      } catch (e) {
        console.warn("[SIP] instance_id resolve failed (fallback random):", e);
      }
    }

    this.ua = new (JsSIP as any).UA(uaConfig);
    __uaCreateCount += 1;
    (this.ua as any).__uaId = __uaCreateCount;
    console.log(`[RUNTIME_PROOF] ua_created uaId=${__uaCreateCount} jsRuntimeTag=${__JS_RUNTIME_TAG}`);

    const attemptId = ++this.registerAttemptSeq;
    this.registerAttemptStartedAtMs = Date.now();
    const attemptUa = this.ua;
    this.registerPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (cb: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        clearTimeout(connectWatchdogId);
        // Only clear shared state if a newer attempt hasn't replaced us —
        // a late settle from an abandoned attempt must not clobber the
        // replacement attempt's promise/abort hook.
        if (this.registerAttemptSeq === attemptId) {
          this.registerPromise = null;
          this.abortRegisterAttempt = null;
        }
        cb();
      };
      const timeoutId = setTimeout(() => {
        const msg = "SIP registration timed out";
        console.warn("[SIP] Registration timeout");
        settle(() => reject(new Error(msg)));
      }, 20_000);
      // Connect watchdog: if the WebSocket hasn't reached `connected` in
      // time, this attempt's socket is presumed dead. Fail FAST so callers
      // (answer pipeline retry loop, maintenance task retry) rebuild on a
      // fresh WebSocket instead of waiting out the 20 s cap.
      const connectWatchdogId = setTimeout(() => {
        if (settled) return;
        if (this.isConnected()) return; // socket up — REGISTER exchange continues under the 20 s cap
        const msg = `sip_connect_watchdog: ws not connected within ${JsSipClient.REGISTER_CONNECT_WATCHDOG_MS}ms`;
        console.warn(`[SIP] ${msg} — tearing down attempt for a fresh socket`);
        try {
          (attemptUa as any).__jsSipClientReplaced = true;
          attemptUa.stop();
        } catch { /* ignore */ }
        if (this.ua === attemptUa) this.ua = null;
        settle(() => reject(new Error(msg)));
      }, JsSipClient.REGISTER_CONNECT_WATCHDOG_MS);
      // Allow a newer register() call to abandon this attempt when it's stuck.
      this.abortRegisterAttempt = (reason: string) => {
        if (settled) return;
        try {
          (attemptUa as any).__jsSipClientReplaced = true;
          attemptUa.stop();
        } catch { /* ignore */ }
        if (this.ua === attemptUa) this.ua = null;
        settle(() => reject(new Error(`sip_register_attempt_aborted: ${reason}`)));
      };

      this.ua.on("registered", () => {
        __registeredOkCount += 1;
        console.log('[SIP] Registered successfully');
        console.log(`[RUNTIME_PROOF] register_ok count=${__registeredOkCount} uaId=${(this.ua as any)?.__uaId} jsRuntimeTag=${__JS_RUNTIME_TAG}`);
        this.registeredAtMs = Date.now();
        this.startOptionsKeepalive();
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
      // ---- Do Not Disturb: decline the inbound INVITE IMMEDIATELY with a final
      // response so the PBX diverts the call straight to voicemail — no ring, no
      // ringback dragged out for the full ring-group timeout.
      //
      // History: an earlier attempt silenced the leg but kept sending 180 Ringing
      // with no final response, so the call just rang out instead of going to
      // voicemail (the user's "DND only mutes my phone, it never sends to
      // voicemail" report). We previously feared 486 because it looped the ring
      // group — but that loop was the telephony "mobile invite requeue" AMI
      // Redirect (now gated on a live extension leg), NOT the 486 itself. With
      // that fixed, an instant decline diverts to voicemail cleanly (confirmed
      // live: the WebRTC desk's own decline reaches voicemail "right away" with
      // no loop). A 486 is a final response, so the extension's Dial() leg ends
      // immediately → DIALSTATUS busy/failover → voicemail. We never touch
      // outbound or already-active calls.
      if (e.originator === "remote" && getDnd()) {
        console.log("[SIP][DND] inbound INVITE declined with 486 Busy (DND on) — diverting straight to voicemail");
        try {
          e.session?.terminate?.({ status_code: 486, reason_phrase: "Busy Here" });
        } catch (err) {
          console.warn("[SIP][DND] failed to send 486 on DND INVITE:", err);
        }
        // A DND decline is still a missed call. The native FCM service records
        // the pending missed-call entry (and posts the notification); nudge the
        // JS drain so it lands in Recent promptly even while the app is already
        // foreground (mount / AppState-active drains won't fire in that case).
        try {
          DeviceEventEmitter.emit("connect.dndMissed");
        } catch {
          /* non-fatal */
        }
        return;
      }

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
        const callerName = this.getSessionFromDisplayName(e.session) || null;
        const toUser = this.getSessionTo(e.session);
        const inviteArrivedAt = Date.now();
        (e.session as any)._inviteArrivedAt = inviteArrivedAt;
        // Authoritative per-session "this is an inbound ring leg" marker. The
        // closure-captured `isOutboundSession` in bindSession proved unreliable
        // for ring-group forks (1 of 3 forks mis-classified), letting a fork
        // CANCEL stop the native ringtone ~1s into the ring. This marker is set
        // the instant the INVITE arrives and never mutates, so the failed/ended
        // handlers can decide "keep the native ringtone alive" deterministically.
        (e.session as any)._inboundRingLeg = true;
        const rawUser = this.getSessionFromUser(e.session);
        const rawDisplayName = this.getSessionFromDisplayName(e.session);
        console.log('[SIP] Incoming SIP INVITE —', JSON.stringify({
          from: callerNumber, callerName,
          rawUser, rawDisplayName,
          to: toUser,
          incomingSessionsBefore: this.incomingSessions.length,
          sessionsById: this.sessionsById.size,
          ts: inviteArrivedAt,
        }));
        this.incomingSessions.push(e.session);
        // Open the answer-window: protects this UA from teardown/replacement by
        // a late SipContext mount / foreground re-register while the user is
        // about to answer (see INVITE_ANSWER_WINDOW_MS / inInviteAnswerWindow).
        this.lastIncomingInviteAtMs = Date.now();
        this.events.onIncomingInviteReceived?.({
          sessionId: sipSessionId,
          from: callerNumber,
          to: toUser,
          callerName,
        });
        // JsSIP automatically sends 100 Trying + 180 Ringing after newRTCSession fires.
        // No manual call needed — the PBX will see 180 Ringing within milliseconds.

        this.setSessionState(e.session, "ringing");
        this.events.onIncomingCall?.(callerNumber, callerName);
        this.events.onCallState?.("ringing");
        this.emitSessionAdded(e.session);
        // Android inbound ringing is owned by the native incoming-call service.
        // Starting JS ringtone here causes late or duplicate ringing once the app opens.
        if (Platform.OS !== "android") {
          initAudioSession().then(() => startRingtone()).catch(() => undefined);
        } else {
          console.log("[SIP] Android inbound INVITE received — leaving ringtone to native incoming-call flow");
          // Tell the native service a live inbound leg exists (initial INVITE
          // or a ring-group fork re-INVITE) so any pending fork-abandon stop is
          // cancelled — the call is still being offered to this device.
          notifyNativeInboundLeg("alive");
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
      // Flush a deferred mid-call ICE restart (see tryIceRestart): the network
      // changed while the socket was down; now that transport is back, move
      // the media to the new interface. Small delay lets JsSIP finish its
      // transport-recovery bookkeeping before we send the re-INVITE.
      if (this.pendingIceRestartReason) {
        const deferredReason = this.pendingIceRestartReason;
        this.pendingIceRestartReason = null;
        setTimeout(() => {
          try {
            if (this.hasActiveSession()) this.tryIceRestart(deferredReason + ":deferred");
          } catch (err) {
            console.warn('[SIP_ICE_RESTART] deferred flush threw:', err);
          }
        }, 300);
      }
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
      this.stopOptionsKeepalive();
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

  /**
   * Fire-and-forget REGISTER refresh, even when the client believes it is
   * registered. Needed because that belief goes STALE in the background:
   * Android pauses all JS timers when the app is backgrounded (verified
   * 2026-07-27: frozen even during an active HeadlessJS task on Samsung One
   * UI), so JsSIP's own ~600 s refresh timer never fires, the PBX silently
   * expires the contact, and incoming calls skip this phone on the initial
   * dial. The native heartbeat calls this via the maintenance headless task.
   *
   * DELIBERATELY TIMER-FREE: no awaiting, no setTimeout. In the background
   * only event-driven JS runs (socket data, native module events) — a
   * timer-based timeout would freeze and hang the caller until the app is
   * foregrounded (observed live: a stuck 22:57 maintenance tick only
   * completed at 23:02 when the activity resumed). Success is observed
   * asynchronously by the persistent UA "registered" handler updating
   * registeredAtMs; the NEXT tick decides the socket is dead if that
   * timestamp goes stale (see headlessMaintenanceRegisterSip).
   *
   * Returns true if a REGISTER was actually written toward the socket.
   */
  sendRegisterRefresh(): boolean {
    const ua = this.ua;
    if (!ua) return false;
    try {
      if (!(ua as any)._transport?.isConnected?.() || !ua.isRegistered?.()) return false;
      // UA.register() sends a fresh REGISTER even when already registered.
      ua.register();
      this.lastRefreshSentAtMs = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Failure detector for the maintenance tick: did our own refresh REGISTER
   * (sendRegisterRefresh) go unanswered? True only when a refresh was actually
   * written to the socket, no `registered` event arrived after it, and enough
   * time has passed for a reply. This deliberately does NOT use wall-clock
   * registration age: the heartbeat alarm is inexact and Android defers it
   * (observed 2026-07-28: a 240 s alarm fired after 420 s), so an age
   * threshold false-positives on the first deferred tick and force-restarts a
   * perfectly healthy UA — unregistering from the PBX in the process.
   */
  isRefreshUnanswered(): boolean {
    if (!this.lastRefreshSentAtMs) return false;
    if ((this.registeredAtMs ?? 0) >= this.lastRefreshSentAtMs) return false;
    return Date.now() - this.lastRefreshSentAtMs > 30_000;
  }

  // ── Standing-mode OPTIONS keepalive — WIRE-TRUTH edition ────────────────
  // 2026-07-29 incident (Landau 101, caller heard nothing / callback never
  // "answered"): the 5G socket died silently (half-open), JsSIP's REGISTER
  // refresh vanished into it, and the app dialed on an 11-minute-old
  // registration while believing "Already registered". Three holes fixed:
  //  1. flag-hydration race could skip starting this loop entirely (silent),
  //  2. the transport/registered gate silently returned instead of signalling,
  //  3. an OPTIONS with NO response (half-open socket) triggered nothing —
  //     only explicit failures did. Now every ping has a 10s response
  //     deadline, and a registration-age watchdog forces a reconnect when
  //     the PBX's 600s grant is about to lapse without a confirmed refresh.
  private startOptionsKeepalive() {
    if (Platform.OS !== "android") return;
    this.stopOptionsKeepalive();
    // Await flag hydration — a cold-start register can beat AsyncStorage and
    // the sync flag read, which silently left sessions with NO keepalive.
    void getFeatureFlags().then((flags) => {
      if (!flags.standingRegistration) {
        console.log("[SIP_KEEPALIVE_PING] standingRegistration off — keepalive not started");
        return;
      }
      if (this.optionsKeepaliveTimer != null) return; // raced with a newer start
      console.log(
        `[SIP_KEEPALIVE_PING] started interval=${JsSipClient.OPTIONS_KEEPALIVE_INTERVAL_MS}ms (wire-truth)`,
      );
      this.optionsKeepaliveTimer = setInterval(() => {
        // ── Phantom-anchor watchdog (Izzy 2026-07-29: "make sure it doesn't
        // happen again") ─────────────────────────────────────────────────────
        // A Telecom anchor Connection with NO live SIP session is a leak: it
        // pins MODE_IN_COMMUNICATION system-wide, silencing voicemail/media
        // playback until the app is force-stopped (live repro: TC@216 stuck
        // ACTIVE after a never-confirmed outbound). The ended/failed handlers
        // now clean up correctly, but this sweep guarantees ANY missed path
        // self-heals within one keepalive tick (45s).
        if (Platform.OS === "android" && this.sessionsById.size === 0) {
          try {
            const mod = (NativeModules as any)?.IncomingCallUi;
            if (
              mod &&
              typeof mod.telecomHasAnyLiveConnection === "function" &&
              mod.telecomHasAnyLiveConnection() === true &&
              typeof mod.telecomTerminateAnchors === "function"
            ) {
              console.warn("[SIP_KEEPALIVE_PING] phantom Telecom anchor with zero SIP sessions — terminating (leak watchdog)");
              mod.telecomTerminateAnchors();
              if (typeof mod.resetCallAudioState === "function") {
                setTimeout(() => { try { mod.resetCallAudioState(); } catch { /* ignore */ } }, 1500);
              }
            }
          } catch { /* watchdog is best-effort */ }
        }
        const ua = this.ua;
        if (!ua) return;
        let transportUp = false;
        try {
          transportUp = (ua as any)._transport?.isConnected?.() === true;
        } catch { /* treat as down */ }
        if (!transportUp || !ua.isRegistered?.()) {
          // Never silently skip — say so and kick the reconnect machinery.
          console.warn(
            `[SIP_KEEPALIVE_PING] gate: transportUp=${transportUp} registered=${!!ua.isRegistered?.()} — signalling disconnect`,
          );
          try { this.events.onSocketDisconnected?.("options_keepalive_gate"); } catch { /* ignore */ }
          return;
        }
        // Registration-age watchdog: PBX grants 600s. Older than 540s with no
        // confirmed refresh = the refresh died on a half-open socket. Force a
        // rebuild regardless of what JsSIP believes.
        const regAge = this.getRegistrationAgeMs();
        if (regAge != null && regAge > 540_000) {
          console.warn(`[SIP_KEEPALIVE_PING] registration stale ageMs=${regAge} — forcing reconnect`);
          try {
            this.events.onRegistrationState?.("disconnected");
            this.events.onSocketDisconnected?.("registration_stale");
          } catch { /* ignore */ }
          return;
        }
        const sentAt = Date.now();
        // Response deadline: half-open sockets produce NO failure event (the
        // 32s SIP timer proved unreliable here) — 10s of silence = dead wire.
        let settled = false;
        const deadline = setTimeout(() => {
          if (settled) return;
          settled = true;
          console.warn("[SIP_KEEPALIVE_PING] no response in 10s — socket presumed dead, signalling disconnect");
          try {
            this.events.onRegistrationState?.("disconnected");
            this.events.onSocketDisconnected?.("options_keepalive_timeout");
          } catch { /* ignore */ }
        }, 10_000);
        try {
          ua.sendOptions(`sip:${this.bundle?.sipDomain}`, undefined, {
            eventHandlers: {
              succeeded: () => {
                if (settled) return;
                settled = true;
                clearTimeout(deadline);
                const rttMs = Date.now() - sentAt;
                // Log slow round-trips only; a healthy ping every 45 s would
                // drown the logs.
                if (rttMs > 2_000) {
                  console.log(`[SIP_KEEPALIVE_PING] slow rtt=${rttMs}ms`);
                }
              },
              failed: (e: any) => {
                if (settled) return;
                settled = true;
                clearTimeout(deadline);
                const cause = e?.cause || "unknown";
                console.warn(
                  `[SIP_KEEPALIVE_PING] failed cause=${cause} — socket presumed dead, signalling disconnect`,
                );
                try {
                  this.events.onRegistrationState?.("disconnected");
                  this.events.onSocketDisconnected?.(`options_keepalive_failed:${cause}`);
                } catch { /* ignore */ }
              },
            },
          });
        } catch (err) {
          settled = true;
          clearTimeout(deadline);
          console.warn('[SIP_KEEPALIVE_PING] sendOptions threw:', err);
          try { this.events.onSocketDisconnected?.("options_send_threw"); } catch { /* ignore */ }
        }
      }, JsSipClient.OPTIONS_KEEPALIVE_INTERVAL_MS);
    });
  }

  private stopOptionsKeepalive() {
    if (this.optionsKeepaliveTimer != null) {
      clearInterval(this.optionsKeepaliveTimer);
      this.optionsKeepaliveTimer = null;
    }
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

  /**
   * Live-update the ICE server set (fresh TURN credentials). pcConfig rides
   * per-call (see callPcConfig), so the NEXT call picks these up without any
   * UA rebuild or re-register. Called by SipContext once the auth token is
   * available — the cold-boot configure paths (module singleton, provisioning
   * cache) run before the token loads and can't fetch fresh servers
   * themselves.
   */
  updateIceServers(iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>): void {
    if (!Array.isArray(iceServers) || iceServers.length === 0) return;
    if (this.bundle) this.bundle.iceServers = iceServers;
    if (this.callPcConfig) (this.callPcConfig as any).iceServers = iceServers;
    console.log(`[SIP] iceServers live-updated (${iceServers.length} entries)`);
  }

  getRegistrationAgeMs(): number | null {
    if (!this.registeredAtMs || !this.isRegistered()) return null;
    return Math.max(0, Date.now() - this.registeredAtMs);
  }

  private isSessionLive(session: any): boolean {
    const status = (session as any)?._status;
    return status !== 8;
  }

  private countLiveIncomingSessions(): number {
    return this.incomingSessions.filter((s) => this.isSessionLive(s)).length;
  }

  /**
   * True while an inbound INVITE is live OR arrived so recently a fork
   * re-INVITE may still be in flight. During this window the singleton UA MUST
   * NOT be stopped or replaced — the SIP INVITE (and the native incoming ring,
   * which arrives on the same call) would be dropped, sending the caller to
   * voicemail while the phone still rings. Used to make SipContext's mount /
   * foreground / wake / reconnect register + logout_teardown unregister attach
   * to this UA instead of restarting it.
   */
  private inInviteAnswerWindow(): boolean {
    try {
      if (this.countLiveIncomingSessions() > 0) return true;
    } catch {
      /* ignore */
    }
    return (
      this.lastIncomingInviteAtMs > 0 &&
      Date.now() - this.lastIncomingInviteAtMs < JsSipClient.INVITE_ANSWER_WINDOW_MS
    );
  }

  private emitOutboundTrace(
    stage: "OUTBOUND_INVITE_SENT" | "OUTBOUND_RINGING" | "OUTBOUND_CONNECTED" | "OUTBOUND_FAILED" | "OUTBOUND_ENDED",
    extra?: {
      sipCode?: number | null;
      sipReason?: string | null;
      sipCause?: string | null;
      failedOriginator?: string | null;
    },
  ): void {
    this.events.onOutboundTrace?.({
      stage,
      timestamp: Date.now(),
      dialedNumber: this.lastOutboundDialTarget,
      normalizedNumber: this.lastOutboundDialTarget,
      registrationAgeMs: this.getRegistrationAgeMs(),
      sipCode: extra?.sipCode ?? null,
      sipReason: extra?.sipReason ?? null,
      sipCause: extra?.sipCause ?? null,
      failedOriginator: extra?.failedOriginator ?? null,
    });
  }

  hasActiveSession(): boolean {
    try {
      if (this.countLiveIncomingSessions() > 0) return true;
      for (const s of this.sessionsById.values()) {
        if (this.isSessionLive(s)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Mid-call network handoff (standing-registration feature — caller gates on
   * the server flag). When the default network changes under an active call
   * (Wi-Fi ⇄ LTE/5G), the existing RTP path dies with the old interface. A
   * plain UA reconnect can't help — it would tear the session down. The SIP
   * fix is an ICE restart: renegotiate the established session with
   * iceRestart:true so WebRTC gathers fresh candidates on the new network and
   * a re-INVITE moves the media without dropping the call.
   *
   * Returns the number of sessions a restart was dispatched for (0 = nothing
   * to do). Failures are logged and swallowed — worst case the call behaves
   * exactly as it does today (dies on network switch).
   */
  tryIceRestart(reason: string): number {
    // Break-before-make handover (observed live: Wi-Fi → 5G, 2026-07-28): the
    // old interface's WSS dies BEFORE the new network's socket is up. Firing
    // renegotiate() now would push the re-INVITE into a dead transport and
    // JsSIP terminates the whole session with cause "Connection Error" — the
    // recovery itself kills the call. Defer: stash the request and let the
    // UA "connected" handler flush it once the socket is back (1–2 s later).
    // (Make-before-break, 5G → Wi-Fi, keeps the old socket alive long enough
    // that the immediate path below still works — same as before.)
    try {
      if (this.ua && typeof this.ua.isConnected === "function" && !this.ua.isConnected()) {
        if (this.hasActiveSession()) {
          this.pendingIceRestartReason = reason;
          console.log(`[SIP_ICE_RESTART] deferred until socket reconnect reason=${reason}`);
        }
        return 0;
      }
    } catch { /* fall through — attempt the immediate restart */ }
    let dispatched = 0;
    try {
      const seen = new Set<any>();
      const candidates: any[] = [];
      for (const s of this.sessionsById.values()) candidates.push(s);
      if (this.session) candidates.push(this.session);
      for (const session of candidates) {
        if (!session || seen.has(session)) continue;
        seen.add(session);
        try {
          if (typeof session.isEstablished !== "function" || !session.isEstablished()) continue;
          if (typeof session.renegotiate !== "function") continue;
          const ok = session.renegotiate({
            rtcOfferConstraints: { iceRestart: true },
          });
          console.log(`[SIP_ICE_RESTART] renegotiate(iceRestart) ${ok ? "dispatched" : "refused"} reason=${reason} sessionId=${this.getSessionIdSafe(session) ?? "?"}`);
          if (ok) dispatched += 1;
        } catch (e) {
          console.warn(`[SIP_ICE_RESTART] session renegotiate threw (${reason}):`, e instanceof Error ? e.message : String(e));
        }
      }
    } catch (e) {
      console.warn(`[SIP_ICE_RESTART] tryIceRestart threw (${reason}):`, e instanceof Error ? e.message : String(e));
    }
    return dispatched;
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
    // IDEMPOTENCY GUARD — a session must be bound exactly once. Observed live
    // 2026-07-28: the [SIP_SDP] log fired twice for the SAME local offer,
    // proving double-attached listeners. Double handlers double every piece
    // of session work (audio setup on confirmed, stats collection + native
    // cleanup on ended, telemetry posts) — enough JS-thread load to make
    // answer/hangup taps visibly laggy once the telemetry callbacks were
    // actually wired. Root-fix: mark and skip.
    if ((session as any)._ccHandlersBound) {
      console.log('[SIP] bindSession skipped — already bound sessionId=' + (this.getSessionIdSafe(session) ?? '?'));
      return;
    }
    (session as any)._ccHandlersBound = true;
    const isOutboundSession = !this.incomingSessions.includes(session);

    // Opus preference (both directions — offers AND answers). Wideband on
    // extension-to-extension calls; in-band FEC makes every call resilient to
    // mobile packet loss. The first live test (2026-07-28 ~11:29) sounded
    // "quiet/horrible" — but that call ran on a phone stranded in the previous
    // call's stuck MODE_IN_COMMUNICATION state (verified via dumpsys), so it
    // was not a fair codec test. Re-enabled together with the audio-state
    // watchdog that guarantees a clean state per call. If a CLEAN-state test
    // still shows a volume drop, tune PBX-side opus gain — don't revert.
    // ICE-gathering stall-proofing (2026-07-29): JsSIP waits for gathering to
    // COMPLETE before sending the SDP. Any unreachable/mis-credentialed ICE
    // server (e.g. TURN with expired HMAC creds) stalls completion for tens of
    // seconds — observed live as "calls not connecting at all". This caps the
    // wait: 1.5s after the newest candidate, send with whatever paths exist.
    // Dead servers cost 1.5s, never the call.
    //
    // INBOUND FAST PATH (2026-07-30): the resetting 1.5s cap gated the 200 OK
    // behind ≥1.5s of candidate silence — it single-handedly killed the
    // instantaneous answer the 07-28 push achieved (which had unknowingly been
    // riding the empty-pcConfig bug: no servers → gathering trivially done →
    // answer out at tap). Owner bar: answer must be instantaneous. For inbound
    // answers under the default "all" policy the answer SDP goes out at the
    // first public-route (srflx/relay) candidate — typically ~100ms — or a
    // hard, NON-resetting 500ms cap, whichever first. Host-only-after-500ms is
    // exactly the SDP shape every call shipped for months pre-07-29, and the
    // PBX has a public IP + full ICE (peer-reflexive), so media still connects.
    // Outbound offers and relay-forced calls keep the 1.5s stall cap: under
    // "relay" policy a relay candidate is mandatory, and that path is where
    // the dead-creds stall incident actually happened. Do not remove either.
    let iceReadyTimer: ReturnType<typeof setTimeout> | null = null;
    let iceReadyFired = false;
    const fireIceReady = (ev: any, why: string) => {
      if (iceReadyFired) return;
      iceReadyFired = true;
      if (iceReadyTimer) { clearTimeout(iceReadyTimer); iceReadyTimer = null; }
      console.log(`[SIP] ice ready (${why}) — sending SDP with gathered candidates`);
      try { ev.ready(); } catch { /* already completed */ }
    };
    session.on("icecandidate", (ev: any) => {
      if (typeof ev?.ready !== "function" || iceReadyFired) return;
      const policy = String((this.callPcConfig as any)?.iceTransportPolicy ?? "all");
      if (!isOutboundSession && policy !== "relay") {
        const candStr = String(ev?.candidate?.candidate ?? "");
        if (/ typ (srflx|relay)/.test(candStr)) {
          fireIceReady(ev, "answer: public-route candidate");
          return;
        }
        if (!iceReadyTimer) {
          iceReadyTimer = setTimeout(() => fireIceReady(ev, "answer: 500ms cap"), 500);
        }
        return;
      }
      if (iceReadyTimer) clearTimeout(iceReadyTimer);
      iceReadyTimer = setTimeout(() => fireIceReady(ev, "capped at 1.5s"), 1500);
    });

    // Server-controlled codec switch (Izzy 2026-08-01). Read per call, not
    // per app-start, so flipping the flag takes effect on the NEXT call with no
    // reinstall. Default (flag absent) = true = today's exact behaviour.
    // Set disableOpusSdp on the device row to fall back to plain G.711 (PCMU),
    // the codec every call used before 2026-07-28.
    const PREFER_OPUS_SDP = !isOpusSdpDisabled();
    console.log(`[SIP_SDP] opus preference ${PREFER_OPUS_SDP ? "ON" : "OFF (G.711)"}`);
    if (PREFER_OPUS_SDP) {
      session.on("sdp", (e: any) => {
        try {
          if (e && typeof e.sdp === "string") {
            const mLine = (sdp: string) => (sdp.match(/^m=audio.*$/m)?.[0] ?? "no-m-audio").slice(0, 90);
            if (e.originator === "local") {
              const before = mLine(e.sdp);
              // OFFERS: opus-only (proven for months — outbound HD works).
              // ANSWERS: reorder only. Two outages on 2026-07-30 proved the
              // app cannot force HD on INBOUND calls from the SDP layer:
              //  • opus-only LOCAL answer → wire says opus, libwebrtc still
              //    sends PCMU (setLocalDescription gets createAnswer's
              //    ORIGINAL) → PBX drops every mic packet → ONE-WAY AUDIO.
              //  • opus-only REMOTE offer → setRemoteDescription rejects →
              //    488 → INBOUND CALLS DON'T CONNECT AT ALL.
              // Inbound HD is a PBX-side task (endpoint codec prefs so the
              // PBX offers opus first to the app). Until then inbound rides
              // PCMU: some hiss, but calls connect and mics work.
              e.sdp = e.type === "offer" ? preferOpusOnlyOffer(e.sdp) : preferOpusInSdp(e.sdp);
              console.log(`[SIP_SDP] local ${e.type}: ${before} -> ${mLine(e.sdp)}`);
            } else {
              // ⛔ NEVER munge the REMOTE offer. ⛔ (2026-07-30, second
              // outage of the day.) Stripping narrowband here IS applied to
              // setRemoteDescription — mechanically correct — but it made
              // inbound calls fail to establish entirely: answer sent, never
              // confirmed, caller hears ringing until the 30s dial timeout
              // (diagnosis INBOUND_SESSION_NOT_FOUND_TIMEOUT; JsSIP replies
              // 488 when setRemoteDescription rejects the edited offer).
              // Inbound HD must be solved on the PBX side (endpoint codec
              // config / transcode), never by editing SDP the app receives.
              console.log(`[SIP_SDP] remote ${e.type}: ${mLine(e.sdp)}`);
            }
          }
        } catch (err) {
          console.warn('[SIP_SDP] opus preference munge failed:', err instanceof Error ? err.message : String(err));
        }
      });
    }

    session.on("progress", (e: any) => {
      const code = e?.response?.status_code;
      console.log('[CALL_EVENT] progress status=' + code);
      // Inbound sessions stay "ringing"; outbound sessions transition from
      // "dialing" to "ringing" once the remote side is alerting (180).
      if (this.callDirection === "outbound") {
        this.setSessionState(session, "ringing");
      }
      if (isOutboundSession && (code === 180 || code === 183)) {
        this.emitOutboundTrace("OUTBOUND_RINGING", {
          sipCode: typeof code === "number" ? code : null,
          sipReason: e?.response?.reason_phrase ?? null,
          sipCause: e?.cause ?? null,
        });
      }
      // Early media (183 with SDP): the carrier streams its own ringback tone
      // over RTP. Kill the locally generated ringback or the user hears both
      // layered (reported live 2026-07-28: US tone + a second double-ring
      // cadence in parallel).
      if (isOutboundSession && code === 183 && typeof e?.response?.body === "string" && e.response.body.length > 0) {
        console.log('[AUDIO] early media detected (183 w/ SDP) — stopping local ringback');
        this.stopCallAudioAndRingback();
      }
      this.events.onCallState?.("ringing");
    });

    // EARLY CONNECT (inbound only): JsSIP fires `accepted` the moment our
    // 200 OK goes on the wire — ~700 ms before `confirmed` (which waits for
    // the PBX's ACK, delayed by its answer-time macros: recording setup,
    // sub-before-bridging gosubs). A desk/GSM phone flips to "connected" at
    // answer, not at ACK — mirror that for the UI. Audio routing, live-ping,
    // and ghost bookkeeping stay on `confirmed` (unchanged below); the ghost
    // machinery already covers a 200-OK-then-cancel race via its
    // "never confirmed" case.
    session.on("accepted", () => {
      if (isOutboundSession) return;
      if (this.ghostSessions.has(session)) return;
      console.log('[CALL_EVENT] session_accepted — early connect (inbound 200 OK sent)');
      if (!this.callStartedAt) this.callStartedAt = Date.now();
      this.setSessionState(session, "connected");
      this.events.onCallState?.("connected");
    });

    session.on("confirmed", () => {
      console.log('[CALL_EVENT] session_confirmed');
      this.sessionConfirmedAt.set(session, Date.now());
      if (this.ghostSessions.has(session)) {
        console.warn('[CALL_EVENT] session_confirmed ignored — marked as ghost');
        return;
      }
      this.stopCallAudioAndRingback();
      ICM.start("audio");
      // Refresh device list and re-apply the desired route. This was
      // previously a hard `routeToEarpiece()` 150 ms after confirmed,
      // which yanked audio away from a connected Bluetooth headset.
      // The route manager respects: user override > BT > wired > earpiece.
      setTimeout(() => {
        audioRouteManager.refreshDevices(getAudioDevicesSnapshot());
        audioRouteManager.noteCallConnected();
      }, 150);
      if (!this.callStartedAt) this.callStartedAt = Date.now();
      this.setSessionState(session, "connected");
      this.events.onCallState?.("connected");
      if (isOutboundSession) {
        this.emitOutboundTrace("OUTBOUND_CONNECTED");
      }
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
      // See the `failed` handler: an unanswered inbound fork that ENDs (BYE on
      // a fork the PBX is reaping) must not stop the native ringtone mid-ring
      // while the ring group is still alerting. Leave it to the authoritative
      // stop paths on Android.
      const endedWasUnansweredInbound =
        ((session as any)._inboundRingLeg === true || !isOutboundSession) &&
        !this.sessionConfirmedAt.has(session);
      const endedKeepRingtoneAlive =
        Platform.OS === "android" && endedWasUnansweredInbound;
      if (isLastLiveSession && !endedKeepRingtoneAlive) {
        this.stopCallAudioAndRingback();
        this.stopLivePing();
        ICM.stop();
        audioRouteManager.noteCallEnded();
        restoreAudioSession().catch(() => undefined);
        // No call remains — release the prewarmed mic if still held. Skipped
        // while endedKeepRingtoneAlive (a ring-group fork ended but the ring
        // continues), so the prewarm survives for the eventual answer.
        this.releasePrewarmedMedia("session_ended");
      } else if (endedKeepRingtoneAlive) {
        console.log(
          "[MULTICALL] session_ended_cleanup keep_ringtone_alive — unanswered inbound fork end, leaving native ringtone to authoritative stop paths",
        );
        // Background-safe teardown: the native service debounces this for a
        // re-INVITE; if the call really rolled to voicemail / was answered
        // elsewhere, it stops the ringtone where the JS poll never runs.
        notifyNativeInboundLeg("gone");
      }
      this.collectAndSubmitQualityReport(cause).catch(() => {});
      if (this.session === session) this.session = null;
      if (this.incomingSessions.length === 0) this.lastAnswerMatch = undefined;
      this.setSessionState(session, "ended");
      this.removeSession(session);
      if (isOutboundSession) {
        this.emitOutboundTrace("OUTBOUND_ENDED", { sipCause: cause });
      }
      if (isLastLiveSession) {
        this.events.onCallState?.("ended");
        // React-tree-independent teardown of the in-call notification and the
        // Telecom anchor. Gated on confirmed so an unanswered fork's BYE can
        // never disturb the ring-phase notification — INBOUND only. OUTBOUND
        // sessions always clean up: the dial-time anchor exists BEFORE
        // confirmation, so a busy/declined/canceled outbound that never
        // confirmed used to LEAK an ACTIVE phantom Telecom call that held
        // MODE_IN_COMMUNICATION forever and silenced all media playback
        // (live repro 2026-07-29: stuck TC@216, voicemails inaudible).
        if (this.sessionConfirmedAt.has(session) || !(session as any)._inboundRingLeg) {
          nativeCallEndedCleanup("session_ended", () => this.listSessions().length === 0);
        }
      }
      this.flushGhostRetryCallbacks("failed");
    });

    session.on("failed", (e: any) => {
      const fields = extractJsSipFailureFields(e);
      const cause = fields.failedCause || "unknown";
      const code = fields.sipStatusCode;
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
      // Ring-group fork storm: a forked inbound INVITE that is CANCELed before
      // it was ever answered must NOT stop the native ringtone. The PBX forks
      // the call to multiple contacts and rapidly CANCELs + re-INVITEs each
      // fork while the caller is still ringing; calling stopAllTelephonyAudio
      // on every fork CANCEL kills the native ring ~1-2s in even though the
      // call is still live. On Android the native incoming-call service owns
      // the ringtone — leave it to the authoritative stop paths (answer /
      // decline / INVITE_CANCELED FCM / INVITE_POLL killAll). Outbound and
      // already-answered (confirmed) inbound legs are unaffected.
      const wasUnansweredInbound =
        ((session as any)._inboundRingLeg === true || !isOutboundSession) &&
        !this.sessionConfirmedAt.has(session);
      const keepRingtoneAlive =
        Platform.OS === "android" && wasUnansweredInbound;
      if (isLastLiveSession && !keepRingtoneAlive) {
        this.stopCallAudioAndRingback();
        this.stopLivePing();
        ICM.stop();
        audioRouteManager.noteCallEnded();
        restoreAudioSession().catch(() => undefined);
        // No call remains — release the prewarmed mic if still held. Skipped
        // while keepRingtoneAlive (unanswered inbound fork cancel during an
        // active ring), so the prewarm survives for the eventual answer.
        this.releasePrewarmedMedia("session_failed");
      } else if (keepRingtoneAlive) {
        console.log(
          "[MULTICALL] session_failed_cleanup keep_ringtone_alive — unanswered inbound fork cancel, leaving native ringtone to authoritative stop paths",
        );
        // Background-safe teardown: the native service debounces this for a
        // re-INVITE; if the call really rolled to voicemail / was answered
        // elsewhere, it stops the ringtone where the JS poll never runs.
        notifyNativeInboundLeg("gone");
      }
      this.collectAndSubmitQualityReport(cause).catch(() => {});
      if (this.session === session) this.session = null;
      if (this.incomingSessions.length === 0) this.lastAnswerMatch = undefined;
      this.setSessionState(session, "ended");
      this.removeSession(session);
      if (isOutboundSession) {
        this.emitOutboundTrace("OUTBOUND_FAILED", {
          sipCode: typeof code === "number" ? code : null,
          sipReason: fields.sipReasonPhrase,
          sipCause: cause,
          failedOriginator: fields.failedOriginator,
        });
        const payload = this.outboundBlackbox?.buildOutboundFailurePayload({
          targetRaw: this.lastOutboundDialTarget,
          targetNormalized: this.lastOutboundDialTarget,
          session,
          failedEvent: e,
          offerSdp: (() => {
            try { return session.connection?.localDescription?.sdp ?? null; } catch { return null; }
          })(),
          dialMeta: {
            uaCallInvoked: true,
            sessionReturned: true,
            sessionId: this.getSessionIdSafe(session),
          },
          mediaMeta: { constraints: VOICE_AUDIO_CONSTRAINTS },
          wssConnected: this.isConnected(),
          channelNotCreated: true,
        });
        if (payload) this.emitWebrtcCallDebug(payload);
      }
      if (isLastLiveSession) {
        this.events.onCallState?.("ended");
        // Same React-tree-independent native teardown as the "ended" handler.
        // Outbound always cleans up — see the anchor-leak note there (a failed
        // outbound is exactly the busy/declined path that leaked TC@216).
        if (this.sessionConfirmedAt.has(session) || !(session as any)._inboundRingLeg) {
          nativeCallEndedCleanup("session_failed", () => this.listSessions().length === 0);
        }
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
      // an interval on stalled calls. Only runs when latency measurement is
      // actually on: with it off this was still firing ~8 getStats bridge
      // round-trips per second through the call-connect window for marks
      // that would be discarded anyway.
      if (isCallLatencyEnabled() && typeof pc.getStats === "function") {
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

      // ── [MIC_PROBE] iOS dead-mic evidence collector (2026-07-30) ──────────
      // Prints, once per second for the first 15s of a confirmed call, the
      // hard numbers that localize where outgoing audio dies:
      //   trackLive/trackEnabled/trackMuted — did getUserMedia hand us a live
      //     mic track and is it capturing?
      //   audioLevel — is the capture unit hearing ANYTHING (0.00 = silence)?
      //   packetsSent — is our voice actually leaving the phone as RTP?
      // Diagnostic-only: reads state, never touches the session or routing.
      try {
        const pc: any = (session as any).connection;
        if (pc && typeof pc.getStats === "function") {
          const probeStart = Date.now();
          const probe = setInterval(async () => {
            if (Date.now() - probeStart > 15_000 || !pc || pc.connectionState === "closed") {
              clearInterval(probe);
              return;
            }
            try {
              let trackInfo = "no-sender";
              try {
                const senders = typeof pc.getSenders === "function" ? pc.getSenders() : [];
                const audioSender = (senders || []).find((s: any) => s?.track && s.track.kind === "audio");
                const t = audioSender?.track;
                if (t) {
                  trackInfo =
                    "live=" + String(t.readyState === "live") +
                    " enabled=" + String(t.enabled) +
                    " muted=" + String(!!t.muted);
                }
              } catch { trackInfo = "sender-err"; }
              let packetsSent: number | null = null;
              let audioLevel: number | null = null;
              const stats = await pc.getStats();
              const each = (cb: (r: any) => void) => {
                if (stats && typeof (stats as any).forEach === "function") (stats as any).forEach(cb);
                else if (Array.isArray(stats)) stats.forEach(cb);
              };
              each((r: any) => {
                if (r?.type === "outbound-rtp" && (r.kind === "audio" || r.mediaType === "audio")) {
                  if (typeof r.packetsSent === "number") packetsSent = r.packetsSent;
                }
                if (r?.type === "media-source" && (r.kind === "audio" || r.mediaType === "audio")) {
                  if (typeof r.audioLevel === "number") audioLevel = r.audioLevel;
                }
              });
              console.log(
                "[MIC_PROBE] t=" + Math.round((Date.now() - probeStart) / 1000) + "s" +
                " track(" + trackInfo + ")" +
                " audioLevel=" + (audioLevel === null ? "n/a" : (audioLevel as number).toFixed(3)) +
                " packetsSent=" + (packetsSent === null ? "n/a" : String(packetsSent)),
              );
            } catch (e) {
              console.log("[MIC_PROBE] stats-err " + String((e as any)?.message ?? e));
            }
          }, 1000);
        } else {
          console.log("[MIC_PROBE] no peerconnection on confirmed session");
        }
      } catch (e) {
        console.log("[MIC_PROBE] setup-err " + String((e as any)?.message ?? e));
      }
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
      confirmedAtMs: this.sessionConfirmedAt.get(session) ?? null,
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
        this.stopCallAudioAndRingback();
        this.stopLivePing();
        ICM.stop();
        audioRouteManager.noteCallEnded();
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
      newer.answer(this.buildAnswerOptions());
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
    const user = String(session?.remote_identity?.uri?.user || "");
    const displayName = String(session?.remote_identity?.display_name || "");

    // VitalPBX ring groups apply a prefix to CallerIDName and put the result in
    // the SIP From: display name, e.g. "New Tires:8453050021" (when no CNAM is
    // available the caller's PSTN number appears after the colon) or
    // "New Tires:John Smith" (when CNAM is available).
    //
    // Strategy:
    //   1. If display_name has colon format "Prefix:CallerInfo" and the part
    //      after the colon IS a phone number (7+ digits), use that number as
    //      the caller number — it is the most authoritative source.
    //   2. If the caller-info part is a name (not a number), fall through and
    //      use uri.user when it is a PSTN number (7+ digits).
    //   3. Otherwise fall back to display_name so the ring group prefix is at
    //      least preserved in call history (old behaviour for unknown formats).
    const colonIdx = displayName.indexOf(":");
    if (colonIdx > 0) {
      const afterColon = displayName.slice(colonIdx + 1).replace(/:$/, "").trim();
      const afterColonDigits = afterColon.replace(/\D/g, "");
      if (afterColonDigits.length >= 7) {
        // "New Tires:8453050021" — the caller number is in the display name.
        return afterColon;
      }
    }

    // For non-ring-group calls OR ring-group calls where the caller has a text
    // CNAM: use uri.user when it looks like a real PSTN number (7+ digits).
    // Avoid short extensions (2–6 digits) — those are often the dialled
    // extension, not the external caller's number.
    const userDigits = user.replace(/^\+/, "").replace(/\D/g, "");
    if (userDigits.length >= 7) return user;

    // Last resort: fall back to display_name (preserves ring group prefix for
    // old-format display names like "New Tires:New Tires:").
    return displayName || user || "";
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

  private buildIncomingSessionSnapshot(
    match: SipMatch | undefined,
    input: { pollIterations?: number; answerAttempts?: number; failureReason?: string },
  ) {
    const sessions = [...this.incomingSessions];
    if (this.session && !sessions.includes(this.session)) {
      sessions.push(this.session);
    }
    const answerable = sessions.filter((session) => this.isAnswerableIncoming(session));
    return {
      incomingSessionCount: sessions.length,
      answerableSessionCount: answerable.length,
      uaConnected: this.isConnected(),
      uaRegistered: this.isRegistered(),
      sipStackHealthy: this.isConnected() && this.isRegistered(),
      pollIterations: input.pollIterations ?? null,
      answerAttempts: input.answerAttempts ?? null,
      failureReason: input.failureReason ?? null,
      newRtcsessionObserved: sessions.length > 0,
      sessionIds: sessions.map((s) => this.getSessionIdSafe(s)).filter(Boolean),
      jssipCallIds: sessions.map((s) => (s as { id?: string })?.id ?? null).filter(Boolean),
      match: match
        ? {
            inviteId: match.inviteId ?? null,
            fromNumber: match.fromNumber ?? null,
            toExtension: match.toExtension ?? null,
            pbxCallId: match.pbxCallId ?? null,
          }
        : null,
      candidates: answerable.map((session) => this.describeIncomingSession(session)),
    };
  }

  private emitWebrtcCallDebug(payload: Record<string, unknown>) {
    try {
      this.onWebrtcCallDebug?.(payload);
    } catch {
      /* best-effort */
    }
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

    // FORKED-CALL fallback (live failure 2026-07-28, three consecutive
    // SIP_ANSWER_FAILED): when the AOR holds two contacts the PBX forks one
    // call into TWO ringing sessions. The exact match misses both (it always
    // missed — the single-session fallback silently absorbed that for years)
    // and with candidateCount=2 nothing was returned, so answering timed out.
    // If every answerable session is from the SAME caller they are forks of
    // one call: answer the newest — the PBX CANCELs the other leg on 200 OK.
    // Distinct callers (true call-waiting) still fall through to the miss log.
    if (match && answerableSessions.length > 1) {
      const remoteOf = (s: any) =>
        this.normalizeNumber(String(s?.remote_identity?.uri?.user ?? ""));
      const remotes = new Set(answerableSessions.map(remoteOf));
      const expectedFrom = this.normalizeNumber(match.fromNumber || "");
      if (remotes.size === 1 && (!expectedFrom || remotes.has(expectedFrom))) {
        const fallback = answerableSessions[0];
        console.warn(
          "[SIP] findIncoming: forked-call fallback — all candidates share one caller, answering newest",
          JSON.stringify({
            expectedFrom,
            candidateCount: answerableSessions.length,
            session: this.describeIncomingSession(fallback),
          }),
        );
        return fallback;
      }
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
    // Answer-window guard: never tear down the UA while an inbound INVITE is
    // live or just arrived. logout_teardown can fire spuriously on a cold
    // wake-boot (auth token still loading), and that must not abandon the
    // INVITE the user is about to answer. A genuine logout happens with no
    // incoming call, so this does not block real sign-outs.
    if (this.ua && this.inInviteAnswerWindow()) {
      console.log('[SIP] unregister: suppressed — inbound INVITE window active (protecting UA)');
      return;
    }
    // Tag the UA as replaced so any async `disconnected` / `unregistered`
    // events fired by the closing WebSocket don't trigger the reconnect
    // orchestrator (via onSocketDisconnected). This is the user-initiated
    // teardown path — logout, explicit re-provisioning, diagnostics.
    if (this.ua) {
      try { (this.ua as any).__jsSipClientReplaced = true; } catch { /* ignore */ }
    }
    this.stopOptionsKeepalive();
    try {
      this.ua?.stop();
    } finally {
      this.ua = null;
      this.events.onRegistrationState?.("idle");
    }
  }

  async dial(target: string) {
    if (!this.bundle) throw new Error("Missing provisioning bundle");

    const normalized = normalizeMobileDialTarget(target);
    if (!normalized) throw new Error("Invalid dial target");

    const reg = await ensureOutboundSipRegistration({
      isConnected: () => this.isConnected(),
      isRegistered: () => this.isRegistered(),
      register: (options) => this.register(options),
    });
    if (!reg.ok) {
      throw new Error(reg.error || "sip_registration_timeout");
    }
    if (!this.ua) throw new Error("SIP UA not registered");

    this.lastOutboundDialTarget = normalized;
    const dest = `sip:${normalized}@${this.bundle.sipDomain}`;
    this.outboundBlackbox = new MobileWebrtcBlackboxRecorder();
    this.outboundBlackbox.setIdentity(this.blackboxIdentity as any);
    this.outboundBlackbox.setClient(this.buildBlackboxClient());
    this.outboundBlackbox.setRegistration({
      registrationState: this.isRegistered() ? "registered" : "not_registered",
      registrationAgeMs: this.getRegistrationAgeMs(),
      wssConnected: this.isConnected(),
      uaStarted: !!this.ua,
    });
    this.outboundBlackbox.mark("dial_start", { dest, normalized });
    const regAgeAtDial = this.getRegistrationAgeMs();
    console.log('[SIP] Dialing:', dest, 'regAgeMs=' + (regAgeAtDial ?? 'unknown'));
    // Last-resort guard (2026-07-29): dialing on a registration older than the
    // PBX's 600s grant sends the INVITE into the void. Kick the reconnect
    // machinery immediately — the attempt may fail fast, but the line heals in
    // seconds instead of staying silently dead.
    if (regAgeAtDial != null && regAgeAtDial > 540_000) {
      console.warn(`[SIP] dial on stale registration (ageMs=${regAgeAtDial}) — forcing reconnect`);
      try { this.events.onSocketDisconnected?.("dial_stale_registration"); } catch { /* ignore */ }
    }
    this.callDirection = "outbound";
    this.callStartedAt = Date.now();
    this.events.onCallState?.("dialing");
    // Start InCallManager early so there is always a matching stop() later.
    // On Android this sets MODE_IN_COMMUNICATION; the audio route manager
    // then chooses Bluetooth / wired / earpiece based on what's available
    // (or the user's per-call override). Ringback follows the same sink as
    // the live call audio — so a BT headset plays ringback on BT, not on
    // the earpiece.
    ICM.start("audio");
    audioRouteManager.noteCallStarted("outbound");
    audioRouteManager.refreshDevices(getAudioDevicesSnapshot());
    audioRouteManager.noteCallConnected();
    {
      const rbGen = ++this.ringbackGen;
      initAudioSession()
        .then(() => {
          if (rbGen !== this.ringbackGen) {
            console.log('[AUDIO] ringback start skipped — call state moved on (stale generation)');
            return;
          }
          return startRingback();
        })
        .catch(() => undefined);
    }
    try {
      this.outboundBlackbox.mark("ua_call_invoked");
      this.session = this.ua.call(dest, {
        mediaConstraints: VOICE_AUDIO_CONSTRAINTS,
        // Explicit per-call config — see callPcConfig doc (JsSIP discards
        // UA-level pcConfig; the old `_configuration?.pcConfig ?? {}` was
        // ALWAYS {}).
        pcConfig: this.callPcConfig ?? {},
      });
      this.outboundBlackbox.setDial({
        uaCallInvoked: true,
        sessionReturned: !!this.session,
        sessionId: this.getSessionIdSafe(this.session),
        jssipCallId: (this.session as { id?: string })?.id ?? null,
        dialedNumber: normalized,
      });
      // NOTE: do NOT call bindSession here — ua.call() fires newRTCSession
      // synchronously, which already calls bindSession. Calling it again here
      // would double-attach all event listeners, causing confirmed/ended/failed
      // to fire twice and every state update to run twice.
      console.log('[SIP] INVITE sent');
      this.emitOutboundTrace("OUTBOUND_INVITE_SENT");
    } catch (e: any) {
      this.stopCallAudioAndRingback();
      ICM.stop();
      const msg = e?.message || "dial failed";
      console.error('[SIP] Dial error:', msg);
      this.emitOutboundTrace("OUTBOUND_FAILED", {
        sipCause: msg,
      });
      this.events.onError?.(`Dial error: ${msg}`);
      this.events.onCallState?.("ended");
      throw e;
    }
  }

  /**
   * Phase 1 / Option 2A — pre-acquire the inbound mic during the ring.
   * Android-only, best-effort. On success the stream is later handed to JsSIP
   * `answer()` (see {@link buildAnswerOptions}) so its internal getUserMedia is
   * skipped, cutting the 200-OK → ICE-gathering delay. Any failure is swallowed:
   * the normal answer path re-acquires the mic itself. Never grabs the mic
   * while a call is live or when one is already warmed/in-flight.
   */
  prewarmInboundMedia(): void {
    if (Platform.OS !== "android") return;
    if (this.session) return; // only during a ring, never mid-call
    if (this.prewarmedInboundStream || this.prewarmInFlight) return;
    this.prewarmInFlight = true;
    const startedAt = Date.now();
    Promise.resolve()
      .then(() => (mediaDevices as any).getUserMedia(VOICE_AUDIO_CONSTRAINTS))
      .then((stream: MediaStream) => {
        // A call may have started, or a release fired, while we were
        // acquiring. Discard immediately so we never hold the mic outside
        // an active ring.
        if (this.session || !this.prewarmInFlight) {
          try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
          this.prewarmInFlight = false;
          return;
        }
        this.prewarmedInboundStream = stream;
        this.prewarmInFlight = false;
        console.log("[SIP][prewarm] mic_acquired ms=" + (Date.now() - startedAt));
      })
      .catch((e: any) => {
        this.prewarmInFlight = false;
        console.warn("[SIP][prewarm] mic_acquire_failed: " + (e?.message || String(e)));
      });
  }

  /**
   * Release any prewarmed inbound mic stream and cancel an in-flight acquire.
   * Idempotent and safe to call from any teardown path. JsSIP does NOT stop
   * caller-supplied tracks itself, so this is the authoritative release for a
   * prewarmed stream whether or not it was consumed by an answered call.
   */
  releasePrewarmedMedia(reason: string): void {
    this.prewarmInFlight = false;
    const stream = this.prewarmedInboundStream;
    if (!stream) return;
    this.prewarmedInboundStream = null;
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch { /* ignore */ }
    console.log("[SIP][prewarm] released reason=" + reason);
  }

  /**
   * Build JsSIP `answer()` options, injecting the prewarmed mic stream when one
   * is available so `answer()` skips its internal getUserMedia. We keep our
   * reference to the stream so the session terminal handlers can release it.
   * Falls back to internal getUserMedia (constraints only) when not prewarmed —
   * this is what preserves the normal answer path if prewarm failed/was off.
   */
  private buildAnswerOptions(): { mediaConstraints: typeof VOICE_AUDIO_CONSTRAINTS; mediaStream?: MediaStream; pcConfig?: Record<string, unknown> } {
    // pcConfig must ride on EVERY answer — see callPcConfig doc (JsSIP
    // discards UA-level pcConfig, so inbound calls otherwise get an empty
    // RTCPeerConnection config: no STUN/TURN at all).
    const pcConfig = (this.callPcConfig ?? undefined) as Record<string, unknown> | undefined;
    const stream = this.prewarmedInboundStream;
    if (stream) {
      console.log("[SIP][prewarm] answer_using_prewarmed_stream");
      return { mediaConstraints: VOICE_AUDIO_CONSTRAINTS, mediaStream: stream, ...(pcConfig ? { pcConfig } : {}) };
    }
    return { mediaConstraints: VOICE_AUDIO_CONSTRAINTS, ...(pcConfig ? { pcConfig } : {}) };
  }

  async answer() {
    this.stopCallAudioAndRingback(); // Stop ringtone on answer (also invalidates pending ringback)
    ICM.start("audio");
    audioRouteManager.noteCallStarted("inbound");
    audioRouteManager.refreshDevices(getAudioDevicesSnapshot());
    // Apply the right route immediately (BT if available, else earpiece)
    // — the previous unconditional `routeToEarpiece` ignored Bluetooth.
    setTimeout(() => audioRouteManager.noteCallConnected(), 150);
    this.session?.answer?.(this.buildAnswerOptions());
  }

  /**
   * Answer-pipeline lifecycle markers. The pipeline calls
   * `markAnswerFlowStart()` when the user taps Answer; `hangup()` stamps
   * `answerWaitAbortedAtMs`. A hangup AFTER the flow start means the user
   * gave up mid-answer — the invite waits must exit immediately instead of
   * running out their deadline (live failure 2026-07-27: user's End tap
   * killed the requeued INVITE, then the pipeline sat 16 s in
   * wait_for_incoming_invite showing a dead "Answering…" screen).
   */
  markAnswerFlowStart() {
    this.answerFlowStartedAtMs = Date.now();
  }

  isAnswerFlowAborted(): boolean {
    return (
      this.answerFlowStartedAtMs > 0 &&
      this.answerWaitAbortedAtMs > this.answerFlowStartedAtMs
    );
  }

  /**
   * Synchronous probe: is a matching inbound INVITE already live on this UA?
   * The answer pipeline uses it to skip the register gate on warm answers —
   * a present INVITE is stronger proof of a working socket+registration than
   * any register round-trip (standing registration: Asterisk dialed us
   * directly and the INVITE landed during the ring).
   */
  hasMatchingIncomingInvite(match?: SipMatch): boolean {
    try {
      return !!this.findIncoming(match);
    } catch {
      return false;
    }
  }

  async waitForIncomingInvite(
    match?: SipMatch,
    deadlineHandle?: SipAnswerDeadlineHandle,
  ): Promise<boolean> {
    const waitStartAt = Date.now();
    const deadline =
      deadlineHandle ??
      createSipAnswerDeadline(waitStartAt, MOBILE_SIP_ANSWER_INITIAL_WAIT_MS).handle;
    const getUntil = () => deadline.getUntilMs();
    this.lastAnswerMatch = match;
    console.log(
      "[CALL_EVENT] wait_for_incoming_invite start until=" + getUntil(),
    );
    // do..while — ALWAYS probe at least once, even when the deadline has
    // already lapsed. The lock-screen answer path spends ~200 ms of preamble
    // before reaching this wait; with a short pre-claim deadline the old
    // while-loop expired WITHOUT EVER CALLING findIncoming, declared the
    // (actually present) INVITE missing, and sent an already-ringing call
    // down the 9-second claim/requeue path (live failure 2026-07-27 23:46).
    do {
      if (this.isAnswerFlowAborted()) {
        console.warn(
          "[CALL_EVENT] wait_for_incoming_invite aborted (user hangup during answer) waitedMs=" +
            (Date.now() - waitStartAt),
        );
        return false;
      }
      const session = this.findIncoming(match);
      if (session) {
        console.log(
          "[CALL_EVENT] wait_for_incoming_invite found waitedMs=" +
            (Date.now() - waitStartAt),
        );
        return true;
      }
      if (Date.now() >= getUntil()) break;
      await new Promise((resolve) => setTimeout(resolve, MOBILE_SIP_ANSWER_POLL_MS));
    } while (true);
    console.warn(
      "[CALL_EVENT] wait_for_incoming_invite timeout waitedMs=" +
        (Date.now() - waitStartAt),
    );
    return false;
  }

  async answerIncoming(
    match?: SipMatch,
    timeoutMs = 5000,
    onTrace?: (event: SipAnswerTraceEvent) => void,
    deadlineHandle?: SipAnswerDeadlineHandle,
  ): Promise<boolean> {
    const answerStartAt = Date.now();
    const deadline =
      deadlineHandle ?? createSipAnswerDeadline(answerStartAt, timeoutMs).handle;
    const getUntil = () => deadline.getUntilMs();
    const MAX_ATTEMPTS = 3;
    let attempt = 0;
    const epoch = ++this.activeAnswerEpoch;
    this.lastAnswerMatch = match;
    const inviteKey = match?.inviteId ?? undefined;
    if (!this.inboundBlackbox || this.inboundBlackbox.correlationId !== inviteKey) {
      this.inboundBlackbox = new MobileWebrtcBlackboxRecorder(inviteKey);
      this.inboundBlackbox.setIdentity(this.blackboxIdentity as any);
      this.inboundBlackbox.setClient(this.buildBlackboxClient());
    }
    this.inboundBlackbox.setRegistration({
      registrationState: this.isRegistered() ? "registered" : "not_registered",
      registrationAgeMs: this.registeredAtMs ? Date.now() - this.registeredAtMs : null,
      wssConnected: this.isConnected(),
    });
    this.inboundBlackbox.mark("answer_pipeline_start", {
      inviteId: match?.inviteId ?? null,
      pbxCallId: match?.pbxCallId ?? null,
    });

    // IMPORTANT: `attempt` counts real `session.answer()` invocations only.
    // A poll iteration that finds no incoming session yet (cold-start race where
    // SIP is registered but the INVITE hasn't arrived) must NOT consume an
    // attempt slot — we just wait inside the overall time budget.
    const POLL_MS = MOBILE_SIP_ANSWER_POLL_MS;
    let inviteFoundMarked = false;
    let pollIterations = 0;
    const inviteIdForLatency = match?.inviteId ?? null;
    while (Date.now() < getUntil()) {
      if (epoch !== this.activeAnswerEpoch) {
        console.warn('[CALL_EVENT] answer_pipeline_superseded epoch=' + epoch);
        return false;
      }
      pollIterations += 1;
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
      this.stopCallAudioAndRingback();
      ICM.start("audio");
      setTimeout(() => ICM.routeToEarpiece(), 150);

      const outcome = await new Promise<"confirmed" | "ghost" | "failed">((resolve) => {
        const ANSWER_TIMEOUT_MS = Math.max(500, getUntil() - Date.now());
        let settled = false;
        const answerTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          console.warn('[CALL_EVENT] answer_timeout after ' + ANSWER_TIMEOUT_MS + 'ms');
          resolve("failed");
        }, ANSWER_TIMEOUT_MS);

        const finalize = (v: "confirmed" | "ghost" | "failed") => {
          if (settled) return;
          if (epoch !== this.activeAnswerEpoch) {
            settled = true;
            clearTimeout(answerTimer);
            resolve("failed");
            return;
          }
          settled = true;
          clearTimeout(answerTimer);
          resolve(v);
        };

        const awaitGhostRetry = () => {
          const remaining = Math.max(500, getUntil() - Date.now());
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
          const sid = this.getSessionIdSafe(session);
          const inviteId = match?.inviteId;
          if (inviteId && sid) linkCallLatencyIds(inviteId, sid);
          const answerInvokedAt = Date.now();
          markCallLatency(inviteId ?? sid, "SIP_ANSWER_INVOKED", {
            sinceAnswerStartMs: answerInvokedAt - answerStartAt,
          });
          session.answer(this.buildAnswerOptions());
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

      if (epoch !== this.activeAnswerEpoch) {
        console.warn('[CALL_EVENT] answer_pipeline_superseded_post_attempt epoch=' + epoch);
        return false;
      }
      if (outcome === "confirmed") {
        console.log('[CALL_EVENT] answer_pipeline_success attempts=' + attempt);
        return true;
      }
      if (outcome === "ghost") {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    if (epoch !== this.activeAnswerEpoch) {
      return false;
    }

    console.warn('[CALL_EVENT] answer_pipeline_exhausted attempts=' + attempt);
    const failureReason = attempt >= MAX_ATTEMPTS ? "max_attempts" : "session_not_found_timeout";
    this.emitWebrtcCallDebug(
      this.inboundBlackbox.buildInboundFailurePayload({
        inviteId: match?.inviteId ?? null,
        pbxCallId: match?.pbxCallId ?? null,
        callerNumber: match?.fromNumber ?? null,
        calleeExtension: match?.toExtension ?? null,
        failureReason,
        incomingSessionSnapshot: this.buildIncomingSessionSnapshot(match, {
          pollIterations,
          answerAttempts: attempt,
          failureReason,
        }),
        sipAnswer: {
          attempted: attempt > 0,
          sent: inviteFoundMarked,
          confirmed: false,
        },
      }),
    );
    onTrace?.({
      phase: "failed",
      timestamp: Date.now(),
      reason: failureReason,
      message: failureReason,
    });
    return false;
  }

  async rejectIncoming(match?: SipMatch): Promise<boolean> {
    const session = this.findIncoming(match);
    if (!session) return false;
    this.stopCallAudioAndRingback(); // Stop ringtone on reject (also invalidates pending ringback)
    try {
      session.terminate?.();
    } catch {}
    this.incomingSessions = this.incomingSessions.filter((x) => x !== session);
    if (this.session === session) this.session = null;
    return true;
  }

  async hangup() {
    console.log('[SIP] Hanging up');
    // If an answer pipeline is mid-flight, this hangup is the user aborting
    // it — stamp the abort so waitForIncomingInvite exits immediately (see
    // markAnswerFlowStart / isAnswerFlowAborted).
    this.answerWaitAbortedAtMs = Date.now();
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
    this.releasePrewarmedMedia("hangup");
    this.stopCallAudioAndRingback();
    this.stopLivePing();
    await this.collectAndSubmitQualityReport("user_hangup").catch(() => {});
    ICM.stop();
    audioRouteManager.noteCallEnded();
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
    // Route through the durable manager so we don't fight the BT route.
    // Speaker ON ⇒ user override = "speaker".
    // Speaker OFF ⇒ clear override (manager picks BT > wired > earpiece).
    audioRouteManager.refreshDevices(getAudioDevicesSnapshot());
    audioRouteManager.setUserOverride(speakerOn ? "speaker" : null);
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
    // Fresh call — drop the previous call's cached stats so a stale snapshot
    // can never leak into this call's final report.
    this.lastLivePingStats = null;
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
          const codecIds = new Map<string, string>();
          stats.forEach((r: any) => {
            if (r.type === "local-candidate") localCandidates.set(r.id, r.candidateType || "");
            if (r.type === "codec" && typeof r.mimeType === "string") {
              codecIds.set(r.id, r.mimeType.replace(/^audio\//, ""));
            }
          });
          stats.forEach((r: any) => {
            if (r.type === "inbound-rtp" && r.kind === "audio") {
              if (typeof r.packetsLost === "number") snapshot.packetsLost = r.packetsLost;
              if (typeof r.packetsReceived === "number") snapshot.packetsReceived = r.packetsReceived;
              if (typeof r.jitter === "number") snapshot.jitterMs = Math.round(r.jitter * 1000);
              if (typeof r.bytesReceived === "number") snapshot.bytesReceived = r.bytesReceived;
              if (r.codecId && codecIds.has(r.codecId)) snapshot.audioCodec = codecIds.get(r.codecId);
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
          // Cache the last snapshot that actually carried RTP stats. The final
          // end-of-call report often runs AFTER JsSIP closed the
          // RTCPeerConnection (remote hangup path) — getStats then returns
          // nothing and the report used to go out empty (every pre-2026-07-28
          // Android report had no rtt/loss/codec). This cache is its fallback.
          if (snapshot.packetsReceived !== undefined || snapshot.rttMs !== undefined) {
            this.lastLivePingStats = { ...snapshot };
          }
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
      // Server zod is .optional() (NOT .nullable()) for direction — a null
      // would 400 the whole report. Omit when unknown.
      ...(this.callDirection === "inbound" || this.callDirection === "outbound"
        ? { direction: this.callDirection }
        : {}),
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
          // SEND-side loss: what the far end (PBX) reports back about OUR
          // uplink via RTCP. On cellular the UPLINK is usually the weak
          // direction — without this the quality picture is half-blind
          // (Izzy 2026-07-29: "a lot of packet loss on 5G" while receive-side
          // stats looked clean).
          if (r.type === "remote-inbound-rtp" && r.kind === "audio") {
            if (typeof r.packetsLost === "number") report.txPacketsLost = r.packetsLost;
            if (typeof r.fractionLost === "number") report.txFractionLost = Math.round(r.fractionLost * 10000) / 100;
            if (typeof r.jitter === "number") report.txJitterMs = Math.round(r.jitter * 1000);
          }
          if (r.type === "outbound-rtp" && r.kind === "audio") {
            if (typeof r.packetsSent === "number") report.packetsSent = r.packetsSent;
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

    // Fallback: the PC is closed on remote-hangup paths and getStats comes
    // back empty — fill the report from the last live-ping snapshot (taken
    // every 10s during the call) so the report is never blind.
    if (report.packetsReceived === undefined && report.rttMs === undefined && this.lastLivePingStats) {
      const cached = this.lastLivePingStats;
      for (const key of [
        "rttMs", "jitterMs", "packetsLost", "packetsReceived",
        "audioCodec", "candidateType", "isUsingRelay", "audioRoute",
      ] as const) {
        if (cached[key] !== undefined && report[key] === undefined) report[key] = cached[key];
      }
      report.statsSource = "live_ping_cache";
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

    // Uplink (send-side) loss caps the grade — the far end hearing us choppy
    // is just as much a bad call as the reverse, and on cellular it's usually
    // the uplink that suffers.
    const txSent = typeof report.packetsSent === "number" ? (report.packetsSent as number) : 0;
    const txLost = typeof report.txPacketsLost === "number" ? (report.txPacketsLost as number) : 0;
    const txLossRate =
      typeof report.txFractionLost === "number"
        ? (report.txFractionLost as number)
        : txSent > 0
          ? (txLost / txSent) * 100
          : 0;
    if (txLossRate >= 3) report.qualityGrade = "poor";
    else if (txLossRate >= 1 && (report.qualityGrade === "excellent" || report.qualityGrade === "good")) {
      report.qualityGrade = "fair";
    }

    this.callStartedAt = null;
    this.onCallQualityReport?.(report);
  }
}
