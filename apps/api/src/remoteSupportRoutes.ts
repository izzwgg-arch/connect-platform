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
import {
  checkSignalPayload,
  decideCapability,
  decideMediaBudget,
  decideProbeRate,
  decideRequestRate,
  decideSupportGate,
  isRemoteCapability,
  resolveCapabilityGrant,
  REQUEST_WINDOW_MS,
  MAX_PENDING_SIGNALS_PER_ROLE,
  type RemoteCapability,
} from "./remoteSupport/controls";
import { loadRemoteSupportControls } from "./remoteSupport/controlStore";
import { recordEvent, sanitizeChatBody } from "./remoteSupport/events";
import { registerRemoteSupportControlRoutes } from "./remoteSupport/controlRoutes";

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

/**
 * The requester's LIVE permissions, looked up by id.
 *
 * ⛔ Needed by the consent route, which runs as the CUSTOMER but has to decide
 * what the TECHNICIAN may be granted. Reading the technician's key at the moment
 * of consent — rather than trusting what they held when they asked — is what
 * makes "revoke someone and the next thing they do fails" true even across the
 * gap between the request and the answer.
 *
 * ⛔ Fails CLOSED. A user row that has vanished, or a lookup that throws, yields
 * no permissions, so the capability resolves to view-only rather than to
 * whatever was asked for.
 */
async function actorFactsForUserId(userId: string): Promise<{ canRemoteSupport: boolean; canControl: boolean }> {
  try {
    const u = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, tenantId: true, role: true, email: true },
    });
    if (!u) return { canRemoteSupport: false, canControl: false };
    const shaped = { sub: u.id, tenantId: u.tenantId, role: String(u.role), email: u.email };
    const [canRemoteSupport, canControl] = await Promise.all([
      userHasActionPermission(shaped, "can_remote_support"),
      userHasActionPermission(shaped, "can_control_remote_support"),
    ]);
    return { canRemoteSupport, canControl };
  } catch {
    return { canRemoteSupport: false, canControl: false };
  }
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
    // ⛔ Both lists, kept apart. `Requested` tells the consent dialog which rows
    // to SHOW; `Granted` is the only one that authorises anything.
    capabilitiesRequested: row.capabilitiesRequested ?? [],
    capabilitiesGranted: row.capabilitiesGranted ?? [],
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
  /**
   * Beyond looking and typing (Phases 11, 12).
   * ⛔ Unknown values are dropped by `resolveCapabilityGrant`, never rejected —
   * an older desktop app posting a capability this build does not know about
   * must degrade to "not granted", not to a 400 that breaks its whole session.
   */
  capabilities: z.array(z.string().max(32)).max(8).optional().default([]),
});

const consentBody = z.object({
  allow: z.boolean(),
  allowControl: z.boolean().optional().default(false),
  deviceLabel: z.string().max(200).optional(),
  /** Which of the requested extras the customer ticked. */
  allowCapabilities: z.array(z.string().max(32)).max(8).optional().default([]),
  /**
   * The machine answering. Recorded so a device revocation has something to
   * match, and so the audit row says which computer rather than only which
   * person.
   */
  deviceId: z.string().max(200).optional(),
});

const chatBody = z.object({ body: z.string().min(1).max(4000) });

const capabilityBody = z.object({ capability: z.string().max(32) });

/**
 * The subject every gate decision needs.
 *
 * ⛔ THE TENANT IS THE **TARGET'S**, NEVER THE ACTOR'S. A super admin reaching
 * into a customer must be stopped by that customer's revocation, and taking the
 * tenant from the caller would mean a platform admin could never be blocked by
 * one — which is exactly backwards, since they are the account with the most
 * reach.
 */
function gateSubject(actorUserId: string, session: { tenantId: string; deviceId?: string | null }) {
  return { actorUserId, tenantId: session.tenantId, deviceId: session.deviceId ?? null };
}

const signalBody = z.object({
  kind: z.enum(["offer", "answer", "ice"]),
  payload: z.any(),
});

