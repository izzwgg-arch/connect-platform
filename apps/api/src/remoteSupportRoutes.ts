/**
 * Remote support routes — requesting a session, the customer answering, and the
 * signalling that gets a peer connection up.
 *
 * ⛔ WHAT DOES **NOT** GO THROUGH HERE: the screen and the input events. Those
 * ride the peer connection directly. This API only ever carries the question
 * ("may I connect?"), the answer, and the handful of messages needed to
 * introduce the two browsers to each other. That is deliberate — the customer's
 * screen never touches Connect's servers, so there is no recording to leak and
 * no storage to secure.
 *
 * Every decision lives in `remoteSupport/policy.ts`, tested without a database.
 * These handlers load facts, ask the policy, and write the result. If you find
 * yourself writing an `if` about who may do what in this file, it belongs in
 * the policy module instead.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { userHasActionPermission } from "./permissionGates";
import {
  decideConsent,
  decideControl,
  decideEnd,
  decideParticipation,
  decideRequest,
  counterpartRole,
  explainReason,
  resolveControlGrant,
  sessionLapseReason,
  REQUEST_TTL_MS,
  SIGNAL_TTL_MS,
  type ActorFacts,
  type SessionFacts,
} from "./remoteSupport/policy";

type JwtUser = { sub: string; tenantId: string; email: string; role: string };

export type RemoteSupportDeps = {
  audit: (params: {
    tenantId: string;
    action: string;
    entityType: string;
    entityId: string;
    actorUserId?: string;
    targetUserId?: string | null;
    metadata?: Record<string, unknown> | null;
  }) => Promise<void>;
};

const getUser = (req: any): JwtUser => req.user as JwtUser;

/**
 * ⛔ Permissions are read LIVE on every request, never cached onto the session.
 * This is what makes "revoke someone's access and it stops" true rather than
 * aspirational.
 */
async function actorFacts(user: JwtUser): Promise<ActorFacts> {
  const [canRemoteSupport, canControl] = await Promise.all([
    userHasActionPermission(user, "can_remote_support"),
    userHasActionPermission(user, "can_control_remote_support"),
  ]);
  return {
    userId: user.sub,
    tenantId: user.tenantId,
    isSuperAdmin: String(user.role) === "SUPER_ADMIN",
    canRemoteSupport,
    canControl,
  };
}

function toFacts(row: any): SessionFacts {
  return {
    id: row.id,
    tenantId: row.tenantId,
    targetUserId: row.targetUserId,
    requestedByUserId: row.requestedByUserId,
    status: row.status,
    controlRequested: row.controlRequested,
    controlGranted: row.controlGranted,
    expiresAt: row.expiresAt,
    startedAt: row.startedAt,
    lastSeenAdminAt: row.lastSeenAdminAt,
    lastSeenClientAt: row.lastSeenClientAt,
  };
}

/** The shape every screen renders. Never leaks anything about other sessions. */
function publicView(row: any, names: { target?: string | null; requester?: string | null } = {}) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    status: row.status,
    controlRequested: row.controlRequested,
    controlGranted: row.controlGranted,
    requestReason: row.requestReason,
    deviceLabel: row.deviceLabel,
    targetUserId: row.targetUserId,
    targetUserName: names.target ?? null,
    requestedByUserId: row.requestedByUserId,
    requestedByName: names.requester ?? null,
    expiresAt: row.expiresAt,
    consentAt: row.consentAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endedReason: row.endedReason,
    endedBy: row.endedBy,
    inputEventCount: row.inputEventCount,
    createdAt: row.createdAt,
  };
}

/**
 * Close any session that has run out of road.
 *
 * ⛔ Called lazily from the polling routes rather than only from a timer. A
 * session must be able to die even if the process that started it restarted —
 * the same lesson as the alert cooldown that lived in a Map and re-armed on
 * every deploy.
 */
export async function sweepLapsedRemoteSupportSessions(now = new Date()): Promise<number> {
  const open = await db.remoteSupportSession.findMany({
    where: { status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
    select: {
      id: true, tenantId: true, targetUserId: true, requestedByUserId: true, status: true,
      controlRequested: true, controlGranted: true, expiresAt: true, startedAt: true,
      lastSeenAdminAt: true, lastSeenClientAt: true,
    },
  });

  let closed = 0;
  for (const row of open) {
    const reason = sessionLapseReason(toFacts(row), now);
    if (!reason) continue;
    const status = reason === "no_answer" ? "EXPIRED" : "ENDED";
    // Guarded on the status we read, so two sweepers racing cannot both close it.
    const res = await db.remoteSupportSession.updateMany({
      where: { id: row.id, status: row.status },
      data: { status, endedAt: now, endedReason: reason, endedBy: "watchdog" },
    });
    closed += res.count;
  }
  return closed;
}

/** Signalling rows are junk once the negotiation is over. */
async function purgeOldSignals(now = new Date()): Promise<void> {
  await db.remoteSupportSignal.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - SIGNAL_TTL_MS) } },
  });
}

