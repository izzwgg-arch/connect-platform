/**
 * Yiddish learning engine — register call recordings as `call_recordings`
 * source items, for Yiddish-speaking tenants only.
 *
 * WHY THIS EXISTS (§3.4.1, AGENT_HANDOFF_YIDDISH_WHISPER_FINETUNE_2026-09-17.md):
 * `internalIndexer.ts` COUNTS `ConnectCdr` rows for `call_recordings` (see the
 * `⛔⛔` rule at the top of that file: count and measure, never read) but never
 * turns any of them into a `YcSourceItem` the audio pipeline can claim. This
 * script is that missing step. It creates one item per qualifying call, in
 * state `QUEUED`, and lets `enqueueNext` — the same gate every other source
 * goes through — decide whether the rights/budget state currently lets any
 * audio stage run for it.
 *
 * IT NEVER READS AUDIO. It never opens `ConnectCdr.recordingPath`, never
 * touches `Voicemail.transcript` or any Yiddish Labs text. Only CDR metadata
 * (linkedId, recordingPath, talkSec, direction, startedAt) and `Tenant.name`
 * are read.
 *
 * "Yiddish-speaking tenant" = any tenant with at least one
 * `Voicemail.transcriptLanguage` of "yi" or "yi-en" — the same rule the rest
 * of the engine uses.
 *
 * Runs INSIDE the api container, exactly like yc-backfill-categories.ts:
 *
 *   docker exec -w /app/apps/api app-api-1 npx tsx scripts/yc-register-call-recordings.ts \
 *     [--tenant <name>] [--limit N] [--min-talk-sec N] [--dry-run]
 *
 * Without --dry-run this WRITES YcSourceItem rows and enqueues their next
 * stage. --dry-run only counts and prints — nothing is written.
 */
import { db } from "@connect/db";
import { enqueueNext } from "../src/yiddishCorpus/jobs";

export const CALL_RECORDINGS_SOURCE_KEY = "call_recordings";
export const DEFAULT_MIN_TALK_SEC = 20;

export interface RegisterOptions {
  /** Case-insensitive substring match on Tenant.name, like the other scripts here. */
  tenantName?: string | null;
  /** Cap the number of calls considered PER TENANT. */
  limit?: number | null;
  minTalkSec?: number;
  dryRun?: boolean;
  now?: Date;
}

export interface RegisterTenantSummary {
  tenantId: string;
  tenantName: string;
  candidates: number;
  registered: number;
  alreadyRegistered: number;
  hours: number;
}

export interface RegisterResult {
  tenants: RegisterTenantSummary[];
  totalRegistered: number;
  totalAlreadyRegistered: number;
  totalHours: number;
}

/** Tenants with at least one Yiddish (or mixed) voicemail transcript. Counts nothing else. */
async function yiddishTenantIds(dbc: any): Promise<Set<string>> {
  const rows = await dbc.voicemail.findMany({
    where: { transcriptLanguage: { in: ["yi", "yi-en"] }, tenantId: { not: null } },
    select: { tenantId: true },
  });
  return new Set((rows || []).map((r: any) => r.tenantId).filter(Boolean));
}

/**
 * Register qualifying call recordings for every Yiddish-speaking tenant (or
 * the one matched by `opts.tenantName`). Idempotent on `(sourceId, externalId
 * = ConnectCdr.linkedId)` — re-running this script never duplicates an item.
 */
