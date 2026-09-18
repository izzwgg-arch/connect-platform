import type { Db } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { notify } from "../lib/notify.js";

export type TargetSummary = {
  title: string;
  href: string | null;
  /** Raw fields for the evidence panel — shape varies by targetType. */
  evidence: Record<string, unknown> | null;
};

function truncate(s: string | null | undefined, n = 240): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Resolves a moderation target to a queue title/href + case-detail evidence. Absent rows read as "deleted". */
export async function loadTarget(db: Db, targetType: string, targetId: string): Promise<TargetSummary> {
  try {
    switch (targetType) {
      case "person": {
        const p = await db.person.findUnique({ where: { id: targetId }, select: { username: true, profile: { select: { firstName: true, lastName: true, headline: true, about: true } } } });
        if (!p) return { title: "(deleted person)", href: null, evidence: null };
        const name = p.profile ? `${p.profile.firstName} ${p.profile.lastName}`.trim() : p.username;
        return { title: name, href: `/people/${p.username}`, evidence: { headline: p.profile?.headline ?? null, about: truncate(p.profile?.about) } };
      }
      case "organization": {
        const o = await db.organization.findUnique({ where: { id: targetId }, select: { displayName: true, slug: true, description: true, website: true, status: true } });
        if (!o) return { title: "(deleted company)", href: null, evidence: null };
        return { title: o.displayName, href: `/companies/${o.slug}`, evidence: { description: truncate(o.description), website: o.website, status: o.status } };
      }
      case "post": {
        const post = await db.post.findUnique({ where: { id: targetId }, select: { body: true, authorId: true, deletedAt: true, media: { select: { assetId: true } } } });
        if (!post) return { title: "(deleted post)", href: null, evidence: null };
        return { title: truncate(post.body, 80) || "(media post)", href: `/posts/${targetId}`, evidence: { body: post.body, mediaAssetIds: post.media.map((m) => m.assetId), removed: !!post.deletedAt, authorId: post.authorId } };
      }
      case "comment": {
        const c = await db.comment.findUnique({ where: { id: targetId }, select: { body: true, postId: true, authorId: true, deletedAt: true } });
        if (!c) return { title: "(deleted comment)", href: null, evidence: null };
        return { title: truncate(c.body, 80), href: `/posts/${c.postId}`, evidence: { body: c.body, removed: !!c.deletedAt, authorId: c.authorId } };
      }
      case "message": {
        const m = await db.message.findUnique({ where: { id: targetId }, select: { body: true, threadId: true, senderId: true, kind: true, deletedAt: true, createdAt: true } });
        if (!m) return { title: "(deleted message)", href: null, evidence: null };
        return { title: truncate(m.body, 80) || `(${m.kind.toLowerCase()})`, href: `/messages/${m.threadId}`, evidence: { body: m.body, kind: m.kind, removed: !!m.deletedAt, senderId: m.senderId, createdAt: m.createdAt } };
      }
      case "job": {
        const j = await db.job.findUnique({ where: { id: targetId }, select: { title: true, description: true, status: true, organizationId: true, createdById: true } });
        if (!j) return { title: "(deleted job)", href: null, evidence: null };
        return { title: j.title, href: `/jobs/${targetId}`, evidence: { description: truncate(j.description), status: j.status, createdById: j.createdById } };
      }
      case "listing": {
        const l = await db.listing.findUnique({ where: { id: targetId }, select: { title: true, description: true, status: true, sellerPersonId: true, organizationId: true } });
        if (!l) return { title: "(deleted listing)", href: null, evidence: null };
        return { title: l.title, href: `/marketplace/${targetId}`, evidence: { description: truncate(l.description), status: l.status, sellerPersonId: l.sellerPersonId, organizationId: l.organizationId } };
      }
      case "rfq": {
        const r = await db.rfq.findUnique({ where: { id: targetId }, select: { title: true, description: true, status: true, buyerPersonId: true, number: true } });
        if (!r) return { title: "(deleted rfq)", href: null, evidence: null };
        return { title: `${r.number} — ${r.title}`, href: `/rfq/${targetId}`, evidence: { description: truncate(r.description), status: r.status, buyerPersonId: r.buyerPersonId } };
      }
      case "event": {
        const e = await db.event.findUnique({ where: { id: targetId }, select: { title: true, description: true, slug: true, hostId: true } });
        if (!e) return { title: "(deleted event)", href: null, evidence: null };
        return { title: e.title, href: `/events/${e.slug}`, evidence: { description: truncate(e.description), hostId: e.hostId } };
      }
      case "group": {
        const g = await db.group.findUnique({ where: { id: targetId }, select: { name: true, description: true, slug: true } });
        if (!g) return { title: "(deleted group)", href: null, evidence: null };
        return { title: g.name, href: `/groups/${g.slug}`, evidence: { description: truncate(g.description) } };
      }
      default:
        return { title: `${targetType} #${targetId.slice(-6)}`, href: null, evidence: null };
    }
  } catch {
    return { title: "(couldn't load)", href: null, evidence: null };
  }
}

