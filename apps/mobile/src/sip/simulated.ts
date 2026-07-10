import type {
  SipAnswerTraceEvent,
  SipClient,
  SipEvents,
  SipMatch,
  SipSessionInfo,
  SipSessionState,
} from "./types";
import type { ProvisioningBundle } from "../types";

export class SimulatedSipClient implements SipClient {
  private events: SipEvents = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _bundle: ProvisioningBundle | null = null;
  private registeredAt: number | null = null;
  private connected = false;
  private sessions: SipSessionInfo[] = [];

  configure(bundle: ProvisioningBundle) {
    this._bundle = bundle;
  }

  setEvents(events: SipEvents) {
    this.events = events;
  }

  isConnected() {
    return this.connected;
  }

  isRegistered() {
    return this.registeredAt != null;
  }

  getRegistrationAgeMs() {
    return this.registeredAt == null ? null : Date.now() - this.registeredAt;
  }

  hasActiveSession() {
    return this.sessions.some((s) => s.state !== "ended");
  }

  async register() {
    this.connected = true;
    this.events.onRegistrationState?.("registering");
    this.timer = setTimeout(() => {
      this.registeredAt = Date.now();
      this.events.onRegistrationState?.("registered");
    }, 500);
  }

  async unregister() {
    this.registeredAt = null;
    this.connected = false;
    this.events.onRegistrationState?.("idle");
  }

  async dial(target: string) {
    console.log("[SIM] Dialing", target, "(simulated)");
    this.events.onCallState?.("dialing");
    setTimeout(() => this.events.onCallState?.("ringing"), 500);
    setTimeout(() => this.events.onCallState?.("connected"), 1200);
  }

  async answer() {
    this.events.onCallState?.("connected");
  }

  async waitForIncomingInvite(_match?: SipMatch): Promise<boolean> {
    return false;
  }

  async answerIncoming(
    _match?: SipMatch,
    _timeoutMs = 5000,
    onTrace?: (event: SipAnswerTraceEvent) => void,
  ): Promise<boolean> {
    const now = Date.now();
    onTrace?.({ phase: "sent", timestamp: now });
    onTrace?.({ phase: "confirmed", timestamp: now + 10 });
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

  prewarmInboundMedia() {}
  releasePrewarmedMedia(_reason: string) {}

  setMute() {}
  setSpeaker() {}
  hold() {}
  unhold() {}
  sendDtmf() {}

  listSessions() {
    return [...this.sessions];
  }

  holdSession(_sessionId: string) {
    return false;
  }

  unholdSession(_sessionId: string) {
    return false;
  }

  hangupSession(_sessionId: string) {
    return false;
  }

  async answerSession(
    _sessionId: string,
    _timeoutMs?: number,
    onTrace?: (event: SipAnswerTraceEvent) => void,
  ): Promise<boolean> {
    const now = Date.now();
    onTrace?.({ phase: "sent", timestamp: now });
    onTrace?.({ phase: "confirmed", timestamp: now + 10 });
    return true;
  }

  getSessionState(_sessionId: string): SipSessionState | null {
    return null;
  }

  setActiveSession(_sessionId: string) {
    return false;
  }

  isSessionAlive(_sessionId: string) {
    return false;
  }

  transferSession(_sessionId: string, _target: string) {
    return false;
  }
}
