/**
 * ACT AS THE PERSON WHO FILED THE TICKET.
 *
 *   POST /admin/support/escalations/:reference/act   { method, path, body? }
 *
 * Izzy, 2026-09-14: the support agent may fix everything the person who filed
 * the ticket is allowed to do in their custom role — an owner-toggle holder
 * gets owner-level things, an ordinary user gets what their role grants — and
 * there must be no tenant leakage.
 *
 * ⛔⛔ HOW THAT IS ENFORCED, none of it the agent's discretion:
 *   1. The request is REPLAYED through the api's own routes with `app.inject`,
 *      signed as the filer with a 2-minute token that never leaves this process
 *      (the `injectAsService` pattern the agent grant routes already use). The
 *      global preHandler then resolves that person's permissions from the
 *      database exactly as it does for their own browser — so their custom role,
 *      and nothing else, decides what goes through.
 *   2. The token's identity comes from the USER ROW, never from the request, and
 *      that user's tenant must equal the ticket's tenant. A SUPER_ADMIN filer is
 *      refused: acting as them would not be confined to one company.
 *   3. Platform-only doors are refused whatever the role says (BLOCKED_PREFIXES),
 *      as are absolute URLs, traversal, and the tenant-context override.
 *   4. Only a person's ticket (not a platform alarm), at most a week old.
 *   5. Writes are OFF until SUPPORT_AGENT_WRITES_ENABLED=1 — the owner must be
 *      texted what is being done before anything is changed unattended — and
 *      capped per tenant per day.
 *   6. Every call, read or write, is audited against the ticket.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resolveEscalationId } from "./customerUpdateRoutes";

export const ACT_TICKET_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Izzy, 2026-09-14: "10 per day … per tenant". Counted as distinct tickets with a write. */
export const ACT_WRITE_TICKETS_PER_TENANT_PER_DAY = 10;
export const ACT_MAX_BODY_CHARS = 100_000;
export const ACT_MAX_RESPONSE_CHARS = 100_000;

/**
 * ⛔ Refused for EVERY filer. These are platform staff doors, the auth surface,
 * the support channel itself (the agent must never pose as the customer
 * writing to us), onboarding's public doors, and the raw VitalPBX resource door
 * the 2026-08-17 isolation audit found passes an id with no tenant scope.
 */
export const BLOCKED_PREFIXES = Object.freeze([
  "/admin",
  "/internal",
  "/auth",
  "/ops",
  "/agent",
  "/agent-api",
  "/support",
  "/onboarding",
  "/voice/pbx/resources",
]);

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type ActDecision = { ok: true; path: string; query: string } | { ok: false; status: number; error: string; message: string };

/** Pure: is this path something the agent may send as the filer? */
export function checkActPath(raw: unknown): ActDecision {
  const input = String(raw ?? "").trim();
  const refuse = (message: string): ActDecision => ({ ok: false, status: 400, error: "path_refused", message });
  if (!input.startsWith("/") || input.startsWith("//")) return refuse("Give an api path starting with a single '/', not a URL.");
  if ([...input].some((ch) => ch === "\\" || ch.charCodeAt(0) < 32)) return refuse("That path contains characters an api path never has.");
  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    return refuse("That path is not valid URL encoding.");
  }
  const [pathPart, ...rest] = input.split("?");
  const query = rest.join("?");
  const decodedPath = decoded.split("?")[0];
  if (decodedPath.split("/").some((seg) => seg === ".." || seg === ".")) return refuse("Relative segments are not allowed.");
  // The portal's /api prefix is nginx's; the api itself routes without it.
  const path = pathPart.replace(/^\/api(?=\/|$)/, "") || "/";
  const normalized = decodedPath.replace(/^\/api(?=\/|$)/, "").toLowerCase();
  for (const prefix of BLOCKED_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix + "/")) {
      return { ok: false, status: 403, error: "path_blocked", message: `${prefix} is never reachable as a customer, whatever their role.` };
    }
  }
  const params = new URLSearchParams(query);
  for (const key of params.keys()) {
    const k = key.toLowerCase();
    if (k === "token" || k === "tenantcontext") {
      return { ok: false, status: 400, error: "path_refused", message: `The ${key} parameter would change who the request runs as; it is not allowed.` };
    }
  }
  return { ok: true, path, query };
}

export type ActAsFilerDeps = {
  db: any;
  requireSuper: (req: any, reply: any) => Promise<any> | any;
  /** Signs a SHORT-LIVED session token for exactly these claims. */
  signFilerToken: (claims: { sub: string; tenantId: string; email: string; role: string }) => string;
  /** Replays one request through the api's own routes. */
  inject: (input: { method: string; url: string; token: string; body?: unknown }) => Promise<{ statusCode: number; body: unknown }>;
  audit: (params: {
    tenantId: string;
    action: string;
    entityType: string;
    entityId: string;
    actorUserId?: string;
    metadata?: Record<string, unknown> | null;
  }) => Promise<unknown>;
  writesEnabled: () => boolean;
  /** Has the owner been texted what is happening, and has he not said STOP? (supportAgentNotice.ts) */
  ownerNoticeGate: (escalationId: string) => Promise<{ ok: true } | { ok: false; error: string; message: string }>;
  now?: () => number;
  log?: { info?: (o: any, m?: string) => void; warn?: (o: any, m?: string) => void };
};

const bodySchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1).max(2000),
  body: z.unknown().optional(),
});

function startOfUtcDay(ms: number): Date {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function truncateBody(body: unknown): unknown {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? null);
  if (text.length <= ACT_MAX_RESPONSE_CHARS) return body;
  return { truncated: true, preview: text.slice(0, ACT_MAX_RESPONSE_CHARS) };
}

export function registerActAsFilerRoutes(app: FastifyInstance, deps: ActAsFilerDeps): void {
  const { db } = deps;
  const now = deps.now ?? (() => Date.now());

  app.post("/admin/support/escalations/:reference/act", async (req: any, reply: any) => {
    const actor = await deps.requireSuper(req, reply);
    if (!actor) return reply;

    const reference = String((req.params as any)?.reference ?? "").trim();
    const parsed = bodySchema.safeParse(req.body || {});
    if (!reference || !parsed.success) {
      return reply.status(400).send({ error: "invalid_request", message: "Send { method, path, body? } for a ticket reference." });
    }
    const { method, body } = parsed.data;
    if (body !== undefined && JSON.stringify(body).length > ACT_MAX_BODY_CHARS) {
      return reply.status(413).send({ error: "body_too_large", message: "That request body is too large." });
    }

    const pathCheck = checkActPath(parsed.data.path);
    if (!pathCheck.ok) return reply.status(pathCheck.status).send({ error: pathCheck.error, message: pathCheck.message });

    const escalationId = await resolveEscalationId(db, reference);
    const esc = escalationId
      ? await db.agentEscalation.findUnique({
          where: { id: escalationId },
          select: { id: true, tenantId: true, clientUserId: true, createdAt: true },
        })
      : null;
    if (!esc) return reply.status(404).send({ error: "not_found", message: `No recent ticket with reference ${reference}.` });
    if (!esc.clientUserId) {
      return reply.status(409).send({ error: "not_applicable", message: "That ticket is a platform alarm — there is no person to act as." });
    }
    if (now() - new Date(esc.createdAt).getTime() > ACT_TICKET_MAX_AGE_MS) {
      return reply.status(410).send({ error: "ticket_too_old", message: "That ticket is more than a week old; a person must handle it." });
    }

    const filer = await db.user.findUnique({
      where: { id: esc.clientUserId },
      select: { id: true, tenantId: true, email: true, role: true, status: true },
    });
    if (!filer || String(filer.status) !== "ACTIVE") {
      return reply.status(403).send({ error: "filer_inactive", message: "The person who filed this ticket is no longer an active user." });
    }
    // ⛔ The leakage line: the identity is the DB row, and it must be the ticket's own company.
    if (!filer.tenantId || filer.tenantId !== esc.tenantId) {
      return reply.status(403).send({ error: "tenant_mismatch", message: "The filer does not belong to the ticket's company; refusing." });
    }
    if (String(filer.role) === "SUPER_ADMIN") {
      return reply.status(403).send({ error: "platform_role", message: "The filer is platform staff; acting as them would not be confined to one company." });
    }

    const isWrite = WRITE_METHODS.has(method);
    if (isWrite) {
      if (!deps.writesEnabled()) {
        return reply.status(403).send({ error: "writes_disabled", message: "Changes as the filer are switched off (SUPPORT_AGENT_WRITES_ENABLED)." });
      }
      const todays = await db.auditLog.findMany({
        where: { tenantId: esc.tenantId, action: "SUPPORT_AGENT_ACT_WRITE", createdAt: { gte: startOfUtcDay(now()) } },
        select: { entityId: true },
      });
      const tickets = new Set(todays.map((r: any) => r.entityId));
      if (!tickets.has(esc.id) && tickets.size >= ACT_WRITE_TICKETS_PER_TENANT_PER_DAY) {
        return reply.status(429).send({
          error: "tenant_daily_cap",
          message: `This company already had changes made on ${tickets.size} tickets today; the rest wait for tomorrow or a person.`,
        });
      }
      // ⛔ The owner is told BEFORE anything changes, and his STOP is final.
      const gate = await deps.ownerNoticeGate(esc.id);
      if (!gate.ok) return reply.status(409).send({ error: gate.error, message: gate.message });
    }

    const token = deps.signFilerToken({ sub: filer.id, tenantId: filer.tenantId, email: filer.email, role: String(filer.role) });
    const url = pathCheck.query ? `${pathCheck.path}?${pathCheck.query}` : pathCheck.path;
    const result = await deps.inject({ method, url, token, body: isWrite ? body : undefined });

    await deps
      .audit({
        tenantId: esc.tenantId,
        action: isWrite ? "SUPPORT_AGENT_ACT_WRITE" : "SUPPORT_AGENT_ACT_READ",
        entityType: "AgentEscalation",
        entityId: esc.id,
        actorUserId: filer.id,
        metadata: { reference: reference.toUpperCase(), method, path: pathCheck.path, statusCode: result.statusCode, via: "support_agent" },
      })
      .catch((err: any) => deps.log?.warn?.({ err: String(err?.message || err), reference }, "support-act: audit failed"));

    deps.log?.info?.({ reference, method, path: pathCheck.path, statusCode: result.statusCode }, "support-act: replayed as the filer");
    return reply.send({ ok: true, statusCode: result.statusCode, body: truncateBody(result.body) });
  });
}
