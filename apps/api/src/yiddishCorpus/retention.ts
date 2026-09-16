/**
 * Loopcom Yiddish Corpus — RETENTION. Audio files expire. Knowledge does not.
 *
 * What this deletes: the AUDIO BYTES of expired ORDINARY assets, and nothing
 * else. Transcripts, segments, observations, lexemes, ratings, corrections,
 * findings and every piece of metadata stay exactly where they are — the whole
 * value of the corpus is the knowledge extracted from the audio, and that
 * survives the recording by design. The asset ROW also stays, marked deleted,
 * so a later question ("where did this observation come from?") still answers.
 *
 * What it never touches:
 *   • retentionClass GOLDEN or HUMAN_REFERENCE — the benchmark material;
 *   • kind HUMAN_REFERENCE — a person recorded it for us;
 *   • any asset a person has reviewed with a correction (REJECTED / EDITED /
 *     VARIANT). A rejection with a correction attached is the most expensive
 *     data in the system: somebody listened, and said what it should have been.
 *
 * THE DELETION LOG is a YcFinding row (kind `retention`), chosen over a metric
 * counter because a finding carries `evidence` Json — so the log holds the
 * actual asset ids, not just a number, and is readable on the findings screen
 * like everything else the engine did. A YcMetricSnapshot counter is written
 * alongside it for the progress chart.
 */
import { unlink } from "node:fs/promises";
import path from "node:path";

export interface YcRetentionOpts {
  /** Report only: nothing is deleted, nothing is written. */
  dryRun?: boolean;
  /** Where STORED audio lives, when storageKey is a relative name. */
  storageDir?: string | null;
  /** Override the file remover (tests inject one; returns true if bytes are gone). */
  deleteFile?: (asset: YcRetentionAsset) => Promise<boolean>;
  /** Cap per run, so a first run on a big backlog is not one enormous transaction. */
  limit?: number;
  /** Protected review decisions — a human correction against the asset. */
  protectedReviewStates?: string[];
}

export interface YcRetentionAsset {
  id: string;
  itemId: string;
  storage: string;
  storageKey: string | null;
  uri: string | null;
  bytes: number | null;
  kind: string;
  retentionClass: string;
  expiresAt: Date | null;
}

export interface YcRetentionResult {
  dryRun: boolean;
  now: string;
  /** Everything that was expired and STORED before protection was applied. */
  candidates: number;
  /** Assets whose bytes were removed (or would be, in a dry run). */
  deleted: { assetId: string; bytes: number | null; storageKey: string | null }[];
  /** Assets left alone, each with the reason in plain English. */
  protectedAssets: { assetId: string; why: string }[];
  errors: { assetId: string; error: string }[];
  /** Nothing textual is ever removed. Stated here so a caller can assert it. */
  textDeleted: 0;
  note: string;
}

const DEFAULT_PROTECTED_REVIEW_STATES = ["REJECTED", "EDITED", "VARIANT"];

async function defaultDeleteFile(asset: YcRetentionAsset, storageDir: string | null | undefined): Promise<boolean> {
  const key = asset.storageKey;
  if (!key) return false;
  const full = path.isAbsolute(key) ? key : path.join(storageDir ?? "", key);
  try {
    await unlink(full);
    return true;
  } catch (err: any) {
    // Already gone is the outcome we wanted. Anything else is a real error.
    if (err?.code === "ENOENT") return true;
    throw err;
  }
}

/**
 * Sweep expired audio. Returns what it did — or, with `dryRun`, exactly what
 * it WOULD do, computed the same way, so the preview cannot drift from the run.
 */
