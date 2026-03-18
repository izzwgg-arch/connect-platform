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
  dcontext: string | null;   // AMI Cdr dcontext — VitalPBX names this "ext-local-{slug}", "from-pstn-{slug}", etc.
  accountCode: string | null; // AMI Cdr accountCode — sometimes set to tenant slug
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

    const skipReason = shouldSkip(call);
    if (skipReason) {
      if (env.ENABLE_TELEPHONY_DEBUG) {
        log.debug({ linkedId: call.id, reason: skipReason }, "cdr: skipped");
      }
      return;
    }

    let dir = normalizeDirection(call.direction);

    // If direction is still unknown, try to infer from caller/callee number lengths.
    // A long (7+ digit) source number is almost always an inbound call from PSTN.
    // A short source with a long destination is an outbound call from an extension.
    // This runs in the notifier so it applies even when the AMI Cdr event isn't available.
    if (dir === "unknown" && (call.from || call.to)) {
      const srcDigits = (call.from ?? "").replace(/[^\d]/g, "").replace(/^1(\d{10})$/, "$1");
      const dstDigits = (call.to  ?? "").replace(/[^\d]/g, "").replace(/^1(\d{10})$/, "$1");
      // Only count a number as "external PSTN" if it's 10+ digits (full national number).
      // 7-digit local numbers are ambiguous and should not trigger outgoing classification.
      const srcLong  = srcDigits.length >= 10;
      const dstLong  = dstDigits.length >= 10;
      const srcShort = srcDigits.length >= 2 && srcDigits.length <= 6;
      const dstShort = dstDigits.length >= 2 && dstDigits.length <= 6;
      if (srcLong)                   dir = "incoming";
      else if (srcShort && dstLong)  dir = "outgoing";
      else if (srcShort && dstShort) dir = "internal";
    }

    const disposition = deriveDisposition(call, dir);

    // talkSec: time from answer to end (0 if unanswered)
    let talkSec = 0;
    if (call.answeredAt && call.endedAt) {
      talkSec = Math.max(0, Math.round(
        (new Date(call.endedAt).getTime() - new Date(call.answeredAt).getTime()) / 1000
      ));
    }

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
      // call.channels is empty by hangup time (cleared as each leg ends).
      // Use metadata.seenChannels which accumulates all channels during the call lifetime.
      channels: (call.metadata?.seenChannels as string[] | undefined) ?? call.channels,
      // AMI Cdr dcontext is the most reliable tenant indicator for VitalPBX — e.g. "ext-local-relax_tires".
      // accountCode may also carry the tenant slug in some VitalPBX installations.
      dcontext: (call.metadata?.cdrDcontext as string | undefined) ?? null,
      accountCode: (call.metadata?.cdrAccountCode as string | undefined) ?? null,
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
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
      if (!res.ok) {
        log.warn({ linkedId: payload.linkedId, status: res.status }, "cdr: ingest HTTP error");
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
