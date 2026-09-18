import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { requireActor } from "../auth/actor.js";
import { requireVerifiedActor } from "../auth/guards.js";
import { notify } from "../lib/notify.js";
import { track } from "../lib/analytics.js";
import { publishToMany } from "../lib/realtime.js";
import { clampLimit, decodeCursor, encodeCursor } from "../lib/pagination.js";
import { connectionIds } from "../policy/graph.js";
import { effectiveVisibility } from "../profiles/policy.js";
import { personCard, personCards, type PersonCard } from "../profiles/cards.js";
import { orgCard, type OrgCard } from "../organizations/cards.js";
import { messageDto } from "../messaging/service.js";
import {
  MUTUAL_TAG_KINDS,
  VERIFIED_AFFILIATIONS,
  bestEvidence,
  describeEvidence,
  isOpenIntroStatus,
  templateDraft,
  type IntroEvidence,
} from "./policy.js";

type IntroPath = { middle: PersonCard; how: ReturnType<typeof describeEvidence>["how"]; strength: number };

type Target = { targetPersonId?: string; targetOrgId?: string };

const targetSchema = z
  .object({ targetPersonId: z.string().min(1).optional(), targetOrgId: z.string().min(1).optional() })
  .refine((v) => !!v.targetPersonId !== !!v.targetOrgId, { message: "Provide exactly one of targetPersonId or targetOrgId." });

