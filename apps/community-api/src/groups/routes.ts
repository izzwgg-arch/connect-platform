import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { requireActor } from "../auth/actor.js";
import { requireVerifiedActor } from "../auth/guards.js";
import { audit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { track } from "../lib/analytics.js";
import { buildSearchText } from "../lib/search.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { storeUpload } from "../media/service.js";
import { personCard, personCards } from "../profiles/cards.js";
import { connectionIds } from "../policy/graph.js";
import { POST_INCLUDE, hydratePosts, type PostRow } from "../posts/service.js";
import { eventCard } from "../events/service.js";
import {
  GROUP_MEMBER_STATE_VALUES,
  GROUP_ROLE_VALUES,
  canActOnMember,
  canSeeGroupDetail,
  canSeeGroupPost,
  isActiveMember,
  isAdmin,
  joinOutcome,
  type GroupMemberState,
  type GroupRole,
} from "./policy.js";
import { ensureInGroupChat, groupCard, groupSearchText, uniqueGroupSlug } from "./service.js";

const RoleIn = z.enum(GROUP_ROLE_VALUES as [GroupRole, ...GroupRole[]]);
const StateIn = z.enum(GROUP_MEMBER_STATE_VALUES as [GroupMemberState, ...GroupMemberState[]]);

const CreateGroupSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(4000).optional(),
  category: z.string().trim().max(80).optional(),
  isPrivate: z.boolean().default(false),
  requiresApproval: z.boolean().default(false),
  rules: z.string().trim().max(4000).optional(),
});

const PatchGroupSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(4000).optional(),
  category: z.string().trim().max(80).optional(),
  isPrivate: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  rules: z.string().trim().max(4000).optional(),
});

type MembershipRow = { role: GroupRole; state: GroupMemberState } | null;

async function membershipOf(db: Db, groupId: string, personId: string | null): Promise<MembershipRow> {
  if (!personId) return null;
  const m = await db.groupMember.findUnique({ where: { groupId_personId: { groupId, personId } } });
  return m ? { role: m.role as GroupRole, state: m.state as GroupMemberState } : null;
}

async function loadGroupOr404(db: Db, id: string) {
  const group = await db.group.findUnique({ where: { id } });
  if (!group) throw notFound("That group");
  return group;
}

