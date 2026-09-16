/**
 * Creative Studio — writing a finished output into storage and the library.
 *
 * Its own module so the job runner and the local (FFmpeg) jobs can both use it
 * without importing each other in a circle.
 */
import crypto from "crypto";
import path from "path";
import { promises as fs } from "fs";
import { EngineOutput } from "./engines";
import { buildKey, putObject } from "./storage";
import * as media from "./media";

export interface SaveAssetInput {
  tenantId: string;
  projectId?: string | null;
  kind: string;
  source: string;
  output: EngineOutput;
  createdByUserId?: string | null;
  expiresAt?: Date | null;
  license?: any;
}

/** Bytes to object storage, a row for the rest of the platform, a thumbnail. */
export async function saveOutputAsset(db: any, input: SaveAssetInput): Promise<any> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const key = buildKey({ tenantId: input.tenantId, kind: input.kind, assetId: id, name: input.output.name });
  const stored = await putObject(key, input.output.buffer, input.output.mime);

  let thumbKey: string | null = null;
  let durationMs = input.output.durationMs ?? null;
  let width = input.output.width ?? null;
  let height = input.output.height ?? null;

  if (input.kind === "image" || input.kind === "video") {
    try {
      await media.withTempDir(async (dir) => {
        const src = path.join(dir, media.tempName(input.kind === "video" ? "mp4" : "png"));
        await fs.writeFile(src, input.output.buffer);
        if (input.kind === "video") {
          const info = await media.probe(src).catch(() => null);
          if (info) {
            durationMs = info.durationMs || durationMs;
            width = info.width ?? width;
            height = info.height ?? height;
          }
        }
        const thumb = path.join(dir, media.tempName("jpg"));
        await media.thumbnail(src, thumb, input.kind === "video" ? 0.5 : 0);
        const bytes = await fs.readFile(thumb);
        const tKey = buildKey({ tenantId: input.tenantId, kind: input.kind, assetId: id, name: "thumb.jpg", variant: "thumb" });
        await putObject(tKey, bytes, "image/jpeg");
        thumbKey = tKey;
      });
    } catch {
      // A missing thumbnail is a cosmetic problem, never a failed render.
      thumbKey = null;
    }
  }

  return db.creativeAsset.create({
    data: {
      tenantId: input.tenantId,
      projectId: input.projectId || null,
      kind: input.kind,
      source: input.source,
      name: input.output.name,
      storageKey: stored.key,
      thumbKey,
      mime: input.output.mime,
      bytes: stored.bytes,
      width,
      height,
      durationMs,
      sha256: stored.sha256,
      scanStatus: "clean",
      license: input.license ?? { source: input.source === "generated" ? "generated" : input.source, commercialUse: true },
      meta: (input.output.meta as any) || undefined,
      createdByUserId: input.createdByUserId || null,
      expiresAt: input.expiresAt ?? null,
    },
  });
}

