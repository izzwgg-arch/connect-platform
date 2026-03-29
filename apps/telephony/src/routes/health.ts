import type { Router, Request } from "express";
import type { TelephonyModule } from "../telephony";

export function registerHealthRoutes(router: Router, telephony: TelephonyModule): void {
  router.get("/health", (_req, res) => {
    const health = telephony.healthService.getHealth();
    const statusCode = health.status === "down" ? 503 : 200;
    res.status(statusCode).json(health);
  });

  // Always expose diagnostics/forensic for live mismatch investigation (no debug flag required).
  router.get("/diagnostics", (_req, res) => {
    res.json(telephony.healthService.getDiagnostics());
  });

  /**
   * Live mismatch snapshot: capture PBX vs dashboard at one timestamp.
   * Query params (all optional): pbx=2&kpi=7&rows=7
   * Returns: timestamp, user-provided counts, telephony health/calls/diagnostics, forensic report.
   */
  router.get("/forensic", (req: Request, res) => {
      const pbxActiveCount = req.query["pbx"] != null ? Number(req.query["pbx"]) : null;
      const dashboardKpi = req.query["kpi"] != null ? Number(req.query["kpi"]) : null;
      const dashboardRowCount = req.query["rows"] != null ? Number(req.query["rows"]) : null;

      const health = telephony.healthService.getHealth();
      const activeCalls = telephony.ariBridgedPoller.getCallsForSnapshot();
      const telephonyCallsCount = activeCalls.length;
      const amiDerivedActive = telephony.callStore.getActive();
      const diagnostics = telephony.healthService.getDiagnostics();
      const forensic = telephony.callStore.getForensicReport();

      res.json({
        timestamp: new Date().toISOString(),
        mismatchSnapshot: {
          pbxActiveCount,
          dashboardKpi,
          dashboardRowCount,
          telephonyHealthActiveCalls: health.activeCalls,
          telephonyCallsCount,
          amiDerivedActiveCount: amiDerivedActive.length,
          diagnosticsRawChannelCount: diagnostics.calls.rawChannelCount,
          diagnosticsDerivedActiveCount: diagnostics.calls.derivedActiveCount,
          overcountSuspected: diagnostics.calls.overcountSuspected ?? false,
        },
        telephonyHealth: health,
        telephonyCallsSample: activeCalls.slice(0, 20).map((c) => ({
          id: c.id,
          linkedId: c.linkedId,
          from: c.from,
          to: c.to,
          state: c.state,
          tenantId: c.tenantId,
          channelCount: c.channels.length,
          bridgeCount: c.bridgeIds.length,
        })),
        diagnostics,
        forensic: {
          rawChannelCount: forensic.rawChannelCount,
          derivedActiveCount: forensic.derivedActiveCount,
          bucketCounts: forensic.bucketCounts,
          activeCallsForensic: forensic.activeCallsForensic,
        },
      });
    });
}
