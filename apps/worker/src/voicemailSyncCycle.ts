import {
  classifyHelperFailure,
  db,
  helperBaseHostFromUrl,
  recordHelperIncident,
  recordRestVsSpoolDiverge,
  recordWorkerSyncGlobalZero,
  resolveHelperIncidentsForPbx,
  resolveRestVsSpoolDiverge,
  resolveWorkerSyncGlobalZero,
} from "@connect/db";
import { decryptJson } from "@connect/security";
import {
  VitalPbxClient,
  fetchAllVoicemailSpoolMessages,
  resolvePbxRouteHelperConfig,
} from "@connect/integrations";
import {
  interleaveVoicemailHelperSlots,
  mapHelperVoicemailSpoolToRecordShape,
  selectDistinctFairHelperPicks,
  vmExtractCallerName,
  vmExtractCallerNumber,
  vmNormalizeFolder,
  vmStablePbxMessageId,
  type VoicemailHelperFairSlot,
} from "@connect/shared";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getVitalPbxClientForWorker(input: { baseUrl: string; token: string; secret?: string | null }) {
  return new VitalPbxClient({
    baseUrl: input.baseUrl,
    apiToken: input.token,
    apiSecret: input.secret || undefined,
    timeoutMs: Number(process.env.PBX_TIMEOUT_MS || 10000),
  });
}

let _voicemailSyncRunning = false;
let _vmWorkerSyncZeroStreak = 0;
/** Rotating index into the interleaved needy-mailbox ring (fair helper scheduling). */
let _vmFairHelperScheduleCursor = 0;

type VmExtWork = VoicemailHelperFairSlot & {
  link: any;
  ext: any;
  pbx: VitalPbxClient;
  pbxExtId: string;
  restRecords: any[];
  restError: string | null;
  mergedRecords: any[];
  helperCalled: boolean;
  helperError: string | null;
  helperMessageCount: number;
  /** True when fetchAllVoicemailSpoolMessages hit maxPages before helper cleared truncated */
  spoolPaginationIncomplete: boolean;
  scheduledFairHelper: boolean;
};

function slotKey(s: VmExtWork): string {
  return `${s.link.tenantId}:${s.ext.extNumber}`;
}

