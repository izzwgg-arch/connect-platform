import type { SipClient, SipEvents, SipMatch } from "./types";
import type { ProvisioningBundle } from "../types";

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
      m.start({ media });
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
    } catch { /* module not linked */ }
  },
};

export class JsSipClient implements SipClient {
  private events: SipEvents = {};
  private bundle: ProvisioningBundle | null = null;
  private ua: any = null;
  private session: any = null;
  private incomingSessions: any[] = [];
  private callStartedAt: number | null = null;
  private callDirection: "outbound" | "inbound" = "outbound";
  /** Callback for submitting quality reports — injected by the context layer. */
  onCallQualityReport?: (report: Record<string, unknown>) => void;

  configure(bundle: ProvisioningBundle) {
    this.bundle = bundle;
  }

  setEvents(events: SipEvents) {
    this.events = events;
  }

  async register() {
    if (!this.bundle) throw new Error("Missing provisioning bundle");
    this.events.onRegistrationState?.("registering");
    console.log('[SIP] Registering to', this.bundle.sipDomain, 'via', this.bundle.sipWsUrl);

    // Register WebRTC globals lazily (not at startup — avoids native crash on launch)
    try {
      const { registerGlobals } = await import('react-native-webrtc');
      registerGlobals();
      console.log('[SIP] WebRTC globals registered');
    } catch (e) {
      console.warn('[SIP] WebRTC registerGlobals failed:', e);
    }

    const JsSIP = (await import("jssip")).default as any;
    const socket = new JsSIP.WebSocketInterface(this.bundle.sipWsUrl);

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

    this.ua = new JsSIP.UA(uaConfig);

    this.ua.on("registered", () => {
      console.log('[SIP] Registered successfully');
      this.events.onRegistrationState?.("registered");
    });

    this.ua.on("registrationFailed", (e: any) => {
      const code = e?.response?.status_code;
      const cause = e?.cause || "unknown";
      const msg = code ? `SIP reg failed (${code}): ${cause}` : `SIP reg failed: ${cause}`;
      console.warn('[SIP] Registration failed:', msg);
      this.events.onRegistrationState?.("failed");
      this.events.onError?.(msg);
    });

    this.ua.on("newRTCSession", (e: any) => {
      this.session = e.session;
      console.log('[SIP] New RTC session, originator:', e.originator);

      if (e.originator === "remote") {
        this.callDirection = "inbound";
        const callerNumber = this.getSessionFrom(e.session);
        console.log('[SIP] Incoming call from:', callerNumber);
        this.incomingSessions.push(e.session);
        this.events.onIncomingCall?.(callerNumber);
        this.events.onCallState?.("ringing");
      }
      this.bindSession(this.session);
    });

    this.ua.on("disconnected", (e: any) => {
      console.warn('[SIP] UA disconnected:', e?.cause);
    });

    this.ua.start();
    console.log('[SIP] UA started');
  }

  private bindSession(session: any) {
    session.on("progress", (e: any) => {
      const code = e?.response?.status_code;
      console.log('[SIP] Call progress, status:', code);
      this.events.onCallState?.("ringing");
    });

    session.on("confirmed", () => {
      console.log('[SIP] Call confirmed (connected)');
      ICM.start("audio");
      if (!this.callStartedAt) this.callStartedAt = Date.now();
      this.events.onCallState?.("connected");
    });

    session.on("ended", (e: any) => {
      const cause = e?.cause || "normal";
      console.log('[SIP] Call ended, cause:', cause);
      this.collectAndSubmitQualityReport(cause).catch(() => {});
      ICM.stop();
      this.incomingSessions = this.incomingSessions.filter((x) => x !== session);
      if (this.session === session) this.session = null;
      this.events.onCallState?.("ended");
    });

    session.on("failed", (e: any) => {
      const cause = e?.cause || "unknown";
      const code = e?.response?.status_code;
      const msg = code ? `Call failed (${code}): ${cause}` : `Call failed: ${cause}`;
      console.warn('[SIP] Call failed:', msg);
      this.collectAndSubmitQualityReport(cause).catch(() => {});
      ICM.stop();
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
    if (match.toExtension && to && to !== String(match.toExtension)) return false;
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
    ICM.start("audio");
    try {
      this.session = this.ua.call(dest, {
        mediaConstraints: VOICE_AUDIO_CONSTRAINTS,
        pcConfig: this.ua._configuration?.pcConfig ?? {},
      });
      this.bindSession(this.session);
      console.log('[SIP] INVITE sent');
    } catch (e: any) {
      ICM.stop();
      const msg = e?.message || "dial failed";
      console.error('[SIP] Dial error:', msg);
      this.events.onError?.(`Dial error: ${msg}`);
      this.events.onCallState?.("ended");
    }
  }

  async answer() {
    ICM.start("audio");
    this.session?.answer?.({ mediaConstraints: VOICE_AUDIO_CONSTRAINTS });
  }

  async answerIncoming(match?: SipMatch, timeoutMs = 5000): Promise<boolean> {
    const until = Date.now() + Math.max(500, timeoutMs);
    while (Date.now() < until) {
      const session = this.findIncoming(match);
      if (session) {
        this.session = session;
        ICM.start("audio");
        session.answer?.({ mediaConstraints: VOICE_AUDIO_CONSTRAINTS });
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return false;
  }

  async rejectIncoming(match?: SipMatch): Promise<boolean> {
    const session = this.findIncoming(match);
    if (!session) return false;
    try {
      session.terminate?.();
    } catch {}
    this.incomingSessions = this.incomingSessions.filter((x) => x !== session);
    if (this.session === session) this.session = null;
    return true;
  }

  async hangup() {
    console.log('[SIP] Hanging up');
    await this.collectAndSubmitQualityReport("user_hangup").catch(() => {});
    ICM.stop();
    try {
      this.session?.terminate?.();
    } catch (e) {
      console.warn('[SIP] Hangup error:', e);
    }
    this.events.onCallState?.("ended");
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
    try {
      const NetInfo = require("@react-native-community/netinfo");
      if (NetInfo?.fetch) {
        const state = await NetInfo.fetch();
        networkType = state?.type || null;
      }
    } catch { /* netinfo may not be available */ }

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