async function loadSession(id: string) {
  return db.remoteSupportSession.findUnique({ where: { id } });
}

async function resolveNames(row: any) {
  const ids = [row.targetUserId, row.requestedByUserId].filter(Boolean);
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const label = (id: string) => {
    const u = users.find((x) => x.id === id);
    if (!u) return null;
    // A real name if we have one, the email if not. Never "Unknown user" — the
    // escalation SMS taught that lesson: a placeholder where a person's name
    // belongs reads as a bug in us rather than a fact anyone can act on.
    const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
    return full || u.email;
  };
  return { target: label(row.targetUserId), requester: label(row.requestedByUserId) };
}

const requestBody = z.object({
  targetUserId: z.string().min(1),
  reason: z.string().min(1).max(300),
  requestControl: z.boolean().optional().default(false),
});

const consentBody = z.object({
  allow: z.boolean(),
  allowControl: z.boolean().optional().default(false),
  deviceLabel: z.string().max(200).optional(),
});

const signalBody = z.object({
  kind: z.enum(["offer", "answer", "ice"]),
  payload: z.any(),
});

export async function registerRemoteSupportRoutes(app: FastifyInstance, deps: RemoteSupportDeps) {
  /**
   * The staff member asks. Nothing is shown to the customer until this succeeds,
   * and nothing happens on their machine until they answer.
   */
  app.post("/remote-support/sessions", async (req: any, reply: any) => {
    const user = getUser(req);
    const parsed = requestBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", message: "Missing a target or a reason." });
    }
    const { targetUserId, reason, requestControl } = parsed.data;

    const target = await db.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, tenantId: true, firstName: true, lastName: true, email: true },
    });
    if (!target) {
      return reply.status(404).send({ error: "user_not_found", message: "That person no longer exists." });
    }

    const actor = await actorFacts(user);
    const decision = decideRequest({
      actor,
      targetUserId,
      targetTenantId: target.tenantId,
      requestControl,
      reason,
    });
    if (!decision.ok) {
      // 403 for permission, 400 for a bad request — so the caller can tell
      // "you may not" from "you asked wrongly".
      const status = decision.reason.startsWith("missing_") || decision.reason.includes("tenant") ? 403 : 400;
      return reply.status(status).send({
        error: decision.reason,
        message: explainReason(decision.reason),
      });
    }

    const now = new Date();
    const session = await db.remoteSupportSession.create({
      data: {
        tenantId: target.tenantId,
        targetUserId,
        requestedByUserId: user.sub,
        requestReason: reason.trim(),
        controlRequested: requestControl,
        // ⛔ Never set here. Only the consent route may write this.
        controlGranted: false,
        status: "REQUESTED",
        expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
      },
    });

    await deps.audit({
      tenantId: target.tenantId,
      action: "REMOTE_SUPPORT_REQUESTED",
      entityType: "RemoteSupportSession",
      entityId: session.id,
      actorUserId: user.sub,
      targetUserId,
      metadata: { reason: reason.trim(), controlRequested: requestControl },
    });

    return reply.send({ ok: true, session: publicView(session, await resolveNames(session)) });
  });

  /**
   * The desktop app asks: is anyone waiting on me? This is the only polling the
   * customer's machine does when nothing is happening.
   */
  app.get("/remote-support/pending", async (req: any, reply: any) => {
    const user = getUser(req);
    await sweepLapsedRemoteSupportSessions();

    const rows = await db.remoteSupportSession.findMany({
      where: { targetUserId: user.sub, status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    const out = [];
    for (const row of rows) out.push(publicView(row, await resolveNames(row)));
    return reply.send({ sessions: out });
  });

  /** Status poll, for both sides. */
  app.get("/remote-support/sessions/:id", async (req: any, reply: any) => {
    const user = getUser(req);
    await sweepLapsedRemoteSupportSessions();

    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });

    const actor = await actorFacts(user);
    const isParticipant = row.targetUserId === user.sub || row.requestedByUserId === user.sub;
    if (!isParticipant && !actor.isSuperAdmin) {
      return reply.status(403).send({ error: "not_a_participant", message: explainReason("not_a_participant") });
    }

    return reply.send({ session: publicView(row, await resolveNames(row)) });
  });

  /**
   * The customer answers.
   *
   * ⛔ The ONLY place `controlGranted` is ever written, and it is computed from
   * both sides agreeing rather than from anything the caller sends.
   */
  app.post("/remote-support/sessions/:id/consent", async (req: any, reply: any) => {
    const user = getUser(req);
    const parsed = consentBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });

    const now = new Date();
    const decision = decideConsent({ actor: { userId: user.sub }, session: toFacts(row), now });
    if (!decision.ok) {
      return reply.status(decision.reason === "not_your_session" ? 403 : 409).send({
        error: decision.reason,
        message: explainReason(decision.reason),
      });
    }

    if (!parsed.data.allow) {
      // Guarded update so a second click cannot flip a declined session.
      const res = await db.remoteSupportSession.updateMany({
        where: { id: row.id, status: "REQUESTED" },
        data: { status: "DECLINED", declinedAt: now, endedAt: now, endedReason: "declined", endedBy: "customer" },
      });
      if (res.count === 0) return reply.status(409).send({ error: "already_answered" });

      await deps.audit({
        tenantId: row.tenantId,
        action: "REMOTE_SUPPORT_DECLINED",
        entityType: "RemoteSupportSession",
        entityId: row.id,
        actorUserId: user.sub,
        targetUserId: row.requestedByUserId,
        metadata: { reason: row.requestReason },
      });
      return reply.send({ ok: true, allowed: false });
    }

    const controlGranted = resolveControlGrant({
      controlRequested: row.controlRequested,
      customerAllowedControl: parsed.data.allowControl === true,
    });

    const res = await db.remoteSupportSession.updateMany({
      where: { id: row.id, status: "REQUESTED" },
      data: {
        status: "CONSENTED",
        controlGranted,
        consentAt: now,
        startedAt: now,
        lastSeenClientAt: now,
        deviceLabel: parsed.data.deviceLabel?.slice(0, 200) || row.deviceLabel,
      },
    });
    if (res.count === 0) return reply.status(409).send({ error: "already_answered" });

    await deps.audit({
      tenantId: row.tenantId,
      action: "REMOTE_SUPPORT_CONSENTED",
      entityType: "RemoteSupportSession",
      entityId: row.id,
      actorUserId: user.sub,
      targetUserId: row.requestedByUserId,
      metadata: {
        controlRequested: row.controlRequested,
        controlGranted,
        deviceLabel: parsed.data.deviceLabel || null,
      },
    });

    const fresh = await loadSession(row.id);
    return reply.send({ ok: true, allowed: true, session: publicView(fresh, await resolveNames(fresh)) });
  });

  /**
   * Heartbeat. Both sides call this; silence is what ends a session, so this is
   * load-bearing rather than telemetry.
   */
  app.post("/remote-support/sessions/:id/heartbeat", async (req: any, reply: any) => {
    const user = getUser(req);
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });

    const actor = await actorFacts(user);
    const now = new Date();
    const participation = decideParticipation({ actor, session: toFacts(row), now });
    if (!participation.ok) {
      return reply.status(409).send({
        error: participation.reason,
        message: explainReason(participation.reason),
      });
    }

    const data: Record<string, unknown> =
      participation.role === "ADMIN" ? { lastSeenAdminAt: now } : { lastSeenClientAt: now };
    // The first heartbeat from a consented session is what marks it live.
    if (row.status === "CONSENTED") data.status = "ACTIVE";

    await db.remoteSupportSession.updateMany({
      where: { id: row.id, status: { in: ["CONSENTED", "ACTIVE"] } },
      data,
    });

    return reply.send({ ok: true, role: participation.role, canControl: row.controlGranted });
  });

  /** Post a signalling message for the other side. */
  app.post("/remote-support/sessions/:id/signal", async (req: any, reply: any) => {
    const user = getUser(req);
    const parsed = signalBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });

    const actor = await actorFacts(user);
    const participation = decideParticipation({ actor, session: toFacts(row), now: new Date() });
    if (!participation.ok) {
      return reply.status(409).send({
        error: participation.reason,
        message: explainReason(participation.reason),
      });
    }

    await db.remoteSupportSignal.create({
      data: {
        sessionId: row.id,
        fromRole: participation.role,
        kind: parsed.data.kind,
        payload: parsed.data.payload ?? {},
      },
    });

    return reply.send({ ok: true });
  });

  /** Drain everything the other side has posted since last time. */
  app.get("/remote-support/sessions/:id/signal", async (req: any, reply: any) => {
    const user = getUser(req);
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });

    const actor = await actorFacts(user);
    const participation = decideParticipation({ actor, session: toFacts(row), now: new Date() });
    if (!participation.ok) {
      return reply.status(409).send({
        error: participation.reason,
        message: explainReason(participation.reason),
      });
    }

    const want = counterpartRole(participation.role);
    const rows = await db.remoteSupportSignal.findMany({
      where: { sessionId: row.id, fromRole: want, consumedAt: null },
      orderBy: { createdAt: "asc" },
      take: 50,
    });

    if (rows.length > 0) {
      await db.remoteSupportSignal.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { consumedAt: new Date() },
      });
    }
    void purgeOldSignals().catch(() => {});

    return reply.send({
      signals: rows.map((r) => ({ id: r.id, kind: r.kind, payload: r.payload })),
      status: row.status,
      controlGranted: row.controlGranted,
    });
  });

  /**
   * Records that input was actually injected, and re-authorises control while
   * doing so. The count is the honest answer to "did they touch anything".
   */
  app.post("/remote-support/sessions/:id/input", async (req: any, reply: any) => {
    const user = getUser(req);
    const count = Math.max(0, Math.min(10_000, Number(req.body?.count) || 0));

    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });

    const actor = await actorFacts(user);
    const decision = decideControl({ actor, session: toFacts(row), now: new Date() });
    if (!decision.ok) {
      return reply.status(403).send({ error: decision.reason, message: explainReason(decision.reason) });
    }

    if (count > 0) {
      await db.remoteSupportSession.update({
        where: { id: row.id },
        data: { inputEventCount: { increment: count } },
      });
    }
    return reply.send({ ok: true });
  });

  /** Either side hangs up. */
  app.post("/remote-support/sessions/:id/end", async (req: any, reply: any) => {
    const user = getUser(req);
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });

    const actor = await actorFacts(user);
    const decision = decideEnd({
      actor: { userId: user.sub, isSuperAdmin: actor.isSuperAdmin },
      session: toFacts(row),
    });
    if (!decision.ok) {
      // Already ended is a success from the caller's point of view — they wanted
      // it stopped and it is stopped.
      if (decision.reason === "already_ended") return reply.send({ ok: true, alreadyEnded: true });
      return reply.status(403).send({ error: decision.reason, message: explainReason(decision.reason) });
    }

    const endedBy = user.sub === row.targetUserId ? "customer" : "admin";
    const now = new Date();
    await db.remoteSupportSession.updateMany({
      where: { id: row.id, status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
      data: { status: "ENDED", endedAt: now, endedReason: `ended_by_${endedBy}`, endedBy },
    });

    await deps.audit({
      tenantId: row.tenantId,
      action: "REMOTE_SUPPORT_ENDED",
      entityType: "RemoteSupportSession",
      entityId: row.id,
      actorUserId: user.sub,
      targetUserId: row.targetUserId,
      metadata: {
        endedBy,
        controlGranted: row.controlGranted,
        inputEventCount: row.inputEventCount,
        startedAt: row.startedAt,
      },
    });

    return reply.send({ ok: true });
  });

  /**
   * The audit view: who watched whose screen, and did they touch anything.
   * Scoped to the caller's tenant unless they are a super admin.
   */
  app.get("/remote-support/sessions", async (req: any, reply: any) => {
    const user = getUser(req);
    const actor = await actorFacts(user);
    if (!actor.canRemoteSupport) {
      return reply.status(403).send({ error: "missing_permission", message: explainReason("missing_permission") });
    }
    await sweepLapsedRemoteSupportSessions();

    const take = Math.min(200, Math.max(1, Number(req.query?.limit) || 50));
    const rows = await db.remoteSupportSession.findMany({
      where: actor.isSuperAdmin ? {} : { tenantId: user.tenantId },
      orderBy: { createdAt: "desc" },
      take,
    });

    const out = [];
    for (const row of rows) out.push(publicView(row, await resolveNames(row)));
    return reply.send({ sessions: out });
  });
}
