/**
 * Creative Studio — the jobs we do ourselves.
 *
 * Generation goes to an engine; joining, exporting and re-framing happen here,
 * on our own machines, with FFmpeg. These are the capabilities that cost
 * nothing per run and must never be sent to a third party: the customer's
 * finished film passing through somebody else's API to be cut is both a
 * privacy problem and a bill.
 */
import path from "path";
import { promises as fs } from "fs";
import * as media from "./media";
import { getObject } from "./storage";
import { saveOutputAsset } from "./assets";

export const EXPORT_PRESETS: Record<string, { label: string; width: number; height: number; kind: "video" | "image" }> = {
  whatsapp_status: { label: "WhatsApp Status", width: 1080, height: 1920, kind: "video" },
  instagram_reel: { label: "Instagram Reel", width: 1080, height: 1920, kind: "video" },
  instagram_post: { label: "Instagram post", width: 1080, height: 1350, kind: "image" },
  facebook: { label: "Facebook", width: 1200, height: 628, kind: "image" },
  tiktok: { label: "TikTok", width: 1080, height: 1920, kind: "video" },
  youtube: { label: "YouTube", width: 1920, height: 1080, kind: "video" },
  youtube_shorts: { label: "YouTube Shorts", width: 1080, height: 1920, kind: "video" },
  landscape: { label: "Landscape commercial", width: 1920, height: 1080, kind: "video" },
  square: { label: "Square", width: 1080, height: 1080, kind: "video" },
};

export const LOCAL_CAPABILITIES = new Set(["export", "timeline.render"]);

interface LocalDeps {
  db: any;
  workerId: string;
}

async function fetchAsset(db: any, tenantId: string, assetId: string): Promise<{ asset: any; buffer: Buffer } | null> {
  const asset = await db.creativeAsset.findFirst({ where: { id: String(assetId), tenantId, deletedAt: null } });
  if (!asset) return null;
  const got = await getObject(asset.storageKey);
  return { asset, buffer: got.body };
}

/**
 * Export one asset for one place it is going. Video is re-framed (filled and
 * cropped, never stretched) and loudness-matched; a still is resized.
 */
export async function runExportJob(deps: LocalDeps, job: any): Promise<{ assetIds: string[] }> {
  const { db } = deps;
  const req = job.request as any;
  const presetKey = String(req.preset || "youtube");
  const preset = EXPORT_PRESETS[presetKey];
  if (!preset) throw new Error(`Unknown export preset "${presetKey}"`);

  const source = await fetchAsset(db, job.tenantId, String(req.assetId));
  if (!source) throw new Error("The file to export is not there any more.");

  const isVideo = source.asset.kind === "video";
  const outAsset = await media.withTempDir(async (dir) => {
    const inFile = path.join(dir, isVideo ? "in.mp4" : "in.png");
    await fs.writeFile(inFile, source.buffer);
    const outFile = path.join(dir, isVideo ? "out.mp4" : `out.${String(req.format || "png").replace(/[^a-z0-9]/gi, "") || "png"}`);

    if (isVideo) await media.reframe(inFile, outFile, preset.width, preset.height);
    else await media.convertImage(inFile, outFile, { width: preset.width, height: preset.height, quality: 3 });

    const buffer = await fs.readFile(outFile);
    return saveOutputAsset(db, {
      tenantId: job.tenantId,
      projectId: job.projectId,
      kind: isVideo ? "video" : "image",
      source: "exported",
      output: {
        buffer,
        mime: isVideo ? "video/mp4" : outFile.endsWith(".jpg") || outFile.endsWith(".jpeg") ? "image/jpeg" : outFile.endsWith(".webp") ? "image/webp" : "image/png",
        name: `${preset.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.${isVideo ? "mp4" : outFile.split(".").pop()}`,
      },
      createdByUserId: job.requestedByUserId,
    });
  });

  return { assetIds: [outAsset.id] };
}

