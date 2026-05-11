/**
 * PBX helper spool list → Voicemail rows (shared by backfill script and scheduled reconcile).
 */
import { db } from "@connect/db";
import {
  fetchAllVoicemailSpoolMessages,
  type PbxRouteHelperConfig,
  type VoicemailSpoolListMergedResponse,
} from "@connect/integrations";
import {
  mapHelperVoicemailSpoolToRecordShape,
  vmExtractCallerName,
  vmExtractCallerNumber,
  vmNormalizeFolder,
  vmStablePbxMessageId,
} from "@connect/shared";

export type TenantLinkShape = {
  tenantId: string;
  pbxTenantId: string | null;
};

function isPrismaUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002";
}

function buildPbxFolderMaxAndNewestFromMapped(
  mapped: ReturnType<typeof mapHelperVoicemailSpoolToRecordShape>[],
): { pbxFolderMax: Record<string, number>; newestPbxSec: number | null } {
  let newestPbxSec: number | null = null;
  const pbxFolderMax: Record<string, number> = {};
  for (const rec of mapped) {
    const ot = String(rec.date ?? rec.origtime ?? rec.orig_time ?? "");
    const sec = parseInt(ot, 10);
    if (!ot || ot === "0" || !sec) continue;
    newestPbxSec = newestPbxSec == null ? sec : Math.max(newestPbxSec, sec);
    const folder = String(rec.folder ?? "INBOX").toLowerCase();
    pbxFolderMax[folder] = Math.max(pbxFolderMax[folder] ?? 0, sec);
  }
  return { pbxFolderMax, newestPbxSec };
}

export type MailboxSpoolApplyResult = {
  spoolMessageCount: number;
  inserted: number;
  alreadyPresent: number;
  skippedInvalidOrigtime: number;
  errors: number;
  spool: VoicemailSpoolListMergedResponse;
  pbxFolderMaxOrigtimeSec: Record<string, number>;
  newestPbxSec: number | null;
};

/**
 * Fetches full spool via schema-2 pagination when available, then creates missing rows and/or upserts.
 */
export async function fetchSpoolAndApplyVoicemails(
  link: TenantLinkShape,
  extNumber: string,
  pbxExtId: string,
  helperCfg: PbxRouteHelperConfig,
  vitalTid: string,
  opts: {
    dryRun: boolean;
    mode: "insert_only" | "upsert";
    pageSize?: number;
    timeoutMs?: number;
    maxPages?: number;
  },
): Promise<MailboxSpoolApplyResult> {
  const spoolPageSize =
    opts.pageSize ?? Math.max(100, Number(process.env.VOICEMAIL_HELPER_SPOOL_PAGE_SIZE || 2000) || 2000);
  const spoolTimeoutMs =
    opts.timeoutMs ?? Math.max(5000, Number(process.env.VOICEMAIL_HELPER_SPOOL_FETCH_TIMEOUT_MS || 20000) || 20000);
  const spool = await fetchAllVoicemailSpoolMessages(
    helperCfg,
    { tenantId: vitalTid, extension: extNumber },
    { pageSize: spoolPageSize, timeoutMs: spoolTimeoutMs, maxPages: opts.maxPages },
  );
  const messages = spool.messages || [];
  const mapped = messages.map(mapHelperVoicemailSpoolToRecordShape);
  const { pbxFolderMax, newestPbxSec: walkNewest } = buildPbxFolderMaxAndNewestFromMapped(mapped);

  let mergedNewest = walkNewest;
  if (spool.maxOrigtimeAll != null && String(spool.maxOrigtimeAll) !== "") {
    const mall = parseInt(String(spool.maxOrigtimeAll), 10);
    if (mall > 0) {
      mergedNewest = mergedNewest == null ? mall : Math.max(mergedNewest, mall);
    }
  }

  let inserted = 0;
  let alreadyPresent = 0;
  let skippedInvalidOrigtime = 0;
  let errors = 0;

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
      extNumber,
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

    if (opts.mode === "insert_only") {
      if (existing) {
        alreadyPresent++;
        continue;
      }
      try {
        await db.voicemail.create({
          data: {
            pbxMessageId: msgId,
            tenantId: link.tenantId,
            extension: extNumber,
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
      } catch (e: unknown) {
        if (isPrismaUniqueViolation(e)) {
          alreadyPresent++;
        } else {
          errors++;
        }
      }
      continue;
    }

    try {
      await db.voicemail.upsert({
        where: { pbxMessageId: msgId },
        create: {
          pbxMessageId: msgId,
          tenantId: link.tenantId,
          extension: extNumber,
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
    } catch (e: unknown) {
      errors++;
    }
  }

  return {
    spoolMessageCount: messages.length,
    inserted,
    alreadyPresent,
    skippedInvalidOrigtime,
    errors,
    spool,
    pbxFolderMaxOrigtimeSec: pbxFolderMax,
    newestPbxSec: mergedNewest,
  };
}
