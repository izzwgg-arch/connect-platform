import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { requireActor } from "../auth/actor.js";
import { subscribe } from "../lib/realtime.js";
import { ANALYTICS_EVENTS, track } from "../lib/analytics.js";
import { DEFAULT_VISIBILITY } from "../policy/graph.js";
import { audit } from "../lib/audit.js";
import { unreadCount } from "../lib/notify.js";

/** Cross-cutting routes: realtime stream, analytics ingest, flags, privacy, devices. */
export function registerCoreRoutes(app: FastifyInstance, db: Db) {
  // ── realtime (SSE) ──────────────────────────────────────────────────────
  // EventSource can't set headers, so the web passes ?access_token=; the actor
  // hook accepts it. One stream per tab; events are addressed per person.
  app.get("/realtime/stream", async (req, reply) => {
    const actor = requireActor(req);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": String(req.headers.origin || "*"),
      "access-control-allow-credentials": "true",
    });
    const write = (event: string, data: unknown) => {
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* closed */
      }
    };
    write("hello", { personId: actor.personId, at: new Date().toISOString(), unread: await unreadCount(db, actor.personId) });
    const off = subscribe(actor.personId, (e) => write(e.type, e.data));
    const ping = setInterval(() => write("ping", { at: Date.now() }), 25_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      off();
    });
    // Keep the connection open — Fastify must not end the reply.
    await new Promise<void>((resolve) => req.raw.on("close", () => resolve()));
    return reply;
  });

  // ── analytics ingest (client-side events) ───────────────────────────────
  app.post("/analytics/events", async (req) => {
    const actor = req.actor;
    const body = z
      .object({
        events: z
          .array(
            z.object({
              event: z.enum(ANALYTICS_EVENTS),
              objectType: z.string().max(40).optional(),
              objectId: z.string().max(80).optional(),
              surface: z.string().max(60).optional(),
              position: z.number().int().min(0).max(10_000).optional(),
              recommendationId: z.string().max(80).optional(),
              experimentId: z.string().max(80).optional(),
              client: z.string().max(30).optional(),
              appVersion: z.string().max(30).optional(),
              props: z.record(z.unknown()).optional(),
            }),
          )
          .max(100),
      })
      .parse(req.body);
    for (const ev of body.events) {
      await track(db, { personId: actor?.personId ?? null, sessionId: actor?.sessionId ?? null, ...ev });
    }
    return { accepted: body.events.length };
  });

  // ── feature flags (evaluated for the caller) ────────────────────────────
  app.get("/flags", async (req) => {
    const flags = await db.featureFlag.findMany();
    const actor = req.actor;
    const orgIds = actor ? (await db.membership.findMany({ where: { personId: actor.personId }, select: { organizationId: true } })).map((m) => m.organizationId) : [];
    const out: Record<string, boolean> = {};
    for (const f of flags) out[f.key] = evaluateFlag(f, actor?.personId ?? null, orgIds, actor?.staffRole ?? null);
    return { flags: out };
  });

  // ── privacy ─────────────────────────────────────────────────────────────
  app.get("/me/privacy", async (req) => {
    const actor = requireActor(req);
    const rows = await db.privacySetting.findMany({ where: { personId: actor.personId } });
    const settings: Record<string, string> = { ...DEFAULT_VISIBILITY };
    for (const r of rows) settings[r.category] = r.visibility;
    return { settings, categories: Object.keys(DEFAULT_VISIBILITY) };
  });

  app.put("/me/privacy", async (req) => {
    const actor = requireActor(req);
    const body = z.record(z.enum(["PUBLIC", "CONNECTIONS", "ORGANIZATION", "PRIVATE"])).parse(req.body);
    const before = await db.privacySetting.findMany({ where: { personId: actor.personId } });
    for (const [category, visibility] of Object.entries(body)) {
      if (!(category in DEFAULT_VISIBILITY)) continue;
      await db.privacySetting.upsert({
        where: { personId_category: { personId: actor.personId, category } },
        create: { personId: actor.personId, category, visibility },
        update: { visibility },
      });
    }
    await audit(db, { actorId: actor.personId, action: "person.privacy_changed", targetType: "Person", targetId: actor.personId, before: Object.fromEntries(before.map((b) => [b.category, b.visibility])), after: body });
    return { ok: true };
  });

  // ── push device registration ────────────────────────────────────────────
  app.post("/me/devices", async (req) => {
    const actor = requireActor(req);
    const body = z.object({ platform: z.enum(["ios", "android", "web"]), token: z.string().min(8).max(500), appVersion: z.string().max(30).optional() }).parse(req.body);
    await db.deviceToken.upsert({
      where: { token: body.token },
      create: { personId: actor.personId, platform: body.platform, token: body.token, appVersion: body.appVersion ?? null },
      update: { personId: actor.personId, platform: body.platform, appVersion: body.appVersion ?? null, lastSeenAt: new Date() },
    });
    return { ok: true };
  });

  app.delete("/me/devices/:token", async (req) => {
    const actor = requireActor(req);
    const { token } = z.object({ token: z.string() }).parse(req.params);
    await db.deviceToken.deleteMany({ where: { token, personId: actor.personId } });
    return { ok: true };
  });
}

export function evaluateFlag(
  f: { enabled: boolean; rollout: number; audience: string; allowPersons: string[]; allowOrgs: string[]; key: string },
  personId: string | null,
  orgIds: string[],
  staffRole: string | null,
): boolean {
  if (!f.enabled) return false;
  if (personId && f.allowPersons.includes(personId)) return true;
  if (orgIds.some((o) => f.allowOrgs.includes(o))) return true;
  if (f.audience === "INTERNAL") return !!staffRole;
  if (f.audience === "SELECTED") return false;
  if (f.audience === "PERCENT") {
    if (!personId) return false;
    // Stable bucket per (flag, person) so a person never flips between visits.
    let h = 0;
    for (const ch of `${f.key}:${personId}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % 100 < f.rollout;
  }
  return f.audience === "ALL";
}
