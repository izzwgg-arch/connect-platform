/**
 * Loopcom Yiddish audio runner — runs on Izzy's PC (2026-09-17).
 *
 * Takes ONLY the audio stages (download, speech/music split, rhythm features)
 * from the shared Yiddish engine queue, keeps the MP3s on this computer, and
 * writes the results back to the Connect database through an SSH tunnel
 * (tunnel.cmd). The server is set to leave these stages alone
 * (YIDDISH_WORKER_EXCLUDE_STAGES), everything else still runs there.
 *
 * Same code as production: code/ is a snapshot of apps/api/src/yiddishCorpus.
 * The audio gate still applies — a job only downloads while the Yiddish24
 * source is OWNER_AUTHORIZED with a GRANTED rights record.
 *
 * Stop it: create a file named STOP in this folder (or close the window).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const HERE = __dirname;

// .env: DATABASE_URL pointing at the tunnel (127.0.0.1:15432).
for (const line of readFileSync(path.join(HERE, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
process.env.YC_AUDIO_DIR ||= path.join(HERE, "audio");
const FFMPEG_BIN =
  "C:\\Users\\izzyw\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin";
process.env.YC_FFMPEG_PATH ||= path.join(FFMPEG_BIN, "ffmpeg.exe");
process.env.YC_FFPROBE_PATH ||= path.join(FFMPEG_BIN, "ffprobe.exe");

// ⛔ 2026-09-17: transcribe/align now have handlers in the shared engine
// (Lane A, apps/api/src/yiddishCorpus/jobs.ts). They are listed here so this
// log line stays honest about which stages this runner is meant to carry;
// actually claiming them (adding them to the `stages:` arrays in the loop
// below, and to the server's YIDDISH_WORKER_EXCLUDE_STAGES) is the
// integrator's step, done together with landing Lane A and regenerating this
// runner's Prisma client — see §4.1 of
// docs/ai-context/AGENT_HANDOFF_YIDDISH_WHISPER_FINETUNE_2026-09-17.md.
const STAGES = ["fetch_audio", "segment", "features", "transcribe", "align"];
const LEASE_OWNER = "izzy-pc";
const BATCH = 3;
const IDLE_MS = 20_000;
const ERROR_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/**
 * Any INTERNAL_TABLE source whose items carry `metadata.localAudioPath` reads
 * its audio from `audio/<sourceKey>/<file>` on this PC instead of downloading
 * it — this is how customer voicemails (Izzy: customers cleared it,
 * 2026-09-17) AND call recordings (bulk-copied ahead of time by
 * `copy-call-recordings.ts`, never fetched over the network by this handler)
 * enter the pipeline. Presence of the `localAudioPath` field on the item's
 * metadata IS the signal — sources with a real network fetch (Yiddish24)
 * never set it, so this generalises to any future internal audio source with
 * no further change here.
 *
 * AUDIO ONLY. Neither the Yiddish Labs voicemail transcript nor any call
 * transcript text is ever read by this handler.
 *
 * TODO (integrator / Lane A): for `call_recordings` items specifically, the
 * `transcribe` handler in `apps/api/src/yiddishCorpus/jobs.ts` should run the
 * cheap language probe BEFORE paying to transcribe a whole call: submit the
 * first ~30s with `language: "auto"`, then call `probeDecision(text,
 * detectedLanguage)` from `scripts/yiddish-runner/languageProbe.ts` (pure,
 * copy it or import it — it has no dependency on this runner). When
 * `!decision.yiddish`, write the item SKIPPED with `decision.reason` and stop
 * — same shape `fetch_audio` already uses for a lawful skip — instead of
 * transcribing the rest of an English call. Yiddish24 and voicemail need no
 * such probe (already known-Yiddish by construction / by
 * `Voicemail.transcriptLanguage`). This runner does not call the probe
 * itself: it downloads audio, it does not transcribe.
 */
