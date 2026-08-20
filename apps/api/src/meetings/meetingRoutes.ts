/**
 * Loopcom Meetings — the API half. Create a meeting, hand out LiveKit join
 * tokens (signed-in and guest), and give the host the moderation verbs.
 *
 * The video itself NEVER touches these routes: media flows browser ↔ LiveKit.
 * This API only decides who may enter which room and with what powers — the
 * same division of labor as remote support (signalling here, pixels direct).
 *
 * Auth model:
 *   • /meetings/*            — ordinary JWT routes (any signed-in user).
 *   • /meetings/public/*     — NO JWT (on the bypass list). The meeting CODE is
 *     the credential, like a pay link: unguessable, per-meeting, validated
 *     against the VideoMeeting table in-handler. Only info + join live here.
 *   • host controls          — JWT + the caller must be the meeting's creator
 *     (or SUPER_ADMIN). Guests can never moderate: guest tokens are minted
 *     without roomAdmin and the host routes require a session.
 *
 * ⛔ Every body is parsed with safeParse — a malformed body must be a 4xx in
 * plain English, never a 500 through the global error handler.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db as realDb } from "@connect/db";
import {
  buildGuestIdentity,
  buildLiveKitJwt,
  buildMeetingCode,
  getLiveKitConfig,
  isValidMeetingCode,
  liveKitRoomForMeeting,
  roomServiceRequest,
  sanitizeDisplayName,
  type LiveKitConfig,
} from "./livekit";

type JwtUser = { sub: string; tenantId: string; email: string; role: string };

export type MeetingRoutesDeps = {
  db?: any;
  /** Injectable for tests; defaults to reading process.env at call time. */
  config?: () => LiveKitConfig | null;
  roomService?: typeof roomServiceRequest;
};

/** Participant tokens live long enough for an all-day meeting, no longer. */
const PARTICIPANT_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/** The nginx path (on BOTH vhosts) that proxies to LiveKit's signal endpoint.
 *  The browser builds wss://<its own host><this path> — never a hardcoded
 *  hostname (publicOrigins rule: links follow the host you are on). */
export const MEETINGS_PUBLIC_WS_PATH = "/meetws";

const getUser = (req: FastifyRequest): JwtUser => (req as any).user as JwtUser;

function notConfigured(reply: FastifyReply) {
  return reply.code(503).send({
    error: "meetings_not_configured",
    message: "Video meetings are not set up on this server yet.",
  });
}

function badCode(reply: FastifyReply) {
  return reply.code(404).send({
    error: "meeting_not_found",
    message: "This meeting link is not valid. Check the link and try again.",
  });
}

