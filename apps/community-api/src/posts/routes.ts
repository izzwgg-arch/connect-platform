import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { requireActor } from "../auth/actor.js";
import { requireVerifiedActor } from "../auth/guards.js";
import { requireOrgPermission, hasOrgPermission, membershipOf } from "../organizations/permissions.js";
import { personCard } from "../profiles/cards.js";
import { canSeePost, degreeBetween, isBlockedEitherWay, sharesOrganization, type Degree } from "../policy/graph.js";
import { notify } from "../lib/notify.js";
import { track } from "../lib/analytics.js";
import { audit } from "../lib/audit.js";
import { buildSearchText } from "../lib/search.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { addJob } from "../core/schedulers.js";
import { canComment, deriveKindFromMedia, REACTION_KINDS } from "./policy.js";
import { POST_INCLUDE, fetchLinkPreview, hydrateComments, hydratePosts, publishScheduledPosts, type LinkPreview, type PostRow } from "./service.js";

const PostKindIn = z.enum(["TEXT", "IMAGE", "GALLERY", "VIDEO", "DOCUMENT", "LINK", "POLL", "ARTICLE", "COMPANY_UPDATE"]);
const VisibilityIn = z.enum(["PUBLIC", "CONNECTIONS", "ORGANIZATION", "PRIVATE"]);
const CommentsPolicyIn = z.enum(["ANYONE", "CONNECTIONS", "NOBODY"]);

const CreatePostSchema = z.object({
  kind: PostKindIn.optional(),
  body: z.string().max(6000).optional(),
  mediaAssetIds: z.array(z.string()).max(10).optional(),
  altTexts: z.array(z.string().max(500).nullable()).optional(),
  linkUrl: z.string().url().optional(),
  poll: z
    .object({
      question: z.string().min(1).max(300),
      options: z.array(z.string().min(1).max(120)).min(2).max(6),
      closesInHours: z.number().int().positive().max(24 * 30).optional(),
    })
    .optional(),
  visibility: VisibilityIn.optional(),
  commentsPolicy: CommentsPolicyIn.optional(),
  organizationId: z.string().optional(),
  scheduledFor: z.string().optional(),
  industry: z.string().max(120).optional(),
  location: z.string().max(200).optional(),
  mentions: z.object({ personIds: z.array(z.string()).optional(), orgIds: z.array(z.string()).optional() }).optional(),
});

const PatchPostSchema = z.object({
  body: z.string().max(6000).optional(),
  altTexts: z.array(z.string().max(500).nullable()).optional(),
  commentsPolicy: CommentsPolicyIn.optional(),
  visibility: VisibilityIn.optional(),
});

const CreateCommentSchema = z.object({ body: z.string().min(1).max(3000), parentId: z.string().optional() });

/** Personal-post ORGANIZATION visibility = shares a verified org with the author; company-post = viewer is a member of THAT org. */
async function sameOrgAsPost(db: Db, viewerId: string | null, post: { organizationId: string | null; authorId: string }): Promise<boolean> {
  if (!viewerId) return false;
  if (post.organizationId) return !!(await membershipOf(db, viewerId, post.organizationId));
  return sharesOrganization(db, viewerId, post.authorId);
}

async function loadVisiblePost(db: Db, id: string, viewerId: string | null) {
  const row = await db.post.findUnique({ where: { id }, include: POST_INCLUDE });
  if (!row || row.deletedAt) throw notFound("That post");
  const isAuthor = viewerId === row.authorId;
  if (!row.publishedAt && !isAuthor) throw notFound("That post");
  if (viewerId && (await isBlockedEitherWay(db, viewerId, row.authorId))) throw notFound("That post");
  const [degree, sameOrganization] = await Promise.all([degreeBetween(db, viewerId, row.authorId), sameOrgAsPost(db, viewerId, row)]);
  if (!canSeePost(row.visibility as any, { degree, sameOrganization, isAuthor })) throw notFound("That post");
  return row;
}

