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

const STAGES = ["fetch_audio", "segment", "features"];
const LEASE_OWNER = "izzy-pc";
const BATCH = 3;
const IDLE_MS = 20_000;
const ERROR_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Customer voicemails (Izzy: customers cleared it, 2026-09-17). Audio was
 * bulk-copied from the server's voicemail volume into audio\voicemail; the
 * file name is the Voicemail.localAudioPath kept on the item's metadata.
 * AUDIO ONLY — the Yiddish Labs transcript is never read. */
function voicemailFetchHandler(defaultFetch: any, probeAudio: any) {
  return async (ctx: any) => {
    if (ctx.job?.sourceKey !== "voicemail") return defaultFetch(ctx);
    const { db, item } = ctx;
    const name = String(item?.metadata?.localAudioPath || "");
    if (!name || name.includes("..") || /[\\/]/.test(name)) return { ok: true, skipped: true, reason: "no local voicemail audio", advance: false };
    const file = path.join(HERE, "audio", "voicemail", name);
    if (!existsSync(file)) return { ok: false, reason: `voicemail audio not copied to this PC yet: ${name}` };
    const bytes = readFileSync(file);
    const sha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    const probed: any = await probeAudio(file);
    const existing = await db.ycAudioAsset.findFirst({ where: { itemId: item.id, storage: "STORED", deletedAt: null } });
    if (!existing) {
      await db.ycAudioAsset.create({
        data: {
          itemId: item.id,
          storage: "STORED",
          uri: `voicemail:${item.externalId}`,
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
  const handlers = { ...defaultStageHandlers, fetch_audio: voicemailFetchHandler(defaultStageHandlers.fetch_audio, probeAudio) };
  const db = new PrismaClient();
  log(`runner up — stages ${STAGES.join(", ")}; audio in ${process.env.YC_AUDIO_DIR}`);

  let totals = { done: 0, skipped: 0, failed: 0, retried: 0 };
  while (!existsSync(path.join(HERE, "STOP"))) {
    try {
      // Analyze what is already on disk BEFORE downloading more, or a big
      // download queue starves the learning for days.
      let res: any = await runDueJobs(db, {
        leaseOwner: LEASE_OWNER,
        limit: BATCH,
        stages: ["segment", "features"],
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
