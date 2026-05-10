/**
 * Read-only audit: PBX helper spool vs Connect Voicemail (per mailbox).
 * No database writes. No PBX mutations (helper list is read-only).
 *
 * Run inside app-worker-1:
 *   cd /app/apps/worker && pnpm exec tsx src/scripts/voicemail-spool-audit.ts [options]
 *
 * Options:
 *   --min-missing-7d=N   Only emit rows where missing_7d >= N (default: 0 = all mailboxes)
 *   --tenant=<cuid>      Restrict to one Connect tenant
 *   --extension=<ext>    Restrict to one mailbox (requires --tenant)
 *   --helper-delay-ms=M  Pause M ms between helper calls (default 100)
 */
import { db, type Prisma } from "@connect/db";
import { fetchAllVoicemailSpoolMessages, resolvePbxRouteHelperConfig } from "@connect/integrations";
import { mapHelperVoicemailSpoolToRecordShape, vmExtractCallerNumber, vmStablePbxMessageId } from "@connect/shared";

function parseArgs(): {
  minMissing7d: number;
  tenantId: string | null;
  extension: string | null;
  helperDelayMs: number;
} {
  let minMissing7d = 0;
  let tenantId: string | null = null;
  let extension: string | null = null;
  let helperDelayMs = 100;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--min-missing-7d=")) minMissing7d = Math.max(0, parseInt(a.slice("--min-missing-7d=".length), 10) || 0);
    if (a.startsWith("--tenant=")) tenantId = a.slice("--tenant=".length).trim() || null;
    if (a.startsWith("--extension=")) extension = a.slice("--extension=".length).trim() || null;
    if (a.startsWith("--helper-delay-ms=")) helperDelayMs = Math.max(0, parseInt(a.slice("--helper-delay-ms=".length), 10) || 0);
  }
  return { minMissing7d, tenantId, extension, helperDelayMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function inWindowSec(origtimeSec: number, hours: number): boolean {
  if (!origtimeSec || origtimeSec <= 0) return false;
  const ms = origtimeSec * 1000;
  return ms >= Date.now() - hours * 3600 * 1000;
}

async function main(): Promise<void> {
  const { minMissing7d, tenantId: filterTenantId, extension: filterExt, helperDelayMs } = parseArgs();

  if (filterExt && !filterTenantId) {
    console.error("--extension requires --tenant");
    process.exit(2);
  }

  const linkWhere: Prisma.TenantPbxLinkWhereInput = { pbxInstance: { isEnabled: true } };
  if (filterTenantId) {
    linkWhere.tenantId = filterTenantId;
  }

  const links = await db.tenantPbxLink.findMany({
    where: linkWhere,
    include: {
      pbxInstance: true,
      tenant: { select: { id: true, name: true } },
    },
  });

  const summary = {
    msg: "voicemail-spool-audit-summary",
    mailboxes_scanned: 0,
    mailboxes_with_missing_7d: 0,
    total_missing_7d: 0,
    helper_errors: 0,
    helper_pagination_incomplete_mailboxes: 0,
  };

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

      const rowBase = {
        tenantName: link.tenant?.name ?? null,
        tenantId: link.tenantId,
        pbxTenantId: link.pbxTenantId ?? null,
        pbxTenantCode: link.pbxTenantCode ?? null,
        extension: ext.extNumber,
      };

      if (!helperCfg || !vitalTid) {
        console.log(
          JSON.stringify({
            ...rowBase,
            msg: "voicemail-spool-audit-row",
            spool_count_24h: null,
            spool_count_7d: null,
            spool_total: null,
            db_count_24h: null,
            db_count_7d: null,
            missing_24h: null,
            missing_7d: null,
            oldest_missing_iso: null,
            audit_error: !vitalTid ? "missing_pbx_tenant_id" : "missing_helper_config",
          }),
        );
        continue;
      }

      let spoolMessages: any[] = [];
      let auditError: string | null = null;
      let helperPaginationComplete = true;
      let helperTotalCount: number | null = null;
      let helperMaxOrigtimeAll: string | null = null;
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
        spoolMessages = spool.messages || [];
        helperPaginationComplete = spool.paginationComplete;
        helperTotalCount = spool.totalCount ?? spoolMessages.length;
        helperMaxOrigtimeAll = spool.maxOrigtimeAll != null && String(spool.maxOrigtimeAll) !== "" ? String(spool.maxOrigtimeAll) : null;
        if (!helperPaginationComplete) summary.helper_pagination_incomplete_mailboxes++;
      } catch (e: unknown) {
        auditError = e instanceof Error ? e.message : String(e);
        summary.helper_errors++;
      }

      if (auditError) {
        console.log(
          JSON.stringify({
            ...rowBase,
            msg: "voicemail-spool-audit-row",
            spool_count_24h: null,
            spool_count_7d: null,
            spool_total: null,
            db_count_24h: null,
            db_count_7d: null,
            missing_24h: null,
            missing_7d: null,
            oldest_missing_iso: null,
            audit_error: auditError,
            helper_pagination_complete: null,
            helper_total_count: null,
            helper_max_origtime_all: null,
          }),
        );
        continue;
      }

      const mapped = spoolMessages.map(mapHelperVoicemailSpoolToRecordShape);
      let spool24 = 0;
      let spool7 = 0;
      let missing24 = 0;
      let missing7 = 0;
      let oldestMissingSec: number | null = null;

      for (const rec of mapped) {
        const origtime = String(rec.date ?? rec.origtime ?? rec.orig_time ?? "");
        const sec = parseInt(origtime, 10);
        if (!origtime || origtime === "0" || !sec) continue;

        const in24 = inWindowSec(sec, 24);
        const in7 = inWindowSec(sec, 24 * 7);
        if (in24) spool24++;
        if (in7) spool7++;

        const rawCallerid = String(rec.clid ?? rec.callerid ?? rec.caller_id ?? "");
        const callerNumber = vmExtractCallerNumber(rawCallerid) || null;
        const callerDigits = (callerNumber ?? "").slice(-10);
        const msgId = vmStablePbxMessageId({
          msgId: rec.msg_id,
          pbxTenantIdOrTenantCuid: String(link.pbxTenantId || link.tenantId),
          extNumber: ext.extNumber,
          origtime,
          callerDigits,
        });

        const exists = await db.voicemail.findUnique({
          where: { pbxMessageId: msgId },
          select: { id: true },
        });
        if (!exists) {
          if (in24) missing24++;
          if (in7) {
            missing7++;
            oldestMissingSec = oldestMissingSec === null ? sec : Math.min(oldestMissingSec, sec);
          }
        }
      }

      const db24 = await db.voicemail.count({
        where: {
          tenantId: link.tenantId,
          extension: ext.extNumber,
          deletedAt: null,
          receivedAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
        },
      });
      const db7 = await db.voicemail.count({
        where: {
          tenantId: link.tenantId,
          extension: ext.extNumber,
          deletedAt: null,
          receivedAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) },
        },
      });

      if (missing7 > 0) {
        summary.mailboxes_with_missing_7d++;
        summary.total_missing_7d += missing7;
      }

      if (missing7 < minMissing7d) continue;

      console.log(
        JSON.stringify({
          ...rowBase,
          msg: "voicemail-spool-audit-row",
          spool_count_24h: spool24,
          spool_count_7d: spool7,
          spool_total: mapped.length,
          db_count_24h: db24,
          db_count_7d: db7,
          missing_count_24h: missing24,
          missing_count_7d: missing7,
          oldest_missing_iso:
            oldestMissingSec != null ? new Date(oldestMissingSec * 1000).toISOString() : null,
          audit_error: null,
          helper_pagination_complete: helperPaginationComplete,
          helper_total_count: helperTotalCount,
          helper_max_origtime_all: helperMaxOrigtimeAll,
        }),
      );
    }
  }

  console.log(JSON.stringify(summary));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