export interface TimelineClip {
  assetId: string;
  startMs?: number;
  durationMs?: number;
  /** Where in the source clip this piece begins — what a split produces. */
  inMs?: number;
}

export interface TimelineAudio {
  assetId: string;
  startMs?: number;
  gain?: number;
  duck?: boolean;
}

export interface TimelineDoc {
  width?: number;
  height?: number;
  fps?: number;
  clips?: TimelineClip[];
  voice?: TimelineAudio[];
  music?: TimelineAudio[];
  effects?: TimelineAudio[];
  captions?: Array<{ startMs: number; endMs: number; text: string }>;
  burnCaptions?: boolean;
  captionStyle?: { fontSize?: number };
}

/**
 * The editor and the renderer share ONE document.
 *
 * A person dragging a clip and the Coworker sending an op both write the same
 * `objects` array, because that is the only way "the agent edits the same
 * project you do" can be true rather than a claim. This turns that array into
 * the lanes FFmpeg needs. A document that already carries `clips` (an older
 * one, or a render asked for directly) is passed through untouched.
 */
export function normaliseTimeline(doc: any): TimelineDoc | null {
  if (!doc || typeof doc !== "object") return null;
  if (Array.isArray(doc.clips) && doc.clips.length) return doc as TimelineDoc;
  const objects: any[] = Array.isArray(doc.objects) ? doc.objects : [];
  if (!objects.length) return null;

  const byStart = (a: any, b: any) => Number(a.startMs || 0) - Number(b.startMs || 0);
  const of = (type: string) => objects.filter((o) => o?.type === type && o?.assetId).sort(byStart);
  const audio = (type: string) =>
    of(type).map((o) => ({ assetId: String(o.assetId), startMs: Number(o.startMs || 0), gain: o.gain != null ? Number(o.gain) : undefined, duck: o.duck === true }));

  return {
    width: Number(doc.width || 1280),
    height: Number(doc.height || 720),
    fps: Number(doc.fps || 30),
    clips: of("clip").map((o) => ({
      assetId: String(o.assetId),
      startMs: Number(o.startMs || 0),
      durationMs: o.durationMs != null ? Number(o.durationMs) : undefined,
      inMs: o.inMs != null ? Number(o.inMs) : undefined,
    })),
    voice: audio("voice"),
    music: audio("music"),
    effects: audio("sfx"),
    captions: objects
      .filter((o) => o?.type === "caption" && String(o.text || "").trim())
      .sort(byStart)
      .map((o) => ({ startMs: Number(o.startMs || 0), endMs: Number(o.endMs ?? Number(o.startMs || 0) + Number(o.durationMs || 2000)), text: String(o.text) })),
    burnCaptions: doc.burnCaptions !== false,
    captionStyle: doc.captionStyle || {},
  };
}

/**
 * The finished film: join the shots, lay the sound under them, burn the
 * captions in, and keep a .srt beside it for the platforms that want one.
 */
