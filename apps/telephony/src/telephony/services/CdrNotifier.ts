import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { NormalizedCall } from "../types";
import { isLocalOnlyCall, hasValidChannel } from "../normalizers/normalizeCallEvent";

const log = childLogger("CdrNotifier");

// Direction mapping: telephony service uses "inbound"/"outbound"; DB/KPI uses "incoming"/"outgoing"
function normalizeDirection(dir: string): "incoming" | "outgoing" | "internal" | "unknown" {
  if (dir === "inbound") return "incoming";
  if (dir === "outbound") return "outgoing";
  if (dir === "internal") return "internal";
  return "unknown";
}

// Disposition rules:
//  1. AMI Cdr event sets cdrDisposition explicitly → trust that
//  2. If answeredAt is set → answered
//  3. Inbound with no answer → missed
//  4. Outbound/internal with no answer → canceled
// resolvedDir: pass the already-inferred direction (may differ from call.direction when we
// applied number heuristics above). Avoids double-inferring direction inside this function.
function deriveDisposition(call: NormalizedCall, resolvedDir?: string): string {
  const cdrDisp = String(call.metadata?.cdrDisposition ?? "").toUpperCase().trim();
  if (cdrDisp === "ANSWERED") return "answered";
  if (cdrDisp === "NO ANSWER") return "missed";
  if (cdrDisp === "BUSY") return "busy";
  if (cdrDisp === "FAILED" || cdrDisp === "CONGESTION") return "failed";
  if (cdrDisp === "CANCEL" || cdrDisp === "CANCELED") return "canceled";

  // Infer from call data — answeredAt is set when a channel goes to Up state or a bridge forms.
  if (call.answeredAt) return "answered";
  const dir = resolvedDir ?? normalizeDirection(call.direction);
  if (dir === "incoming") return "missed";
  if (dir === "outgoing" || dir === "internal") return "canceled";
  return "unknown";
}

// Guard: skip calls that should NOT produce CDR rows.
// Returns a reason string if call should be skipped, null if it should be written.
function shouldSkip(call: NormalizedCall): string | null {
  // Must be fully ended
  if (!call.endedAt) return "no_end_time";

  // Skip if no real channel was ever involved (all helpers / Local/ / mixing/)
  // Allow calls that already had channels cleared (channels=[] after hangup is normal)
  // Instead check if the call was ever system-only by checking metadata or from/to
  if (call.channels.length > 0 && isLocalOnlyCall(call)) return "local_only";

  // Skip clearly synthetic calls with no useful data
  if (!call.from && !call.to && !call.tenantId) return "no_data";

  // Skip if direction is completely unknown AND no tenant AND duration is 0
  if (call.direction === "unknown" && !call.tenantId && call.durationSec === 0) return "unknown_no_tenant";

  return null;
}

// ── In-process observability counters ────────────────────────────────────────
// Lifetime counters (reset on container restart). Exposed via getCdrStats().
// All mutations happen synchronously on the Node.js event loop — no lock needed.
export type CdrStats = {
  notified: number;
  skipped: Record<string, number>;
  httpErrors: number;
  httpTimeouts: number;
  postedOk: number;
  since: string; // ISO timestamp of when counters were last reset
};

let _stats: CdrStats = {
  notified: 0,
  skipped: {},
  httpErrors: 0,
  httpTimeouts: 0,
  postedOk: 0,
  since: new Date().toISOString(),
};

/** Returns a snapshot of CDR notifier counters. Safe to call from any thread. */
export function getCdrStats(): Readonly<CdrStats> {
  return { ..._stats, skipped: { ..._stats.skipped } };
}

/** Reset all counters (e.g. after debugging). */
export function resetCdrStats(): void {
  _stats = {
    notified: 0,
    skipped: {},
    httpErrors: 0,
    httpTimeouts: 0,
    postedOk: 0,
    since: new Date().toISOString(),
  };
}

