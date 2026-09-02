/**
 * The Coworker's hands, api half: the record of what was proposed, who approved
 * it, and what the desktop reported back.
 *
 * ⛔ THE API RUNS NOTHING. The agent PROPOSES (a DRAFT AgentAction under
 * COWORKER_TASK_CAPABILITY_ID), the person APPROVES on the four-question card in
 * the Coworker popover (this file records it, single-use, TTL-bound), the DESKTOP
 * app runs the task against its own copy of the allowlist, and the result lands
 * back here so the assistant can answer "did it finish?" from the record instead
 * of from hope.
 *
 * ⛔ SELF-SCOPED, ALWAYS. Every route resolves the caller's own row: same tenant
 * AND `requestedBy === the signed-in user`. A task proposed to Baila is not
 * approvable by Baila's colleague, and a task in another company does not exist
 * from here (404, never 403 — no oracle).
 *
 * ⛔ The prefix `/coworker` is listed in PORTAL_API_PERMISSION_RULES with
 * `permission: null` (authenticated only) — the customer whose computer it is holds
 * no admin key, so a permission gate here would 403 every customer. Same lesson as
 * `/voice/diag` and `/remote-support`.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import {
  COWORKER_TASK_CAPABILITY_ID, COWORKER_TASK_TTL_MS,
  parseCoworkerTask, describeCoworkerTask, coworkerTaskExpired, boundTaskResult,
  type CoworkerTask,
} from "@connect/shared/coworker";

type Actor = { sub: string; tenantId: string; role: string };

export type CoworkerTaskRouteDeps = {
  db?: any;
  now?: () => number;
  /** Best-effort audit hook; a failure here never fails the request. */
  audit?: (event: { action: string; tenantId: string; userId: string; detail: Record<string, unknown> }) => Promise<void> | void;
};

/** What the popover renders. `task` is re-parsed from the row, never trusted raw. */
export function pendingTaskView(row: { id: string; params: unknown; createdAt: Date | string }) {
  const params = (row.params ?? {}) as { task?: unknown; decision?: { verdict?: string } };
  const parsed = parseCoworkerTask(params.task);
  if (!parsed.ok) return null;
  return {
    id: row.id,
    task: parsed.task,
    card: describeCoworkerTask(parsed.task),
    verdict: params.decision?.verdict === "allow" ? "allow" : "ask",
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(new Date(row.createdAt).getTime() + COWORKER_TASK_TTL_MS).toISOString(),
  };
}

export async function registerCoworkerTaskRoutes(app: FastifyInstance, deps: CoworkerTaskRouteDeps = {}) {
  const prisma = deps.db ?? db;
  const now = deps.now ?? (() => Date.now());
  const audit = async (action: string, actor: Actor, detail: Record<string, unknown>) => {
    try { await deps.audit?.({ action, tenantId: actor.tenantId, userId: actor.sub, detail }); } catch { /* never fail a task on its audit */ }
  };
  const idParam = z.object({ id: z.string().min(1).max(64) });
  const own = (actor: Actor, id: string) => ({ id, tenantId: actor.tenantId, requestedBy: actor.sub, capabilityId: COWORKER_TASK_CAPABILITY_ID });

  app.get("/coworker/tasks/pending", async (req: any) => {
    const actor = req.user as Actor;
    const rows = await prisma.agentAction.findMany({
      where: { tenantId: actor.tenantId, requestedBy: actor.sub, capabilityId: COWORKER_TASK_CAPABILITY_ID, status: "DRAFT", approvalConsumedAt: null },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, params: true, createdAt: true },
    });
    const t = now();
    const tasks = rows
      .filter((r: any) => !coworkerTaskExpired(new Date(r.createdAt).getTime(), t))
      .map(pendingTaskView)
      .filter(Boolean);
    return { tasks };
  });

  /**
   * "Do it." Single-use: the claim is an updateMany conditioned on DRAFT +
   * unconsumed, so two racing clicks (or two windows) cannot both win. Returns the
   * task the DESKTOP should run — the renderer never supplies it.
   */
  app.post("/coworker/tasks/:id/approve", async (req: any, reply: any) => {
    const actor = req.user as Actor;
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "task_not_found" });
    const row = await prisma.agentAction.findFirst({ where: own(actor, p.data.id), select: { id: true, params: true, createdAt: true, status: true } });
    if (!row) return reply.code(404).send({ error: "task_not_found" });
    if (coworkerTaskExpired(new Date(row.createdAt).getTime(), now())) {
      await prisma.agentAction.updateMany({ where: { ...own(actor, row.id), status: "DRAFT" }, data: { status: "EXPIRED" } });
      return reply.code(410).send({ error: "task_expired", message: "That request is too old to run now — ask the Coworker again." });
    }
    const view = pendingTaskView(row);
    if (!view) return reply.code(409).send({ error: "task_unreadable", message: "That request can't be read back safely, so it will not run." });
    const claimed = await prisma.agentAction.updateMany({
      where: { ...own(actor, row.id), status: "DRAFT", approvalConsumedAt: null },
      data: { status: "APPROVED", approvedBy: actor.sub, approvalConsumedAt: new Date(now()) },
    });
    if (!claimed.count) return reply.code(409).send({ error: "task_already_answered" });
    await audit("coworker_task.approved", actor, { taskId: row.id, kind: view.task.kind });
    return { ok: true, id: row.id, task: view.task as CoworkerTask };
  });

  /** "No." No password, no ceremony: declining can only make the computer less touched. */
  app.post("/coworker/tasks/:id/dismiss", async (req: any, reply: any) => {
    const actor = req.user as Actor;
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "task_not_found" });
    const done = await prisma.agentAction.updateMany({
      where: { ...own(actor, p.data.id), status: "DRAFT", approvalConsumedAt: null },
      data: { status: "DENIED", deniedReason: "dismissed_by_requester" },
    });
    if (!done.count) return reply.code(404).send({ error: "task_not_found" });
    await audit("coworker_task.dismissed", actor, { taskId: p.data.id });
    return { ok: true, dismissed: done.count };
  });

  /**
   * What the desktop did. Only an APPROVED row may take a result, and only once —
   * a second report of the same task is refused, so a retried IPC cannot turn a
   * failure into a success after the fact.
   */
  app.post("/coworker/tasks/:id/result", async (req: any, reply: any) => {
    const actor = req.user as Actor;
    const p = idParam.safeParse(req.params);
    if (!p.success) return reply.code(404).send({ error: "task_not_found" });
    const result = boundTaskResult(req.body);
    if (!result) return reply.code(400).send({ error: "bad_result", message: "The result must say ok (true/false) and a one-line summary." });
    // Ownership first: a row that is not mine reads exactly like one that does not exist.
    const mine = await prisma.agentAction.findFirst({ where: own(actor, p.data.id), select: { id: true } });
    if (!mine) return reply.code(404).send({ error: "task_not_found" });
    const done = await prisma.agentAction.updateMany({
      where: { ...own(actor, p.data.id), status: "APPROVED", executedAt: null },
      data: {
        status: result.ok ? "EXECUTED" : "FAILED",
        executedAt: new Date(now()),
        resultSnapshot: result,
        ...(result.ok ? {} : { errorDetail: (result.code ?? "failed").slice(0, 64) }),
      },
    });
    if (!done.count) return reply.code(409).send({ error: "task_not_awaiting_result" });
    await audit(result.ok ? "coworker_task.executed" : "coworker_task.failed", actor, { taskId: p.data.id, summary: result.summary, code: result.code ?? null });
    return { ok: true };
  });
}
