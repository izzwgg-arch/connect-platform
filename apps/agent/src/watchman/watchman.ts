/**
 * Watchman — 24/7 read-only security + health monitoring (PLAN.md §9).
 *
 * Detect + alert only. NEVER takes a write/remediation action (v1). PBX is only
 * ever reached via the gentle read path, never written. Each check returns
 * signals; the runner records incidents and escalates per the ladder:
 *   info    → daily digest
 *   warning → email within the cycle
 *   critical→ immediate email (+ SMS once Twilio configured)
 */
export type Severity = "info" | "warning" | "critical";

export interface Signal {
  type: string;
  severity: Severity;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface HealthInput {
  /** container name -> running? */
  containers: Record<string, boolean>;
  diskUsedPct: number;
  dbReachable: boolean;
  /** hours until TLS cert expiry, if known */
  certExpiryHours?: number | null;
  /** age of newest DB backup in hours, if known */
  backupAgeHours?: number | null;
}

export interface SecurityInput {
  /** failed auth attempts in the window */
  authFailures: number;
  /** distinct source IPs for those failures */
  distinctSourceIps: number;
  /** off-hours international call attempts (toll-fraud signal) */
  offHoursIntlAttempts: number;
  /** new registrations from unexpected geos */
  unexpectedGeoRegs: number;
}

const CRITICAL_CONTAINERS = ["app-api-1", "app-portal-1", "connectcomms-postgres"];

export function evaluateHealth(h: HealthInput): Signal[] {
  const out: Signal[] = [];
  for (const [name, up] of Object.entries(h.containers)) {
    if (!up) {
      out.push({ type: "service_down", severity: CRITICAL_CONTAINERS.includes(name) ? "critical" : "warning", message: `Container ${name} is not running`, evidence: { container: name } });
    }
  }
  if (!h.dbReachable) out.push({ type: "db_unreachable", severity: "critical", message: "Postgres is unreachable" });
  if (h.diskUsedPct >= 90) out.push({ type: "disk_high", severity: "critical", message: `Disk ${h.diskUsedPct}% used`, evidence: { diskUsedPct: h.diskUsedPct } });
  else if (h.diskUsedPct >= 80) out.push({ type: "disk_high", severity: "warning", message: `Disk ${h.diskUsedPct}% used`, evidence: { diskUsedPct: h.diskUsedPct } });
  if (h.certExpiryHours != null) {
    if (h.certExpiryHours <= 48) out.push({ type: "cert_expiry", severity: "critical", message: `TLS cert expires in ${Math.round(h.certExpiryHours)}h` });
    else if (h.certExpiryHours <= 14 * 24) out.push({ type: "cert_expiry", severity: "warning", message: `TLS cert expires in ${Math.round(h.certExpiryHours / 24)}d` });
  }
  if (h.backupAgeHours != null && h.backupAgeHours > 26) {
    out.push({ type: "backup_stale", severity: "warning", message: `Newest DB backup is ${Math.round(h.backupAgeHours)}h old` });
  }
  return out;
}

export function evaluateSecurity(s: SecurityInput): Signal[] {
  const out: Signal[] = [];
  if (s.offHoursIntlAttempts >= 10) {
    out.push({ type: "toll_fraud_pattern", severity: "critical", message: `${s.offHoursIntlAttempts} off-hours international call attempts — possible toll fraud`, evidence: { count: s.offHoursIntlAttempts } });
  }
  if (s.authFailures >= 500) {
    out.push({ type: "sip_bruteforce", severity: s.distinctSourceIps <= 5 ? "warning" : "critical", message: `${s.authFailures} auth failures from ${s.distinctSourceIps} IPs`, evidence: { authFailures: s.authFailures, distinctSourceIps: s.distinctSourceIps } });
  }
  if (s.unexpectedGeoRegs > 0) {
    out.push({ type: "unexpected_geo_registration", severity: "warning", message: `${s.unexpectedGeoRegs} registration(s) from unexpected locations`, evidence: { count: s.unexpectedGeoRegs } });
  }
  return out;
}

export function highestSeverity(signals: Signal[]): Severity | null {
  if (signals.some((s) => s.severity === "critical")) return "critical";
  if (signals.some((s) => s.severity === "warning")) return "warning";
  if (signals.length) return "info";
  return null;
}
