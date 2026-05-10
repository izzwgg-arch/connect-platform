/**
 * Idempotent PBX spool → Connect Voicemail upsert (read-only on PBX).
 *
 * Run inside the worker container (same env as worker):
 *   cd /app/apps/worker && pnpm exec tsx src/scripts/voicemail-spool-backfill.ts <mode> [--extension=<extNumber>]
 *
 * Mode (exactly one):
 *   --tenant=<connectTenantCuid>
 *   --all-tenants
 *   --tenant-ids-file=/path/to/ids.txt   (one Connect tenant CUID per line)
 *
 * Per extension JSON line: inserted, already_present, skipped_invalid_origtime, upsert_errors (errors).
 */
import { readFileSync } from "node:fs";

import { db } from "@connect/db";
import { fetchAllVoicemailSpoolMessages, resolvePbxRouteHelperConfig } from "@connect/integrations";
import {
  mapHelperVoicemailSpoolToRecordShape,
  vmExtractCallerName,
  vmExtractCallerNumber,
  vmNormalizeFolder,
  vmStablePbxMessageId,
} from "@connect/shared";

type BackfillMode =
  | { kind: "single"; tenantId: string }
  | { kind: "all" }
  | { kind: "file"; path: string };

function parseArgs(): { mode: BackfillMode | null; extension: string | null } {
  let extension: string | null = null;
  let singleTenant: string | null = null;
  let allTenants = false;
  let tenantIdsFile: string | null = null;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--tenant=")) singleTenant = a.slice("--tenant=".length).trim() || null;
    if (a === "--all-tenants") allTenants = true;
    if (a.startsWith("--tenant-ids-file=")) tenantIdsFile = a.slice("--tenant-ids-file=".length).trim() || null;
    if (a.startsWith("--extension=")) extension = a.slice("--extension=".length).trim() || null;
  }

  const modes = [singleTenant, allTenants, tenantIdsFile].filter(Boolean).length;
  if (modes !== 1) {
    return { mode: null, extension };
  }
  if (singleTenant) return { mode: { kind: "single", tenantId: singleTenant }, extension };
  if (allTenants) return { mode: { kind: "all" }, extension };
  return { mode: { kind: "file", path: tenantIdsFile! }, extension };
}

