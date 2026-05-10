/**
 * Fleet-wide stale-risk report: compares newest PBX-visible voicemail (helper spool list)
 * vs DB aggregates (all folders + inbox-only, matching API list defaults).
 *
 * Read-only: SELECTs + helper POST /voicemail/spool/list.
 *
 * Run inside app-worker-1:
 *   cd /app/apps/worker && pnpm exec tsx src/scripts/voicemail-fleet-stale-report.ts
 *
 * Options:
 *   --tenant=<cuid>       One Connect tenant
 *   --extension=<ext>     One mailbox (requires --tenant)
 *   --helper-delay-ms=N   Delay between helper calls (default 100)
 *   --min-risk=low|medium|high|critical   Only print rows at or above threshold
 */
import { db, type Prisma } from "@connect/db";
import { listVoicemailSpoolFromHelper, resolvePbxRouteHelperConfig } from "@connect/integrations";
import { mapHelperVoicemailSpoolToRecordShape } from "@connect/shared";

type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";

const RISK_RANK: Record<RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
  UNKNOWN: 4,
};

type DbRow = {
  tenantId: string;
  extension: string;
  newest_any: Date | null;
  newest_inbox: Date | null;
  newest_created: Date | null;
  cnt_7d_any: number;
  cnt_7d_inbox: number;
  cnt_30d_any: number;
};

