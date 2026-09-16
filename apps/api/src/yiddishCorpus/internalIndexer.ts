/**
 * Loopcom Yiddish Corpus — INTERNAL INDEXER. Index what we already have,
 * honestly, before a single byte is fetched from anywhere outside.
 *
 * ⛔⛔ THE RULE THAT SHAPES THIS WHOLE FILE: for a CUSTOMER_PRIVATE source this
 * code may COUNT and it may MEASURE (durations, date ranges). It may not READ.
 * So every private-table call here is a `count` or an `aggregate` — never a
 * `findMany`, never a `select` of a transcript, a body, a message or a path.
 * That is asserted by a test that watches every call the indexer makes.
 *
 * The one source that IS read is `yiddishlabs_cache` (PLATFORM): the Yiddish
 * Labs translation cache is our own row of text, and reading it seeds LEXEMES —
 * spelling and meaning, not pronunciation. Those lexemes carry no pronunciation
 * weight (YC_SOURCE_WEIGHTS.yiddishlabs = 0) and the source is permanently
 * EXCLUDED from every training export.
 *
 * Numbers land in YcMetricSnapshot (the append-only counter table) and a
 * summary lands on the source's `config`, so the dashboard reads counts without
 * re-scanning anything.
 */
import { YC_INTERNAL_SOURCES } from "./contracts";
import { upsertLexemesFromText } from "./lexicon";

export interface YcInternalCount {
  key: string;
  name: string;
  governanceClass: string;
  /** Rows counted (voicemails, recordings, drafts, messages, cache rows). */
  items: number;
  /** Audio hours where the table records a duration; null when it does not. */
  audioHours: number | null;
  firstAt: string | null;
  lastAt: string | null;
  /** How the count was obtained — "count", "aggregate", "sql-script-regex", "absent". */
  method: string;
  /** Plain English caveat for the dashboard. Always says what we did NOT do. */
  note: string;
  /** Lexemes seeded (yiddishlabs_cache only). */
  lexemesSeeded?: number;
}

export interface YcReindexResult {
  countedAt: string;
  sources: YcInternalCount[];
}

const HOUR_SEC = 3600;

function hours(sumSeconds: number | null | undefined): number | null {
  if (sumSeconds == null || !Number.isFinite(sumSeconds)) return null;
  return Math.round((sumSeconds / HOUR_SEC) * 10) / 10;
}

function iso(d: any): string | null {
  if (!d) return null;
  try {
    return new Date(d).toISOString();
  } catch {
    return null;
  }
}

/** Hebrew-script narrowing without pulling a single row into this process. */
async function countHebrewScriptViaSql(db: any, sql: string): Promise<number | null> {
  if (typeof db?.$queryRawUnsafe !== "function") return null;
  try {
    const rows: any[] = await db.$queryRawUnsafe(sql);
    const first = rows?.[0];
    if (!first) return 0;
    const value = first.count ?? first.n ?? Object.values(first)[0];
    return Number(value ?? 0);
  } catch {
    // A missing table or an unsupported regex must not fail the whole reindex.
    return null;
  }
}

/** Ensure every internal source has its registered row, without clobbering the
 *  owner's own decisions (contentAllowed, audioFetchMode, enabled stay put). */
async function ensureSource(db: any, entry: { key: string; name: string; governanceClass: string }): Promise<any> {
  const trainingExportEligibility =
    entry.governanceClass === "CUSTOMER_PRIVATE" || entry.key === "yiddishlabs_cache" ? "EXCLUDED" : "UNKNOWN";
  return db.ycSource.upsert({
    where: { key: entry.key },
    update: { name: entry.name },
    create: {
      key: entry.key,
      name: entry.name,
      kind: entry.key === "voicelab" ? "VOICE_LAB" : "INTERNAL_TABLE",
      governanceClass: entry.governanceClass,
      trainingExportEligibility,
      contentAllowed: false,
      audioFetchMode: "DISABLED",
      enabled: false,
    },
  });
}

async function storeCounts(db: any, source: any, count: YcInternalCount, day: string): Promise<void> {
  const metrics: [string, number][] = [
    ["internal_items", count.items],
    ["internal_audio_hours", count.audioHours ?? 0],
  ];
  for (const [metric, value] of metrics) {
    await db.ycMetricSnapshot.upsert({
      where: { day_sourceKey_metric: { day, sourceKey: count.key, metric } },
      update: { value },
      create: { day, sourceKey: count.key, metric, value },
    });
  }
  await db.ycSource.update({
    where: { id: source.id },
    data: {
      lastDiscoveryAt: new Date(),
      config: {
        ...(source.config && typeof source.config === "object" ? source.config : {}),
        inventory: {
          items: count.items,
          audioHours: count.audioHours,
          firstAt: count.firstAt,
          lastAt: count.lastAt,
          method: count.method,
          note: count.note,
          countedAt: new Date().toISOString(),
        },
      },
    },
  });
}

