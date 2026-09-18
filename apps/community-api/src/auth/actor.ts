import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import type { AccessClaims } from "./tokens.js";

/**
 * The caller, resolved once per request. `req.actor` is null for anonymous
 * requests; routes call `requireActor(req)` when a person is required.
 * Staff role comes from StaffGrant — never from a token claim.
 */
export type Actor = {
  personId: string;
  sessionId: string;
  status: string;
  username: string;
  staffRole: string | null;
  loopcomTenantId: string | null;
};

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

/**
 * Paths a signed-out person may call. On these an invalid/expired token is
 * ignored (anonymous). Everywhere else a bad token is a 401 with a reason.
 */
export const PUBLIC_PREFIXES = [
  "/health",
  "/auth/register",
  "/auth/login",
  "/auth/refresh",
  "/auth/password/forgot",
  "/auth/password/reset",
  "/auth/oauth/",
  "/auth/loopcom",
  "/auth/passkeys/login/",
  "/public/",
  "/search",
  "/media/file/",
  "/flags",
  "/analytics/events",
  "/dev/",
  "/.well-known/",
];

export function registerActorResolution(app: FastifyInstance, db: Db) {
  app.decorateRequest("actor", null);
  app.addHook("preHandler", async (req, reply) => {
    req.actor = null;
    const auth = String(req.headers.authorization || "");
    const queryToken = (req.query as Record<string, string | undefined>)?.access_token;
    const raw = auth.startsWith("Bearer ") ? auth.slice(7).trim() : queryToken || "";
    const path = req.url.split("?")[0];
    const isPublic = PUBLIC_PREFIXES.some((p) => path.startsWith(p));
    if (!raw) {
      if (isPublic) return;
      return reply.status(401).send({ error: "unauthorized", message: "Sign in to continue." });
    }
    let claims: AccessClaims;
    try {
      claims = app.jwt.verify<AccessClaims>(raw);
    } catch {
      if (isPublic) return;
      return reply.status(401).send({ error: "unauthorized", message: "Your session expired. Sign in again." });
    }
    if (claims.typ !== "access") {
      return reply.status(401).send({ error: "unauthorized", message: "Sign in to continue." });
    }
    // Account status is checked BEFORE session validity on purpose: a moderation
    // suspend/ban also revokes every session, and a still-in-flight request
    // should surface the specific, actionable "account_restricted" reason
    // rather than a generic "session was signed out" (a person only ever sees
    // the latter for their OWN sign-outs, never for someone else's action).
    const person = await db.person.findUnique({
      where: { id: claims.sub },
      select: { id: true, status: true, username: true, loopcomTenantId: true },
    });
    if (!person) return reply.status(401).send({ error: "unauthorized", message: "Sign in to continue." });
    if (person.status === "BANNED" || person.status === "SUSPENDED") {
      // A public path still tolerates a restricted account's stale token — it
      // just falls back to anonymous, exactly like any other bad token would.
      if (isPublic) return;
      return reply.status(403).send({ error: "account_restricted", message: "This account can't be used right now. Check your email for details or appeal in Settings." });
    }
    const session = await db.session.findUnique({ where: { id: claims.sid }, select: { revokedAt: true, expiresAt: true } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      if (isPublic) return;
      return reply.status(401).send({ error: "session_revoked", message: "That session was signed out. Sign in again." });
    }
    const staff = await db.staffGrant.findUnique({ where: { personId: person.id } });
    req.actor = {
      personId: person.id,
      sessionId: claims.sid,
      status: person.status,
      username: person.username,
      staffRole: staff?.role ?? null,
      loopcomTenantId: person.loopcomTenantId,
    };
    // Touch lastSeen at most once a minute per session (cheap presence signal).
    const bucket = Math.floor(Date.now() / 60_000);
    const last = (lastSeenBuckets.get(claims.sid) ?? 0);
    if (last !== bucket) {
      lastSeenBuckets.set(claims.sid, bucket);
      db.person.update({ where: { id: person.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    }
  });
}

const lastSeenBuckets = new Map<string, number>();

export function requireActor(req: FastifyRequest): Actor {
  if (!req.actor) throw unauthorized();
  return req.actor;
}

export function requireStaff(req: FastifyRequest, roles: string[] = ["MODERATOR", "ADMIN"]): Actor {
  const a = requireActor(req);
  if (!a.staffRole || !roles.includes(a.staffRole)) throw forbidden("Platform staff only.");
  return a;
}
