"use client";

import { useCallback, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { PageHeader } from "../../../../components/PageHeader";
import { apiGet, apiPost } from "../../../../services/apiClient";

type HealthStatus = "ok" | "warning" | "critical" | "unknown";

type StorageClassification =
  | "PROTECTED_NEVER_DELETE"
  | "ACTIVE_REQUIRED"
  | "ROLLBACK_CANDIDATE"
  | "SAFE_CANDIDATE"
  | "UNKNOWN_REQUIRES_REVIEW";

type StorageItem = {
  id: string;
  kind: string;
  label: string;
  pathOrRef: string;
  sizeBytes: number | null;
  classification: StorageClassification;
  evidence: string;
  reclaimableBytes: number | null;
};

type StorageAlert = {
  code: string;
  severity: HealthStatus;
  message: string;
};

type StorageScan = {
  scanId: string;
  timestamp: string;
  hostname: string;
  durationMs: number;
  readOnly: true;
  reclaimEstimateBytes: number;
  unknownCount: number;
  protectedCount: number;
  items: StorageItem[];
  alerts: StorageAlert[];
  docker: {
    buildCache: { entryCount: number | null; totalBytes: number | null; reclaimableBytes: number | null };
  };
  diskMounts: Array<{ path: string; usedPct: number; usedBytes: number; freeBytes: number; totalBytes: number }>;
};

type CleanupPlan = {
  planId: string;
  phase: "dry_run_only";
  blocked: boolean;
  blockReasons: string[];
  totalEstimatedReclaimBytes: number;
  actions: Array<{
    id: string;
    label: string;
    command: string;
    dryRunCommand: string | null;
    blocked: boolean;
    blockReason: string | null;
    estimatedReclaimBytes: number | null;
  }>;
};

type StorageHealth = {
  latestScan: StorageScan | null;
  previousScans: Array<{ scanId: string; timestamp: string; diskUsedPct: number | null; reclaimEstimateBytes: number }>;
  alerts: StorageAlert[];
};

function fmtBytes(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function classColor(c: StorageClassification): string {
  if (c === "PROTECTED_NEVER_DELETE" || c === "ACTIVE_REQUIRED") return "#dc2626";
  if (c === "ROLLBACK_CANDIDATE" || c === "UNKNOWN_REQUIRES_REVIEW") return "#d97706";
  return "#16a34a";
}

export default function StorageHealthPage() {
  const [health, setHealth] = useState<StorageHealth | null>(null);
  const [scan, setScan] = useState<StorageScan | null>(null);
  const [plan, setPlan] = useState<CleanupPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const data = await apiGet<StorageHealth>("/admin/storage-health");
    setHealth(data);
    setScan(data.latestScan);
  }, []);

  const runScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiPost<StorageScan>("/admin/storage-health/scan", {});
      setScan(result);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const buildPlan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiPost<CleanupPlan>("/admin/storage-health/plan", {});
      setPlan(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Plan generation failed");
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <PermissionGate permission="can_view_admin_storage_health" fallback={<div className="state-box">You do not have storage health access.</div>}>
      <div className="stack">
        <PageHeader
          title="Storage Health"
          subtitle="Read-only disk forensics and guarded cleanup planning. Phase 1 does not delete anything."
          actions={
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn" onClick={() => void refresh()} disabled={loading}>
                Refresh
              </button>
              <button type="button" className="btn primary" onClick={() => void runScan()} disabled={loading}>
                Scan Now
              </button>
              <button type="button" className="btn" onClick={() => void buildPlan()} disabled={loading || !scan}>
                Cleanup Plan
              </button>
            </div>
          }
        />

        {error ? <div className="state-box error">{error}</div> : null}

        {scan ? (
          <section className="card stack">
            <h3>Latest scan</h3>
            <p>
              Host <strong>{scan.hostname}</strong> · {new Date(scan.timestamp).toLocaleString()} ·{" "}
              {scan.items.length} items · reclaim estimate <strong>{fmtBytes(scan.reclaimEstimateBytes)}</strong>
            </p>
            <p>
              Protected: {scan.protectedCount} · Unknown: {scan.unknownCount} · BuildKit cache:{" "}
              {fmtBytes(scan.docker.buildCache.totalBytes)} ({scan.docker.buildCache.entryCount ?? "?"} entries)
            </p>
            {scan.alerts.length > 0 ? (
              <ul>
                {scan.alerts.map((a) => (
                  <li key={a.code}>
                    <strong>{a.severity}</strong> — {a.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No active storage alerts.</p>
            )}
          </section>
        ) : (
          <div className="state-box">No scan yet. Click Scan Now to inventory storage (read-only).</div>
        )}

        {health?.previousScans?.length ? (
          <section className="card stack">
            <h3>Disk usage trend</h3>
            <table className="table compact">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Disk used %</th>
                  <th>Reclaim estimate</th>
                </tr>
              </thead>
              <tbody>
                {health.previousScans.slice(0, 12).map((row) => (
                  <tr key={row.scanId}>
                    <td>{new Date(row.timestamp).toLocaleString()}</td>
                    <td>{row.diskUsedPct ?? "—"}%</td>
                    <td>{fmtBytes(row.reclaimEstimateBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {scan ? (
          <section className="card stack">
            <h3>Inventory classification</h3>
            <table className="table compact">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Kind</th>
                  <th>Size</th>
                  <th>Classification</th>
                </tr>
              </thead>
              <tbody>
                {scan.items.slice(0, 100).map((item) => (
                  <tr key={item.id}>
                    <td>{item.label}</td>
                    <td>{item.kind}</td>
                    <td>{fmtBytes(item.sizeBytes)}</td>
                    <td style={{ color: classColor(item.classification) }}>{item.classification}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {plan ? (
          <section className="card stack">
            <h3>Cleanup plan (dry-run only)</h3>
            <p>
              Plan <code>{plan.planId}</code> · blocked: <strong>{plan.blocked ? "yes" : "no"}</strong> · estimated reclaim{" "}
              {fmtBytes(plan.totalEstimatedReclaimBytes)}
            </p>
            {plan.blockReasons.length ? (
              <ul>
                {plan.blockReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
            <table className="table compact">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Command</th>
                  <th>Blocked</th>
                </tr>
              </thead>
              <tbody>
                {plan.actions.map((action) => (
                  <tr key={action.id}>
                    <td>{action.label}</td>
                    <td>
                      <code>{action.dryRunCommand ?? action.command}</code>
                    </td>
                    <td>{action.blocked ? action.blockReason ?? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-muted">
              Approve and Execute are disabled in Phase 1. Manual approval is required before any future cleanup.
            </p>
          </section>
        ) : null}
      </div>
    </PermissionGate>
  );
}
