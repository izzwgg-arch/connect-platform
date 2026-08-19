/**
 * The assistant's investigation door — read-only access to BOTH servers.
 *
 * Same contract as the other `/internal/agent/*` doors:
 *  - in-handler shared-secret auth (AGENT_INTERNAL_SECRET), FAIL CLOSED;
 *  - ⛔ the path MUST also be in jwtPublicRouteBypass.ts or the global JWT hook
 *    401s it before this auth ever runs — that exact miss left the
 *    account-setup door dead for six days. A 401 means you never reached the
 *    route; a bad secret answers 403. Tell them apart by the STATUS.
 *
 * ⛔⛔ THIS DOOR IS NOT TENANT-SCOPED, AND THAT IS DELIBERATE — read this before
 * changing it. Every other agent door answers one narrow question for one
 * tenant, so it can bind the tenant itself. This one takes an arbitrary read
 * query, and a query cannot be mechanically confined to a tenant without either
 * (a) parsing SQL, which this module refuses to rely on, or (b) a keyword check
 * that blocks legitimate work — "is this happening to anyone else?" is a
 * question a diagnostician must be able to ask. So instead:
 *   - the door is reachable ONLY with the internal secret, i.e. by the agent
 *     service, never by a customer;
 *   - the tools that call it are `minRole: "internal"`, so customer-facing chat
 *     cannot reach them at all;
 *   - EVERY call is audited with the claimed tenant and the exact statement, so
 *     a cross-tenant read is visible afterwards even though it is not blocked.
 * ⛔ Do NOT expose this to `minRole: "customer"`. The whole tenant-isolation
 * design of toolRegistry.ts rests on the model never choosing its own scope,
 * and this door hands it exactly that.
 *
 * What it CANNOT do, by construction: write anything, to either server. See
 * readOnlySql.ts for the three enforcement layers.
 */
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { agentMohSecretOk } from "../agentMohOverride";
import { db } from "@connect/db";
import { runConnectQuery, runPbxQuery } from "./investigationRunner";
import { MAX_INVESTIGATION_ROWS } from "./readOnlySql";

/**
 * A model in a tool loop can fire queries far faster than a person, and each
 * one costs a real connection on a live database. This is a ceiling, not a
 * throttle: hitting it means something is looping, and the refusal says so.
 */
const MAX_QUERIES_PER_MINUTE = 40;
const recentCalls: number[] = [];

function withinRateLimit(): boolean {
  const now = Date.now();
  while (recentCalls.length && now - recentCalls[0] > 60_000) recentCalls.shift();
  if (recentCalls.length >= MAX_QUERIES_PER_MINUTE) return false;
  recentCalls.push(now);
  return true;
}

/** Exposed so a test can prove the limiter is real without waiting a minute. */
export function _resetInvestigationRateLimit() {
  recentCalls.length = 0;
}

const bodySchema = z.object({
  tenantId: z.string().min(1),
  source: z.enum(["connect", "pbx"]),
  sql: z.string().min(1).max(20_000),
  limit: z.number().int().positive().max(MAX_INVESTIGATION_ROWS).optional(),
  /** Free-text note from the model on why it is asking — lands in the audit
   *  row, so a person reading the trail later sees the reasoning, not just the
   *  SQL. Never used for control flow. */
  purpose: z.string().max(300).optional(),
});

/** The PBX MySQL credential lives encrypted on the enabled PbxInstance. */
async function resolvePbxMysqlUrlEncrypted(): Promise<string | null> {
  const instance = await (db as any).pbxInstance.findFirst({
    where: { isEnabled: true },
    select: { ombuMysqlUrlEncrypted: true },
  });
  return instance?.ombuMysqlUrlEncrypted ?? null;
}

export function registerAgentInvestigationRoute(app: FastifyInstance) {
  app.post("/internal/agent/investigate", async (req, reply) => {
    // Fail closed: an unset secret must not become an open door.
    if (!agentMohSecretOk(req.headers["x-agent-internal-secret"], process.env.AGENT_INTERNAL_SECRET)) {
      return reply.code(403).send({ ok: false, error: "forbidden" });
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "bad_request", detail: parsed.error.issues[0]?.message });
    }
    const { tenantId, source, sql, limit, purpose } = parsed.data;

    if (!withinRateLimit()) {
      return reply.code(429).send({
        ok: false,
        error: "rate_limited",
        message:
          `More than ${MAX_QUERIES_PER_MINUTE} investigation queries in a minute — ` +
          `that is a loop, not an investigation. Summarise what you already found.`,
      });
    }

    const result =
      source === "connect"
        ? await runConnectQuery(db, sql, limit ?? 50)
        : await runPbxQuery(await resolvePbxMysqlUrlEncrypted(), sql, limit ?? 50);

    // ⛔ Audited whether it succeeded, was refused, or errored. A refused query
    // is the most interesting row in this table: it is the model trying to do
    // something it is not allowed to do, and that must never be invisible.
    try {
      const event = result.ok ? "investigation.query" : "investigation.refused";
      const payload = {
        source,
        purpose: purpose ?? null,
        statement: sql.slice(0, 2000),
        ok: result.ok,
        rowCount: result.ok ? result.rowCount : 0,
        truncated: result.ok ? result.truncated : false,
        error: result.ok ? null : result.error,
        refusedByGuard: result.ok ? false : result.refusedByGuard,
      };
      await (db as any).agentAuditLog.create({
        data: {
          actor: "agent",
          event,
          tenantId,
          payload,
          // Real tamper evidence, same convention as every other writer of this
          // table. A stubbed hash silently turns an audit trail into a log.
          hash: createHash("sha256")
            .update(JSON.stringify({ actor: "agent", event, tenantId, payload }))
            .digest("hex"),
        },
      });
    } catch (err) {
      // An audit failure must not swallow the answer, but it must be loud —
      // an unaudited read of production data is the thing we promised not to do.
      req.log?.error({ err, tenantId, source }, "agent_investigation_audit_failed");
    }

    if (!result.ok) {
      return reply.code(200).send({
        ok: false,
        error: result.error,
        refusedByGuard: result.refusedByGuard,
        source: result.source,
      });
    }

    return {
      ok: true,
      source: result.source,
      executed: result.executed,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      elapsedMs: result.elapsedMs,
    };
  });
}
