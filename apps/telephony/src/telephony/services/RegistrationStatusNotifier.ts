import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";

const log = childLogger("RegistrationStatusNotifier");

/**
 * Forwards pjsip endpoint registration state (AMI ContactStatus / PeerStatus)
 * to the API so it can be persisted per-device and used for the device
 * registration watchdog, admin dashboard, and "Not Registered" alerting.
 *
 * Telephony has no DB access, so this mirrors the CdrNotifier pattern: a
 * fire-and-forget HTTP POST to an internal API route secured by the shared
 * CDR_INGEST_SECRET. The destination URL is derived from CDR_INGEST_URL so no
 * additional deploy-env variable is required.
 *
 * Coalescing: qualify fires every 30s and would emit a steady stream of
 * identical "Reachable" events. We only POST when the normalized status
 * changes for an endpoint, or once every HEARTBEAT_MS to keep lastEventAt
 * fresh (so the watchdog can tell "registered & alive" from "stale").
 */

export type NormalizedRegStatus = "REGISTERED" | "UNREACHABLE" | "UNREGISTERED" | "UNKNOWN";

export function normalizeContactStatus(raw: string | undefined | null): NormalizedRegStatus {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "removed" || s === "deleted" || s === "unregistered") return "UNREGISTERED";
  if (s === "unreachable") return "UNREACHABLE";
  if (
    s === "reachable" ||
    s === "created" ||
    s === "available" ||
    s === "nonqualified" ||
    s === "non-qualified" ||
    s === "registered" ||
    s === "unknown"
  ) {
    // NB: "unknown"/"nonqualified" mean a contact exists but qualify hasn't
    // measured it — treat as registered (a contact is present), matching the
    // BLF presence mapping in TelephonyService.contactStatusToPeerStatus.
    return s === "unknown" ? "UNKNOWN" : "REGISTERED";
  }
  return "UNKNOWN";
}

/** Map a PeerStatus value (Reachable/Unreachable/Registered/Unregistered) to normalized. */
export function normalizePeerStatus(raw: string | undefined | null): NormalizedRegStatus {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "unregistered" || s === "removed") return "UNREGISTERED";
  if (s === "unreachable") return "UNREACHABLE";
  if (s === "reachable" || s === "registered") return "REGISTERED";
  return "UNKNOWN";
}

export type RegStatusInput = {
  endpoint: string;
  normalizedStatus: NormalizedRegStatus;
  rawStatus?: string | null;
  contactUri?: string | null;
  userAgent?: string | null;
  roundtripUsec?: string | null;
  tenantId?: string | null;
  source: "ami_contactstatus" | "ami_peerstatus" | "ami_bootstrap";
};

const HEARTBEAT_MS = 5 * 60 * 1000;

export class RegistrationStatusNotifier {
  private readonly url: string | undefined;
  private readonly secret: string | undefined;
  private readonly last = new Map<string, { status: NormalizedRegStatus; sentAtMs: number }>();

  constructor() {
    this.url = deriveContactStatusUrl(env.CDR_INGEST_URL);
    this.secret = env.CDR_INGEST_SECRET;
    if (!this.url) {
      log.info("CDR_INGEST_URL not set — PBX registration-state forwarding disabled");
    } else {
      log.info({ url: this.url }, "RegistrationStatusNotifier ready");
    }
  }

  notify(input: RegStatusInput): void {
    if (!this.url) return;
    const endpoint = String(input.endpoint || "").trim();
    if (!endpoint) return;

    const now = Date.now();
    const prev = this.last.get(endpoint);
    const changed = !prev || prev.status !== input.normalizedStatus;
    const heartbeatDue = !prev || now - prev.sentAtMs >= HEARTBEAT_MS;
    if (!changed && !heartbeatDue) return;

    this.last.set(endpoint, { status: input.normalizedStatus, sentAtMs: now });
    void this.postAsync(input, changed).catch((err: unknown) => {
      log.warn({ endpoint, err: (err as Error)?.message }, "reg-status ingest failed");
    });
  }

  private async postAsync(input: RegStatusInput, changed: boolean): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(this.url!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.secret ? { "x-cdr-secret": this.secret } : {}),
        },
        body: JSON.stringify({
          endpoint: input.endpoint,
          status: input.normalizedStatus,
          rawStatus: input.rawStatus ?? null,
          contactUri: input.contactUri ?? null,
          userAgent: input.userAgent ?? null,
          roundtripUsec: input.roundtripUsec ?? null,
          tenantId: input.tenantId ?? null,
          source: input.source,
          statusChanged: changed,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        log.warn({ endpoint: input.endpoint, status: res.status }, "reg-status ingest HTTP error");
      }
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }
}

/**
 * CDR_INGEST_URL is the full URL to /internal/cdr-ingest. Swap the trailing
 * internal path for /internal/pbx/contact-status so we reuse the same base
 * host + secret without requiring a new deploy-env variable.
 */
export function deriveContactStatusUrl(cdrIngestUrl: string | undefined): string | undefined {
  const base = String(cdrIngestUrl || "").trim();
  if (!base) return undefined;
  if (base.includes("/internal/")) {
    return base.replace(/\/internal\/.*$/, "/internal/pbx/contact-status");
  }
  return base.replace(/\/+$/, "") + "/internal/pbx/contact-status";
}
