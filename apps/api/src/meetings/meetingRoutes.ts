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
import {
  MAX_DURATION_MINUTES,
  MAX_INVITES_PER_MEETING,
  MIN_DURATION_MINUTES,
  isUsableTimeZone,
  parseInviteEmails,
} from "./meetingSchedule";
import { meetingJoinUrl, meetingWhen, sendMeetingInvites } from "./meetingInviteSend";

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

/** Default when the host does not name a zone. The tenant's own zone if it has
 *  one — a New York business scheduling "2 PM" means Eastern. */
const FALLBACK_TIME_ZONE = "America/New_York";

/** One shape for a meeting on the wire, so the create response, the list and
 *  the invite response can never disagree about what a meeting looks like. */
function presentMeeting(m: any) {
  const when = meetingWhen(m);
  return {
    id: m.id,
    code: m.code,
    title: m.title,
    locked: m.locked,
    createdAt: m.createdAt,
    endedAt: m.endedAt ?? null,
    scheduledStartAt: m.scheduledStartAt ?? null,
    durationMinutes: m.durationMinutes ?? null,
    timezone: m.timezone ?? null,
    inviteMessage: m.inviteMessage ?? null,
    /** Pre-rendered exactly as the invite email states it, so the screen and
     *  the email can never describe the same meeting differently. */
    when: when ? { dateLine: when.dateLine, timeLine: when.timeLine, zoneLine: when.zoneLine } : null,
    joinPath: `/meet/${m.code}`,
    joinUrl: meetingJoinUrl(m.code),
    invites: Array.isArray(m.invites)
      ? m.invites.map((i: any) => ({ email: i.email, emailedAt: i.emailedAt ?? null }))
      : undefined,
  };
}

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

  /**
   * Who may START a meeting. Izzy's instruction 2026-08-21: "Permissions off
   * for everybody but me" — SUPER_ADMIN only.
   *
   * ⛔ This gates CREATE and LIST only, never JOIN. A guest has no account at
   * all and an ordinary signed-in colleague must still be able to open a link;
   * gating the join routes would make the feature pointless. Host powers are
   * separately limited to the creator (isMeetingHost), so a joiner still cannot
   * mute, remove, lock or end.
   *
   * ⛔ The portal hides the nav item and refuses to render /meetings for the
   * same rule. Those are presentation; THIS is the enforcement — a typed URL or
   * a raw curl lands here.
   */
  function requireMeetingCreator(req: FastifyRequest, reply: FastifyReply): boolean {
    if (String(getUser(req).role) === "SUPER_ADMIN") return true;
    reply.code(403).send({
      error: "forbidden",
      message: "Only a platform administrator can start a meeting.",
    });
    return false;
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

  /** Shared schedule validation for create and, later, any edit path.
   *  Returns a plain-English refusal rather than a slug — this is the screen a
   *  host uses under time pressure. */
  async function resolveScheduleInput(
    raw: { scheduledStartAt?: string; durationMinutes?: number; timezone?: string },
    tenantId: string,
  ): Promise<
    | { ok: true; scheduledStartAt: Date | null; durationMinutes: number | null; timezone: string | null }
    | { ok: false; message: string }
  > {
    if (!raw.scheduledStartAt) {
      // An instant meeting — start it and share the link now. The original
      // behaviour, still the default.
      return { ok: true, scheduledStartAt: null, durationMinutes: null, timezone: null };
    }
    const startAt = new Date(raw.scheduledStartAt);
    if (Number.isNaN(startAt.getTime())) {
      return { ok: false, message: "That start date and time could not be read." };
    }
    // Bound it so an obvious typo (a wrong year) cannot invite people to a
    // meeting in 2035 — without policing a host who wants a past record.
    const now = Date.now();
    if (startAt.getTime() > now + 2 * 365 * 24 * 3600_000) {
      return { ok: false, message: "That start date is more than two years away — check the year." };
    }
    if (startAt.getTime() < now - 30 * 24 * 3600_000) {
      return { ok: false, message: "That start date is more than a month in the past — check the date." };
    }

    const duration = Math.round(raw.durationMinutes ?? 30);
    if (duration < MIN_DURATION_MINUTES || duration > MAX_DURATION_MINUTES) {
      return {
        ok: false,
        message: `A meeting has to be between ${MIN_DURATION_MINUTES} minutes and ${MAX_DURATION_MINUTES / 60} hours long.`,
      };
    }

    let timezone = String(raw.timezone || "").trim();
    if (!timezone) {
      // Fall back to the tenant's own zone before the platform default.
      try {
        const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
        timezone = String(tenant?.timezone || "").trim();
      } catch {
        timezone = "";
      }
      if (!isUsableTimeZone(timezone)) timezone = FALLBACK_TIME_ZONE;
    }
    // ⛔ An unusable zone is REFUSED, never quietly swapped for UTC — the
    // email always names the zone, and a wrong one is a missed meeting.
    if (!isUsableTimeZone(timezone)) {
      return { ok: false, message: "That time zone was not recognised." };
    }
    return { ok: true, scheduledStartAt: startAt, durationMinutes: duration, timezone };
  }

  // ── Create (instant, or scheduled with invites) ───────────────────────
  app.post("/meetings", async (req, reply) => {
    if (!requireMeetingCreator(req, reply)) return reply;
    if (!config()) return notConfigured(reply);
    const user = getUser(req);
    const parsed = z
      .object({
        title: z.string().max(120).optional(),
        scheduledStartAt: z.string().max(64).optional(),
        durationMinutes: z.number().int().optional(),
        timezone: z.string().max(64).optional(),
        message: z.string().max(1000).optional(),
        invites: z.union([z.string().max(8000), z.array(z.string().max(320))]).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "validation_error",
        message: "Some of those meeting details could not be read. Check the name, the time and the invite list.",
      });
    }
    const title = sanitizeDisplayName(parsed.data.title)?.slice(0, 80) || "Video meeting";

    const schedule = await resolveScheduleInput(parsed.data, user.tenantId);
    if (!schedule.ok) return reply.code(400).send({ error: "validation_error", message: schedule.message });

    const invited = parseInviteEmails(parsed.data.invites ?? "");
    if (!invited.emails.length && invited.invalid.length) {
      return reply.code(400).send({
        error: "validation_error",
        message: `None of those look like email addresses: ${invited.invalid.slice(0, 5).join(", ")}`,
      });
    }

    const message = String(parsed.data.message ?? "").trim().slice(0, 1000) || null;

    // The unique index on code makes a collision a retry, never a corruption.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const meeting = await db.videoMeeting.create({
          data: {
            code: buildMeetingCode(),
            tenantId: user.tenantId,
            createdByUserId: user.sub,
            title,
            scheduledStartAt: schedule.scheduledStartAt,
            durationMinutes: schedule.durationMinutes,
            timezone: schedule.timezone,
            inviteMessage: message,
          },
        });

        // ⛔ Invites are queued AFTER the meeting exists and can never fail the
        // create: a meeting with a working link and no invites is recoverable
        // from the screen; a failed create with invites already sent is not.
        let sendResult = { sent: [] as string[], alreadyInvited: [] as string[], failed: [] as string[] };
        if (invited.emails.length) {
          sendResult = await sendMeetingInvites(db, {
            meeting,
            emails: invited.emails,
            skipAlreadyInvited: false,
            log: (m) => app.log.warn(m),
          });
        }

        return {
          ...presentMeeting(meeting),
          invites: invited.emails.map((email) => ({
            email,
            emailedAt: sendResult.sent.includes(email) ? new Date() : null,
          })),
          invitesSent: sendResult.sent.length,
          invitesFailed: sendResult.failed,
          invalidAddresses: invited.invalid,
          truncatedInvites: invited.truncated,
        };
      } catch (e: any) {
        if (e?.code === "P2002" && String(e?.meta?.target ?? "").includes("code")) continue;
        throw e;
      }
    }
    return reply.code(500).send({ error: "meeting_create_failed", message: "Could not create the meeting. Try again." });
  });

  // ── Invite more people to an existing meeting ─────────────────────────
  app.post("/meetings/:code/invite", async (req, reply) => {
    if (!requireMeetingCreator(req, reply)) return reply;
    const user = getUser(req);
    const meeting = await findMeetingByCode((req.params as any).code);
    if (!meeting) return badCode(reply);
    if (!isMeetingHost(meeting, user)) {
      return reply.code(403).send({ error: "forbidden", message: "Only the meeting's host can invite people." });
    }
    if (meeting.endedAt) {
      return reply.code(409).send({ error: "meeting_ended", message: "This meeting has already ended." });
    }
    const parsed = z
      .object({ invites: z.union([z.string().max(8000), z.array(z.string().max(320))]) })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_error", message: "That invite list could not be read." });
    }
    const invited = parseInviteEmails(parsed.data.invites);
    if (!invited.emails.length) {
      return reply.code(400).send({
        error: "validation_error",
        message: invited.invalid.length
          ? `None of those look like email addresses: ${invited.invalid.slice(0, 5).join(", ")}`
          : "Add at least one email address.",
      });
    }
    const existingCount = await db.videoMeetingInvite.count({ where: { meetingId: meeting.id } });
    if (existingCount + invited.emails.length > MAX_INVITES_PER_MEETING) {
      return reply.code(400).send({
        error: "too_many_invites",
        message: `A meeting can have at most ${MAX_INVITES_PER_MEETING} invitations.`,
      });
    }

    // ⛔ skipAlreadyInvited: adding two more people must not re-mail the six
    // who already have the invite sitting in their inbox.
    const sendResult = await sendMeetingInvites(db, {
      meeting,
      emails: invited.emails,
      skipAlreadyInvited: true,
      log: (m) => app.log.warn(m),
    });
    return {
      invitesSent: sendResult.sent.length,
      sent: sendResult.sent,
      alreadyInvited: sendResult.alreadyInvited,
      invitesFailed: sendResult.failed,
      invalidAddresses: invited.invalid,
      truncatedInvites: invited.truncated,
    };
  });

  // ── My meetings (creator-scoped on purpose — a meeting link is private to
  //    whoever made it until they share it) ─────────────────────────────────
  app.get("/meetings", async (req, reply) => {
    if (!requireMeetingCreator(req, reply)) return reply;
    const user = getUser(req);
    const rows = await db.videoMeeting.findMany({
      where: { tenantId: user.tenantId, createdByUserId: user.sub },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { invites: { orderBy: { createdAt: "asc" } } },
    });
    return { meetings: rows.map(presentMeeting) };
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
