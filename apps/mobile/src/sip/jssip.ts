import type { SipClient, SipEvents, SipMatch } from "./types";
import type { ProvisioningBundle } from "../types";

export class JsSipClient implements SipClient {
  private events: SipEvents = {};
  private bundle: ProvisioningBundle | null = null;
  private ua: any = null;
  private session: any = null;
  private incomingSessions: any[] = [];

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
      this.events.onCallState?.("connected");
    });

    session.on("ended", (e: any) => {
      const cause = e?.cause || "normal";
      console.log('[SIP] Call ended, cause:', cause);
      this.incomingSessions = this.incomingSessions.filter((x) => x !== session);
      if (this.session === session) this.session = null;
      this.events.onCallState?.("ended");
    });

    session.on("failed", (e: any) => {
      const cause = e?.cause || "unknown";
      const code = e?.response?.status_code;
      const msg = code ? `Call failed (${code}): ${cause}` : `Call failed: ${cause}`;
      console.warn('[SIP] Call failed:', msg);
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
    this.events.onCallState?.("dialing");
    try {
      this.session = this.ua.call(dest, {
        mediaConstraints: { audio: true, video: false },
        pcConfig: this.ua._configuration?.pcConfig ?? {},
      });
      this.bindSession(this.session);
      console.log('[SIP] INVITE sent');
    } catch (e: any) {
      const msg = e?.message || "dial failed";
      console.error('[SIP] Dial error:', msg);
      this.events.onError?.(`Dial error: ${msg}`);
      this.events.onCallState?.("ended");
    }
  }

  async answer() {
    this.session?.answer?.({ mediaConstraints: { audio: true, video: false } });
  }

  async answerIncoming(match?: SipMatch, timeoutMs = 5000): Promise<boolean> {
    const until = Date.now() + Math.max(500, timeoutMs);
    while (Date.now() < until) {
      const session = this.findIncoming(match);
      if (session) {
        this.session = session;
        session.answer?.({ mediaConstraints: { audio: true, video: false } });
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
    // Use react-native-incall-manager if available for earpiece/speaker routing.
    // This is a best-effort call — silently ignored if the module isn't linked.
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const InCallManager = require('react-native-incall-manager').default;
      InCallManager.setSpeakerphoneOn(speakerOn);
      console.log('[SIP] Speaker', speakerOn ? 'on' : 'off');
    } catch {
      // Module not available — audio routing unchanged
      console.log('[SIP] setSpeaker: InCallManager not available, skipping');
    }
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
}
