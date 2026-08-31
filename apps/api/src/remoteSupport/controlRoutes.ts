/**
 * The emergency surface: the kill switch, revocations, and ending sessions in
 * bulk (Phase 30).
 *
 * ⛔⛔ SUPER ADMIN ONLY, ON EVERY ROUTE, CHECKED FIRST.
 *
 * The switch that turns remote support off is not something a support person can
 * reach. Anyone who can revoke a technician can also un-revoke one; anyone who
 * can un-revoke one could quietly restore their own access after being caught.
 * That is why this file does not accept `can_remote_support` as sufficient for
 * anything, and why every handler opens with the same check rather than relying
 * on a route prefix somebody might later re-order.
 *
 * ⛔ These routes are separated from `remoteSupportRoutes.ts` so the ordinary
 * session surface and the emergency surface can never share a permission by
 * accident.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import {
  addRemoteSupportRevocation,
  endRemoteSupportSessions,
  liftRemoteSupportRevocation,
  loadRemoteSupportControls,
  setRemoteSupportEnabled,
} from "./controlStore";
import { recordEvent } from "./events";

type JwtUser = { sub: string; tenantId: string; email: string; role: string };

export type RemoteSupportControlDeps = {
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
 * ⛔ The one gate, used by every handler in this file.
 *
 * Reads the JWT role rather than a permission key, deliberately: a permission
 * key can be granted through a custom role by anyone who can edit roles, and the
 * emergency controls must not be reachable that way.
 */
function requireSuperAdmin(req: any, reply: any): JwtUser | null {
  const user = getUser(req);
  if (String(user?.role || "").toUpperCase() !== "SUPER_ADMIN") {
    reply.status(403).send({
      error: "super_admin_only",
      message: "Only a Loopcom administrator can change the remote support controls.",
    });
    return null;
  }
  return user;
}

const setEnabledBody = z.object({
  enabled: z.boolean(),
  reason: z.string().max(300).optional(),
});

const revokeBody = z.object({
  scope: z.enum(["TECHNICIAN", "DEVICE", "TENANT"]),
  subjectId: z.string().min(1).max(200),
  reason: z.string().max(300).optional(),
});

/** The tenant an admin action is filed under when it is not about one customer. */
function auditTenant(user: JwtUser): string {
  return user.tenantId;
}

