import type { SipClient, SipEvents } from "./types";
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

  async dial() {
    this.events.onCallState?.("dialing");
    setTimeout(() => this.events.onCallState?.("ringing"), 500);
    setTimeout(() => this.events.onCallState?.("connected"), 1200);
  }

  async answer() {
    this.events.onCallState?.("connected");
  }

  async hangup() {
    this.events.onCallState?.("ended");
  }

  setMute() {}

  setSpeaker() {}

  sendDtmf() {}
}
