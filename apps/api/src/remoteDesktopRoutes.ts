/**
 * Remote Desktop routes — a customer's own computers, and computers whose owner
 * issued a Connect ID password.
 *
 * ⛔ WHAT DOES **NOT** GO THROUGH HERE, exactly as for remote support: the
 * screen, the sound, the microphone, every mouse and key event — and, new here,
 * THE USERNAME AND PASSWORD OF THE REMOTE COMPUTER. All of that rides the peer
 * connection. This API carries the request, the machine's answer, the handful
 * of signalling messages, and the VERDICT of a login ("accepted" / "3 tries
 * left" / "locked"), never the credentials themselves.
 *
 * Every decision lives in `remoteDesktop/policy.ts`, tested without a database.
 * These handlers load facts, ask the policy, and write the result.
 *
 * ⛔ THE MACHINE IS IDENTIFIED BY ITS KEY (`x-machine-key`), NEVER BY ITS USER.
 * On your own computer both ends of a session are signed in as the same person,
 * so "who is calling" cannot be read off the JWT. A call carrying the key that
 * hashes to the session's machine is the machine; a call without one from the
 * person who asked is the viewer.
 *
 * ⛔ The kill switch, revocations, the transcript, the signal table and the media
 * budget are the SUPPORT engine's, reused unchanged. The rows live in
 * RemoteSupportSession with kind = "desktop", so `POST /admin/remote-support/
 * controls {enabled:false}` ends these sessions too. There is deliberately no
 * second switch.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { userHasActionPermission } from "./permissionGates";
import {
  DESKTOP_REQUEST_TTL_MS,
  LOGIN_MAX_FAILURES,
  OWN_MACHINE_ALLOWS,
  decideConnectById,
  decideDesktopControl,
  decideDesktopParticipation,
  decideMachineRegister,
  decideManageMachine,
  decideOwnConnect,
  decideShareCreate,
  desktopLapseReason,
  explainDesktopReason,
  formatConnectId,
  hashMachineKey,
  hashSharePassword,
  isDesktopCapability,
  isPlausibleDeviceId,
  isPlausibleMachineKey,
  isShareExpiry,
  isShareScope,
  machineOnline,
  mintConnectId,
  mintSharePassword,
  nextShareFailure,
  normalizeConnectId,
  resolveDesktopGrant,
  shareAllows,
  shareExpiryFor,
  shareIsLive,
  type ActorFacts,
  type DesktopSessionFacts,
  type MachineFacts,
  type ShareFacts,
} from "./remoteDesktop/policy";
import { SIGNAL_TTL_MS } from "./remoteSupport/policy";
import {
  checkSignalPayload,
  decideMediaBudget,
  decideRequestRate,
  decideSupportGate,
  REQUEST_WINDOW_MS,
} from "./remoteSupport/controls";
import { loadRemoteSupportControls } from "./remoteSupport/controlStore";
import { recordEvent } from "./remoteSupport/events";

type JwtUser = { sub: string; tenantId: string; email: string; role: string };

export type RemoteDesktopDeps = {
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

/** The header the machine proves itself with. Absent = the viewer side. */
export const MACHINE_KEY_HEADER = "x-machine-key";

function presentedKey(req: any): string | null {
  const raw = req.headers?.[MACHINE_KEY_HEADER];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return isPlausibleMachineKey(v) ? v : null;
}

/**
 * Connecting by ID is Loopcom-app-to-Loopcom-app only (Izzy, 2026-09-02). The
 * Windows shell brands its user agent `Loopcom/<version>`; a browser tab does
 * not. ⛔ A product rule, not a security boundary — the security boundaries are
 * the password, the scope and the lockout, all checked regardless.
 */
export function isDesktopAppRequest(userAgent: unknown): boolean {
  return /\bLoopcom\/\d/.test(String(userAgent || ""));
}

async function actorFacts(user: JwtUser, req: any): Promise<ActorFacts> {
  const [canUseRemoteDesktop, canConnectById, canShareOwnComputer] = await Promise.all([
    userHasActionPermission(user, "can_use_remote_desktop"),
    userHasActionPermission(user, "can_connect_by_id"),
    userHasActionPermission(user, "can_share_own_computer"),
  ]);
  return {
    userId: user.sub,
    tenantId: user.tenantId,
    isSuperAdmin: String(user.role) === "SUPER_ADMIN",
    canUseRemoteDesktop,
    canConnectById,
    canShareOwnComputer,
    fromDesktopApp: isDesktopAppRequest(req.headers?.["user-agent"]),
  };
}

function machineFacts(row: any): MachineFacts {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerUserId: row.ownerUserId,
    deviceId: row.deviceId,
    machineKeyHash: row.machineKeyHash,
    unattendedEnabled: row.unattendedEnabled,
    hasAccessLogin: row.hasAccessLogin,
    locked: row.locked,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
    shareFailCount: row.shareFailCount ?? 0,
    shareLockedUntil: row.shareLockedUntil ?? null,
  };
}

function sessionFacts(row: any): DesktopSessionFacts {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind ?? "support",
    status: row.status,
    machineId: row.machineId ?? null,
    requestedByUserId: row.requestedByUserId,
    targetUserId: row.targetUserId,
    clientAuthenticated: row.clientAuthenticated === true,
    capabilitiesGranted: row.capabilitiesGranted ?? [],
    expiresAt: row.expiresAt,
    startedAt: row.startedAt,
    lastSeenAdminAt: row.lastSeenAdminAt,
    lastSeenClientAt: row.lastSeenClientAt,
  };
}

function shareFacts(row: any): ShareFacts {
  return {
    id: row.id,
    machineId: row.machineId,
    tenantId: row.tenantId,
    passwordHash: row.passwordHash,
    scope: row.scope,
    oneTime: row.oneTime,
    expiresAt: row.expiresAt,
    usedCount: row.usedCount ?? 0,
    revokedAt: row.revokedAt,
    allowControl: row.allowControl,
    allowSound: row.allowSound,
    allowMic: row.allowMic,
    allowClipboard: row.allowClipboard,
  };
}

/** What the screens render about a computer. ⛔ Never the key hash, never a lockout counter. */
function machineView(row: any, now: Date, extra: { activeShares?: number; standingShares?: number } = {}) {
  return {
    id: row.id,
    name: row.name,
    connectId: row.connectId,
    connectIdDisplay: formatConnectId(row.connectId),
    deviceId: row.deviceId,
    osLabel: row.osLabel ?? null,
    monitors: row.monitors ?? 1,
    appVersion: row.appVersion ?? null,
    unattendedEnabled: row.unattendedEnabled === true,
    hasAccessLogin: row.hasAccessLogin === true,
    locked: row.locked === true,
    online: machineOnline(row, now),
    lastSeenAt: row.lastSeenAt,
    activeShares: extra.activeShares ?? 0,
    standingShares: extra.standingShares ?? 0,
    createdAt: row.createdAt,
  };
}

