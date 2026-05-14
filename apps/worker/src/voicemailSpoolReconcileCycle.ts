/**
 * Scheduled insert-only reconcile: PBX spool → DB for all active PBX-linked mailboxes.
 * Complements the faster voicemail sync cycle (REST-first, capped helper fallback).
 */
import IORedis from "ioredis";
import { db } from "@connect/db";
import {
  fetchPbxRouteHelperHealth,
  listVoicemailSpoolFromHelper,
  pbxHelperVersionMeetsMin,
  resolvePbxRouteHelperConfig,
} from "@connect/integrations";
import {
  classifyVoicemailStaleRisk,
  loadVoicemailDbStatsByMailbox,
  VOICEMAIL_STALE_RISK_RANK,
  type VoicemailStaleRiskLevel,
} from "./voicemailStaleRiskShared";
import { fetchSpoolAndApplyVoicemails } from "./voicemailSpoolMailbox";

const REDIS_SUMMARY_KEY = "connect:worker:vmSpoolReconcile:lastSummary";
const REDIS_BACKOFF_STATE_KEY = "connect:worker:vmSpoolReconcile:backoffState";

let _redisSingleton: IORedis | null = null;
function reconcileRedis(): IORedis {
  if (!_redisSingleton) {
    _redisSingleton = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
  }
  return _redisSingleton;
}

let _vmSpoolReconcileRunning = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** @internal tests — exponential delay from base when consecutive clean zero-insert cycles completed. */
export function computeAdaptiveReconcileDelayMs(
  baseMs: number,
  maxMs: number,
  maxBackoffSteps: number,
  consecutiveCleanZeroInsertCycles: number,
): number {
  const base = Math.max(60_000, baseMs);
  const cap = Math.max(base, maxMs);
  const steps = Math.max(0, Math.floor(maxBackoffSteps));
  const c = Math.max(0, Math.floor(consecutiveCleanZeroInsertCycles));
  if (c <= 0) return Math.min(cap, base);
  const exp = Math.min(c, steps);
  return Math.min(cap, Math.floor(base * 2 ** exp));
}

/** @internal tests — spread scheduled wakeups (±ratio). */
export function applyScheduleJitterMs(delayMs: number, jitterRatio: number): number {
  const r = Math.max(0, Math.min(0.45, jitterRatio));
  const factor = 1 + (Math.random() * 2 - 1) * r;
  return Math.max(5_000, Math.floor(delayMs * factor));
}

type BackoffRedisState = { consecutiveCleanZeroInsertCycles: number };

function readBackoffState(raw: string | null): BackoffRedisState {
  if (!raw) return { consecutiveCleanZeroInsertCycles: 0 };
  try {
    const o = JSON.parse(raw) as { consecutiveCleanZeroInsertCycles?: number };
    return {
      consecutiveCleanZeroInsertCycles: Math.max(0, Math.floor(Number(o.consecutiveCleanZeroInsertCycles) || 0)),
    };
  } catch {
    return { consecutiveCleanZeroInsertCycles: 0 };
  }
}

/** @internal tests */
export function evaluateVoicemailSpoolReconcileHealth(input: {
  helperVersionOkGlobal: boolean;
  schema2RequiredViolations: number;
  paginationIncompleteMailboxes: number;
  helperErrors: number;
  totalInserted: number;
  staleHighRiskIncreased: boolean;
}): { unhealthy: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!input.helperVersionOkGlobal) reasons.push("helper_version_below_min_or_health_failed");
  if (input.schema2RequiredViolations > 0) reasons.push("helper_spool_list_schema_not_2");
  if (input.paginationIncompleteMailboxes > 0) reasons.push("pagination_incomplete");
  if (input.helperErrors > 0) reasons.push("helper_or_db_errors");
  if (input.totalInserted > 0) reasons.push("ingestion_gaps_repaired_inserted_missing_rows");
  if (input.staleHighRiskIncreased) reasons.push("high_or_critical_stale_risk_mailbox_count_increased");
  const unhealthy =
    !input.helperVersionOkGlobal ||
    input.schema2RequiredViolations > 0 ||
    input.paginationIncompleteMailboxes > 0 ||
    input.helperErrors > 0 ||
    input.totalInserted > 0 ||
    input.staleHighRiskIncreased;
  return { unhealthy, reasons };
}

