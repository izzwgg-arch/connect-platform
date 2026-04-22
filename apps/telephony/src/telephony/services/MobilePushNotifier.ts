import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { NormalizedCall } from "../types";

const log = childLogger("MobilePushNotifier");

// Short extension pattern: 2–6 digit numbers only (not trunk peer IDs like "344022_gesheft")
const SHORT_EXT_RE = /^\d{2,6}$/;

/**
 * Extract a plain extension number from a raw string that may be:
 *   "103"        → "103"   (direct SIP peer)
 *   "T8_103"     → "103"   (VitalPBX multi-tenant: Tcode_extension)
 *   "344022"     → null    (6-digit VitalPBX peer ID — too long or no context)
 *   "344022_gesheft" → null (not a numeric extension)
 *
 * Returns null if the string cannot be reduced to a short (2–6 digit) extension.
 */
function extractShortExtension(raw: string): string | null {
  // Direct short number: e.g. "103"
  if (SHORT_EXT_RE.test(raw)) return raw;
  // VitalPBX multi-tenant: "T{code}_{ext}" e.g. "T8_103" → "103"
  const m = /^T\d+_(\d{2,6})$/i.exec(raw);
  if (m?.[1]) return m[1];
  return null;
}

export type MobilePushRingPayload = {
  linkedId: string;
  toExtension: string;
  fromNumber: string | null;
  fromDisplay: string | null;
  connectTenantId: string | null;
  pbxVitalTenantId: string | null;
  state?: "ringing" | "hungup";
};

/**
 * Fires a mobile push notification to the API when an inbound call rings at an extension.
 * This bridges the telephony service (which sees all PBX events) to the API's
 * CallInvite + Expo push pipeline (which requires knowledge of registered devices).
 *
 * Pattern mirrors CdrNotifier: fire-and-forget HTTP POST to /internal/mobile-ring-notify.
 */
export class MobilePushNotifier {
  private readonly url: string | undefined;
  private readonly secret: string | undefined;
  // De-dupe set: once we have found extensions and sent a push for a linkedId,
  // skip subsequent callUpsert events for the same call.
  private readonly pushed = new Set<string>();

  constructor() {
    const base = env.CDR_INGEST_URL
      ? env.CDR_INGEST_URL.replace(/\/[^/]+$/, "")
      : undefined;
    this.url = base ? `${base}/mobile-ring-notify` : undefined;
    this.secret = env.CDR_INGEST_SECRET;

    if (!this.url) {
      log.info("CDR_INGEST_URL not set — mobile ring push disabled");
    } else {
      log.info({ url: this.url }, "MobilePushNotifier ready");
    }
  }

  notify(call: NormalizedCall): void {
    if (!this.url) return;

    // Verbose entry log so we can trace every call through the push pipeline.
    log.info({ linkedId: call.linkedId, state: call.state, dir: call.direction, exts: call.extensions, from: call.from, tenantId: call.tenantId }, "mobile-ring: notify-entry");

    // Hangup path: notify API so it can mark the invite CANCELED + send an
    // INVITE_CANCELED push. This is the ONLY real-time hangup signal we get
    // before CDR ingest (which arrives 20–60s later), so it's critical for
    // stopping the native ringtone the moment the caller hangs up.
    if (call.state === "hungup") {
      const wasPushed = this.pushed.has(call.linkedId);
      this.pushed.delete(call.linkedId);
      if (!wasPushed) return;
      const payload: MobilePushRingPayload = {
        linkedId: call.linkedId,
        toExtension: "",
        fromNumber: call.from ?? null,
        fromDisplay: call.fromName ?? null,
        connectTenantId: call.tenantId ?? null,
        pbxVitalTenantId: (call.metadata?.pbxVitalTenantId as string | undefined) ?? null,
        state: "hungup",
      };
      log.info(
        { linkedId: call.linkedId, connectTenantId: call.tenantId, from: call.from },
        "mobile-ring: notifying API of hangup",
      );
      this.postAsync(payload).catch((err: unknown) => {
        log.warn(
          { linkedId: call.linkedId, err: (err as Error)?.message },
          "mobile-ring: hangup notify failed",
        );
      });
      return;
    }

    // Push for inbound (PSTN→extension) AND internal (extension→extension) ringing calls.
    // Allow any pre-answer state: "ringing", "unknown", or "dialing".
    // Extension resolution on VitalPBX multi-tenant often lands in "dialing"/"unknown"
    // by the time the target extension channel appears — we must allow those states too.
    const PRE_ANSWER_STATES = new Set(["ringing", "unknown", "dialing"]);
    if (!PRE_ANSWER_STATES.has(call.state)) return;
    if (call.direction !== "inbound" && call.direction !== "internal") return;

    // Already sent a push for this call — skip.
    if (this.pushed.has(call.linkedId)) return;

    // For internal calls (ext→ext), exclude the calling extension so we only notify
    // the RECEIVING side. For inbound PSTN calls, call.from is a 10-digit PSTN number
    // so it never matches a short extension — all listed extensions are recipients.
    const callerExt = extractShortExtension(call.from ?? "");

    // Extract short extension numbers (e.g. "103") from the extensions list.
    // Handles both plain "103" and VitalPBX multi-tenant "T8_103" formats.
    // Trunk peer IDs (e.g. "344022_gesheft") and the calling party are filtered out.
    const toExtensions = [...new Set(
      call.extensions
        .map(extractShortExtension)
        .filter((x): x is string => x !== null && x !== callerExt)
    )];
    if (toExtensions.length === 0) {
      // Extensions not yet resolved in this event — will retry on next callUpsert.
      return;
    }

    // Mark pushed BEFORE async calls so concurrent callUpsert events don't double-send.
    this.pushed.add(call.linkedId);

    const pbxVitalTenantId =
      (call.metadata?.pbxVitalTenantId as string | undefined) ?? null;

    for (const ext of toExtensions) {
      const payload: MobilePushRingPayload = {
        linkedId: call.linkedId,
        toExtension: ext,
        fromNumber: call.from ?? null,
        fromDisplay: call.fromName ?? null,
        connectTenantId: call.tenantId ?? null,
        pbxVitalTenantId,
      };

      log.info(
        {
          linkedId: call.linkedId,
          toExtension: ext,
          connectTenantId: call.tenantId,
          from: call.from,
        },
        "mobile-ring: notifying API",
      );

      this.postAsync(payload).catch((err: unknown) => {
        log.warn(
          { linkedId: call.linkedId, toExtension: ext, err: (err as Error)?.message },
          "mobile-ring: API notify failed",
        );
      });
    }
  }

  private async postAsync(payload: MobilePushRingPayload): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
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
        const body = await res.text().catch(() => "");
        log.warn(
          { status: res.status, body },
          "mobile-ring: API returned error",
        );
      } else {
        log.info({ status: res.status }, "mobile-ring: API notified ok");
      }
    } catch (err: unknown) {
      clearTimeout(timer);
      if ((err as Error)?.name === "AbortError") {
        log.warn("mobile-ring: API notify timed out (8s)");
      } else {
        log.warn({ err: (err as Error)?.message }, "mobile-ring: API notify error");
      }
    }
  }
}
