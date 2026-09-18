import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../db.js";
import { sha256, token } from "../lib/ids.js";
import { unauthorized } from "../lib/errors.js";

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_DAYS = 60;
/** After rotation the old refresh token still works for this long (racing tabs). */
export const ROTATION_GRACE_MS = 30_000;

export type AccessClaims = { sub: string; sid: string; typ: "access" };

export type IssuedSession = {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  expiresIn: number;
};

export function signAccess(app: FastifyInstance, personId: string, sessionId: string): string {
  return app.jwt.sign({ sub: personId, sid: sessionId, typ: "access" } satisfies AccessClaims, { expiresIn: ACCESS_TTL_SECONDS });
}

export async function issueSession(
  app: FastifyInstance,
  db: Db,
  personId: string,
  meta: { userAgent?: string | null; ip?: string | null; client?: string; deviceLabel?: string | null },
): Promise<IssuedSession> {
  const refreshToken = token(48);
  const session = await db.session.create({
    data: {
      personId,
      refreshTokenHash: sha256(refreshToken),
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip ?? null,
      client: meta.client ?? "web",
      deviceLabel: meta.deviceLabel ?? labelFromUserAgent(meta.userAgent),
      expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000),
    },
  });
  return { accessToken: signAccess(app, personId, session.id), refreshToken, sessionId: session.id, expiresIn: ACCESS_TTL_SECONDS };
}

/** Rotates the refresh token; the previous one stays valid for ROTATION_GRACE_MS. */
export async function rotateSession(app: FastifyInstance, db: Db, refreshToken: string): Promise<IssuedSession> {
  const h = sha256(refreshToken);
  const now = new Date();
  let session = await db.session.findUnique({ where: { refreshTokenHash: h } });
  if (!session) {
    const prev = await db.session.findFirst({ where: { previousTokenHash: h } });
    if (prev && prev.rotatedAt && now.getTime() - prev.rotatedAt.getTime() < ROTATION_GRACE_MS && !prev.revokedAt) {
      // Racing client re-presenting the just-rotated token: hand it the same new one is impossible
      // (we never stored it), so issue a fresh rotation from the current row.
      session = prev;
    } else if (prev) {
      // Token reuse outside the grace window = theft signal. Kill the whole session.
      await db.session.update({ where: { id: prev.id }, data: { revokedAt: now } });
      throw unauthorized("That session was signed out. Sign in again.");
    } else {
      throw unauthorized("That session was signed out. Sign in again.");
    }
  }
  if (session.revokedAt || session.expiresAt < now) throw unauthorized("That session expired. Sign in again.");
  const person = await db.person.findUnique({ where: { id: session.personId }, select: { status: true } });
  if (!person || person.status === "BANNED" || person.status === "SUSPENDED") throw unauthorized("This account can't sign in right now.");
  const next = token(48);
  await db.session.update({
    where: { id: session.id },
    data: { refreshTokenHash: sha256(next), previousTokenHash: session.refreshTokenHash, rotatedAt: now, lastUsedAt: now },
  });
  return { accessToken: signAccess(app, session.personId, session.id), refreshToken: next, sessionId: session.id, expiresIn: ACCESS_TTL_SECONDS };
}

export async function revokeSession(db: Db, sessionId: string) {
  await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeAllSessions(db: Db, personId: string, exceptSessionId?: string) {
  await db.session.updateMany({
    where: { personId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
}

export function labelFromUserAgent(ua?: string | null): string | null {
  if (!ua) return null;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /LoopcomCommunity\//.test(ua) ? "Loopcom app" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  return `${browser} on ${os}`;
}

export function clientIp(req: FastifyRequest): string | null {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.ip || null;
}
