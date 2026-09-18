import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db.js";
import { env } from "../env.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { track } from "../lib/analytics.js";
import { requireActor } from "../auth/actor.js";
import { requireVerifiedActor } from "../auth/guards.js";
import { searchOrganizations, searchPeople, searchJobs, searchEvents, searchGroups, searchListings, type SearchCtx, type SearchHit } from "../search/engine.js";
import { understand, type Intent } from "./understand.js";

/**
 * AI Business Concierge (brief §33). It understands a request, searches the
 * network, explains every match, and PROPOSES actions. Nothing external
 * happens until the person confirms a signed action token — the concierge
 * cannot message, post, or contact anyone on its own. It never fabricates:
 * every match is a real row with the search engine's own `why`.
 */
type ProposedAction =
  | { kind: "post_rfq"; label: string; payload: { title: string; description: string; location?: string | null; quantity?: string | null; deadline?: string | null; inviteOrganizationIds: string[] } }
  | { kind: "message_org"; label: string; payload: { organizationId: string; body: string } }
  | { kind: "follow_org"; label: string; payload: { organizationId: string } };

function sign(personId: string, action: ProposedAction): string {
  const exp = Math.floor(Date.now() / 1000) + 30 * 60;
  const body = Buffer.from(JSON.stringify({ personId, action, exp })).toString("base64url");
  const sig = createHmac("sha256", env().COMMUNITY_JWT_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verify(personId: string, token: string): ProposedAction {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw badRequest("action_invalid", "That action is no longer valid. Ask again.");
  const expected = createHmac("sha256", env().COMMUNITY_JWT_SECRET).update(body).digest("base64url");
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) throw badRequest("action_invalid", "That action is no longer valid. Ask again.");
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { personId: string; action: ProposedAction; exp: number };
  if (parsed.personId !== personId) throw forbidden("That action belongs to someone else.");
  if (parsed.exp * 1000 < Date.now()) throw badRequest("action_expired", "That action expired. Ask again.");
  return parsed.action;
}

export function registerConciergeRoutes(app: FastifyInstance, db: Db) {
  app.post("/concierge/ask", { config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } }, async (req) => {
    const actor = requireActor(req);
    const { question } = z.object({ question: z.string().trim().min(3).max(2000) }).parse(req.body);
    const intent = await understand(question);
    const ctx: SearchCtx = { viewerId: actor.personId, q: [intent.service, intent.customerType].filter(Boolean).join(" ") || question, limit: 8, location: intent.location };
    const matches: SearchHit[] = [];
    let explanation = "";
    switch (intent.kind) {
      case "find_vendor":
      case "post_rfq": {
        const [orgs, listings] = await Promise.all([searchOrganizations(db, ctx), searchListings(db, { ...ctx, limit: 5 })]);
        matches.push(...orgs, ...listings);
        explanation = orgs.length
          ? `I found ${orgs.length} business${orgs.length === 1 ? "" : "es"} on Loopcom Community matching "${ctx.q}"${intent.location ? ` around ${intent.location}` : ""}. Each line says why it matched — I only show what their own pages say.`
          : `No business on Loopcom Community matches "${ctx.q}"${intent.location ? ` around ${intent.location}` : ""} yet. Posting a request for quotes reaches vendors as they join and anyone already here whose category fits.`;
        break;
      }
      case "find_customer": {
        const orgs = await searchOrganizations(db, ctx);
        matches.push(...orgs);
        explanation = orgs.length ? `${orgs.length} businesses match the customer type you described. Follow them to see their requests, or post an opportunity.` : "No businesses match that description yet.";
        break;
      }
      case "find_person": {
        const people = await searchPeople(db, ctx);
        matches.push(...people);
        explanation = people.length ? `${people.length} people match. Only what they chose to make visible is shown.` : "Nobody matches that yet — try fewer words.";
        break;
      }
      case "find_job": {
        matches.push(...(await searchJobs(db, ctx)));
        explanation = matches.length ? `${matches.length} open jobs match.` : "No open jobs match that yet — save the search and we'll alert you.";
        break;
      }
      case "find_event":
        matches.push(...(await searchEvents(db, ctx)));
        explanation = matches.length ? `${matches.length} events match.` : "No events match that yet.";
        break;
      case "find_group":
        matches.push(...(await searchGroups(db, ctx)));
        explanation = matches.length ? `${matches.length} groups match.` : "No groups match that yet.";
        break;
      default:
        explanation = "I can find vendors, customers, people, jobs, events and groups, or draft a request for quotes. Tell me what you need, where, and by when.";
    }

    const actions: Array<{ token: string; kind: ProposedAction["kind"]; label: string; needsConfirmation: true }> = [];
    const orgIds = matches.filter((m) => m.type === "organizations").map((m) => m.id);
    if ((intent.kind === "find_vendor" || intent.kind === "post_rfq") && intent.service) {
      const action: ProposedAction = {
        kind: "post_rfq",
        label: `Post this as a request for quotes${orgIds.length ? ` and invite the ${orgIds.length} matching vendor${orgIds.length === 1 ? "" : "s"}` : ""}`,
        payload: {
          title: intent.summary.slice(0, 140),
          description: question,
          location: intent.location,
          quantity: intent.quantity,
          deadline: intent.deadline,
          inviteOrganizationIds: orgIds,
        },
      };
      actions.push({ token: sign(actor.personId, action), kind: action.kind, label: action.label, needsConfirmation: true });
    }
    for (const org of matches.filter((m) => m.type === "organizations").slice(0, 3)) {
      const name = (org.item as { displayName?: string }).displayName ?? "this business";
      const msg: ProposedAction = { kind: "message_org", label: `Message ${name} about this`, payload: { organizationId: org.id, body: `Hi — ${question}` } };
      actions.push({ token: sign(actor.personId, msg), kind: msg.kind, label: msg.label, needsConfirmation: true });
    }
    await track(db, { personId: actor.personId, event: "search", surface: "concierge", props: { kind: intent.kind, matches: matches.length, source: intent.source } });
    return { intent, explanation, matches, actions, disclaimer: "Matches come from members' own pages and verified signals. Nothing is sent until you confirm an action." };
  });

  app.post("/concierge/act", { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } }, async (req) => {
    const actor = await requireVerifiedActor(req, db);
    const { token } = z.object({ token: z.string().min(20).max(8000) }).parse(req.body);
    const action = verify(actor.personId, token);
    await audit(db, { actorId: actor.personId, action: `concierge.${action.kind}`, targetType: "Concierge", after: action.payload as object });
    if (action.kind === "post_rfq") {
      const res = await app.inject({
        method: "POST",
        url: "/rfq",
        headers: { authorization: String(req.headers.authorization || ""), "content-type": "application/json", "idempotency-key": `concierge:${token.slice(-24)}` },
        payload: { title: action.payload.title, description: action.payload.description, location: action.payload.location ?? undefined, quantity: action.payload.quantity ?? undefined, inviteOrganizationIds: action.payload.inviteOrganizationIds, visibility: "MATCHED" },
      });
      if (res.statusCode >= 400) throw badRequest("rfq_failed", (res.json() as any).message || "The request could not be posted.");
      const body = res.json() as any;
      return { done: "post_rfq", rfqId: body.rfq?.id ?? body.id, href: `/rfq/${body.rfq?.id ?? body.id}`, invitedCount: body.invitedCount ?? action.payload.inviteOrganizationIds.length };
    }
    if (action.kind === "message_org") {
      const org = await db.organization.findUnique({ where: { id: action.payload.organizationId }, select: { id: true, openMessages: true, memberships: { where: { role: { in: ["OWNER", "ADMIN"] } }, orderBy: { createdAt: "asc" }, take: 1, select: { personId: true } } } });
      if (!org || !org.openMessages || !org.memberships[0]) throw notFound("That business");
      const res = await app.inject({
        method: "POST",
        url: "/threads",
        headers: { authorization: String(req.headers.authorization || ""), "content-type": "application/json" },
        payload: { personIds: [org.memberships[0].personId] },
      });
      if (res.statusCode >= 400) throw badRequest("message_failed", (res.json() as any).message || "The message could not be started.");
      const thread = res.json() as any;
      const threadId = thread.thread?.id ?? thread.id;
      const sent = await app.inject({
        method: "POST",
        url: `/threads/${threadId}/messages`,
        headers: { authorization: String(req.headers.authorization || ""), "content-type": "application/json" },
        payload: { kind: "TEXT", body: action.payload.body.slice(0, 2000) },
      });
      if (sent.statusCode >= 400) throw badRequest("message_failed", (sent.json() as any).message || "The message could not be sent.");
      return { done: "message_org", threadId, href: `/messages/${threadId}` };
    }
    if (action.kind === "follow_org") {
      await app.inject({ method: "POST", url: `/organizations/${action.payload.organizationId}/follow`, headers: { authorization: String(req.headers.authorization || "") } });
      return { done: "follow_org", href: `/companies/id/${action.payload.organizationId}` };
    }
    throw badRequest("action_unknown", "That action isn't supported.");
  });

  app.get("/concierge/status", async (req) => {
    requireActor(req);
    return { ai: !!process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_API_KEY ? "claude-sonnet-5" : null, mode: process.env.ANTHROPIC_API_KEY ? "ai" : "rules" };
  });
}
