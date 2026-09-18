import type { Db } from "../db.js";
import { env } from "../env.js";
import { personCards, type PersonCard } from "../profiles/cards.js";
import { signMediaUrl } from "../media/service.js";
import { pairKey, isBlockedEitherWay, degreeBetween } from "../policy/graph.js";
import { publishTo, publishToMany } from "../lib/realtime.js";
import { notify } from "../lib/notify.js";
import { track } from "../lib/analytics.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import {
  canSendGiven,
  decideThreadStart,
  isOnline,
  previewFor,
  readReceiptsVisible,
  resolvePrefs,
  sanitizeBody,
  threadHiddenFor,
  WAIT_FOR_ACCEPT_MESSAGE,
  type MessagingPrefs,
  type ParticipantState,
} from "./policy.js";
// (threadHiddenFor / ParticipantState stay imported: used by loadThreadForActor below.)

export type Actor = { personId: string };

/* ── small lookups ──────────────────────────────────────────────────────── */

export async function prefsFor(db: Db, personId: string): Promise<MessagingPrefs> {
  const p = await db.person.findUnique({ where: { id: personId }, select: { preferences: true } });
  return resolvePrefs(p?.preferences);
}

export async function prefsForMany(db: Db, personIds: string[]): Promise<Map<string, MessagingPrefs>> {
  const ids = [...new Set(personIds)];
  if (!ids.length) return new Map();
  const rows = await db.person.findMany({ where: { id: { in: ids } }, select: { id: true, preferences: true, lastSeenAt: true } });
  const out = new Map<string, MessagingPrefs & { lastSeenAt: Date | null }>();
  for (const r of rows) out.set(r.id, { ...resolvePrefs(r.preferences), lastSeenAt: r.lastSeenAt });
  return out as unknown as Map<string, MessagingPrefs>;
}

function assetUrl(asset: { id: string; isPrivate: boolean; variants: unknown }): string {
  if (asset.isPrivate) return signMediaUrl(asset.id, "original");
  return `${env().COMMUNITY_API_URL}/media/file/${asset.id}/original`;
}

/* ── loading a thread for an actor ─────────────────────────────────────── */

export type LoadedThread = {
  thread: NonNullable<Awaited<ReturnType<Db["thread"]["findUnique"]>>>;
  participants: Array<NonNullable<Awaited<ReturnType<Db["threadParticipant"]["findFirst"]>>>>;
  mine: NonNullable<Awaited<ReturnType<Db["threadParticipant"]["findFirst"]>>>;
};

/** Loads a thread + every participant row, and refuses (notFound) unless the actor is a non-hidden participant. */
export async function loadThreadForActor(db: Db, threadId: string, actorId: string, opts: { allowHidden?: boolean } = {}): Promise<LoadedThread> {
  const thread = await db.thread.findUnique({ where: { id: threadId } });
  if (!thread) throw notFound("That thread");
  const participants = await db.threadParticipant.findMany({ where: { threadId } });
  const mine = participants.find((p) => p.personId === actorId);
  if (!mine) throw notFound("That thread");
  if (!opts.allowHidden && threadHiddenFor(mine.state as ParticipantState)) throw notFound("That thread");
  return { thread, participants, mine };
}

/* ── shaping ────────────────────────────────────────────────────────────── */

export async function threadTitle(db: Db, thread: { kind: string; title: string | null }, participants: Array<{ personId: string }>, viewerId: string, cards: Map<string, PersonCard>): Promise<string> {
  if (thread.title) return thread.title;
  if (thread.kind === "DIRECT") {
    const other = participants.find((p) => p.personId !== viewerId);
    return (other && cards.get(other.personId)?.name) || "Conversation";
  }
  return participants
    .filter((p) => p.personId !== viewerId)
    .slice(0, 3)
    .map((p) => cards.get(p.personId)?.name ?? "")
    .filter(Boolean)
    .join(", ") || "Group";
}

export async function shapeParticipants(
  db: Db,
  participants: Array<{ personId: string; state: string; role: string; lastReadAt: Date | null }>,
  viewerId: string,
): Promise<Array<{ person: PersonCard; state: string; role: string; online: boolean; lastReadAt: string | null }>> {
  const ids = participants.map((p) => p.personId);
  const [cards, prefs] = await Promise.all([personCards(db, ids), prefsForMany(db, ids)]);
  const viewerPrefs = prefs.get(viewerId);
  return participants.map((p) => {
    const card = cards.get(p.personId) ?? { id: p.personId, username: "unknown", name: "Unknown", firstName: "", lastName: "", headline: null, avatarAssetId: null, location: null, industry: null, verified: [], primaryOrg: null };
    const pref = prefs.get(p.personId) as (MessagingPrefs & { lastSeenAt: Date | null }) | undefined;
    const online = p.personId === viewerId ? false : isOnline(pref?.lastSeenAt ?? null, pref);
    const showRead = p.personId === viewerId ? true : readReceiptsVisible(viewerPrefs, pref);
    return { person: card, state: p.state, role: p.role, online, lastReadAt: showRead ? (p.lastReadAt ? p.lastReadAt.toISOString() : null) : null };
  });
}