/** The session shape both sides poll. ⛔ No secrets live on the row, so nothing to omit. */
function sessionView(row: any, names: { requester?: string | null; machine?: string | null; owner?: string | null } = {}) {
  return {
    id: row.id,
    kind: row.kind ?? "support",
    status: row.status,
    machineId: row.machineId ?? null,
    machineName: names.machine ?? row.deviceLabel ?? null,
    shareId: row.shareId ?? null,
    /** Own-computer sessions must log in over the peer connection; share sessions are already authenticated. */
    authRequired: !row.shareId,
    clientAuthenticated: row.clientAuthenticated === true,
    capabilitiesGranted: row.capabilitiesGranted ?? [],
    requestedByUserId: row.requestedByUserId,
    requestedByName: names.requester ?? null,
    targetUserId: row.targetUserId,
    ownerName: names.owner ?? null,
    /** Where the connecting person was sitting, as their app described it. */
    viewerLabel: row.requestReason ?? null,
    clientOnCall: row.clientOnCall === true,
    expiresAt: row.expiresAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endedReason: row.endedReason,
    endedBy: row.endedBy,
    inputEventCount: row.inputEventCount ?? 0,
    createdAt: row.createdAt,
  };
}

async function nameOf(userId: string): Promise<string | null> {
  try {
    const u = await db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, email: true } });
    if (!u) return null;
    return [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email;
  } catch {
    return null;
  }
}

async function loadMachine(id: string | null | undefined) {
  if (!id) return null;
  return db.remoteDesktopMachine.findUnique({ where: { id } });
}

async function loadSession(id: string) {
  return db.remoteSupportSession.findUnique({ where: { id } });
}

/** The subject every kill-switch / revocation check needs: the MACHINE's tenant and device, the viewer as actor. */
function gateSubject(session: any, machine: any) {
  return {
    actorUserId: session.requestedByUserId,
    tenantId: machine?.tenantId ?? session.tenantId,
    deviceId: machine?.deviceId ?? session.deviceId ?? null,
  };
}

/**
 * Close desktop sessions that have run out of road. Same lazy-from-the-polling-
 * routes shape as the support sweep, for the same reason: a session must be
 * able to die even if the process that started it restarted.
 */
export async function sweepLapsedRemoteDesktopSessions(now = new Date()): Promise<number> {
  const open = await db.remoteSupportSession.findMany({
    where: { kind: "desktop", status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
  });
  let closed = 0;
  for (const row of open) {
    const reason = desktopLapseReason(sessionFacts(row), now);
    if (!reason) continue;
    const status = reason === "machine_did_not_answer" ? "EXPIRED" : "ENDED";
    const res = await db.remoteSupportSession.updateMany({
      where: { id: row.id, status: row.status },
      data: { status, endedAt: now, endedReason: reason, endedBy: "watchdog" },
    });
    closed += res.count;
  }
  return closed;
}

async function purgeOldSignals(now = new Date()): Promise<void> {
  await db.remoteSupportSignal.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - SIGNAL_TTL_MS) } } });
}

/** A unique Connect ID. Collisions on nine digits are rare; the loop makes them impossible. */
async function mintUniqueConnectId(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = mintConnectId();
    const clash = await db.remoteDesktopMachine.findUnique({ where: { connectId: candidate }, select: { id: true } });
    if (!clash) return candidate;
  }
  throw new Error("could not mint a unique Connect ID");
}

const registerBody = z.object({
  deviceId: z.string().min(8).max(120),
  name: z.string().min(1).max(80),
  osLabel: z.string().max(120).optional(),
  monitors: z.number().int().min(1).max(16).optional(),
  appVersion: z.string().max(40).optional(),
  unattendedEnabled: z.boolean(),
  hasAccessLogin: z.boolean(),
  locked: z.boolean().optional(),
});

const pollBody = z.object({
  deviceId: z.string().min(8).max(120),
  unattendedEnabled: z.boolean().optional(),
  hasAccessLogin: z.boolean().optional(),
  locked: z.boolean().optional(),
  monitors: z.number().int().min(1).max(16).optional(),
});

const connectBody = z.object({
  capabilities: z.array(z.string().max(32)).max(8).optional().default(["control", "sound", "mic", "clipboard"]),
  /** How the connecting side describes where it is sitting: "Office PC", "a browser". */
  fromLabel: z.string().max(120).optional(),
});

const connectByIdBody = connectBody.extend({
  connectId: z.string().min(9).max(20),
  password: z.string().min(1).max(200),
});

const shareBody = z.object({
  expiry: z.string(),
  scope: z.string(),
  allowControl: z.boolean().optional().default(true),
  allowSound: z.boolean().optional().default(true),
  allowMic: z.boolean().optional().default(false),
  allowClipboard: z.boolean().optional().default(false),
});

const signalBody = z.object({ kind: z.enum(["offer", "answer", "ice"]), payload: z.any() });

const loginResultBody = z.object({
  ok: z.boolean(),
  attemptsLeft: z.number().int().min(0).max(10).optional(),
  locked: z.boolean().optional(),
});

const audioBody = z.object({ sound: z.boolean(), mic: z.boolean() });

const MAX_LIVE_SHARES = 10;

