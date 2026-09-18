import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { env } from "../env.js";
import { badRequest, notFound } from "../lib/errors.js";
import { requireActor } from "../auth/actor.js";
import { track } from "../lib/analytics.js";
import { degreeBetween, isBlockedEitherWay, sharesOrganization } from "../policy/graph.js";
import { connectionStatusBetween, effectiveVisibility, sectionVisibility } from "../profiles/policy.js";
import { normalizeUsername } from "../profiles/service.js";
import { personCard } from "../profiles/cards.js";

/**
 * QR networking. The person's own QR (rendered on the web at /me/qr) encodes
 * `${COMMUNITY_PUBLIC_URL}/people/<username>?via=qr`. `/qr/resolve` accepts
 * either that whole URL or a bare username — the web scanner hands over
 * whatever the camera decoded.
 */
function usernameFromCode(raw: string): string {
  const match = raw.match(/\/people\/([^/?#]+)/i);
  return normalizeUsername(match ? decodeURIComponent(match[1]) : raw);
}

function escapeVcard(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

export function registerQrRoutes(app: FastifyInstance, db: Db) {
  app.get("/qr/resolve", async (req, reply) => {
    const actor = requireActor(req);
    const q = z.object({ code: z.string().min(1).max(300) }).parse(req.query);
    const username = usernameFromCode(q.code);
    if (!username) throw badRequest("bad_code", "That code isn't a Loopcom Community profile link.");
    const target = await db.person.findUnique({ where: { username }, select: { id: true, status: true } });
    if (!target || target.status !== "ACTIVE") throw notFound("That person");
    if (await isBlockedEitherWay(db, actor.personId, target.id)) throw notFound("That person");

    const card = await personCard(db, target.id);
    if (!card) throw notFound("That person");
    const [degree, connectionStatus] = await Promise.all([degreeBetween(db, actor.personId, target.id), connectionStatusBetween(db, actor.personId, target.id)]);
    await track(db, { personId: actor.personId, event: "profile_view", objectType: "person", objectId: target.id, surface: "qr" });
    return reply.send({ person: card, relationship: { degree, connectionStatus } });
  });

  app.post("/qr/met", async (req, reply) => {
    const actor = requireActor(req);
    const body = z.object({ personId: z.string().min(1), note: z.string().trim().max(1000).optional(), event: z.string().trim().max(120).optional() }).parse(req.body);
    if (body.personId === actor.personId) throw badRequest("self", "That's you.");
    const target = await db.person.findUnique({ where: { id: body.personId }, select: { id: true } });
    if (!target) throw notFound("That person");
    if (await isBlockedEitherWay(db, actor.personId, body.personId)) throw notFound("That person");

    const tags = ["met-in-person", ...(body.event ? [body.event.toLowerCase()] : [])];
    const noteBody = body.event ? `Met at ${body.event}${body.note ? ` — ${body.note}` : ""}` : `Met in person${body.note ? ` — ${body.note}` : ""}`;
    const created = await db.privateNote.create({ data: { ownerId: actor.personId, targetPersonId: body.personId, body: noteBody, tags } });

    const connectionStatus = await connectionStatusBetween(db, actor.personId, body.personId);
    const suggestions: string[] = [];
    if (connectionStatus === "none") suggestions.push("connect");
    suggestions.push("follow", "save_contact");

    const card = await personCard(db, body.personId);
    return reply.status(201).send({
      note: { id: created.id, body: created.body, tags: created.tags, createdAt: created.createdAt.toISOString() },
      person: card,
      suggestions,
    });
  });

  /** A shareable business-card file. Public so a scan works before signing in; phone/email obey the target's own privacy choices for THIS viewer. */
  app.get("/public/people/:username/vcard", async (req, reply) => {
    const { username } = z.object({ username: z.string().min(1).max(60) }).parse(req.params);
    const viewerId = req.actor?.personId ?? null;
    const target = await db.person.findUnique({ where: { username: normalizeUsername(username) }, include: { profile: true } });
    if (!target || !target.profile) throw notFound("That profile");
    if (target.status !== "ACTIVE" && viewerId !== target.id) throw notFound("That profile");
    if (viewerId && (await isBlockedEitherWay(db, viewerId, target.id))) throw notFound("That profile");

    const [privacyRows, degree, sameOrg, membership] = await Promise.all([
      db.privacySetting.findMany({ where: { personId: target.id } }),
      degreeBetween(db, viewerId, target.id),
      sharesOrganization(db, viewerId, target.id),
      db.membership.findFirst({
        where: { personId: target.id, showOnProfile: true, affiliation: { in: ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"] } },
        orderBy: { isPrimary: "desc" },
        select: { organization: { select: { displayName: true } } },
      }),
    ]);
    const vis = effectiveVisibility(privacyRows);
    const sections = sectionVisibility(vis, { degree, sameOrganization: sameOrg });

    const p = target.profile;
    const name = `${p.firstName} ${p.lastName}`.trim() || target.username;
    const lines = ["BEGIN:VCARD", "VERSION:3.0", `N:${escapeVcard(p.lastName)};${escapeVcard(p.firstName)};;;`, `FN:${escapeVcard(name)}`];
    if (sections.headline && p.headline) lines.push(`TITLE:${escapeVcard(p.headline)}`);
    if (membership?.organization.displayName) lines.push(`ORG:${escapeVcard(membership.organization.displayName)}`);
    if (sections.phone && target.phoneE164) lines.push(`TEL;TYPE=CELL:${escapeVcard(target.phoneE164)}`);
    if (sections.email && target.email) lines.push(`EMAIL:${escapeVcard(target.email)}`);
    lines.push(`URL:${env().COMMUNITY_PUBLIC_URL}/people/${target.username}`);
    lines.push("END:VCARD");

    reply.header("content-type", "text/vcard; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${target.username}.vcf"`);
    return reply.send(lines.join("\r\n"));
  });
}
