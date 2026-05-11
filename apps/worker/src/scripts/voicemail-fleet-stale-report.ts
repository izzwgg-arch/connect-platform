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
import { fetchAllVoicemailSpoolMessages, resolvePbxRouteHelperConfig } from "@connect/integrations";
import { mapHelperVoicemailSpoolToRecordShape } from "@connect/shared";
import {
  classifyVoicemailStaleRisk,
  hoursDeltaPbxMinusDb,
  loadVoicemailDbStatsByMailbox,
  VOICEMAIL_STALE_RISK_RANK,
  type VoicemailDbStatsRow,
  type VoicemailStaleRiskLevel,
} from "../voicemailStaleRiskShared";

type RiskLevel = VoicemailStaleRiskLevel;
type DbRow = VoicemailDbStatsRow;

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

async function main(): Promise<void> {
  const { tenantId: filterTenantId, extension: filterExt, helperDelayMs, minRisk } = parseArgs();
  const minRank = VOICEMAIL_STALE_RISK_RANK[minRisk];

  if (filterExt && !filterTenantId) {
    console.error("--extension requires --tenant");
    process.exit(2);
  }

  const linkWhere: Prisma.TenantPbxLinkWhereInput = { pbxInstance: { isEnabled: true } };
  if (filterTenantId) linkWhere.tenantId = filterTenantId;

  const dbMap = await loadVoicemailDbStatsByMailbox();

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
    helper_pagination_incomplete_mailboxes: 0,
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
    helper_pagination_complete: boolean | null;
    helper_spool_list_schema: number | null;
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
      let paginationComplete = true;
      let spoolListSchema: number | null = null;
      const pbxFolderMax: Record<string, number> = {};

      if (!helperCfg || !vitalTid) {
        auditError = !vitalTid ? "missing_pbx_tenant_id" : "missing_helper_config";
        summary.helper_errors++;
      } else {
        try {
          if (helperCalls > 0 && helperDelayMs > 0) await sleep(helperDelayMs);
          const spoolPageSize = Math.max(100, Number(process.env.VOICEMAIL_HELPER_SPOOL_PAGE_SIZE || 2000) || 2000);
          const spoolTimeoutMs = Math.max(5000, Number(process.env.VOICEMAIL_HELPER_SPOOL_FETCH_TIMEOUT_MS || 20000) || 20000);
          const spool = await fetchAllVoicemailSpoolMessages(
            helperCfg,
            { tenantId: vitalTid, extension: ext.extNumber },
            { pageSize: spoolPageSize, timeoutMs: spoolTimeoutMs },
          );
          helperCalls++;
          mailboxPath = spool.mailboxPath ?? null;
          resolvedContext = spool.resolvedContext ?? null;
          const messages = spool.messages || [];
          spoolCount = messages.length;
          if (spool.maxOrigtimeAll != null && String(spool.maxOrigtimeAll) !== "") {
            const mall = parseInt(String(spool.maxOrigtimeAll), 10);
            if (mall > 0) newestPbxSec = mall;
          }
          paginationComplete = spool.paginationComplete;
          spoolListSchema = spool.spoolListSchema ?? null;
          if (!paginationComplete) summary.helper_pagination_incomplete_mailboxes++;

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

      const { level, failureMode } = classifyVoicemailStaleRisk({
        auditError,
        paginationComplete: auditError ? true : paginationComplete,
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
        newestPbxSec != null && newestDbAnyMs != null ? hoursDeltaPbxMinusDb(newestPbxSec, newestDbAnyMs) : null;

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
        helper_pagination_complete: auditError ? null : paginationComplete,
        helper_spool_list_schema: auditError ? null : spoolListSchema,
      };

      if (VOICEMAIL_STALE_RISK_RANK[level] >= minRank) {
        outRows.push(row);
      }
    }
  }

  outRows.sort((a, b) => {
    const dr = VOICEMAIL_STALE_RISK_RANK[b.stale_risk_level] - VOICEMAIL_STALE_RISK_RANK[a.stale_risk_level];
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
