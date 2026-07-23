/**
 * Future-proofing self-heal for Sync SIP: periodically re-runs the (now
 * live-check-aware) extension sync for every PBX-linked tenant and reports
 * on "drift" — extensions where a WebRTC device only became visible through
 * the live AMI/API cross-check (`pbxExtensionSync.ts`'s
 * `confirmWebrtcDeviceLive`), not VitalPBX's bulk extensions list. That is
 * exactly the ext 107 / T8 "Gesheft" bug shape: an admin-created "_1" device
 * that's genuinely live on the PBX but invisible to the bulk API.
 *
 * This complements (does not replace) `apps/api/src/server.ts`'s existing
 * 5-minute `runAutoPbxSync` — that job silently keeps Connect's DB in sync;
 * this one is the dedicated drift-observability + alerting signal, run less
 * often, from a separate process, so a stuck/disabled api-side timer doesn't
 * leave WebRTC drift undetected indefinitely.
 *
 * Strictly READ-ONLY against the PBX — delegates all PBX access to the
 * already-read-only `syncExtensionsFromPbx` (GET only, no Apply Changes, no
 * tenant writes). See AGENTS.md.
 */
import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { VitalPbxClient } from "@connect/integrations";
import { syncExtensionsFromPbx, type ExtensionSyncResult } from "../../api/src/pbxExtensionSync";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getVitalPbxClientForWorker(input: { baseUrl: string; token: string; secret?: string | null }): VitalPbxClient {
  return new VitalPbxClient({
    baseUrl: input.baseUrl,
    apiToken: input.token,
    apiSecret: input.secret || undefined,
    timeoutMs: Number(process.env.PBX_TIMEOUT_MS || 10000),
  });
}

let _pbxWebrtcDriftReconcileRunning = false;

export type PbxWebrtcDriftReconcileSummary = {
  msg: "pbx-webrtc-drift-reconcile-summary";
  started_at_iso: string;
  duration_ms: number;
  instances_scanned: number;
  instance_errors: number;
  total_extensions_found: number;
  total_live_confirmed_webrtc: number;
  total_errors: number;
  per_instance: Array<{
    pbxInstanceId: string;
    ok: boolean;
    error?: string;
    liveConfirmedWebrtc: number;
    extensionsFound: number;
  }>;
  drift_detected: boolean;
};

/**
 * @internal exported for tests — decides whether this cycle's findings
 * warrant an operator-visible alert log line.
 */
export function evaluatePbxWebrtcDriftAlert(summary: {
  total_live_confirmed_webrtc: number;
  instance_errors: number;
}): { alert: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (summary.total_live_confirmed_webrtc > 0) {
    reasons.push("bulk_vitalpbx_api_missed_a_live_webrtc_device");
  }
  if (summary.instance_errors > 0) {
    reasons.push("pbx_instance_unreachable_or_credentials_invalid");
  }
  return { alert: reasons.length > 0, reasons };
}

export async function runPbxWebrtcDriftReconcileCycle(): Promise<PbxWebrtcDriftReconcileSummary | null> {
  if (_pbxWebrtcDriftReconcileRunning) return null;
  _pbxWebrtcDriftReconcileRunning = true;
  const started = Date.now();

  try {
    const instances = await db.pbxInstance.findMany({ where: { isEnabled: true } });

    const perInstance: PbxWebrtcDriftReconcileSummary["per_instance"] = [];
    let totalExtensionsFound = 0;
    let totalLiveConfirmedWebrtc = 0;
    let totalErrors = 0;
    let instanceErrors = 0;

    for (const instance of instances) {
      try {
        const auth = decryptJson<{ token: string; secret?: string | null }>(instance.apiAuthEncrypted);
        const client = getVitalPbxClientForWorker({
          baseUrl: instance.baseUrl,
          token: auth.token,
          secret: auth.secret || null,
        });

        const result: ExtensionSyncResult = await syncExtensionsFromPbx(db as any, instance.id, client, {});

        totalExtensionsFound += result.totalExtensions;
        totalLiveConfirmedWebrtc += result.totalLiveConfirmedWebrtc;
        totalErrors += result.totalErrors;
        perInstance.push({
          pbxInstanceId: instance.id,
          ok: true,
          liveConfirmedWebrtc: result.totalLiveConfirmedWebrtc,
          extensionsFound: result.totalExtensions,
        });
      } catch (e: unknown) {
        instanceErrors++;
        perInstance.push({
          pbxInstanceId: instance.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          liveConfirmedWebrtc: 0,
          extensionsFound: 0,
        });
      }
    }

    const summary: PbxWebrtcDriftReconcileSummary = {
      msg: "pbx-webrtc-drift-reconcile-summary",
      started_at_iso: new Date(started).toISOString(),
      duration_ms: Date.now() - started,
      instances_scanned: instances.length,
      instance_errors: instanceErrors,
      total_extensions_found: totalExtensionsFound,
      total_live_confirmed_webrtc: totalLiveConfirmedWebrtc,
      total_errors: totalErrors,
      per_instance: perInstance,
      drift_detected: totalLiveConfirmedWebrtc > 0,
    };

    console.log(JSON.stringify(summary));

    const { alert, reasons } = evaluatePbxWebrtcDriftAlert(summary);
    if (alert) {
      // Deliberately console.error (not .log) so log-based alerting can grep
      // on severity, same convention as other worker cycles in this repo.
      console.error(
        JSON.stringify({
          msg: "pbx-webrtc-drift-reconcile-alert",
          reasons,
          total_live_confirmed_webrtc: totalLiveConfirmedWebrtc,
          instance_errors: instanceErrors,
          per_instance: perInstance,
        }),
      );
    }

    return summary;
  } finally {
    _pbxWebrtcDriftReconcileRunning = false;
  }
}

let _driftReconcileTimer: ReturnType<typeof setTimeout> | null = null;
let _driftReconcileLoopStarted = false;

/**
 * Self-scheduling loop (mirrors `voicemailSpoolReconcileCycle.ts`'s
 * setTimeout-based re-scheduling — not `setInterval` — so a slow cycle can
 * never overlap the next one). Default: every 30 minutes.
 * `PBX_WEBRTC_DRIFT_RECONCILE_INTERVAL_MS=0` disables.
 */
export function startPbxWebrtcDriftReconcileLoop(): void {
  if (_driftReconcileLoopStarted) return;
  const intervalMs = Number(process.env.PBX_WEBRTC_DRIFT_RECONCILE_INTERVAL_MS ?? 30 * 60 * 1000);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
  _driftReconcileLoopStarted = true;

  const schedule = (delayMs: number) => {
    if (_driftReconcileTimer) clearTimeout(_driftReconcileTimer);
    _driftReconcileTimer = setTimeout(runOnce, delayMs);
  };

  const runOnce = async () => {
    try {
      await runPbxWebrtcDriftReconcileCycle();
    } catch (err: unknown) {
      console.error("pbx webrtc drift reconcile failed", err instanceof Error ? err.message : String(err));
    } finally {
      schedule(Math.max(60_000, intervalMs));
    }
  };

  schedule(0);
}

/** @internal tests — reset the loop-start guard (does not clear an active timer). */
export function __testOnly_resetPbxWebrtcDriftReconcileLoopGuard(): void {
  _driftReconcileLoopStarted = false;
}