export async function registerRemoteDesktopRoutes(app: FastifyInstance, deps: RemoteDesktopDeps) {
  /* ────────────────────────── the viewer's page ────────────────────── */

  /** What may this person do here? Drives which cards the page draws. */
  app.get("/remote-desktop/me", async (req: any, reply: any) => {
    const actor = await actorFacts(getUser(req), req);
    return reply.send({
      canUseRemoteDesktop: actor.canUseRemoteDesktop,
      canConnectById: actor.canConnectById,
      canShareOwnComputer: actor.canShareOwnComputer,
      fromDesktopApp: actor.fromDesktopApp,
    });
  });

  /** My computers. Only mine — ownership is the whole rule. */
  app.get("/remote-desktop/machines", async (req: any, reply: any) => {
    const user = getUser(req);
    const actor = await actorFacts(user, req);
    if (!actor.canUseRemoteDesktop) {
      return reply.status(403).send({ error: "missing_permission", message: explainDesktopReason("missing_permission") });
    }
    const now = new Date();
    const rows = await db.remoteDesktopMachine.findMany({
      where: { ownerUserId: user.sub, revokedAt: null },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    const shares = rows.length
      ? await db.remoteDesktopShare.findMany({
          where: { machineId: { in: rows.map((m) => m.id) }, revokedAt: null },
          select: { machineId: true, oneTime: true, expiresAt: true, usedCount: true },
        })
      : [];
    const out = rows.map((m) => {
      const live = shares.filter((s) => s.machineId === m.id && shareIsLive({ ...s, id: "", machineId: m.id, tenantId: "", passwordHash: "", scope: "", revokedAt: null, allowControl: true, allowSound: true, allowMic: false, allowClipboard: false }, now));
      return machineView(m, now, {
        activeShares: live.length,
        standingShares: live.filter((s) => !s.expiresAt && !s.oneTime).length,
      });
    });
    return reply.send({ machines: out });
  });

  /** Rename. */
  app.patch("/remote-desktop/machines/:id", async (req: any, reply: any) => {
    const user = getUser(req);
    const machine = await loadMachine(String(req.params.id));
    if (!machine) return reply.status(404).send({ error: "not_found" });
    const actor = await actorFacts(user, req);
    const decision = decideManageMachine({ actor, machine: machineFacts(machine) });
    if (!decision.ok) return reply.status(404).send({ error: "not_found" }); // yours or nothing — no oracle
    const name = String(req.body?.name || "").trim().slice(0, 80);
    if (!name) return reply.status(400).send({ error: "invalid_request", message: "Give the computer a name." });
    const updated = await db.remoteDesktopMachine.update({ where: { id: machine.id }, data: { name } });
    return reply.send({ ok: true, machine: machineView(updated, new Date()) });
  });

  /** Remove this computer: it stops being reachable, its passwords die, its live session ends. */
  app.delete("/remote-desktop/machines/:id", async (req: any, reply: any) => {
    const user = getUser(req);
    const machine = await loadMachine(String(req.params.id));
    if (!machine) return reply.status(404).send({ error: "not_found" });
    const actor = await actorFacts(user, req);
    const decision = decideManageMachine({ actor, machine: machineFacts(machine) });
    if (!decision.ok) return reply.status(404).send({ error: "not_found" });
    const now = new Date();
    await db.remoteDesktopMachine.update({ where: { id: machine.id }, data: { revokedAt: now, unattendedEnabled: false } });
    await db.remoteDesktopShare.updateMany({ where: { machineId: machine.id, revokedAt: null }, data: { revokedAt: now, revokedByUserId: user.sub } });
    await db.remoteSupportSession.updateMany({
      where: { machineId: machine.id, status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
      data: { status: "ENDED", endedAt: now, endedReason: "machine_removed", endedBy: "owner" },
    });
    await deps.audit({
      tenantId: machine.tenantId, action: "REMOTE_DESKTOP_MACHINE_REMOVED", entityType: "RemoteDesktopMachine",
      entityId: machine.id, actorUserId: user.sub, metadata: { name: machine.name },
    });
    return reply.send({ ok: true });
  });

  /**
   * Connect to one of MY computers.
   *
   * The session is created REQUESTED; the machine sees it on its next poll,
   * accepts, and the two sides negotiate. ⛔ Nothing is shared at accept time:
   * the machine sends its screen only after the username and password typed on
   * this side were verified THERE. `clientAuthenticated` records that verdict.
   */
  app.post("/remote-desktop/machines/:id/connect", async (req: any, reply: any) => {
    const user = getUser(req);
    const machine = await loadMachine(String(req.params.id));
    if (!machine) return reply.status(404).send({ error: "not_found" });

    const parsed = connectBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

    const actor = await actorFacts(user, req);
    const now = new Date();
    const decision = decideOwnConnect({ actor, machine: machineFacts(machine), now });
    if (!decision.ok) {
      // A computer that is not yours reads like one that does not exist.
      if (decision.reason === "not_your_computer" || decision.reason === "machine_removed") return reply.status(404).send({ error: "not_found" });
      const status = decision.reason === "missing_permission" ? 403 : 409;
      return reply.status(status).send({ error: decision.reason, message: explainDesktopReason(decision.reason) });
    }

    const { controls, revocations } = await loadRemoteSupportControls();
    const gate = decideSupportGate({ controls, subject: { actorUserId: user.sub, tenantId: machine.tenantId, deviceId: machine.deviceId }, revocations });
    if (!gate.ok) return reply.status(403).send({ error: gate.reason, message: gate.detail });

    const rate = await requestRate(user.sub, machine.ownerUserId, now);
    if (!rate.ok) {
      reply.header("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
      return reply.status(429).send({ error: rate.reason, message: rate.detail });
    }

    // One live session per machine: a second connect closes the first rather than
    // letting two viewers fight over one mouse.
    await db.remoteSupportSession.updateMany({
      where: { machineId: machine.id, status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
      data: { status: "ENDED", endedAt: now, endedReason: "superseded", endedBy: "viewer" },
    });

    const granted = resolveDesktopGrant({ requested: parsed.data.capabilities, allowed: OWN_MACHINE_ALLOWS });
    const fromLabel = (parsed.data.fromLabel || "").trim().slice(0, 120) || "another computer";
    const session = await db.remoteSupportSession.create({
      data: {
        tenantId: machine.tenantId,
        kind: "desktop",
        machineId: machine.id,
        shareId: null,
        targetUserId: machine.ownerUserId,
        requestedByUserId: user.sub,
        requestReason: fromLabel,
        controlRequested: granted.includes("control"),
        controlGranted: granted.includes("control"),
        capabilitiesRequested: parsed.data.capabilities.filter(isDesktopCapability),
        capabilitiesGranted: granted,
        clientAuthenticated: false,
        deviceId: machine.deviceId,
        deviceLabel: machine.name,
        status: "REQUESTED",
        expiresAt: new Date(now.getTime() + DESKTOP_REQUEST_TTL_MS),
      },
    });

    void recordEvent({
      sessionId: session.id, tenantId: machine.tenantId, actorRole: "ADMIN", actorUserId: user.sub,
      kind: "system", code: "desktop_connected", facts: { actorName: await nameOf(user.sub), detail: fromLabel },
      meta: { capabilities: granted, machineId: machine.id, own: true },
    });
    await deps.audit({
      tenantId: machine.tenantId, action: "REMOTE_DESKTOP_CONNECT", entityType: "RemoteSupportSession",
      entityId: session.id, actorUserId: user.sub, targetUserId: machine.ownerUserId,
      metadata: { machineId: machine.id, machineName: machine.name, capabilities: granted, own: true },
    });
    return reply.send({ ok: true, session: sessionView(session, { machine: machine.name, requester: await nameOf(user.sub) }) });
  });

  /**
   * Connect to someone ELSE's computer with a Connect ID and password.
   *
   * ⛔ Every mismatch answers the same `invalid_id_or_password`. See the policy
   * for why. A wrong password counts against the MACHINE, and five of them lock
   * that Connect ID for fifteen minutes whichever password is live.
   */
  app.post("/remote-desktop/connect-by-id", async (req: any, reply: any) => {
    const user = getUser(req);
    const parsed = connectByIdBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", message: "Enter the Connect ID and the password." });

    const actor = await actorFacts(user, req);
    const now = new Date();
    const connectId = normalizeConnectId(parsed.data.connectId);
    const machine = connectId ? await db.remoteDesktopMachine.findUnique({ where: { connectId } }) : null;

    let matched: any = null;
    // A password that WAS right but is spent (one-time already used, expired,
    // revoked) still answers `invalid_id_or_password` — but it is not a GUESS,
    // and must not count toward the lockout. Proven by the stress suite: fifty
    // people holding the same one-time password locked the machine for
    // everybody within one race, because the 49 losers were counted as guessers.
    let hashMatchedAny = false;
    if (machine && !machine.revokedAt) {
      const shares = await db.remoteDesktopShare.findMany({ where: { machineId: machine.id } });
      for (const s of shares) {
        if (s.passwordHash !== hashSharePassword(s.id, parsed.data.password)) continue;
        hashMatchedAny = true;
        if (!s.revokedAt && shareIsLive(shareFacts(s), now)) {
          matched = s;
          break;
        }
      }
    }

    const decision = decideConnectById({ actor, machine: machine ? machineFacts(machine) : null, matchedShare: matched ? shareFacts(matched) : null, now });
    if (!decision.ok) {
      // A wrong guess against a REAL machine is counted. A guess at an id that is
      // nobody's computer counts against nothing — there is nothing to protect.
      if (decision.reason === "invalid_id_or_password" && machine && !machine.revokedAt && !hashMatchedAny) {
        await db.remoteDesktopMachine.update({ where: { id: machine.id }, data: nextShareFailure(machineFacts(machine), now) });
      }
      const status =
        decision.reason === "missing_connect_permission" ? 403
        : decision.reason === "desktop_app_required" ? 403
        : decision.reason === "locked_out" ? 429
        : decision.reason === "invalid_id_or_password" ? 401
        : 409;
      return reply.status(status).send({ error: decision.reason, message: explainDesktopReason(decision.reason) });
    }

    const { controls, revocations } = await loadRemoteSupportControls();
    const gate = decideSupportGate({ controls, subject: { actorUserId: user.sub, tenantId: machine!.tenantId, deviceId: machine!.deviceId }, revocations });
    if (!gate.ok) return reply.status(403).send({ error: gate.reason, message: gate.detail });

    const rate = await requestRate(user.sub, machine!.ownerUserId, now);
    if (!rate.ok) {
      reply.header("retry-after", String(Math.ceil(rate.retryAfterMs / 1000)));
      return reply.status(429).send({ error: rate.reason, message: rate.detail });
    }

    // The password worked: the guessing counter starts over.
    if (machine!.shareFailCount > 0) {
      await db.remoteDesktopMachine.update({ where: { id: machine!.id }, data: { shareFailCount: 0, shareLockedUntil: null } });
    }

    await db.remoteSupportSession.updateMany({
      where: { machineId: machine!.id, status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
      data: { status: "ENDED", endedAt: now, endedReason: "superseded", endedBy: "viewer" },
    });

    const granted = resolveDesktopGrant({ requested: parsed.data.capabilities, allowed: shareAllows(shareFacts(matched)) });
    const fromLabel = (parsed.data.fromLabel || "").trim().slice(0, 120) || "another computer";
    const session = await db.remoteSupportSession.create({
      data: {
        tenantId: machine!.tenantId,
        kind: "desktop",
        machineId: machine!.id,
        shareId: matched.id,
        targetUserId: machine!.ownerUserId,
        requestedByUserId: user.sub,
        requestReason: fromLabel,
        controlRequested: granted.includes("control"),
        controlGranted: granted.includes("control"),
        capabilitiesRequested: parsed.data.capabilities.filter(isDesktopCapability),
        capabilitiesGranted: granted,
        // ⛔ The password IS the consent: the owner issued it for exactly this.
        clientAuthenticated: true,
        deviceId: machine!.deviceId,
        deviceLabel: machine!.name,
        status: "REQUESTED",
        expiresAt: new Date(now.getTime() + DESKTOP_REQUEST_TTL_MS),
      },
    });

    // Guarded on the value read, so two racing first uses of a one-time password
    // cannot both succeed: the loser sees usedCount already moved.
    const consumed = await db.remoteDesktopShare.updateMany({
      where: { id: matched.id, usedCount: matched.usedCount, revokedAt: null },
      data: { usedCount: { increment: 1 }, lastUsedAt: now, lastUsedById: user.sub },
    });
    if (consumed.count === 0 && matched.oneTime) {
      await db.remoteSupportSession.updateMany({
        where: { id: session.id },
        data: { status: "ENDED", endedAt: now, endedReason: "password_already_used", endedBy: "system" },
      });
      return reply.status(401).send({ error: "invalid_id_or_password", message: explainDesktopReason("invalid_id_or_password") });
    }

    const requesterName = await nameOf(user.sub);
    void recordEvent({
      sessionId: session.id, tenantId: machine!.tenantId, actorRole: "ADMIN", actorUserId: user.sub,
      kind: "system", code: "share_used", facts: { actorName: requesterName },
      meta: { capabilities: granted, machineId: machine!.id, shareId: matched.id, scope: matched.scope },
    });
    await deps.audit({
      tenantId: machine!.tenantId, action: "REMOTE_DESKTOP_CONNECT_BY_ID", entityType: "RemoteSupportSession",
      entityId: session.id, actorUserId: user.sub, targetUserId: machine!.ownerUserId,
      metadata: { machineId: machine!.id, machineName: machine!.name, shareId: matched.id, capabilities: granted, actorTenantId: user.tenantId },
    });
    return reply.send({ ok: true, session: sessionView(session, { machine: machine!.name, requester: requesterName }) });
  });

  /* ─────────────────────────── shares ───────────────────────────────── */

  app.get("/remote-desktop/machines/:id/shares", async (req: any, reply: any) => {
    const user = getUser(req);
    const machine = await loadMachine(String(req.params.id));
    if (!machine) return reply.status(404).send({ error: "not_found" });
    const actor = await actorFacts(user, req);
    if (!decideManageMachine({ actor, machine: machineFacts(machine) }).ok) return reply.status(404).send({ error: "not_found" });
    const now = new Date();
    const rows = await db.remoteDesktopShare.findMany({ where: { machineId: machine.id, revokedAt: null }, orderBy: { createdAt: "desc" }, take: 50 });
    return reply.send({ shares: rows.filter((s) => shareIsLive(shareFacts(s), now)).map(shareView) });
  });

  /**
   * Issue a password for this computer. ⛔ The clear password is in THIS
   * response and nowhere else, ever. The row keeps a hash.
   */
  app.post("/remote-desktop/machines/:id/shares", async (req: any, reply: any) => {
    const user = getUser(req);
    const machine = await loadMachine(String(req.params.id));
    if (!machine) return reply.status(404).send({ error: "not_found" });

    const parsed = shareBody.safeParse(req.body ?? {});
    if (!parsed.success || !isShareExpiry(parsed.data.expiry) || !isShareScope(parsed.data.scope)) {
      return reply.status(400).send({ error: "invalid_request", message: "Choose how long the password works and who may use it." });
    }
    const actor = await actorFacts(user, req);
    const decision = decideShareCreate({ actor, machine: machineFacts(machine) });
    if (!decision.ok) {
      if (decision.reason === "not_your_computer" || decision.reason === "machine_removed") return reply.status(404).send({ error: "not_found" });
      return reply.status(403).send({ error: decision.reason, message: explainDesktopReason(decision.reason) });
    }

    const now = new Date();
    const live = await db.remoteDesktopShare.findMany({ where: { machineId: machine.id, revokedAt: null } });
    if (live.filter((s) => shareIsLive(shareFacts(s), now)).length >= MAX_LIVE_SHARES) {
      return reply.status(409).send({ error: "too_many_passwords", message: "This computer already has ten live passwords. Remove one first." });
    }

    const password = mintSharePassword();
    const { oneTime, expiresAt } = shareExpiryFor(parsed.data.expiry, now);
    // Created with a placeholder hash, then hashed against its own id.
    const created = await db.remoteDesktopShare.create({
      data: {
        machineId: machine.id,
        tenantId: machine.tenantId,
        createdByUserId: user.sub,
        passwordHash: "pending",
        scope: parsed.data.scope,
        oneTime,
        expiresAt,
        allowControl: parsed.data.allowControl,
        allowSound: parsed.data.allowSound,
        allowMic: parsed.data.allowMic,
        allowClipboard: parsed.data.allowClipboard,
      },
    });
    const share = await db.remoteDesktopShare.update({ where: { id: created.id }, data: { passwordHash: hashSharePassword(created.id, password) } });

    await deps.audit({
      tenantId: machine.tenantId, action: "REMOTE_DESKTOP_SHARE_CREATED", entityType: "RemoteDesktopShare",
      entityId: share.id, actorUserId: user.sub,
      // ⛔ Never the password.
      metadata: { machineId: machine.id, scope: share.scope, oneTime, expiresAt, allowControl: share.allowControl, allowSound: share.allowSound, allowMic: share.allowMic, allowClipboard: share.allowClipboard },
    });
    return reply.send({ ok: true, share: shareView(share), password, connectId: machine.connectId, connectIdDisplay: formatConnectId(machine.connectId) });
  });

  app.post("/remote-desktop/machines/:id/shares/:shareId/revoke", async (req: any, reply: any) => {
    const user = getUser(req);
    const machine = await loadMachine(String(req.params.id));
    if (!machine) return reply.status(404).send({ error: "not_found" });
    const actor = await actorFacts(user, req);
    if (!decideManageMachine({ actor, machine: machineFacts(machine) }).ok) return reply.status(404).send({ error: "not_found" });
    const now = new Date();
    const res = await db.remoteDesktopShare.updateMany({
      where: { id: String(req.params.shareId), machineId: machine.id, revokedAt: null },
      data: { revokedAt: now, revokedByUserId: user.sub },
    });
    if (res.count === 0) return reply.status(404).send({ error: "not_found" });
    // A password that is withdrawn ends the session it opened.
    await db.remoteSupportSession.updateMany({
      where: { shareId: String(req.params.shareId), status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
      data: { status: "ENDED", endedAt: now, endedReason: "password_removed", endedBy: "owner" },
    });
    return reply.send({ ok: true });
  });

  /* ───────────────────────── the machine side ───────────────────────── */

  /**
   * The desktop app enrolls, or re-registers on every launch while the tray
   * switch is on. ⛔ Only a call carrying a plausible machine key may reach here;
   * the key is hashed with the deviceId and compared to the stored hash.
   */
  app.post("/remote-desktop/machines/register", async (req: any, reply: any) => {
    const user = getUser(req);
    const key = presentedKey(req);
    if (!key) return reply.status(400).send({ error: "machine_key_required" });
    const parsed = registerBody.safeParse(req.body ?? {});
    if (!parsed.success || !isPlausibleDeviceId(parsed.data.deviceId)) return reply.status(400).send({ error: "invalid_request" });

    const now = new Date();
    const keyHash = hashMachineKey(parsed.data.deviceId, key);
    const existing = await db.remoteDesktopMachine.findUnique({ where: { deviceId: parsed.data.deviceId } });
    const decision = decideMachineRegister({ existing: existing ? { machineKeyHash: existing.machineKeyHash, revokedAt: existing.revokedAt } : null, presentedKeyHash: keyHash });
    if (!decision.ok) {
      return reply.status(decision.reason === "machine_removed" ? 410 : 403).send({ error: decision.reason, message: explainDesktopReason(decision.reason) });
    }

    const common = {
      tenantId: user.tenantId,
      ownerUserId: user.sub,
      name: parsed.data.name.trim().slice(0, 80),
      osLabel: parsed.data.osLabel?.slice(0, 120) ?? null,
      monitors: parsed.data.monitors ?? 1,
      appVersion: parsed.data.appVersion?.slice(0, 40) ?? null,
      unattendedEnabled: parsed.data.unattendedEnabled,
      hasAccessLogin: parsed.data.hasAccessLogin,
      locked: parsed.data.locked === true,
      lastSeenAt: now,
    };

    let row;
    if (existing) {
      const ownerChanged = existing.ownerUserId !== user.sub;
      row = await db.remoteDesktopMachine.update({ where: { id: existing.id }, data: common });
      if (ownerChanged) {
        // A different person signed in on the same install: the computer is
        // theirs now, and every password the previous owner issued dies with the
        // hand-over — a password is a promise made by a person, not a machine.
        await db.remoteDesktopShare.updateMany({ where: { machineId: existing.id, revokedAt: null }, data: { revokedAt: now, revokedByUserId: user.sub } });
        await deps.audit({
          tenantId: user.tenantId, action: "REMOTE_DESKTOP_MACHINE_OWNER_CHANGED", entityType: "RemoteDesktopMachine",
          entityId: existing.id, actorUserId: user.sub, metadata: { previousOwnerUserId: existing.ownerUserId },
        });
      }
    } else {
      row = await db.remoteDesktopMachine.create({
        data: { ...common, deviceId: parsed.data.deviceId, connectId: await mintUniqueConnectId(), machineKeyHash: keyHash },
      });
      await deps.audit({
        tenantId: user.tenantId, action: "REMOTE_DESKTOP_MACHINE_ENROLLED", entityType: "RemoteDesktopMachine",
        entityId: row.id, actorUserId: user.sub, metadata: { name: row.name, connectId: row.connectId },
      });
    }
    return reply.send({ ok: true, machine: machineView(row, now) });
  });

  /**
   * Presence + "is anyone waiting on me?". The only polling an enrolled machine
   * does while nothing is happening, and it runs ONLY while the tray switch is on.
   */
  app.post("/remote-desktop/machines/poll", async (req: any, reply: any) => {
    const key = presentedKey(req);
    if (!key) return reply.status(400).send({ error: "machine_key_required" });
    const parsed = pollBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

    const machine = await db.remoteDesktopMachine.findUnique({ where: { deviceId: parsed.data.deviceId } });
    if (!machine || machine.machineKeyHash !== hashMachineKey(parsed.data.deviceId, key)) {
      return reply.status(403).send({ error: "machine_key_mismatch", message: explainDesktopReason("machine_key_mismatch") });
    }
    if (machine.revokedAt) return reply.status(410).send({ error: "machine_removed", message: explainDesktopReason("machine_removed") });

    const now = new Date();
    await db.remoteDesktopMachine.update({
      where: { id: machine.id },
      data: {
        lastSeenAt: now,
        ...(parsed.data.unattendedEnabled === undefined ? {} : { unattendedEnabled: parsed.data.unattendedEnabled }),
        ...(parsed.data.hasAccessLogin === undefined ? {} : { hasAccessLogin: parsed.data.hasAccessLogin }),
        ...(parsed.data.locked === undefined ? {} : { locked: parsed.data.locked }),
        ...(parsed.data.monitors === undefined ? {} : { monitors: parsed.data.monitors }),
      },
    });
    await sweepLapsedRemoteDesktopSessions(now);

    const rows = await db.remoteSupportSession.findMany({
      where: { machineId: machine.id, kind: "desktop", status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
      orderBy: { createdAt: "desc" },
      take: 3,
    });
    const sessions = [];
    for (const row of rows) sessions.push(sessionView(row, { machine: machine.name, requester: await nameOf(row.requestedByUserId) }));
    return reply.send({ ok: true, connectId: machine.connectId, connectIdDisplay: formatConnectId(machine.connectId), sessions });
  });

  /** The machine picks up. Nothing is shared yet — see the note on connect. */
  app.post("/remote-desktop/sessions/:id/accept", async (req: any, reply: any) => {
    const user = getUser(req);
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });
    const machine = await loadMachine(row.machineId);
    const now = new Date();
    const part = decideDesktopParticipation({ session: sessionFacts(row), machine: machine ? machineFacts(machine) : null, actorUserId: user.sub, presentedKeyHash: keyHashFor(req, machine), now });
    if (!part.ok) return reply.status(part.reason === "not_a_participant" ? 403 : 409).send({ error: part.reason, message: explainDesktopReason(part.reason) });
    if (part.role !== "MACHINE") return reply.status(403).send({ error: "only_machine_may_accept" });

    const { controls, revocations } = await loadRemoteSupportControls();
    const gate = decideSupportGate({ controls, subject: gateSubject(row, machine), revocations });
    if (!gate.ok) {
      await endByGate(row.id, gate.reason, now);
      return reply.status(403).send({ error: gate.reason, message: gate.detail });
    }

    const res = await db.remoteSupportSession.updateMany({
      where: { id: row.id, status: "REQUESTED" },
      data: { status: "CONSENTED", consentAt: now, startedAt: now, lastSeenClientAt: now },
    });
    if (res.count === 0) return reply.status(409).send({ error: "already_answered" });
    void recordEvent({ sessionId: row.id, tenantId: row.tenantId, actorRole: "CLIENT", kind: "system", code: "machine_accepted", facts: { screenName: machine?.name ?? null } });
    const fresh = await loadSession(row.id);
    return reply.send({ ok: true, session: sessionView(fresh, { machine: machine?.name ?? null, requester: await nameOf(row.requestedByUserId) }) });
  });

  /**
   * The machine reports what happened when the viewer typed the computer's
   * username and password. ⛔ A verdict and a count. The credentials never come
   * near this route — the machine checked them itself.
   */
  app.post("/remote-desktop/sessions/:id/login-result", async (req: any, reply: any) => {
    const user = getUser(req);
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });
    const parsed = loginResultBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const machine = await loadMachine(row.machineId);
    const now = new Date();
    const part = decideDesktopParticipation({ session: sessionFacts(row), machine: machine ? machineFacts(machine) : null, actorUserId: user.sub, presentedKeyHash: keyHashFor(req, machine), now });
    if (!part.ok) return reply.status(part.reason === "not_a_participant" ? 403 : 409).send({ error: part.reason, message: explainDesktopReason(part.reason) });
    if (part.role !== "MACHINE") return reply.status(403).send({ error: "only_machine_may_report_login" });
    if (row.shareId) return reply.status(409).send({ error: "not_a_login_session" });

    if (parsed.data.ok) {
      await db.remoteSupportSession.updateMany({ where: { id: row.id, status: { in: ["CONSENTED", "ACTIVE"] } }, data: { clientAuthenticated: true } });
      void recordEvent({ sessionId: row.id, tenantId: row.tenantId, actorRole: "CLIENT", kind: "system", code: "login_ok" });
      return reply.send({ ok: true });
    }
    if (parsed.data.locked) {
      await db.remoteSupportSession.updateMany({
        where: { id: row.id, status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
        data: { status: "ENDED", endedAt: now, endedReason: "login_locked", endedBy: "machine" },
      });
      void recordEvent({ sessionId: row.id, tenantId: row.tenantId, actorRole: "CLIENT", kind: "system", code: "login_locked" });
      await deps.audit({
        tenantId: row.tenantId, action: "REMOTE_DESKTOP_LOGIN_LOCKED", entityType: "RemoteSupportSession",
        entityId: row.id, actorUserId: row.requestedByUserId, targetUserId: row.targetUserId, metadata: { machineId: row.machineId },
      });
      return reply.send({ ok: true, ended: true });
    }
    void recordEvent({
      sessionId: row.id, tenantId: row.tenantId, actorRole: "CLIENT", kind: "system", code: "login_failed",
      facts: { count: Math.min(LOGIN_MAX_FAILURES, parsed.data.attemptsLeft ?? 0) },
    });
    return reply.send({ ok: true });
  });

  /* ─────────────────────────── both sides ───────────────────────────── */

  app.get("/remote-desktop/sessions/:id", async (req: any, reply: any) => {
    const user = getUser(req);
    const row = await loadSession(String(req.params.id));
    if (!row || row.kind !== "desktop") return reply.status(404).send({ error: "not_found" });
    await sweepLapsedRemoteDesktopSessions();
    const machine = await loadMachine(row.machineId);
    const fresh = (await loadSession(row.id)) ?? row;
    const isViewer = fresh.requestedByUserId === user.sub;
    const isOwner = fresh.targetUserId === user.sub;
    const isMachine = Boolean(machine) && keyHashFor(req, machine) === machine!.machineKeyHash;
    const isSuper = String(user.role) === "SUPER_ADMIN";
    if (!isViewer && !isOwner && !isMachine && !isSuper) return reply.status(404).send({ error: "not_found" });
    return reply.send({ session: sessionView(fresh, { machine: machine?.name ?? null, requester: await nameOf(fresh.requestedByUserId), owner: await nameOf(fresh.targetUserId) }) });
  });

  app.post("/remote-desktop/sessions/:id/heartbeat", async (req: any, reply: any) => {
    const user = getUser(req);
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });
    const machine = await loadMachine(row.machineId);
    const now = new Date();
    const part = decideDesktopParticipation({ session: sessionFacts(row), machine: machine ? machineFacts(machine) : null, actorUserId: user.sub, presentedKeyHash: keyHashFor(req, machine), now });
    if (!part.ok) return reply.status(part.reason === "not_a_participant" ? 403 : 409).send({ error: part.reason, message: explainDesktopReason(part.reason) });

    // ⛔ THE KILL SWITCH ON EVERY BEAT — "off" ends the live session.
    const { controls, revocations } = await loadRemoteSupportControls();
    const gate = decideSupportGate({ controls, subject: gateSubject(row, machine), revocations });
    if (!gate.ok) {
      await endByGate(row.id, gate.reason, now);
      return reply.status(409).send({ error: gate.reason, message: gate.detail });
    }

    const data: Record<string, unknown> = part.role === "VIEWER" ? { lastSeenAdminAt: now } : { lastSeenClientAt: now };
    if (row.status === "CONSENTED") data.status = "ACTIVE";

    // ⛔ Only the MACHINE may say a call is up (rule 15), and only it knows
    // whether Windows is locked.
    const onCall = part.role === "MACHINE" ? req.body?.callInProgress === true : row.clientOnCall;
    if (part.role === "MACHINE") {
      if (onCall !== row.clientOnCall) {
        data.clientOnCall = onCall;
        void recordEvent({ sessionId: row.id, tenantId: row.tenantId, actorRole: "SYSTEM", kind: "system", code: onCall ? "call_started" : "call_ended" });
      }
      if (machine && typeof req.body?.locked === "boolean" && req.body.locked !== machine.locked) {
        await db.remoteDesktopMachine.update({ where: { id: machine.id }, data: { locked: req.body.locked, lastSeenAt: now } });
      } else if (machine) {
        await db.remoteDesktopMachine.update({ where: { id: machine.id }, data: { lastSeenAt: now } });
      }
    }

    await db.remoteSupportSession.updateMany({ where: { id: row.id, status: { in: ["CONSENTED", "ACTIVE"] } }, data });

    const budget = decideMediaBudget({ callInProgress: onCall, packetLoss: Number(req.body?.packetLoss), roundTripMs: Number(req.body?.roundTripMs) });
    const fresh = (await loadSession(row.id)) ?? row;
    return reply.send({
      ok: true,
      role: part.role,
      status: fresh.status,
      capabilities: fresh.capabilitiesGranted ?? [],
      clientAuthenticated: fresh.clientAuthenticated === true,
      canControl: decideDesktopControl({ session: sessionFacts(fresh), role: "VIEWER" }).ok,
      mediaBudget: budget,
      callInProgress: onCall,
      locked: machine?.locked === true,
    });
  });

  app.post("/remote-desktop/sessions/:id/signal", async (req: any, reply: any) => {
    const user = getUser(req);
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });
    const parsed = signalBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const machine = await loadMachine(row.machineId);
    const now = new Date();
    const part = decideDesktopParticipation({ session: sessionFacts(row), machine: machine ? machineFacts(machine) : null, actorUserId: user.sub, presentedKeyHash: keyHashFor(req, machine), now });
    if (!part.ok) return reply.status(part.reason === "not_a_participant" ? 403 : 409).send({ error: part.reason, message: explainDesktopReason(part.reason) });

    const { controls, revocations } = await loadRemoteSupportControls();
    const gate = decideSupportGate({ controls, subject: gateSubject(row, machine), revocations });
    if (!gate.ok) {
      await endByGate(row.id, gate.reason, now);
      return reply.status(409).send({ error: gate.reason, message: gate.detail });
    }

    const fromRole = part.role === "VIEWER" ? "ADMIN" : "CLIENT";
    const pending = await db.remoteSupportSignal.count({ where: { sessionId: row.id, fromRole, consumedAt: null } });
    const check = checkSignalPayload(parsed.data.payload, pending);
    if (!check.ok) return reply.status(check.reason === "signal_backlog" ? 429 : 400).send({ error: check.reason, message: check.detail });

    await db.remoteSupportSignal.create({ data: { sessionId: row.id, fromRole, kind: parsed.data.kind, payload: parsed.data.payload } });
    return reply.send({ ok: true });
  });

  app.get("/remote-desktop/sessions/:id/signal", async (req: any, reply: any) => {
    const user = getUser(req);
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });
    const machine = await loadMachine(row.machineId);
    const now = new Date();
    const part = decideDesktopParticipation({ session: sessionFacts(row), machine: machine ? machineFacts(machine) : null, actorUserId: user.sub, presentedKeyHash: keyHashFor(req, machine), now });
    if (!part.ok) return reply.status(part.reason === "not_a_participant" ? 403 : 409).send({ error: part.reason, message: explainDesktopReason(part.reason) });

    const want = part.role === "VIEWER" ? "CLIENT" : "ADMIN";
    const rows = await db.remoteSupportSignal.findMany({ where: { sessionId: row.id, fromRole: want, consumedAt: null }, orderBy: { createdAt: "asc" }, take: 50 });
    if (rows.length > 0) {
      await db.remoteSupportSignal.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { consumedAt: now } });
    }
    void purgeOldSignals(now).catch(() => {});
    return reply.send({
      signals: rows.map((r) => ({ id: r.id, kind: r.kind, payload: r.payload })),
      status: row.status,
      clientAuthenticated: row.clientAuthenticated === true,
      capabilities: row.capabilitiesGranted ?? [],
    });
  });

  /** Injected input, as a COUNT. Re-authorises control. */
  app.post("/remote-desktop/sessions/:id/input", async (req: any, reply: any) => {
    const user = getUser(req);
    const count = Math.max(0, Math.min(10_000, Number(req.body?.count) || 0));
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });
    const machine = await loadMachine(row.machineId);
    const now = new Date();
    const part = decideDesktopParticipation({ session: sessionFacts(row), machine: machine ? machineFacts(machine) : null, actorUserId: user.sub, presentedKeyHash: keyHashFor(req, machine), now });
    if (!part.ok) return reply.status(part.reason === "not_a_participant" ? 403 : 409).send({ error: part.reason, message: explainDesktopReason(part.reason) });
    const control = decideDesktopControl({ session: sessionFacts(row), role: part.role });
    if (!control.ok) return reply.status(403).send({ error: control.reason, message: explainDesktopReason(control.reason) });

    const { controls, revocations } = await loadRemoteSupportControls();
    const gate = decideSupportGate({ controls, subject: gateSubject(row, machine), revocations });
    if (!gate.ok) return reply.status(403).send({ error: gate.reason, message: gate.detail });

    if (count > 0) await db.remoteSupportSession.update({ where: { id: row.id }, data: { inputEventCount: { increment: count } } });
    return reply.send({ ok: true });
  });

  /** Where sound and microphone are right now — recorded, so the history is honest. */
  app.post("/remote-desktop/sessions/:id/audio", async (req: any, reply: any) => {
    const user = getUser(req);
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });
    const parsed = audioBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const machine = await loadMachine(row.machineId);
    const now = new Date();
    const part = decideDesktopParticipation({ session: sessionFacts(row), machine: machine ? machineFacts(machine) : null, actorUserId: user.sub, presentedKeyHash: keyHashFor(req, machine), now });
    if (!part.ok) return reply.status(part.reason === "not_a_participant" ? 403 : 409).send({ error: part.reason, message: explainDesktopReason(part.reason) });
    if (part.role !== "VIEWER") return reply.status(403).send({ error: "only_viewer_may_route_audio" });

    const granted = new Set(row.capabilitiesGranted ?? []);
    const sound = parsed.data.sound && granted.has("sound");
    const mic = parsed.data.mic && granted.has("mic");
    const viewerName = await nameOf(user.sub);
    const label = row.requestReason || "the connecting computer";
    void recordEvent({ sessionId: row.id, tenantId: row.tenantId, actorRole: "ADMIN", actorUserId: user.sub, kind: "system", code: sound ? "sound_routed" : "sound_stopped", facts: { detail: label } });
    void recordEvent({ sessionId: row.id, tenantId: row.tenantId, actorRole: "ADMIN", actorUserId: user.sub, kind: "system", code: mic ? "mic_routed" : "mic_stopped", facts: { detail: viewerName ?? label } });
    return reply.send({ ok: true, sound, mic });
  });

  /**
   * Either side hangs up. ⛔⛔ NO GATE CHECK HERE, deliberately — the same rule
   * as remote support's end route. A switch that could refuse `end` would leave
   * a live session running in the exact emergency it exists for.
   */
  app.post("/remote-desktop/sessions/:id/end", async (req: any, reply: any) => {
    const user = getUser(req);
    const row = await loadSession(String(req.params.id));
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (row.status === "ENDED" || row.status === "DECLINED" || row.status === "EXPIRED") return reply.send({ ok: true, alreadyEnded: true });

    const machine = await loadMachine(row.machineId);
    const isMachine = Boolean(machine) && keyHashFor(req, machine) === machine!.machineKeyHash;
    const isViewer = row.requestedByUserId === user.sub;
    const isOwner = row.targetUserId === user.sub;
    const isSuper = String(user.role) === "SUPER_ADMIN";
    if (!isMachine && !isViewer && !isOwner && !isSuper) return reply.status(403).send({ error: "not_a_participant", message: explainDesktopReason("not_a_participant") });

    const endedBy = isMachine ? "machine" : isViewer ? "viewer" : isOwner ? "owner" : "admin";
    const now = new Date();
    await db.remoteSupportSession.updateMany({
      where: { id: row.id, status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
      data: { status: "ENDED", endedAt: now, endedReason: `ended_by_${endedBy}`, endedBy },
    });
    void recordEvent({
      sessionId: row.id, tenantId: row.tenantId, actorRole: endedBy === "machine" ? "CLIENT" : "ADMIN", actorUserId: isMachine ? null : user.sub,
      kind: "system", code: "ended", facts: { detail: endedBy === "machine" ? "stopped at the remote computer" : endedBy === "viewer" ? "disconnected by the connecting side" : `closed by the ${endedBy}` },
    });
    await deps.audit({
      tenantId: row.tenantId, action: "REMOTE_DESKTOP_ENDED", entityType: "RemoteSupportSession", entityId: row.id,
      actorUserId: user.sub, targetUserId: row.targetUserId,
      metadata: { endedBy, inputEventCount: row.inputEventCount, startedAt: row.startedAt, machineId: row.machineId },
    });
    return reply.send({ ok: true });
  });

  /** The transcript. Participants, the owner and super admins. */
  app.get("/remote-desktop/sessions/:id/events", async (req: any, reply: any) => {
    const user = getUser(req);
    const row = await loadSession(String(req.params.id));
    if (!row || row.kind !== "desktop") return reply.status(404).send({ error: "not_found" });
    const machine = await loadMachine(row.machineId);
    const isMachine = Boolean(machine) && keyHashFor(req, machine) === machine!.machineKeyHash;
    const allowed = isMachine || row.requestedByUserId === user.sub || row.targetUserId === user.sub || String(user.role) === "SUPER_ADMIN";
    if (!allowed) return reply.status(404).send({ error: "not_found" });
    const since = req.query?.since ? new Date(String(req.query.since)) : null;
    const events = await db.remoteSupportEvent.findMany({
      where: { sessionId: row.id, ...(since && !Number.isNaN(since.getTime()) ? { at: { gt: since } } : {}) },
      orderBy: { at: "asc" },
      take: 500,
    });
    return reply.send({ events: events.map((e) => ({ id: e.id, at: e.at, kind: e.kind, code: e.code, actorRole: e.actorRole, body: e.body })) });
  });

  /**
   * Recent connections, as the customer sees them: every session that touched
   * one of MY computers (own, by-ID, and Loopcom support), plus every one I
   * opened. A customer reads every time anyone was on their machine — staff
   * included. Same table, same ordering.
   */
  app.get("/remote-desktop/history", async (req: any, reply: any) => {
    const user = getUser(req);
    const actor = await actorFacts(user, req);
    if (!actor.canUseRemoteDesktop) return reply.status(403).send({ error: "missing_permission", message: explainDesktopReason("missing_permission") });
    const take = Math.min(100, Math.max(1, Number(req.query?.limit) || 30));
    const mine = await db.remoteDesktopMachine.findMany({ where: { ownerUserId: user.sub }, select: { id: true, name: true } });
    const machineIds = mine.map((m) => m.id);
    const rows = await db.remoteSupportSession.findMany({
      where: {
        OR: [
          { requestedByUserId: user.sub, kind: "desktop" },
          ...(machineIds.length ? [{ machineId: { in: machineIds } }] : []),
          { targetUserId: user.sub, kind: "support" },
        ],
      },
      orderBy: { createdAt: "desc" },
      take,
    });
    const names = new Map<string, string | null>();
    const out = [];
    for (const row of rows) {
      if (!names.has(row.requestedByUserId)) names.set(row.requestedByUserId, await nameOf(row.requestedByUserId));
      const machineName = mine.find((m) => m.id === row.machineId)?.name ?? row.deviceLabel ?? null;
      out.push({
        ...sessionView(row, { machine: machineName, requester: names.get(row.requestedByUserId) ?? null }),
        connectedFrom: row.kind === "desktop" ? row.requestReason : null,
        soundUsed: (row.capabilitiesGranted ?? []).includes("sound"),
        micUsed: (row.capabilitiesGranted ?? []).includes("mic"),
      });
    }
    return reply.send({ sessions: out });
  });

  /* ─────────────────────────── helpers ──────────────────────────────── */

  function keyHashFor(req: any, machine: any | null): string | null {
    const key = presentedKey(req);
    if (!key || !machine) return null;
    return hashMachineKey(machine.deviceId, key);
  }

  async function endByGate(sessionId: string, reason: string, now: Date) {
    const row = await loadSession(sessionId);
    await db.remoteSupportSession.updateMany({
      where: { id: sessionId, status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] } },
      data: { status: "ENDED", endedAt: now, endedReason: reason, endedBy: "control" },
    });
    if (row) void recordEvent({ sessionId, tenantId: row.tenantId, actorRole: "SYSTEM", kind: "system", code: reason === "remote_support_disabled" ? "killed" : "revoked" });
  }

  async function requestRate(actorUserId: string, targetUserId: string, now: Date) {
    const recent = await db.remoteSupportSession.findMany({
      where: { requestedByUserId: actorUserId, createdAt: { gte: new Date(now.getTime() - REQUEST_WINDOW_MS) } },
      select: { createdAt: true, targetUserId: true },
      take: 200,
    });
    const distinct = new Set(recent.map((r) => r.targetUserId));
    distinct.add(targetUserId);
    return decideRequestRate({ now, recentRequestsAt: recent.map((r) => r.createdAt), distinctTargetsInWindow: distinct.size });
  }
}

function shareView(row: any) {
  return {
    id: row.id,
    scope: row.scope,
    oneTime: row.oneTime === true,
    expiresAt: row.expiresAt,
    allowControl: row.allowControl === true,
    allowSound: row.allowSound === true,
    allowMic: row.allowMic === true,
    allowClipboard: row.allowClipboard === true,
    usedCount: row.usedCount ?? 0,
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt,
  };
}