export async function applyRetention(
  db: any,
  now: Date = new Date(),
  opts: YcRetentionOpts = {},
): Promise<YcRetentionResult> {
  const dryRun = opts.dryRun === true;
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
  const protectedStates = opts.protectedReviewStates ?? DEFAULT_PROTECTED_REVIEW_STATES;

  const candidates: YcRetentionAsset[] = await db.ycAudioAsset.findMany({
    where: {
      retentionClass: "ORDINARY",
      storage: "STORED",
      deletedAt: null,
      expiresAt: { not: null, lte: now },
    },
    take: limit,
    orderBy: { expiresAt: "asc" },
  });

  const protectedAssets: { assetId: string; why: string }[] = [];
  const eligible: YcRetentionAsset[] = [];

  // Belt and braces: the query already excludes GOLDEN / HUMAN_REFERENCE
  // retention classes, but a HUMAN_REFERENCE *kind* on an ordinary class would
  // slip past it, and that is a recording a person made for us.
  for (const a of candidates) {
    if (a.retentionClass !== "ORDINARY") {
      protectedAssets.push({ assetId: a.id, why: `retention class ${a.retentionClass} is kept permanently` });
      continue;
    }
    if (String(a.kind).toUpperCase() === "HUMAN_REFERENCE") {
      protectedAssets.push({ assetId: a.id, why: "a person recorded this as a human reference" });
      continue;
    }
    eligible.push(a);
  }

  // A human correction against the asset protects it, whatever its class.
  if (eligible.length > 0) {
    const ids = eligible.map((a) => a.id);
    const reviews: any[] = await db.ycReviewItem.findMany({
      where: { subjectId: { in: ids }, state: { in: protectedStates } },
    });
    const corrected = new Set(reviews.map((r) => r.subjectId));
    for (let i = eligible.length - 1; i >= 0; i -= 1) {
      const a = eligible[i]!;
      if (corrected.has(a.id)) {
        protectedAssets.push({ assetId: a.id, why: "a person reviewed this and left a correction on it" });
        eligible.splice(i, 1);
      }
    }
  }

  const deleted: YcRetentionResult["deleted"] = [];
  const errors: YcRetentionResult["errors"] = [];

  const note =
    "Audio bytes only. Transcripts, segments, observations, lexemes, ratings, corrections and every " +
    "piece of metadata are untouched — the asset row stays, marked deleted, so provenance still answers.";

  if (dryRun) {
    return {
      dryRun: true,
      now: now.toISOString(),
      candidates: candidates.length,
      deleted: eligible.map((a) => ({ assetId: a.id, bytes: a.bytes ?? null, storageKey: a.storageKey ?? null })),
      protectedAssets,
      errors,
      textDeleted: 0,
      note,
    };
  }

  for (const a of eligible) {
    try {
      const remover = opts.deleteFile ?? ((asset: YcRetentionAsset) => defaultDeleteFile(asset, opts.storageDir));
      const gone = await remover(a);
      if (!gone) {
        errors.push({ assetId: a.id, error: "the audio file could not be located, so nothing was changed" });
        continue;
      }
      // Bytes gone; the row becomes a REFERENCE_ONLY record of what was here.
      await db.ycAudioAsset.update({
        where: { id: a.id },
        data: {
          storage: "REFERENCE_ONLY",
          storageKey: null,
          bytes: null,
          deletedAt: now,
          deleteReason: `retention: ORDINARY audio expired ${a.expiresAt ? new Date(a.expiresAt).toISOString() : ""}`.trim(),
        },
      });
      deleted.push({ assetId: a.id, bytes: a.bytes ?? null, storageKey: a.storageKey ?? null });
    } catch (err: any) {
      errors.push({ assetId: a.id, error: String(err?.message ?? err) });
    }
  }

  if (deleted.length > 0 || errors.length > 0) {
    // The deletion log. A finding, because it carries the ids as evidence.
    await db.ycFinding.create({
      data: {
        kind: "retention",
        statement:
          `Retention sweep removed audio bytes for ${deleted.length} expired ordinary asset` +
          `${deleted.length === 1 ? "" : "s"}. No text, ratings or corrections were deleted.`,
        evidence: {
          deletedAssetIds: deleted.map((d) => d.assetId),
          protected: protectedAssets,
          errors,
          bytesFreed: deleted.reduce((s, d) => s + (d.bytes ?? 0), 0),
          ranAt: now.toISOString(),
        },
        sampleCount: deleted.length,
        status: "ACCEPTED",
      },
    });
    const day = now.toISOString().slice(0, 10);
    await db.ycMetricSnapshot.upsert({
      where: { day_sourceKey_metric: { day, sourceKey: "__all__", metric: "retention_audio_deleted" } },
      update: { value: deleted.length },
      create: { day, sourceKey: "__all__", metric: "retention_audio_deleted", value: deleted.length },
    });
  }

  return {
    dryRun: false,
    now: now.toISOString(),
    candidates: candidates.length,
    deleted,
    protectedAssets,
    errors,
    textDeleted: 0,
    note,
  };
}