export type CdrPayload = {
  linkedId: string;
  tenantId: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  direction: string;
  disposition: string;
  startedAt: string;        // ISO
  answeredAt: string | null; // ISO or null
  endedAt: string;           // ISO
  durationSec: number;
  talkSec: number;
  queueId: string | null;
  hangupCause: string | null;
  channels: string[];        // Raw Asterisk channel names (e.g. PJSIP/344822_Comfortone-xxx)
  dcontext: string | null;   // last / primary AMI Cdr dcontext
  dcontexts: string[];       // all legs
  accountCode: string | null;
  pbxVitalTenantId: string | null;
  pbxTenantCode: string | null;
};

export class CdrNotifier {
  private readonly url: string | undefined;
  private readonly secret: string | undefined;

  constructor() {
    this.url = env.CDR_INGEST_URL;
    this.secret = env.CDR_INGEST_SECRET;

    if (!this.url) {
      log.info("CDR_INGEST_URL not set — CDR persistence disabled");
    } else {
      log.info({ url: this.url }, "CdrNotifier ready");
    }
  }

  // Called for every callUpsert with state=hungup.
  // Fire-and-forget: errors are logged but never thrown.
  notify(call: NormalizedCall): void {
    if (!this.url) return;

    _stats.notified++;

    const skipReason = shouldSkip(call);
    if (skipReason) {
      _stats.skipped[skipReason] = (_stats.skipped[skipReason] ?? 0) + 1;
      if (env.ENABLE_TELEPHONY_DEBUG) {
        log.debug({ linkedId: call.id, reason: skipReason }, "cdr: skipped");
      } else {
        // Always log skips with direction/tenant info so missing calls are visible in prod
        log.info(
          {
            linkedId: call.id,
            reason: skipReason,
            direction: call.direction,
            tenantId: call.tenantId ?? null,
            from: call.from ?? null,
            to: call.to ?? null,
            durationSec: call.durationSec,
            dcontext: (call.metadata?.cdrDcontext as string | undefined) ?? null,
          },
          "cdr: skipped",
        );
      }
      return;
    }

    let dir = normalizeDirection(call.direction);

    // dcontext from the AMI Cdr event is the most authoritative direction signal.
    // It tells us the Asterisk dialplan context that originated the call:
    //   "ext-local-*" / "from-internal" = user-originated (outgoing or internal)
    //   "from-trunk" / "from-pstn"       = PSTN inbound
    // This MUST be checked first because the number heuristic fails when
    // both from and to are full 10-digit PSTN numbers (outbound call showing DID as caller-ID).
    const dcontext = (call.metadata?.cdrDcontext as string | undefined) ?? null;
    if (dcontext) {
      const dctx = dcontext.toLowerCase();
      if (
        dctx.includes("from-trunk") || dctx.includes("from-pstn") ||
        dctx.includes("from-external") || dctx.includes("inbound") ||
        /^ivr-\d/.test(dctx) || /^trk-[^-]+-in/.test(dctx)
      ) {
        dir = "incoming";
      } else if (
        dctx.includes("from-internal") || dctx.includes("ext-local") || dctx.includes("outbound") ||
        /^trk-[^-]+-dial/.test(dctx) || /^t\d+_cos-/.test(dctx) || dctx.includes("sub-local-dialing")
      ) {
        const dstDigits = (call.to ?? "").replace(/[^\d]/g, "").replace(/^1(\d{10})$/, "$1");
        const dstShort = dstDigits.length >= 2 && dstDigits.length <= 6;
        dir = dstShort ? "internal" : "outgoing";
      }
    }

    // Fallback: number-length heuristic only when dcontext gave no signal and direction is still unknown.
    if (dir === "unknown" && (call.from || call.to)) {
      const srcDigits = (call.from ?? "").replace(/[^\d]/g, "").replace(/^1(\d{10})$/, "$1");
      const dstDigits = (call.to  ?? "").replace(/[^\d]/g, "").replace(/^1(\d{10})$/, "$1");
      const srcLong  = srcDigits.length >= 10;
      const dstLong  = dstDigits.length >= 10;
      const srcShort = srcDigits.length >= 2 && srcDigits.length <= 6;
      const dstShort = dstDigits.length >= 2 && dstDigits.length <= 6;
      if (srcShort && dstLong) dir = "outgoing";
      else if (srcLong && dstShort) dir = "incoming";
      else if (srcShort && dstShort) dir = "internal";
      else if (srcLong) dir = "incoming";
    }

    const disposition = deriveDisposition(call, dir);

    // talkSec: time from answer to end (0 if unanswered)
    let talkSec = 0;
    if (call.answeredAt && call.endedAt) {
      talkSec = Math.max(0, Math.round(
        (new Date(call.endedAt).getTime() - new Date(call.answeredAt).getTime()) / 1000
      ));
    }

    const dcxList = (call.metadata?.cdrDcontexts as string[] | undefined) ?? [];
    const primaryDctx = (call.metadata?.cdrDcontext as string | undefined) ?? null;
    const dcontexts = dcxList.length > 0 ? dcxList : primaryDctx ? [primaryDctx] : [];

    const payload: CdrPayload = {
      linkedId: call.linkedId,
      tenantId: call.tenantId ?? null,
      fromNumber: call.from ?? null,
      toNumber: call.to ?? null,
      direction: dir,
      disposition,
      startedAt: call.startedAt,
      answeredAt: call.answeredAt ?? null,
      endedAt: call.endedAt!,
      durationSec: call.durationSec,
      talkSec,
      queueId: call.queueId ?? null,
      hangupCause: String(call.metadata?.hangupCause ?? "") || null,
      channels: (call.metadata?.seenChannels as string[] | undefined) ?? call.channels,
      dcontext: primaryDctx,
      dcontexts,
      accountCode: (call.metadata?.cdrAccountCode as string | undefined) ?? null,
      pbxVitalTenantId: (call.metadata?.pbxVitalTenantId as string | undefined) ?? null,
      pbxTenantCode: (call.metadata?.pbxTenantCode as string | undefined) ?? null,
    };

    if (env.ENABLE_TELEPHONY_DEBUG) {
      log.debug({ linkedId: call.id, direction: dir, disposition, talkSec }, "cdr: notifying");
    }

    // Fire-and-forget — don't block the AMI event loop
    this.postAsync(payload).catch((err: unknown) => {
      log.warn({ linkedId: call.id, err: (err as Error)?.message }, "cdr: ingest failed");
    });
  }