export async function registerCallRecordings(dbc: any, opts: RegisterOptions = {}): Promise<RegisterResult> {
  const now = opts.now ?? new Date();
  const minTalkSec = Math.max(1, opts.minTalkSec ?? DEFAULT_MIN_TALK_SEC);
  const dryRun = opts.dryRun === true;

  const source = await dbc.ycSource.findUnique({ where: { key: CALL_RECORDINGS_SOURCE_KEY } });
  if (!source) {
    throw new Error(`source "${CALL_RECORDINGS_SOURCE_KEY}" is missing — run the internal reindex first`);
  }

  const yiddishTenants = await yiddishTenantIds(dbc);
  const out: RegisterResult = { tenants: [], totalRegistered: 0, totalAlreadyRegistered: 0, totalHours: 0 };
  if (!yiddishTenants.size) return out;

  let tenantRows: any[] = await dbc.tenant.findMany({ where: { id: { in: [...yiddishTenants] } } });
  if (opts.tenantName) {
    const needle = opts.tenantName.toLowerCase();
    tenantRows = tenantRows.filter((t: any) => String(t.name || "").toLowerCase().includes(needle));
  }

  let totalHoursSec = 0;

  for (const tenant of tenantRows) {
    const cdrs: any[] = await dbc.connectCdr.findMany({
      where: {
        tenantId: tenant.id,
        recordingPath: { not: null },
        recordingMissingAt: null,
        talkSec: { gte: minTalkSec },
      },
      orderBy: { startedAt: "asc" },
      take: opts.limit ?? undefined,
    });

    let registered = 0;
    let alreadyRegistered = 0;
    let secondsRegistered = 0;

    for (const cdr of cdrs) {
      const existing = await dbc.ycSourceItem
        .findUnique({ where: { sourceId_externalId: { sourceId: source.id, externalId: cdr.linkedId } } })
        .catch(() => null);
      if (existing) {
        alreadyRegistered += 1;
        continue;
      }

      secondsRegistered += Number(cdr.talkSec) || 0;
      registered += 1;
      if (dryRun) continue;

      const startedAt = cdr.startedAt instanceof Date ? cdr.startedAt.toISOString() : cdr.startedAt ?? null;
      const item = await dbc.ycSourceItem.create({
        data: {
          sourceId: source.id,
          externalId: cdr.linkedId,
          durationSec: cdr.talkSec ?? null,
          state: "QUEUED",
          fingerprint: `call_recordings:${cdr.linkedId}`,
          metadata: {
            tenantId: tenant.id,
            tenantName: tenant.name,
            pbxPath: cdr.recordingPath,
            direction: cdr.direction ?? null,
            startedAt,
            localAudioPath: `${cdr.linkedId}.wav`,
          },
        },
      });
      await enqueueNext(dbc, item, { sourceKey: CALL_RECORDINGS_SOURCE_KEY, now }).catch(() => {});
    }

    out.tenants.push({
      tenantId: tenant.id,
      tenantName: tenant.name,
      candidates: cdrs.length,
      registered,
      alreadyRegistered,
      hours: Math.round((secondsRegistered / 3600) * 10) / 10,
    });
    out.totalRegistered += registered;
    out.totalAlreadyRegistered += alreadyRegistered;
    totalHoursSec += secondsRegistered;
  }

  out.totalHours = Math.round((totalHoursSec / 3600) * 10) / 10;
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx === process.argv.length - 1) return null;
  return process.argv[idx + 1];
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const tenantName = argValue("--tenant");
  const limitArg = argValue("--limit");
  const minTalkArg = argValue("--min-talk-sec");

  console.log(
    `yc-register-call-recordings — ${new Date().toISOString()} — ${dryRun ? "dry run" : "APPLY"}` +
      (tenantName ? ` — tenant contains "${tenantName}"` : "") +
      (limitArg ? ` — limit ${limitArg}/tenant` : "") +
      (minTalkArg ? ` — min talk ${minTalkArg}s` : ""),
  );

  const result = await registerCallRecordings(db, {
    tenantName,
    limit: limitArg ? Number(limitArg) : null,
    minTalkSec: minTalkArg ? Number(minTalkArg) : undefined,
    dryRun,
  });

  if (!result.tenants.length) {
    console.log("no Yiddish-speaking tenants matched (or none have a qualifying call recording)");
  }
  for (const t of result.tenants) {
    console.log(
      `  ${t.tenantName.padEnd(28)} candidates=${String(t.candidates).padStart(5)} ` +
        `registered=${String(t.registered).padStart(5)} already=${String(t.alreadyRegistered).padStart(5)} ` +
        `hours=${t.hours}`,
    );
  }
  console.log(
    `\n${dryRun ? "would register" : "registered"} ${result.totalRegistered} items ` +
      `(${result.totalAlreadyRegistered} already registered), ${result.totalHours} hours total.`,
  );
  if (dryRun) console.log("dry run — nothing written. Re-run without --dry-run to apply.");
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("yc-register-call-recordings failed:", err?.message ?? err);
      process.exit(1);
    });
}
