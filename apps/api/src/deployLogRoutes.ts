import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

type QueueResponse = { ok: boolean; status: number; data: unknown };
type Deps = {
  requireSuperAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  dqFetch: (path: string) => Promise<QueueResponse>;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? value as Record<string, unknown> : {};

/** A real job without a log is a normal resource state, not a missing endpoint.
 * Repeated public 404s for queued jobs used to trigger the nginx IP ban. */
export function registerDeployLogRoutes(app: FastifyInstance, deps: Deps) {
  app.get("/admin/deploy/jobs/:id/log", async (req, reply) => {
    if (!await deps.requireSuperAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.status(400).send({ error: "invalid_job_id" });
    const query = req.query as Record<string, string>;
    const lines = Math.min(2000, Math.max(1, Number(query.lines) || 200));
    const path = `/ops/deploy/jobs/${encodeURIComponent(id)}`;
    const info = await deps.dqFetch(path);
    if (!info.ok) return reply.status(info.status).send(info.data);
    const job = record(record(info.data).job);
    if (job.id !== id || typeof job.status !== "string") {
      return reply.status(502).send({ error: "invalid_job_response_from_queue" });
    }
    const waiting = (pending: boolean) => ({
      id, lines: 0, available: false, pending,
      text: pending ? "Waiting for this deployment to create its log." : "No log is available for this deployment.",
    });
    if (job.status === "queued") return reply.send(waiting(true));
    const log = await deps.dqFetch(`${path}/log?lines=${lines}`);
    if (log.status === 404 && record(log.data).error === "log_not_available") {
      // The job exists; the queue still enforces its registered-path fence.
      return reply.send(waiting(job.status === "running"));
    }
    return reply.status(log.status).send(log.data);
  });
}