export async function threadListItem(db: Db, thread: { id: string; kind: string; title: string | null; refType: string | null; refId: string | null; lastMessageAt: Date | null; lastMessagePreview: string | null }, participants: Array<{ personId: string; state: string; role: string; lastReadAt: Date | null; unreadCount: number; pinnedAt: Date | null; mutedUntil: Date | null; archivedAt: Date | null }>, viewerId: string) {
  const mine = participants.find((p) => p.personId === viewerId)!;
  const cards = await personCards(db, participants.map((p) => p.personId));
  const title = await threadTitle(db, thread, participants, viewerId, cards);
  const shaped = await shapeParticipants(db, participants, viewerId);
  const requestFromMe = participants.some((p) => p.personId !== viewerId && p.state === "REQUESTED");
  return {
    id: thread.id,
    kind: thread.kind,
    title,
    participants: shaped,
    lastMessageAt: thread.lastMessageAt ? thread.lastMessageAt.toISOString() : null,
    lastMessagePreview: thread.lastMessagePreview,
    unreadCount: mine.unreadCount,
    pinnedAt: mine.pinnedAt ? mine.pinnedAt.toISOString() : null,
    mutedUntil: mine.mutedUntil ? mine.mutedUntil.toISOString() : null,
    ref: thread.refType && thread.refId ? { type: thread.refType, id: thread.refId } : null,
    requestFromMe,
  };
}

export async function messageDto(db: Db, m: { id: string; threadId: string; senderId: string; kind: string; body: string | null; replyToId: string | null; forwardedFromId: string | null; assetId: string | null; refType: string | null; refId: string | null; reactions: unknown; editedAt: Date | null; deletedAt: Date | null; createdAt: Date }, viewerId: string) {
  const [senderCard, asset, replyTo] = await Promise.all([
    personCards(db, [m.senderId]).then((c) => c.get(m.senderId)),
    m.assetId ? db.mediaAsset.findUnique({ where: { id: m.assetId } }) : null,
    m.replyToId ? db.message.findUnique({ where: { id: m.replyToId }, select: { id: true, body: true, senderId: true, deletedAt: true } }) : null,
  ]);
  let replyToDto: { id: string; senderName: string; body: string | null } | null = null;
  if (replyTo) {
    const senderName = (await personCards(db, [replyTo.senderId])).get(replyTo.senderId)?.name ?? "Someone";
    replyToDto = { id: replyTo.id, senderName, body: replyTo.deletedAt ? null : replyTo.body };
  }
  const reactionsRaw = (m.reactions as Record<string, string[]> | null) ?? {};
  const reactions: Record<string, number> = {};
  const mine: string[] = [];
  for (const [emoji, personIds] of Object.entries(reactionsRaw)) {
    if (!Array.isArray(personIds) || !personIds.length) continue;
    reactions[emoji] = personIds.length;
    if (personIds.includes(viewerId)) mine.push(emoji);
  }
  return {
    id: m.id,
    threadId: m.threadId,
    sender: senderCard ?? null,
    kind: m.kind,
    body: m.deletedAt ? null : m.body,
    asset: asset ? { id: asset.id, kind: asset.kind, mime: asset.mime, url: assetUrl(asset), name: asset.originalName } : null,
    replyTo: replyToDto,
    forwardedFrom: m.forwardedFromId,
    refType: m.refType,
    refId: m.refId,
    reactions: { ...reactions, mine },
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    deletedAt: m.deletedAt ? m.deletedAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
  };
}

/* ── thread creation ────────────────────────────────────────────────────── */

export async function findOrCreateDirectThread(db: Db, actorId: string, otherId: string) {
  if (actorId === otherId) throw badRequest("cant_message_self", "You can't start a thread with yourself.");
  if (await isBlockedEitherWay(db, actorId, otherId)) throw notFound("That person");
  const key = pairKey(actorId, otherId);
  const existing = await db.thread.findUnique({ where: { pairKey: key } });
  if (existing) return { thread: existing, created: false };

  const [degree, otherPrefs] = await Promise.all([degreeBetween(db, actorId, otherId), prefsFor(db, otherId)]);
  const outcome = decideThreadStart({ blocked: false, connected: degree === 1, recipientAllowsRequests: otherPrefs.messageRequests !== false });
  if (!outcome.allowed) throw notFound("That person");

  const thread = await db.thread.create({
    data: {
      kind: "DIRECT",
      pairKey: key,
      createdById: actorId,
      participants: {
        create: [
          { personId: actorId, state: "ACTIVE", role: "MEMBER" },
          { personId: otherId, state: outcome.recipientState, role: "MEMBER" },
        ],
      },
    },
  });
  return { thread, created: true };
}