type RiskyMailbox = {
  tenantId: string;
  extension: string;
  stale_risk_level: VoicemailStaleRiskLevel;
  likely_failure_mode: string;
  inserted: number;
  pagination_complete: boolean | null;
  helper_spool_list_schema: number | null;
};

export type VoicemailSpoolReconcileSummary = {
  msg: "voicemail-spool-reconcile-summary";
  started_at_iso: string;
  duration_ms: number;
  min_helper_version: string;
  helper_version_ok_global: boolean;
  helper_health_by_pbx_instance: Record<string, { ok: boolean; version?: string; error?: string }>;
  tenants_scanned: number;
  mailboxes_scanned: number;
  total_inserted: number;
  total_already_present: number;
  total_skipped_invalid_origtime: number;
  total_errors: number;
  helper_errors: number;
  pagination_incomplete_mailboxes: number;
  schema2_violation_mailboxes: number;
  spool_messages_sum: number;
  high_or_critical_stale_risk_mailboxes: number;
  stale_high_risk_increased: boolean;
  unhealthy: boolean;
  unhealthy_reasons: string[];
  top_risky_mailboxes: RiskyMailbox[];
  helper_calls: number;
  avg_helper_ms: number;
  max_helper_ms: number;
  skipped_probe_no_new: number;
  skipped_since_no_messages: number;
  consecutive_clean_zero_insert_cycles_after: number;
  adaptive_delay_base_ms: number;
  next_reconcile_delay_ms: number;
};

