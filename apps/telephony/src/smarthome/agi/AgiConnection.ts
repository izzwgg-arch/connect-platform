// AgiConnection — one FastAGI session (one inbound call) over a TCP socket.
//
// FastAGI protocol:
//   1. Asterisk connects and sends `agi_*: value` header lines, then a blank line.
//   2. We send one command per line; Asterisk replies `200 result=<n> [extra]`.
//   3. If the caller hangs up mid-command, Asterisk sends a bare `HANGUP` line
//      and/or closes the socket — we surface that as CallEndedError so the IVR
//      flow can abort cleanly.
//
// Only one command may be in flight at a time (AGI is strictly serial).

import type { Socket } from "net";
import { childLogger } from "../../logging/logger";

const log = childLogger("AgiConnection");

/** Thrown when the caller hangs up / socket closes while the flow is running. */
export class CallEndedError extends Error {
  constructor(message = "call ended") {
    super(message);
    this.name = "CallEndedError";
  }
}

export interface AgiResponse {
  code: number;
  result: string;
  extra: string | null;
}

/** Parse an AGI response line like `200 result=1 (timeout)` or `200 result=-1`. */
export function parseAgiResponse(line: string): AgiResponse | null {
  const m = /^(\d{3})\s+result=(-?[^\s(]*)\s*(?:\((.*)\))?/.exec(line.trim());
  if (!m) return null;
  return { code: Number(m[1]), result: m[2] ?? "", extra: m[3] ?? null };
}

/** Parse `agi_*` header lines (everything before the first blank line). */
export function parseAgiEnv(headerBlock: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of headerBlock.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key.startsWith("agi_")) continue;
    out[key] = line.slice(idx + 1).trim();
  }
  return out;
}

export class AgiConnection {
  private readonly socket: Socket;
  private buffer = "";
  private envResolved = false;
  private ended = false;
  private envResolve: ((env: Record<string, string>) => void) | null = null;
  private pending: {
    resolve: (r: AgiResponse) => void;
    reject: (e: Error) => void;
  } | null = null;

  /** AGI environment (agi_callerid, agi_dnid, …) — populated after readEnv(). */
  agiEnv: Record<string, string> = {};

  constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    const end = () => this.onEnd();
    socket.on("close", end);
    socket.on("end", end);
    socket.on("error", (err) => {
      log.debug({ err: err.message }, "AGI socket error");
      this.onEnd();
    });
  }

  get isEnded(): boolean {
    return this.ended;
  }

  /** Wait for the initial agi_* header block. */
  readEnv(timeoutMs = 5000): Promise<Record<string, string>> {
    if (this.envResolved) return Promise.resolve(this.agiEnv);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.envResolve = null;
        reject(new Error("timeout waiting for AGI environment"));
      }, timeoutMs);
      this.envResolve = (env) => {
        clearTimeout(timer);
        resolve(env);
      };
      // Header may already be buffered.
      this.tryResolveEnv();
    });
  }

  /** Send one AGI command and await its `200 result=…` response. */
  sendCommand(command: string, timeoutMs = 30_000): Promise<AgiResponse> {
    if (this.ended) return Promise.reject(new CallEndedError());
    if (this.pending) {
      return Promise.reject(new Error("AGI command already in flight"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`AGI command timed out: ${command}`));
      }, timeoutMs);
      this.pending = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.socket.write(command + "\n");
    });
  }

  close(): void {
    this.socket.destroy();
  }

  // ── internal ──────────────────────────────────────────────────────────────

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (!this.envResolved) this.tryResolveEnv();
    if (this.envResolved) this.drainLines();
  }

  private tryResolveEnv(): void {
    const sep = this.buffer.indexOf("\n\n");
    if (sep === -1) return;
    const headerBlock = this.buffer.slice(0, sep);
    this.buffer = this.buffer.slice(sep + 2);
    this.agiEnv = parseAgiEnv(headerBlock);
    this.envResolved = true;
    if (this.envResolve) {
      this.envResolve(this.agiEnv);
      this.envResolve = null;
    }
  }

  private drainLines(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      if (line === "HANGUP") {
        // Async hangup notification — next command result will be -1, and the
        // socket will close shortly. Mark ended so the flow aborts.
        this.onEnd();
        continue;
      }
      const resp = parseAgiResponse(line);
      if (resp && this.pending) {
        const p = this.pending;
        this.pending = null;
        if (resp.code >= 500) {
          p.reject(new Error(`AGI error ${resp.code}: ${line}`));
        } else {
          p.resolve(resp);
        }
      } else if (resp) {
        log.debug({ line }, "AGI response with no pending command");
      } else {
        log.debug({ line }, "Unparseable AGI line ignored");
      }
    }
  }

  private onEnd(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject(new CallEndedError());
    }
    if (this.envResolve) {
      this.envResolve = null;
    }
  }
}
