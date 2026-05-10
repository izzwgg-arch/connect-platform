/**
 * Idempotent PBX spool → Connect Voicemail upsert (read-only on PBX).
 *
 * Run inside the worker container (same env as worker):
 *   cd /app/apps/worker && pnpm exec tsx src/scripts/voicemail-spool-backfill.ts --tenant=<connectTenantCuid> [--extension=<extNumber>]
 *
 * Logs JSON per extension: inserted, already_present, skipped_invalid_origtime, errors.
 */
import { db } from "@connect/db";
import { listVoicemailSpoolFromHelper, resolvePbxRouteHelperConfig } from "@connect/integrations";
import {
  mapHelperVoicemailSpoolToRecordShape,
  vmExtractCallerName,
  vmExtractCallerNumber,
  vmNormalizeFolder,
  vmStablePbxMessageId,
} from "@connect/shared";

function parseArgs(): { tenantId: string | null; extension: string | null } {
  let tenantId: string | null = null;
  let extension: string | null = null;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--tenant=")) tenantId = a.slice("--tenant=".length).trim() || null;
    if (a.startsWith("--extension=")) extension = a.slice("--extension=".length).trim() || null;
  }
  return { tenantId, extension };
}

async function main(): Promise<void> {
  const { tenantId, extension } = parseArgs();
  if (!tenantId) {
    console.error(
      "Usage: pnpm exec tsx src/scripts/voicemail-spool-backfill.ts --tenant=<connectTenantCuid> [--extension=<extNumber>]",
    );
    process.exit(2);
  }

  const link = await db.tenantPbxLink.findUnique({
    where: { tenantId },
    include: { pbxInstance: true },
  });
  if (!link?.pbxInstance) {
    console.log(JSON.stringify({ ok: false, error: "no_tenant_pbx_link", tenantId }));
    process.exit(1);
  }

  const vitalTid = String(link.pbxTenantId || "").trim();
  const helperCfg = vitalTid ? resolvePbxRouteHelperConfig(link.pbxInstanceId) : null;
  if (!helperCfg || !vitalTid) {
    console.log(JSON.stringify({ ok: false, error: "missing_pbx_tenant_id_or_helper", tenantId, vitalTid }));
    process.exit(1);
  }

  const extensions = await db.extension.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      ...(extension ? { extNumber: extension } : {}),
    },
    include: { pbxLink: true },
  });

  let totalInserted = 0;
  let totalPresent = 0;
  let totalSkippedOrig = 0;

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
      const spool = await listVoicemailSpoolFromHelper(helperCfg, {
        tenantId: vitalTid,
        extension: ext.extNumber,
      });
      spoolMessageCount = (spool.messages || []).length;
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
        upsert_errors: upsertErrors,
      }),
    );
  }

  console.log(
    JSON.stringify({
      msg: "voicemail-spool-backfill-done",
      tenantId,
      total_inserted: totalInserted,
      total_already_present: totalPresent,
      total_skipped_invalid_origtime: totalSkippedOrig,
    }),
  );

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
