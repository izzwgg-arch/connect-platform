import net from "net";
import { EventEmitter } from "events";
import { childLogger } from "../../logging/logger";
import {
  createReconnectState,
  nextDelayMs,
  onConnected,
  onFailed,
  abort,
  isAborted,
  type ReconnectState,
} from "./AmiReconnect";
import type { AmiFrame } from "./AmiTypes";

const log = childLogger("AmiClient");

export interface AmiClientConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  debugFrames?: boolean;
}

// Events emitted by AmiClient:
//   'connected'       — authenticated successfully
//   'disconnected'    — socket closed/errored
//   'event'           — AmiFrame for an Event frame
//   'response'        — AmiFrame for a Response frame
//   'error'           — non-fatal error (malformed frame, auth fail etc.)
export declare interface AmiClient {
  on(event: "connected", listener: () => void): this;
  on(event: "disconnected", listener: (reason: string) => void): this;
  on(event: "event", listener: (frame: AmiFrame) => void): this;
  on(event: "response", listener: (frame: AmiFrame) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export class AmiClient extends EventEmitter {
  private readonly cfg: AmiClientConfig;
  private socket: net.Socket | null = null;
  private reconnect: ReconnectState;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private buffer = "";
  private greetingReceived = false;
  private authenticated = false;
  private actionSeq = 0;
  _isConnected = false;
  lastEventAt: Date | null = null;
  lastError: string | null = null;

  constructor(cfg: AmiClientConfig) {
    super();
    this.cfg = cfg;
    this.reconnect = createReconnectState();
  }

  start(): void {
    if (isAborted(this.reconnect)) return;
    this.connect();
  }

  stop(): void {
    abort(this.reconnect);
    this.clearTimers();
    this.destroySocket("shutdown");
  }

  // Send a raw AMI action. Returns the generated ActionID.
  sendAction(action: string, fields: Record<string, string> = {}): string {
    if (!this.socket || !this.authenticated) {
      throw new Error("AMI not connected");
    }
    const id = `cc-${++this.actionSeq}`;
    let msg = `Action: ${action}\r\nActionID: ${id}\r\n`;
    for (const [k, v] of Object.entries(fields)) {
      msg += `${k}: ${v}\r\n`;
    }
    msg += "\r\n";
    this.socket.write(msg);
    return id;
  }

  // Read a single AstDB value by Family + Key. Resolves with { ok: true, value }
  // on success, { ok: false } if the key is absent, and rejects on timeout or
  // disconnect.
  //
  // Implementation note: Asterisk's AMI `DBGet` is a two-step exchange:
  //   1. We send Action: DBGet (ActionID: X)
  //   2. Asterisk replies `Response: Success` (matching ActionID)
  //   3. Then emits a separate `Event: DBGetResponse` carrying Family/Key/Val
  //   — OR — if the key is missing, step 2 is `Response: Error`
  //     with Message: "Database entry not found." and no event follows.
  //
  // We subscribe to both the `response` and `event` streams for the window of
  // this call. This is cheap: DBGet is purely in-memory in Asterisk and the
  // full round-trip typically completes in under 5ms.
  //
  // Used by Option A IVR routing to snapshot the pre-publish state so rollback
  // can restore the real prior values.
  dbGet(
    family: string,
    key: string,
    timeoutMs = 3_000,
  ): Promise<{ ok: true; value: string } | { ok: false }> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.authenticated) {
        reject(new Error("AMI not connected"));
        return;
      }
      const id = `cc-${++this.actionSeq}`;
      let settled = false;
      let sawSuccessResponse = false;

      const onResponse = (frame: AmiFrame) => {
        if (frame["ActionID"] !== id) return;
        if (settled) return;
        const status = frame["Response"] ?? "";
        if (status === "Success") {
          // Some Asterisk builds inline the value in the Response frame itself
          // (observed on 18+ in certain configurations). Prefer that if present.
          if (typeof frame["Val"] === "string") {
            settled = true;
            cleanup();
            resolve({ ok: true, value: frame["Val"] });
            return;
          }
          // Otherwise, wait for the DBGetResponse event below.
          sawSuccessResponse = true;
          return;
        }
        // Response: Error → key missing (or another AMI error).
        settled = true;
        cleanup();
        resolve({ ok: false });
      };

      const onEvent = (frame: AmiFrame) => {
        if (settled) return;
        if (frame["Event"] !== "DBGetResponse") return;
        if (frame["Family"] !== family || frame["Key"] !== key) return;
        // Only trust the event if we first saw a Success response for our id,
        // to avoid racing against unrelated parallel DBGet calls. ActionID on
        // events is usually echoed by Asterisk for actions that emit them.
        if (frame["ActionID"] !== undefined && frame["ActionID"] !== id) return;
        if (!sawSuccessResponse && frame["ActionID"] !== id) return;
        settled = true;
        cleanup();
        resolve({ ok: true, value: frame["Val"] ?? "" });
      };

      const onDisconnect = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("AMI disconnected before DBGet completed"));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        // If we got Success but the event never arrived, treat as missing
        // rather than error — the response itself said the action succeeded.
        if (sawSuccessResponse) resolve({ ok: false });
        else reject(new Error(`AMI DBGet timed out: ${family}/${key}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("response", onResponse);
        this.off("event", onEvent);
        this.off("disconnected", onDisconnect);
      };
      this.on("response", onResponse);
      this.on("event", onEvent);
      this.once("disconnected", onDisconnect);

      const msg =
        `Action: DBGet\r\nActionID: ${id}\r\nFamily: ${family}\r\nKey: ${key}\r\n\r\n`;
      try {
        this.socket.write(msg);
      } catch (err) {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  private connect(): void {
    if (isAborted(this.reconnect)) return;
    log.info({ host: this.cfg.host, port: this.cfg.port }, "AMI connecting");

    const sock = new net.Socket();
    this.socket = sock;
    this.buffer = "";
    this.greetingReceived = false;
    this.authenticated = false;

    sock.setEncoding("utf8");
    sock.setTimeout(45_000);

    sock.connect(this.cfg.port, this.cfg.host);

    sock.once("connect", () => {
      log.debug("AMI socket connected, waiting for greeting");
    });

    sock.on("data", (chunk: string) => {
      this.handleData(chunk);
    });

    sock.on("timeout", () => {
      log.warn("AMI socket timeout — closing");
      sock.destroy(new Error("socket timeout"));
    });

    sock.once("error", (err) => {
      log.warn({ err: err.message }, "AMI socket error");
      this.lastError = err.message;
      this.emit("error", err);
    });

    sock.once("close", (hadError) => {
      const reason = hadError ? "error" : "remote close";
      this.handleDisconnect(reason);
    });
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;

    // AMI greeting: a single line sent once at connect, before any frames.
    // Only parse it once — use greetingReceived to avoid re-entering this
    // block on subsequent data chunks that arrive before authentication completes.
    if (!this.greetingReceived && this.buffer.includes("\r\n")) {
      const greetEnd = this.buffer.indexOf("\r\n");
      const greeting = this.buffer.slice(0, greetEnd);
      this.buffer = this.buffer.slice(greetEnd + 2);
      log.debug({ greeting }, "AMI greeting received");
      this.greetingReceived = true;

      if (!greeting.startsWith("Asterisk Call Manager")) {
        const err = new Error(`Unexpected AMI greeting: ${greeting}`);
        this.lastError = err.message;
        this.emit("error", err);
        this.destroySocket("bad greeting");
        return;
      }

      this.sendLogin();
    }

    // Do not attempt frame parsing until greeting is done
    if (!this.greetingReceived) return;

    // Parse complete frames (delimited by \r\n\r\n)
    let delimIdx: number;
    while ((delimIdx = this.buffer.indexOf("\r\n\r\n")) !== -1) {
      const raw = this.buffer.slice(0, delimIdx);
      this.buffer = this.buffer.slice(delimIdx + 4);
      if (raw.trim() === "") continue;

      const frame = this.parseFrame(raw);
      if (!frame) continue;

      if (this.cfg.debugFrames) {
        log.trace({ frame }, "AMI raw frame");
      }

      this.processFrame(frame);
    }
  }

  private sendLogin(): void {
    if (!this.socket) return;
    const msg =
      `Action: Login\r\n` +
      `Username: ${this.cfg.username}\r\n` +
      `Secret: ${this.cfg.password}\r\n` +
      `Events: on\r\n` +
      `ActionID: login-${Date.now()}\r\n\r\n`;
    this.socket.write(msg);
  }

  private parseFrame(raw: string): AmiFrame | null {
    const frame: AmiFrame = {};
    for (const line of raw.split("\r\n")) {
      if (line.trim() === "") continue;
      const colon = line.indexOf(": ");
      if (colon === -1) {
        // Some AMI lines may not have ": " — skip gracefully
        continue;
      }
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 2);
      if (key) frame[key] = value;
    }
    return Object.keys(frame).length > 0 ? frame : null;
  }

  private processFrame(frame: AmiFrame): void {
    if (frame["Response"] !== undefined) {
      if (!this.authenticated) {
        if (frame["Response"] === "Success") {
          this.authenticated = true;
          this._isConnected = true;
          onConnected(this.reconnect);
          log.info("AMI authenticated successfully");
          this.startKeepalive();
          this.emit("connected");
        } else {
          const msg = frame["Message"] ?? "Authentication failed";
          this.lastError = msg;
          log.error({ msg }, "AMI authentication failed — will retry with backoff");
          const err = new Error(`AMI auth failed: ${msg}`);
          if (this.listenerCount("error") > 0) {
            this.emit("error", err);
          }
          // destroySocket clears the socket; handleDisconnect schedules reconnect.
          // Call destroySocket first so the socket is gone before we reschedule.
          if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
          }
          this.clearKeepalive();
          this.greetingReceived = false;
          this.authenticated = false;
          this._isConnected = false;
          // Reconnect with backoff (service will retry indefinitely)
          onFailed(this.reconnect);
          const delay = nextDelayMs(this.reconnect);
          log.info({ attempt: this.reconnect.attempt, delayMs: delay }, "AMI scheduling reconnect after auth failure");
          this.reconnectTimer = setTimeout(() => { this.connect(); }, delay);
          if (this.reconnectTimer.unref) this.reconnectTimer.unref();
        }
        return;
      }
      this.emit("response", frame);
      return;
    }

    if (frame["Event"] !== undefined) {
      this.lastEventAt = new Date();
      this.emit("event", frame);
    }
  }

  private startKeepalive(): void {
    this.clearKeepalive();
    // Send a Ping every 30 s to keep the connection alive and detect stalls
    this.keepaliveTimer = setInterval(() => {
      try {
        this.sendAction("Ping");
      } catch {
        // Socket likely gone — the close handler will trigger reconnect
      }
    }, 30_000);
    if (this.keepaliveTimer.unref) this.keepaliveTimer.unref();
  }

  private handleDisconnect(reason: string): void {
    const wasConnected = this._isConnected;
    this._isConnected = false;
    this.authenticated = false;
    this.greetingReceived = false;
    this.socket = null;
    this.clearKeepalive();

    if (wasConnected) {
      log.warn({ reason }, "AMI disconnected");
      this.emit("disconnected", reason);
    }

    if (isAborted(this.reconnect)) return;

    onFailed(this.reconnect);
    const delay = nextDelayMs(this.reconnect);
    log.info(
      { attempt: this.reconnect.attempt, delayMs: delay },
      "AMI scheduling reconnect",
    );

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  private destroySocket(reason: string): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    const wasConnected = this._isConnected;
    this._isConnected = false;
    this.authenticated = false;
    this.greetingReceived = false;
    this.clearKeepalive();
    if (wasConnected) this.emit("disconnected", reason);
  }

  private clearTimers(): void {
    this.clearKeepalive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}