function parseArgs(): {
  tenantId: string | null;
  extension: string | null;
  helperDelayMs: number;
  minRisk: RiskLevel;
} {
  let tenantId: string | null = null;
  let extension: string | null = null;
  let helperDelayMs = 100;
  let minRisk: RiskLevel = "LOW";
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--tenant=")) tenantId = a.slice("--tenant=".length).trim() || null;
    if (a.startsWith("--extension=")) extension = a.slice("--extension=".length).trim() || null;
    if (a.startsWith("--helper-delay-ms=")) helperDelayMs = Math.max(0, parseInt(a.slice("--helper-delay-ms=".length), 10) || 0);
    if (a.startsWith("--min-risk=")) {
      const v = a.slice("--min-risk=".length).trim().toLowerCase();
      if (v === "medium" || v === "med") minRisk = "MEDIUM";
      else if (v === "high") minRisk = "HIGH";
      else if (v === "critical" || v === "crit") minRisk = "CRITICAL";
      else minRisk = "LOW";
    }
  }
  return { tenantId, extension, helperDelayMs, minRisk };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function iso(d: Date | null | undefined): string | null {
  if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function hoursDelta(aSec: number | null, bMs: number | null): number | null {
  if (aSec == null || bMs == null) return null;
  return (aSec * 1000 - bMs) / 3600000;
}

function daysSince(ms: number | null): number | null {
  if (ms == null) return null;
  return (Date.now() - ms) / (86400000);
}

function classifyStaleRisk(input: {
  auditError: string | null;
  newestPbxSec: number | null;
  spoolCount: number;
  mailboxPath: string | null;
  newestDbAnyMs: number | null;
  newestDbInboxMs: number | null;
  cnt7dAny: number;
  cnt30dAny: number;
  avgPerDay30: number;
  pbxFolderMaxJson: Record<string, number>;
}): { level: RiskLevel; failureMode: string } {
  if (input.auditError) {
    return { level: "UNKNOWN", failureMode: `helper_or_config_error:${input.auditError.slice(0, 120)}` };
  }

  const expected7d = input.avgPerDay30 * 7;
  const collapse =
    input.avgPerDay30 >= 0.2 &&
    expected7d >= 1 &&
    input.cnt7dAny < Math.max(1, expected7d * 0.15) &&
    (daysSince(input.newestDbAnyMs) ?? 99) > 2;

  const highBaseline = input.avgPerDay30 >= 0.15;
  const helperEmpty = input.spoolCount === 0;
  const dbStaleDays = daysSince(input.newestDbAnyMs) ?? 0;

  // PBX (per helper list) ahead of DB — messages visible to helper are newer than last ingested row
  if (input.newestPbxSec != null && input.newestDbAnyMs != null) {
    const d = hoursDelta(input.newestPbxSec, input.newestDbAnyMs);
    if (d != null && d > 2) {
      return {
        level: "CRITICAL",
        failureMode: `pbx_helper_max_ahead_of_db(${d.toFixed(1)}h);ingest_lag_or_dedupe_mismatch`,
      };
    }
  }

  if (input.newestPbxSec != null && input.newestDbAnyMs == null && input.newestPbxSec * 1000 > Date.now() - 86400000 * 7) {
    return { level: "CRITICAL", failureMode: "pbx_helper_shows_recent_mail_but_no_db_rows" };
  }

  if (helperEmpty && highBaseline && dbStaleDays > 3) {
    return {
      level: "HIGH",
      failureMode:
        "helper_empty_or_zero_msgs_vs_high_historical_baseline;check_slug_path_mailbox_drift_or_auth",
    };
  }

  if (collapse) {
    return {
      level: "HIGH",
      failureMode: "volume_collapse_vs_30d_baseline;check_rest_non_empty_skip_helper_or_notify_path",
    };
  }

  // Default inbox list hides old/urgent — user-visible "staleness" while DB has fresh rows elsewhere
  if (
    input.newestDbAnyMs != null &&
    input.newestDbInboxMs != null &&
    input.newestDbAnyMs - input.newestDbInboxMs > 3600000 * 6
  ) {
    const gapH = (input.newestDbAnyMs - input.newestDbInboxMs) / 3600000;
    return {
      level: "MEDIUM",
      failureMode: `api_ui_default_inbox_stale_vs_other_folders(${gapH.toFixed(1)}h newer outside inbox);folder_filter_not_bug_but_masks_activity`,
    };
  }

  // Helper returns some rows but newest PBX in list is much older than DB — possible wrong mailbox / stale listing
  if (!helperEmpty && input.newestPbxSec != null && input.newestDbAnyMs != null) {
    const d = hoursDelta(input.newestDbAnyMs / 1000, input.newestPbxSec * 1000);
    if (d != null && d > 48) {
      return {
        level: "MEDIUM",
        failureMode: "db_newer_than_helper_max;helper_stale_subset_wrong_mailbox_or_deleted_on_pbx",
      };
    }
  }

  const folders = Object.keys(input.pbxFolderMaxJson);
  if (folders.length > 1) {
    const vals = Object.values(input.pbxFolderMaxJson);
    const spreadSec = Math.max(...vals) - Math.min(...vals);
    if (spreadSec > 86400 * 3) {
      return {
        level: "MEDIUM",
        failureMode: "large_pbx_folder_origtime_spread;check_folder_drift_inbox_vs_old",
      };
    }
  }

  if (highBaseline && helperEmpty && input.cnt7dAny > 0) {
    return {
      level: "MEDIUM",
      failureMode: "helper_empty_but_db_has_7d_rows;possible_transient_or_listing_scope_mismatch",
    };
  }

  return { level: "LOW", failureMode: "nominal" };
}

async function loadDbStats(): Promise<Map<string, DbRow>> {
  const rows = await db.$queryRaw<DbRow[]>`
    SELECT
      v."tenantId" AS "tenantId",
      v.extension AS extension,
      MAX(v."receivedAt") AS "newest_any",
      MAX(v."receivedAt") FILTER (WHERE v.folder = 'inbox') AS "newest_inbox",
      MAX(v."createdAt") AS "newest_created",
      COUNT(*) FILTER (WHERE v."receivedAt" >= NOW() - INTERVAL '7 days')::int AS "cnt_7d_any",
      COUNT(*) FILTER (
        WHERE v."receivedAt" >= NOW() - INTERVAL '7 days' AND v.folder = 'inbox'
      )::int AS "cnt_7d_inbox",
      COUNT(*) FILTER (WHERE v."receivedAt" >= NOW() - INTERVAL '30 days')::int AS "cnt_30d_any"
    FROM "Voicemail" v
    WHERE v."deletedAt" IS NULL AND v."tenantId" IS NOT NULL
    GROUP BY v."tenantId", v.extension
  `;
  const m = new Map<string, DbRow>();
  for (const r of rows) {
    m.set(`${r.tenantId}:${r.extension}`, r);
  }
  return m;
}

async function main(): Promise<void> {
  const { tenantId: filterTenantId, extension: filterExt, helperDelayMs, minRisk } = parseArgs();
  const minRank = RISK_RANK[minRisk];

  if (filterExt && !filterTenantId) {
    console.error("--extension requires --tenant");
    process.exit(2);
  }

  const linkWhere: Prisma.TenantPbxLinkWhereInput = { pbxInstance: { isEnabled: true } };
  if (filterTenantId) linkWhere.tenantId = filterTenantId;

  const dbMap = await loadDbStats();

  const links = await db.tenantPbxLink.findMany({
    where: linkWhere,
    include: {
      pbxInstance: true,
      tenant: { select: { id: true, name: true } },
    },
  });

  const summary = {
    msg: "voicemail-fleet-stale-summary",
    mailboxes_scanned: 0,
    by_risk: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 } as Record<RiskLevel, number>,
    helper_errors: 0,
  };

  type OutRow = {
    msg: "voicemail-fleet-stale-row";
    tenant: string | null;
    tenantId: string;
    extension: string;
    pbxTenantId: string | null;
    pbxTenantCode: string | null;
    newest_pbx_vm_iso: string | null;
    newest_db_vm_iso: string | null;
    newest_db_inbox_iso: string | null;
    newest_db_created_iso: string | null;
    /** Positive = PBX helper max origtime ahead of DB max receivedAt (any folder), hours */
    delta_hours_pbx_minus_db: number | null;
    volume_7d: number;
    historical_avg_per_day_30d: number;
    expected_7d_from_baseline: number;
    spool_message_count: number;
    mailbox_path: string | null;
    resolved_context: string | null;
    pbx_folder_max_origtime_sec: Record<string, number>;
    stale_risk_level: RiskLevel;
    likely_failure_mode: string;
  };

  const outRows: OutRow[] = [];
  let helperCalls = 0;

  for (const link of links) {
    if (!link?.pbxInstance) continue;
    const vitalTid = String(link.pbxTenantId || "").trim();
    const helperCfg = vitalTid ? resolvePbxRouteHelperConfig(link.pbxInstanceId) : null;

    const extensions = await db.extension.findMany({
      where: {
        tenantId: link.tenantId,
        status: "ACTIVE",
        ...(filterExt ? { extNumber: filterExt } : {}),
      },
      include: { pbxLink: true },
    });

    for (const ext of extensions) {
      if (!ext.pbxLink?.pbxExtensionId) continue;
      summary.mailboxes_scanned++;

      const key = `${link.tenantId}:${ext.extNumber}`;
      const dbs = dbMap.get(key);

      const newestDbAnyMs = dbs?.newest_any ? dbs.newest_any.getTime() : null;
      const newestDbInboxMs = dbs?.newest_inbox ? dbs.newest_inbox.getTime() : null;
      const cnt7dAny = dbs?.cnt_7d_any ?? 0;
      const cnt30d = dbs?.cnt_30d_any ?? 0;
      const avgPerDay30 = cnt30d / 30;

      let auditError: string | null = null;
      let spoolCount = 0;
      let newestPbxSec: number | null = null;
      let mailboxPath: string | null = null;
      let resolvedContext: string | null = null;
      const pbxFolderMax: Record<string, number> = {};

      if (!helperCfg || !vitalTid) {
        auditError = !vitalTid ? "missing_pbx_tenant_id" : "missing_helper_config";
        summary.helper_errors++;
      } else {
        try {
          if (helperCalls > 0 && helperDelayMs > 0) await sleep(helperDelayMs);
          const spool = await listVoicemailSpoolFromHelper(helperCfg, {
            tenantId: vitalTid,
            extension: ext.extNumber,
          });
          helperCalls++;
          mailboxPath = spool.mailboxPath ?? null;
          resolvedContext = spool.resolvedContext ?? null;
          const messages = spool.messages || [];
          spoolCount = messages.length;
          const mapped = messages.map(mapHelperVoicemailSpoolToRecordShape);
          for (const rec of mapped) {
            const ot = String(rec.date ?? rec.origtime ?? rec.orig_time ?? "");
            const sec = parseInt(ot, 10);
            if (!ot || ot === "0" || !sec) continue;
            newestPbxSec = newestPbxSec == null ? sec : Math.max(newestPbxSec, sec);
            const folder = String(rec.folder ?? "INBOX").toLowerCase();
            pbxFolderMax[folder] = Math.max(pbxFolderMax[folder] ?? 0, sec);
          }
        } catch (e: unknown) {
          auditError = e instanceof Error ? e.message : String(e);
          summary.helper_errors++;
        }
      }

      const { level, failureMode } = classifyStaleRisk({
        auditError,
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

      summary.by_risk[level]++;

      const deltaH =
        newestPbxSec != null && newestDbAnyMs != null ? hoursDelta(newestPbxSec, newestDbAnyMs) : null;

      const row: OutRow = {
        msg: "voicemail-fleet-stale-row",
        tenant: link.tenant?.name ?? null,
        tenantId: link.tenantId,
        extension: ext.extNumber,
        pbxTenantId: link.pbxTenantId ?? null,
        pbxTenantCode: link.pbxTenantCode ?? null,
        newest_pbx_vm_iso: newestPbxSec != null ? new Date(newestPbxSec * 1000).toISOString() : null,
        newest_db_vm_iso: iso(dbs?.newest_any ?? null),
        newest_db_inbox_iso: iso(dbs?.newest_inbox ?? null),
        newest_db_created_iso: iso(dbs?.newest_created ?? null),
        delta_hours_pbx_minus_db: deltaH,
        volume_7d: cnt7dAny,
        historical_avg_per_day_30d: Math.round(avgPerDay30 * 1000) / 1000,
        expected_7d_from_baseline: Math.round(avgPerDay30 * 7 * 1000) / 1000,
        spool_message_count: spoolCount,
        mailbox_path: mailboxPath,
        resolved_context: resolvedContext,
        pbx_folder_max_origtime_sec: pbxFolderMax,
        stale_risk_level: level,
        likely_failure_mode: failureMode,
      };

      if (RISK_RANK[level] >= minRank) {
        outRows.push(row);
      }
    }
  }

  outRows.sort((a, b) => {
    const dr = RISK_RANK[b.stale_risk_level] - RISK_RANK[a.stale_risk_level];
    if (dr !== 0) return dr;
    const da = a.delta_hours_pbx_minus_db ?? -9999;
    const db = b.delta_hours_pbx_minus_db ?? -9999;
    return db - da;
  });

  for (const r of outRows) {
    console.log(JSON.stringify(r));
  }

  console.log(JSON.stringify(summary));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
