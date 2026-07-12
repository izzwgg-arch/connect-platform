import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { AmiClient } from "../ami/AmiClient";
import type { AmiFrame } from "../ami/AmiTypes";

const log = childLogger("ConnectWakeConsumer");

/**
 * Telephony-side owner of wake DELIVERY for the dialplan's [connect-wake-core]
 * engine. The engine emits a non-blocking AMI `UserEvent(ConnectWake,...)` the
 * instant it decides to hold a cold inbound call in its grace window; this
 * consumer turns that signal into the existing mobile pre-wake push (the same
 * `/internal/mobile-prewake` pipeline MobilePushNotifier already uses).
 *
 * Single-ownership boundaries:
 *   • The dialplan engine OWNS the wake DECISION + emission and the grace hold.
 *   • This consumer OWNS wake DELIVERY, debounce, and wake-delivery logging.
 *   • The API/push provider OWNS the actual transport (unchanged).
 *
 * Reliability: AMI has no event replay. If telephony is down/reconnecting when
 * a ConnectWake fires, the event is simply missed and the call falls back to
 * native voicemail after the grace window — acceptable best-effort behavior
 * (a delivered push never guaranteed an in-time wake either).
 */

export interface ConnectWakeEvent {
  /** Numeric VitalPBX tenant id (the "2" in T2_cos-all). */
  tid: string;
  /** Extension number, e.g. "110". */
  ext: string;
  /** ${LINKEDID} of the inbound call (best-effort correlation id). */
  callId: string;
  /** Caller number, if present. */
  from: string | null;
}

export interface ConnectWakeDeliverInput {
  linkedId: string;
  connectTenantId: string | null;
  pbxVitalTenantId: string | null;
  toExtension: string;
  /** Caller number for the held inbound call, so the iOS VoIP wake can present
   *  a proper CallKit call with the number. Null when Asterisk gave us none. */
  fromNumber: string | null;
}

/** Minimal slice of PbxTenantMapCache this consumer depends on (keeps it testable). */
export interface TenantResolverLike {
  resolveConnectTenant(hints: {
    vitalTenantId?: string;
    tenantCode?: string;
    dialplanT?: string;
  }): string | null;
}

export interface ConnectWakeConsumerOptions {
  /** Collapse duplicate wakes for the same tenant+ext within this window (ms). */
  debounceMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable delivery for tests; defaults to the prewake HTTP POST. */
  deliver?: (input: ConnectWakeDeliverInput) => Promise<void>;
}

/**
 * Parse a raw AMI frame into a ConnectWakeEvent, or null if it is not a
 * well-formed ConnectWake UserEvent. Pure — safe to unit test directly.
 *
 * Asterisk renders `UserEvent(ConnectWake,Tenant: 2,...)` as a frame with
 * `Event: UserEvent`, `UserEvent: ConnectWake`, and one header per pair.
 */
export function parseConnectWakeEvent(frame: AmiFrame): ConnectWakeEvent | null {
  if (frame["Event"] !== "UserEvent") return null;
  if (frame["UserEvent"] !== "ConnectWake") return null;
  const tid = (frame["Tenant"] ?? "").trim();
  const ext = (frame["Extension"] ?? "").trim();
  if (!tid || !ext) return null;
  return {
    tid,
    ext,
    callId: (frame["CallId"] ?? "").trim(),
    from: (frame["From"] ?? "").trim() || null,
  };
}

export class ConnectWakeConsumer {
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly deliverFn: (input: ConnectWakeDeliverInput) => Promise<void>;
  /** key = `${tid}:${ext}` → last delivery timestamp (ms). */
  private readonly recent = new Map<string, number>();
  private readonly prewakeUrl: string | undefined;
  private readonly secret: string | undefined;
  private boundHandler: ((frame: AmiFrame) => void) | null = null;

