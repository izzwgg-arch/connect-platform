// AriClient — REST-only ARI integration.
//
// This build of VitalPBX/Asterisk does NOT ship res_ari_websockets.so, so ARI
// WebSocket event subscription is intentionally not attempted.  AMI is the
// canonical live-event source; ARI is used purely for call-control REST actions
// (hangup, bridge, originate, etc.).
//
// Health is determined by a periodic REST probe against /ari/asterisk/info.
// `_isConnected` is true while the last probe succeeded; false after a failure.

import { EventEmitter } from "events";
import { childLogger } from "../../logging/logger";
import type { AriChannel, AriBridge, AriEndpoint } from "./AriTypes";

const log = childLogger("AriClient");

// How often to probe ARI REST health when last probe succeeded / failed.
const PROBE_INTERVAL_OK_MS = 30_000;
const PROBE_INTERVAL_FAIL_MS = 10_000;

export interface AriClientConfig {
  baseUrl: string;
  username: string;
  password: string;
  appName: string;
}

// Events emitted:
//   'rest:healthy'   — REST probe succeeded (transitioning from unhealthy)
//   'rest:unhealthy' — REST probe failed   (transitioning from healthy)
//   'error'          — non-fatal error (probe failure detail)
export declare interface AriClient {
  on(event: "rest:healthy", listener: () => void): this;
  on(event: "rest:unhealthy", listener: (err: Error) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

export class AriClient extends EventEmitter {
  private readonly cfg: AriClientConfig;
  private probeTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  /** True while the most recent REST probe succeeded. */
  _isConnected = false;
  lastEventAt: Date | null = null;
  lastRestCheckAt: Date | null = null;
  lastError: string | null = null;

  // ARI WebSocket is explicitly unsupported on this PBX build.
  static readonly webSocketSupported = false;

  constructor(cfg: AriClientConfig) {
    super();
    this.cfg = cfg;
  }

  /** Start periodic REST health probing. */
  start(): void {
    if (this.stopped) return;
    log.info(
      { baseUrl: this.cfg.baseUrl, appName: this.cfg.appName },
      "ARI REST client starting (WebSocket not available on this PBX build)",
    );
    // Probe immediately, then on schedule.
    void this.probe();
  }

  /** Stop health probing. */
  stop(): void {
    this.stopped = true;
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    if (this._isConnected) {
      this._isConnected = false;
      this.emit("rest:unhealthy", new Error("shutdown"));
    }
  }

  // ── REST action helpers ────────────────────────────────────────────────────

  async getChannels(): Promise<AriChannel[]> {
    return this.rest<AriChannel[]>("GET", "/ari/channels");
  }

  async getBridges(): Promise<AriBridge[]> {
    return this.rest<AriBridge[]>("GET", "/ari/bridges");
  }

  async getEndpoints(): Promise<AriEndpoint[]> {
    return this.rest<AriEndpoint[]>("GET", "/ari/endpoints");
  }

  /**
   * Fetch a channel variable (e.g. CALLERID(num)) via ARI.
   * Returns the value string, or null if the channel/variable doesn't exist.
   */
  async getChannelVariable(channelId: string, varName: string): Promise<string | null> {
    try {
      const result = await this.rest<{ value: string }>(
        "GET",
        `/ari/channels/${encodeURIComponent(channelId)}/variable`,
        { variable: varName },
      );
      return result?.value ?? null;
    } catch {
      return null;
    }
  }

  async hangupChannel(channelId: string, reason = "normal"): Promise<void> {
    await this.rest<void>("DELETE", `/ari/channels/${encodeURIComponent(channelId)}`, {
      reason,
    });
  }

  async createBridge(type = "mixing"): Promise<AriBridge> {
    return this.rest<AriBridge>("POST", "/ari/bridges", { type });
  }

  async addChannelToBridge(bridgeId: string, channelId: string): Promise<void> {
    await this.rest<void>(
      "POST",
      `/ari/bridges/${encodeURIComponent(bridgeId)}/addChannel`,
      { channel: channelId },
    );
  }

  async removeChannelFromBridge(bridgeId: string, channelId: string): Promise<void> {
    await this.rest<void>(
      "POST",
      `/ari/bridges/${encodeURIComponent(bridgeId)}/removeChannel`,
      { channel: channelId },
    );
  }

  async rest<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const base = this.cfg.baseUrl.replace(/\/$/, "");
    const url =
      body && method === "GET"
        ? `${base}${path}?${new URLSearchParams(body as Record<string, string>)}`
        : `${base}${path}`;

    const auth = Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64");

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: body && method !== "GET" ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ARI ${method} ${path} → HTTP ${res.status}: ${text}`);
    }

    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  // ── Private: periodic REST health probe ───────────────────────────────────

  private async probe(): Promise<void> {
    if (this.stopped) return;

    let ok = false;
    try {
      await this.rest<unknown>("GET", "/ari/asterisk/info");
      ok = true;
      this.lastRestCheckAt = new Date();
      this.lastEventAt = this.lastRestCheckAt;

      if (!this._isConnected) {
        this._isConnected = true;
        log.info({ baseUrl: this.cfg.baseUrl }, "ARI REST probe succeeded — marking healthy");
        this.emit("rest:healthy");
      } else {
        log.debug({ baseUrl: this.cfg.baseUrl }, "ARI REST probe OK");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.lastRestCheckAt = new Date();

      if (this._isConnected) {
        this._isConnected = false;
        log.warn({ err: msg }, "ARI REST probe failed — marking unhealthy");
        const errObj = err instanceof Error ? err : new Error(msg);
        this.emit("rest:unhealthy", errObj);
        if (this.listenerCount("error") > 0) this.emit("error", errObj);
      } else {
        log.debug({ err: msg }, "ARI REST probe still failing");
      }
    }

    if (!this.stopped) {
      const interval = ok ? PROBE_INTERVAL_OK_MS : PROBE_INTERVAL_FAIL_MS;
      this.probeTimer = setTimeout(() => void this.probe(), interval);
      if (this.probeTimer.unref) this.probeTimer.unref();
    }
  }
}