export async function runVoicemailSpoolReconcileCycle(): Promise<VoicemailSpoolReconcileSummary | null> {
  if (_vmSpoolReconcileRunning) return null;
  _vmSpoolReconcileRunning = true;
  const started = Date.now();
  let helperCalls = 0;
  let helperMsSum = 0;
  let helperMsMax = 0;
  let skippedProbeNoNew = 0;
  let skippedSinceNoMessages = 0;

  const trackHelper = async <T>(fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      helperCalls += 1;
      return await fn();
    } finally {
      const dt = Date.now() - t0;
      helperMsSum += dt;
      helperMsMax = Math.max(helperMsMax, dt);
    }
  };

  try {
    const minHelperVersion = String(
      process.env.VOICEMAIL_SPOOL_RECONCILE_MIN_HELPER_VERSION || "2026.05.10.1",
    ).trim();
    const mailboxDelayMs = Math.max(
      0,
      Number(process.env.VOICEMAIL_SPOOL_RECONCILE_MAILBOX_DELAY_MS || 150) || 150,
    );
    const tenantDelayMs = Math.max(
      0,
      Number(process.env.VOICEMAIL_SPOOL_RECONCILE_TENANT_DELAY_MS || 0) || 0,
    );
    const healthTimeoutMs = Math.max(2000, Number(process.env.VOICEMAIL_HELPER_HEALTH_TIMEOUT_MS || 5000) || 5000);
    const spoolProbeTimeoutMs = Math.max(
      5000,
      Number(process.env.VOICEMAIL_HELPER_SPOOL_FETCH_TIMEOUT_MS || 20000) || 20000,
    );
    const probeSkipEnabled = String(process.env.VOICEMAIL_SPOOL_RECONCILE_PROBE_SKIP || "1").trim() !== "0";
    const sinceOverlapSec = Math.max(
      0,
      Number(process.env.VOICEMAIL_SPOOL_SINCE_OVERLAP_SEC || 120) || 120,
    );

    const redis = reconcileRedis();
    let backoffBefore = readBackoffState(await redis.get(REDIS_BACKOFF_STATE_KEY));

    let prevHighRisk = 0;
    let hadPrevSummary = false;
    try {
      const prevRaw = await redis.get(REDIS_SUMMARY_KEY);
      if (prevRaw) {
        hadPrevSummary = true;
        const prev = JSON.parse(prevRaw) as { high_or_critical_stale_risk_mailboxes?: number };
        prevHighRisk = Math.max(0, Number(prev.high_or_critical_stale_risk_mailboxes) || 0);
      }
    } catch {
      prevHighRisk = 0;
      hadPrevSummary = false;
    }

    const dbMap = await loadVoicemailDbStatsByMailbox();

    const links = await db.tenantPbxLink.findMany({
      where: { pbxInstance: { isEnabled: true } },
      include: { pbxInstance: true, tenant: { select: { id: true, name: true } } },
    });

    const distinctInstanceIds = [...new Set(links.map((l) => l.pbxInstanceId).filter(Boolean))] as string[];
    const healthByInstance: Record<string, { ok: boolean; version?: string; error?: string }> = {};
    let helperVersionOkGlobal = true;

    for (const iid of distinctInstanceIds) {
      const cfg = resolvePbxRouteHelperConfig(iid);
      if (!cfg?.baseUrl) {
        healthByInstance[iid] = { ok: false, error: "helper_config_missing" };
        helperVersionOkGlobal = false;
        continue;
      }
      const h = await fetchPbxRouteHelperHealth(cfg.baseUrl, healthTimeoutMs);
      const version = h.version;
      const ok = h.ok && pbxHelperVersionMeetsMin(version, minHelperVersion);
      healthByInstance[iid] = { ok, version, error: h.ok ? undefined : h.error };
      if (!ok) helperVersionOkGlobal = false;
    }

    const summaryBase: Omit<VoicemailSpoolReconcileSummary, "helper_calls" | "avg_helper_ms" | "max_helper_ms" | "skipped_probe_no_new" | "skipped_since_no_messages" | "consecutive_clean_zero_insert_cycles_after" | "adaptive_delay_base_ms" | "next_reconcile_delay_ms"> = {
      msg: "voicemail-spool-reconcile-summary",
      started_at_iso: new Date(started).toISOString(),
      duration_ms: 0,
      min_helper_version: minHelperVersion,
      helper_version_ok_global: helperVersionOkGlobal,
      helper_health_by_pbx_instance: healthByInstance,
      tenants_scanned: 0,
      mailboxes_scanned: 0,
      total_inserted: 0,
      total_already_present: 0,
      total_skipped_invalid_origtime: 0,
      total_errors: 0,
      helper_errors: 0,
      pagination_incomplete_mailboxes: 0,
      schema2_violation_mailboxes: 0,
      spool_messages_sum: 0,
      high_or_critical_stale_risk_mailboxes: 0,
      stale_high_risk_increased: false,
      unhealthy: false,
      unhealthy_reasons: [],
      top_risky_mailboxes: [],
    };

    const riskyAccumulator: RiskyMailbox[] = [];

    for (const link of links) {
      if (!link?.pbxInstance) continue;
      const vitalTid = String(link.pbxTenantId || "").trim();
      const helperCfg = vitalTid ? resolvePbxRouteHelperConfig(link.pbxInstanceId) : null;
      summaryBase.tenants_scanned++;

      const extensions = await db.extension.findMany({
        where: { tenantId: link.tenantId, status: "ACTIVE" },
        include: { pbxLink: true },
      });

      for (const ext of extensions) {
        const pbxExtId = ext.pbxLink?.pbxExtensionId;
        if (!pbxExtId) continue;

        summaryBase.mailboxes_scanned++;
        const key = `${link.tenantId}:${ext.extNumber}`;
        const dbs = dbMap.get(key);
        const newestDbAnyMs = dbs?.newest_any ? dbs.newest_any.getTime() : null;
        const newestDbInboxMs = dbs?.newest_inbox ? dbs.newest_inbox.getTime() : null;
        const cnt7dAny = dbs?.cnt_7d_any ?? 0;
        const cnt30d = dbs?.cnt_30d_any ?? 0;
        const avgPerDay30 = cnt30d / 30;

        let auditError: string | null = null;
        let paginationComplete: boolean | null = null;
        let spoolListSchema: number | null = null;
        let spoolCount = 0;
        let mailboxPath: string | null = null;
        let pbxFolderMax: Record<string, number> = {};
        let newestPbxSec: number | null = null;
        let inserted = 0;
        let alreadyPresent = 0;
        let skippedInvalidOrigtime = 0;
        let errors = 0;

        if (!helperCfg || !vitalTid) {
          auditError = !vitalTid ? "missing_pbx_tenant_id" : "missing_helper_config";
          summaryBase.helper_errors++;
        } else {
          try {
            const dbNewestSec = newestDbAnyMs != null ? Math.floor(newestDbAnyMs / 1000) : null;
            let skipFullList = false;

            if (probeSkipEnabled && dbNewestSec != null && dbNewestSec > 0) {
              const probe = await trackHelper(() =>
                listVoicemailSpoolFromHelper(
                  helperCfg,
                  { tenantId: vitalTid, extension: ext.extNumber, limit: 1, offset: 0 },
                  spoolProbeTimeoutMs,
                ),
              );
              if (probe.spoolListSchema === 2) {
                const pbxMax = parseInt(String(probe.maxOrigtimeAll || ""), 10);
                if (Number.isFinite(pbxMax) && pbxMax > 0 && pbxMax <= dbNewestSec + sinceOverlapSec) {
                  skipFullList = true;
                  skippedProbeNoNew += 1;
                  spoolListSchema = 2;
                  paginationComplete = true;
                  mailboxPath = probe.mailboxPath ?? null;
                  const folderSum =
                    probe.totalCount != null && Number.isFinite(probe.totalCount)
                      ? Number(probe.totalCount)
                      : probe.folderMsgCounts && typeof probe.folderMsgCounts === "object"
                        ? Object.values(probe.folderMsgCounts).reduce((a, v) => a + (Number(v) || 0), 0)
                        : 0;
                  spoolCount = folderSum;
                  summaryBase.spool_messages_sum += folderSum;
                  newestPbxSec = pbxMax;
                }
              }
            }

            if (!skipFullList) {
              const sinceSec =
                dbNewestSec != null && dbNewestSec > 0 ? Math.max(0, dbNewestSec - sinceOverlapSec) : undefined;
              const applied = await trackHelper(() =>
                fetchSpoolAndApplyVoicemails(
                  { tenantId: link.tenantId, pbxTenantId: link.pbxTenantId },
                  ext.extNumber,
                  pbxExtId,
                  helperCfg,
                  vitalTid,
                  {
                    dryRun: false,
                    mode: "insert_only",
                    ...(sinceSec != null ? { sinceOrigtimeSec: sinceSec } : {}),
                  },
                ),
              );
              if (sinceSec != null && applied.spoolMessageCount === 0) {
                skippedSinceNoMessages += 1;
              }
              inserted = applied.inserted;
              alreadyPresent = applied.alreadyPresent;
              skippedInvalidOrigtime = applied.skippedInvalidOrigtime;
              errors = applied.errors;
              const spool = applied.spool;
              spoolCount = applied.spoolMessageCount;
              summaryBase.spool_messages_sum += spoolCount;
              mailboxPath = spool.mailboxPath ?? null;
              paginationComplete = spool.paginationComplete;
              spoolListSchema = spool.spoolListSchema ?? null;
              pbxFolderMax = applied.pbxFolderMaxOrigtimeSec;
              newestPbxSec = applied.newestPbxSec;

              if (!spool.paginationComplete) {
                summaryBase.pagination_incomplete_mailboxes++;
              }
              if (spool.spoolListSchema !== 2) {
                summaryBase.schema2_violation_mailboxes++;
              }
              if (errors > 0) {
                summaryBase.helper_errors++;
              }
            }
          } catch (e: unknown) {
            auditError = e instanceof Error ? e.message : String(e);
            summaryBase.helper_errors++;
          }
        }

        summaryBase.total_inserted += inserted;
        summaryBase.total_already_present += alreadyPresent;
        summaryBase.total_skipped_invalid_origtime += skippedInvalidOrigtime;
        summaryBase.total_errors += errors;

        const { level, failureMode } = classifyVoicemailStaleRisk({
          auditError,
          paginationComplete: auditError ? true : (paginationComplete ?? true),
          newestPbxSec,
          spoolCount,
          mailboxPath,
          newestDbAnyMs,
          newestDbInboxMs,
          cnt7dAny,
          cnt30dAny: cnt30d,
          avgPerDay30,
          pbxFolderMaxJson: pbxFolderMax,
        });

        if (VOICEMAIL_STALE_RISK_RANK[level] >= VOICEMAIL_STALE_RISK_RANK["HIGH"]) {
          summaryBase.high_or_critical_stale_risk_mailboxes++;
        }

        riskyAccumulator.push({
          tenantId: link.tenantId,
          extension: ext.extNumber,
          stale_risk_level: level,
          likely_failure_mode: failureMode,
          inserted,
          pagination_complete: auditError ? null : paginationComplete,
          helper_spool_list_schema: auditError ? null : spoolListSchema,
        });

        if (mailboxDelayMs > 0) {
          await sleep(mailboxDelayMs);
        }
      }

      if (tenantDelayMs > 0) {
        await sleep(tenantDelayMs);
      }
    }

    riskyAccumulator.sort(
      (a, b) => VOICEMAIL_STALE_RISK_RANK[b.stale_risk_level] - VOICEMAIL_STALE_RISK_RANK[a.stale_risk_level],
    );
    summaryBase.top_risky_mailboxes = riskyAccumulator.slice(0, 20);

    const staleHighRiskIncreased =
      hadPrevSummary && summaryBase.high_or_critical_stale_risk_mailboxes > prevHighRisk;
    const evald = evaluateVoicemailSpoolReconcileHealth({
      helperVersionOkGlobal,
      schema2RequiredViolations: summaryBase.schema2_violation_mailboxes,
      paginationIncompleteMailboxes: summaryBase.pagination_incomplete_mailboxes,
      helperErrors: summaryBase.helper_errors,
      totalInserted: summaryBase.total_inserted,
      staleHighRiskIncreased,
    });
    summaryBase.stale_high_risk_increased = staleHighRiskIncreased;
    summaryBase.unhealthy = evald.unhealthy;
    summaryBase.unhealthy_reasons = evald.reasons;
    summaryBase.duration_ms = Date.now() - started;

    const baseIntervalMs = Math.max(
      60_000,
      Number(process.env.VOICEMAIL_SPOOL_RECONCILE_INTERVAL_MS || 15 * 60 * 1000) || 15 * 60 * 1000,
    );
    const maxAdaptiveMs = Math.max(
      baseIntervalMs,
      Number(process.env.VOICEMAIL_SPOOL_RECONCILE_ADAPTIVE_MAX_INTERVAL_MS || 4 * 60 * 60 * 1000) ||
        4 * 60 * 60 * 1000,
    );
    const maxBackoffSteps = Math.max(
      0,
      Number(process.env.VOICEMAIL_SPOOL_RECONCILE_ZERO_INSERT_BACKOFF_MAX_STEPS || 5) || 5,
    );
    const jitterRatio = Math.max(0, Number(process.env.VOICEMAIL_SPOOL_RECONCILE_SCHEDULE_JITTER_RATIO || 0.12) || 0.12);

    const cleanZero =
      summaryBase.total_inserted === 0 &&
      summaryBase.helper_errors === 0 &&
      summaryBase.pagination_incomplete_mailboxes === 0 &&
      summaryBase.schema2_violation_mailboxes === 0 &&
      helperVersionOkGlobal &&
      !staleHighRiskIncreased;

    const nextStreak = cleanZero ? backoffBefore.consecutiveCleanZeroInsertCycles + 1 : 0;
    const adaptiveBase = computeAdaptiveReconcileDelayMs(
      baseIntervalMs,
      maxAdaptiveMs,
      maxBackoffSteps,
      nextStreak,
    );
    const next_reconcile_delay_ms = applyScheduleJitterMs(adaptiveBase, jitterRatio);

    const fullSummary: VoicemailSpoolReconcileSummary = {
      ...summaryBase,
      helper_calls: helperCalls,
      avg_helper_ms: helperCalls > 0 ? Math.round(helperMsSum / helperCalls) : 0,
      max_helper_ms: helperMsMax,
      skipped_probe_no_new: skippedProbeNoNew,
      skipped_since_no_messages: skippedSinceNoMessages,
      consecutive_clean_zero_insert_cycles_after: nextStreak,
      adaptive_delay_base_ms: adaptiveBase,
      next_reconcile_delay_ms,
    };

    console.log(JSON.stringify(fullSummary));

    try {
      await redis.set(REDIS_SUMMARY_KEY, JSON.stringify(fullSummary), "EX", 86400 * 7);
    } catch (e: unknown) {
      console.error(
        JSON.stringify({
          msg: "voicemail-spool-reconcile-redis-write-failed",
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }

    try {
      await redis.set(
        REDIS_BACKOFF_STATE_KEY,
        JSON.stringify({ consecutiveCleanZeroInsertCycles: nextStreak }),
        "EX",
        86400 * 7,
      );
    } catch (e: unknown) {
      console.error(
        JSON.stringify({
          msg: "voicemail-spool-reconcile-backoff-redis-write-failed",
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }

    return fullSummary;
  } finally {
    _vmSpoolReconcileRunning = false;
  }
}

let _spoolReconcileTimer: ReturnType<typeof setTimeout> | null = null;
let _spoolReconcileLoopStarted = false;

/** Self-scheduling loop (adaptive delay + jitter). Replaces fixed setInterval for spool reconcile. */
export function startVoicemailSpoolReconcileLoop(): void {
  if (_spoolReconcileLoopStarted) return;
  const baseIntervalMs = Number(process.env.VOICEMAIL_SPOOL_RECONCILE_INTERVAL_MS || 15 * 60 * 1000);
  if (!Number.isFinite(baseIntervalMs) || baseIntervalMs <= 0) return;
  _spoolReconcileLoopStarted = true;

  const schedule = (delayMs: number) => {
    if (_spoolReconcileTimer) clearTimeout(_spoolReconcileTimer);
    _spoolReconcileTimer = setTimeout(runOnce, delayMs);
  };

  const runOnce = async () => {
    try {
      const summary = await runVoicemailSpoolReconcileCycle();
      const waitMs =
        summary?.next_reconcile_delay_ms ??
        applyScheduleJitterMs(
          Math.max(60_000, baseIntervalMs),
          Math.max(0, Number(process.env.VOICEMAIL_SPOOL_RECONCILE_SCHEDULE_JITTER_RATIO || 0.12) || 0.12),
        );
      schedule(waitMs);
    } catch (err: unknown) {
      console.error("voicemail spool reconcile failed", err instanceof Error ? err.message : String(err));
      const jitterRatio = Math.max(0, Number(process.env.VOICEMAIL_SPOOL_RECONCILE_SCHEDULE_JITTER_RATIO || 0.12) || 0.12);
      schedule(applyScheduleJitterMs(Math.max(60_000, baseIntervalMs), jitterRatio));
    }
  };

  schedule(0);
}

/** @internal tests — reset adaptive loop guard (does not clear active timer). */
export function __testOnly_resetVoicemailSpoolReconcileLoopGuard(): void {
  _spoolReconcileLoopStarted = false;
}

export { REDIS_SUMMARY_KEY, REDIS_BACKOFF_STATE_KEY };