  constructor(
    private readonly ami: AmiClient,
    private readonly tenantMap: TenantResolverLike,
    opts: ConnectWakeConsumerOptions = {},
  ) {
    const envDebounce = Number(process.env.CONNECT_WAKE_DEBOUNCE_MS ?? "");
    this.debounceMs =
      opts.debounceMs ?? (Number.isFinite(envDebounce) && envDebounce > 0 ? envDebounce : 5_000);
    this.now = opts.now ?? (() => Date.now());

    const base = env.CDR_INGEST_URL ? env.CDR_INGEST_URL.replace(/\/[^/]+$/, "") : undefined;
    this.prewakeUrl = base ? `${base}/mobile-prewake` : undefined;
    this.secret = env.CDR_INGEST_SECRET;
    this.deliverFn = opts.deliver ?? ((input) => this.postPrewake(input));
  }

  start(): void {
    if (this.boundHandler) return;
    this.boundHandler = (frame: AmiFrame) => {
      try {
        this.onFrame(frame);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "connect-wake: frame handler error",
        );
      }
    };
    this.ami.on("event", this.boundHandler);
    log.info(
      { prewake: Boolean(this.prewakeUrl), debounceMs: this.debounceMs },
      this.prewakeUrl
        ? "ConnectWakeConsumer ready"
        : "ConnectWakeConsumer ready (no prewake URL — wakes will be logged only)",
    );
  }

  stop(): void {
    if (this.boundHandler) {
      this.ami.off("event", this.boundHandler);
      this.boundHandler = null;
    }
    this.recent.clear();
  }

  /**
   * Handle one AMI frame. Returns true when a wake was accepted and dispatched,
   * false when the frame is not a ConnectWake or was debounced. Exposed for tests.
   */
  onFrame(frame: AmiFrame): boolean {
    const evt = parseConnectWakeEvent(frame);
    if (!evt) return false;
    return this.handleWake(evt);
  }

  /** Debounce + resolve + dispatch. Returns true when dispatched. */
  handleWake(evt: ConnectWakeEvent): boolean {
    const key = `${evt.tid}:${evt.ext}`;
    const now = this.now();
    const last = this.recent.get(key);
    if (last !== undefined && now - last < this.debounceMs) {
      log.info(
        { tid: evt.tid, ext: evt.ext, msAgo: now - last, debounceMs: this.debounceMs },
        "connect-wake: debounced duplicate",
      );
      return false;
    }
    this.recent.set(key, now);
    this.pruneOld(now);

    const connectTenantId = this.tenantMap.resolveConnectTenant({ vitalTenantId: evt.tid }) ?? null;
    log.info(
      { tid: evt.tid, ext: evt.ext, callId: evt.callId, connectTenantId },
      "connect-wake: delivering wake",
    );

    void this.deliverFn({
      linkedId: evt.callId,
      connectTenantId,
      pbxVitalTenantId: evt.tid,
      toExtension: evt.ext,
      fromNumber: evt.from ?? null,
    }).catch((err: unknown) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), tid: evt.tid, ext: evt.ext },
        "connect-wake: delivery failed",
      );
    });
    return true;
  }

  private pruneOld(now: number): void {
    const horizon = this.debounceMs * 4;
    for (const [k, ts] of this.recent) {
      if (now - ts > horizon) this.recent.delete(k);
    }
  }

  private async postPrewake(input: ConnectWakeDeliverInput): Promise<void> {
    if (!this.prewakeUrl) {
      log.warn(
        { tid: input.pbxVitalTenantId, ext: input.toExtension },
        "connect-wake: no prewake URL configured — wake dropped",
      );
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(this.prewakeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.secret ? { "x-cdr-secret": this.secret } : {}),
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        log.info({ status: res.status, ext: input.toExtension }, "connect-wake: prewake ok");
      } else {
        const body = await res.text().catch(() => "");
        log.warn({ status: res.status, body }, "connect-wake: prewake API error");
      }
    } catch (err: unknown) {
      clearTimeout(timer);
      if ((err as Error)?.name === "AbortError") {
        log.warn("connect-wake: prewake API timed out (5s)");
      } else {
        log.warn({ err: (err as Error)?.message }, "connect-wake: prewake API error");
      }
    }
  }
}
