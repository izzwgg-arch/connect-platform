import type { FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { forbidden } from "../lib/errors.js";
import { requireActor, type Actor } from "./actor.js";

/**
 * Public actions (post, message, connect, quote, apply, create an org) need a
 * verified email or phone — the one rule that keeps throwaway accounts quiet.
 */
export async function requireVerifiedActor(req: FastifyRequest, db: Db): Promise<Actor> {
  const actor = requireActor(req);
  const p = await db.person.findUnique({ where: { id: actor.personId }, select: { emailVerifiedAt: true, phoneVerifiedAt: true } });
  if (!p?.emailVerifiedAt && !p?.phoneVerifiedAt) {
    throw forbidden("Verify your email or mobile number first (Settings → Account) — it takes a minute.");
  }
  return actor;
}

/** Active restriction of a kind (e.g. "OUTREACH") blocks the action with the moderator's plain-English reason. */
export async function requireNoRestriction(db: Db, personId: string, kind: string) {
  const r = await db.restriction.findFirst({
    where: { personId, kind, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    orderBy: { createdAt: "desc" },
  });
  if (r) throw forbidden(r.reason);
}
