/**
 * Creative Studio — turning a film into shots, and shots into a cut.
 *
 * Both of these exist ONCE and are used by the browser and the Coworker alike.
 * If the agent had its own splitter, "make me a 15-second commercial" and
 * clicking the same thing would quietly produce different films — and the one
 * nobody tested would be the one a customer got.
 */
import crypto from "crypto";

/** Short, readable ids for the pieces of a document. */
function newDocId(prefix: string): string {
  return `${prefix}${crypto.randomBytes(4).toString("hex")}`;
}

/** No single generated clip may be longer than this. It is an engine fact. */
export const MAX_SHOT_SECONDS = 15;

/**
 * Split a film into shots a person would actually cut.
 *
 * Five seconds is the default beat: long enough to read, short enough that a
 * bad one is cheap to redo. Nothing comes back shorter than three seconds,
 * because a two-second shot reads as a mistake.
 */
export function planShots(totalSeconds: number, preferred = 5): number[] {
  const total = Math.max(1, Math.round(Number(totalSeconds) || 0));
  const beat = Math.max(3, Math.min(MAX_SHOT_SECONDS, Math.round(preferred)));
  if (total <= MAX_SHOT_SECONDS && total <= beat) return [total];

  const count = Math.max(1, Math.round(total / beat));
  const base = Math.floor(total / count);
  const shots = Array.from({ length: count }, () => base);
  let left = total - base * count;
  for (let i = 0; left > 0; i = (i + 1) % count) {
    shots[i] += 1;
    left -= 1;
  }
  // A beat that came out over the ceiling is split again rather than clipped.
  const out: number[] = [];
  for (const s of shots) {
    if (s <= MAX_SHOT_SECONDS) out.push(s);
    else {
      const half = Math.floor(s / 2);
      out.push(half, s - half);
    }
  }
  return out.filter((s) => s > 0);
}

export interface ShotInput {
  title?: string;
  prompt: string;
  seconds?: number;
}

/**
 * The storyboard document, in the shape both editors read: an `objects` array
 * that the ops door can add to, re-order and delete.
 */
export function storyboardDoc(shots: ShotInput[], totalSeconds: number, ratio = "16:9"): any {
  // A length the agent gave us is honoured (clamped to the ceiling). A shot
  // with no length shares out whatever is left of the film.
  const given = shots.map((s) => {
    const n = Math.round(Number(s.seconds || 0));
    return n > 0 ? Math.max(1, Math.min(MAX_SHOT_SECONDS, n)) : 0;
  });
  const missing = given.filter((n) => !n).length;
  const spoken = given.reduce((a, b) => a + b, 0);
  const left = Math.max(missing * 3, Math.round(Number(totalSeconds) || 0) - spoken);

  // Even shares, with the remainder spread one second at a time rather than
  // dumped on the last shot.
  const share = missing ? Math.floor(left / missing) : 0;
  const shares = Array.from({ length: missing }, () => share);
  let spare = missing ? left - share * missing : 0;
  for (let i = 0; spare > 0; i = (i + 1) % missing) {
    shares[i] += 1;
    spare -= 1;
  }

  const objects: any[] = [];
  let slot = 0;
  shots.forEach((shot, i) => {
    const prompt = String(shot.prompt || "").slice(0, 2000);
    const title = String(shot.title || `Shot ${i + 1}`).slice(0, 120);
    // A share that will not fit in one clip becomes two shots of the same
    // thing rather than a length the engine would refuse.
    const lengths = given[i] ? [given[i]] : planShots(shares[slot++] || 5, MAX_SHOT_SECONDS);
    lengths.forEach((seconds, part) => {
      objects.push({
        id: newDocId("s"),
        type: "shot",
        title: part ? `${title} (part ${part + 1})`.slice(0, 120) : title,
        prompt,
        seconds,
        transition: "Cut",
      });
    });
  });

  return { kind: "storyboard", ratio, objects };
}

/**
 * Lay every rendered shot end to end on the video track, in storyboard order.
 *
 * ⛔ Shots with no clip yet are SKIPPED rather than left as gaps: a gap in the
 * middle of a cut renders as a freeze, which looks like a broken file.
 */
