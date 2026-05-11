/**
 * Scheduled insert-only reconcile: PBX spool → DB for all active PBX-linked mailboxes.
 * Complements the faster voicemail sync cycle (REST-first, capped helper fallback).
 */
import IORedis from "ioredis";
import { db } from "@connect/db";
import {
  fetchPbxRouteHelperHealth,
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

export async function runVoicemailSpoolReconcileCycle(): Promise<void> {
  if (_vmSpoolReconcileRunning) return;
  _vmSpoolReconcileRunning = true;
  const started = Date.now();
  try {
    const minHelperVersion = String(
      process.env.VOICEMAIL_SPOOL_RECONCILE_MIN_HELPER_VERSION || "2026.05.10.1",
    ).trim();
    const mailboxDelayMs = Math.max(
      0,
      Number(process.env.VOICEMAIL_SPOOL_RECONCILE_MAILBOX_DELAY_MS || 150) || 150,
    );
    const healthTimeoutMs = Math.max(2000, Number(process.env.VOICEMAIL_HELPER_HEALTH_TIMEOUT_MS || 5000) || 5000);

    const redis = reconcileRedis();
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

    const summaryBase = {
      msg: "voicemail-spool-reconcile-summary" as const,
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
      unhealthy_reasons: [] as string[],
      top_risky_mailboxes: [] as RiskyMailbox[],
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
            const applied = await fetchSpoolAndApplyVoicemails(
              { tenantId: link.tenantId, pbxTenantId: link.pbxTenantId },
              ext.extNumber,
              pbxExtId,
              helperCfg,
              vitalTid,
              { dryRun: false, mode: "insert_only" },
            );
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

    console.log(JSON.stringify(summaryBase));

    try {
      await redis.set(REDIS_SUMMARY_KEY, JSON.stringify(summaryBase), "EX", 86400 * 7);
    } catch (e: unknown) {
      console.error(
        JSON.stringify({
          msg: "voicemail-spool-reconcile-redis-write-failed",
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  } finally {
    _vmSpoolReconcileRunning = false;
  }
}

export { REDIS_SUMMARY_KEY };
