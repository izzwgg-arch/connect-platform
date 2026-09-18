import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { env } from "../env.js";
import { addJob } from "../core/schedulers.js";
import { requireActor, type Actor } from "../auth/actor.js";
import { requireVerifiedActor } from "../auth/guards.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { track } from "../lib/analytics.js";
import { buildSearchText } from "../lib/search.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { signMediaUrl } from "../media/service.js";
import { personCard, personCards } from "../profiles/cards.js";
import { orgCard, orgCards } from "../organizations/cards.js";
import { hasOrgPermission, permissionsForMembership, requireOrgPermission } from "../organizations/permissions.js";
import { extractRfq } from "./extract.js";
import { matchVendors } from "./matching.js";
import { CATEGORY_SEED, canViewRfq, defaultClosesAt, formatRfqNumber, isOpenForQuoting, mergeExtracted } from "./policy.js";

/* ── small helpers ──────────────────────────────────────────────────────── */

function assetUrl(asset: { id: string; isPrivate: boolean }): string {
  if (asset.isPrivate) return signMediaUrl(asset.id, "original");
  return `${env().COMMUNITY_API_URL}/media/file/${asset.id}/original`;
}

async function ensureCategories(db: Db) {
  for (const cat of CATEGORY_SEED.filter((c) => !c.parentSlug)) {
    await db.category.upsert({
      where: { slug: cat.slug },
      create: { slug: cat.slug, name: cat.name, kind: "MARKETPLACE", sortOrder: cat.sortOrder },
      update: { name: cat.name, sortOrder: cat.sortOrder },
    });
  }
  for (const cat of CATEGORY_SEED.filter((c) => c.parentSlug)) {
    const parent = await db.category.findUnique({ where: { slug: cat.parentSlug! } });
    await db.category.upsert({
      where: { slug: cat.slug },
      create: { slug: cat.slug, name: cat.name, kind: "MARKETPLACE", sortOrder: cat.sortOrder, parentId: parent?.id ?? null },
      update: { name: cat.name, sortOrder: cat.sortOrder, parentId: parent?.id ?? null },
    });
  }
}

async function nextRfqNumber(db: Db): Promise<string> {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 8; attempt++) {
    const count = await db.rfq.count({ where: { number: { startsWith: `RFQ-${year}-` } } });
    const number = formatRfqNumber(year, count + 1 + attempt);
    const exists = await db.rfq.findUnique({ where: { number } });
    if (!exists) return number;
  }
  return formatRfqNumber(year, Date.now());
}

