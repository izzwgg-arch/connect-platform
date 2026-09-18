/**
 * Loopcom staff: the Yealink ticket-portal session, and a manual filing door.
 *
 * ⛔ SUPER_ADMIN only, mirroring the GDMS credential routes in deviceCloudRoutes.ts exactly:
 * write-only save (never echoes the cookie), read-only Verify, and a manual "file a release"
 * door for a phone the automatic hook (yealinkRedirectClaim.ts's conflict branch) hasn't
 * reached yet — see yealinkMacRemoval.ts's own header for the ticket-portal contract.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeMac } from "@connect/shared";
import {
  describeYealinkTicketSession,
  fetchMacRemovalUsage,
  fileMacRemoval,
  resolveYealinkTicketSession,
  storeYealinkTicketSession,
  validateYealinkTicketSession,
  type MacRemovalFailureCode,
  type MacRemovalFetch,
  type YealinkTicketSession,
} from "./yealinkMacRemoval";

type JwtUser = { sub: string; tenantId: string; email: string; role: string };

export type YealinkMacRemovalRouteContext = {
  db: any;
  getUser: (req: any) => JwtUser;
  isSuper: (user: JwtUser) => boolean;
  audit: (p: {
    tenantId: string; action: string; entityType: string; entityId: string;
    actorUserId?: string; metadata?: Record<string, unknown> | null;
  }) => Promise<void>;
  /** Injectable for tests only; the real default is the global `fetch`. */
  request?: MacRemovalFetch;
};

const serialTail = (s: string | null | undefined) => (s ? `…${s.slice(-4)}` : null);

function messageFor(code: MacRemovalFailureCode): string {
  switch (code) {
    case "not_configured": return "No Yealink ticket-portal session is saved.";
    case "invalid_input": return "Enter the phone's MAC address and a serial number of at least 6 characters.";
    case "yealink_cap_reached": return "Yealink's daily release allowance is nearly used up. Try again after it resets.";
    case "yealink_session_expired": return "That session cookie is no longer signed in. Sign in again at ticket.yealink.com and paste a fresh Cookie header.";
    case "mac_serial_mismatch": return "Yealink says that MAC address and serial number don't match.";
    case "yealink_unavailable": default: return "Yealink's ticket portal didn't answer. Try again shortly.";
  }
}