/**
 * REMOVE_CONTENT effects. Only post/comment/message/listing/job/opportunity/rfq
 * have a field the schema lets us soft-delete or close; person/organization/
 * event/group are moderated through SUSPEND/BAN instead (no removable field
 * for the object itself), so those throw a clear refusal.
 */
export async function removeContent(db: Db, targetType: string, targetId: string, moderatorId: string): Promise<void> {
  switch (targetType) {
    case "post": {
      const post = await db.post.update({ where: { id: targetId }, data: { deletedAt: new Date() } }).catch(() => null);
      if (post) await notify(db, { personId: post.authorId, kind: "moderation.action", title: "Your post was removed", body: "A moderator removed a post that broke community rules.", href: "/settings/notices", actorId: moderatorId });
      return;
    }
    case "comment": {
      const c = await db.comment.update({ where: { id: targetId }, data: { deletedAt: new Date() } }).catch(() => null);
      if (c) await notify(db, { personId: c.authorId, kind: "moderation.action", title: "Your comment was removed", body: "A moderator removed a comment that broke community rules.", href: "/settings/notices", actorId: moderatorId });
      return;
    }
    case "message": {
      const m = await db.message.update({ where: { id: targetId }, data: { deletedAt: new Date() } }).catch(() => null);
      if (m) await notify(db, { personId: m.senderId, kind: "moderation.action", title: "Your message was removed", body: "A moderator removed a message that broke community rules.", href: "/settings/notices", actorId: moderatorId });
      return;
    }
    case "listing": {
      const l = await db.listing.update({ where: { id: targetId }, data: { status: "REMOVED" } }).catch(() => null);
      if (l?.sellerPersonId) await notify(db, { personId: l.sellerPersonId, kind: "moderation.action", title: "Your listing was removed", body: "A moderator removed a listing that broke community rules.", href: "/settings/notices", actorId: moderatorId });
      return;
    }
    case "job": {
      const j = await db.job.update({ where: { id: targetId }, data: { status: "CLOSED", closedAt: new Date() } }).catch(() => null);
      if (j) {
        const org = await db.organization.findUnique({ where: { id: j.organizationId }, select: { memberships: { where: { role: "OWNER" }, select: { personId: true } } } }).catch(() => null);
        for (const m of org?.memberships ?? []) {
          await notify(db, { personId: m.personId, kind: "moderation.action", title: "A job post was closed", body: "A moderator closed a job post that broke community rules.", href: "/settings/notices", actorId: moderatorId });
        }
      }
      return;
    }
    case "opportunity": {
      const o = await db.opportunity.update({ where: { id: targetId }, data: { status: "REMOVED" } }).catch(() => null);
      if (o) await notify(db, { personId: o.posterId, kind: "moderation.action", title: "Your opportunity was removed", body: "A moderator removed an opportunity that broke community rules.", href: "/settings/notices", actorId: moderatorId });
      return;
    }
    case "rfq": {
      const r = await db.rfq.update({ where: { id: targetId }, data: { status: "CANCELLED" } }).catch(() => null);
      if (r) await notify(db, { personId: r.buyerPersonId, kind: "moderation.action", title: "Your RFQ was removed", body: "A moderator removed an RFQ that broke community rules.", href: "/settings/notices", actorId: moderatorId });
      return;
    }
    default:
      throw badRequest("not_removable", "That kind of content can't be removed directly — suspend or ban the account or company instead.");
  }
}