async function resolveTenantIds(mode: BackfillMode): Promise<string[]> {
  if (mode.kind === "single") return [mode.tenantId];
  if (mode.kind === "all") {
    const links = await db.tenantPbxLink.findMany({
      where: { pbxInstance: { isEnabled: true } },
      select: { tenantId: true },
    });
    return [...new Set(links.map((l) => l.tenantId))];
  }
  const raw = readFileSync(mode.path, "utf8");
  return [...new Set(raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
}

async function backfillOneTenant(tenantId: string, extension: string | null): Promise<{
  totalInserted: number;
  totalPresent: number;
  totalSkippedOrig: number;
  totalErrors: number;
}> {
  let totalInserted = 0;
  let totalPresent = 0;
  let totalSkippedOrig = 0;
  let totalErrors = 0;

  const link = await db.tenantPbxLink.findUnique({
    where: { tenantId },
    include: { pbxInstance: true },
  });
  if (!link?.pbxInstance) {
    console.log(JSON.stringify({ ok: false, error: "no_tenant_pbx_link", tenantId }));
    return { totalInserted: 0, totalPresent: 0, totalSkippedOrig: 0, totalErrors: 0 };
  }

  const vitalTid = String(link.pbxTenantId || "").trim();
  const helperCfg = vitalTid ? resolvePbxRouteHelperConfig(link.pbxInstanceId) : null;
  if (!helperCfg || !vitalTid) {
    console.log(JSON.stringify({ ok: false, error: "missing_pbx_tenant_id_or_helper", tenantId, vitalTid }));
    return { totalInserted: 0, totalPresent: 0, totalSkippedOrig: 0, totalErrors: 0 };
  }

  const extensions = await db.extension.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      ...(extension ? { extNumber: extension } : {}),
    },
    include: { pbxLink: true },
  });

  for (const ext of extensions) {
    const pbxExtId = ext.pbxLink?.pbxExtensionId;
    if (!pbxExtId) {
      console.log(JSON.stringify({ extension: ext.extNumber, skipped: "no_pbx_extension_link" }));
      continue;
    }

    let inserted = 0;
    let alreadyPresent = 0;
    let skippedInvalidOrigtime = 0;
    let upsertErrors = 0;

    let spoolMessageCount = 0;
    try {
      const spoolPageSize = Math.max(100, Number(process.env.VOICEMAIL_HELPER_SPOOL_PAGE_SIZE || 2000) || 2000);
      const spoolTimeoutMs = Math.max(5000, Number(process.env.VOICEMAIL_HELPER_SPOOL_FETCH_TIMEOUT_MS || 20000) || 20000);
      const spool = await fetchAllVoicemailSpoolMessages(
        helperCfg,
        { tenantId: vitalTid, extension: ext.extNumber },
        { pageSize: spoolPageSize, timeoutMs: spoolTimeoutMs },
      );
      spoolMessageCount = (spool.messages || []).length;
      if (!spool.paginationComplete) {
        console.log(
          JSON.stringify({
            extension: ext.extNumber,
            warn: "helper_spool_pagination_incomplete",
            pagesFetched: spool.pagesFetched,
            totalCount: spool.totalCount,
          }),
        );
      }
      const mapped = (spool.messages || []).map(mapHelperVoicemailSpoolToRecordShape);

      for (const rec of mapped) {
        const origtime = String(rec.date ?? rec.origtime ?? rec.orig_time ?? "");
        if (!origtime || origtime === "0") {
          skippedInvalidOrigtime++;
          continue;
        }
        const rawCallerid = String(rec.clid ?? rec.callerid ?? rec.caller_id ?? "");
        const callerNumber = vmExtractCallerNumber(rawCallerid) || null;
        const callerName = vmExtractCallerName(rawCallerid) || null;
        const callerDigits = (callerNumber ?? "").slice(-10);
        const rawFolder = String(rec.folder ?? "INBOX");
        const folder = vmNormalizeFolder(rawFolder);
        const listened = folder !== "inbox";
        const msgId = vmStablePbxMessageId({
          msgId: rec.msg_id,
          pbxTenantIdOrTenantCuid: String(link.pbxTenantId || link.tenantId),
          extNumber: ext.extNumber,
          origtime,
          callerDigits,
        });

        const existing = await db.voicemail.findUnique({ where: { pbxMessageId: msgId } });
        const filename = String(rec.filename ?? "");
        const recfile = String(rec.recfile ?? "");
        const fromFilename = filename.replace(/\.[^.]+$/, "");
        const fromRecfile = recfile ? (recfile.split("/").pop() ?? "").replace(/\.[^.]+$/, "") : "";
        const pbxMsgNum = String(rec.msg_num ?? rec.msgnum ?? rec.id ?? fromFilename ?? fromRecfile ?? "");

        await db.voicemail.upsert({
          where: { pbxMessageId: msgId },
          create: {
            pbxMessageId: msgId,
            tenantId: link.tenantId,
            extension: ext.extNumber,
            pbxExtensionId: pbxExtId,
            callerNumber,
            callerName,
            durationSec: parseInt(String(rec.duration ?? "0"), 10) || 0,
            folder,
            pbxFolder: rawFolder,
            pbxMsgNum,
            pbxRecfile: recfile || null,
            listened,
            receivedAt: new Date(parseInt(origtime, 10) * 1000),
          },
          update: {
            folder,
            pbxFolder: rawFolder,
            pbxMsgNum,
            ...(recfile ? { pbxRecfile: recfile } : {}),
            callerNumber,
            callerName,
            listened,
          },
        });

        if (existing) alreadyPresent++;
        else inserted++;
      }
    } catch (e: unknown) {
      upsertErrors++;
      console.log(
        JSON.stringify({
          extension: ext.extNumber,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }

    totalInserted += inserted;
    totalPresent += alreadyPresent;
    totalSkippedOrig += skippedInvalidOrigtime;
    totalErrors += upsertErrors;

    console.log(
      JSON.stringify({
        msg: "voicemail-spool-backfill-ext",
        tenantId,
        pbxTenantId: vitalTid,
        pbxTenantCode: link.pbxTenantCode ?? null,
        extension: ext.extNumber,
        spool_messages: spoolMessageCount,
        inserted,
        already_present: alreadyPresent,
        skipped_invalid_origtime: skippedInvalidOrigtime,
        errors: upsertErrors,
      }),
    );
  }

  console.log(
    JSON.stringify({
      msg: "voicemail-spool-backfill-tenant-done",
      tenantId,
      total_inserted: totalInserted,
      total_already_present: totalPresent,
      total_skipped_invalid_origtime: totalSkippedOrig,
      total_errors: totalErrors,
    }),
  );

  return {
    totalInserted,
    totalPresent,
    totalSkippedOrig,
    totalErrors,
  };
}

async function main(): Promise<void> {
  const { mode, extension } = parseArgs();
  if (!mode) {
    console.error(
      "Usage: pnpm exec tsx src/scripts/voicemail-spool-backfill.ts (--tenant=<cuid> | --all-tenants | --tenant-ids-file=/path) [--extension=<ext>]",
    );
    process.exit(2);
  }

  const tenantIds = await resolveTenantIds(mode);

  let grandInserted = 0;
  let grandPresent = 0;
  let grandSkippedOrig = 0;
  let grandErrors = 0;

  for (const tenantId of tenantIds) {
    const t = await backfillOneTenant(tenantId, extension);
    grandInserted += t.totalInserted;
    grandPresent += t.totalPresent;
    grandSkippedOrig += t.totalSkippedOrig;
    grandErrors += t.totalErrors;
  }

  console.log(
    JSON.stringify({
      msg: "voicemail-spool-backfill-done",
      tenants_processed: tenantIds.length,
      total_inserted: grandInserted,
      total_already_present: grandPresent,
      total_skipped_invalid_origtime: grandSkippedOrig,
      total_errors: grandErrors,
    }),
  );

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