export async function runVoicemailSyncCycle(): Promise<void> {
  if (_voicemailSyncRunning) return;
  _voicemailSyncRunning = true;
  try {
    const links: any[] = await db.tenantPbxLink.findMany({
      where: { pbxInstance: { isEnabled: true } } as any,
      include: { pbxInstance: true } as any,
    } as any);

    if (links.length === 0) return;

    const maxHelperFallback = Math.max(0, Number(process.env.VOICEMAIL_HELPER_FALLBACK_MAX_PER_CYCLE || 32) || 0);
    const helperMinIntervalMs = Math.max(0, Number(process.env.VOICEMAIL_HELPER_MIN_INTERVAL_MS || 200) || 0);
    let lastHelperCallAt = 0;
    const helperResolvedPbxIds = new Set<string>();

    const allSlots: VmExtWork[] = [];
    let totalExts = 0;
    let cycleRestRecords = 0;
    let totalErrors = 0;

    for (const link of links) {
      if (!link?.pbxInstance) continue;
      try {
        const auth = decryptJson<{ token: string; secret?: string | null }>(link.pbxInstance.apiAuthEncrypted);
        const pbx = getVitalPbxClientForWorker({
          baseUrl: link.pbxInstance.baseUrl,
          token: auth.token,
          secret: auth.secret || null,
        });

        const extensions: any[] = await db.extension.findMany({
          where: { tenantId: link.tenantId, status: "ACTIVE" } as any,
          include: { pbxLink: true } as any,
        } as any);

        for (const ext of extensions) {
          const pbxExtId: string | undefined = ext.pbxLink?.pbxExtensionId;
          if (!pbxExtId) continue;
          totalExts++;

          let restRecords: any[] = [];
          let restError: string | null = null;
          try {
            restRecords = await pbx.getExtensionVoicemailRecords(pbxExtId, link.pbxTenantId || undefined);
          } catch (e: any) {
            restError = String(e?.message || e || "rest_error");
          }
          cycleRestRecords += restRecords.length;

          allSlots.push({
            tenantId: link.tenantId,
            extNumber: ext.extNumber,
            link,
            ext,
            pbx,
            pbxExtId,
            restRecords,
            restError,
            mergedRecords: restRecords,
            helperCalled: false,
            helperError: null,
            helperMessageCount: 0,
            spoolPaginationIncomplete: false,
            scheduledFairHelper: false,
          });
        }
      } catch (tenantErr: any) {
        totalErrors++;
        console.error(`voicemail sync tenant ${link.tenantId}: ${tenantErr?.message}`);
      }
    }

    const needyByTenant = new Map<string, VmExtWork[]>();
    for (const slot of allSlots) {
      if (slot.restRecords.length > 0) continue;
      const tid = String(slot.link.pbxTenantId || "").trim();
      const helperCfg = tid ? resolvePbxRouteHelperConfig(slot.link.pbxInstanceId) : null;
      if (!helperCfg || !tid) continue;
      const arr = needyByTenant.get(slot.tenantId) ?? [];
      arr.push(slot);
      needyByTenant.set(slot.tenantId, arr);
    }

    const interleavedNeedy = interleaveVoicemailHelperSlots(needyByTenant);
    const needyTotal = interleavedNeedy.length;
    const { picks: fairPicks, nextStartIndex } = selectDistinctFairHelperPicks(
      interleavedNeedy,
      maxHelperFallback,
      _vmFairHelperScheduleCursor,
      slotKey,
    );
    _vmFairHelperScheduleCursor = nextStartIndex;

    const pickSet = new Set(fairPicks.map(slotKey));
    for (const slot of allSlots) {
      if (slot.restRecords.length > 0) continue;
      const tid = String(slot.link.pbxTenantId || "").trim();
      const helperCfg = tid ? resolvePbxRouteHelperConfig(slot.link.pbxInstanceId) : null;
      if (!helperCfg || !tid) continue;
      slot.scheduledFairHelper = pickSet.has(slotKey(slot));
    }

    let cycleHelperCalls = 0;
    let cycleHelperMessages = 0;

    for (const slot of fairPicks) {
      const tid = String(slot.link.pbxTenantId || "").trim();
      const helperCfg = resolvePbxRouteHelperConfig(slot.link.pbxInstanceId);
      if (!helperCfg || !tid) continue;

      if (helperMinIntervalMs > 0 && lastHelperCallAt > 0) {
        const wait = helperMinIntervalMs - (Date.now() - lastHelperCallAt);
        if (wait > 0) await sleep(wait);
      }

      try {
        const spoolPageSize = Math.max(100, Number(process.env.VOICEMAIL_HELPER_SPOOL_PAGE_SIZE || 2000) || 2000);
        const spoolTimeoutMs = Math.max(5000, Number(process.env.VOICEMAIL_HELPER_SPOOL_FETCH_TIMEOUT_MS || 20000) || 20000);
        const spool = await fetchAllVoicemailSpoolMessages(
          helperCfg,
          {
            tenantId: tid,
            extension: slot.ext.extNumber,
          },
          { pageSize: spoolPageSize, timeoutMs: spoolTimeoutMs },
        );
        cycleHelperCalls += 1;
        lastHelperCallAt = Date.now();
        slot.helperCalled = true;
        if (!spool.paginationComplete) {
          slot.helperError = (slot.helperError ? slot.helperError + "; " : "") + "helper_spool_pagination_incomplete";
        }
        const mapped = (spool.messages || []).map(mapHelperVoicemailSpoolToRecordShape);
        slot.helperMessageCount = mapped.length;
        cycleHelperMessages += mapped.length;
        if (mapped.length > 0) {
          slot.mergedRecords = mapped;
        }
        if (!helperResolvedPbxIds.has(slot.link.pbxInstanceId)) {
          helperResolvedPbxIds.add(slot.link.pbxInstanceId);
          try {
            await resolveHelperIncidentsForPbx(db, slot.link.pbxInstanceId);
          } catch {
            /* ignore */
          }
        }
      } catch (helperErr: any) {
        slot.helperError = String(helperErr?.message || helperErr || "helper_error");
        const kind = classifyHelperFailure(helperErr);
        if (
          kind === "HELPER_ROUTE_MISSING" ||
          kind === "HELPER_SECRET_MISMATCH" ||
          kind === "HELPER_UNREACHABLE"
        ) {
          try {
            await recordHelperIncident(db, {
              scenario: kind,
              pbxInstanceId: slot.link.pbxInstanceId,
              tenantId: slot.link.tenantId,
              metadata: {
                mailbox: slot.ext.extNumber,
                httpStatus: helperErr?.httpStatus,
                helperBaseHost: helperBaseHostFromUrl(helperCfg.baseUrl),
              },
            });
          } catch {
            /* ignore */
          }
        }
      }
    }

    let totalRecords = 0;
    let totalUpserts = 0;
    const extJsonLogs = (process.env.VOICEMAIL_SYNC_EXT_JSON_LOGS || "true").toLowerCase() !== "false";

    for (const slot of allSlots) {
      const link = slot.link;
      const ext = slot.ext;
      const pbxExtId = slot.pbxExtId;
      const records = slot.mergedRecords;
      totalRecords += records.length;

      let upsertsThisExt = 0;
      let skippedOrigThisSlot = 0;

      let upsertException: string | null = null;
      try {
        for (const rec of records) {
          const origtime = String(rec.date ?? rec.origtime ?? rec.orig_time ?? "");
          if (!origtime || origtime === "0") {
            skippedOrigThisSlot++;
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
          const filename = String(rec.filename ?? "");
          const recfile = String(rec.recfile ?? "");
          const fromFilename = filename.replace(/\.[^.]+$/, "");
          const fromRecfile = recfile ? (recfile.split("/").pop() ?? "").replace(/\.[^.]+$/, "") : "";
          const pbxMsgNum = String(rec.msg_num ?? rec.msgnum ?? rec.id ?? fromFilename ?? fromRecfile ?? "");

          totalUpserts++;
          upsertsThisExt++;
          await (db as any).voicemail.upsert({
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
        }

        const usedHelperForExt =
          slot.helperCalled && slot.restRecords.length === 0 && slot.mergedRecords.length > 0;
        if (usedHelperForExt && upsertsThisExt === 0) {
          try {
            await recordRestVsSpoolDiverge(db, {
              tenantId: link.tenantId,
              mailbox: ext.extNumber,
              source: "worker_sync",
            });
          } catch {
            /* ignore */
          }
        } else if (usedHelperForExt && upsertsThisExt > 0) {
          try {
            await resolveRestVsSpoolDiverge(db, {
              tenantId: link.tenantId,
              mailbox: ext.extNumber,
              source: "worker_sync",
            });
          } catch {
            /* ignore */
          }
        }

      } catch (extErr: any) {
        totalErrors++;
        upsertException = String(extErr?.message || extErr || "error").slice(0, 200);
        console.warn(`voicemail sync ext ${ext.extNumber} (tenant ${link.tenantId}): ${extErr?.message}`);
      }

      const tid = String(link.pbxTenantId || "").trim();
      const helperCfgPresent = Boolean(tid && resolvePbxRouteHelperConfig(link.pbxInstanceId));

      let skippedReason: string;
      if (upsertException) {
        skippedReason = `upsert_exception:${upsertException}`;
      } else if (upsertsThisExt > 0) {
        skippedReason = "ok";
      } else if (records.length > 0 && skippedOrigThisSlot > 0 && upsertsThisExt === 0) {
        skippedReason = "all_records_skipped_invalid_origtime";
      } else if (slot.restRecords.length > 0) {
        skippedReason = "rest_returned_no_valid_rows";
      } else if (slot.restError) {
        skippedReason = `rest_error:${slot.restError.slice(0, 120)}`;
      } else if (!tid) {
        skippedReason = "missing_pbx_tenant_id";
      } else if (!helperCfgPresent) {
        skippedReason = "missing_helper_config";
      } else if (!slot.scheduledFairHelper) {
        skippedReason = "helper_not_scheduled_this_cycle";
      } else if (slot.helperError) {
        skippedReason = `helper_error:${slot.helperError.slice(0, 120)}`;
      } else if (!slot.helperCalled) {
        skippedReason = "helper_not_called";
      } else if (slot.helperMessageCount === 0) {
        skippedReason = "spool_empty";
      } else {
        skippedReason = "no_upserts_after_helper";
      }

      if (extJsonLogs) {
        const perExtLog = {
          msg: "voicemail-sync-ext",
          tenantId: link.tenantId,
          pbxTenantId: link.pbxTenantId ?? null,
          pbxTenantCode: link.pbxTenantCode ?? null,
          extension: ext.extNumber,
          rest_count: slot.restRecords.length,
          rest_fetch_error: slot.restError,
          helper_scheduled: slot.scheduledFairHelper,
          helper_called: slot.helperCalled,
          helper_message_count: slot.helperMessageCount,
          spool_pagination_incomplete: slot.spoolPaginationIncomplete,
          merged_record_count: records.length,
          upsert_attempts: upsertsThisExt,
          skipped_invalid_origtime: skippedOrigThisSlot,
          skipped_reason: skippedReason,
          fair_needy_total: needyTotal,
          fair_budget_per_cycle: maxHelperFallback,
          fair_cursor_next: _vmFairHelperScheduleCursor,
        };
        console.log(JSON.stringify(perExtLog));
      }
    }

    const source_used =
      cycleHelperCalls > 0 ? (cycleRestRecords > 0 ? "rest+helper" : "helper") : "rest";
    const fallback_reason =
      cycleHelperCalls > 0 ? "rest_empty_used_spool_fallback_fair_schedule" : null;

    if (links.length > 0 && totalExts > 0 && totalRecords === 0 && totalErrors === 0) {
      _vmWorkerSyncZeroStreak += 1;
    } else {
      _vmWorkerSyncZeroStreak = 0;
    }
    if (links.length === 0 || totalExts === 0 || totalRecords > 0) {
      try {
        await resolveWorkerSyncGlobalZero(db);
      } catch {
        /* ignore */
      }
    }
    if (_vmWorkerSyncZeroStreak >= 3) {
      try {
        await recordWorkerSyncGlobalZero(db);
      } catch {
        /* ignore */
      }
    }

    console.log(
      JSON.stringify({
        msg: "voicemail-sync-cycle",
        links: links.length,
        extsChecked: totalExts,
        records: totalRecords,
        upserts: totalUpserts,
        errors: totalErrors,
        rest_count: cycleRestRecords,
        helper_count: cycleHelperMessages,
        helper_calls: cycleHelperCalls,
        source_used,
        upserted_count: totalUpserts,
        fallback_reason,
        worker_sync_zero_streak: _vmWorkerSyncZeroStreak,
        fair_needy_mailboxes: needyTotal,
        fair_helper_picks: fairPicks.length,
        fair_budget_per_cycle: maxHelperFallback,
        fair_cursor: _vmFairHelperScheduleCursor,
      }),
    );
  } finally {
    _voicemailSyncRunning = false;
  }
}