export function registerMeetingRoutes(app: FastifyInstance, deps: MeetingRoutesDeps = {}): void {
  const db = deps.db ?? realDb;
  const config = deps.config ?? (() => getLiveKitConfig());
  const roomService = deps.roomService ?? roomServiceRequest;

  async function findMeetingByCode(codeRaw: unknown) {
    const code = String(codeRaw || "").trim().toLowerCase();
    if (!isValidMeetingCode(code)) return null;
    return db.videoMeeting.findUnique({ where: { code } });
  }

  function isMeetingHost(meeting: { createdByUserId: string }, user: JwtUser): boolean {
    return meeting.createdByUserId === user.sub || String(user.role) === "SUPER_ADMIN";
  }

  function mintJoinToken(params: {
    cfg: LiveKitConfig;
    meeting: { id: string; title: string };
    identity: string;
    name: string;
    isHost: boolean;
  }) {
    const room = liveKitRoomForMeeting(params.meeting.id);
    // ⛔ Participant tokens never carry roomAdmin — moderation happens through
    // the host routes below so it is re-checked server-side on every call.
    const token = buildLiveKitJwt({
      config: params.cfg,
      identity: params.identity,
      name: params.name,
      ttlSeconds: PARTICIPANT_TOKEN_TTL_SECONDS,
      grant: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
      metadata: JSON.stringify({ host: params.isHost }),
    });
    return {
      token,
      room,
      identity: params.identity,
      isHost: params.isHost,
      wsPath: MEETINGS_PUBLIC_WS_PATH,
      title: params.meeting.title,
    };
  }

  // ── Create ────────────────────────────────────────────────────────────────
  app.post("/meetings", async (req, reply) => {
    if (!config()) return notConfigured(reply);
    const user = getUser(req);
    const parsed = z.object({ title: z.string().max(120).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_error", message: "That meeting name is too long." });
    }
    const title = sanitizeDisplayName(parsed.data.title)?.slice(0, 80) || "Video meeting";
    // The unique index on code makes a collision a retry, never a corruption.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const meeting = await db.videoMeeting.create({
          data: {
            code: buildMeetingCode(),
            tenantId: user.tenantId,
            createdByUserId: user.sub,
            title,
          },
        });
        return {
          id: meeting.id,
          code: meeting.code,
          title: meeting.title,
          locked: meeting.locked,
          createdAt: meeting.createdAt,
          joinPath: `/meet/${meeting.code}`,
        };
      } catch (e: any) {
        if (e?.code === "P2002") continue; // code collision — new code, try again
        throw e;
      }
    }
    return reply.code(500).send({ error: "meeting_create_failed", message: "Could not create the meeting. Try again." });
  });

  // ── My meetings (creator-scoped on purpose — a meeting link is private to
  //    whoever made it until they share it) ─────────────────────────────────
  app.get("/meetings", async (req) => {
    const user = getUser(req);
    const rows = await db.videoMeeting.findMany({
      where: { tenantId: user.tenantId, createdByUserId: user.sub },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return {
      meetings: rows.map((m: any) => ({
        id: m.id,
        code: m.code,
        title: m.title,
        locked: m.locked,
        createdAt: m.createdAt,
        endedAt: m.endedAt,
        joinPath: `/meet/${m.code}`,
      })),
    };
  });

  // ── Signed-in join ────────────────────────────────────────────────────────
  app.post("/meetings/:code/join", async (req, reply) => {
    const cfg = config();
    if (!cfg) return notConfigured(reply);
    const user = getUser(req);
    const meeting = await findMeetingByCode((req.params as any).code);
    if (!meeting) return badCode(reply);
    if (meeting.endedAt) {
      return reply.code(410).send({ error: "meeting_ended", message: "This meeting has ended." });
    }
    const isHost = isMeetingHost(meeting, user);
    if (meeting.locked && !isHost) {
      return reply.code(403).send({
        error: "meeting_locked",
        message: "The host has locked this meeting to new participants.",
      });
    }
    const parsed = z.object({ displayName: z.string().max(200).optional() }).safeParse(req.body ?? {});
    // ⛔ Never fall back to the email address — the platform-wide naming rule
    // (personDisplayName): a person must not be greeted as "845luzerj". The
    // portal always sends the profile name it already displays.
    const name = sanitizeDisplayName(parsed.success ? parsed.data.displayName : null) || "Teammate";
    // Random suffix so the same person in two windows is two participants —
    // LiveKit disconnects the older holder of a duplicated identity, which
    // would read as "the meeting kicked me out for no reason".
    const suffix = buildGuestIdentity().slice(-6);
    return mintJoinToken({ cfg, meeting, identity: `user-${user.sub}-${suffix}`, name, isHost });
  });

  // ── Public: what the join page shows before anyone types a name ──────────
  app.get("/meetings/public/:code/info", async (req) => {
    const meeting = await findMeetingByCode((req.params as any).code);
    if (!meeting) return { exists: false };
    return {
      exists: true,
      title: meeting.title,
      locked: meeting.locked,
      ended: Boolean(meeting.endedAt),
    };
  });

  // ── Public: guest join. The code is the credential; the name is required —
  //    an unnamed tile in a meeting is a design bug, not a nicety. ──────────
  app.post("/meetings/public/:code/join", async (req, reply) => {
    const cfg = config();
    if (!cfg) return notConfigured(reply);
    const meeting = await findMeetingByCode((req.params as any).code);
    if (!meeting) return badCode(reply);
    if (meeting.endedAt) {
      return reply.code(410).send({ error: "meeting_ended", message: "This meeting has ended." });
    }
    if (meeting.locked) {
      return reply.code(403).send({
        error: "meeting_locked",
        message: "The host has locked this meeting to new participants.",
      });
    }
    const parsed = z.object({ displayName: z.string().max(200) }).safeParse(req.body ?? {});
    const name = sanitizeDisplayName(parsed.success ? parsed.data.displayName : null);
    if (!name) {
      return reply.code(400).send({ error: "name_required", message: "Type your name so people know who joined." });
    }
    // ⛔ Guests are never hosts, whatever the body claims.
    return mintJoinToken({ cfg, meeting, identity: buildGuestIdentity(), name, isHost: false });
  });

  // ── Host controls (creator or SUPER_ADMIN only) ───────────────────────────
  async function requireHost(req: FastifyRequest, reply: FastifyReply) {
    const user = getUser(req);
    const meeting = await findMeetingByCode((req.params as any).code);
    if (!meeting) {
      badCode(reply);
      return null;
    }
    if (!isMeetingHost(meeting, user)) {
      reply.code(403).send({ error: "forbidden", message: "Only the meeting host can do that." });
      return null;
    }
    return meeting;
  }

  app.post("/meetings/:code/lock", async (req, reply) => {
    const meeting = await requireHost(req, reply);
    if (!meeting) return reply;
    const parsed = z.object({ locked: z.boolean() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_error", message: "Send { locked: true | false }." });
    }
    await db.videoMeeting.update({ where: { id: meeting.id }, data: { locked: parsed.data.locked } });
    return { ok: true, locked: parsed.data.locked };
  });

  app.post("/meetings/:code/end", async (req, reply) => {
    const meeting = await requireHost(req, reply);
    if (!meeting) return reply;
    await db.videoMeeting.update({ where: { id: meeting.id }, data: { endedAt: new Date() } });
    // Best-effort: tear the live room down so everyone leaves now, not at the
    // empty-timeout. A LiveKit hiccup must not make "End meeting" fail — the
    // DB row is the truth and rejoin is already refused above.
    const cfg = config();
    if (cfg) {
      try {
        await roomService(cfg, "DeleteRoom", { room: liveKitRoomForMeeting(meeting.id) });
      } catch {
        /* the room dies at empty-timeout regardless */
      }
    }
    return { ok: true };
  });

  app.post("/meetings/:code/host/mute", async (req, reply) => {
    const meeting = await requireHost(req, reply);
    if (!meeting) return reply;
    const cfg = config();
    if (!cfg) return notConfigured(reply);
    const parsed = z.object({ identity: z.string().min(1).max(200), trackSid: z.string().min(1).max(200) }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_error", message: "Send { identity, trackSid }." });
    }
    const res = await roomService(cfg, "MutePublishedTrack", {
      room: liveKitRoomForMeeting(meeting.id),
      identity: parsed.data.identity,
      track_sid: parsed.data.trackSid,
      muted: true,
    });
    if (!res.ok) {
      return reply.code(502).send({ error: "mute_failed", message: "The meeting server refused the mute. Try again." });
    }
    return { ok: true };
  });

  app.post("/meetings/:code/host/remove", async (req, reply) => {
    const meeting = await requireHost(req, reply);
    if (!meeting) return reply;
    const cfg = config();
    if (!cfg) return notConfigured(reply);
    const parsed = z.object({ identity: z.string().min(1).max(200) }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_error", message: "Send { identity }." });
    }
    const res = await roomService(cfg, "RemoveParticipant", {
      room: liveKitRoomForMeeting(meeting.id),
      identity: parsed.data.identity,
    });
    if (!res.ok) {
      return reply.code(502).send({ error: "remove_failed", message: "The meeting server refused the removal. Try again." });
    }
    return { ok: true };
  });
}
