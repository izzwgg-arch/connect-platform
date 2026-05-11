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
 * Options:
 *   --dry-run                          Fetch + count only; no DB writes
 *   --insert-only                      Skip updates to existing Voicemail rows (create missing only)
 *   --mailbox-delay-ms=N               Pause N ms after each mailbox (rate-limit helper)
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

type BackfillOptions = {
  dryRun: boolean;
  insertOnly: boolean;
  mailboxDelayMs: number;
};

function parseArgs(): { mode: BackfillMode | null; extension: string | null; opts: BackfillOptions } {
  let extension: string | null = null;
  let singleTenant: string | null = null;
  let allTenants = false;
  let tenantIdsFile: string | null = null;
  let dryRun = false;
  let insertOnly = false;
  let mailboxDelayMs = 0;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--tenant=")) singleTenant = a.slice("--tenant=".length).trim() || null;
    if (a === "--all-tenants") allTenants = true;
    if (a.startsWith("--tenant-ids-file=")) tenantIdsFile = a.slice("--tenant-ids-file=".length).trim() || null;
    if (a.startsWith("--extension=")) extension = a.slice("--extension=".length).trim() || null;
    if (a === "--dry-run") dryRun = true;
    if (a === "--insert-only") insertOnly = true;
    if (a.startsWith("--mailbox-delay-ms=")) mailboxDelayMs = Math.max(0, parseInt(a.slice("--mailbox-delay-ms=".length), 10) || 0);
  }

  const modes = [singleTenant, allTenants, tenantIdsFile].filter(Boolean).length;
  if (modes !== 1) {
    return { mode: null, extension, opts: { dryRun, insertOnly, mailboxDelayMs } };
  }
  const opts = { dryRun, insertOnly, mailboxDelayMs };
  if (singleTenant) return { mode: { kind: "single", tenantId: singleTenant }, extension, opts };
  if (allTenants) return { mode: { kind: "all" }, extension, opts };
  return { mode: { kind: "file", path: tenantIdsFile! }, extension, opts };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

type TenantBackfillResult = {
  totalInserted: number;
  totalPresent: number;
  totalSkippedOrig: number;
  totalErrors: number;
  mailboxesProcessed: number;
  spoolMessagesSum: number;
  paginationIncompleteExts: string[];
  helperErrorExts: { extension: string; error: string }[];
  extInserted: { extension: string; inserted: number }[];
  tenantSkipReason: string | null;
};

async function backfillOneTenant(
  tenantId: string,
  extension: string | null,
  opts: BackfillOptions,
): Promise<TenantBackfillResult> {
  let totalInserted = 0;
  let totalPresent = 0;
  let totalSkippedOrig = 0;
  let totalErrors = 0;
  let mailboxesProcessed = 0;
  let spoolMessagesSum = 0;
  const paginationIncompleteExts: string[] = [];
  const helperErrorExts: { extension: string; error: string }[] = [];
  const extInserted: { extension: string; inserted: number }[] = [];

  const link = await db.tenantPbxLink.findUnique({
    where: { tenantId },
    include: { pbxInstance: true },
  });
  if (!link?.pbxInstance) {
    console.log(JSON.stringify({ ok: false, error: "no_tenant_pbx_link", tenantId }));
    return {
      totalInserted: 0,
      totalPresent: 0,
      totalSkippedOrig: 0,
      totalErrors: 0,
      mailboxesProcessed: 0,
      spoolMessagesSum: 0,
      paginationIncompleteExts: [],
      helperErrorExts: [],
      extInserted: [],
      tenantSkipReason: "no_tenant_pbx_link",
    };
  }

  const vitalTid = String(link.pbxTenantId || "").trim();
  const helperCfg = vitalTid ? resolvePbxRouteHelperConfig(link.pbxInstanceId) : null;
  if (!helperCfg || !vitalTid) {
    console.log(JSON.stringify({ ok: false, error: "missing_pbx_tenant_id_or_helper", tenantId, vitalTid }));
    return {
      totalInserted: 0,
      totalPresent: 0,
      totalSkippedOrig: 0,
      totalErrors: 0,
      mailboxesProcessed: 0,
      spoolMessagesSum: 0,
      paginationIncompleteExts: [],
      helperErrorExts: [],
      extInserted: [],
      tenantSkipReason: "missing_pbx_tenant_id_or_helper",
    };
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

    mailboxesProcessed++;
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
      spoolMessagesSum += spoolMessageCount;
      if (!spool.paginationComplete) {
        paginationIncompleteExts.push(ext.extNumber);
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

        if (opts.dryRun) {
          if (existing) alreadyPresent++;
          else inserted++;
          continue;
        }

        if (opts.insertOnly) {
          if (existing) {
            alreadyPresent++;
            continue;
          }
          await db.voicemail.create({
            data: {
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
          });
          inserted++;
          continue;
        }

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
      const errStr = e instanceof Error ? e.message : String(e);
      helperErrorExts.push({ extension: ext.extNumber, error: errStr });
      console.log(JSON.stringify({ extension: ext.extNumber, error: errStr }));
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
        dry_run: opts.dryRun,
        insert_only: opts.insertOnly,
        spool_messages: spoolMessageCount,
        inserted,
        already_present: alreadyPresent,
        skipped_invalid_origtime: skippedInvalidOrigtime,
        errors: upsertErrors,
      }),
    );
    extInserted.push({ extension: ext.extNumber, inserted });

    if (opts.mailboxDelayMs > 0) {
      await sleep(opts.mailboxDelayMs);
    }
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
    mailboxesProcessed,
    spoolMessagesSum,
    paginationIncompleteExts,
    helperErrorExts,
    extInserted,
    tenantSkipReason: null,
  };
}