  private async postAsync(payload: CdrPayload): Promise<void> {
    // Retry up to 3 times with brief exponential backoff (1s, 2s, 4s).
    // Covers transient network blips and brief API container restarts during deploys.
    const MAX_ATTEMPTS = 3;
    const TIMEOUT_MS = 8000;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(this.url!, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.secret ? { "x-cdr-secret": this.secret } : {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          _stats.httpErrors++;
          log.warn({ linkedId: payload.linkedId, status: res.status, attempt }, "cdr: ingest HTTP error");
          // 4xx errors are not retryable (bad payload); 5xx are retryable
          if (res.status < 500) return;
          lastErr = new Error(`HTTP ${res.status}`);
        } else {
          _stats.postedOk++;
          return;
        }
      } catch (err: unknown) {
        clearTimeout(timer);
        if ((err as Error)?.name === "AbortError") {
          _stats.httpTimeouts++;
          log.warn({ linkedId: payload.linkedId, attempt }, "cdr: ingest POST timed out (8s)");
          lastErr = err;
        } else {
          _stats.httpErrors++;
          lastErr = err;
        }
      }

      if (attempt < MAX_ATTEMPTS) {
        const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    log.error(
      { linkedId: payload.linkedId, err: (lastErr as Error)?.message, attempts: MAX_ATTEMPTS },
      "cdr: ingest failed after all retries — call will be missing from Connect",
    );
  }
}
