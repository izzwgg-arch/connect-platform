import Redis from "ioredis";
import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { NormalizedCall } from "../types";
import { getRtpStatsForChannels } from "./RtpStatsSampler";
import { isLocalOnlyCall, hasValidChannel } from "../normalizers/normalizeCallEvent";

const log = childLogger("CdrNotifier");

// ── Durable retry queue (2026-08-04) ─────────────────────────────────────────
// The in-process retry (3 attempts, ~7s) cannot survive an API deploy — every
// call that ended during a restart window was permanently lost ("cdr: ingest
// failed after all retries"). Failed payloads now go to a Redis list and are
// re-posted every RETRY_DRAIN_INTERVAL_MS until the API accepts them. The list
// survives both API and telephony restarts.
const RETRY_QUEUE_KEY = "telephony:cdr:retry:v1";
const RETRY_DRAIN_INTERVAL_MS = 30_000;
const RETRY_DRAIN_BATCH = 50;
// ~7 days at one drain attempt per 30s round. A payload this old means the API
// rejected or the queue was stuck for a week — log loudly and drop.
const RETRY_MAX_ATTEMPTS = 20_160;

type QueuedCdr = {
  payload: CdrPayload;
  attempts: number;
  firstFailedAt: string;
};

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
/**
 * True when an incoming call was "answered" ONLY by the voicemail application —
 * i.e. no human/device leg ever answered. Asterisk marks the caller channel
 * ANSWERED the moment VoiceMail() picks up, which historically made
 * ring-to-voicemail calls show as answered/incoming in call history instead of
 * missed. Detection (verified against live PBX CDR 2026-07-28): the flow emits
 * a "Dial"/NO ANSWER leg followed by a "VoiceMail"/ANSWERED leg (destination
 * sometimes rewritten to "VM-<ext>"). A real answer always leaves an ANSWERED
 * leg whose lastapp is NOT VoiceMail (Dial/Queue/etc), so requiring EVERY
 * answered leg to be a voicemail leg cannot misfire on answered calls,
 * transfers, or ring groups answered by a colleague.
 */
export function isVoicemailOnlyAnswer(call: NormalizedCall): boolean {
  type Leg = { destination?: string; disposition?: string; lastApplication?: string };
  const legs = (call.metadata?.cdrLegs as Leg[] | undefined) ?? [];
  if (legs.length === 0) return false;
  const answered = legs.filter((l) => String(l.disposition ?? "").toUpperCase().trim() === "ANSWERED");
  if (answered.length === 0) return false;
  const isVmLeg = (l: Leg) =>
    /voicemail/i.test(String(l.lastApplication ?? "")) ||
    /^vm-/i.test(String(l.destination ?? "").trim());
  return answered.every(isVmLeg);
}

export function deriveDisposition(call: NormalizedCall, resolvedDir?: string): string {
  // Voicemail "answers" are missed calls from the callee's point of view.
  // Checked FIRST because both the explicit ANSWERED disposition and the
  // answeredAt inference below would otherwise classify them as answered.
  // Scoped to incoming calls — the only direction where "reached voicemail"
  // means the user missed the call.
  const dirForVm = resolvedDir ?? normalizeDirection(call.direction);
  if (dirForVm === "incoming" && isVoicemailOnlyAnswer(call)) return "missed";

  // HARDENED (Izzy 2026-07-29): a genuine tenant-extension leg answered.
  // extensionAnsweredAt is set ONLY by real extension pickups — never by
  // inbound-trunk IVR Answer() or ringback early media (see NormalizedCall).
  // It outranks leg-level "NO ANSWER" evidence: on a multi-device fork the
  // answering device's own CDR record can be missing or late, leaving only
  // the unanswered siblings' NO ANSWER records — which classified a 40s
  // answered call as missed (live repro linkedId 1785378877.138561).
  // Answered by a human anywhere ⇒ answered, no matter which device.
  if (dirForVm === "incoming" && call.extensionAnsweredAt) return "answered";

  const cdrDisp = String(call.metadata?.cdrDisposition ?? "").toUpperCase().trim();
  if (cdrDisp === "ANSWERED") return "answered";
  // Direction-aware: "NO ANSWER" is a MISSED call only for the callee. For an
  // outgoing/internal call it means the FAR side didn't pick up — that is a
  // canceled/unanswered outbound, never "missed". (Regression 2026-07-28:
  // enabling AMI Cdr events made outgoing unanswered calls display as Missed
  // in Recents because this mapping ignored direction.)
  if (cdrDisp === "NO ANSWER") return dirForVm === "incoming" ? "missed" : "canceled";
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
  fromName: string | null;
  /** Ring-group CID prefix (deduped), kept separate from fromName. */
  fromPrefix: string | null;
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
  // Absolute filesystem path reported by AMI when MixMonitor() was invoked.
  // Example: /var/spool/asterisk/monitor/<tenant_hash>/YYYY/MM/DD/<name>.wav
  // Null when the call was not recorded (no MIXMONITOR_FILENAME VarSet).
  recordingAbsPath: string | null;
  // Final PBX-side RTP samples for this call's channels (both directions —
  // rx = the remote party's uplink the app can never measure). Collected by
  // RtpStatsSampler while the call was live; empty when sampling was off or
  // the call was shorter than one sampling tick.
  rtpStats?: import("./RtpStatsSampler").RtpChannelStatSample[];
};