async function main(): Promise<void> {
  const { mode, extension, opts } = parseArgs();
  if (!mode) {
    console.error(
      "Usage: pnpm exec tsx src/scripts/voicemail-spool-backfill.ts (--tenant=<cuid> | --all-tenants | --tenant-ids-file=/path) [--extension=<ext>] [--dry-run] [--insert-only] [--mailbox-delay-ms=N]",
    );
    process.exit(2);
  }

  const tenantIds = await resolveTenantIds(mode);
  const tenantsMeta = await db.tenant.findMany({
    where: { id: { in: tenantIds } },
    select: { id: true, name: true },
  });
  const tenantNameById = Object.fromEntries(tenantsMeta.map((x) => [x.id, x.name ?? null]));

  let grandInserted = 0;
  let grandPresent = 0;
  let grandSkippedOrig = 0;
  let grandErrors = 0;
  let grandMailboxes = 0;
  let grandSpoolMsgs = 0;
  const paginationPairs: { tenantId: string; extension: string }[] = [];
  const helperErrRows: { tenantId: string; extension: string; error: string }[] = [];
  const insertedRank: { tenantId: string; tenantName: string | null; extension: string; inserted: number }[] = [];
  const tenantsSkipped: { tenantId: string; tenant_name: string | null; reason: string }[] = [];

  for (let i = 0; i < tenantIds.length; i++) {
    const tenantId = tenantIds[i]!;
    console.log(
      JSON.stringify({
        msg: "voicemail-spool-backfill-tenant-start",
        tenant_index: i + 1,
        tenants_total: tenantIds.length,
        tenantId,
        tenant_name: tenantNameById[tenantId] ?? null,
        dry_run: opts.dryRun,
        insert_only: opts.insertOnly,
      }),
    );
    const t = await backfillOneTenant(tenantId, extension, opts);
    if (t.tenantSkipReason) {
      tenantsSkipped.push({
        tenantId,
        tenant_name: tenantNameById[tenantId] ?? null,
        reason: t.tenantSkipReason,
      });
    }
    grandInserted += t.totalInserted;
    grandPresent += t.totalPresent;
    grandSkippedOrig += t.totalSkippedOrig;
    grandErrors += t.totalErrors;
    grandMailboxes += t.mailboxesProcessed;
    grandSpoolMsgs += t.spoolMessagesSum;
    for (const extn of t.paginationIncompleteExts) {
      paginationPairs.push({ tenantId, extension: extn });
    }
    for (const h of t.helperErrorExts) {
      helperErrRows.push({ tenantId, extension: h.extension, error: h.error });
    }
    const tname = tenantNameById[tenantId] ?? null;
    for (const row of t.extInserted) {
      if (row.inserted > 0) {
        insertedRank.push({ tenantId, tenantName: tname, extension: row.extension, inserted: row.inserted });
      }
    }
  }

  insertedRank.sort((a, b) => b.inserted - a.inserted);

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

  console.log(
    JSON.stringify({
      msg: "voicemail-spool-backfill-fleet-summary",
      dry_run: opts.dryRun,
      insert_only: opts.insertOnly,
      mailbox_delay_ms: opts.mailboxDelayMs,
      tenants_scanned: tenantIds.length,
      mailboxes_scanned: grandMailboxes,
      total_spool_messages: grandSpoolMsgs,
      total_inserted: grandInserted,
      total_already_present: grandPresent,
      total_skipped_invalid_origtime: grandSkippedOrig,
      total_errors: grandErrors,
      top_mailboxes_by_inserted: insertedRank.slice(0, 20),
      mailboxes_pagination_incomplete: paginationPairs,
      mailboxes_helper_errors: helperErrRows,
      tenants_skipped: tenantsSkipped,
    }),
  );

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