export function registerGroupRoutes(app: FastifyInstance, db: Db) {
  const viewerOf = (req: FastifyRequest) => req.actor?.personId ?? null;

  /* ───────────────────────────── Create ───────────────────────────── */
  app.post("/groups", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const input = CreateGroupSchema.parse(req.body);
    const slug = await uniqueGroupSlug(db, input.name);
    const searchText = groupSearchText(input);

    const created = await db.$transaction(async (tx) => {
      const thread = await tx.thread.create({
        data: { kind: "GROUP_CHAT", title: input.name, createdById: actor.personId, groupId: null, participants: { create: [{ personId: actor.personId, role: "ADMIN", state: "ACTIVE" }] } },
      });
      const group = await tx.group.create({
        data: {
          slug,
          name: input.name,
          description: input.description ?? null,
          category: input.category ?? null,
          isPrivate: input.isPrivate,
          requiresApproval: input.requiresApproval,
          rules: input.rules ?? null,
          chatThreadId: thread.id,
          memberCount: 1,
          createdById: actor.personId,
          searchText,
          members: { create: [{ personId: actor.personId, role: "OWNER", state: "ACTIVE" }] },
        },
      });
      await tx.thread.update({ where: { id: thread.id }, data: { groupId: group.id } });
      return group;
    });

    await track(db, { personId: actor.personId, event: "group_join", objectType: "Group", objectId: created.id });
    reply.status(201);
    return { group: groupCard(created) };
  });

  /* ───────────────────────────── Discover / mine / categories ───────────────────────────── */
  app.get("/groups", async (req) => {
    const actor = requireActor(req);
    const q = z.object({ q: z.string().trim().max(200).optional(), category: z.string().trim().max(80).optional(), cursor: z.string().optional(), limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(q.limit, 20, 50);
    const cur = decodeCursor(q.cursor);
    const mine = await db.groupMember.findMany({ where: { personId: actor.personId, state: { in: ["ACTIVE", "PENDING"] } }, select: { groupId: true } });
    const mineIds = mine.map((m) => m.groupId);
    const where: any = { OR: [{ isPrivate: false }, { id: { in: mineIds } }] };
    if (q.category) where.category = q.category;
    if (q.q) {
      const needle = q.q.toLowerCase();
      where.AND = [{ OR: [{ name: { contains: needle, mode: "insensitive" } }, { description: { contains: needle, mode: "insensitive" } }] }];
    }
    const rows = await db.group.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cur ? { cursor: { id: cur.id }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].createdAt, page[page.length - 1].id) : null;
    const memberships = await db.groupMember.findMany({ where: { groupId: { in: page.map((g) => g.id) }, personId: actor.personId } });
    const byGroup = new Map(memberships.map((m) => [m.groupId, { role: m.role, state: m.state }]));
    return { items: page.map((g) => ({ ...groupCard(g), myMembership: byGroup.get(g.id) ?? null })), nextCursor };
  });

  app.get("/me/groups", async (req) => {
    const actor = requireActor(req);
    const memberships = await db.groupMember.findMany({ where: { personId: actor.personId, state: { in: ["ACTIVE", "PENDING"] } }, include: { group: true }, orderBy: { joinedAt: "desc" } });
    return { items: memberships.map((m) => ({ ...groupCard(m.group), myMembership: { role: m.role, state: m.state } })) };
  });

  app.get("/groups/categories", async () => {
    const rows = await db.group.groupBy({ by: ["category"], where: { category: { not: null } }, _count: { _all: true } });
    return { categories: rows.map((r) => ({ category: r.category as string, count: r._count._all })).sort((a, b) => b.count - a.count) };
  });

  /* ───────────────────────────── Public detail ───────────────────────────── */
  app.get("/public/groups/:slug", async (req) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const viewerId = viewerOf(req);
    const group = await db.group.findUnique({ where: { slug } });
    if (!group) throw notFound("That group");
    const m = await membershipOf(db, group.id, viewerId);
    const view = canSeeGroupDetail(group, m);
    if (view === "preview") {
      return { group: { id: group.id, slug: group.slug, name: group.name, description: group.description, isPrivate: true, memberCount: group.memberCount }, preview: true, myMembership: m };
    }
    const [admins, counts] = await Promise.all([
      db.groupMember.findMany({ where: { groupId: group.id, role: { in: ["OWNER", "ADMIN"] }, state: "ACTIVE" }, select: { personId: true }, take: 5 }),
      Promise.all([
        db.groupMember.count({ where: { groupId: group.id, state: "ACTIVE" } }),
        db.post.count({ where: { groupId: group.id, deletedAt: null } }),
        db.groupFile.count({ where: { groupId: group.id } }),
        db.event.count({ where: { groupId: group.id } }),
      ]),
    ]);
    const adminCards = await personCards(db, admins.map((a) => a.personId));
    return {
      group: groupCard(group),
      preview: false,
      rules: group.rules,
      pinnedPostIds: group.pinnedPostIds,
      admins: admins.map((a) => adminCards.get(a.personId)).filter(Boolean),
      counts: { members: counts[0], posts: counts[1], files: counts[2], events: counts[3] },
      myMembership: m,
    };
  });

  /* ───────────────────────────── Edit / cover / logo / delete ───────────────────────────── */
  app.patch("/groups/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const group = await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, actor.personId);
    if (!isAdmin(m)) throw forbidden("Only a group owner or admin can edit this group.");
    const body = PatchGroupSchema.parse(req.body);
    const data: Record<string, unknown> = { ...body };
    if (["name", "description", "category", "rules"].some((k) => k in body)) {
      data.searchText = groupSearchText({ name: body.name ?? group.name, description: body.description ?? group.description, category: body.category ?? group.category, rules: body.rules ?? group.rules });
    }
    const updated = await db.group.update({ where: { id }, data });
    await audit(db, { actorId: actor.personId, action: "group.update", targetType: "Group", targetId: id, before: body, after: updated });
    return { group: groupCard(updated) };
  });

  app.post("/groups/:id/cover", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, actor.personId);
    if (!isAdmin(m)) throw forbidden("Only a group owner or admin can change the cover.");
    const file = await req.file();
    if (!file) throw badRequest("file_required", "Choose an image to upload.");
    const asset = await storeUpload(db, actor.personId, { buffer: await file.toBuffer(), filename: file.filename, mimetype: file.mimetype }, { allow: ["image"] });
    await db.group.update({ where: { id }, data: { coverAssetId: asset.id } });
    await audit(db, { actorId: actor.personId, action: "group.cover_changed", targetType: "Group", targetId: id, after: { assetId: asset.id } });
    return { asset };
  });

  app.post("/groups/:id/logo", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, actor.personId);
    if (!isAdmin(m)) throw forbidden("Only a group owner or admin can change the logo.");
    const file = await req.file();
    if (!file) throw badRequest("file_required", "Choose an image to upload.");
    const asset = await storeUpload(db, actor.personId, { buffer: await file.toBuffer(), filename: file.filename, mimetype: file.mimetype }, { allow: ["image"] });
    await db.group.update({ where: { id }, data: { logoAssetId: asset.id } });
    await audit(db, { actorId: actor.personId, action: "group.logo_changed", targetType: "Group", targetId: id, after: { assetId: asset.id } });
    return { asset };
  });

  app.delete("/groups/:id", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const group = await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, actor.personId);
    if (m?.role !== "OWNER") throw forbidden("Only the group owner can delete this group.");
    await db.$transaction(async (tx) => {
      if (group.chatThreadId) {
        await tx.thread.delete({ where: { id: group.chatThreadId } }).catch(() => undefined);
      }
      await tx.group.delete({ where: { id } });
    });
    await audit(db, { actorId: actor.personId, action: "group.deleted", targetType: "Group", targetId: id });
    return { ok: true };
  });

  /* ───────────────────────────── Membership ───────────────────────────── */
  app.post("/groups/:id/join", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const group = await loadGroupOr404(db, id);
    const existing = await membershipOf(db, id, actor.personId);
    if (existing?.state === "ACTIVE") return { membership: existing };
    if (existing?.state === "BANNED") throw forbidden("You can't rejoin this group.");

    // An existing PENDING row (created by an invite, or by a prior approval request) accepts/re-sends straight to ACTIVE
    // when the person clicking join was the one invited or is now joining a group whose approval already queued them.
    if (existing?.state === "PENDING") {
      await db.groupMember.update({ where: { groupId_personId: { groupId: id, personId: actor.personId } }, data: { state: "ACTIVE" } });
      await db.group.update({ where: { id }, data: { memberCount: { increment: 1 } } });
      await ensureInGroupChat(db, group.chatThreadId, actor.personId);
      await track(db, { personId: actor.personId, event: "group_join", objectType: "Group", objectId: id });
      return { membership: { role: existing.role, state: "ACTIVE" } };
    }

    const outcome = joinOutcome(group);
    if (outcome === "blocked") throw notFound("That group");

    if (outcome === "pending") {
      await db.groupMember.create({ data: { groupId: id, personId: actor.personId, role: "MEMBER", state: "PENDING" } });
      const admins = await db.groupMember.findMany({ where: { groupId: id, role: { in: ["OWNER", "ADMIN"] }, state: "ACTIVE" }, select: { personId: true } });
      const requester = await personCard(db, actor.personId);
      await Promise.all(
        admins.map((a) =>
          notify(db, { personId: a.personId, kind: "group.request", title: `${requester?.name ?? "Someone"} wants to join ${group.name}`, href: `/groups/${group.slug}`, actorId: actor.personId, objectType: "Group", objectId: id, groupKey: `group-request:${id}` }),
        ),
      );
      return { membership: { role: "MEMBER", state: "PENDING" } };
    }

    await db.$transaction([
      db.groupMember.create({ data: { groupId: id, personId: actor.personId, role: "MEMBER", state: "ACTIVE" } }),
      db.group.update({ where: { id }, data: { memberCount: { increment: 1 } } }),
    ]);
    await ensureInGroupChat(db, group.chatThreadId, actor.personId);
    await track(db, { personId: actor.personId, event: "group_join", objectType: "Group", objectId: id });
    return { membership: { role: "MEMBER", state: "ACTIVE" } };
  });

  app.post("/groups/:id/leave", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const group = await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, actor.personId);
    if (!m || m.state === "LEFT") return { ok: true };
    if (m.role === "OWNER") {
      const otherAdmins = await db.groupMember.count({ where: { groupId: id, state: "ACTIVE", role: { in: ["OWNER", "ADMIN"] }, personId: { not: actor.personId } } });
      if (otherAdmins === 0) throw conflict("last_owner", "You're the only owner or admin. Promote someone else before you leave.");
    }
    const wasActive = m.state === "ACTIVE";
    await db.groupMember.update({ where: { groupId_personId: { groupId: id, personId: actor.personId } }, data: { state: "LEFT" } });
    if (wasActive) await db.group.update({ where: { id }, data: { memberCount: { decrement: 1 } } });
    if (group.chatThreadId) {
      await db.threadParticipant.updateMany({ where: { threadId: group.chatThreadId, personId: actor.personId }, data: { state: "LEFT" } });
    }
    return { ok: true };
  });

  app.get("/groups/:id/members", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, actor.personId);
    const q = z.object({ state: StateIn.default("ACTIVE"), cursor: z.string().optional(), limit: z.string().optional() }).parse(req.query);
    if (q.state !== "ACTIVE" && !isAdmin(m)) throw forbidden("Only a group owner or admin can see that list.");
    if (!isActiveMember(m) && !isAdmin(m)) throw forbidden("Join this group to see its members.");
    const limit = clampLimit(q.limit, 30, 100);
    const cur = decodeCursor(q.cursor);
    const rows = await db.groupMember.findMany({
      where: { groupId: id, state: q.state },
      orderBy: { joinedAt: "desc" },
      take: limit + 1,
      ...(cur ? { skip: 1, cursor: { groupId_personId: { groupId: id, personId: cur.id } } } : {}),
    });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].joinedAt, page[page.length - 1].personId) : null;
    const cards = await personCards(db, page.map((r) => r.personId));
    return { items: page.map((r) => ({ person: cards.get(r.personId) ?? null, role: r.role, state: r.state, joinedAt: r.joinedAt.toISOString() })), nextCursor };
  });

  app.patch("/groups/:id/members/:personId", async (req) => {
    const actor = requireActor(req);
    const { id, personId } = z.object({ id: z.string(), personId: z.string() }).parse(req.params);
    const group = await loadGroupOr404(db, id);
    const actorM = await membershipOf(db, id, actor.personId);
    const targetM = await membershipOf(db, id, personId);
    if (!targetM) throw notFound("That member");
    if (!canActOnMember(actorM, targetM)) throw forbidden("You don't have permission to change that member.");
    const body = z.object({ role: RoleIn.optional(), state: StateIn.optional() }).parse(req.body);
    if (!body.role && !body.state) throw badRequest("nothing_to_change", "Pick a role or a status to change.");
    if (body.role === "OWNER" && actorM?.role !== "OWNER") throw forbidden("Only the current owner can hand off ownership.");
    if (targetM.role === "OWNER" && body.role && body.role !== "OWNER" && actorM?.role !== "OWNER") throw forbidden("Only the owner can change the owner's role.");

    const wasActive = targetM.state === "ACTIVE";
    const data: Record<string, unknown> = {};
    if (body.role) data.role = body.role;
    if (body.state) data.state = body.state;
    await db.groupMember.update({ where: { groupId_personId: { groupId: id, personId } }, data });
    const nowActive = (body.state ?? targetM.state) === "ACTIVE";
    if (wasActive && !nowActive) await db.group.update({ where: { id }, data: { memberCount: { decrement: 1 } } });
    if (!wasActive && nowActive) {
      await db.group.update({ where: { id }, data: { memberCount: { increment: 1 } } });
      await ensureInGroupChat(db, group.chatThreadId, personId);
      const approver = await personCard(db, actor.personId);
      await notify(db, { personId, kind: "group.approved", title: `You're in — ${group.name}`, href: `/groups/${group.slug}`, actorId: actor.personId, objectType: "Group", objectId: id });
      void approver;
    }
    if (body.state === "BANNED" && group.chatThreadId) {
      await db.threadParticipant.updateMany({ where: { threadId: group.chatThreadId, personId }, data: { state: "LEFT" } });
    }
    await audit(db, { actorId: actor.personId, action: "group.member_update", targetType: "GroupMember", targetId: `${id}:${personId}`, before: targetM, after: body });
    return { ok: true };
  });

  app.post("/groups/:id/invites", async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const group = await loadGroupOr404(db, id);
    const actorM = await membershipOf(db, id, actor.personId);
    if (!isActiveMember(actorM)) throw forbidden("Join this group before inviting others.");
    const body = z.object({ personIds: z.array(z.string()).min(1).max(50) }).parse(req.body);
    const myConnections = new Set(await connectionIds(db, actor.personId));
    const inviter = await personCard(db, actor.personId);
    const invited: string[] = [];
    for (const personId of body.personIds) {
      if (personId === actor.personId) continue;
      if (!myConnections.has(personId)) continue;
      const existing = await membershipOf(db, id, personId);
      if (existing) continue;
      await db.groupMember.create({ data: { groupId: id, personId, role: "MEMBER", state: "PENDING" } });
      await notify(db, { personId, kind: "group.request", title: `${inviter?.name ?? "Someone"} invited you to ${group.name}`, href: `/groups/${group.slug}`, actorId: actor.personId, objectType: "Group", objectId: id });
      invited.push(personId);
    }
    return { invited };
  });

  /* ───────────────────────────── Posts (feed tab) ───────────────────────────── */
  app.post("/groups/:id/posts", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const group = await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, actor.personId);
    if (!isActiveMember(m)) throw forbidden("Join this group to post here.");
    const input = z
      .object({
        body: z.string().max(6000).optional(),
        mediaAssetIds: z.array(z.string()).max(10).optional(),
        poll: z.object({ question: z.string().min(1).max(300), options: z.array(z.string().min(1).max(120)).min(2).max(6), closesInHours: z.number().int().positive().max(24 * 30).optional() }).optional(),
      })
      .parse(req.body);
    if (!input.body?.trim() && !input.mediaAssetIds?.length && !input.poll) throw badRequest("empty_post", "Write something, add media, or a poll before posting.");

    let assets: Array<{ id: string; kind: string }> = [];
    if (input.mediaAssetIds?.length) {
      const found = await db.mediaAsset.findMany({ where: { id: { in: input.mediaAssetIds }, ownerId: actor.personId }, select: { id: true, kind: true } });
      if (found.length !== input.mediaAssetIds.length) throw badRequest("media_not_found", "One of those files isn't yours or doesn't exist.");
      assets = found;
    }
    const kind = input.poll ? "POLL" : assets.some((a) => a.kind === "video") ? "VIDEO" : assets.filter((a) => a.kind === "image").length > 1 ? "GALLERY" : assets.some((a) => a.kind === "image") ? "IMAGE" : "TEXT";
    const authorCard = await personCard(db, actor.personId);
    const searchText = buildSearchText([input.body, authorCard?.name ?? actor.username]);

    const created = await db.$transaction(async (tx) => {
      const post = await tx.post.create({
        data: { authorId: actor.personId, groupId: id, kind: kind as any, body: input.body ?? null, visibility: "PUBLIC", commentsPolicy: "ANYONE", publishedAt: new Date(), searchText },
      });
      if (assets.length) await tx.postMedia.createMany({ data: assets.map((a, i) => ({ postId: post.id, assetId: a.id, sortOrder: i })) });
      if (input.poll) {
        const closesAt = input.poll.closesInHours ? new Date(Date.now() + input.poll.closesInHours * 3_600_000) : null;
        await tx.poll.create({ data: { postId: post.id, question: input.poll.question, closesAt, options: { create: input.poll.options.map((text, i) => ({ text, sortOrder: i })) } } });
      }
      return post;
    });
    const row = await db.post.findUnique({ where: { id: created.id }, include: POST_INCLUDE });
    const [dto] = await hydratePosts(db, [row as unknown as PostRow], actor.personId);
    reply.status(201);
    return { post: dto };
  });

  app.get("/groups/:id/posts", async (req) => {
    const viewerId = viewerOf(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const group = await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, viewerId);
    if (!canSeeGroupPost(group, m)) throw forbidden("This group is private. Ask a member to invite you.");
    const q = z.object({ cursor: z.string().optional(), limit: z.string().optional() }).parse(req.query);
    const limit = clampLimit(q.limit, 20, 50);
    const cur = decodeCursor(q.cursor);
    const where: any = { groupId: id, deletedAt: null, publishedAt: { not: null } };
    if (cur) where.publishedAt = { lt: new Date(cur.value) };
    const rows = await db.post.findMany({ where, orderBy: { publishedAt: "desc" }, take: limit + 1, include: POST_INCLUDE });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1].publishedAt!, page[page.length - 1].id) : null;
    const items = await hydratePosts(db, page as unknown as PostRow[], viewerId);
    return { items, nextCursor, pinnedPostIds: group.pinnedPostIds };
  });

  app.post("/groups/:id/posts/:postId/pin", async (req) => {
    const actor = requireActor(req);
    const { id, postId } = z.object({ id: z.string(), postId: z.string() }).parse(req.params);
    const group = await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, actor.personId);
    if (!isAdmin(m)) throw forbidden("Only a group owner or admin can pin posts.");
    const post = await db.post.findFirst({ where: { id: postId, groupId: id, deletedAt: null } });
    if (!post) throw notFound("That post");
    const already = group.pinnedPostIds.includes(postId);
    const pinnedPostIds = already ? group.pinnedPostIds.filter((p) => p !== postId) : [postId, ...group.pinnedPostIds].slice(0, 5);
    await db.group.update({ where: { id }, data: { pinnedPostIds } });
    await audit(db, { actorId: actor.personId, action: already ? "group.post_unpinned" : "group.post_pinned", targetType: "Post", targetId: postId, organizationId: null });
    return { pinnedPostIds, pinned: !already };
  });

  /* ───────────────────────────── Files ───────────────────────────── */
  app.post("/groups/:id/files", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, actor.personId);
    if (!isActiveMember(m)) throw forbidden("Join this group to share files here.");
    let buffer: Buffer | null = null;
    let filename: string | undefined;
    let mimetype: string | undefined;
    let title = "";
    for await (const part of req.parts()) {
      if (part.type === "file" && part.fieldname === "file") {
        buffer = await part.toBuffer();
        filename = part.filename;
        mimetype = part.mimetype;
      } else if (part.type === "field" && part.fieldname === "title") {
        title = String(part.value).slice(0, 160);
      }
    }
    if (!buffer) throw badRequest("file_required", "Choose a file to upload.");
    const asset = await storeUpload(db, actor.personId, { buffer, filename, mimetype }, { allow: ["image", "document", "video", "audio"] });
    const file = await db.groupFile.create({ data: { groupId: id, assetId: asset.id, uploaderId: actor.personId, title: title || filename || "File" } });
    reply.status(201);
    return { file: { id: file.id, assetId: asset.id, title: file.title, uploaderId: file.uploaderId, createdAt: file.createdAt.toISOString(), asset } };
  });

  app.get("/groups/:id/files", async (req) => {
    const viewerId = viewerOf(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const group = await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, viewerId);
    if (canSeeGroupDetail(group, m) === "preview") throw forbidden("This group is private. Ask a member to invite you.");
    const rows = await db.groupFile.findMany({ where: { groupId: id }, orderBy: { createdAt: "desc" }, take: 100 });
    const cards = await personCards(db, rows.map((r) => r.uploaderId));
    return { items: rows.map((r) => ({ id: r.id, assetId: r.assetId, title: r.title, uploader: cards.get(r.uploaderId) ?? null, createdAt: r.createdAt.toISOString() })) };
  });

  app.delete("/groups/:id/files/:fileId", async (req) => {
    const actor = requireActor(req);
    const { id, fileId } = z.object({ id: z.string(), fileId: z.string() }).parse(req.params);
    const file = await db.groupFile.findFirst({ where: { id: fileId, groupId: id } });
    if (!file) throw notFound("That file");
    const m = await membershipOf(db, id, actor.personId);
    if (file.uploaderId !== actor.personId && !isAdmin(m)) throw forbidden("Only the uploader or a group admin can delete this file.");
    await db.groupFile.delete({ where: { id: fileId } });
    return { ok: true };
  });

  /* ───────────────────────────── Chat ───────────────────────────── */
  app.get("/groups/:id/chat", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const group = await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, actor.personId);
    if (!isActiveMember(m)) throw forbidden("Join this group to open its chat.");
    if (!group.chatThreadId) throw notFound("This group's chat");
    await ensureInGroupChat(db, group.chatThreadId, actor.personId);
    return { threadId: group.chatThreadId };
  });

  /* ───────────────────────────── Jobs / listings (read-only, sourced from members) ───────────────────────────── */
  async function activeMemberOrgIds(id: string) {
    const members = await db.groupMember.findMany({ where: { groupId: id, state: "ACTIVE" }, select: { personId: true } });
    const personIds = members.map((m) => m.personId);
    const memberships = await db.membership.findMany({ where: { personId: { in: personIds } }, select: { organizationId: true } });
    return { personIds, orgIds: [...new Set(memberships.map((m) => m.organizationId))] };
  }

  app.get("/groups/:id/events", async (req) => {
    const viewerId = viewerOf(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const group = await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, viewerId);
    if (canSeeGroupDetail(group, m) === "preview") throw forbidden("This group is private. Ask a member to invite you.");
    const rows = await db.event.findMany({ where: { groupId: id }, orderBy: { startsAt: "asc" }, take: 50 });
    return { items: rows.map(eventCard) };
  });

  app.get("/groups/:id/jobs", async (req) => {
    const viewerId = viewerOf(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const group = await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, viewerId);
    if (canSeeGroupDetail(group, m) === "preview") throw forbidden("This group is private. Ask a member to invite you.");
    const since = new Date(Date.now() - 90 * 86_400_000);
    const { orgIds } = await activeMemberOrgIds(id);
    const jobs = orgIds.length ? await db.job.findMany({ where: { organizationId: { in: orgIds }, status: "OPEN", createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 30 }) : [];
    return { items: jobs, source: "members" };
  });

  app.get("/groups/:id/listings", async (req) => {
    const viewerId = viewerOf(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const group = await loadGroupOr404(db, id);
    const m = await membershipOf(db, id, viewerId);
    if (canSeeGroupDetail(group, m) === "preview") throw forbidden("This group is private. Ask a member to invite you.");
    const since = new Date(Date.now() - 90 * 86_400_000);
    const { personIds, orgIds } = await activeMemberOrgIds(id);
    const listings =
      personIds.length || orgIds.length
        ? await db.listing.findMany({ where: { OR: [{ sellerPersonId: { in: personIds } }, { organizationId: { in: orgIds } }], createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 30 })
        : [];
    return { items: listings, source: "members" };
  });
}