export function registerPostRoutes(app: FastifyInstance, db: Db) {
  const viewerOf = (req: FastifyRequest) => req.actor?.personId ?? null;

  /* ───────────────────────────── Link preview (composer paste) ───────────────────────────── */
  app.post("/posts/preview", async (req) => {
    requireActor(req);
    const input = z.object({ url: z.string().url() }).parse(req.body);
    const preview = await fetchLinkPreview(input.url);
    return { preview };
  });

  /* ───────────────────────────── Create ───────────────────────────── */
  app.post("/posts", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const input = CreatePostSchema.parse(req.body);
    if (!input.body?.trim() && !input.mediaAssetIds?.length && !input.poll && !input.linkUrl) {
      throw badRequest("empty_post", "Write something, add media, a link, or a poll before posting.");
    }

    if (input.organizationId) {
      await requireOrgPermission(db, actor, input.organizationId, "org.post");
    }

    let scheduledDate: Date | null = null;
    if (input.scheduledFor) {
      scheduledDate = new Date(input.scheduledFor);
      if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
        throw badRequest("invalid_schedule", "Pick a time in the future to schedule this post.");
      }
      if (input.organizationId) await requireOrgPermission(db, actor, input.organizationId, "org.schedule_posts");
    }

    let assets: Array<{ id: string; kind: string }> = [];
    if (input.mediaAssetIds?.length) {
      const found = await db.mediaAsset.findMany({ where: { id: { in: input.mediaAssetIds }, ownerId: actor.personId }, select: { id: true, kind: true } });
      if (found.length !== input.mediaAssetIds.length) throw badRequest("media_not_found", "One of those files isn't yours or doesn't exist.");
      const byId = new Map(found.map((a) => [a.id, a]));
      assets = input.mediaAssetIds.map((id) => byId.get(id)!);
    }

    let linkPreview: LinkPreview | null = null;
    if (input.linkUrl && !assets.length && !input.poll) {
      linkPreview = await fetchLinkPreview(input.linkUrl);
    }

    const mediaKind = deriveKindFromMedia(assets);
    const kind = input.poll ? "POLL" : mediaKind ?? (input.linkUrl && !assets.length ? "LINK" : input.kind ?? "TEXT");

    const authorCard = await personCard(db, actor.personId);
    const authorName = authorCard?.name ?? actor.username;
    const searchText = buildSearchText([input.body, linkPreview?.title, linkPreview?.description, authorName]);

    const created = await db.$transaction(async (tx) => {
      const post = await tx.post.create({
        data: {
          authorId: actor.personId,
          organizationId: input.organizationId ?? null,
          kind: kind as any,
          body: input.body ?? null,
          visibility: (input.visibility ?? "PUBLIC") as any,
          commentsPolicy: input.commentsPolicy ?? "ANYONE",
          linkUrl: input.linkUrl ?? null,
          linkPreview: linkPreview ? (linkPreview as any) : undefined,
          industry: input.industry ?? null,
          location: input.location ?? null,
          scheduledFor: scheduledDate,
          publishedAt: scheduledDate ? null : new Date(),
          searchText,
        },
      });
      if (assets.length) {
        await tx.postMedia.createMany({ data: assets.map((a, i) => ({ postId: post.id, assetId: a.id, sortOrder: i, altText: input.altTexts?.[i] ?? null })) });
      }
      if (input.poll) {
        const closesAt = input.poll.closesInHours ? new Date(Date.now() + input.poll.closesInHours * 3_600_000) : null;
        await tx.poll.create({ data: { postId: post.id, question: input.poll.question, closesAt, options: { create: input.poll.options.map((text, i) => ({ text, sortOrder: i })) } } });
      }
      const mentionRows: Array<{ postId: string; personId?: string; orgId?: string }> = [];
      for (const pid of input.mentions?.personIds ?? []) mentionRows.push({ postId: post.id, personId: pid });
      for (const oid of input.mentions?.orgIds ?? []) mentionRows.push({ postId: post.id, orgId: oid });
      if (mentionRows.length) await tx.mention.createMany({ data: mentionRows });
      if (scheduledDate) {
        await tx.scheduledPost.create({ data: { organizationId: input.organizationId ?? null, authorId: actor.personId, payload: { postId: post.id }, scheduledFor: scheduledDate } });
      }
      return post;
    });

    for (const pid of input.mentions?.personIds ?? []) {
      if (pid !== actor.personId) {
        await notify(db, { personId: pid, kind: "post.mention", title: `${authorName} mentioned you in a post`, href: `/posts/${created.id}`, actorId: actor.personId, objectType: "Post", objectId: created.id });
      }
    }

    const row = await db.post.findUnique({ where: { id: created.id }, include: POST_INCLUDE });
    const [dto] = await hydratePosts(db, [row as unknown as PostRow], actor.personId);
    reply.status(201);
    return { post: dto };
  });

  /* ───────────────────────────── Read one ───────────────────────────── */
  const readOne = async (req: FastifyRequest) => {
    const id = (req.params as any).id as string;
    const viewerId = viewerOf(req);
    const row = await loadVisiblePost(db, id, viewerId);
    await track(db, { personId: viewerId, event: "post_open", objectType: "Post", objectId: id });
    const [dto] = await hydratePosts(db, [row as unknown as PostRow], viewerId);
    return { post: dto };
  };
  app.get("/posts/:id", readOne);
  app.get("/public/posts/:id", readOne);

  app.patch("/posts/:id", async (req) => {
    const actor = requireActor(req);
    const id = (req.params as any).id as string;
    const existing = await db.post.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw notFound("That post");
    if (existing.authorId !== actor.personId) throw forbidden("Only the author can edit this post.");
    const input = PatchPostSchema.parse(req.body);
    const data: Record<string, unknown> = { editedAt: new Date() };
    if (input.body !== undefined) data.body = input.body;
    if (input.commentsPolicy !== undefined) data.commentsPolicy = input.commentsPolicy;
    if (input.visibility !== undefined) data.visibility = input.visibility;
    if (input.body !== undefined) {
      const authorCard = await personCard(db, actor.personId);
      const preview = existing.linkPreview as LinkPreview | null;
      data.searchText = buildSearchText([input.body, preview?.title, preview?.description, authorCard?.name ?? actor.username]);
    }
    await db.post.update({ where: { id }, data });
    if (input.altTexts) {
      const media = await db.postMedia.findMany({ where: { postId: id }, orderBy: { sortOrder: "asc" } });
      await Promise.all(media.map((m, i) => (input.altTexts![i] !== undefined ? db.postMedia.update({ where: { id: m.id }, data: { altText: input.altTexts![i] } }) : null)));
    }
    const row = await db.post.findUnique({ where: { id }, include: POST_INCLUDE });
    const [dto] = await hydratePosts(db, [row as unknown as PostRow], actor.personId);
    return { post: dto };
  });

  app.delete("/posts/:id", async (req) => {
    const actor = requireActor(req);
    const id = (req.params as any).id as string;
    const existing = await db.post.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw notFound("That post");
    const isAuthor = existing.authorId === actor.personId;
    const orgOk = existing.organizationId ? await hasOrgPermission(db, actor, existing.organizationId, "org.post") : false;
    const isStaff = !!actor.staffRole;
    if (!isAuthor && !orgOk && !isStaff) throw forbidden("You can't delete this post.");
    await db.post.update({ where: { id }, data: { deletedAt: new Date() } });
    if (isStaff && !isAuthor) await audit(db, { actorId: actor.personId, action: "post.removed", targetType: "Post", targetId: id, source: "api" });
    return { ok: true };
  });

  /* ───────────────────────────── Comments ───────────────────────────── */
  const listComments = async (req: FastifyRequest) => {
    const id = (req.params as any).id as string;
    const viewerId = viewerOf(req);
    await loadVisiblePost(db, id, viewerId);
    const query = req.query as Record<string, string | undefined>;
    const limit = clampLimit(query.limit, 20, 50);
    const cur = decodeCursor(query.cursor);
    const where: any = { postId: id, parentId: null, deletedAt: null };
    if (cur) where.createdAt = { lt: new Date(cur.value) };
    const rows = await db.comment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      include: { replies: { where: { deletedAt: null }, orderBy: { createdAt: "asc" }, take: 3 }, _count: { select: { replies: true } } },
    });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null;
    const items = await hydrateComments(db, page as any, viewerId);
    return { items, nextCursor };
  };
  app.get("/posts/:id/comments", listComments);
  app.get("/public/posts/:id/comments", listComments);

  app.post("/posts/:id/comments", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const id = (req.params as any).id as string;
    const post = await loadVisiblePost(db, id, actor.personId);
    const input = CreateCommentSchema.parse(req.body);
    const isAuthor = post.authorId === actor.personId;
    const degree = await degreeBetween(db, actor.personId, post.authorId);
    if (!canComment(post.commentsPolicy, { isAuthor, degree })) throw forbidden("Comments are limited on this post.");
    let parent: { id: string; authorId: string; postId: string; deletedAt: Date | null } | null = null;
    if (input.parentId) {
      parent = await db.comment.findUnique({ where: { id: input.parentId } });
      if (!parent || parent.postId !== id || parent.deletedAt) throw notFound("That comment");
    }
    const comment = await db.comment.create({ data: { postId: id, authorId: actor.personId, parentId: input.parentId ?? null, body: input.body } });
    await db.post.update({ where: { id }, data: { commentCount: { increment: 1 } } });
    const commenterCard = await personCard(db, actor.personId);
    const commenterName = commenterCard?.name ?? actor.username;
    if (post.authorId !== actor.personId) {
      await notify(db, { personId: post.authorId, kind: "post.comment", title: `${commenterName} commented on your post`, body: input.body.slice(0, 140), href: `/posts/${id}`, actorId: actor.personId, objectType: "Post", objectId: id });
    }
    if (parent && parent.authorId !== actor.personId && parent.authorId !== post.authorId) {
      await notify(db, { personId: parent.authorId, kind: "post.comment", title: `${commenterName} replied to your comment`, body: input.body.slice(0, 140), href: `/posts/${id}`, actorId: actor.personId, objectType: "Comment", objectId: parent.id });
    }
    await track(db, { personId: actor.personId, event: "comment", objectType: "Post", objectId: id });
    const [dto] = await hydrateComments(db, [{ ...comment, replies: [], _count: { replies: 0 } } as any], actor.personId);
    reply.status(201);
    return { comment: dto };
  });

  app.patch("/comments/:id", async (req) => {
    const actor = requireActor(req);
    const id = (req.params as any).id as string;
    const existing = await db.comment.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw notFound("That comment");
    if (existing.authorId !== actor.personId) throw forbidden("Only the author can edit this comment.");
    const input = z.object({ body: z.string().min(1).max(3000) }).parse(req.body);
    const updated = await db.comment.update({ where: { id }, data: { body: input.body, editedAt: new Date() } });
    const [dto] = await hydrateComments(db, [{ ...updated, replies: [], _count: { replies: 0 } } as any], actor.personId);
    return { comment: dto };
  });

  app.delete("/comments/:id", async (req) => {
    const actor = requireActor(req);
    const id = (req.params as any).id as string;
    const existing = await db.comment.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw notFound("That comment");
    if (existing.authorId !== actor.personId && !actor.staffRole) throw forbidden("Only the author can delete this comment.");
    await db.comment.update({ where: { id }, data: { deletedAt: new Date() } });
    await db.post.update({ where: { id: existing.postId }, data: { commentCount: { decrement: 1 } } }).catch(() => undefined);
    return { ok: true };
  });

  app.post("/comments/:id/react", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const id = (req.params as any).id as string;
    const input = z.object({ kind: z.enum(REACTION_KINDS).optional() }).parse(req.body ?? {});
    const kind = input.kind ?? "LIKE";
    const comment = await db.comment.findUnique({ where: { id } });
    if (!comment || comment.deletedAt) throw notFound("That comment");
    const existing = await db.reaction.findUnique({ where: { personId_commentId: { personId: actor.personId, commentId: id } } });
    let mine: string | null = null;
    if (existing && existing.kind === kind) {
      await db.reaction.delete({ where: { id: existing.id } });
      await db.comment.update({ where: { id }, data: { reactionCount: { decrement: 1 } } });
    } else if (existing) {
      await db.reaction.update({ where: { id: existing.id }, data: { kind } });
      mine = kind;
    } else {
      await db.reaction.create({ data: { personId: actor.personId, commentId: id, kind } });
      await db.comment.update({ where: { id }, data: { reactionCount: { increment: 1 } } });
      mine = kind;
    }
    await track(db, { personId: actor.personId, event: "reaction", objectType: "Comment", objectId: id });
    return { myReaction: mine };
  });

  /* ───────────────────────────── Reactions on posts ───────────────────────────── */
  app.post("/posts/:id/react", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const id = (req.params as any).id as string;
    const input = z.object({ kind: z.enum(REACTION_KINDS) }).parse(req.body);
    const post = await loadVisiblePost(db, id, actor.personId);
    const existing = await db.reaction.findUnique({ where: { personId_postId: { personId: actor.personId, postId: id } } });
    let mine: string | null = null;
    if (existing && existing.kind === input.kind) {
      await db.reaction.delete({ where: { id: existing.id } });
      await db.post.update({ where: { id }, data: { reactionCount: { decrement: 1 } } });
    } else if (existing) {
      await db.reaction.update({ where: { id: existing.id }, data: { kind: input.kind } });
      mine = input.kind;
    } else {
      await db.reaction.create({ data: { personId: actor.personId, postId: id, kind: input.kind } });
      await db.post.update({ where: { id }, data: { reactionCount: { increment: 1 } } });
      mine = input.kind;
    }
    if (mine && post.authorId !== actor.personId) {
      const card = await personCard(db, actor.personId);
      await notify(db, { personId: post.authorId, kind: "post.reaction", title: `${card?.name ?? "Someone"} reacted to your post`, href: `/posts/${id}`, actorId: actor.personId, objectType: "Post", objectId: id, groupKey: `react:${id}` });
    }
    await track(db, { personId: actor.personId, event: "reaction", objectType: "Post", objectId: id });
    return { myReaction: mine };
  });

  app.delete("/posts/:id/react", async (req) => {
    const actor = requireActor(req);
    const id = (req.params as any).id as string;
    const existing = await db.reaction.findUnique({ where: { personId_postId: { personId: actor.personId, postId: id } } });
    if (existing) {
      await db.reaction.delete({ where: { id: existing.id } });
      await db.post.update({ where: { id }, data: { reactionCount: { decrement: 1 } } }).catch(() => undefined);
    }
    return { ok: true };
  });

  /* ───────────────────────────── Save ───────────────────────────── */
  app.post("/posts/:id/save", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const id = (req.params as any).id as string;
    await loadVisiblePost(db, id, actor.personId);
    const existing = await db.save.findUnique({ where: { personId_postId: { personId: actor.personId, postId: id } } });
    if (!existing) {
      await db.save.create({ data: { personId: actor.personId, postId: id } });
      await db.post.update({ where: { id }, data: { saveCount: { increment: 1 } } });
      await track(db, { personId: actor.personId, event: "save", objectType: "Post", objectId: id });
    }
    return { ok: true, saved: true };
  });

  app.delete("/posts/:id/save", async (req) => {
    const actor = requireActor(req);
    const id = (req.params as any).id as string;
    const existing = await db.save.findUnique({ where: { personId_postId: { personId: actor.personId, postId: id } } });
    if (existing) {
      await db.save.delete({ where: { personId_postId: { personId: actor.personId, postId: id } } });
      await db.post.update({ where: { id }, data: { saveCount: { decrement: 1 } } }).catch(() => undefined);
    }
    return { ok: true, saved: false };
  });

  app.get("/me/saved", async (req) => {
    const actor = requireActor(req);
    const query = req.query as Record<string, string | undefined>;
    const limit = clampLimit(query.limit, 20, 50);
    const cur = decodeCursor(query.cursor);
    const where: any = { personId: actor.personId };
    if (cur) where.createdAt = { lt: new Date(cur.value) };
    const saves = await db.save.findMany({ where, orderBy: { createdAt: "desc" }, take: limit + 1, select: { postId: true, createdAt: true } });
    const page = saves.slice(0, limit);
    const nextCursor = saves.length > limit ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].postId) : null;
    const rows = await db.post.findMany({ where: { id: { in: page.map((s) => s.postId) }, deletedAt: null }, include: POST_INCLUDE });
    const order = new Map(page.map((s, i) => [s.postId, i]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const items = await hydratePosts(db, rows as unknown as PostRow[], actor.personId);
    return { items, nextCursor };
  });

  /* ───────────────────────────── Repost ───────────────────────────── */
  app.post("/posts/:id/repost", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const id = (req.params as any).id as string;
    const original = await loadVisiblePost(db, id, actor.personId);
    const input = z.object({ comment: z.string().max(3000).optional() }).parse(req.body ?? {});
    const comment = input.comment?.trim() || null;
    if (!comment) {
      const existingPlain = await db.post.findFirst({ where: { authorId: actor.personId, kind: "REPOST", refType: "Post", refId: id, repostComment: null, deletedAt: null } });
      if (existingPlain) throw conflict("already_reposted", "You already reposted this.");
    }
    const authorCard = await personCard(db, actor.personId);
    const searchText = buildSearchText([comment, authorCard?.name ?? actor.username]);
    const repost = await db.post.create({
      data: { authorId: actor.personId, kind: "REPOST", refType: "Post", refId: id, repostComment: comment, visibility: "PUBLIC", commentsPolicy: "ANYONE", publishedAt: new Date(), searchText },
    });
    await db.post.update({ where: { id }, data: { repostCount: { increment: 1 } } });
    if (original.authorId !== actor.personId) {
      await notify(db, { personId: original.authorId, kind: "post.repost", title: `${authorCard?.name ?? "Someone"} reposted your post`, href: `/posts/${repost.id}`, actorId: actor.personId, objectType: "Post", objectId: id, groupKey: `repost:${id}` });
    }
    await track(db, { personId: actor.personId, event: "share", objectType: "Post", objectId: id });
    const row = await db.post.findUnique({ where: { id: repost.id }, include: POST_INCLUDE });
    const [dto] = await hydratePosts(db, [row as unknown as PostRow], actor.personId);
    reply.status(201);
    return { post: dto };
  });

  /* ───────────────────────────── Hide / impression ───────────────────────────── */
  app.post("/posts/:id/hide", async (req) => {
    const actor = requireActor(req);
    const id = (req.params as any).id as string;
    await db.hide.upsert({ where: { personId_postId: { personId: actor.personId, postId: id } }, create: { personId: actor.personId, postId: id }, update: {} });
    await track(db, { personId: actor.personId, event: "hide", objectType: "Post", objectId: id });
    return { ok: true };
  });

  app.post("/posts/:id/impression", async (req) => {
    const actor = requireActor(req);
    const id = (req.params as any).id as string;
    const input = z.object({ recommendationId: z.string().optional(), surface: z.string().min(1).max(60), position: z.number().int().optional() }).parse(req.body ?? {});
    await db.post.update({ where: { id }, data: { impressionCount: { increment: 1 } } }).catch(() => undefined);
    await track(db, { personId: actor.personId, event: "post_impression", objectType: "Post", objectId: id, surface: input.surface, position: input.position ?? null, recommendationId: input.recommendationId ?? null });
    if (input.recommendationId) {
      await db.recommendationImpression.updateMany({ where: { id: input.recommendationId, personId: actor.personId }, data: { outcome: "viewed" } });
    }
    return { ok: true };
  });

  /* ───────────────────────────── Poll vote ───────────────────────────── */
  app.post("/posts/:id/poll/vote", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const id = (req.params as any).id as string;
    const post = await loadVisiblePost(db, id, actor.personId);
    if (post.kind !== "POLL" || !post.poll) throw badRequest("not_a_poll", "This post doesn't have a poll.");
    if (post.poll.closesAt && post.poll.closesAt.getTime() < Date.now()) throw badRequest("poll_closed", "This poll is closed.");
    const input = z.object({ optionId: z.string() }).parse(req.body);
    const option = post.poll.options.find((o) => o.id === input.optionId);
    if (!option) throw notFound("That option");
    await db.$transaction(async (tx) => {
      const existing = await tx.pollVote.findUnique({ where: { pollId_personId: { pollId: id, personId: actor.personId } } });
      if (existing) {
        if (existing.optionId === input.optionId) return;
        await tx.pollOption.update({ where: { id: existing.optionId }, data: { voteCount: { decrement: 1 } } });
        await tx.pollVote.update({ where: { pollId_personId: { pollId: id, personId: actor.personId } }, data: { optionId: input.optionId } });
      } else {
        await tx.pollVote.create({ data: { pollId: id, personId: actor.personId, optionId: input.optionId } });
      }
      await tx.pollOption.update({ where: { id: input.optionId }, data: { voteCount: { increment: 1 } } });
    });
    const row = await db.post.findUnique({ where: { id }, include: POST_INCLUDE });
    const [dto] = await hydratePosts(db, [row as unknown as PostRow], actor.personId);
    return { post: dto };
  });

  /* ───────────────────────────── Per-person / per-org listings ───────────────────────────── */
  const listByPerson = async (req: FastifyRequest) => {
    const username = (req.params as any).username as string;
    const viewerId = viewerOf(req);
    const person = await db.person.findUnique({ where: { username }, select: { id: true } });
    if (!person) throw notFound("That person");
    if (viewerId && (await isBlockedEitherWay(db, viewerId, person.id))) throw notFound("That person");
    const query = req.query as Record<string, string | undefined>;
    const limit = clampLimit(query.limit, 20, 50);
    const cur = decodeCursor(query.cursor);
    const where: any = { authorId: person.id, deletedAt: null, publishedAt: { not: null } };
    if (cur) where.publishedAt = { lt: new Date(cur.value) };
    const rows = await db.post.findMany({ where, orderBy: { publishedAt: "desc" }, take: limit + 1, include: POST_INCLUDE });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].publishedAt!, page[page.length - 1].id) : null;
    const isAuthor = viewerId === person.id;
    const [degree, baseSameOrg] = viewerId ? await Promise.all([degreeBetween(db, viewerId, person.id), sharesOrganization(db, viewerId, person.id)]) : [3 as Degree, false];
    const visible: typeof page = [];
    for (const r of page) {
      const sameOrganization = r.organizationId ? (viewerId ? !!(await membershipOf(db, viewerId, r.organizationId)) : false) : baseSameOrg;
      if (canSeePost(r.visibility as any, { degree, sameOrganization, isAuthor })) visible.push(r);
    }
    const items = await hydratePosts(db, visible as unknown as PostRow[], viewerId);
    return { items, nextCursor };
  };
  app.get("/people/:username/posts", listByPerson);
  app.get("/public/people/:username/posts", listByPerson);

  const listByOrg = async (req: FastifyRequest) => {
    const orgId = (req.params as any).id as string;
    const viewerId = viewerOf(req);
    const org = await db.organization.findUnique({ where: { id: orgId }, select: { id: true } });
    if (!org) throw notFound("That company");
    const query = req.query as Record<string, string | undefined>;
    const limit = clampLimit(query.limit, 20, 50);
    const cur = decodeCursor(query.cursor);
    const where: any = { organizationId: orgId, deletedAt: null, publishedAt: { not: null } };
    if (cur) where.publishedAt = { lt: new Date(cur.value) };
    const rows = await db.post.findMany({ where, orderBy: { publishedAt: "desc" }, take: limit + 1, include: POST_INCLUDE });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].publishedAt!, page[page.length - 1].id) : null;
    const sameOrganization = viewerId ? !!(await membershipOf(db, viewerId, orgId)) : false;
    const visible: typeof page = [];
    for (const r of page) {
      const degree = viewerId ? await degreeBetween(db, viewerId, r.authorId) : 3;
      const isAuthor = viewerId === r.authorId;
      if (canSeePost(r.visibility as any, { degree, sameOrganization, isAuthor })) visible.push(r);
    }
    const items = await hydratePosts(db, visible as unknown as PostRow[], viewerId);
    return { items, nextCursor };
  };
  app.get("/organizations/:id/posts", listByOrg);
  app.get("/public/organizations/:id/posts", listByOrg);

  /* ───────────────────────────── Analytics ───────────────────────────── */
  app.get("/posts/:id/analytics", async (req) => {
    const actor = requireActor(req);
    const id = (req.params as any).id as string;
    const post = await db.post.findUnique({ where: { id } });
    if (!post || post.deletedAt) throw notFound("That post");
    const isAuthor = post.authorId === actor.personId;
    const orgOk = post.organizationId ? await hasOrgPermission(db, actor, post.organizationId, "org.view_analytics") : false;
    if (!isAuthor && !orgOk && !actor.staffRole) throw forbidden("You don't have access to this post's analytics.");
    const [opens, profileClicks] = await Promise.all([
      db.analyticsEvent.count({ where: { objectType: "Post", objectId: id, event: "post_open" } }),
      db.analyticsEvent.count({ where: { objectType: "Post", objectId: id, event: "profile_view" } }),
    ]);
    return {
      impressions: post.impressionCount,
      opens,
      reactions: post.reactionCount,
      comments: post.commentCount,
      reposts: post.repostCount,
      saves: post.saveCount,
      profileClicks,
    };
  });

  addJob({ name: "posts.publish_scheduled", everyMs: 60_000, run: publishScheduledPosts });
}

// Re-exported so feed/routes.ts (and tests) can reuse the exact same visibility gate.
export { loadVisiblePost, sameOrgAsPost };