export interface YcReindexOpts {
  /** Read the YL translation cache to seed lexemes (PLATFORM source only). */
  seedLexemes?: boolean;
  /** Cap on translation-cache rows read in one pass. */
  seedLimit?: number;
  now?: Date;
}

/**
 * Re-count every internal source. Counts only, except the platform-owned
 * translation cache. Safe to run as often as you like: the metric rows are
 * upserted per day and the lexeme seeding is idempotent per (text, source, item).
 */
export async function reindexInternal(db: any, opts: YcReindexOpts = {}): Promise<YcReindexResult> {
  const now = opts.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const out: YcInternalCount[] = [];

  for (const entry of YC_INTERNAL_SOURCES) {
    const source = await ensureSource(db, entry as any);
    let count: YcInternalCount;

    switch (entry.key) {
      case "voicemail": {
        // COUNTS + DURATIONS ONLY. No transcript, no caller, no audio path.
        const agg = await db.voicemail.aggregate({
          where: { transcriptLanguage: { in: ["yi", "yi-en"] } },
          _count: { _all: true },
          _sum: { durationSec: true },
          _min: { receivedAt: true },
          _max: { receivedAt: true },
        });
        count = {
          key: entry.key,
          name: entry.name,
          governanceClass: entry.governanceClass,
          items: Number(agg?._count?._all ?? 0),
          audioHours: hours(agg?._sum?.durationSec),
          firstAt: iso(agg?._min?.receivedAt),
          lastAt: iso(agg?._max?.receivedAt),
          method: "aggregate",
          note:
            "Counted, never read. Transcript text, caller details and audio stay out of the corpus " +
            "until the owner records a basis. These rows are also permanently no-train: the engine tag " +
            "stt-yi hides whether Yiddish Labs or ivrit produced them.",
        };
        break;
      }

      case "call_recordings": {
        // recordingPath proves INTENT, not existence (the documented trap), so
        // rows the PBX has confirmed missing are left out of the count.
        const agg = await db.connectCdr.aggregate({
          where: { recordingPath: { not: null }, recordingMissingAt: null },
          _count: { _all: true },
          _sum: { talkSec: true },
          _min: { startedAt: true },
          _max: { startedAt: true },
        });
        count = {
          key: entry.key,
          name: entry.name,
          governanceClass: entry.governanceClass,
          items: Number(agg?._count?._all ?? 0),
          audioHours: hours(agg?._sum?.talkSec),
          firstAt: iso(agg?._min?.startedAt),
          lastAt: iso(agg?._max?.startedAt),
          method: "aggregate",
          note:
            "Counted, never opened. No recording is fetched, and the Yiddish share of these calls is " +
            "unknown — there is no recording-consent field on this table.",
        };
        break;
      }

      case "supermarket_drafts": {
        const agg = await db.supermarketOrderDraft.aggregate({
          where: { transcript: { not: "" } },
          _count: { _all: true },
          _min: { createdAt: true },
          _max: { createdAt: true },
        });
        count = {
          key: entry.key,
          name: entry.name,
          governanceClass: entry.governanceClass,
          items: Number(agg?._count?._all ?? 0),
          audioHours: null,
          firstAt: iso(agg?._min?.createdAt),
          lastAt: iso(agg?._max?.createdAt),
          method: "aggregate",
          note:
            "Counted, never read. Valuable because it is a SECOND, independent transcript of voicemail " +
            "audio we already hold — evaluation material, if the owner ever records a basis.",
        };
        break;
      }

      case "assistant_chat": {
        const conversations = await db.agentConversation.count({ where: { language: "yi" } });
        const sqlCount = await countHebrewScriptViaSql(
          db,
          `SELECT COUNT(*)::int AS count FROM "AgentMessage" WHERE "content" ~ '[\\u0590-\\u05FF]'`,
        );
        const messages =
          sqlCount ?? (await db.agentMessage.count({ where: { conversation: { language: "yi" } } }));
        const agg = await db.agentConversation.aggregate({
          where: { language: "yi" },
          _min: { startedAt: true },
          _max: { startedAt: true },
        });
        count = {
          key: entry.key,
          name: entry.name,
          governanceClass: entry.governanceClass,
          items: Number(messages ?? 0),
          audioHours: null,
          firstAt: iso(agg?._min?.startedAt),
          lastAt: iso(agg?._max?.startedAt),
          method: sqlCount == null ? "count" : "sql-script-regex",
          note:
            `Counted, never read (${conversations} Yiddish conversations). ` +
            (sqlCount == null
              ? "Hebrew-script narrowing was not available here, so this is the message count of Yiddish conversations."
              : "Hebrew-script narrowing was done inside the database; no message text entered this process.") +
            " These chats ran through the Yiddish Labs bridge, so they are no-train as well.",
        };
        break;
      }

      case "connect_chat": {
        const sqlCount = await countHebrewScriptViaSql(
          db,
          `SELECT COUNT(*)::int AS count FROM "ConnectChatMessage" WHERE "body" ~ '[\\u0590-\\u05FF]'`,
        );
        const messages = sqlCount ?? (await db.connectChatMessage.count({ where: { type: "TEXT" } }));
        const agg = await db.connectChatMessage.aggregate({
          _min: { createdAt: true },
          _max: { createdAt: true },
        });
        count = {
          key: entry.key,
          name: entry.name,
          governanceClass: entry.governanceClass,
          items: Number(messages ?? 0),
          audioHours: null,
          firstAt: iso(agg?._min?.createdAt),
          lastAt: iso(agg?._max?.createdAt),
          method: sqlCount == null ? "count" : "sql-script-regex",
          note:
            sqlCount == null
              ? "Counted, never read. Hebrew-script narrowing was not available, so this is the whole text-message count."
              : "Counted, never read. The Hebrew-script filter ran inside the database; no message body entered this process.",
        };
        break;
      }

      case "yiddishlabs_cache": {
        // PLATFORM. Our own rows. Reading them is allowed, and it buys spelling
        // and meaning — never pronunciation (weight 0, export EXCLUDED).
        const agg = await db.agentTranslation.aggregate({
          where: { action: { in: ["translate-yiddish", "translate-english"] } },
          _count: { _all: true },
          _min: { createdAt: true },
          _max: { createdAt: true },
        });
        let lexemesSeeded = 0;
        if (opts.seedLexemes) {
          const rows = await db.agentTranslation.findMany({
            where: { action: { in: ["translate-yiddish", "translate-english"] } },
            select: { id: true, action: true, srcText: true, outText: true },
            take: opts.seedLimit ?? 2000,
            orderBy: { updatedAt: "desc" },
          });
          for (const r of rows ?? []) {
            // translate-yiddish: the OUTPUT is the Yiddish. translate-english:
            // the SOURCE was. Anything else is skipped rather than guessed at.
            const yiddish = r.action === "translate-yiddish" ? r.outText : r.action === "translate-english" ? r.srcText : null;
            if (!yiddish) continue;
            const res = await upsertLexemesFromText(db, yiddish, {
              sourceKey: entry.key,
              itemId: r.id,
              now,
            });
            lexemesSeeded += res.lexemeIds.length;
          }
        }
        count = {
          key: entry.key,
          name: entry.name,
          governanceClass: entry.governanceClass,
          items: Number(agg?._count?._all ?? 0),
          audioHours: null,
          firstAt: iso(agg?._min?.createdAt),
          lastAt: iso(agg?._max?.createdAt),
          method: "aggregate",
          note:
            "Read on purpose: this is our own translation cache, and it tells us how words are SPELLED. " +
            "It is lexical evidence only — weight 0 for pronunciation — and Yiddish Labs output is " +
            "excluded from every training export.",
          lexemesSeeded,
        };
        break;
      }

      case "voicelab":
      default: {
        // The Voice Lab tables are a design, not a schema, as of this build.
        count = {
          key: entry.key,
          name: entry.name,
          governanceClass: entry.governanceClass,
          items: 0,
          audioHours: null,
          firstAt: null,
          lastAt: null,
          method: "absent",
          note:
            "No Voice Lab tables exist yet, so this counts zero — it is not an empty result, it is an " +
            "absent source. It fills in when the Voice Lab is built.",
        };
        break;
      }
    }

    await storeCounts(db, source, count, day);
    out.push(count);
  }

  return { countedAt: now.toISOString(), sources: out };
}
