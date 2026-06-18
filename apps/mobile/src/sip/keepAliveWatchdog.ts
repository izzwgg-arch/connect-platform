import type { CallWakeNativeState } from "../diagnostics/callWakeDiagnostics";

/**
 * Honest keep-alive health evaluation.
 *
 * The previous failure mode (T25/101 S25) was that the app *claimed* keep-alive
 * was fine while the foreground service had never actually reached foreground
 * state — the diagnostics were read cross-process and were permanently zeroed,
 * so nothing ever flagged it. This function encodes the rule that the watchdog
 * uses, and it deliberately refuses to call keep-alive "healthy" unless ALL of:
 *
 *   • the service object was actually created (serviceCreatedAtMs > 0), and
 *   • it currently claims to be running (isRunning === true), and
 *   • startForeground() actually landed at least once (foregroundLandedAtMs > 0).
 *
 * If any of those is false we report unhealthy with a specific reason, which is
 * what drives the re-arm + backend report. We never silently claim OK when
 * serviceCreatedAtMs=0 or isRunning=false.
 */
export type KeepAliveHealth = {
  healthy: boolean;
  reason: string;
  isRunning: boolean;
  serviceCreated: boolean;
  foregroundLanded: boolean;
  process: string;
  rearmCount: number;
};

export function evaluateKeepAliveHealth(s: CallWakeNativeState): KeepAliveHealth {
  const serviceCreated = (s.keepAliveServiceCreatedAtMs ?? 0) > 0;
  const foregroundLanded = (s.keepAliveForegroundLandedAtMs ?? 0) > 0;
  const isRunning = !!s.keepAliveIsRunning;
  const healthy = serviceCreated && isRunning && foregroundLanded;

  let reason = "ok";
  if (!serviceCreated) {
    // start() was dispatched but the OS never instantiated the Service. On
    // Android 12+ this is usually a background-start refusal.
    reason =
      "service_never_created:" +
      (s.keepAliveLastStartResult || "?") +
      (s.keepAliveLastStartErrorClass ? ":" + s.keepAliveLastStartErrorClass : "");
  } else if (!foregroundLanded) {
    // Service was created but every startForeground attempt in the ladder
    // failed — capture the final ladder rung + error class (e.g.
    // ForegroundServiceStartNotAllowedException) so triage is one glance.
    reason =
      "foreground_never_landed:" +
      (s.keepAliveLastForegroundResult || "?") +
      (s.keepAliveLastForegroundErrorClass ? ":" + s.keepAliveLastForegroundErrorClass : "");
  } else if (!isRunning) {
    reason = "service_not_running";
  }

  return {
    healthy,
    reason,
    isRunning,
    serviceCreated,
    foregroundLanded,
    process: s.keepAliveProcess || "",
    rearmCount: s.keepAliveRearmCount || 0,
  };
}