export function registerIntroRoutes(app: FastifyInstance, db: Db) {
  /** Every discoverable path from `requesterId` to `target`, ranked strongest first. Pure w.r.t. the DB rows it reads. */
  async function computeIntroPaths(requesterId: string, target: Target): Promise<IntroPath[]> {
    const myConnections = await connectionIds(db, requesterId);
    if (!myConnections.length) return [];
    const evidenceByMiddle = new Map<string, IntroEvidence[]>();

    if (target.targetPersonId) {
      const targetId = target.targetPersonId;
      if (targetId !== requesterId) {
        const privacyRows = await db.privacySetting.findMany({ where: { personId: targetId, category: "connections" } });
        const visibility = effectiveVisibility(privacyRows).connections;
        if (visibility === "PUBLIC") {
          const targetConnections = new Set(await connectionIds(db, targetId));
          for (const middleId of myConnections) {
            if (middleId === targetId) continue;
            if (targetConnections.has(middleId)) evidenceByMiddle.set(middleId, [{ kind: "public_connection" }]);
          }
        }
      }
    } else if (target.targetOrgId) {
      const orgId = target.targetOrgId;
      const [tags, memberships] = await Promise.all([
        db.relationshipTag.findMany({ where: { ownerId: { in: myConnections }, targetOrgId: orgId, mutual: true, kind: { in: MUTUAL_TAG_KINDS } } }),
        db.membership.findMany({ where: { personId: { in: myConnections }, organizationId: orgId, affiliation: { in: [...VERIFIED_AFFILIATIONS] } }, select: { personId: true, role: true } }),
      ]);
      for (const m of memberships) {
        const arr = evidenceByMiddle.get(m.personId) ?? [];
        arr.push({ kind: "verified_membership", role: m.role });
        evidenceByMiddle.set(m.personId, arr);
      }
      for (const t of tags) {
        const arr = evidenceByMiddle.get(t.ownerId) ?? [];
        arr.push({ kind: "mutual_org_tag", tagKind: t.kind });
        evidenceByMiddle.set(t.ownerId, arr);
      }
    }

    const middleIds = [...evidenceByMiddle.keys()];
    if (!middleIds.length) return [];
    const cards = await personCards(db, middleIds);
    const out: IntroPath[] = [];
    for (const [middleId, evidences] of evidenceByMiddle) {
      const card = cards.get(middleId);
      if (!card) continue;
      const best = bestEvidence(evidences);
      if (!best) continue;
      const { how, strength } = describeEvidence(best);
      out.push({ middle: card, how, strength });
    }
    out.sort((a, b) => b.strength - a.strength);
    return out;
  }

  async function loadTarget(target: Target) {
    if (target.targetPersonId) {
      const t = await db.person.findUnique({ where: { id: target.targetPersonId }, select: { id: true } });
      if (!t) throw notFound("That person");
    } else if (target.targetOrgId) {
      const t = await db.organization.findUnique({ where: { id: target.targetOrgId }, select: { id: true } });
      if (!t) throw notFound("That business");
    }
  }

  type IntroRequestRow = {
    id: string;
    requesterId: string;
    middleId: string;
    targetPersonId: string | null;
    targetOrgId: string | null;
    message: string | null;
    draft: string | null;
    status: string;
    threadId: string | null;
    createdAt: Date;
    decidedAt: Date | null;
  };

  async function introRequestDto(row: IntroRequestRow, viewerId: string) {
    const personIds = [row.requesterId, row.middleId, row.targetPersonId].filter((x): x is string => !!x);
    const [cards, org] = await Promise.all([personCards(db, personIds), row.targetOrgId ? orgCard(db, row.targetOrgId) : Promise.resolve(null)]);
    return {
      id: row.id,
      status: row.status,
      message: row.message,
      draft: row.draft,
      threadId: row.threadId,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      requester: cards.get(row.requesterId) ?? null,
      middle: cards.get(row.middleId) ?? null,
      targetPerson: row.targetPersonId ? cards.get(row.targetPersonId) ?? null : null,
      targetOrg: org as OrgCard | null,
      role: viewerId === row.requesterId ? "requester" : viewerId === row.middleId ? "middle" : "target",
    };
  }

  /* ─────────────────────────── Paths ─────────────────────────── */

  app.get("/intros/paths", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const q = targetSchema.parse(req.query);
    await loadTarget(q);
    const paths = await computeIntroPaths(actor.personId, q);
    return reply.send({ paths });
  });

  /* ─────────────────────────── Create / list ─────────────────────────── */

  const createSchema = z
    .object({
      middleId: z.string().min(1),
      targetPersonId: z.string().min(1).optional(),
      targetOrgId: z.string().min(1).optional(),
      message: z.string().trim().max(1000).optional(),
    })
    .refine((v) => !!v.targetPersonId !== !!v.targetOrgId, { message: "Provide exactly one of targetPersonId or targetOrgId." });

  app.post("/intros", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const body = createSchema.parse(req.body);
    if (body.middleId === actor.personId) throw badRequest("self_middle", "Pick someone else to make the introduction — not yourself.");
    if (body.targetPersonId === actor.personId) throw badRequest("self_target", "You can't request an introduction to yourself.");
    if (body.targetPersonId === body.middleId) throw badRequest("target_is_middle", "Message them directly — they don't need an introduction to themselves.");
    await loadTarget(body);

    const paths = await computeIntroPaths(actor.personId, body);
    const chosen = paths.find((p) => p.middle.id === body.middleId);
    if (!chosen) throw new ApiError(404, "not_found", "No introduction path found");

    const existing = await db.introRequest.findFirst({
      where: {
        requesterId: actor.personId,
        middleId: body.middleId,
        targetPersonId: body.targetPersonId ?? null,
        targetOrgId: body.targetOrgId ?? null,
        status: { in: ["REQUESTED", "APPROVED"] },
      },
    });
    if (existing) throw conflict("already_requested", "You already have an open introduction request with them for this.");

    const created = await db.introRequest.create({
      data: {
        requesterId: actor.personId,
        middleId: body.middleId,
        targetPersonId: body.targetPersonId ?? null,
        targetOrgId: body.targetOrgId ?? null,
        message: body.message ?? null,
      },
    });

    await notify(db, {
      personId: body.middleId,
      kind: "intro.request",
      title: "Introduction request",
      body: body.message ?? null,
      href: "/network/intros",
      actorId: actor.personId,
      objectType: "IntroRequest",
      objectId: created.id,
    });
    await track(db, { personId: actor.personId, event: "intro_requested", objectType: "IntroRequest", objectId: created.id });

    return reply.status(201).send(await introRequestDto(created, actor.personId));
  });

  app.get("/intros", async (req, reply) => {
    const actor = requireActor(req);
    const q = z.object({ role: z.enum(["middle", "requester"]).default("middle"), cursor: z.string().optional(), limit: z.string().optional() }).parse(req.query);
    const cur = decodeCursor(q.cursor);
    const limit = clampLimit(q.limit);
    const where = q.role === "middle" ? { middleId: actor.personId } : { requesterId: actor.personId };
    const rows = await db.introRequest.findMany({
      where: { ...where, ...(cur ? { createdAt: { lt: new Date(cur.value) } } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const items = await Promise.all(page.map((r) => introRequestDto(r, actor.personId)));
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null;
    return reply.send({ items, nextCursor });
  });

  /* ─────────────────────────── Decisions ─────────────────────────── */

  app.patch("/intros/:id/draft", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ draft: z.string().trim().max(2000) }).parse(req.body);
    const row = await db.introRequest.findUnique({ where: { id } });
    if (!row) throw notFound("That introduction request");
    if (row.middleId !== actor.personId) throw forbidden("Only the person asked to introduce can edit this.");
    if (row.status !== "REQUESTED") throw conflict("not_requested", "That request isn't awaiting your decision anymore.");
    const updated = await db.introRequest.update({ where: { id }, data: { draft: body.draft } });
    return reply.send({ draft: updated.draft });
  });

  app.post("/intros/:id/draft/suggest", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = await db.introRequest.findUnique({ where: { id } });
    if (!row) throw notFound("That introduction request");
    if (row.middleId !== actor.personId) throw forbidden("Only the person asked to introduce can draft this.");
    if (row.status !== "REQUESTED") throw conflict("not_requested", "That request isn't awaiting your decision anymore.");

    const [requesterCard, targetCard, targetOrg] = await Promise.all([
      personCard(db, row.requesterId),
      row.targetPersonId ? personCard(db, row.targetPersonId) : Promise.resolve(null),
      row.targetOrgId ? orgCard(db, row.targetOrgId) : Promise.resolve(null),
    ]);
    const targetName = targetCard?.name ?? targetOrg?.displayName ?? "there";
    const template = templateDraft({ requesterName: requesterCard?.name ?? "Someone", requesterHeadline: requesterCard?.headline, targetName, message: row.message });
    const draft = await suggestIntroDraft({ requesterCard, targetName, message: row.message, template });
    return reply.send(draft);
  });

  app.post("/intros/:id/approve", async (req, reply) => {
    const actor = await requireVerifiedActor(req, db);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ note: z.string().trim().max(1000).optional() }).parse(req.body ?? {});
    const row = await db.introRequest.findUnique({ where: { id } });
    if (!row) throw notFound("That introduction request");
    if (row.middleId !== actor.personId) throw forbidden("Only the person asked to introduce can approve this.");
    if (row.status !== "REQUESTED") throw conflict("not_requested", "That request isn't awaiting your decision anymore.");

    let targetPersonId = row.targetPersonId;
    if (!targetPersonId && row.targetOrgId) {
      const owner = await db.membership.findFirst({
        where: { organizationId: row.targetOrgId, role: { in: ["OWNER", "ADMIN"] } },
        orderBy: [{ role: "asc" }, { createdAt: "asc" }],
        select: { personId: true },
      });
      if (!owner) throw badRequest("no_org_contact", "That business doesn't have anyone set up to receive introductions yet.");
      targetPersonId = owner.personId;
    }
    if (!targetPersonId) throw badRequest("no_target", "There's no one to introduce to.");
    if (targetPersonId === row.middleId) throw badRequest("target_is_middle", "That business's contact is you — message the requester directly instead.");

    const [requesterCard, targetCard] = await Promise.all([personCard(db, row.requesterId), personCard(db, targetPersonId)]);
    const draftText =
      row.draft?.trim() ||
      templateDraft({ requesterName: requesterCard?.name ?? "Someone", requesterHeadline: requesterCard?.headline, targetName: targetCard?.name ?? "there", message: row.message });

    const participantIds = [...new Set([row.requesterId, row.middleId, targetPersonId])];
    const thread = await db.thread.create({
      data: {
        kind: "INTRO",
        refType: "IntroRequest",
        refId: row.id,
        createdById: actor.personId,
        participants: { create: participantIds.map((personId) => ({ personId, state: "ACTIVE" as const, role: personId === row.middleId ? "ADMIN" : "MEMBER" })) },
      },
    });
    const message = await db.message.create({ data: { threadId: thread.id, senderId: actor.personId, kind: "TEXT", body: draftText } });
    await db.thread.update({ where: { id: thread.id }, data: { lastMessageAt: message.createdAt, lastMessagePreview: draftText.slice(0, 140) } });
    await db.threadParticipant.updateMany({ where: { threadId: thread.id, personId: { in: participantIds.filter((p) => p !== actor.personId) } }, data: { unreadCount: { increment: 1 } } });

    const updated = await db.introRequest.update({ where: { id }, data: { status: "APPROVED", threadId: thread.id, decidedAt: new Date(), draft: draftText } });

    const dto = await messageDto(db, message, actor.personId);
    const others = participantIds.filter((p) => p !== actor.personId);
    await publishToMany(participantIds, "thread", { threadId: thread.id, lastMessageAt: message.createdAt.toISOString(), preview: draftText.slice(0, 140) });
    await publishToMany(others, "message", { threadId: thread.id, message: dto, unreadDelta: 1 });

    const requesterName = requesterCard?.name ?? "Someone";
    const middleCard = await personCard(db, row.middleId);
    const middleName = middleCard?.name ?? "Someone";
    await notify(db, {
      personId: row.requesterId,
      kind: "intro.decision",
      title: "Your introduction was approved",
      body: body.note ?? null,
      href: `/messages/${thread.id}`,
      actorId: actor.personId,
      objectType: "IntroRequest",
      objectId: row.id,
    });
    await notify(db, {
      personId: targetPersonId,
      kind: "intro.request",
      title: `${middleName} introduced you to ${requesterName}`,
      href: `/messages/${thread.id}`,
      actorId: actor.personId,
      objectType: "IntroRequest",
      objectId: row.id,
    });

    return reply.send(await introRequestDto(updated, actor.personId));
  });

  app.post("/intros/:id/decline", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = await db.introRequest.findUnique({ where: { id } });
    if (!row) throw notFound("That introduction request");
    if (row.middleId !== actor.personId) throw forbidden("Only the person asked to introduce can decline this.");
    if (row.status !== "REQUESTED") throw conflict("not_requested", "That request isn't awaiting your decision anymore.");
    const updated = await db.introRequest.update({ where: { id }, data: { status: "DECLINED", decidedAt: new Date() } });
    // Silent to the target on purpose — they were never told about the ask.
    await notify(db, {
      personId: row.requesterId,
      kind: "intro.decision",
      title: "Your introduction request didn't go through",
      href: "/network/intros",
      actorId: actor.personId,
      objectType: "IntroRequest",
      objectId: row.id,
    });
    return reply.send({ id: updated.id, status: updated.status });
  });

  app.post("/intros/:id/withdraw", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = await db.introRequest.findUnique({ where: { id } });
    if (!row) throw notFound("That introduction request");
    if (row.requesterId !== actor.personId) throw forbidden("Only the person who asked can withdraw this.");
    if (!isOpenIntroStatus(row.status)) throw conflict("not_open", "That request isn't open anymore.");
    const updated = await db.introRequest.update({ where: { id }, data: { status: "WITHDRAWN", decidedAt: new Date() } });
    return reply.send({ id: updated.id, status: updated.status });
  });

  app.post("/intros/:id/complete", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = await db.introRequest.findUnique({ where: { id } });
    if (!row) throw notFound("That introduction");
    if (row.requesterId !== actor.personId && row.middleId !== actor.personId) throw forbidden("That's not your introduction.");
    if (row.status !== "APPROVED") throw conflict("not_approved", "Only an approved introduction can be marked complete.");
    const updated = await db.introRequest.update({ where: { id }, data: { status: "COMPLETED", decidedAt: row.decidedAt ?? new Date() } });
    return reply.send({ id: updated.id, status: updated.status });
  });
}

