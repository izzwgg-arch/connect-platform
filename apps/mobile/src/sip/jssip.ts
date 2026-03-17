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

    const JsSIP = (await import("jssip")).default as any;
    const socket = new JsSIP.WebSocketInterface(this.bundle.sipWsUrl);

    const iceServers = this.bundle.iceServers?.length
      ? this.bundle.iceServers
      : [{ urls: "stun:stun.l.google.com:19302" }];

    const uaConfig: Record<string, unknown> = {
      sockets: [socket],
      uri: `sip:${this.bundle.sipUsername}@${this.bundle.sipDomain}`,
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

    this.ua.on("registered", () => this.events.onRegistrationState?.("registered"));
    this.ua.on("registrationFailed", (e: any) => {
      this.events.onRegistrationState?.("failed");
      const code = e?.response?.status_code;
      const cause = e?.cause || "unknown";
      const msg = code
        ? `SIP reg failed (${code}): ${cause}`
        : `SIP reg failed: ${cause}`;
      this.events.onError?.(msg);
    });
    this.ua.on("newRTCSession", (e: any) => {
      this.session = e.session;
      if (e.originator === "remote") {
        this.incomingSessions.push(e.session);
        this.events.onIncomingCall?.();
        this.events.onCallState?.("ringing");
      }
      this.bindSession(this.session);
    });

    this.ua.start();
  }

  private bindSession(session: any) {
    session.on("progress", () => this.events.onCallState?.("ringing"));
    session.on("confirmed", () => this.events.onCallState?.("connected"));
    session.on("ended", () => {
      this.incomingSessions = this.incomingSessions.filter((x) => x !== session);
      if (this.session === session) this.session = null;
      this.events.onCallState?.("ended");
    });
    session.on("failed", (e: any) => {
      this.incomingSessions = this.incomingSessions.filter((x) => x !== session);
      if (this.session === session) this.session = null;
      this.events.onCallState?.("ended");
      const cause = e?.cause || "unknown";
      this.events.onError?.(`Call failed: ${cause}`);
    });
  }

  private normalizeNumber(v: string | undefined): string {
    return String(v || "").replace(/[^0-9+]/g, "");
  }

  private getSessionFrom(session: any): string {
    return String(session?.remote_identity?.uri?.user || session?.remote_identity?.display_name || "");
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
    this.events.onCallState?.("dialing");
    this.session = this.ua.call(`sip:${target}@${this.bundle.sipDomain}`, {
      mediaConstraints: { audio: true, video: false },
      pcConfig: this.ua._configuration?.pcConfig ?? {},
    });
    this.bindSession(this.session);
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
    this.session?.terminate?.();
    this.events.onCallState?.("ended");
  }

  setMute(mute: boolean) {
    if (mute) this.session?.mute?.({ audio: true });
    else this.session?.unmute?.({ audio: true });
  }

  setSpeaker(_speakerOn: boolean) {
    // Platform-specific audio routing can be layered in with native modules.
  }

  sendDtmf(digit: string) {
    this.session?.sendDTMF?.(digit);
  }
}
