/**
 * The desktop link's HTTP face: what the Loopcom Windows app calls.
 *
 * Reached through nginx as /agent-api/coworker/* (→ /agent/coworker/*), with the
 * same portal JWT the chat widget uses. Identity is DERIVED from the token —
 * `resolveIdentity` — never from the body, so a desktop can only ever register
 * itself for, poll for, and answer on behalf of the person signed into it.
 *
 *   POST /agent/coworker/hello    { manifest }             → { ok, pollWaitMs }
 *   GET  /agent/coworker/next?wait=25                      → 200 { message } | 204
 *   POST /agent/coworker/result   { callId, ok, content }  → { ok, accepted }
 *   POST /agent/coworker/cancel   { taskId? }              → { ok, cancelled }
 *   POST /agent/coworker/goodbye                           → { ok }
 *   GET  /agent/coworker/status                            → the link's view of this person's desktop
 *
 * ⛔ Nothing here runs anything, and nothing here decides anything. The desktop
 * decides locally; this is the mailbox.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { resolveIdentity } from "../conversation/routes";
import type { AuditLog } from "../audit/audit";
import { DesktopLink, MAX_POLL_WAIT_MS, parseManifest, type LinkIdentity } from "./desktopLink";

function who(req: FastifyRequest): LinkIdentity | null {
  const id = resolveIdentity(req);
  if (!id || !id.clientUserId) return null;
  return { tenantId: id.tenantId, clientUserId: id.clientUserId };
}

export function registerCoworkerLinkRoutes(app: FastifyInstance, link: DesktopLink, audit: AuditLog | null = null) {
  app.post("/agent/coworker/hello", async (req, reply) => {
    const id = who(req);
    if (!id) return reply.code(403).send({ error: "forbidden" });
    const body = (req.body ?? {}) as { manifest?: unknown };
    const parsed = parseManifest(body.manifest);
    if (!parsed.ok) return reply.code(400).send({ error: "bad_manifest", refused: parsed.refused });
    const r = link.hello(id, parsed.manifest);
    await audit?.record({
      actor: "system", event: r.replaced ? "coworker.desktop_hello_again" : "coworker.desktop_hello", tenantId: id.tenantId,
      payload: { userId: id.clientUserId, desktopId: parsed.manifest.desktopId, appVersion: parsed.manifest.appVersion, tools: parsed.manifest.tools.length, mcpServers: (parsed.manifest.mcpServers ?? []).length, profile: parsed.manifest.profile },
    });
    return { ok: true, pollWaitMs: MAX_POLL_WAIT_MS, tools: parsed.manifest.tools.length };
  });

  app.get("/agent/coworker/next", async (req, reply) => {
    const id = who(req);
    if (!id) return reply.code(403).send({ error: "forbidden" });
    const q = (req.query ?? {}) as { wait?: string };
    const waitMs = Math.min(Math.max(0, Number(q.wait ?? 25) * 1000 || 0), MAX_POLL_WAIT_MS);
    if (!link.session(id)) return reply.code(409).send({ error: "not_registered", message: "Say hello first." });
    const msg = await link.next(id, waitMs);
    if (!msg) return reply.code(204).send();
    return { message: msg };
  });

  app.post("/agent/coworker/result", async (req, reply) => {
    const id = who(req);
    if (!id) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ callId: z.string().min(1).max(80), ok: z.boolean(), content: z.unknown().optional(), name: z.string().max(64).optional(), durationMs: z.number().optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    const accepted = link.result(id, body.data.callId, { ok: body.data.ok, content: body.data.content ?? null });
    await audit?.record({
      actor: "system", event: accepted ? "coworker.desktop_result" : "coworker.desktop_result_late", tenantId: id.tenantId,
      payload: { userId: id.clientUserId, callId: body.data.callId, tool: body.data.name ?? null, ok: body.data.ok, durationMs: body.data.durationMs ?? null },
    });
    return { ok: true, accepted };
  });

  app.post("/agent/coworker/cancel", async (req, reply) => {
    const id = who(req);
    if (!id) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ taskId: z.string().max(120).nullable().optional() }).safeParse(req.body ?? {});
    const taskId = body.success ? body.data.taskId ?? null : null;
    const r = link.cancel(id, taskId);
    await audit?.record({ actor: "system", event: "coworker.cancel", tenantId: id.tenantId, payload: { userId: id.clientUserId, taskId, cancelled: r.cancelled } });
    return { ok: true, ...r };
  });

  app.post("/agent/coworker/goodbye", async (req, reply) => {
    const id = who(req);
    if (!id) return reply.code(403).send({ error: "forbidden" });
    const gone = link.goodbye(id);
    await audit?.record({ actor: "system", event: "coworker.desktop_goodbye", tenantId: id.tenantId, payload: { userId: id.clientUserId, wasConnected: gone } });
    return { ok: true };
  });

  app.get("/agent/coworker/status", async (req, reply) => {
    const id = who(req);
    if (!id) return reply.code(403).send({ error: "forbidden" });
    return link.status(id);
  });

  app.get("/agent/coworker/manifest", async (req, reply) => {
    const id = who(req);
    if (!id) return reply.code(403).send({ error: "forbidden" });
    const m = link.manifest(id);
    if (!m) return reply.code(404).send({ error: "not_connected" });
    return { manifest: m };
  });
}