export async function createGroupThread(db: Db, actorId: string, memberIds: string[], title?: string) {
  const ids = [...new Set(memberIds)].filter((id) => id !== actorId);
  if (ids.length < 1) throw badRequest("group_needs_members", "Add at least one other person to start a group.");
  for (const id of ids) {
    if (await isBlockedEitherWay(db, actorId, id)) throw notFound("One of those people");
    const degree = await degreeBetween(db, actorId, id);
    if (degree !== 1) throw forbidden("You can only start a group chat with your connections.");
  }
  const thread = await db.thread.create({
    data: {
      kind: "GROUP",
      title: title ?? null,
      createdById: actorId,
      participants: {
        create: [{ personId: actorId, state: "ACTIVE", role: "ADMIN" }, ...ids.map((id) => ({ personId: id, state: "ACTIVE" as const, role: "MEMBER" }))],
      },
    },
  });
  return thread;
}

/* ── sending ────────────────────────────────────────────────────────────── */

export type SendInput = {
  kind: "TEXT" | "IMAGE" | "FILE" | "AUDIO" | "VIDEO";
  body?: string;
  assetId?: string;
  replyToId?: string;
  refType?: string;
  refId?: string;
};

export async function sendMessage(db: Db, actorId: string, threadId: string, input: SendInput) {
  // Actor's own state DECLINED/LEFT => the thread is invisible to them: notFound, same as absence.
  const { thread, participants, mine } = await loadThreadForActor(db, threadId, actorId);

  const body = input.body ? sanitizeBody(input.body).slice(0, 5000) : null;
  if (!body && !input.assetId) throw badRequest("empty_message", "Write something or attach a file.");

  if (input.assetId) {
    const asset = await db.mediaAsset.findUnique({ where: { id: input.assetId } });
    if (!asset || asset.ownerId !== actorId) throw badRequest("asset_not_yours", "That attachment isn't yours to send.");
  }
  if (input.replyToId) {
    const original = await db.message.findUnique({ where: { id: input.replyToId }, select: { threadId: true } });
    if (!original || original.threadId !== threadId) throw badRequest("reply_not_in_thread", "That message isn't in this conversation.");
  }

  const others = participants.filter((p) => p.personId !== actorId && p.state !== "LEFT");
  if (thread.kind === "DIRECT") {
    const other = others[0];
    if (other) {
      if (await isBlockedEitherWay(db, actorId, other.personId)) throw notFound("That person");
      if (!canSendGiven(other.state as ParticipantState, await countSentBy(db, threadId, actorId))) {
        throw conflict("message_request_pending", WAIT_FOR_ACCEPT_MESSAGE);
      }
    }
  }

  // Sending while your own state is REQUESTED implicitly accepts the request.
  if (mine.state === "REQUESTED") {
    await db.threadParticipant.update({ where: { id: mine.id }, data: { state: "ACTIVE" } });
  }

  const messagesBeforeThis = await db.message.count({ where: { threadId } });
  const message = await db.message.create({
    data: {
      threadId,
      senderId: actorId,
      kind: input.kind,
      body,
      replyToId: input.replyToId ?? null,
      assetId: input.assetId ?? null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
    },
  });

  await db.thread.update({ where: { id: threadId }, data: { lastMessageAt: message.createdAt, lastMessagePreview: previewFor(input.kind, body) } });

  for (const p of others) {
    if (p.state === "DECLINED") continue; // invisible to them — no count, no notice, no publish
    await db.threadParticipant.update({ where: { id: p.id }, data: { unreadCount: { increment: 1 } } });
    await notify(db, {
      personId: p.personId,
      kind: p.state === "REQUESTED" ? "message.request" : "message.new",
      title: p.state === "REQUESTED" ? "New message request" : "New message",
      body: previewFor(input.kind, body),
      href: `/messages/${threadId}`,
      actorId,
      objectType: "Thread",
      objectId: threadId,
      groupKey: `thread:${threadId}`,
    });
  }
  const dto = await messageDto(db, message, actorId);
  const liveRecipients = others.filter((p) => p.state !== "DECLINED").map((p) => p.personId);
  await publishToMany(liveRecipients, "message", { threadId, message: dto, unreadDelta: 1 });
  await publishTo(actorId, "message", { threadId, message: dto, unreadDelta: 0 });
  await publishToMany([actorId, ...liveRecipients], "thread", { threadId, lastMessageAt: message.createdAt.toISOString(), preview: previewFor(input.kind, body) });

  await track(db, { personId: actorId, event: messagesBeforeThis === 0 ? "message_started" : "message_replied", objectType: "Thread", objectId: threadId });
  return dto;
}

async function countSentBy(db: Db, threadId: string, personId: string): Promise<number> {
  return db.message.count({ where: { threadId, senderId: personId } });
}

/* ── pagination helpers used by routes ─────────────────────────────────── */

export { clampLimit, decodeCursor, encodeCursor };