export function registerYealinkMacRemovalRoutes(app: FastifyInstance, ctx: YealinkMacRemovalRouteContext): void {
  const { db, getUser, isSuper, audit } = ctx;
  const ENTITY = { entityType: "PlatformIntegration", entityId: "yealink_ticket" } as const;

  /** Masked hints only — never a value. */
  app.get("/admin/desk-phones/yealink-ticket-session", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!user?.sub || !isSuper(user)) return reply.status(403).send({ error: "forbidden" });
    return reply.send({ ok: true, session: await describeYealinkTicketSession(db) });
  });

  /** Save (or clear) the session. ⛔ Write-only: the response carries hints, the audit carries none of the cookie. */
  app.post("/admin/desk-phones/yealink-ticket-session", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!user?.sub || !isSuper(user)) return reply.status(403).send({ error: "forbidden" });
    const body = z.object({
      clear: z.boolean().optional(),
      cookie: z.string().max(8000).optional(),
      note: z.string().max(300).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });

    const cleared = body.data.clear === true;
    let value: YealinkTicketSession | null = null;
    if (!cleared) {
      const check = validateYealinkTicketSession(body.data);
      if (!check.ok) return reply.status(400).send({ ok: false, error: "invalid_session", message: check.message });
      value = check.value;
    }
    try {
      await storeYealinkTicketSession(db, value, user.email || user.sub);
    } catch (err: any) {
      if (String(err?.message) === "credentials_master_key_missing") {
        return reply.status(503).send({
          ok: false, error: "credentials_master_key_missing",
          message: "Credentials can't be stored securely on this server yet — its encryption key isn't set. Nothing was saved.",
        });
      }
      return reply.status(500).send({ ok: false, error: "store_failed", message: "The session couldn't be saved. Nothing was changed." });
    }
    const described = await describeYealinkTicketSession(db);
    await audit({
      tenantId: user.tenantId, actorUserId: user.sub, ...ENTITY,
      action: cleared ? "YEALINK_TICKET_SESSION_CLEARED" : "YEALINK_TICKET_SESSION_SAVED",
      metadata: { savedAt: described.savedAt },
    });
    return reply.send({ ok: true, session: described });
  });

  /** Clear the saved session. */
  app.delete("/admin/desk-phones/yealink-ticket-session", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!user?.sub || !isSuper(user)) return reply.status(403).send({ error: "forbidden" });
    try {
      await storeYealinkTicketSession(db, null, user.email || user.sub);
    } catch {
      return reply.status(500).send({ ok: false, error: "store_failed", message: "The session couldn't be cleared." });
    }
    await audit({ tenantId: user.tenantId, actorUserId: user.sub, ...ENTITY, action: "YEALINK_TICKET_SESSION_CLEARED", metadata: {} });
    return reply.send({ ok: true, session: await describeYealinkTicketSession(db) });
  });

  /** Read-only proof the saved cookie still works: one usage read. Changes nothing at Yealink. */
  app.post("/admin/desk-phones/yealink-ticket-session/verify", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!user?.sub || !isSuper(user)) return reply.status(403).send({ error: "forbidden" });
    const session = await resolveYealinkTicketSession(db);
    if (!session) return reply.status(409).send({ ok: false, error: "not_configured", message: messageFor("not_configured") });
    const out = await fetchMacRemovalUsage(session, ctx.request ?? fetch);
    if (!out.ok) {
      await audit({ tenantId: user.tenantId, actorUserId: user.sub, ...ENTITY, action: "YEALINK_TICKET_SESSION_VERIFY_FAILED", metadata: { code: out.code } });
      return reply.status(out.code === "yealink_session_expired" ? 409 : 503).send({ ok: false, error: out.code, message: messageFor(out.code) });
    }
    await audit({ tenantId: user.tenantId, actorUserId: user.sub, ...ENTITY, action: "YEALINK_TICKET_SESSION_VERIFIED", metadata: out.usage });
    return reply.send({ ok: true, removedCount: out.usage.removedCount, errorCount: out.usage.errorCount });
  });

  /**
   * Manual filing door for staff — the same fences the automatic hook uses. Only useful for
   * a phone the automatic hook hasn't already covered; it does NOT read or write the
   * ManagedDeskPhone dedupe record, so it is a deliberate staff override, not the normal path.
   */
  app.post("/admin/desk-phones/yealink-ticket-session/file", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!user?.sub || !isSuper(user)) return reply.status(403).send({ error: "forbidden" });
    const body = z.object({ mac: z.string().max(40), serial: z.string().min(6).max(80) }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ ok: false, error: "invalid_request", message: "Enter the phone's MAC address and serial number." });
    const mac = normalizeMac(body.data.mac);
    if (!mac) return reply.status(400).send({ ok: false, error: "invalid_mac", message: "Enter the device's hardware (MAC) address." });
    const serial = body.data.serial.trim();

    const result = await fileMacRemoval({ mac, serial }, { db, request: ctx.request });
    if (!result.ok) {
      await audit({
        tenantId: user.tenantId, actorUserId: user.sub, ...ENTITY, action: "YEALINK_TICKET_MANUAL_FILE_FAILED",
        metadata: { mac, serialTail: serialTail(serial), code: result.code },
      });
      return reply.status(409).send({ ok: false, error: result.code, message: messageFor(result.code) });
    }
    await audit({
      tenantId: user.tenantId, actorUserId: user.sub, ...ENTITY, action: "YEALINK_TICKET_MANUAL_FILE_FILED",
      metadata: { mac, serialTail: serialTail(serial), ticketId: result.ticketId },
    });
    return reply.send({ ok: true, ticketId: result.ticketId });
  });
}
