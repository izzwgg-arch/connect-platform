import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { requireActor } from "../auth/actor.js";
import { badRequest, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { storage } from "../lib/storage.js";
import { storeUpload, toStored, verifyMediaSignature, type AssetKind } from "./service.js";

const VARIANTS = ["thumb", "medium", "original"] as const;
const KINDS: AssetKind[] = ["image", "video", "document", "audio"];

/**
 * Media domain: upload (multipart), serve by variant (public cached / private
 * signed), owner metadata + delete, and the owner's own media library.
 */
export function registerMediaRoutes(app: FastifyInstance, db: Db) {
  // ── upload ────────────────────────────────────────────────────────────
  app.post("/media", { config: { rateLimit: { max: 60, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const actor = requireActor(req);
    let buffer: Buffer | null = null;
    let filename: string | undefined;
    let mimetype: string | undefined;
    let isPrivate = false;
    let allow: AssetKind[] | undefined;
    for await (const part of req.parts()) {
      if (part.type === "file" && part.fieldname === "file") {
        buffer = await part.toBuffer();
        filename = part.filename;
        mimetype = part.mimetype;
      } else if (part.type === "field") {
        if (part.fieldname === "private") isPrivate = ["1", "true", "yes"].includes(String(part.value).toLowerCase());
        if (part.fieldname === "kind") {
          const wanted = String(part.value)
            .split(",")
            .map((s) => s.trim())
            .filter((s): s is AssetKind => (KINDS as string[]).includes(s));
          if (wanted.length) allow = wanted;
        }
      }
    }
    if (!buffer) throw badRequest("file_required", "Choose a file to upload.");
    const asset = await storeUpload(db, actor.personId, { buffer, filename, mimetype }, { isPrivate, allow });
    return reply.status(201).send({ asset });
  });

  // ── serve a variant ──────────────────────────────────────────────────
  // Public in PUBLIC_PREFIXES: anonymous readers may fetch public assets;
  // private assets need a valid signed URL or the owner's own bearer token.
  app.get("/media/file/:id/:variant", async (req, reply) => {
    const { id, variant } = z.object({ id: z.string(), variant: z.enum(VARIANTS) }).parse(req.params);
    const asset = await db.mediaAsset.findUnique({ where: { id } });
    if (!asset || asset.status !== "READY") throw notFound("File");
    if (asset.isPrivate) {
      const { exp, sig } = req.query as Record<string, string | undefined>;
      const signed = verifyMediaSignature(id, variant, exp, sig);
      const owner = !!req.actor && req.actor.personId === asset.ownerId;
      if (!signed && !owner) throw notFound("File");
    }
    const variants = (asset.variants as Record<string, string> | null) ?? {};
    // Non-image kinds only ever have `original` — every other variant maps to it.
    const key = variants[variant] ?? variants.original ?? asset.storageKey;
    if (!key) throw notFound("File");
    let bytes: Buffer;
    try {
      bytes = await storage().get(key);
    } catch {
      throw notFound("File");
    }
    reply.header("content-type", asset.mime);
    reply.header("cache-control", asset.isPrivate ? "private, no-store" : "public, max-age=31536000, immutable");
    return reply.send(bytes);
  });

  // ── owner metadata ───────────────────────────────────────────────────
  app.get("/media/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const asset = await db.mediaAsset.findUnique({ where: { id } });
    if (!asset || (asset.ownerId !== actor.personId && !actor.staffRole)) throw notFound("Asset");
    return { asset: toStored(asset) };
  });

  // ── delete ───────────────────────────────────────────────────────────
  app.delete("/media/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const asset = await db.mediaAsset.findUnique({ where: { id } });
    if (!asset || asset.ownerId !== actor.personId) throw notFound("Asset");
    const variants = (asset.variants as Record<string, string> | null) ?? {};
    const keys = new Set(Object.values(variants));
    if (asset.storageKey) keys.add(asset.storageKey);
    await Promise.all([...keys].map((k) => storage().remove(k)));
    await db.mediaAsset.delete({ where: { id } });
    await audit(db, { actorId: actor.personId, action: "media.deleted", targetType: "MediaAsset", targetId: id });
    return { ok: true };
  });

  // ── owner's media library ────────────────────────────────────────────
  app.get("/me/media", async (req) => {
    const actor = requireActor(req);
    const q = z.object({ cursor: z.string().optional(), limit: z.any().optional() }).parse(req.query);
    const cur = decodeCursor(q.cursor);
    const take = clampLimit(q.limit);
    const rows = await db.mediaAsset.findMany({
      where: {
        ownerId: actor.personId,
        status: "READY",
        ...(cur ? { OR: [{ createdAt: { lt: new Date(cur.value) } }, { createdAt: new Date(cur.value), id: { lt: cur.id } }] } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
    });
    const page = rows.slice(0, take);
    const nextCursor = rows.length > take ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null;
    return { items: page.map(toStored), nextCursor };
  });
}
