import type { SipAnswerTraceEvent, SipClient, SipEvents, SipMatch } from "./types";
import type { ProvisioningBundle } from "../types";
import { registerGlobals as registerWebRTCGlobals } from "react-native-webrtc";
import JsSIP from "jssip";
import {
  startRingback,
  startRingtone,
  stopAllTelephonyAudio,
  initAudioSession,
  restoreAudioSession,
} from "../audio/telephonyAudio";

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
  private registerPromise: Promise<void> | null = null;
  private callStartedAt: number | null = null;
  private callDirection: "outbound" | "inbound" = "outbound";
  private livePingInterval: ReturnType<typeof setInterval> | null = null;
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

  async register() {
    if (!this.bundle) throw new Error("Missing provisioning bundle");

    if (this.registerPromise) {
      return this.registerPromise;
    }

    // If already registered and an incoming call is pending, do not tear down
    // the UA — stopping it would terminate the pending SIP INVITE.
    if (this.ua && this.incomingSessions.length > 0) {
      console.log('[SIP] Skipping re-register — incoming session in progress');
      return;
    }

    // If the UA is already registered and connected, skip the expensive
    // stop/restart cycle. A UA that is registered responds correctly to
    // incoming INVITEs without needing a fresh connection.
    if (this.ua && this.ua.isRegistered?.()) {
      console.log('[SIP] Already registered, skipping re-register');
      return;
    }

    // Tear down any existing UA before creating a new one
    if (this.ua) {
      try { this.ua.stop(); } catch { /* ignore */ }
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
      this.session = e.session;
      console.log('[SIP] New RTC session, originator:', e.originator);

      if (e.originator === "remote") {
        this.callDirection = "inbound";
        const callerNumber = this.getSessionFrom(e.session);
        const toUser = this.getSessionTo(e.session);
        console.log('[SIP] Incoming SIP INVITE — from:', callerNumber, '| to:', toUser,
          '| incomingSessions before:', this.incomingSessions.length);
        this.incomingSessions.push(e.session);
        this.events.onIncomingCall?.(callerNumber);
        this.events.onCallState?.("ringing");
        // Play incoming ringtone
        initAudioSession().then(() => startRingtone()).catch(() => undefined);
      }
      this.bindSession(this.session);
    });

    this.ua.on("disconnected", (e: any) => {
      console.warn('[SIP] UA disconnected:', e?.cause);
    });

    this.ua.start();
    console.log('[SIP] UA started');
    return this.registerPromise;
  }

  private bindSession(session: any) {
    session.on("progress", (e: any) => {
      const code = e?.response?.status_code;
      console.log('[SIP] Call progress, status:', code);
      this.events.onCallState?.("ringing");
      // Ringback is already started in dial() — do NOT restart here.
      // Repeated progress events would interrupt the 4s silence cadence and
      // turn the ringback into a continuous tone.
    });

    session.on("confirmed", () => {
      console.log('[SIP] Call confirmed (connected)');
      stopAllTelephonyAudio().catch(() => undefined);
      // Start InCallManager in audio mode — this sets Android AudioManager to
      // MODE_IN_COMMUNICATION which routes audio to the earpiece by default.
      ICM.start("audio");
      // Belt-and-suspenders: explicitly route to earpiece after a short settle
      // delay so MODE_IN_COMMUNICATION is fully active before we set routing.
      setTimeout(() => ICM.routeToEarpiece(), 150);
      if (!this.callStartedAt) this.callStartedAt = Date.now();
      this.events.onCallState?.("connected");
      this.startLivePing(session);
    });

    session.on("ended", (e: any) => {
      const cause = e?.cause || "normal";
      console.log('[SIP] Call ended, cause:', cause);
      stopAllTelephonyAudio().catch(() => undefined);
      this.stopLivePing();
      this.collectAndSubmitQualityReport(cause).catch(() => {});
      ICM.stop();
      restoreAudioSession().catch(() => undefined);
      this.incomingSessions = this.incomingSessions.filter((x) => x !== session);
      if (this.session === session) this.session = null;
      this.events.onCallState?.("ended");
    });

    session.on("failed", (e: any) => {
      const cause = e?.cause || "unknown";
      const code = e?.response?.status_code;
      const msg = code ? `Call failed (${code}): ${cause}` : `Call failed: ${cause}`;
      console.warn('[SIP] Call failed:', msg);
      stopAllTelephonyAudio().catch(() => undefined);
      this.stopLivePing();
      this.collectAndSubmitQualityReport(cause).catch(() => {});
      ICM.stop();
      restoreAudioSession().catch(() => undefined);
      this.incomingSessions = this.incomingSessions.filter((x) => x !== session);
      if (this.session === session) this.session = null;
      this.events.onCallState?.("ended");
      this.events.onError?.(msg);
    });
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

  private getSessionTo(session: any): string {
    return String(session?.local_identity?.uri?.user || this.bundle?.sipUsername || "");
  }

  private matchesIncoming(session: any, match?: SipMatch): boolean {
    if (!match) return true;
    const from = this.normalizeNumber(this.getSessionFrom(session));
    const targetFrom = this.normalizeNumber(match.fromNumber || "");
    if (targetFrom && from && !from.endsWith(targetFrom) && !targetFrom.endsWith(from)) return false;
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
    for (const s of this.incomingSessions) {
      if (this.matchesIncoming(s, match)) return s;
    }
    if (this.session && this.matchesIncoming(this.session, match)) return this.session;
    return null;
  }

  async unregister() {
    try {
      this.ua?.stop();
    } finally {
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
    const until = Date.now() + Math.max(500, timeoutMs);
    while (Date.now() < until) {
      const session = this.findIncoming(match);
      if (session) {
        this.session = session;
        stopAllTelephonyAudio().catch(() => undefined);
        ICM.start("audio");
        setTimeout(() => ICM.routeToEarpiece(), 150);

        // Wait for the session to be confirmed OR failed/ended before returning.
        // Previously we returned `true` immediately, which meant a silent failure
        // in getUserMedia or ICE left the app stuck on an unanswered "ringing" screen.
        const confirmed = await new Promise<boolean>((resolve) => {
          const ANSWER_TIMEOUT_MS = Math.max(500, until - Date.now());
          const answerTimer = setTimeout(() => {
            console.warn("[SIP] answerIncoming: confirmation timeout after", ANSWER_TIMEOUT_MS, "ms");
            resolve(false);
          }, ANSWER_TIMEOUT_MS);

          const cleanup = () => clearTimeout(answerTimer);

          session.once?.("confirmed", () => {
            console.log("[SIP] answerIncoming: session confirmed");
            onTrace?.({ phase: "confirmed", timestamp: Date.now() });
            cleanup();
            resolve(true);
          });
          session.once?.("failed", (e: any) => {
            const cause = e?.cause || "unknown";
            const code = e?.response?.status_code;
            console.warn("[SIP] answerIncoming: session failed:", code || cause);
            onTrace?.({
              phase: "failed",
              timestamp: Date.now(),
              code: typeof code === "number" ? code : null,
              reason: String(cause || "unknown"),
              message: code ? `failed:${code}` : String(cause || "unknown"),
            });
            cleanup();
            resolve(false);
          });
          session.once?.("ended", () => {
            console.log("[SIP] answerIncoming: session ended before confirmed");
            onTrace?.({
              phase: "failed",
              timestamp: Date.now(),
              reason: "ended_before_confirmed",
              message: "ended_before_confirmed",
            });
            cleanup();
            resolve(false);
          });

          try {
            console.log("[SIP] answerIncoming: calling session.answer()");
            session.answer({ mediaConstraints: VOICE_AUDIO_CONSTRAINTS });
            onTrace?.({ phase: "sent", timestamp: Date.now() });
          } catch (e: any) {
            console.error("[SIP] answerIncoming: session.answer() threw:", e?.message || e);
            onTrace?.({
              phase: "failed",
              timestamp: Date.now(),
              reason: "answer_threw",
              message: e?.message || String(e),
            });
            cleanup();
            resolve(false);
          }
        });

        return confirmed;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    onTrace?.({
      phase: "failed",
      timestamp: Date.now(),
      reason: "session_not_found_timeout",
      message: "session_not_found_timeout",
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