/** Members of an org who hold org.quote (verified affiliation only — pending invites can't quote yet). */
async function quoteHolders(db: Db, organizationId: string): Promise<string[]> {
  const members = await db.membership.findMany({ where: { organizationId, affiliation: { in: ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"] } } });
  return members.filter((m) => permissionsForMembership(m).has("org.quote")).map((m) => m.personId);
}

type QuoteRow = Awaited<ReturnType<Db["quote"]["findUnique"]>>;
type RfqRow = NonNullable<Awaited<ReturnType<Db["rfq"]["findUnique"]>>>;

async function quoteDto(db: Db, quote: NonNullable<QuoteRow>) {
  const [org, attachmentRows] = await Promise.all([orgCard(db, quote.organizationId), db.quoteAttachment.findMany({ where: { quoteId: quote.id } })]);
  const assets = attachmentRows.length ? await db.mediaAsset.findMany({ where: { id: { in: attachmentRows.map((a) => a.assetId) } } }) : [];
  return {
    id: quote.id,
    rfqId: quote.rfqId,
    organization: org,
    authorId: quote.authorId,
    total: quote.total.toString(),
    currency: quote.currency,
    perUnit: quote.perUnit ? quote.perUnit.toString() : null,
    deliveryDate: quote.deliveryDate ? quote.deliveryDate.toISOString() : null,
    validUntil: quote.validUntil ? quote.validUntil.toISOString() : null,
    notes: quote.notes,
    alternateProposal: quote.alternateProposal,
    status: quote.status,
    version: quote.version,
    threadId: quote.threadId,
    attachments: assets.map((a) => ({ id: a.id, url: assetUrl(a), mime: a.mime, kind: a.kind, originalName: a.originalName })),
    createdAt: quote.createdAt.toISOString(),
    updatedAt: quote.updatedAt.toISOString(),
  };
}

async function rfqSummary(db: Db, id: string, preloaded?: RfqRow | null) {
  const rfq = preloaded ?? (await db.rfq.findUnique({ where: { id } }));
  if (!rfq) return null;
  const category = rfq.categoryId ? await db.category.findUnique({ where: { id: rfq.categoryId } }) : null;
  return {
    id: rfq.id,
    number: rfq.number,
    title: rfq.title,
    description: rfq.description,
    status: rfq.status,
    visibility: rfq.visibility,
    category: category ? { id: category.id, slug: category.slug, name: category.name } : null,
    quantity: rfq.quantity,
    budgetMin: rfq.budgetMin ? rfq.budgetMin.toString() : null,
    budgetMax: rfq.budgetMax ? rfq.budgetMax.toString() : null,
    location: rfq.location,
    deadline: rfq.deadline ? rfq.deadline.toISOString() : null,
    closesAt: rfq.closesAt ? rfq.closesAt.toISOString() : null,
    quoteCount: rfq.quoteCount,
    buyerPersonId: rfq.buyerPersonId,
    organizationId: rfq.organizationId,
    createdAt: rfq.createdAt.toISOString(),
  };
}

const TIMELINE_LABELS: Record<string, (r: { after: any; organizationId: string | null }, orgName: string) => string> = {
  "rfq.invites_sent": (r) => `${r.after?.count ?? 0} vendors notified`,
  "rfq.edit": () => "Request edited",
  "rfq.quote_submitted": (_r, name) => `${name} quoted`,
  "rfq.quote_shortlisted": (_r, name) => `${name} shortlisted`,
  "rfq.quote_declined": (_r, name) => `${name} declined`,
  "rfq.quote_withdrawn": (_r, name) => `${name} withdrew their quote`,
  "rfq.accepted": (_r, name) => `${name} accepted`,
  "rfq.closed": () => "Closed",
  "rfq.cancelled": () => "Cancelled",
  "rfq.auto_closed": () => "Closed automatically",
};

async function buildTimeline(db: Db, rfqId: string, createdAt: Date) {
  const rows = await db.auditLog.findMany({ where: { targetType: "Rfq", targetId: rfqId, action: { notIn: ["rfq.create", "rfq.closing_notified"] } }, orderBy: { createdAt: "asc" } });
  const orgIds = [...new Set(rows.map((r) => r.organizationId).filter((x): x is string => !!x))];
  const cards = orgIds.length ? await orgCards(db, orgIds) : new Map();
  const items = [{ label: "Published", at: createdAt.toISOString() }];
  for (const r of rows) {
    const name = r.organizationId ? (cards.get(r.organizationId)?.displayName ?? "A vendor") : "";
    const fn = TIMELINE_LABELS[r.action];
    items.push({ label: fn ? fn(r as any, name) : r.action, at: r.createdAt.toISOString() });
  }
  return items;
}

async function rfqDetail(db: Db, rfq: RfqRow, actor: Actor | null) {
  const [category, attachmentRows, invites, quotesRaw, questionsRaw, buyerCard, buyerOrgCard] = await Promise.all([
    rfq.categoryId ? db.category.findUnique({ where: { id: rfq.categoryId } }) : null,
    db.rfqAttachment.findMany({ where: { rfqId: rfq.id } }),
    db.rfqInvite.findMany({ where: { rfqId: rfq.id } }),
    db.quote.findMany({ where: { rfqId: rfq.id }, orderBy: { createdAt: "asc" } }),
    db.rfqQuestion.findMany({ where: { rfqId: rfq.id }, orderBy: { createdAt: "asc" } }),
    personCard(db, rfq.buyerPersonId),
    rfq.organizationId ? orgCard(db, rfq.organizationId) : null,
  ]);
  const assetIds = attachmentRows.map((a) => a.assetId);
  const assets = assetIds.length ? await db.mediaAsset.findMany({ where: { id: { in: assetIds } } }) : [];
  const attachments = assets.map((a) => ({ id: a.id, url: assetUrl(a), mime: a.mime, kind: a.kind, originalName: a.originalName }));

  const myMemberships = actor ? await db.membership.findMany({ where: { personId: actor.personId } }) : [];
  const myOrgIds = myMemberships.map((m) => m.organizationId);
  const isBuyer = actor?.personId === rfq.buyerPersonId;
  const isStaff = !!actor?.staffRole;
  const isInvitedOrgMember = myOrgIds.some((id) => invites.some((i) => i.organizationId === id));

  const visibleQuotes = isBuyer || isStaff ? quotesRaw : quotesRaw.filter((q) => myOrgIds.includes(q.organizationId));
  const quotes = await Promise.all(visibleQuotes.map((q) => quoteDto(db, q)));

  const visibleQuestions = questionsRaw.filter((q) => isBuyer || isStaff || q.isPublic || myOrgIds.includes(q.organizationId));
  const askerCards = await personCards(db, [...new Set(visibleQuestions.map((q) => q.askedById))]);
  const questionOrgCards = await orgCards(db, [...new Set(visibleQuestions.map((q) => q.organizationId))]);
  const questions = visibleQuestions.map((q) => ({
    id: q.id,
    rfqId: q.rfqId,
    organization: questionOrgCards.get(q.organizationId) ?? null,
    askedBy: askerCards.get(q.askedById) ?? null,
    question: q.question,
    answer: q.answer,
    answeredAt: q.answeredAt ? q.answeredAt.toISOString() : null,
    isPublic: q.isPublic,
    createdAt: q.createdAt.toISOString(),
  }));

  const stats = { invited: invites.length, viewed: invites.filter((i) => i.viewedAt).length, quoted: rfq.quoteCount, declined: invites.filter((i) => i.declinedAt).length };
  const timeline = await buildTimeline(db, rfq.id, rfq.createdAt);

  let myOrgOptions: Array<{ id: string; slug: string; displayName: string } | undefined> = [];
  if (actor) {
    const eligible = myMemberships.filter((m) => ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"].includes(m.affiliation) && permissionsForMembership(m).has("org.quote"));
    const cards = await orgCards(db, eligible.map((m) => m.organizationId));
    myOrgOptions = eligible.map((m) => cards.get(m.organizationId)).filter(Boolean);
  }

  return {
    id: rfq.id,
    number: rfq.number,
    title: rfq.title,
    description: rfq.description,
    status: rfq.status,
    visibility: rfq.visibility,
    category: category ? { id: category.id, slug: category.slug, name: category.name } : null,
    quantity: rfq.quantity,
    budgetMin: rfq.budgetMin ? rfq.budgetMin.toString() : null,
    budgetMax: rfq.budgetMax ? rfq.budgetMax.toString() : null,
    location: rfq.location,
    deadline: rfq.deadline ? rfq.deadline.toISOString() : null,
    requirements: rfq.requirements,
    extracted: rfq.extracted,
    extractionConfirmed: rfq.extractionConfirmed,
    closesAt: rfq.closesAt ? rfq.closesAt.toISOString() : null,
    createdAt: rfq.createdAt.toISOString(),
    buyer: buyerCard,
    organization: buyerOrgCard,
    attachments,
    stats,
    quotes,
    questions,
    timeline,
    myRole: isBuyer ? "buyer" : isInvitedOrgMember ? "vendor" : "visitor",
    myOrgOptions,
    canEdit: isBuyer && rfq.status === "OPEN",
  };
}

/* ── zod bodies ─────────────────────────────────────────────────────────── */

const createRfqSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(3).max(8000),
  categorySlug: z.string().trim().max(80).optional(),
  quantity: z.string().trim().max(120).optional(),
  budgetMin: z.coerce.number().nonnegative().optional(),
  budgetMax: z.coerce.number().nonnegative().optional(),
  location: z.string().trim().max(160).optional(),
  deadline: z.coerce.date().optional(),
  requirements: z.array(z.string().trim().max(400)).max(20).optional(),
  attachmentAssetIds: z.array(z.string()).max(10).optional(),
  organizationId: z.string().optional(),
  closesAt: z.coerce.date().optional(),
  visibility: z.enum(["MATCHED", "PUBLIC"]).optional(),
  inviteOrganizationIds: z.array(z.string()).max(50).optional(),
});

const quoteSchema = z.object({
  organizationId: z.string(),
  total: z.coerce.number().positive(),
  perUnit: z.coerce.number().nonnegative().optional(),
  deliveryDate: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
  notes: z.string().trim().max(4000).optional(),
  alternateProposal: z.string().trim().max(4000).optional(),
  attachmentAssetIds: z.array(z.string()).max(10).optional(),
});

async function assertOwnedAssets(db: Db, personId: string, assetIds: string[] | undefined) {
  if (!assetIds?.length) return;
  const assets = await db.mediaAsset.findMany({ where: { id: { in: assetIds } } });
  if (assets.length !== assetIds.length || assets.some((a) => a.ownerId !== personId)) {
    throw badRequest("asset_not_yours", "One of those attachments isn't yours.");
  }
}

/* ── scheduler job ──────────────────────────────────────────────────────── */

export async function rfqClosingSweep(db: Db) {
  const now = new Date();
  const soon = new Date(now.getTime() + 24 * 3600_000);

  const closingSoon = await db.rfq.findMany({ where: { status: { in: ["OPEN", "SHORTLISTING"] }, closesAt: { gte: now, lte: soon } } });
  for (const rfq of closingSoon) {
    const already = await db.auditLog.findFirst({ where: { targetType: "Rfq", targetId: rfq.id, action: "rfq.closing_notified" } });
    if (already) continue;
    const invites = await db.rfqInvite.findMany({ where: { rfqId: rfq.id, declinedAt: null } });
    const quotedOrgIds = new Set((await db.quote.findMany({ where: { rfqId: rfq.id }, select: { organizationId: true } })).map((q) => q.organizationId));
    for (const inv of invites) {
      if (quotedOrgIds.has(inv.organizationId)) continue;
      const holders = await quoteHolders(db, inv.organizationId);
      for (const personId of holders) {
        await notify(db, { personId, kind: "rfq.closing", title: "A request you were invited to is closing soon", body: rfq.title, href: `/rfq/${rfq.id}`, objectType: "Rfq", objectId: rfq.id, groupKey: `rfq-closing:${rfq.id}` });
      }
    }
    await audit(db, { action: "rfq.closing_notified", targetType: "Rfq", targetId: rfq.id, source: "scheduler" });
  }

  const overdue = await db.rfq.findMany({ where: { status: { in: ["OPEN", "SHORTLISTING"] }, closesAt: { lt: now } } });
  for (const rfq of overdue) {
    if (rfq.acceptedQuoteId) continue;
    await db.rfq.update({ where: { id: rfq.id }, data: { status: "CLOSED" } });
    await notify(db, { personId: rfq.buyerPersonId, kind: "rfq.decision", title: "Your request closed automatically", body: `${rfq.title} passed its closing date with no quote accepted.`, href: `/rfq/${rfq.id}`, objectType: "Rfq", objectId: rfq.id });
    await audit(db, { action: "rfq.auto_closed", targetType: "Rfq", targetId: rfq.id, source: "scheduler" });
  }
}

/* ── routes ─────────────────────────────────────────────────────────────── */

export async function registerRfqRoutes(app: FastifyInstance, db: Db) {
  await ensureCategories(db);

  app.get("/rfq/categories", async () => {
    const rows = await db.category.findMany({ where: { kind: "MARKETPLACE" }, orderBy: [{ sortOrder: "asc" }] });
    return { categories: rows.map((c) => ({ id: c.id, slug: c.slug, name: c.name, parentId: c.parentId })) };
  });

  app.post("/rfq/preview", async (req) => {
    await requireVerifiedActor(req, db);
    const body = z.object({ title: z.string().trim().max(200).optional(), description: z.string().trim().max(8000).optional() }).parse(req.body ?? {});
    const extracted = extractRfq(`${body.title ?? ""}\n${body.description ?? ""}`);
    return { extracted };
  });

  app.post("/rfq", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const body = createRfqSchema.parse(req.body);
    await assertOwnedAssets(db, actor.personId, body.attachmentAssetIds);

    if (body.organizationId) {
      const m = await db.membership.findUnique({ where: { personId_organizationId: { personId: actor.personId, organizationId: body.organizationId } } });
      if (!m) throw forbidden("You're not a member of that company.");
    }

    const extracted = extractRfq(`${body.title}\n${body.description}`);
    const explicit: Record<string, unknown> = {
      quantity: body.quantity,
      budgetMin: body.budgetMin,
      budgetMax: body.budgetMax,
      location: body.location,
      deadline: body.deadline ? body.deadline.toISOString().slice(0, 10) : undefined,
      requirements: body.requirements,
      categorySlug: body.categorySlug,
    };
    const extractedForMerge: Record<string, unknown> = {
      quantity: extracted.quantity ?? undefined,
      budgetMin: extracted.budgetMin ?? undefined,
      budgetMax: extracted.budgetMax ?? undefined,
      location: extracted.location ?? undefined,
      deadline: extracted.deadline ?? undefined,
      requirements: extracted.requirements.length ? extracted.requirements : undefined,
      categorySlug: extracted.categorySlug ?? undefined,
    };
    const { merged, fromExtraction } = mergeExtracted(explicit, extractedForMerge);

    const category = merged.categorySlug ? await db.category.findUnique({ where: { slug: merged.categorySlug as string } }) : null;
    const deadlineDate = merged.deadline ? new Date(`${merged.deadline}T00:00:00.000Z`) : null;
    const closesAt = body.closesAt ?? defaultClosesAt(deadlineDate);
    const number = await nextRfqNumber(db);

    const rfq = await db.rfq.create({
      data: {
        number,
        buyerPersonId: actor.personId,
        organizationId: body.organizationId ?? null,
        categoryId: category?.id ?? null,
        title: body.title,
        description: body.description,
        quantity: (merged.quantity as string | undefined) ?? null,
        budgetMin: merged.budgetMin != null ? (merged.budgetMin as number) : null,
        budgetMax: merged.budgetMax != null ? (merged.budgetMax as number) : null,
        location: (merged.location as string | undefined) ?? null,
        deadline: deadlineDate,
        requirements: (merged.requirements as string[] | undefined) ?? [],
        extracted: extracted as unknown as object,
        extractionConfirmed: fromExtraction.length === 0,
        closesAt,
        visibility: body.visibility ?? "MATCHED",
        searchText: buildSearchText([body.title, body.description, (merged.location as string | undefined) ?? null, category?.name ?? null]),
      },
    });

    if (body.attachmentAssetIds?.length) {
      await db.rfqAttachment.createMany({ data: body.attachmentAssetIds.map((assetId) => ({ rfqId: rfq.id, assetId })) });
    }

    const matched = await matchVendors(db, {
      title: body.title,
      description: body.description,
      categorySlug: category?.slug ?? null,
      location: (merged.location as string | undefined) ?? null,
      buyerPersonId: actor.personId,
    });
    const inviteMap = new Map<string, string>();
    for (const m of matched) inviteMap.set(m.organizationId, m.reason);
    for (const id of new Set(body.inviteOrganizationIds ?? [])) inviteMap.set(id, "invited directly");

    if (inviteMap.size) {
      await db.rfqInvite.createMany({ data: [...inviteMap].map(([organizationId, reason]) => ({ rfqId: rfq.id, organizationId, reason })), skipDuplicates: true });
      // Everyone who may quote at any invited org, in one query; notifications fan out in parallel batches.
      const holders = await db.membership.findMany({
        where: { organizationId: { in: [...inviteMap.keys()] }, affiliation: { in: ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"] } },
        select: { personId: true, organizationId: true, role: true, permissions: true },
      });
      const targets = holders.filter((m) => permissionsForMembership(m).has("org.quote"));
      for (let i = 0; i < targets.length; i += 10) {
        await Promise.all(
          targets.slice(i, i + 10).map((m) =>
            notify(db, { personId: m.personId, kind: "rfq.invite", title: "New request for a quote", body: rfq.title, href: `/rfq/${rfq.id}`, actorId: actor.personId, objectType: "Rfq", objectId: rfq.id, groupKey: `rfq-invite:${m.organizationId}` }),
          ),
        );
      }
    }

    await audit(db, { actorId: actor.personId, action: "rfq.create", targetType: "Rfq", targetId: rfq.id, after: { title: rfq.title, number: rfq.number } });
    if (inviteMap.size) await audit(db, { actorId: actor.personId, action: "rfq.invites_sent", targetType: "Rfq", targetId: rfq.id, after: { count: inviteMap.size } });
    await track(db, { personId: actor.personId, event: "rfq_created", objectType: "Rfq", objectId: rfq.id, props: { categorySlug: category?.slug ?? null } });

    reply.status(201);
    return { rfq: await rfqSummary(db, rfq.id, rfq), invitedCount: inviteMap.size, extracted };
  });

  app.post("/rfq/:id/confirm-extraction", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        quantity: z.string().trim().max(120).nullable().optional(),
        budgetMin: z.coerce.number().nonnegative().nullable().optional(),
        budgetMax: z.coerce.number().nonnegative().nullable().optional(),
        location: z.string().trim().max(160).nullable().optional(),
        deadline: z.coerce.date().nullable().optional(),
        requirements: z.array(z.string().trim().max(400)).max(20).optional(),
        categorySlug: z.string().trim().max(80).nullable().optional(),
      })
      .parse(req.body ?? {});
    const rfq = await db.rfq.findUnique({ where: { id } });
    if (!rfq) throw notFound("That request");
    if (rfq.buyerPersonId !== actor.personId) throw forbidden("Only the buyer can confirm this request's details.");

    let categoryId = rfq.categoryId;
    if (body.categorySlug !== undefined) {
      categoryId = body.categorySlug ? ((await db.category.findUnique({ where: { slug: body.categorySlug } }))?.id ?? null) : null;
    }
    const updated = await db.rfq.update({
      where: { id },
      data: {
        quantity: body.quantity !== undefined ? body.quantity : undefined,
        budgetMin: body.budgetMin !== undefined ? body.budgetMin : undefined,
        budgetMax: body.budgetMax !== undefined ? body.budgetMax : undefined,
        location: body.location !== undefined ? body.location : undefined,
        deadline: body.deadline !== undefined ? body.deadline : undefined,
        requirements: body.requirements !== undefined ? body.requirements : undefined,
        categoryId,
        extractionConfirmed: true,
      },
    });
    return { rfq: await rfqSummary(db, updated.id, updated) };
  });

  app.get("/rfq", async (req) => {
    const actor = requireActor(req);
    const { role, cursor, limit } = z.object({ role: z.enum(["buyer", "vendor"]).optional(), cursor: z.string().optional(), limit: z.coerce.number().optional() }).parse(req.query);
    const lim = clampLimit(limit);
    const cur = decodeCursor(cursor ?? null);

    if ((role ?? "buyer") === "buyer") {
      const where: any = { buyerPersonId: actor.personId };
      if (cur) where.createdAt = { lt: new Date(cur.value) };
      const rows = await db.rfq.findMany({ where, orderBy: { createdAt: "desc" }, take: lim + 1 });
      const page = rows.slice(0, lim);
      const items = await Promise.all(page.map((r) => rfqSummary(db, r.id, r)));
      return { items, nextCursor: rows.length > lim ? encodeCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id) : null };
    }

    const orgIds = (await db.membership.findMany({ where: { personId: actor.personId }, select: { organizationId: true } })).map((m) => m.organizationId);
    if (!orgIds.length) return { items: [], nextCursor: null };
    const where: any = { organizationId: { in: orgIds } };
    if (cur) where.createdAt = { lt: new Date(cur.value) };
    const invites = await db.rfqInvite.findMany({ where, orderBy: { createdAt: "desc" }, take: lim + 1, include: { rfq: true } });
    const page = invites.slice(0, lim);
    const items = await Promise.all(page.map(async (inv) => ({ ...(await rfqSummary(db, inv.rfq.id, inv.rfq)), organizationId: inv.organizationId, viewedAt: inv.viewedAt, declinedAt: inv.declinedAt })));
    return { items, nextCursor: invites.length > lim ? encodeCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.rfqId) : null };
  });

  app.get("/rfq/inbox", async (req) => {
    const actor = requireActor(req);
    const memberships = await db.membership.findMany({ where: { personId: actor.personId, affiliation: { in: ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"] } } });
    const orgIds = memberships.filter((m) => permissionsForMembership(m).has("org.quote")).map((m) => m.organizationId);
    if (!orgIds.length) return { items: [] };
    const invites = await db.rfqInvite.findMany({
      where: { organizationId: { in: orgIds }, declinedAt: null, rfq: { status: { in: ["OPEN", "SHORTLISTING"] } } },
      include: { rfq: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const items = await Promise.all(invites.map(async (inv) => ({ ...(await rfqSummary(db, inv.rfq.id, inv.rfq)), organizationId: inv.organizationId, viewedAt: inv.viewedAt })));
    return { items };
  });

  app.get("/public/rfqs", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().optional() }).parse(req.query);
    const lim = clampLimit(limit, 10, 50);
    const rows = await db.rfq.findMany({ where: { visibility: "PUBLIC", status: "OPEN" }, orderBy: { createdAt: "desc" }, take: lim });
    return { items: await Promise.all(rows.map((r) => rfqSummary(db, r.id, r))) };
  });

  async function loadForView(id: string, actor: Actor | null): Promise<RfqRow> {
    const rfq = await db.rfq.findUnique({ where: { id } });
    if (!rfq) throw notFound("That request");
    const isBuyer = actor?.personId === rfq.buyerPersonId;
    let isInvitedOrgMember = false;
    if (actor && !isBuyer) {
      const orgIds = (await db.membership.findMany({ where: { personId: actor.personId }, select: { organizationId: true } })).map((m) => m.organizationId);
      if (orgIds.length) isInvitedOrgMember = !!(await db.rfqInvite.findFirst({ where: { rfqId: id, organizationId: { in: orgIds } } }));
    }
    if (!canViewRfq({ visibility: rfq.visibility, isBuyer, isInvitedOrgMember, isStaff: !!actor?.staffRole })) throw notFound("That request");
    return rfq;
  }

  app.get("/public/rfq/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const rfq = await loadForView(id, req.actor);
    return rfqDetail(db, rfq, req.actor);
  });

  app.get("/rfq/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const rfq = await loadForView(id, actor);
    return rfqDetail(db, rfq, actor);
  });

  app.patch("/rfq/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        title: z.string().trim().min(3).max(200).optional(),
        description: z.string().trim().min(3).max(8000).optional(),
        quantity: z.string().trim().max(120).nullable().optional(),
        budgetMin: z.coerce.number().nonnegative().nullable().optional(),
        budgetMax: z.coerce.number().nonnegative().nullable().optional(),
        location: z.string().trim().max(160).nullable().optional(),
        deadline: z.coerce.date().nullable().optional(),
        requirements: z.array(z.string().trim().max(400)).max(20).optional(),
        closesAt: z.coerce.date().optional(),
        visibility: z.enum(["MATCHED", "PUBLIC"]).optional(),
      })
      .parse(req.body ?? {});
    const rfq = await db.rfq.findUnique({ where: { id } });
    if (!rfq) throw notFound("That request");
    if (rfq.buyerPersonId !== actor.personId) throw forbidden("Only the buyer can edit this request.");
    if (rfq.status !== "OPEN") throw badRequest("rfq_not_open", "You can only edit a request while it's open.");
    const updated = await db.rfq.update({
      where: { id },
      data: { ...body, searchText: buildSearchText([body.title ?? rfq.title, body.description ?? rfq.description, body.location !== undefined ? body.location : rfq.location]) },
    });
    await audit(db, { actorId: actor.personId, action: "rfq.edit", targetType: "Rfq", targetId: id, before: { title: rfq.title }, after: { title: updated.title } });
    return { rfq: await rfqSummary(db, id, updated) };
  });

  app.post("/rfq/:id/close", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const rfq = await db.rfq.findUnique({ where: { id } });
    if (!rfq) throw notFound("That request");
    if (rfq.buyerPersonId !== actor.personId) throw forbidden("Only the buyer can close this request.");
    if (["CLOSED", "CANCELLED", "ACCEPTED"].includes(rfq.status)) throw badRequest("rfq_already_final", "This request is already closed.");
    await db.rfq.update({ where: { id }, data: { status: "CLOSED" } });
    const quoted = await db.quote.findMany({ where: { rfqId: id, status: { in: ["SUBMITTED", "SHORTLISTED"] } }, select: { authorId: true } });
    for (const q of quoted) {
      await notify(db, { personId: q.authorId, kind: "rfq.decision", title: "Request closed", body: `${rfq.title} was closed without selecting a quote.`, href: `/rfq/${id}`, actorId: actor.personId, objectType: "Rfq", objectId: id });
    }
    await audit(db, { actorId: actor.personId, action: "rfq.closed", targetType: "Rfq", targetId: id });
    await track(db, { personId: actor.personId, event: "rfq_closed", objectType: "Rfq", objectId: id });
    return { status: "CLOSED" };
  });

  app.post("/rfq/:id/cancel", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const rfq = await db.rfq.findUnique({ where: { id } });
    if (!rfq) throw notFound("That request");
    if (rfq.buyerPersonId !== actor.personId) throw forbidden("Only the buyer can cancel this request.");
    if (rfq.status === "ACCEPTED") throw badRequest("rfq_accepted", "This request already has an accepted quote.");
    await db.rfq.update({ where: { id }, data: { status: "CANCELLED" } });
    await audit(db, { actorId: actor.personId, action: "rfq.cancelled", targetType: "Rfq", targetId: id });
    return { status: "CANCELLED" };
  });

  /* ── vendor actions ───────────────────────────────────────────────────── */

  app.post("/rfq/:id/view", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { organizationId } = z.object({ organizationId: z.string() }).parse(req.body);
    await requireOrgPermission(db, actor, organizationId, "org.quote");
    const invite = await db.rfqInvite.findUnique({ where: { rfqId_organizationId: { rfqId: id, organizationId } } });
    if (!invite) throw notFound("That request");
    if (!invite.viewedAt) await db.rfqInvite.update({ where: { rfqId_organizationId: { rfqId: id, organizationId } }, data: { viewedAt: new Date() } });
    return { ok: true };
  });

  app.post("/rfq/:id/decline", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { organizationId } = z.object({ organizationId: z.string() }).parse(req.body);
    await requireOrgPermission(db, actor, organizationId, "org.quote");
    const invite = await db.rfqInvite.findUnique({ where: { rfqId_organizationId: { rfqId: id, organizationId } } });
    if (!invite) throw notFound("That request");
    await db.rfqInvite.update({ where: { rfqId_organizationId: { rfqId: id, organizationId } }, data: { declinedAt: new Date(), viewedAt: invite.viewedAt ?? new Date() } });
    return { ok: true };
  });

  app.post("/rfq/:id/quotes", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = quoteSchema.parse(req.body);
    await requireOrgPermission(db, actor, body.organizationId, "org.quote");
    await assertOwnedAssets(db, actor.personId, body.attachmentAssetIds);

    const rfq = await db.rfq.findUnique({ where: { id } });
    if (!rfq) throw notFound("That request");
    if (!isOpenForQuoting(rfq.status)) throw badRequest("rfq_not_open", "This request isn't accepting quotes right now.");
    const invite = await db.rfqInvite.findUnique({ where: { rfqId_organizationId: { rfqId: id, organizationId: body.organizationId } } });
    if (!invite) throw forbidden("Your company wasn't invited to quote on this request.");
    if (invite.declinedAt) throw badRequest("already_declined", "You already declined this request — withdraw the decline isn't supported, ask the buyer to re-invite you.");

    const existing = await db.quote.findUnique({ where: { rfqId_organizationId: { rfqId: id, organizationId: body.organizationId } } });
    let quote: NonNullable<QuoteRow>;
    if (existing) {
      if (existing.status === "WITHDRAWN") throw badRequest("quote_withdrawn", "You withdrew this quote and can't resubmit it.");
      await db.quoteAttachment.deleteMany({ where: { quoteId: existing.id } });
      quote = await db.quote.update({
        where: { id: existing.id },
        data: {
          total: body.total,
          perUnit: body.perUnit ?? null,
          deliveryDate: body.deliveryDate ?? null,
          validUntil: body.validUntil ?? null,
          notes: body.notes ?? null,
          alternateProposal: body.alternateProposal ?? null,
          status: "SUBMITTED",
          version: { increment: 1 },
        },
      });
    } else {
      quote = await db.quote.create({
        data: {
          rfqId: id,
          organizationId: body.organizationId,
          authorId: actor.personId,
          total: body.total,
          perUnit: body.perUnit ?? null,
          deliveryDate: body.deliveryDate ?? null,
          validUntil: body.validUntil ?? null,
          notes: body.notes ?? null,
          alternateProposal: body.alternateProposal ?? null,
        },
      });
      await db.rfq.update({ where: { id }, data: { quoteCount: { increment: 1 } } });
    }
    if (body.attachmentAssetIds?.length) {
      await db.quoteAttachment.createMany({ data: body.attachmentAssetIds.map((assetId) => ({ quoteId: quote.id, assetId })) });
    }

    await notify(db, { personId: rfq.buyerPersonId, kind: "rfq.quote", title: existing ? "A quote was updated" : "New quote received", body: rfq.title, href: `/rfq/${id}`, actorId: actor.personId, objectType: "Rfq", objectId: id });
    await audit(db, { actorId: actor.personId, action: "rfq.quote_submitted", targetType: "Rfq", targetId: id, organizationId: body.organizationId, after: { version: quote.version, total: body.total } });
    await track(db, { personId: actor.personId, event: "quote_submitted", objectType: "Quote", objectId: quote.id, props: { rfqId: id } });

    reply.status(existing ? 200 : 201);
    return { quote: await quoteDto(db, quote) };
  });

  app.patch("/rfq/:id/quotes/:qid", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { id, qid } = z.object({ id: z.string(), qid: z.string() }).parse(req.params);
    const body = quoteSchema.omit({ organizationId: true }).partial().parse(req.body ?? {});
    const quote = await db.quote.findUnique({ where: { id: qid } });
    if (!quote || quote.rfqId !== id) throw notFound("That quote");
    await requireOrgPermission(db, actor, quote.organizationId, "org.quote");
    await assertOwnedAssets(db, actor.personId, body.attachmentAssetIds);
    const rfq = await db.rfq.findUnique({ where: { id } });
    if (!rfq || !isOpenForQuoting(rfq.status)) throw badRequest("rfq_not_open", "This request isn't accepting quotes right now.");
    if (["WITHDRAWN", "ACCEPTED", "DECLINED"].includes(quote.status)) throw badRequest("quote_final", "That quote can't be changed anymore.");

    if (body.attachmentAssetIds) await db.quoteAttachment.deleteMany({ where: { quoteId: qid } });
    const updated = await db.quote.update({
      where: { id: qid },
      data: {
        total: body.total ?? quote.total,
        perUnit: body.perUnit !== undefined ? body.perUnit : quote.perUnit,
        deliveryDate: body.deliveryDate !== undefined ? body.deliveryDate : quote.deliveryDate,
        validUntil: body.validUntil !== undefined ? body.validUntil : quote.validUntil,
        notes: body.notes !== undefined ? body.notes : quote.notes,
        alternateProposal: body.alternateProposal !== undefined ? body.alternateProposal : quote.alternateProposal,
        status: "SUBMITTED",
        version: { increment: 1 },
      },
    });
    if (body.attachmentAssetIds?.length) {
      await db.quoteAttachment.createMany({ data: body.attachmentAssetIds.map((assetId) => ({ quoteId: qid, assetId })) });
    }
    await notify(db, { personId: rfq.buyerPersonId, kind: "rfq.quote", title: "A quote was updated", body: rfq.title, href: `/rfq/${id}`, actorId: actor.personId, objectType: "Rfq", objectId: id });
    await audit(db, { actorId: actor.personId, action: "rfq.quote_submitted", targetType: "Rfq", targetId: id, organizationId: quote.organizationId, after: { version: updated.version } });
    return { quote: await quoteDto(db, updated) };
  });

  app.post("/rfq/:id/quotes/:qid/withdraw", async (req) => {
    const actor = requireActor(req);
    const { id, qid } = z.object({ id: z.string(), qid: z.string() }).parse(req.params);
    const quote = await db.quote.findUnique({ where: { id: qid } });
    if (!quote || quote.rfqId !== id) throw notFound("That quote");
    await requireOrgPermission(db, actor, quote.organizationId, "org.quote");
    if (quote.status === "ACCEPTED") throw badRequest("quote_accepted", "An accepted quote can't be withdrawn.");
    await db.quote.update({ where: { id: qid }, data: { status: "WITHDRAWN" } });
    await audit(db, { actorId: actor.personId, action: "rfq.quote_withdrawn", targetType: "Rfq", targetId: id, organizationId: quote.organizationId });
    return { status: "WITHDRAWN" };
  });

  /* ── buyer decisions ──────────────────────────────────────────────────── */

  app.post("/rfq/:id/quotes/:qid/shortlist", async (req) => {
    const actor = requireActor(req);
    const { id, qid } = z.object({ id: z.string(), qid: z.string() }).parse(req.params);
    const rfq = await db.rfq.findUnique({ where: { id } });
    if (!rfq) throw notFound("That request");
    if (rfq.buyerPersonId !== actor.personId) throw forbidden("Only the buyer can shortlist a quote.");
    const quote = await db.quote.findUnique({ where: { id: qid } });
    if (!quote || quote.rfqId !== id) throw notFound("That quote");
    await db.quote.update({ where: { id: qid }, data: { status: "SHORTLISTED" } });
    if (rfq.status === "OPEN") await db.rfq.update({ where: { id }, data: { status: "SHORTLISTING" } });
    await notify(db, { personId: quote.authorId, kind: "rfq.decision", title: "Your quote was shortlisted", body: rfq.title, href: `/rfq/${id}`, actorId: actor.personId, objectType: "Rfq", objectId: id });
    await audit(db, { actorId: actor.personId, action: "rfq.quote_shortlisted", targetType: "Rfq", targetId: id, organizationId: quote.organizationId });
    return { status: "SHORTLISTED" };
  });

  app.post("/rfq/:id/quotes/:qid/decline", async (req) => {
    const actor = requireActor(req);
    const { id, qid } = z.object({ id: z.string(), qid: z.string() }).parse(req.params);
    const rfq = await db.rfq.findUnique({ where: { id } });
    if (!rfq) throw notFound("That request");
    if (rfq.buyerPersonId !== actor.personId) throw forbidden("Only the buyer can decline a quote.");
    const quote = await db.quote.findUnique({ where: { id: qid } });
    if (!quote || quote.rfqId !== id) throw notFound("That quote");
    await db.quote.update({ where: { id: qid }, data: { status: "DECLINED" } });
    await notify(db, { personId: quote.authorId, kind: "rfq.decision", title: "Your quote wasn't selected", body: rfq.title, href: `/rfq/${id}`, actorId: actor.personId, objectType: "Rfq", objectId: id });
    await audit(db, { actorId: actor.personId, action: "rfq.quote_declined", targetType: "Rfq", targetId: id, organizationId: quote.organizationId });
    return { status: "DECLINED" };
  });

  app.post("/rfq/:id/quotes/:qid/accept", async (req) => {
    const actor = requireActor(req);
    const { id, qid } = z.object({ id: z.string(), qid: z.string() }).parse(req.params);
    const rfq = await db.rfq.findUnique({ where: { id } });
    if (!rfq) throw notFound("That request");
    if (rfq.buyerPersonId !== actor.personId) throw forbidden("Only the buyer can accept a quote.");
    const quote = await db.quote.findUnique({ where: { id: qid } });
    if (!quote || quote.rfqId !== id) throw notFound("That quote");
    if (!["SUBMITTED", "SHORTLISTED"].includes(quote.status)) throw badRequest("quote_not_acceptable", "That quote can't be accepted.");

    let accepted: NonNullable<QuoteRow>;
    try {
      accepted = await db.$transaction(async (tx) => {
        const q = await tx.quote.update({ where: { id: qid }, data: { status: "ACCEPTED" } });
        await tx.rfq.update({ where: { id }, data: { status: "ACCEPTED", acceptedQuoteId: qid } });
        await tx.quote.updateMany({ where: { rfqId: id, id: { not: qid }, status: { in: ["SUBMITTED", "SHORTLISTED"] } }, data: { status: "DECLINED" } });
        return q;
      });
    } catch (err: any) {
      if (err?.code === "P2002") throw conflict("quote_already_accepted", "A quote was already accepted for this request.");
      throw err;
    }

    const losers = await db.quote.findMany({ where: { rfqId: id, id: { not: qid }, status: "DECLINED" }, select: { authorId: true } });
    await notify(db, { personId: accepted.authorId, kind: "rfq.decision", title: "Your quote was accepted!", body: rfq.title, href: `/rfq/${id}`, actorId: actor.personId, objectType: "Rfq", objectId: id });
    for (const l of losers) {
      await notify(db, { personId: l.authorId, kind: "rfq.decision", title: "Not selected this time", body: rfq.title, href: `/rfq/${id}`, actorId: actor.personId, objectType: "Rfq", objectId: id });
    }

    await db.verification.create({ data: { organizationId: accepted.organizationId, kind: "TRANSACTION", status: "VERIFIED", evidence: { rfqId: id, quoteId: qid }, reviewedAt: new Date() } });
    await db.relationshipTag.upsert({
      where: { ownerId_targetOrgId_kind: { ownerId: actor.personId, targetOrgId: accepted.organizationId, kind: "CUSTOMER" } },
      create: { ownerId: actor.personId, targetOrgId: accepted.organizationId, kind: "CUSTOMER", mutual: true },
      update: { mutual: true },
    });

    await audit(db, { actorId: actor.personId, action: "rfq.accepted", targetType: "Rfq", targetId: id, organizationId: accepted.organizationId });
    await track(db, { personId: actor.personId, event: "quote_accepted", objectType: "Quote", objectId: qid, props: { total: Number(accepted.total) } });

    return { status: "ACCEPTED", quote: await quoteDto(db, accepted) };
  });

  /* ── chat ─────────────────────────────────────────────────────────────── */

  app.post("/rfq/:id/quotes/:qid/thread", async (req) => {
    const actor = requireActor(req);
    const { id, qid } = z.object({ id: z.string(), qid: z.string() }).parse(req.params);
    const rfq = await db.rfq.findUnique({ where: { id } });
    if (!rfq) throw notFound("That request");
    const quote = await db.quote.findUnique({ where: { id: qid } });
    if (!quote || quote.rfqId !== id) throw notFound("That quote");
    const isBuyer = actor.personId === rfq.buyerPersonId;
    const isVendorSide = actor.personId === quote.authorId || (await hasOrgPermission(db, actor, quote.organizationId, "org.quote"));
    if (!isBuyer && !isVendorSide) throw forbidden("You're not part of this quote.");

    let thread = await db.thread.findFirst({ where: { kind: "RFQ", refType: "Rfq", refId: qid } });
    if (!thread) {
      thread = await db.thread.create({
        data: {
          kind: "RFQ",
          refType: "Rfq",
          refId: qid,
          title: rfq.title,
          createdById: actor.personId,
          participants: { create: [{ personId: rfq.buyerPersonId, state: "ACTIVE", role: "MEMBER" }, { personId: quote.authorId, state: "ACTIVE", role: "MEMBER" }] },
        },
      });
      await db.quote.update({ where: { id: qid }, data: { threadId: thread.id } });
    }
    return { threadId: thread.id };
  });

  /* ── questions ────────────────────────────────────────────────────────── */

  app.post("/rfq/:id/questions", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ organizationId: z.string(), question: z.string().trim().min(3).max(1000) }).parse(req.body);
    await requireOrgPermission(db, actor, body.organizationId, "org.quote");
    const rfq = await db.rfq.findUnique({ where: { id } });
    if (!rfq) throw notFound("That request");
    const invite = await db.rfqInvite.findUnique({ where: { rfqId_organizationId: { rfqId: id, organizationId: body.organizationId } } });
    if (!invite) throw forbidden("Your company wasn't invited to this request.");
    const question = await db.rfqQuestion.create({ data: { rfqId: id, organizationId: body.organizationId, askedById: actor.personId, question: body.question } });
    await notify(db, { personId: rfq.buyerPersonId, kind: "rfq.question", title: "New question on your request", body: body.question, href: `/rfq/${id}`, actorId: actor.personId, objectType: "Rfq", objectId: id });
    reply.status(201);
    return {
      question: {
        id: question.id,
        rfqId: question.rfqId,
        organization: await orgCard(db, question.organizationId),
        askedBy: await personCard(db, question.askedById),
        question: question.question,
        answer: question.answer,
        answeredAt: null,
        isPublic: question.isPublic,
        createdAt: question.createdAt.toISOString(),
      },
    };
  });

  app.post("/rfq/:id/questions/:qid/answer", async (req) => {
    const actor = requireActor(req);
    const { id, qid } = z.object({ id: z.string(), qid: z.string() }).parse(req.params);
    const body = z.object({ answer: z.string().trim().min(1).max(2000), isPublic: z.boolean().optional() }).parse(req.body);
    const rfq = await db.rfq.findUnique({ where: { id } });
    if (!rfq) throw notFound("That request");
    if (rfq.buyerPersonId !== actor.personId) throw forbidden("Only the buyer can answer questions on this request.");
    const question = await db.rfqQuestion.findUnique({ where: { id: qid } });
    if (!question || question.rfqId !== id) throw notFound("That question");
    const updated = await db.rfqQuestion.update({ where: { id: qid }, data: { answer: body.answer, answeredAt: new Date(), isPublic: body.isPublic ?? question.isPublic } });
    await notify(db, { personId: question.askedById, kind: "rfq.question", title: "Your question was answered", body: body.answer, href: `/rfq/${id}`, actorId: actor.personId, objectType: "Rfq", objectId: id });
    return {
      question: {
        id: updated.id,
        rfqId: updated.rfqId,
        organization: await orgCard(db, updated.organizationId),
        askedBy: await personCard(db, updated.askedById),
        question: updated.question,
        answer: updated.answer,
        answeredAt: updated.answeredAt ? updated.answeredAt.toISOString() : null,
        isPublic: updated.isPublic,
        createdAt: updated.createdAt.toISOString(),
      },
    };
  });

  addJob({ name: "rfq.closing", everyMs: 15 * 60_000, run: rfqClosingSweep });
}
