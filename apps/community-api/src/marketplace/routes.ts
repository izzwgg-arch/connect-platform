import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { Prisma } from "../db.js";
import { env } from "../env.js";
import { requireActor } from "../auth/actor.js";
import { requireVerifiedActor } from "../auth/guards.js";
import { requireOrgPermission } from "../organizations/permissions.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { track } from "../lib/analytics.js";
import { buildSearchText, ftsIds } from "../lib/search.js";
import { isBlockedEitherWay, pairKey } from "../policy/graph.js";
import { sendMessage } from "../messaging/service.js";
import { personCard, personCards, type PersonCard } from "../profiles/cards.js";
import { orgCard, orgCards, type OrgCard } from "../organizations/cards.js";
import {
  AVAILABILITY_VALUES,
  CATEGORY_SEED,
  LISTING_TYPE_VALUES,
  MARKETPLACE_SORT_VALUES,
  buildCategoryTree,
  collectDescendantIds,
  ensureCategories,
  isVerifiedSellerOrg,
  sortListingRows,
} from "./policy.js";

const TypeIn = z.enum([...LISTING_TYPE_VALUES]);
const AvailabilityIn = z.enum([...AVAILABILITY_VALUES]);
const SortIn = z.enum([...MARKETPLACE_SORT_VALUES]);

const CreateListingSchema = z.object({
  type: TypeIn,
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(1).max(8000),
  categorySlug: z.string().trim().max(80).optional(),
  organizationId: z.string().trim().optional(),
  priceMin: z.coerce.number().nonnegative().optional(),
  priceMax: z.coerce.number().nonnegative().optional(),
  priceUnit: z.string().trim().max(40).optional(),
  minimumOrder: z.string().trim().max(120).optional(),
  turnaround: z.string().trim().max(120).optional(),
  delivery: z.string().trim().max(120).optional(),
  availability: AvailabilityIn.optional().default("AVAILABLE"),
  serviceArea: z.array(z.string().trim().max(80)).max(30).optional(),
  mediaAssetIds: z.array(z.string().trim()).max(10).optional(),
});

const PatchListingSchema = z.object({
  title: z.string().trim().min(3).max(160).optional(),
  description: z.string().trim().min(1).max(8000).optional(),
  categorySlug: z.string().trim().max(80).nullable().optional(),
  priceMin: z.coerce.number().nonnegative().nullable().optional(),
  priceMax: z.coerce.number().nonnegative().nullable().optional(),
  priceUnit: z.string().trim().max(40).nullable().optional(),
  minimumOrder: z.string().trim().max(120).nullable().optional(),
  turnaround: z.string().trim().max(120).nullable().optional(),
  delivery: z.string().trim().max(120).nullable().optional(),
  availability: AvailabilityIn.optional(),
  serviceArea: z.array(z.string().trim().max(80)).max(30).optional(),
});

const ListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: TypeIn.optional(),
  category: z.string().trim().max(80).optional(),
  verifiedOnly: z.string().optional(),
  area: z.string().trim().max(80).optional(),
  priceMax: z.coerce.number().nonnegative().optional(),
  sort: SortIn.optional().default("relevance"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

function mediaUrlFor(assetId: string, variant: "thumb" | "medium" | "original" = "medium"): string {
  return `${env().COMMUNITY_API_URL}/media/file/${assetId}/${variant}`;
}

function numStr(v: unknown): string | null {
  return v == null ? null : String(v);
}

function offsetOf(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function encodeOffset(n: number): string {
  return Buffer.from(String(n)).toString("base64url");
}

type ListingRow = Awaited<ReturnType<Db["listing"]["findFirst"]>> & { media: Array<{ assetId: string }> };

async function shapeListings(db: Db, rows: NonNullable<ListingRow>[], viewerId: string | null) {
  const orgIds = [...new Set(rows.map((r) => r.organizationId).filter((x): x is string => !!x))];
  const personIds = [...new Set(rows.map((r) => r.sellerPersonId).filter((x): x is string => !!x))];
  const [orgs, people, saved] = await Promise.all([
    orgCards(db, orgIds),
    personCards(db, personIds),
    viewerId ? db.listingSave.findMany({ where: { personId: viewerId, listingId: { in: rows.map((r) => r.id) } }, select: { listingId: true } }) : Promise.resolve([]),
  ]);
  const savedSet = new Set(saved.map((s) => s.listingId));
  return rows.map((r) => shapeOne(r, orgs, people, savedSet));
}

function shapeOne(
  r: NonNullable<ListingRow>,
  orgs: Map<string, OrgCard>,
  people: Map<string, PersonCard>,
  savedSet: Set<string>,
) {
  const org = r.organizationId ? orgs.get(r.organizationId) ?? null : null;
  const person = r.sellerPersonId ? people.get(r.sellerPersonId) ?? null : null;
  return {
    listing: {
      id: r.id,
      type: r.type,
      title: r.title,
      description: r.description,
      categoryId: r.categoryId,
      priceMin: numStr(r.priceMin),
      priceMax: numStr(r.priceMax),
      priceUnit: r.priceUnit,
      minimumOrder: r.minimumOrder,
      turnaround: r.turnaround,
      delivery: r.delivery,
      availability: r.availability,
      serviceArea: r.serviceArea,
      status: r.status,
      viewCount: r.viewCount,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    },
    seller: { organization: org, person: org ? null : person },
    media: (r.media ?? []).map((m) => ({ id: m.assetId, url: mediaUrlFor(m.assetId) })),
    verified: org ? isVerifiedSellerOrg(org.verified) : false,
    saved: savedSet.has(r.id),
  };
}

export async function registerMarketplaceRoutes(app: FastifyInstance, db: Db) {
  await ensureCategories(db);

  /* ───────────────────────────── Categories ───────────────────────────── */
  app.get("/marketplace/categories", async () => {
    const cats = await db.category.findMany({ orderBy: { sortOrder: "asc" } });
    const counts = await db.listing.groupBy({ by: ["categoryId"], where: { status: "ACTIVE", categoryId: { not: null } }, _count: { _all: true } });
    const countMap = new Map(counts.filter((c) => c.categoryId).map((c) => [c.categoryId as string, c._count._all]));
    const tree = buildCategoryTree(cats, countMap);
    return { categories: tree };
  });

  /* ───────────────────────────── Create ───────────────────────────── */
  app.post("/listings", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const input = CreateListingSchema.parse(req.body);

    let organizationId: string | null = null;
    let sellerPersonId: string | null = null;
    let ownerName = "";
    if (input.organizationId) {
      await requireOrgPermission(db, actor, input.organizationId, "org.manage_listings");
      organizationId = input.organizationId;
      const org = await orgCard(db, organizationId);
      ownerName = org?.displayName ?? "";
    } else {
      sellerPersonId = actor.personId;
      const card = await personCard(db, actor.personId);
      ownerName = card?.name ?? "";
    }

    let categoryId: string | null = null;
    let categoryName = "";
    if (input.categorySlug) {
      const cat = await db.category.findUnique({ where: { slug: input.categorySlug } });
      if (!cat) throw badRequest("category_not_found", "Choose a valid category.");
      categoryId = cat.id;
      categoryName = cat.name;
    }

    if (input.priceMin != null && input.priceMax != null && input.priceMin > input.priceMax) {
      throw badRequest("price_range", "The minimum price can't be higher than the maximum.");
    }

    if (input.mediaAssetIds?.length) {
      const assets = await db.mediaAsset.findMany({ where: { id: { in: input.mediaAssetIds } } });
      const byId = new Map(assets.map((a) => [a.id, a]));
      for (const id of input.mediaAssetIds) {
        const a = byId.get(id);
        if (!a || a.ownerId !== actor.personId) throw badRequest("asset_not_yours", "One of those photos isn't yours to attach.");
      }
    }

    const searchText = buildSearchText([input.title, input.description, categoryName, ownerName, input.serviceArea]);

    const listing = await db.listing.create({
      data: {
        sellerPersonId,
        organizationId,
        categoryId,
        type: input.type,
        title: input.title,
        description: input.description,
        priceMin: input.priceMin ?? null,
        priceMax: input.priceMax ?? null,
        priceUnit: input.priceUnit ?? null,
        minimumOrder: input.minimumOrder ?? null,
        turnaround: input.turnaround ?? null,
        delivery: input.delivery ?? null,
        availability: input.availability,
        serviceArea: input.serviceArea ?? [],
        searchText,
        media: input.mediaAssetIds?.length ? { create: input.mediaAssetIds.map((assetId, i) => ({ assetId, sortOrder: i })) } : undefined,
      },
      include: { media: true },
    });

    await audit(db, { actorId: actor.personId, action: "listing.create", targetType: "Listing", targetId: listing.id, organizationId, after: { title: listing.title, type: listing.type } });
    reply.status(201);
    const [shaped] = await shapeListings(db, [listing], actor.personId);
    return shaped;
  });

  /* ───────────────────────────── Browse ───────────────────────────── */
  app.get("/listings", async (req) => {
    const actor = requireActor(req);
    const q = ListQuerySchema.parse(req.query);
    const take = q.limit ?? 20;
    const offset = offsetOf(q.cursor);

    const where: Record<string, unknown> = { status: "ACTIVE" };
    if (q.type) where.type = q.type;
    if (q.area) where.serviceArea = { has: q.area };
    if (q.priceMax != null) where.OR = [{ priceMin: null }, { priceMin: { lte: q.priceMax } }];

    if (q.category) {
      const cat = await db.category.findUnique({ where: { slug: q.category } });
      if (!cat) return { items: [], nextCursor: null };
      const all = await db.category.findMany({ select: { id: true, parentId: true } });
      where.categoryId = { in: collectDescendantIds(all as any, cat.id) };
    }

    let rankedIds: string[] | null = null;
    if (q.q) {
      const rows = await ftsIds(db, "Listing", "id", q.q, 300, Prisma.sql`AND "status" = 'ACTIVE'`);
      rankedIds = rows.map((r) => r.id);
      if (!rankedIds.length) {
        await track(db, { personId: actor.personId, event: "marketplace_view", props: { q: q.q } });
        return { items: [], nextCursor: null };
      }
      where.id = { in: rankedIds };
    }

    if (q.verifiedOnly === "1" || q.verifiedOnly === "true") {
      const verifiedOrgIds = await db.verification.findMany({ where: { kind: "BUSINESS", status: "VERIFIED", organizationId: { not: null } }, select: { organizationId: true } });
      where.organizationId = { in: verifiedOrgIds.map((v) => v.organizationId as string) };
    }

    let rows = (await db.listing.findMany({ where: where as any, include: { media: true }, take: 500 })) as NonNullable<ListingRow>[];
    if (rankedIds) {
      const rank = new Map(rankedIds.map((id, i) => [id, i]));
      if (q.sort === "relevance") rows.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
      else rows = sortListingRows(rows as any, q.sort) as any;
    } else {
      rows = sortListingRows(rows as any, q.sort === "relevance" ? "newest" : q.sort) as any;
    }

    const page = rows.slice(offset, offset + take);
    const nextCursor = offset + take < rows.length ? encodeOffset(offset + take) : null;
    const items = await shapeListings(db, page, actor.personId);

    await track(db, { personId: actor.personId, event: "marketplace_view", props: q.q ? { q: q.q } : undefined });
    return { items, nextCursor };
  });

  /* ───────────────────────────── Mine ───────────────────────────── */
  app.get("/me/listings", async (req) => {
    const actor = requireActor(req);
    const myOrgIds = (await db.membership.findMany({ where: { personId: actor.personId }, select: { organizationId: true } })).map((m) => m.organizationId);
    const rows = (await db.listing.findMany({
      where: { OR: [{ sellerPersonId: actor.personId }, { organizationId: { in: myOrgIds } }] },
      include: { media: true },
      orderBy: { createdAt: "desc" },
    })) as NonNullable<ListingRow>[];
    const items = await shapeListings(db, rows, actor.personId);
    return { items };
  });

  app.get("/me/saved-listings", async (req) => {
    const actor = requireActor(req);
    const saves = await db.listingSave.findMany({ where: { personId: actor.personId }, orderBy: { createdAt: "desc" } });
    const rows = (await db.listing.findMany({ where: { id: { in: saves.map((s) => s.listingId) } }, include: { media: true } })) as NonNullable<ListingRow>[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = saves.map((s) => byId.get(s.listingId)).filter((r): r is NonNullable<ListingRow> => !!r);
    const items = await shapeListings(db, ordered, actor.personId);
    return { items };
  });

  /* ───────────────────────────── Single listing ───────────────────────────── */
  app.get("/public/listings/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const existing = await db.listing.findUnique({ where: { id } });
    if (!existing || existing.status === "REMOVED") throw notFound("That listing");
    const listing = (await db.listing.update({
      where: { id },
      data: { viewCount: { increment: 1 } },
      include: { media: true },
    })) as NonNullable<ListingRow>;
    await track(db, { personId: req.actor?.personId ?? null, event: "listing_view", objectType: "Listing", objectId: id });
    const [shaped] = await shapeListings(db, [listing], req.actor?.personId ?? null);
    return shaped;
  });

  async function loadListingForEdit(actorId: string, staffRole: string | null, id: string) {
    const listing = await db.listing.findUnique({ where: { id } });
    if (!listing || listing.status === "REMOVED") throw notFound("That listing");
    if (listing.organizationId) {
      await requireOrgPermission(db, { personId: actorId, staffRole } as any, listing.organizationId, "org.manage_listings");
    } else if (listing.sellerPersonId !== actorId && staffRole !== "ADMIN") {
      throw forbidden("You can only edit your own listing.");
    }
    return listing;
  }

  app.patch("/listings/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const before = await loadListingForEdit(actor.personId, actor.staffRole, id);
    const input = PatchListingSchema.parse(req.body);

    let categoryId = before.categoryId;
    let categoryName = "";
    if (input.categorySlug !== undefined) {
      if (input.categorySlug === null) categoryId = null;
      else {
        const cat = await db.category.findUnique({ where: { slug: input.categorySlug } });
        if (!cat) throw badRequest("category_not_found", "Choose a valid category.");
        categoryId = cat.id;
        categoryName = cat.name;
      }
    }
    if (input.priceMin !== undefined && input.priceMax !== undefined && input.priceMin != null && input.priceMax != null && input.priceMin > input.priceMax) {
      throw badRequest("price_range", "The minimum price can't be higher than the maximum.");
    }

    const ownerName = before.organizationId ? (await orgCard(db, before.organizationId))?.displayName ?? "" : (await personCard(db, before.sellerPersonId!))?.name ?? "";
    const searchText = buildSearchText([
      input.title ?? before.title,
      input.description ?? before.description,
      categoryName,
      ownerName,
      input.serviceArea ?? before.serviceArea,
    ]);

    const updated = (await db.listing.update({
      where: { id },
      data: {
        title: input.title,
        description: input.description,
        categoryId,
        priceMin: input.priceMin === undefined ? undefined : input.priceMin,
        priceMax: input.priceMax === undefined ? undefined : input.priceMax,
        priceUnit: input.priceUnit === undefined ? undefined : input.priceUnit,
        minimumOrder: input.minimumOrder === undefined ? undefined : input.minimumOrder,
        turnaround: input.turnaround === undefined ? undefined : input.turnaround,
        delivery: input.delivery === undefined ? undefined : input.delivery,
        availability: input.availability,
        serviceArea: input.serviceArea,
        searchText,
      },
      include: { media: true },
    })) as NonNullable<ListingRow>;

    await audit(db, { actorId: actor.personId, action: "listing.update", targetType: "Listing", targetId: id, organizationId: before.organizationId, before: { title: before.title }, after: { title: updated.title } });
    const [shaped] = await shapeListings(db, [updated], actor.personId);
    return shaped;
  });

  app.delete("/listings/:id", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const before = await loadListingForEdit(actor.personId, actor.staffRole, id);
    await db.listing.update({ where: { id }, data: { status: "REMOVED" } });
    await audit(db, { actorId: actor.personId, action: "listing.remove", targetType: "Listing", targetId: id, organizationId: before.organizationId });
    reply.status(204);
    return null;
  });

  app.post("/listings/:id/media", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const before = await loadListingForEdit(actor.personId, actor.staffRole, id);
    const { assetId } = z.object({ assetId: z.string() }).parse(req.body);
    const asset = await db.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.ownerId !== actor.personId) throw badRequest("asset_not_yours", "That photo isn't yours to attach.");
    const count = await db.listingMedia.count({ where: { listingId: id } });
    await db.listingMedia.create({ data: { listingId: id, assetId, sortOrder: count } });
    const updated = (await db.listing.findUnique({ where: { id: before.id }, include: { media: true } })) as NonNullable<ListingRow>;
    const [shaped] = await shapeListings(db, [updated], actor.personId);
    return shaped;
  });

  app.delete("/listings/:id/media/:mid", async (req, reply) => {
    const actor = requireActor(req);
    const { id, mid } = z.object({ id: z.string(), mid: z.string() }).parse(req.params);
    await loadListingForEdit(actor.personId, actor.staffRole, id);
    const media = await db.listingMedia.findUnique({ where: { id: mid } });
    if (!media || media.listingId !== id) throw notFound("That photo");
    await db.listingMedia.delete({ where: { id: mid } });
    reply.status(204);
    return null;
  });

  /* ───────────────────────────── Message the seller ───────────────────────────── */
  app.post("/listings/:id/message", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { body } = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body);
    const listing = await db.listing.findUnique({ where: { id } });
    if (!listing || listing.status === "REMOVED") throw notFound("That listing");

    let sellerId: string;
    if (listing.organizationId) {
      const owner = await db.membership.findFirst({ where: { organizationId: listing.organizationId, role: "OWNER" }, orderBy: { createdAt: "asc" } });
      if (!owner) throw notFound("That listing");
      sellerId = owner.personId;
    } else {
      sellerId = listing.sellerPersonId!;
    }
    if (sellerId === actor.personId) throw badRequest("cant_message_self", "That's your own listing.");
    if (await isBlockedEitherWay(db, actor.personId, sellerId)) throw notFound("That listing");

    const key = pairKey(actor.personId, sellerId);
    let thread = await db.thread.findUnique({ where: { pairKey: key } });
    if (!thread) {
      thread = await db.thread.create({
        data: {
          kind: "DIRECT",
          pairKey: key,
          refType: "Listing",
          refId: listing.id,
          createdById: actor.personId,
          participants: { create: [{ personId: actor.personId, state: "ACTIVE", role: "MEMBER" }, { personId: sellerId, state: "ACTIVE", role: "MEMBER" }] },
        },
      });
    }
    await sendMessage(db, actor.personId, thread.id, { kind: "TEXT", body, refType: "Listing", refId: listing.id });
    await notify(db, {
      personId: sellerId,
      kind: "inquiry.business",
      title: "New inquiry about your listing",
      body: `About "${listing.title}"`,
      href: `/marketplace/${listing.id}`,
      actorId: actor.personId,
      objectType: "Listing",
      objectId: listing.id,
    });
    return { threadId: thread.id };
  });

  /* ───────────────────────────── Save / unsave ───────────────────────────── */
  app.post("/listings/:id/save", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const listing = await db.listing.findUnique({ where: { id } });
    if (!listing || listing.status === "REMOVED") throw notFound("That listing");
    await db.listingSave.upsert({ where: { personId_listingId: { personId: actor.personId, listingId: id } }, create: { personId: actor.personId, listingId: id }, update: {} });
    await track(db, { personId: actor.personId, event: "save", objectType: "Listing", objectId: id });
    reply.status(201);
    return { saved: true };
  });

  app.delete("/listings/:id/save", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await db.listingSave.deleteMany({ where: { personId: actor.personId, listingId: id } });
    reply.status(204);
    return null;
  });
}
