/**
 * Yiddish corpus — source health.
 *
 * ⛔⛔ THE RULE THIS FILE EXISTS FOR: a discovery run that finds NOTHING is a
 * HEALTH EVENT, not a result. A scraper whose parsers have rotted returns zero
 * items and reads exactly like a quiet news day, and that is how a broken
 * adapter stays broken for weeks. So:
 *
 *   - every parser assumption is a probe row with a state;
 *   - two consecutive discovery runs that find nothing new raises an alert and
 *     PAUSES the source, rather than reporting success;
 *   - any BROKEN or BLOCKED probe does the same immediately.
 *
 * Pausing means `YcBudget.paused = true`. The source row is left enabled so
 * the owner sees it, with the reason on its health rows.
 */

export interface ProbeInput {
  probeKey: string;
  /** OK | DEGRADED | BROKEN | BLOCKED | ABSENT */
  state: string;
  detail?: string | null;
}

export const YC_EMPTY_RUN_ALERT_THRESHOLD = 2;
/** The probe key the empty-run rule writes under. */
export const YC_DISCOVERY_YIELD_PROBE = "discovery_yield";

export interface HealthAlert {
  sourceKey: string;
  probeKey: string;
  state: string;
  detail: string;
  paused: boolean;
}

/** Upsert a batch of probe rows for one source. Returns how many are not OK. */
export async function recordProbes(
  db: any,
  sourceKey: string,
  probes: ProbeInput[],
): Promise<{ recorded: number; bad: number }> {
  if (!probes?.length) return { recorded: 0, bad: 0 };
  const source = await db.ycSource.findUnique({ where: { key: sourceKey }, select: { id: true } });
  if (!source) return { recorded: 0, bad: 0 };

  const now = new Date();
  let bad = 0;
  for (const probe of probes) {
    const isBad = probe.state === "BROKEN" || probe.state === "BLOCKED" || probe.state === "ABSENT";
    if (isBad) bad += 1;
    const existing = await db.ycSourceHealth.findUnique({
      where: { sourceId_probeKey: { sourceId: source.id, probeKey: probe.probeKey } },
    });
    // brokenSince is set on the FIRST bad check and never bumped while it
    // stays bad — "broken for 9 days" is the number that matters.
    const brokenSince = isBad ? existing?.brokenSince ?? now : null;
    const data = {
      state: probe.state,
      detail: probe.detail ?? null,
      checkedAt: now,
      brokenSince,
    };
    if (existing) await db.ycSourceHealth.update({ where: { id: existing.id }, data });
    else await db.ycSourceHealth.create({ data: { ...data, sourceId: source.id, probeKey: probe.probeKey } });
  }
  return { recorded: probes.length, bad };
}