function internalAudioFetchHandler(defaultFetch: any, probeAudio: any) {
  return async (ctx: any) => {
    const { db, item, job } = ctx;
    const sourceKey = String(job?.sourceKey || "");
    const hasLocalAudioField = !!item?.metadata && Object.prototype.hasOwnProperty.call(item.metadata, "localAudioPath");
    if (!hasLocalAudioField) return defaultFetch(ctx);
    const name = String(item?.metadata?.localAudioPath || "");
    if (!name || name.includes("..") || /[\\/]/.test(name)) {
      return { ok: true, skipped: true, reason: `no local ${sourceKey || "internal"} audio`, advance: false };
    }
    const file = path.join(HERE, "audio", sourceKey, name);
    if (!existsSync(file)) return { ok: false, reason: `${sourceKey} audio not copied to this PC yet: ${name}` };
    const bytes = readFileSync(file);
    const sha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    const probed: any = await probeAudio(file);
    const existing = await db.ycAudioAsset.findFirst({ where: { itemId: item.id, storage: "STORED", deletedAt: null } });
    if (!existing) {
      await db.ycAudioAsset.create({
        data: {
          itemId: item.id,
          storage: "STORED",
          uri: `${sourceKey}:${item.externalId}`,
          storageKey: file,
          sha256,
          bytes: bytes.length,
          durationMs: probed.available ? probed.durationMs ?? null : null,
          sampleRate: probed.available ? probed.sampleRate ?? null : null,
          channels: probed.available ? probed.channels ?? null : null,
          codec: probed.available ? probed.codec ?? null : null,
          kind: "INTERNAL",
        },
      });
    }
    return { ok: true, advance: true };
  };
}

async function main() {
  const { PrismaClient } = await import("@prisma/client");
  const { runDueJobs, defaultStageHandlers } = await import("./code/apps/api/src/yiddishCorpus/jobs");
  const { probeAudio } = await import("./code/apps/api/src/yiddishCorpus/audioPipeline");
  const handlers = { ...defaultStageHandlers, fetch_audio: internalAudioFetchHandler(defaultStageHandlers.fetch_audio, probeAudio) };
  const db = new PrismaClient();
  log(`runner up — stages ${STAGES.join(", ")}; audio in ${process.env.YC_AUDIO_DIR}`);

  let totals = { done: 0, skipped: 0, failed: 0, retried: 0 };
  while (!existsSync(path.join(HERE, "STOP"))) {
    try {
      // Analyze what is already on disk BEFORE downloading more, or a big
      // download queue starves the learning for days.
      // Order inside the lane is by job nextRunAt/priority, not this list; the
      // point is that every LOCAL/labelling stage is tried before another
      // download is started, so a big fetch backlog never starves learning.
      let res: any = await runDueJobs(db, {
        leaseOwner: LEASE_OWNER,
        limit: BATCH,
        stages: ["segment", "features", "transcribe", "align"],
        leaseMs: 45 * 60_000,
        handlers,
      });
      const analyzed = (res?.done || 0) + (res?.skipped || 0) + (res?.failed || 0) + (res?.retried || 0);
      if (analyzed === 0) {
        res = await runDueJobs(db, { leaseOwner: LEASE_OWNER, limit: BATCH, stages: ["fetch_audio"], leaseMs: 45 * 60_000, handlers });
      }
      const worked = (res?.done || 0) + (res?.skipped || 0) + (res?.failed || 0) + (res?.retried || 0);
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += Number(res?.[k]) || 0;
      if (worked > 0) {
        log(`batch done=${res.done} skipped=${res.skipped} failed=${res.failed} retried=${res.retried} | totals ${JSON.stringify(totals)}`);
        for (const e of res?.errors ?? []) log(`  error ${e.stage}: ${e.error}`);
      } else {
        await sleep(IDLE_MS);
      }
    } catch (err: any) {
      log(`tick failed (tunnel down?): ${String(err?.message || err).slice(0, 300)}`);
      await sleep(ERROR_MS);
    }
  }
  log("STOP file found — exiting");
  await db.$disconnect();
}

main().catch((err) => {
  log("fatal", err);
  process.exit(1);
});
