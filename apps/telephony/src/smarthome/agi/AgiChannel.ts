// AgiChannel — typed call-control helpers over an AgiConnection.
// Implements the IvrChannel interface consumed by SmartHomeIvr so the IVR
// flow can be unit-tested against a fake channel.

import { AgiConnection, CallEndedError } from "./AgiConnection";

/** Abstract channel the IVR flow drives (real AGI or a test fake). */
export interface IvrChannel {
  /** Caller ID number, or "" when unavailable/withheld. */
  readonly callerId: string;
  answer(): Promise<void>;
  /**
   * Play a prompt and collect up to maxDigits DTMF digits (# terminates).
   * Returns the digits pressed ("" on timeout with no input), or null if the
   * call ended.
   */
  getData(promptFile: string, timeoutMs: number, maxDigits: number): Promise<string | null>;
  /** Play a sound file to completion (no digit interruption). */
  play(promptFile: string): Promise<void>;
  hangup(): Promise<void>;
}

export class AgiChannel implements IvrChannel {
  private readonly conn: AgiConnection;
  readonly callerId: string;

  constructor(conn: AgiConnection) {
    this.conn = conn;
    const cid = conn.agiEnv["agi_callerid"] ?? "";
    this.callerId = cid === "unknown" ? "" : cid;
  }

  async answer(): Promise<void> {
    await this.conn.sendCommand("ANSWER");
  }

  async getData(promptFile: string, timeoutMs: number, maxDigits: number): Promise<string | null> {
    try {
      const r = await this.conn.sendCommand(
        `GET DATA ${promptFile} ${timeoutMs} ${maxDigits}`,
        timeoutMs + 30_000,
      );
      // result is the digits collected; "-1" means channel failure/hangup.
      if (r.result === "-1") return null;
      return r.result;
    } catch (err) {
      if (err instanceof CallEndedError) return null;
      throw err;
    }
  }

  async play(promptFile: string): Promise<void> {
    try {
      await this.conn.sendCommand(`STREAM FILE ${promptFile} ""`);
    } catch (err) {
      if (err instanceof CallEndedError) return;
      throw err;
    }
  }

  async hangup(): Promise<void> {
    try {
      if (!this.conn.isEnded) await this.conn.sendCommand("HANGUP");
    } catch {
      // Already gone — fine.
    } finally {
      this.conn.close();
    }
  }
}