function readCursor(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/**
 * Record the outcome of one discovery run. The consecutive-empty counter lives
 * on the source's discoveryCursor so it survives a restart like everything
 * else about a run.
 */
export async function noteDiscoveryRun(
  db: any,
  sourceKey: string,
  result: {
    discovered: number;
    duplicates?: number;
    pages?: number;
    healthy?: boolean;
    stoppedReason?: string | null;
    /** The site's own server failed (e.g. a 524). Not evidence of a broken parser. */
    unavailable?: boolean;
  },
): Promise<{ emptyRuns: number }> {
  const source = await db.ycSource.findUnique({ where: { key: sourceKey }, select: { id: true, discoveryCursor: true } });
  if (!source) return { emptyRuns: 0 };
  const cursor = readCursor(source.discoveryCursor);
  const found = Number(result?.discovered) > 0;
  // ⛔ "Nothing NEW" is not "nothing". Once the whole catalog has been walked,
  // a re-check that parses page after page of episodes we already hold is the
  // site and the parser working perfectly on a quiet day. Counting that as an
  // empty run paused the crawler on 2026-09-16, two re-checks after the
  // catalog finished, on a false alarm. A run only counts as empty when it
  // recognised NOTHING - no new item and no known one - which is what a
  // changed page or a broken parser actually looks like.
  const reSeen = Number(result?.duplicates) || 0;
  const alive = found || reSeen > 0;
  // ⛔ A run cut short by the site's own outage proves nothing about the
  // parser, so it neither counts as empty nor clears the count. Counting it
  // let two outages hours apart pause the 24/7 listen.
  const outage = !alive && result?.unavailable === true;
  const emptyRuns = alive ? 0 : outage ? Number(cursor.emptyRuns) || 0 : (Number(cursor.emptyRuns) || 0) + 1;
  cursor.emptyRuns = emptyRuns;
  cursor.lastRunAt = new Date().toISOString();
  cursor.lastRunPages = Number(result?.pages) || 0;
  cursor.lastRunStoppedReason = result?.stoppedReason ?? null;
  await db.ycSource.update({
    where: { id: source.id },
    data: { discoveryCursor: JSON.stringify(cursor), lastRunAt: new Date() },
  });

  if (outage) {
    await recordProbes(db, sourceKey, [
      {
        probeKey: YC_DISCOVERY_YIELD_PROBE,
        state: "DEGRADED",
        detail: `Yiddish24 was unavailable this run; retrying (${result?.stoppedReason ?? "server error"})`,
      },
    ]);
  } else if (!found && reSeen > 0) {
    await recordProbes(db, sourceKey, [
      {
        probeKey: YC_DISCOVERY_YIELD_PROBE,
        state: "OK",
        detail: `no new episodes since the last check; ${reSeen} known episode(s) re-read correctly`,
      },
    ]);
  } else if (!found) {
    await recordProbes(db, sourceKey, [
      {
        probeKey: YC_DISCOVERY_YIELD_PROBE,
        state: emptyRuns >= YC_EMPTY_RUN_ALERT_THRESHOLD ? "BROKEN" : "DEGRADED",
        detail:
          `${emptyRuns} consecutive discovery run(s) found no new items` +
          (result?.stoppedReason ? ` (stopped: ${result.stoppedReason})` : ""),
      },
    ]);
  } else {
    await recordProbes(db, sourceKey, [
      { probeKey: YC_DISCOVERY_YIELD_PROBE, state: "OK", detail: `${result.discovered} new item(s) this run` },
    ]);
  }
  return { emptyRuns };
}

/** Pause a source's budget. Idempotent; missing budget row is not an error. */
async function pauseSource(db: any, sourceId: string): Promise<boolean> {
  const budget = await db.ycBudget.findFirst({ where: { sourceId } });
  if (!budget) return false;
  if (budget.paused) return true;
  await db.ycBudget.update({ where: { id: budget.id }, data: { paused: true } });
  return true;
}

/**
 * Scan every enabled source and pause the ones whose health says the adapter,
 * not the world, is the reason nothing is arriving.
 */
export async function alertIfBroken(db: any): Promise<HealthAlert[]> {
  const sources = await db.ycSource.findMany({
    where: { enabled: true },
    include: { health: true },
  });
  const alerts: HealthAlert[] = [];

  for (const source of sources || []) {
    const rows = source.health || [];
    const broken = rows.filter((h: any) => h.state === "BROKEN" || h.state === "BLOCKED");
    const cursor = readCursor(source.discoveryCursor);
    const emptyRuns = Number(cursor.emptyRuns) || 0;
    const emptyTrip = emptyRuns >= YC_EMPTY_RUN_ALERT_THRESHOLD;

    if (!broken.length && !emptyTrip) continue;

    const paused = await pauseSource(db, source.id);
    for (const h of broken) {
      alerts.push({
        sourceKey: source.key,
        probeKey: h.probeKey,
        state: h.state,
        detail: h.detail || `probe ${h.probeKey} is ${h.state}`,
        paused,
      });
    }
    if (emptyTrip && !broken.some((h: any) => h.probeKey === YC_DISCOVERY_YIELD_PROBE)) {
      alerts.push({
        sourceKey: source.key,
        probeKey: YC_DISCOVERY_YIELD_PROBE,
        state: "BROKEN",
        detail:
          `${emptyRuns} consecutive discovery runs found nothing new. That is reported as a health ` +
          `event, not as "nothing new" — the parsers or the site may have changed.`,
        paused,
      });
    }
  }
  return alerts;
}

/** A plain-English summary for the health screen. Never claims more than it knows. */
export function summarizeHealth(rows: { probeKey: string; state: string; detail?: string | null }[]): string {
  if (!rows?.length) return "No probes have run yet, so nothing is known about this source's health.";
  const bad = rows.filter((r) => r.state === "BROKEN" || r.state === "BLOCKED");
  const degraded = rows.filter((r) => r.state === "DEGRADED");
  if (bad.length) return `${bad.length} of ${rows.length} checks are failing: ${bad.map((r) => r.probeKey).join(", ")}.`;
  if (degraded.length) return `All checks answered; ${degraded.length} are degraded: ${degraded.map((r) => r.probeKey).join(", ")}.`;
  return `All ${rows.length} checks passed at the last run.`;
}