export function timelineFromStoryboard(storyboard: any, assetsById: Record<string, any>, ratio?: string): any {
  const objects: any[] = Array.isArray(storyboard?.objects) ? storyboard.objects : [];
  const shape = String(ratio || storyboard?.ratio || "16:9");
  const [width, height] =
    shape === "9:16" ? [1080, 1920] : shape === "1:1" ? [1080, 1080] : shape === "4:5" ? [1080, 1350] : [1280, 720];

  let at = 0;
  const clips: any[] = [];
  for (const shot of objects) {
    if (shot?.type !== "shot" || !shot.assetId) continue;
    const asset = assetsById[String(shot.assetId)];
    if (!asset) continue;
    const durationMs = Math.max(500, Number(asset.durationMs || 0) || Math.round(Number(shot.seconds || 5) * 1000));
    clips.push({
      id: newDocId("c"),
      type: "clip",
      track: 0,
      assetId: String(shot.assetId),
      startMs: at,
      durationMs,
      name: String(shot.title || "Shot").slice(0, 120),
    });
    at += durationMs;
  }

  return { kind: "timeline", width, height, fps: 30, burnCaptions: true, objects: clips };
}

/**
 * Keep the sound and captions that are already on a timeline when the picture
 * is rebuilt from the storyboard — re-rendering a shot must not silently throw
 * away a voiceover somebody recorded.
 */
export function mergeTimeline(existing: any, rebuilt: any): any {
  const keep: any[] = (Array.isArray(existing?.objects) ? existing.objects : []).filter((o: any) => o?.type && o.type !== "clip");
  return {
    ...rebuilt,
    burnCaptions: existing?.burnCaptions !== undefined ? existing.burnCaptions : rebuilt.burnCaptions,
    captionStyle: existing?.captionStyle || rebuilt.captionStyle,
    objects: [...rebuilt.objects, ...keep],
  };
}

export type AssembleOutcome =
  | { ok: true; documentId: string; revision: number; doc: any; clips: number; skipped: number }
  | { ok: false; code: "no_storyboard" | "no_shots"; reason: string };

/**
 * Build the cut from the storyboard — the ONE implementation, used by the
 * "Open in the editor" button and by the Coworker's assemble tool.
 *
 * Sound and captions already on the timeline survive; only the picture is
 * rebuilt. The document is written as the actor who asked, so the project's
 * history says whether a person or the Coworker assembled it.
 */
export async function assembleFilm(
  db: any,
  input: { tenantId: string; projectId: string; userId?: string | null; actorType?: "user" | "coworker" },
): Promise<AssembleOutcome> {
  const storyboard = await db.creativeDocument.findFirst({ where: { projectId: input.projectId, tenantId: input.tenantId, type: "storyboard" } });
  if (!storyboard) return { ok: false, code: "no_storyboard", reason: "There is no storyboard for this film yet." };

  const shots: any[] = Array.isArray((storyboard.doc as any)?.objects) ? (storyboard.doc as any).objects : [];
  const wanted = shots.filter((s) => s?.type === "shot" && s.assetId).map((s) => String(s.assetId));
  if (!wanted.length) return { ok: false, code: "no_shots", reason: "None of the shots have been rendered yet, so there is nothing to cut." };

  const assets = await db.creativeAsset.findMany({ where: { id: { in: wanted }, tenantId: input.tenantId, deletedAt: null } });
  const byId: Record<string, any> = {};
  for (const a of assets) byId[a.id] = a;

  const rebuilt = timelineFromStoryboard(storyboard.doc, byId);
  if (!rebuilt.objects.length) return { ok: false, code: "no_shots", reason: "The rendered clips for this film are no longer there." };

  const existing = await db.creativeDocument.findFirst({ where: { projectId: input.projectId, tenantId: input.tenantId, type: "timeline" } });
  const doc = mergeTimeline(existing?.doc, rebuilt);
  const actorType = input.actorType || "user";

  const saved = existing
    ? await db.creativeDocument.update({ where: { id: existing.id }, data: { doc, revision: { increment: 1 }, updatedByType: actorType, updatedByUserId: input.userId || null } })
    : await db.creativeDocument.create({ data: { tenantId: input.tenantId, projectId: input.projectId, type: "timeline", doc, revision: 1, updatedByType: actorType, updatedByUserId: input.userId || null } });

  await db.creativeOperation
    .create({
      data: {
        tenantId: input.tenantId,
        documentId: saved.id,
        revision: saved.revision,
        actorType,
        actorUserId: input.userId || null,
        op: "replace",
        payload: { clips: rebuilt.objects.length } as any,
        summary: `Cut assembled from ${rebuilt.objects.length} shot${rebuilt.objects.length === 1 ? "" : "s"}`,
      },
    })
    .catch(() => undefined);

  return { ok: true, documentId: saved.id, revision: saved.revision, doc: saved.doc, clips: rebuilt.objects.length, skipped: shots.filter((s) => s?.type === "shot").length - rebuilt.objects.length };
}