export class CdrNotifier {
  private readonly url: string | undefined;
  private readonly secret: string | undefined;
  private readonly redis: Redis | null = null;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;

  constructor(opts?: { redisUrl?: string }) {
    this.url = env.CDR_INGEST_URL;
    this.secret = env.CDR_INGEST_SECRET;

    const redisUrl = opts?.redisUrl?.trim();
    if (this.url && redisUrl) {
      this.redis = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
      });
      // A broken Redis must never break call handling — queueing is best-effort
      // on top of the in-process retries.
      this.redis.on("error", (err) => {
        log.warn({ err: err?.message }, "cdr-retry-queue: redis error");
      });
      this.startRetryDrain();
    }

    if (!this.url) {
      log.info("CDR_INGEST_URL not set — CDR persistence disabled");
    } else {
      log.info({ url: this.url, durableRetry: this.redis != null }, "CdrNotifier ready");
    }
  }

  startRetryDrain(): void {
    if (!this.redis || this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      void this.drainRetryQueue().catch((err: unknown) => {
        log.warn({ err: (err as Error)?.message }, "cdr-retry-queue: drain error");
      });
    }, RETRY_DRAIN_INTERVAL_MS);
    if (this.drainTimer.unref) this.drainTimer.unref();
  }

  stopRetryDrain(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.redis) void this.redis.quit().catch(() => undefined);
  }

  private async enqueueForDurableRetry(payload: CdrPayload, cause: string): Promise<boolean> {
    if (!this.redis) return false;
    try {
      const item: QueuedCdr = { payload, attempts: 0, firstFailedAt: new Date().toISOString() };
      const depth = await this.redis.rpush(RETRY_QUEUE_KEY, JSON.stringify(item));
      log.warn(
        { linkedId: payload.linkedId, cause, queueDepth: depth },
        "cdr: ingest failed after in-process retries — queued for durable retry",
      );
      return true;
    } catch (err: unknown) {
      log.error(
        { linkedId: payload.linkedId, err: (err as Error)?.message },
        "cdr-retry-queue: enqueue failed — call may be missing from Connect until backfill",
      );
      return false;
    }
  }

  /** Re-post queued payloads. Stops the round on the first failure (API still down). */
  async drainRetryQueue(): Promise<void> {
    if (!this.redis || !this.url || this.draining) return;
    this.draining = true;
    try {
      let recovered = 0;
      for (let i = 0; i < RETRY_DRAIN_BATCH; i++) {
        const raw = await this.redis.lpop(RETRY_QUEUE_KEY);
        if (!raw) break;
        let item: QueuedCdr;
        try {
          item = JSON.parse(raw) as QueuedCdr;
        } catch {
          log.error({ raw: raw.slice(0, 200) }, "cdr-retry-queue: dropping unparseable item");
          continue;
        }
        const outcome = await this.tryPostOnce(item.payload);
        if (outcome === "ok" || outcome === "fatal") {
          // fatal = 4xx: the API examined and rejected the payload; retrying
          // forever cannot fix it. It is already logged by tryPostOnce.
          if (outcome === "ok") recovered++;
          continue;
        }
        item.attempts += 1;
        if (item.attempts >= RETRY_MAX_ATTEMPTS) {
          log.error(
            { linkedId: item.payload.linkedId, attempts: item.attempts, firstFailedAt: item.firstFailedAt },
            "cdr-retry-queue: giving up after max attempts — call missing from Connect",
          );
          continue;
        }
        await this.redis.rpush(RETRY_QUEUE_KEY, JSON.stringify(item));
        break; // API still unreachable — try again next round
      }
      const depth = await this.redis.llen(RETRY_QUEUE_KEY);
      if (recovered > 0 || depth > 0) {
        log.info({ recovered, queueDepth: depth }, "cdr-retry-queue: drain round finished");
      }
    } finally {
      this.draining = false;
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

    // When a from-trunk CDR confirmed this call as inbound, the main record must always be
    // "incoming" regardless of what later CDR events (outbound PSTN legs) wrote into
    // cdrDcontext.  The outbound legs are emitted as separate records below.
    const inboundConfirmed = call.metadata?.inboundConfirmedByCdr === true;

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
    const srcLong   = srcDigits.length >= 10;
    const dstLong   = dstDigits.length >= 10;
    const srcShort  = srcDigits.length >= 2 && srcDigits.length <= 6;
    const dstShort  = dstDigits.length >= 2 && dstDigits.length <= 6;
    // 7–9 digit destination: PBX local-number expansion may not have run yet
    // (e.g. extension 106 dials 2224034; PBX expands to 8452224034 on the trunk).
    // Treat src=extension + dst=7–9 digits as outgoing, never incoming.
    const dstLocalPstn = dstDigits.length >= 7 && dstDigits.length <= 9;
    if (srcShort && dstLong) dir = "outgoing";
    else if (srcShort && dstLocalPstn) dir = "outgoing";
    else if (srcLong && dstShort) dir = "incoming";
    else if (srcShort && dstShort) dir = "internal";
    // srcLong with no clear dst signal: leave as unknown — do not guess incoming,
    // because the trunk CDR leg of an outbound call also has srcLong (the caller-ID DID).
    }

    // Final override: a call confirmed inbound by an authoritative from-trunk CDR is always
    // "incoming" for its main record, even when an outbound-context CDR leg fired last and
    // the heuristics above derived "outgoing" from cdrDcontext.
    if (inboundConfirmed) dir = "incoming";

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
      fromName: call.fromName ?? null,
      fromPrefix: call.fromPrefix ?? null,
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
      recordingAbsPath: (call.metadata?.recordingAbsPath as string | undefined) ?? null,
      rtpStats: getRtpStatsForChannels((call.metadata?.seenChannels as string[] | undefined) ?? call.channels),
    };

    if (env.ENABLE_TELEPHONY_DEBUG) {
      log.debug({ linkedId: call.id, direction: dir, disposition, talkSec }, "cdr: notifying");
    }

    // Fire-and-forget — don't block the AMI event loop
    this.postAsync(payload).catch((err: unknown) => {
      log.warn({ linkedId: call.id, err: (err as Error)?.message }, "cdr: ingest failed");
    });

    // ── Outbound PSTN leg detection ───────────────────────────────────────────
    // When an inbound call (confirmed by from-trunk CDR) also dials a real external PSTN
    // destination — e.g. via a virtual extension, follow-me, ring-group outbound route,
    // or any dialplan path that triggers an outbound trunk dial — we emit a SEPARATE
    // CdrPayload for that leg so it appears as an outgoing record in history and counts.
    //
    // Detection criteria:
    //   1. The overall call was confirmed inbound by a from-trunk CDR event.
    //   2. At least one accumulated CDR leg has an outbound-type dcontext.
    //   3. That leg's destination is ≥7 digits (PSTN or local-expanded number).
    //      Short extensions (2–6 digits) are ring-group/queue attempts — not PSTN dials.
    //
    // The synthetic linkedId suffix ":out" (or ":out1", ":out2" …) ensures the API upserts
    // a new ConnectCdr row distinct from the main inbound record.
    if (inboundConfirmed) {
      type StoredLeg = {
        source: string; destination: string; dcontext: string;
        duration: number; billableSec: number; disposition: string;
      };
      const allLegs = (call.metadata?.cdrLegs as StoredLeg[] | undefined) ?? [];
      let outIdx = 0;
      for (const leg of allLegs) {
        const dctx = (leg.dcontext ?? "").toLowerCase();
        const isOutboundCtx =
          dctx.includes("from-internal") ||
          dctx.includes("ext-local")     ||
          dctx.includes("sub-local-dialing") ||
          dctx.includes("outbound")      ||
          /^t\d+_cos-/.test(dctx)        ||
          /^trk-[^-]+-dial/.test(dctx);
        if (!isOutboundCtx) continue;

        const dstDigits = (leg.destination ?? "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
        if (dstDigits.length < 7) continue; // extension attempt (2–6 digits) — not a PSTN dial

        const suffix = outIdx === 0 ? ":out" : `:out${outIdx}`;
        outIdx++;

        const legDisp = String(leg.disposition ?? "").toUpperCase();
        const legDisposition: string =
          legDisp === "ANSWERED"                           ? "answered" :
          legDisp === "BUSY"                               ? "busy"     :
          legDisp === "FAILED" || legDisp === "CONGESTION" ? "failed"   :
          legDisp === "CANCEL" || legDisp === "CANCELED"   ? "canceled" :
          "missed";

        const outPayload: CdrPayload = {
          linkedId:         call.linkedId + suffix,
          tenantId:         payload.tenantId,
          fromNumber:       leg.source      || null,
          fromName:         null,
          fromPrefix:       null,
          toNumber:         leg.destination || null,
          direction:        "outgoing",
          disposition:      legDisposition,
          startedAt:        call.startedAt,
          answeredAt:       call.answeredAt ?? null,
          endedAt:          call.endedAt!,
          durationSec:      leg.duration,
          talkSec:          leg.billableSec,
          queueId:          null,
          hangupCause:      null,
          channels:         payload.channels,
          dcontext:         leg.dcontext || null,
          dcontexts:        leg.dcontext ? [leg.dcontext] : [],
          accountCode:      payload.accountCode,
          pbxVitalTenantId: payload.pbxVitalTenantId,
          pbxTenantCode:    payload.pbxTenantCode,
          // Outbound leg reuses the same on-disk recording as the parent call.
          recordingAbsPath: payload.recordingAbsPath,
        };

        if (env.ENABLE_TELEPHONY_DEBUG) {
          log.debug(
            { linkedId: outPayload.linkedId, to: outPayload.toNumber, dcontext: leg.dcontext },
            "cdr: outbound-pstn-leg notifying",
          );
        } else {
          log.info(
            { linkedId: outPayload.linkedId, from: outPayload.fromNumber, to: outPayload.toNumber },
            "cdr: outbound-pstn-leg detected in inbound call",
          );
        }

        this.postAsync(outPayload).catch((err: unknown) => {
          log.warn(
            { linkedId: outPayload.linkedId, err: (err as Error)?.message },
            "cdr: outbound-leg ingest failed",
          );
        });
      }
    }
  }

  /** One POST attempt. "fatal" = 4xx (API rejected the payload; retrying can't fix it). */
  private async tryPostOnce(payload: CdrPayload): Promise<"ok" | "retryable" | "fatal"> {
    const TIMEOUT_MS = 8000;
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
      if (res.ok) {
        _stats.postedOk++;
        return "ok";
      }
      _stats.httpErrors++;
      log.warn({ linkedId: payload.linkedId, status: res.status }, "cdr: ingest HTTP error");
      return res.status < 500 ? "fatal" : "retryable";
    } catch (err: unknown) {
      clearTimeout(timer);
      if ((err as Error)?.name === "AbortError") {
        _stats.httpTimeouts++;
        log.warn({ linkedId: payload.linkedId }, "cdr: ingest POST timed out (8s)");
      } else {
        _stats.httpErrors++;
      }
      return "retryable";
    }
  }

  private async postAsync(payload: CdrPayload): Promise<void> {
    // Fast path: up to 3 in-process attempts with brief backoff (covers network
    // blips). Anything that still fails goes to the durable Redis queue, which
    // survives API deploys and telephony restarts — the old 3-and-done behavior
    // permanently lost every call that ended during an API restart window.
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const outcome = await this.tryPostOnce(payload);
      if (outcome === "ok" || outcome === "fatal") return;
      if (attempt < MAX_ATTEMPTS) {
        const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    const queued = await this.enqueueForDurableRetry(payload, "in_process_retries_exhausted");
    if (!queued) {
      // Kept verbatim so existing log-based monitoring still fires on the worst case.
      log.error(
        { linkedId: payload.linkedId, attempts: MAX_ATTEMPTS },
        "cdr: ingest failed after all retries — call will be missing from Connect",
      );
    }
  }
}