/**
 * A short, warm intro line assembled ONLY from the facts given. Uses Claude
 * when ANTHROPIC_API_KEY is set; the deterministic template otherwise, and on
 * any error (network, non-2xx, empty completion) — the draft is never blocked
 * on a third party being up.
 */
async function suggestIntroDraft(input: {
  requesterCard: PersonCard | null;
  targetName: string;
  message: string | null;
  template: string;
}): Promise<{ text: string; source: "template" | "ai" }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { text: input.template, source: "template" };
  try {
    const facts = [
      `Person being introduced: ${input.requesterCard?.name ?? "Someone"}${input.requesterCard?.headline ? `, ${input.requesterCard.headline}` : ""}${input.requesterCard?.industry ? ` (industry: ${input.requesterCard.industry})` : ""}`,
      `Being introduced to: ${input.targetName}`,
      input.message ? `Reason given by the person asking for the introduction: ${input.message}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 300,
        system:
          "You write one short, warm, professional introduction message (at most 3 sentences) connecting two people, addressed to the person being introduced TO. Use ONLY the facts given below — never invent a company, a shared history, or any detail not provided. Plain text only, no markdown, no subject line.",
        messages: [{ role: "user", content: facts }],
      }),
    });
    if (!res.ok) return { text: input.template, source: "template" };
    const json = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = json.content?.[0]?.text?.trim();
    if (!text) return { text: input.template, source: "template" };
    return { text, source: "ai" };
  } catch {
    return { text: input.template, source: "template" };
  }
}