export async function registerRemoteSupportControlRoutes(
  app: FastifyInstance,
  deps: RemoteSupportControlDeps,
) {
  /** What is the state of the world right now. */
  app.get("/admin/remote-support/controls", async (req: any, reply: any) => {
    const user = requireSuperAdmin(req, reply);
    if (!user) return;

    const { controls } = await loadRemoteSupportControls();
    const [revocations, live] = await Promise.all([
      db.remoteSupportRevocation.findMany({
        where: { liftedAt: null },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      db.remoteSupportSession.findMany({
        where: { status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ]);

    // Names, resolved in one query rather than per row.
    const ids = Array.from(
      new Set(live.flatMap((s) => [s.targetUserId, s.requestedByUserId]).filter(Boolean)),
    );
    const users = ids.length
      ? await db.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      : [];
    const nameOf = (id: string) => {
      const u = users.find((x) => x.id === id);
      if (!u) return null;
      return [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email;
    };

    return reply.send({
      controls,
      revocations: revocations.map((r) => ({
        id: r.id,
        scope: r.scope,
        subjectId: r.subjectId,
        reason: r.reason,
        createdAt: r.createdAt,
        createdByUserId: r.createdByUserId,
      })),
      liveSessions: live.map((s) => ({
        id: s.id,
        tenantId: s.tenantId,
        status: s.status,
        controlGranted: s.controlGranted,
        capabilitiesGranted: s.capabilitiesGranted ?? [],
        startedAt: s.startedAt,
        requestedByUserId: s.requestedByUserId,
        requestedByName: nameOf(s.requestedByUserId),
        targetUserId: s.targetUserId,
        targetUserName: nameOf(s.targetUserId),
        deviceLabel: s.deviceLabel,
      })),
    });
  });

  /**
   * Throw or lift the global switch.
   *
   * ⛔⛔ TURNING IT OFF ALSO ENDS EVERY LIVE SESSION, IN THE SAME REQUEST. A kill
   * switch that only refuses new sessions has closed the door behind whoever is
   * already inside — which is the opposite of what the person pressing it
   * believes they just did.
   */
  app.post("/admin/remote-support/controls", async (req: any, reply: any) => {
    const user = requireSuperAdmin(req, reply);
    if (!user) return;

    const parsed = setEnabledBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", message: "Say whether to switch it on or off." });
    }

    const state = await setRemoteSupportEnabled({
      enabled: parsed.data.enabled,
      reason: parsed.data.reason ?? null,
      byUserId: user.sub,
    });

    let endedCount = 0;
    if (!parsed.data.enabled) {
      // Record the events BEFORE ending, so each transcript carries the reason
      // its session stopped rather than simply going quiet.
      const live = await db.remoteSupportSession.findMany({
        where: { status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
        select: { id: true, tenantId: true },
        take: 500,
      });
      for (const s of live) {
        void recordEvent({
          sessionId: s.id,
          tenantId: s.tenantId,
          actorRole: "SYSTEM",
          kind: "system",
          code: "killed",
        });
      }
      endedCount = await endRemoteSupportSessions({
        reason: "remote_support_disabled",
        endedBy: "kill_switch",
      });
    }

    await deps.audit({
      tenantId: auditTenant(user),
      action: parsed.data.enabled ? "REMOTE_SUPPORT_ENABLED" : "REMOTE_SUPPORT_DISABLED",
      entityType: "RemoteSupportControl",
      entityId: "global",
      actorUserId: user.sub,
      metadata: { reason: parsed.data.reason ?? null, sessionsEnded: endedCount },
    });

    return reply.send({ ok: true, controls: state, sessionsEnded: endedCount });
  });

  /**
   * Revoke a technician, a machine, or a whole customer.
   *
   * ⛔ Adding the revocation and ending their live sessions happen together. A
   * revocation that leaves the current session running is a revocation that has
   * not taken effect yet, and "yet" is not a word that belongs in an incident.
   */
  app.post("/admin/remote-support/revocations", async (req: any, reply: any) => {
    const user = requireSuperAdmin(req, reply);
    if (!user) return;

    const parsed = revokeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", message: "Say what to revoke." });
    }
    const { scope, subjectId, reason } = parsed.data;

    const row = await addRemoteSupportRevocation({ scope, subjectId, reason, byUserId: user.sub });

    const where =
      scope === "TECHNICIAN"
        ? { requestedByUserId: subjectId }
        : scope === "DEVICE"
          ? { deviceId: subjectId }
          : { tenantId: subjectId };

    const affected = await db.remoteSupportSession.findMany({
      where: { status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] }, ...where },
      select: { id: true, tenantId: true },
      take: 500,
    });
    for (const s of affected) {
      void recordEvent({
        sessionId: s.id,
        tenantId: s.tenantId,
        actorRole: "SYSTEM",
        kind: "system",
        code: "revoked",
      });
    }
    const endedCount = await endRemoteSupportSessions({
      reason: `revoked_${scope.toLowerCase()}`,
      endedBy: "revocation",
      where,
    });

    await deps.audit({
      tenantId: scope === "TENANT" ? subjectId : auditTenant(user),
      action: "REMOTE_SUPPORT_REVOKED",
      entityType: "RemoteSupportRevocation",
      entityId: row.id,
      actorUserId: user.sub,
      targetUserId: scope === "TECHNICIAN" ? subjectId : null,
      metadata: { scope, subjectId, reason: reason ?? null, sessionsEnded: endedCount },
    });

    return reply.send({ ok: true, revocation: { id: row.id, scope, subjectId }, sessionsEnded: endedCount });
  });

  /** Lift a revocation. Soft, so the record of who was blocked survives. */
  app.delete("/admin/remote-support/revocations/:id", async (req: any, reply: any) => {
    const user = requireSuperAdmin(req, reply);
    if (!user) return;

    const id = String(req.params.id || "");
    const lifted = await liftRemoteSupportRevocation({ id, byUserId: user.sub });
    if (!lifted) {
      return reply.status(404).send({ error: "not_found", message: "That block is not in place." });
    }

    await deps.audit({
      tenantId: auditTenant(user),
      action: "REMOTE_SUPPORT_REVOCATION_LIFTED",
      entityType: "RemoteSupportRevocation",
      entityId: id,
      actorUserId: user.sub,
    });

    return reply.send({ ok: true });
  });

  /**
   * End one session, or all of them.
   *
   * ⛔ Stopping is always safe to allow, so this needs no reason and refuses
   * nothing beyond the role check. The asymmetry is deliberate: starting a
   * session is heavily gated, ending one is not.
   */
  app.post("/admin/remote-support/terminate", async (req: any, reply: any) => {
    const user = requireSuperAdmin(req, reply);
    if (!user) return;

    const sessionId = req.body?.sessionId ? String(req.body.sessionId) : null;
    const all = req.body?.all === true;
    if (!sessionId && !all) {
      return reply.status(400).send({ error: "invalid_request", message: "Say which session, or all of them." });
    }

    const targets = await db.remoteSupportSession.findMany({
      where: {
        status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] },
        ...(sessionId ? { id: sessionId } : {}),
      },
      select: { id: true, tenantId: true },
      take: 500,
    });
    for (const s of targets) {
      void recordEvent({
        sessionId: s.id,
        tenantId: s.tenantId,
        actorRole: "SYSTEM",
        kind: "system",
        code: "ended",
        facts: { detail: "closed by a Loopcom administrator" },
      });
    }

    const endedCount = await endRemoteSupportSessions({
      reason: "terminated_by_admin",
      endedBy: "admin_terminate",
      where: sessionId ? { id: sessionId } : undefined,
    });

    await deps.audit({
      tenantId: auditTenant(user),
      action: "REMOTE_SUPPORT_TERMINATED",
      entityType: "RemoteSupportSession",
      entityId: sessionId || "all",
      actorUserId: user.sub,
      metadata: { sessionsEnded: endedCount, all },
    });

    return reply.send({ ok: true, sessionsEnded: endedCount });
  });
}
