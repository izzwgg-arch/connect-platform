/**
 * Relay-usage SLO analysis.
 *
 * Why (incident 2026-06-08): every web call for over a week reported
 * `isUsingRelay: false`, meaning the TURN relay path was never used. The data
 * to detect this was already in VoiceDiagEvent CALL_QUALITY_REPORT rows, but
 * nothing watched it. These pure helpers turn those rows into a per-tenant
 * relay-usage ratio so a scheduled job can alert when relay usage collapses.
 *
 * Pure (no DB/Prisma) so it is unit-testable.
 */

export type RelayUsageRow = {
  tenantId: string;
  payload: { isUsingRelay?: unknown; candidateType?: unknown } | null | undefined;
};

export type TenantRelayUsage = {
  tenantId: string;
  attempts: number;
  relayCount: number;
  /** relayCount / attempts in [0,1]. */
  ratio: number;
  breaching: boolean;
};

export type RelayUsageOptions = {
  /** Minimum reports before a tenant is eligible to breach (avoid noise). */
  minAttempts: number;
  /** Breach when ratio is at or below this (e.g. 0.05 = 5%). */
  minRatio: number;
};

export const DEFAULT_RELAY_USAGE_OPTIONS: RelayUsageOptions = {
  minAttempts: 8,
  minRatio: 0.05,
};

function rowUsedRelay(row: RelayUsageRow): boolean {
  const p = row.payload || {};
  if ((p as { isUsingRelay?: unknown }).isUsingRelay === true) return true;
  // Defensive: some clients only set candidateType.
  return String((p as { candidateType?: unknown }).candidateType ?? "").toLowerCase() === "relay";
}

/**
 * Aggregate CALL_QUALITY_REPORT rows into per-tenant relay usage and flag the
 * tenants whose relay usage has collapsed (enough attempts, ratio at/below floor).
 */
export function computeRelayUsage(
  rows: ReadonlyArray<RelayUsageRow>,
  options: RelayUsageOptions = DEFAULT_RELAY_USAGE_OPTIONS,
): TenantRelayUsage[] {
  const byTenant = new Map<string, { attempts: number; relayCount: number }>();
  for (const row of rows) {
    if (!row.tenantId) continue;
    const agg = byTenant.get(row.tenantId) ?? { attempts: 0, relayCount: 0 };
    agg.attempts += 1;
    if (rowUsedRelay(row)) agg.relayCount += 1;
    byTenant.set(row.tenantId, agg);
  }
  const out: TenantRelayUsage[] = [];
  for (const [tenantId, agg] of byTenant) {
    const ratio = agg.attempts ? agg.relayCount / agg.attempts : 1;
    const breaching = agg.attempts >= options.minAttempts && ratio <= options.minRatio;
    out.push({ tenantId, attempts: agg.attempts, relayCount: agg.relayCount, ratio, breaching });
  }
  return out;
}

/** Just the breaching tenants, sorted worst-first. */
export function breachingTenants(
  rows: ReadonlyArray<RelayUsageRow>,
  options: RelayUsageOptions = DEFAULT_RELAY_USAGE_OPTIONS,
): TenantRelayUsage[] {
  return computeRelayUsage(rows, options)
    .filter((t) => t.breaching)
    .sort((a, b) => a.ratio - b.ratio || b.attempts - a.attempts);
}
