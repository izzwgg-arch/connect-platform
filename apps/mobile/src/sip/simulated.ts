import type { SipClient, SipEvents, SipMatch } from "./types";
import type { ProvisioningBundle } from "../types";

export class SimulatedSipClient implements SipClient {
  private events: SipEvents = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _bundle: ProvisioningBundle | null = null;

  configure(bundle: ProvisioningBundle) {
    this._bundle = bundle;
  }

  setEvents(events: SipEvents) {
    this.events = events;
  }

  async register() {
    this.events.onRegistrationState?.("registering");
    this.timer = setTimeout(() => this.events.onRegistrationState?.("registered"), 500);
  }

  async unregister() {
    this.events.onRegistrationState?.("idle");
  }

  async dial(target: string) {
    console.log('[SIM] Dialing', target, '(simulated)');
    this.events.onCallState?.("dialing");
    setTimeout(() => this.events.onCallState?.("ringing"), 500);
    setTimeout(() => this.events.onCallState?.("connected"), 1200);
  }

  async answer() {
    this.events.onCallState?.("connected");
  }

  async answerIncoming(_match?: SipMatch, _timeoutMs = 5000): Promise<boolean> {
    this.events.onCallState?.("connected");
    return true;
  }

  async rejectIncoming(_match?: SipMatch): Promise<boolean> {
    this.events.onCallState?.("ended");
    return true;
  }

  async hangup() {
    this.events.onCallState?.("ended");
  }

  setMute() {}
  setSpeaker() {}
  hold() {}
  unhold() {}
  sendDtmf() {}
}