export async function registerRemoteSupportRoutes(app: FastifyInstance, deps: RemoteSupportDeps) {
  /**
   * ⛔ The emergency controls are registered HERE, inside this closure, rather
   * than from `server.ts`.
   *
   * Two reasons, both deliberate. It means adding the kill switch required no
   * edit to `server.ts` — a 40,000-line file that several sessions edit at once,
   * where a merge that silently drops one line would leave the switch
   * unreachable. And it guarantees the emergency surface is registered exactly
   * when the session surface is: there is no ordering in which sessions can be
   * started but not stopped.
   */
  await registerRemoteSupportControlRoutes(app, { audit: deps.audit });

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
    const { targetUserId, reason, requestControl, capabilities } = parsed.data;

    // ⛔ Scoped to the caller's own tenant unless they are SUPER_ADMIN. The
    // lookup used to be by bare id, and the policy then answered
    // `403 cross_tenant_not_allowed` for a foreign user vs `404 user_not_found`
    // for a non-existent one — a platform-wide USER-ID EXISTENCE ORACLE for
    // anyone holding can_remote_support. Now a foreign id reads exactly like a
    // missing one. The policy still runs and still decides cross-tenant for
    // the platform admin, who genuinely may reach other tenants.
    const isPlatformAdmin = String(user.role || "").toUpperCase() === "SUPER_ADMIN";
    const target = await db.user.findFirst({
      where: isPlatformAdmin ? { id: targetUserId } : { id: targetUserId, tenantId: user.tenantId },
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

    // ⛔ THE KILL SWITCH AND REVOCATIONS, checked against the TARGET'S tenant.
    // Deliberately after the policy decision, so a technician who was never
    // allowed to reach this person is told that, rather than being told the
    // feature is off — which would be a small oracle about who exists.
    const { controls, revocations } = await loadRemoteSupportControls();
    const gate = decideSupportGate({
      controls,
      subject: { actorUserId: user.sub, tenantId: target.tenantId, deviceId: null },
      revocations,
    });
    if (!gate.ok) {
      return reply.status(403).send({ error: gate.reason, message: gate.detail });
    }

    const now = new Date();

    // ⛔ ABUSE PROTECTION (Phase 29), keyed on the ACTOR rather than the address:
    // an authenticated abuser behind a corporate NAT shares an IP with the
    // customers we must not break.
    const windowStart = new Date(now.getTime() - REQUEST_WINDOW_MS);
    const recent = await db.remoteSupportSession.findMany({
      where: { requestedByUserId: user.sub, createdAt: { gte: windowStart } },
      select: { createdAt: true, targetUserId: true },
      take: 200,
    });
    const distinctTargets = new Set(recent.map((r) => r.targetUserId));
    distinctTargets.add(targetUserId);
    const rate = decideRequestRate({
      now,
      recentRequestsAt: recent.map((r) => r.createdAt),
      distinctTargetsInWindow: distinctTargets.size,
    });
    if (!rate.ok) {
      reply.header("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
      return reply.status(429).send({ error: rate.reason, message: rate.detail });
    }

    const session = await db.remoteSupportSession.create({
      data: {
        tenantId: target.tenantId,
        targetUserId,
        requestedByUserId: user.sub,
        requestReason: reason.trim(),
        controlRequested: requestControl,
        // ⛔ Never set here. Only the consent route may write this.
        controlGranted: false,
        // ⛔ Requested only. `capabilitiesGranted` stays empty until the customer
        // answers, exactly like controlGranted.
        capabilitiesRequested: capabilities.filter(isRemoteCapability),
        capabilitiesGranted: [],
        status: "REQUESTED",
        expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
      },
    });

    const requesterName = (await resolveNames(session)).requester;
    void recordEvent({
      sessionId: session.id,
      tenantId: target.tenantId,
      actorRole: "ADMIN",
      actorUserId: user.sub,
      kind: "system",
      code: "requested",
      facts: { actorName: requesterName },
      meta: { controlRequested: requestControl, capabilities: capabilities.filter(isRemoteCapability) },
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
    // ⛔ Existence first — see the note on the chat route. A session that does
    // not exist answers the same way whatever the body looked like.
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });

    const parsed = consentBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

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

      void recordEvent({
        sessionId: row.id,
        tenantId: row.tenantId,
        actorRole: "CLIENT",
        actorUserId: user.sub,
        kind: "system",
        code: "declined",
      });

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

    // ⛔ THE EXTRA CAPABILITIES ARE RESOLVED THE SAME WAY AS CONTROL: both sides
    // must have said yes, and the technician must still hold the control key
    // RIGHT NOW. A grant is computed here, never taken from the request body.
    const requesterActor = await actorFactsForUserId(row.requestedByUserId);
    const capabilitiesGranted = resolveCapabilityGrant({
      requested: row.capabilitiesRequested ?? [],
      customerAllowed: parsed.data.allowCapabilities ?? [],
      actorMayControl: requesterActor.canControl,
    });

    const res = await db.remoteSupportSession.updateMany({
      where: { id: row.id, status: "REQUESTED" },
      data: {
        status: "CONSENTED",
        controlGranted,
        capabilitiesGranted,
        consentAt: now,
        startedAt: now,
        lastSeenClientAt: now,
        deviceLabel: parsed.data.deviceLabel?.slice(0, 200) || row.deviceLabel,
        deviceId: parsed.data.deviceId?.slice(0, 200) || row.deviceId,
      },
    });
    if (res.count === 0) return reply.status(409).send({ error: "already_answered" });

    void recordEvent({
      sessionId: row.id,
      tenantId: row.tenantId,
      actorRole: "CLIENT",
      actorUserId: user.sub,
      kind: "system",
      code: "consented",
      facts: {
        capabilities: [
          "screen",
          ...(controlGranted ? ["mouse and keyboard"] : []),
          ...capabilitiesGranted.filter((c) => c !== "view" && c !== "control"),
        ],
      },
      meta: { controlGranted, capabilitiesGranted },
    });

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

    // ⛔ THE KILL SWITCH IS CHECKED ON EVERY BEAT, not only at request time.
    // This is the half that makes "off" mean the live session dies rather than
    // merely that the next one is refused.
    const { controls, revocations } = await loadRemoteSupportControls();
    const gate = decideSupportGate({
      controls,
      subject: gateSubject(row.requestedByUserId, row),
      revocations,
    });
    if (!gate.ok) {
      await db.remoteSupportSession.updateMany({
        where: { id: row.id, status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
        data: { status: "ENDED", endedAt: now, endedReason: gate.reason, endedBy: "control" },
      });
      void recordEvent({
        sessionId: row.id,
        tenantId: row.tenantId,
        actorRole: "SYSTEM",
        kind: "system",
        code: gate.reason === "remote_support_disabled" ? "killed" : "revoked",
      });
      return reply.status(409).send({ error: gate.reason, message: gate.detail });
    }

    const data: Record<string, unknown> =
      participation.role === "ADMIN" ? { lastSeenAdminAt: now } : { lastSeenClientAt: now };
    // The first heartbeat from a consented session is what marks it live.
    if (row.status === "CONSENTED") data.status = "ACTIVE";

    // ⛔ PHASE 37 / NON-NEGOTIABLE #15. The customer's app reports whether a
    // phone call is up; the answer decides the screen's budget. Only the client
    // may set this — an admin claiming "no call in progress" must never be able
    // to buy back bitrate on someone else's machine.
    const onCall = participation.role === "CLIENT" ? req.body?.callInProgress === true : row.clientOnCall;
    if (participation.role === "CLIENT" && onCall !== row.clientOnCall) {
      data.clientOnCall = onCall;
      void recordEvent({
        sessionId: row.id,
        tenantId: row.tenantId,
        actorRole: "SYSTEM",
        kind: "system",
        code: onCall ? "call_started" : "call_ended",
      });
    }

    await db.remoteSupportSession.updateMany({
      where: { id: row.id, status: { in: ["CONSENTED", "ACTIVE"] } },
      data,
    });

    const budget = decideMediaBudget({
      callInProgress: onCall,
      packetLoss: Number(req.body?.packetLoss),
      roundTripMs: Number(req.body?.roundTripMs),
    });

    return reply.send({
      ok: true,
      role: participation.role,
      canControl: row.controlGranted,
      capabilities: row.capabilitiesGranted ?? [],
      /** Advisory to the encoder. Never a permission — see controls.ts. */
      mediaBudget: budget,
      callInProgress: onCall,
    });
  });

  /** Post a signalling message for the other side. */
  app.post("/remote-support/sessions/:id/signal", async (req: any, reply: any) => {
    const user = getUser(req);
    // ⛔ Existence first — see the note on the chat route.
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });

    const parsed = signalBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

    const actor = await actorFacts(user);
    const participation = decideParticipation({ actor, session: toFacts(row), now: new Date() });
    if (!participation.ok) {
      return reply.status(409).send({
        error: participation.reason,
        message: explainReason(participation.reason),
      });
    }

    // ⛔ THE ONLY THING THIS FEATURE EVER WRITES TO OUR DATABASE, so it is the
    // only place a flood or an oversized blob can land. Checked before the write.
    const pending = await db.remoteSupportSignal.count({
      where: { sessionId: row.id, fromRole: participation.role, consumedAt: null },
    });
    const check = checkSignalPayload(parsed.data.payload, pending);
    if (!check.ok) {
      return reply.status(check.reason === "signal_backlog" ? 429 : 400).send({
        error: check.reason,
        message: check.detail,
      });
    }

    await db.remoteSupportSignal.create({
      data: {
        sessionId: row.id,
        fromRole: participation.role,
        kind: parsed.data.kind,
        payload: parsed.data.payload,
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

    // ⛔ The kill switch again. Input is the most invasive thing in the feature,
    // so it re-checks rather than trusting the heartbeat that came before it.
    const { controls, revocations } = await loadRemoteSupportControls();
    const gate = decideSupportGate({
      controls,
      subject: gateSubject(user.sub, row),
      revocations,
    });
    if (!gate.ok) return reply.status(403).send({ error: gate.reason, message: gate.detail });

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

    // ⛔⛔ THERE IS NO GATE CHECK IN THIS HANDLER, AND THAT IS DELIBERATE.
    // The kill switch and every revocation are consulted on request, consent,
    // heartbeat, signal and input — and NEVER here. A switch that could also
    // refuse `end` would, in the exact emergency it exists for, leave a live
    // session running with no way to close it. Do not "tidy" a gate call into
    // this route; `remoteSupportGuards.test.ts` fails if one appears.
    const endedBy = user.sub === row.targetUserId ? "customer" : "admin";
    const now = new Date();
    await db.remoteSupportSession.updateMany({
      where: { id: row.id, status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
      data: { status: "ENDED", endedAt: now, endedReason: `ended_by_${endedBy}`, endedBy },
    });

    void recordEvent({
      sessionId: row.id,
      tenantId: row.tenantId,
      actorRole: endedBy === "customer" ? "CLIENT" : "ADMIN",
      actorUserId: user.sub,
      kind: "system",
      code: "ended",
      facts: { detail: endedBy === "customer" ? "stopped by the customer" : "closed by support" },
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
  /**
   * Who a technician may connect to — the list behind "Choose a person…".
   *
   * ⛔ THE SCOPING IS THE SAME RULE AS `POST /remote-support/sessions`, on
   * purpose: a super admin sees every person on every approved customer tenant,
   * anyone else sees only their own company. A list wider than the request
   * route would offer people the request then refuses; a narrower one would hide
   * people the technician is allowed to reach. Change one, change both.
   *
   * ⛔ The portal used to ask `/team/members` for this list. That route has
   * never existed, so every load was a swallowed 404 and the dropdown was empty
   * for everybody, always. If this list ever reads empty again, check the route
   * NAME the screen calls before anything else.
   */
  app.get("/remote-support/people", async (req: any, reply: any) => {
    const user = getUser(req);
    const actor = await actorFacts(user);
    if (!actor.canRemoteSupport) {
      return reply.status(403).send({ error: "missing_permission", message: explainReason("missing_permission") });
    }
    const rows = await db.user.findMany({
      where: actor.isSuperAdmin
        ? { status: { not: "DISABLED" as any }, role: { not: "SUPER_ADMIN" as any }, tenant: { kind: "CUSTOMER" as any, isApproved: true, pbxRemovedAt: null } }
        : { status: { not: "DISABLED" as any }, tenantId: user.tenantId },
      select: { id: true, firstName: true, lastName: true, email: true, tenant: { select: { id: true, name: true } } },
      orderBy: [{ tenant: { name: "asc" } }, { firstName: "asc" }, { email: "asc" }],
      take: 1000,
    });
    const people = rows.map((u: any) => {
      const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
      return { id: u.id, name: full || u.email, email: u.email, tenantId: u.tenant?.id ?? null, tenantName: u.tenant?.name ?? null };
    });
    return reply.send({ people });
  });

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

  /* ─────────────── the transcript: chat + system events ─────────────── */

  /**
   * Read the session's chronological record.
   *
   * ⛔ Participants and super admins only, and scoped to ONE session. There is no
   * route that reads events across sessions — the transcript of somebody's
   * support call is not a reporting surface.
   */
  app.get("/remote-support/sessions/:id/events", async (req: any, reply: any) => {
    const user = getUser(req);
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });

    const actor = await actorFacts(user);
    const isParticipant = row.targetUserId === user.sub || row.requestedByUserId === user.sub;
    if (!isParticipant && !actor.isSuperAdmin) {
      return reply.status(403).send({ error: "not_a_participant", message: explainReason("not_a_participant") });
    }

    const since = req.query?.since ? new Date(String(req.query.since)) : null;
    const events = await db.remoteSupportEvent.findMany({
      where: {
        sessionId: row.id,
        ...(since && !Number.isNaN(since.getTime()) ? { at: { gt: since } } : {}),
      },
      orderBy: { at: "asc" },
      take: 500,
    });

    return reply.send({
      events: events.map((e) => ({
        id: e.id,
        at: e.at,
        kind: e.kind,
        code: e.code,
        actorRole: e.actorRole,
        body: e.body,
      })),
    });
  });

  /** Say something. Both sides may; nothing else in the session is required. */
  app.post("/remote-support/sessions/:id/chat", async (req: any, reply: any) => {
    const user = getUser(req);

    // ⛔⛔ THE SESSION IS LOADED BEFORE THE BODY IS VALIDATED, AND THE ORDER IS
    // THE POINT. This repo has already paid for the reverse: the desk-phone
    // `authorize-reset` route answered 400 for a malformed body and 403 for a
    // missing permission, both AHEAD of the 404 for a run that was not yours —
    // so the shape of the refusal told you things about ids you had no business
    // learning. Existence dominates, everywhere, on every session-scoped route.
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });

    const parsed = chatBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", message: "Type a message first." });

    const actor = await actorFacts(user);
    const participation = decideParticipation({ actor, session: toFacts(row), now: new Date() });
    if (!participation.ok) {
      return reply.status(409).send({
        error: participation.reason,
        message: explainReason(participation.reason),
      });
    }

    const body = sanitizeChatBody(parsed.data.body);
    if (!body) return reply.status(400).send({ error: "empty_message", message: "Type a message first." });

    await recordEvent({
      sessionId: row.id,
      tenantId: row.tenantId,
      actorRole: participation.role,
      actorUserId: user.sub,
      kind: "chat",
      body,
    });
    return reply.send({ ok: true });
  });

  /* ─────────── asking for more, mid-session (Phases 11, 12) ─────────── */

  /**
   * The technician asks for a capability they were not granted.
   *
   * ⛔⛔ THIS ROUTE CANNOT GRANT ANYTHING. It records the request and puts the
   * question back in front of the customer. `capabilitiesGranted` is written by
   * exactly one place — the consent route — and this is not it. A technician
   * escalating their own access without the customer answering is the single
   * abuse this whole design refuses.
   */
  app.post("/remote-support/sessions/:id/request-capability", async (req: any, reply: any) => {
    const user = getUser(req);
    // ⛔ Existence first — see the note on the chat route.
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });

    const parsed = capabilityBody.safeParse(req.body);
    if (!parsed.success || !isRemoteCapability(parsed.data.capability)) {
      return reply.status(400).send({ error: "unknown_capability", message: "That is not something you can ask for." });
    }
    const capability = parsed.data.capability as RemoteCapability;

    const actor = await actorFacts(user);
    const participation = decideParticipation({ actor, session: toFacts(row), now: new Date() });
    if (!participation.ok) {
      return reply.status(409).send({ error: participation.reason, message: explainReason(participation.reason) });
    }
    if (participation.role !== "ADMIN") {
      return reply.status(403).send({ error: "only_support_may_ask", message: "Only the support side can ask for this." });
    }
    if (!actor.canControl) {
      return reply.status(403).send({
        error: "missing_control_permission",
        message: explainReason("missing_control_permission"),
      });
    }

    const { controls, revocations } = await loadRemoteSupportControls();
    const gate = decideSupportGate({ controls, subject: gateSubject(user.sub, row), revocations });
    if (!gate.ok) return reply.status(403).send({ error: gate.reason, message: gate.detail });

    const already = new Set(row.capabilitiesRequested ?? []);
    already.add(capability);
    await db.remoteSupportSession.update({
      where: { id: row.id },
      data: { capabilitiesRequested: Array.from(already) },
    });

    void recordEvent({
      sessionId: row.id,
      tenantId: row.tenantId,
      actorRole: "ADMIN",
      actorUserId: user.sub,
      kind: "system",
      code: "capability_requested",
      facts: { actorName: (await resolveNames(row)).requester, capabilities: [capability] },
    });

    // ⛔ `granted` is unchanged and is returned so the caller can see that.
    return reply.send({ ok: true, pending: capability, granted: row.capabilitiesGranted ?? [] });
  });

  /**
   * The customer answers a mid-session request.
   *
   * ⛔ THE ONLY OTHER PLACE `capabilitiesGranted` IS WRITTEN, and it is written
   * by the person whose machine it is — the same rule as the original consent.
   */
  app.post("/remote-support/sessions/:id/answer-capability", async (req: any, reply: any) => {
    const user = getUser(req);
    const capability = String(req.body?.capability || "");
    const allow = req.body?.allow === true;
    if (!isRemoteCapability(capability)) {
      return reply.status(400).send({ error: "unknown_capability", message: "That is not something to answer." });
    }

    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });

    // ⛔ Only the person whose screen it is. Not their manager, not a super admin.
    if (row.targetUserId !== user.sub) {
      return reply.status(403).send({ error: "not_your_session", message: explainReason("not_your_session") });
    }
    if (isTerminalStatus(row.status)) {
      return reply.status(409).send({ error: "session_over", message: explainReason("session_over") });
    }
    if (!(row.capabilitiesRequested ?? []).includes(capability)) {
      // Answering something nobody asked for can only come from a forged body.
      return reply.status(409).send({ error: "not_requested", message: "Nothing was asked for." });
    }

    const requesterActor = await actorFactsForUserId(row.requestedByUserId);
    const granted = allow
      ? resolveCapabilityGrant({
          requested: row.capabilitiesRequested ?? [],
          customerAllowed: [...(row.capabilitiesGranted ?? []), capability],
          actorMayControl: requesterActor.canControl,
        })
      : (row.capabilitiesGranted ?? []).filter((c) => c !== capability);

    await db.remoteSupportSession.update({
      where: { id: row.id },
      data: { capabilitiesGranted: granted },
    });

    void recordEvent({
      sessionId: row.id,
      tenantId: row.tenantId,
      actorRole: "CLIENT",
      actorUserId: user.sub,
      kind: "system",
      code: allow ? "capability_granted" : "capability_refused",
      facts: { capabilities: [capability] },
    });

    return reply.send({ ok: true, granted });
  });

  /**
   * Use a capability. Re-authorises, and records volume rather than content.
   *
   * ⛔ The body carries a COUNT, never the clipboard text or the keystrokes.
   * There is no field here that could carry them, which is the point.
   */
  app.post("/remote-support/sessions/:id/use-capability", async (req: any, reply: any) => {
    const user = getUser(req);
    const capability = String(req.body?.capability || "");
    const count = Math.max(0, Math.min(1_000_000, Number(req.body?.count) || 0));
    if (!isRemoteCapability(capability)) {
      return reply.status(400).send({ error: "unknown_capability" });
    }

    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });

    const actor = await actorFacts(user);
    const control = decideControl({ actor, session: toFacts(row), now: new Date() });
    if (!control.ok) {
      return reply.status(403).send({ error: control.reason, message: explainReason(control.reason) });
    }

    const capDecision = decideCapability({
      capability: capability as RemoteCapability,
      granted: (row.capabilitiesGranted ?? []) as RemoteCapability[],
      actorMayControl: actor.canControl,
    });
    if (!capDecision.ok) {
      return reply.status(403).send({ error: capDecision.reason, message: capDecision.detail });
    }

    const { controls, revocations } = await loadRemoteSupportControls();
    const gate = decideSupportGate({ controls, subject: gateSubject(user.sub, row), revocations });
    if (!gate.ok) return reply.status(403).send({ error: gate.reason, message: gate.detail });

    if (capability === "clipboard") {
      void recordEvent({
        sessionId: row.id,
        tenantId: row.tenantId,
        actorRole: "ADMIN",
        actorUserId: user.sub,
        kind: "system",
        code: "clipboard_shared",
        facts: { count },
      });
    }
    return reply.send({ ok: true });
  });
}

/** Local mirror of the policy's terminal set, to avoid importing a private. */
function isTerminalStatus(status: string): boolean {
  return status === "ENDED" || status === "DECLINED" || status === "EXPIRED";
}
