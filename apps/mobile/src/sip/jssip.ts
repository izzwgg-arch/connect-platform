import type { SipClient, SipEvents } from "./types";
import type { ProvisioningBundle } from "../types";

export class JsSipClient implements SipClient {
  private events: SipEvents = {};
  private bundle: ProvisioningBundle | null = null;
  private ua: any = null;
  private session: any = null;

  configure(bundle: ProvisioningBundle) {
    this.bundle = bundle;
  }

  setEvents(events: SipEvents) {
    this.events = events;
  }

  async register() {
    if (!this.bundle) throw new Error("Missing provisioning bundle");
    this.events.onRegistrationState?.("registering");

    // RN runtime wiring for JsSIP + react-native-webrtc in Expo dev client.
    const JsSIP = (await import("jssip")).default as any;
    const socket = new JsSIP.WebSocketInterface(this.bundle.sipWsUrl);

    this.ua = new JsSIP.UA({
      sockets: [socket],
      uri: `sip:${this.bundle.sipUsername}@${this.bundle.sipDomain}`,
      password: this.bundle.sipPassword,
      register: true,
      session_timers: false
    });

    this.ua.on("registered", () => this.events.onRegistrationState?.("registered"));
    this.ua.on("registrationFailed", () => this.events.onRegistrationState?.("failed"));
    this.ua.on("newRTCSession", (e: any) => {
      this.session = e.session;
      if (e.originator === "remote") {
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
    session.on("ended", () => this.events.onCallState?.("ended"));
    session.on("failed", () => this.events.onCallState?.("ended"));
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
      mediaConstraints: { audio: true, video: false }
    });
    this.bindSession(this.session);
  }

  async answer() {
    this.session?.answer?.({ mediaConstraints: { audio: true, video: false } });
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
    // Speaker routing on RN varies by platform and audio routing package.
    // Intentionally no-op without adding unstable native side effects.
  }

  sendDtmf(digit: string) {
    this.session?.sendDTMF?.(digit);
  }
}
