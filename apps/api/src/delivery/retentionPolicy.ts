// Data retention policy — PURE. Governs the high-volume location table + ETA snapshots
// (Gate 3 §08/§22). The retention worker applies these; nothing here touches the DB.

/** Platform bounds for tenant-configurable retention. */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;

export function clampRetentionDays(days: number | null | undefined): number {
  const d = typeof days === "number" && Number.isFinite(days) ? Math.floor(days) : 30;
  return Math.max(MIN_RETENTION_DAYS, Math.min(MAX_RETENTION_DAYS, d));
}

/** The cutoff timestamp: rows older than this are eligible for pruning. */
export function retentionCutoff(nowMs: number, retentionDays: number): Date {
  return new Date(nowMs - clampRetentionDays(retentionDays) * 86_400_000);
}

export function shouldPrune(rowTsMs: number, cutoffMs: number): boolean {
  return rowTsMs < cutoffMs;
}

export interface RetentionPlan {
  /** High-resolution location samples older than the cutoff are deleted. */
  locationCutoff: Date;
  /** ETA snapshots older than this are summarized/dropped (keep a shorter window). */
  etaCutoff: Date;
  /** Delivered/terminal tracking sessions older than the cutoff can be closed out. */
  sessionCutoff: Date;
}

export function retentionPlan(nowMs: number, retentionDays: number): RetentionPlan {
  const clamped = clampRetentionDays(retentionDays);
  return {
    locationCutoff: retentionCutoff(nowMs, clamped),
    // ETA snapshots are cheap operational history — keep at most the retention window, min 7 days.
    etaCutoff: retentionCutoff(nowMs, Math.min(clamped, Math.max(7, Math.floor(clamped / 2)))),
    sessionCutoff: retentionCutoff(nowMs, clamped),
  };
}
