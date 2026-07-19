/**
 * Watchman runner — gathers inputs (read-only), evaluates, records incidents,
 * escalates. Health inputs come from the agent's own vantage (DB reachability,
 * disk of its volume) plus optional host-provided metrics via env/file. It does
 * NOT shell into the host or write anywhere. Security inputs come from Connect
 * DB aggregates (CDR anomalies) and are gentle reads.
 */
import { evaluateHealth, evaluateSecurity, highestSeverity, type Signal } from "./watchman";
import type { AuditLog } from "../audit/audit";
import type { Notifier } from "../notify/notifier";

export class WatchmanRunner {
  constructor(
    private prisma: any,
    private audit: AuditLog,
    private notifier: Notifier,
  ) {}

  async gatherSecurity(): Promise<Signal[]> {
    // Toll-fraud signal: off-hours (00:00–06:00) international outbound attempts in last hour.
    try {
      const since = new Date(Date.now() - 3600 * 1000);
      const rows = await this.prisma.connectCdr.findMany({
        where: { startedAt: { gte: since }, direction: "outgoing" },
        select: { toNumber: true, startedAt: true, disposition: true },
        take: 2000,
      });
      let offHoursIntl = 0;
      for (const r of rows) {
        const h = new Date(r.startedAt).getUTCHours();
        const intl = typeof r.toNumber === "string" && /^(\+?0*1[1-9]|\+?[2-9]\d{7,})/.test(r.toNumber) && !/^\+?1\d{10}$/.test(r.toNumber);
        if (h < 6 && intl) offHoursIntl++;
      }
      return evaluateSecurity({ authFailures: 0, distinctSourceIps: 0, offHoursIntlAttempts: offHoursIntl, unexpectedGeoRegs: 0 });
    } catch {
      return [];
    }
  }

  async gatherHealth(): Promise<Signal[]> {
    let dbReachable = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
    // Containers/disk/cert/backup come from host-provided metrics if present
    // (written by a host cron to a file the agent can read), else best-effort.
    const containers: Record<string, boolean> = {};
    return evaluateHealth({
      containers,
      diskUsedPct: Number(process.env.AGENT_HOST_DISK_PCT ?? 0),
      dbReachable,
      certExpiryHours: process.env.AGENT_CERT_EXPIRY_HOURS ? Number(process.env.AGENT_CERT_EXPIRY_HOURS) : null,
      backupAgeHours: process.env.AGENT_BACKUP_AGE_HOURS ? Number(process.env.AGENT_BACKUP_AGE_HOURS) : null,
    });
  }

  async runOnce(): Promise<{ signals: Signal[]; incidentsRecorded: number }> {
    const signals = [...(await this.gatherHealth()), ...(await this.gatherSecurity())];
    let recorded = 0;
    for (const s of signals) {
      try {
        await this.prisma.agentIncident.create({
          data: { type: s.type, severity: s.severity, evidence: (s.evidence ?? {}) as any, status: "open", notifiedAt: s.severity !== "info" ? new Date() : null },
        });
        recorded++;
      } catch {
        /* non-fatal */
      }
      await this.audit.record({ actor: "watchman", event: `watchman.${s.type}`, payload: { severity: s.severity, message: s.message } });
    }
    const top = highestSeverity(signals);
    if (top === "critical" || top === "warning") {
      const crit = signals.filter((s) => s.severity === top);
      await this.notifier.send({
        kind: "incident",
        to: this.notifier.ownerRecipients(),
        subject: `[Watchman ${top!.toUpperCase()}] ${crit[0]?.message ?? "signals detected"}`,
        text: `Watchman detected ${signals.length} signal(s):\n\n${signals.map((s) => `[${s.severity}] ${s.type}: ${s.message}`).join("\n")}\n\nDetection + alert only — no automated remediation (v1).`,
      });
    }
    return { signals, incidentsRecorded: recorded };
  }
}