export async function runTimelineRenderJob(deps: LocalDeps, job: any): Promise<{ assetIds: string[] }> {
  const { db } = deps;
  const req = job.request as any;

  let timeline: TimelineDoc | null = normaliseTimeline(req.timeline);
  if (!timeline && job.projectId) {
    const doc = await db.creativeDocument.findFirst({ where: { projectId: job.projectId, tenantId: job.tenantId, type: "timeline" } });
    timeline = normaliseTimeline(doc?.doc);
  }
  if (!timeline?.clips?.length) throw new Error("There is nothing on the timeline to render.");

  const width = Number(timeline.width || 1280);
  const height = Number(timeline.height || 720);

  const assetIds = await media.withTempDir(async (dir) => {
    // 1. the picture
    const clipFiles: string[] = [];
    let totalMs = 0;
    for (const [i, clip] of (timeline!.clips || []).entries()) {
      const got = await fetchAsset(db, job.tenantId, clip.assetId);
      if (!got) continue;
      const f = path.join(dir, `clip-${i}.mp4`);
      await fs.writeFile(f, got.buffer);
      let use = f;
      const inMs = Math.max(0, Number(clip.inMs || 0));
      const source = Number(got.asset.durationMs || 0);
      const wants = Number(clip.durationMs || 0);
      // Trim when the piece starts late in the source, or is shorter than it.
      if (inMs > 120 || (wants && source && wants < source - inMs - 120)) {
        const trimmed = path.join(dir, `clip-${i}-trim.mp4`);
        await media.trimTo(f, trimmed, (wants || Math.max(100, source - inMs)) / 1000, inMs / 1000);
        use = trimmed;
      }
      clipFiles.push(use);
      totalMs += wants || Math.max(0, source - inMs);
    }
    if (!clipFiles.length) throw new Error("None of the shots on the timeline could be read.");

    const joined = path.join(dir, "joined.mp4");
    await media.concat(clipFiles, joined, { width, height, fps: Number(timeline!.fps || 30) });

    // 2. the sound
    const layers: media.AudioLayer[] = [];
    const addLayers = async (list: TimelineAudio[] | undefined, defaultGain: number, duck: boolean) => {
      for (const [i, item] of (list || []).entries()) {
        const got = await fetchAsset(db, job.tenantId, item.assetId);
        if (!got) continue;
        const f = path.join(dir, `aud-${duck ? "m" : "v"}-${i}.mp3`);
        await fs.writeFile(f, got.buffer);
        layers.push({ file: f, startMs: Number(item.startMs || 0), gain: Number(item.gain ?? defaultGain), duck });
      }
    };
    await addLayers(timeline!.voice, 1.0, false);
    // Music sits under narration at a fixed, quiet level — that is what
    // "ducked" means to the person who asked for it.
    await addLayers(timeline!.music, (timeline!.voice || []).length ? 0.18 : 0.34, true);
    await addLayers(timeline!.effects, 0.6, false);

    let current = joined;
    if (layers.length) {
      const withAudio = path.join(dir, "with-audio.mp4");
      await media.mixAudioOntoVideo(joined, layers, withAudio, totalMs || 15000);
      current = withAudio;
    }

    // 3. the captions
    const out: string[] = [];
    const cues = timeline!.captions || [];
    let srtAssetId: string | null = null;
    if (cues.length) {
      const srt = media.toSrt(cues);
      const srtAsset = await saveOutputAsset(db, {
        tenantId: job.tenantId,
        projectId: job.projectId,
        kind: "doc",
        source: "rendered",
        output: { buffer: Buffer.from(srt, "utf8"), mime: "text/plain", name: "captions.srt" },
        createdByUserId: job.requestedByUserId,
      });
      srtAssetId = srtAsset.id;
      if (timeline!.burnCaptions !== false) {
        const srtFile = path.join(dir, "captions.srt");
        await fs.writeFile(srtFile, srt, "utf8");
        const burned = path.join(dir, "burned.mp4");
        await media.burnCaptions(current, srtFile, burned, timeline!.captionStyle || {});
        current = burned;
      }
    }

    const buffer = await fs.readFile(current);
    const finalAsset = await saveOutputAsset(db, {
      tenantId: job.tenantId,
      projectId: job.projectId,
      kind: "video",
      source: "rendered",
      output: { buffer, mime: "video/mp4", name: "final-cut.mp4" },
      createdByUserId: job.requestedByUserId,
    });
    out.push(finalAsset.id);
    if (srtAssetId) out.push(srtAssetId);
    return out;
  });

  return { assetIds };
}

export async function runLocalJob(deps: LocalDeps, job: any): Promise<{ assetIds: string[] }> {
  if (job.capability === "export") return runExportJob(deps, job);
  if (job.capability === "timeline.render") return runTimelineRenderJob(deps, job);
  throw new Error(`No local handler for ${job.capability}`);
}
