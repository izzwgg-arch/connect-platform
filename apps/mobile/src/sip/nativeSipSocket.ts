import { NativeEventEmitter, NativeModules, Platform } from "react-native";

/**
 * JsSIP custom Socket backed by the native SipSocketModule (OkHttp).
 *
 * Why not the built-in WebSocket: React Native's WebSocketModule hardcodes a
 * 10 s connect timeout and system DNS ordering. On T-Mobile's IPv6-only
 * network the DNS64-synthesized IPv6 address for the PBX blackholes, so every
 * fresh SIP connect stalled ~10.5 s before the IPv4 fallback — the entire
 * cold-start answer delay. The native module connects IPv4-first (~0.5 s) and
 * additionally runs WebSocket pings on a native thread, which keeps the CGNAT
 * mapping alive while JS timers are frozen in the background.
 *
 * Implements the JsSIP Socket interface:
 * https://jssip.net/documentation/api/socket/
 */

type SipSocketNativeModule = {
  connect(socketId: string, url: string): void;
  send(socketId: string, data: string): void;
  close(socketId: string, code: number, reason: string): void;
};

const native: SipSocketNativeModule | undefined = NativeModules.SipSocket;

export function isNativeSipSocketAvailable(): boolean {
  return Platform.OS === "android" && !!native;
}

let emitter: NativeEventEmitter | null = null;
function getEmitter(): NativeEventEmitter {
  if (!emitter) emitter = new NativeEventEmitter(NativeModules.SipSocket);
  return emitter;
}

let socketSeq = 0;

export class NativeSipSocket {
  private readonly _url: string;
  private readonly _sip_uri: string;
  private _via_transport: string;

  private socketId: string | null = null;
  private state: "closed" | "connecting" | "open" = "closed";
  private subs: { remove: () => void }[] = [];

  // Assigned by JsSIP's Transport after construction.
  public onconnect: () => void = () => {};
  public ondisconnect: (error: boolean, code?: number, reason?: string) => void = () => {};
  public ondata: (data: string) => void = () => {};

  constructor(url: string) {
    const m = /^(wss?):\/\/([^/:?#]+)(?::(\d+))?(\/[^?#]*)?/.exec(url);
    if (!m) throw new TypeError(`Invalid WebSocket URI: ${url}`);
    this._url = url;
    this._via_transport = m[1].toUpperCase();
    const host = m[2];
    const port = m[3];
    this._sip_uri = `sip:${host}${port ? `:${port}` : ""};transport=ws`;
  }

  get url(): string {
    return this._url;
  }

  get sip_uri(): string {
    return this._sip_uri;
  }

  get via_transport(): string {
    return this._via_transport;
  }

  set via_transport(value: string) {
    this._via_transport = value.toUpperCase();
  }

  isConnected(): boolean {
    return this.state === "open";
  }

  isConnecting(): boolean {
    return this.state === "connecting";
  }

  connect(): void {
    if (!native) throw new Error("SipSocket native module unavailable");
    if (this.state === "open" || this.state === "connecting") return;

    const id = `sipws_${++socketSeq}_${Date.now()}`;
    this.socketId = id;
    this.state = "connecting";
    this.unsubscribe();

    const em = getEmitter();
    this.subs = [
      em.addListener("SipSocket_open", (e: { id: string; connectMs?: number }) => {
        if (e.id !== this.socketId) return;
        this.state = "open";
        console.log(`[SIP_SOCKET] native ws connected in ${Math.round(e.connectMs ?? -1)}ms`);
        this.onconnect();
      }),
      em.addListener("SipSocket_message", (e: { id: string; data: string }) => {
        if (e.id !== this.socketId) return;
        this.ondata(e.data);
      }),
      em.addListener(
        "SipSocket_close",
        (e: { id: string; code: number; reason: string; wasClean: boolean }) => {
          if (e.id !== this.socketId) return;
          this.socketId = null;
          this.state = "closed";
          this.unsubscribe();
          this.ondisconnect(!e.wasClean, e.code, e.reason);
        },
      ),
    ];

    native.connect(id, this._url);
  }

  disconnect(): void {
    const id = this.socketId;
    this.socketId = null;
    this.state = "closed";
    this.unsubscribe();
    if (id && native) {
      try {
        native.close(id, 1000, "");
      } catch {
        /* already closed */
      }
    }
  }

  send(message: string): boolean {
    if (this.state !== "open" || !this.socketId || !native) return false;
    try {
      native.send(this.socketId, message);
      return true;
    } catch {
      return false;
    }
  }

  private unsubscribe(): void {
    for (const s of this.subs) {
      try {
        s.remove();
      } catch {
        /* ignore */
      }
    }
    this.subs = [];
  }
}
