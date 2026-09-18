import type { Db } from "../db.js";
import { env } from "../env.js";
import { badRequest } from "../lib/errors.js";
import { personCards, type PersonCard } from "../profiles/cards.js";
import { orgCards, type OrgCard } from "../organizations/cards.js";
import { isPrivateHost, REF_MODELS } from "./policy.js";

/* ───────────────────────────── Link previews ───────────────────────────── */

export type LinkPreview = { title: string | null; description: string | null; image: string | null; url: string };

function metaOf(html: string, prop: string): string | null {
  const a = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]*content=["']([^"']*)["']`, "i"));
  if (a?.[1]) return a[1];
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:${prop}["']`, "i"));
  if (b?.[1]) return b[1];
  const c = html.match(new RegExp(`<meta[^>]+name=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i"));
  return c?.[1] ?? null;
}

export function extractLinkMeta(html: string): { title: string | null; description: string | null; image: string | null } {
  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return {
    title: metaOf(html, "title") ?? (titleTag?.[1]?.trim() || null),
    description: metaOf(html, "description"),
    image: metaOf(html, "image"),
  };
}

/**
 * Fetches a page server-side and pulls a link-preview card from it. Refuses
 * to reach private/loopback/link-local addresses (SSRF guard) — checked on
 * the URL's hostname before any network call, so it is cheap and testable
 * without a real fetch. 5s timeout, 512KB read cap.
 */
export async function fetchLinkPreview(rawUrl: string, fetchImpl: typeof fetch = fetch): Promise<LinkPreview> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw badRequest("invalid_url", "That link doesn't look like a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw badRequest("invalid_url", "Only http and https links can be previewed.");
  }
  if (isPrivateHost(u.hostname)) {
    throw badRequest("private_url", "That link points to a private address and can't be previewed.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchImpl(u.toString(), { signal: controller.signal, redirect: "follow" });
    if (!res.ok) return { title: null, description: null, image: null, url: u.toString() };
    const cap = 512 * 1024;
    let html = "";
    const body: any = res.body;
    if (body?.getReader) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let total = 0;
      try {
        while (total < cap) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength ?? 0;
          html += decoder.decode(value, { stream: true });
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
      }
    } else {
      html = (await res.text()).slice(0, cap);
    }
    return { ...extractLinkMeta(html), url: u.toString() };
  } catch (err: any) {
    if (err?.name === "AbortError") return { title: null, description: null, image: null, url: u.toString() };
    throw badRequest("fetch_failed", "Couldn't fetch that link to build a preview.");
  } finally {
    clearTimeout(timer);
  }
}

/* ───────────────────────────── Media URLs ───────────────────────────── */

export function assetVariantUrl(assetId: string, variant: "thumb" | "medium" | "original"): string {
  return `${env().COMMUNITY_API_URL}/media/file/${assetId}/${variant}`;
}

/* ───────────────────────────── Ref resolution ───────────────────────────── */

export type PostRef = { type: string; id: string; title: string; href: string } | null;

/** Reads the referenced row minimally for JOB/EVENT/OPPORTUNITY/RFQ/LISTING/REPOST embeds. Tolerant of a missing row. */
export async function resolveRef(db: Db, refType: string | null, refId: string | null): Promise<PostRef> {
  if (!refType || !refId || !(REF_MODELS as readonly string[]).includes(refType)) return null;
  try {
    switch (refType) {
      case "Job": {
        const j = await db.job.findUnique({ where: { id: refId }, select: { id: true, title: true, status: true } });
        return j ? { type: "JOB", id: j.id, title: j.title, href: `/jobs/${j.id}` } : null;
      }
      case "Event": {
        const e = await db.event.findUnique({ where: { id: refId }, select: { id: true, title: true, slug: true } });
        return e ? { type: "EVENT", id: e.id, title: e.title, href: `/events/${e.slug}` } : null;
      }
      case "Opportunity": {
        const o = await db.opportunity.findUnique({ where: { id: refId }, select: { id: true, title: true } });
        return o ? { type: "OPPORTUNITY", id: o.id, title: o.title, href: `/opportunities/${o.id}` } : null;
      }
      case "Rfq": {
        const r = await db.rfq.findUnique({ where: { id: refId }, select: { id: true, title: true } });
        return r ? { type: "RFQ", id: r.id, title: r.title, href: `/rfq/${r.id}` } : null;
      }
      case "Listing": {
        const l = await db.listing.findUnique({ where: { id: refId }, select: { id: true, title: true } });
        return l ? { type: "LISTING", id: l.id, title: l.title, href: `/marketplace/${l.id}` } : null;
      }
      case "Post": {
        const p = await db.post.findUnique({ where: { id: refId }, select: { id: true, body: true, deletedAt: true } });
        return p && !p.deletedAt ? { type: "REPOST", id: p.id, title: (p.body ?? "").slice(0, 140), href: `/posts/${p.id}` } : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/* ───────────────────────────── DTO hydration ───────────────────────────── */

export type PostMediaDTO = { id: string; kind: string; altText: string | null; urls: { thumb: string; medium: string; original: string } };
export type PostPollDTO = {
  question: string;
  closesAt: string | null;
  options: Array<{ id: string; text: string; voteCount: number }>;
  totalVotes: number;
  myVote: string | null;
};

export type PostDTO = {
  id: string;
  kind: string;
  body: string | null;
  visibility: string;
  commentsPolicy: string;
  linkUrl: string | null;
  linkPreview: LinkPreview | null;
  altText: string | null;
  industry: string | null;
  location: string | null;
  organizationId: string | null;
  publishedAt: string | null;
  scheduledFor: string | null;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
  author: PersonCard | null;
  organization: OrgCard | null;
  media: PostMediaDTO[];
  poll: PostPollDTO | null;
  ref: PostRef;
  repostComment: string | null;
  counts: { reactions: number; comments: number; reposts: number; saves: number; impressions: number };
  myReaction: string | null;
  saved: boolean;
  mentions: PostMentionDTO[];
};

export type PostMentionDTO = { personId: string | null; orgId: string | null; name: string; href: string };

/** Row shape hydratePosts expects — a superset select on db.post. */
export type PostRow = {
  id: string;
  authorId: string;
  organizationId: string | null;
  kind: string;
  body: string | null;
  visibility: string;
  commentsPolicy: string;
  linkUrl: string | null;
  linkPreview: unknown;
  refType: string | null;
  refId: string | null;
  repostComment: string | null;
  altText: string | null;
  industry: string | null;
  location: string | null;
  publishedAt: Date | null;
  scheduledFor: Date | null;
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  reactionCount: number;
  commentCount: number;
  repostCount: number;
  saveCount: number;
  impressionCount: number;
  media: Array<{ id: string; assetId: string; altText: string | null; asset: { kind: string } }>;
  poll: { question: string; closesAt: Date | null; options: Array<{ id: string; text: string; voteCount: number }> } | null;
};

/** Batches author/org cards, viewer reactions/saves/poll votes, and ref resolution across a page of posts. */
export async function hydratePosts(db: Db, rows: PostRow[], viewerId: string | null): Promise<PostDTO[]> {
  if (!rows.length) return [];
  const authorIds = [...new Set(rows.map((r) => r.authorId))];
  const orgIds = [...new Set(rows.map((r) => r.organizationId).filter((x): x is string => !!x))];
  const postIds = rows.map((r) => r.id);
  const [authors, orgs, myReactions, mySaves, myVotes, mentionRows] = await Promise.all([
    personCards(db, authorIds),
    orgCards(db, orgIds),
    viewerId ? db.reaction.findMany({ where: { personId: viewerId, postId: { in: postIds } }, select: { postId: true, kind: true } }) : Promise.resolve([]),
    viewerId ? db.save.findMany({ where: { personId: viewerId, postId: { in: postIds } }, select: { postId: true } }) : Promise.resolve([]),
    viewerId ? db.pollVote.findMany({ where: { personId: viewerId, pollId: { in: postIds } }, select: { pollId: true, optionId: true } }) : Promise.resolve([]),
    db.mention.findMany({ where: { postId: { in: postIds } }, select: { postId: true, personId: true, orgId: true } }),
  ]);
  const reactionByPost = new Map(myReactions.map((r) => [r.postId as string, r.kind]));
  const saveSet = new Set(mySaves.map((s) => s.postId));
  const voteByPoll = new Map(myVotes.map((v) => [v.pollId, v.optionId]));

  const extraPersonIds = mentionRows.filter((m) => m.personId && !authors.has(m.personId)).map((m) => m.personId as string);
  const extraOrgIds = mentionRows.filter((m) => m.orgId && !orgs.has(m.orgId)).map((m) => m.orgId as string);
  const [extraAuthors, extraOrgs] = await Promise.all([personCards(db, extraPersonIds), orgCards(db, extraOrgIds)]);
  const mentionsByPost = new Map<string, PostMentionDTO[]>();
  for (const m of mentionRows) {
    if (!m.postId) continue;
    let dto: PostMentionDTO | null = null;
    if (m.personId) {
      const card = authors.get(m.personId) ?? extraAuthors.get(m.personId);
      dto = { personId: m.personId, orgId: null, name: card?.name ?? "someone", href: card ? `/people/${card.username}` : "#" };
    } else if (m.orgId) {
      const card = orgs.get(m.orgId) ?? extraOrgs.get(m.orgId);
      dto = { personId: null, orgId: m.orgId, name: card?.displayName ?? "a company", href: card ? `/companies/${card.slug}` : "#" };
    }
    if (dto) mentionsByPost.set(m.postId, [...(mentionsByPost.get(m.postId) ?? []), dto]);
  }

  const out: PostDTO[] = [];
  for (const r of rows) {
    const ref = await resolveRef(db, r.refType, r.refId);
    const poll: PostPollDTO | null = r.poll
      ? {
          question: r.poll.question,
          closesAt: r.poll.closesAt ? r.poll.closesAt.toISOString() : null,
          options: r.poll.options.map((o) => ({ id: o.id, text: o.text, voteCount: o.voteCount })),
          totalVotes: r.poll.options.reduce((a, o) => a + o.voteCount, 0),
          myVote: voteByPoll.get(r.id) ?? null,
        }
      : null;
    out.push({
      id: r.id,
      kind: r.kind,
      body: r.body,
      visibility: r.visibility,
      commentsPolicy: r.commentsPolicy,
      linkUrl: r.linkUrl,
      linkPreview: (r.linkPreview as LinkPreview | null) ?? null,
      altText: r.altText,
      industry: r.industry,
      location: r.location,
      organizationId: r.organizationId,
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
      scheduledFor: r.scheduledFor ? r.scheduledFor.toISOString() : null,
      editedAt: r.editedAt ? r.editedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      author: authors.get(r.authorId) ?? null,
      organization: r.organizationId ? orgs.get(r.organizationId) ?? null : null,
      media: r.media
        .sort((a: any, b: any) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map((m) => ({
          id: m.assetId,
          kind: m.asset.kind,
          altText: m.altText,
          urls: { thumb: assetVariantUrl(m.assetId, "thumb"), medium: assetVariantUrl(m.assetId, "medium"), original: assetVariantUrl(m.assetId, "original") },
        })),
      poll,
      ref,
      repostComment: r.repostComment,
      counts: { reactions: r.reactionCount, comments: r.commentCount, reposts: r.repostCount, saves: r.saveCount, impressions: r.impressionCount },
      myReaction: reactionByPost.get(r.id) ?? null,
      saved: saveSet.has(r.id),
      mentions: mentionsByPost.get(r.id) ?? [],
    });
  }
  return out;
}

/* ───────────────────────────── Comments ───────────────────────────── */

export type CommentDTO = {
  id: string;
  postId: string;
  parentId: string | null;
  body: string;
  editedAt: string | null;
  createdAt: string;
  author: PersonCard | null;
  reactionCount: number;
  myReaction: string | null;
  replyCount: number;
  replies: CommentDTO[];
};

type CommentRow = {
  id: string;
  postId: string;
  parentId: string | null;
  body: string;
  editedAt: Date | null;
  createdAt: Date;
  authorId: string;
  reactionCount: number;
  replies?: CommentRow[];
  _count?: { replies: number };
};

/** Hydrates top-level comments (each with up to 3 attached replies) with author cards and the viewer's own reaction. */
export async function hydrateComments(db: Db, rows: CommentRow[], viewerId: string | null): Promise<CommentDTO[]> {
  if (!rows.length) return [];
  const allIds: string[] = [];
  const authorIds = new Set<string>();
  const collect = (list: CommentRow[]) => {
    for (const r of list) {
      allIds.push(r.id);
      authorIds.add(r.authorId);
      if (r.replies?.length) collect(r.replies);
    }
  };
  collect(rows);
  const [authors, myReactions] = await Promise.all([
    personCards(db, [...authorIds]),
    viewerId ? db.reaction.findMany({ where: { personId: viewerId, commentId: { in: allIds } }, select: { commentId: true, kind: true } }) : Promise.resolve([]),
  ]);
  const reactionByComment = new Map(myReactions.map((r) => [r.commentId as string, r.kind]));
  const toDto = (r: CommentRow): CommentDTO => ({
    id: r.id,
    postId: r.postId,
    parentId: r.parentId,
    body: r.body,
    editedAt: r.editedAt ? r.editedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    author: authors.get(r.authorId) ?? null,
    reactionCount: r.reactionCount,
    myReaction: reactionByComment.get(r.id) ?? null,
    replyCount: r._count?.replies ?? r.replies?.length ?? 0,
    replies: (r.replies ?? []).map((x) => toDto({ ...x, replies: [], _count: { replies: 0 } })),
  });
  return rows.map(toDto);
}

export const POST_INCLUDE = {
  media: { include: { asset: { select: { kind: true } } }, orderBy: { sortOrder: "asc" as const } },
  poll: { include: { options: { orderBy: { sortOrder: "asc" as const } } } },
};

/* ───────────────────────────── Scheduling ───────────────────────────── */

/** Publishes ScheduledPosts whose time has come. Registered as a job by posts/routes.ts. */
export async function publishScheduledPosts(db: Db): Promise<void> {
  const due = await db.scheduledPost.findMany({ where: { publishedPostId: null, scheduledFor: { lte: new Date() } }, take: 100 });
  for (const sp of due) {
    const payload = sp.payload as { postId?: string } | null;
    const postId = payload?.postId;
    try {
      if (!postId) throw new Error("scheduled post has no linked draft");
      const post = await db.post.findUnique({ where: { id: postId }, select: { id: true, deletedAt: true } });
      if (!post || post.deletedAt) throw new Error("the draft post is gone");
      await db.post.update({ where: { id: postId }, data: { publishedAt: new Date() } });
      await db.scheduledPost.update({ where: { id: sp.id }, data: { publishedPostId: postId, failedReason: null } });
    } catch (err: any) {
      await db.scheduledPost.update({ where: { id: sp.id }, data: { failedReason: String(err?.message || err).slice(0, 300) } }).catch(() => undefined);
    }
  }
}
