/**
 * Shared stale-risk heuristics for voicemail (fleet report + scheduled reconcile).
 * Read-only classification inputs; callers supply helper/DB facts.
 */
import { db } from "@connect/db";

export type VoicemailStaleRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";

export const VOICEMAIL_STALE_RISK_RANK: Record<VoicemailStaleRiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
  UNKNOWN: 4,
};

export type VoicemailDbStatsRow = {
  tenantId: string;
  extension: string;
  newest_any: Date | null;
  newest_inbox: Date | null;
  newest_created: Date | null;
  cnt_7d_any: number;
  cnt_7d_inbox: number;
  cnt_30d_any: number;
};

function daysSince(ms: number | null): number | null {
  if (ms == null) return null;
  return (Date.now() - ms) / 86400000;
}

function hoursDelta(aSec: number | null, bMs: number | null): number | null {
  if (aSec == null || bMs == null) return null;
  return (aSec * 1000 - bMs) / 3600000;
}

export function classifyVoicemailStaleRisk(input: {
  auditError: string | null;
  paginationComplete: boolean;
  newestPbxSec: number | null;
  spoolCount: number;
  mailboxPath: string | null;
  newestDbAnyMs: number | null;
  newestDbInboxMs: number | null;
  cnt7dAny: number;
  cnt30dAny: number;
  avgPerDay30: number;
  pbxFolderMaxJson: Record<string, number>;
}): { level: VoicemailStaleRiskLevel; failureMode: string } {
  if (input.auditError) {
    return { level: "UNKNOWN", failureMode: `helper_or_config_error:${input.auditError.slice(0, 120)}` };
  }

  if (input.paginationComplete === false) {
    return {
      level: "HIGH",
      failureMode: "helper_spool_pagination_incomplete;raise_VOICEMAIL_HELPER_SPOOL_MAX_PAGES_or_pageSize",
    };
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
      failureMode: "helper_empty_or_zero_msgs_vs_high_historical_baseline;check_slug_path_mailbox_drift_or_auth",
    };
  }

  if (collapse) {
    return {
      level: "HIGH",
      failureMode: "volume_collapse_vs_30d_baseline;check_rest_non_empty_skip_helper_or_notify_path",
    };
  }

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

export async function loadVoicemailDbStatsByMailbox(): Promise<Map<string, VoicemailDbStatsRow>> {
  const rows = await db.$queryRaw<VoicemailDbStatsRow[]>`
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
  const m = new Map<string, VoicemailDbStatsRow>();
  for (const r of rows) {
    m.set(`${r.tenantId}:${r.extension}`, r);
  }
  return m;
}

export function hoursDeltaPbxMinusDb(newestPbxSec: number | null, newestDbAnyMs: number | null): number | null {
  return hoursDelta(newestPbxSec, newestDbAnyMs);
}
