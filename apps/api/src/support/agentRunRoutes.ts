/**
 * Live visibility into the automatic support agent.
 *
 *   POST /admin/support/agent-runs        the watcher pushes a run as it happens
 *   GET  /admin/support/agent-runs        the console's list
 *   GET  /admin/support/agent-runs/:id    one run, with its live steps
 *   POST /admin/support/agent-watcher     the watcher's heartbeat
 *   GET  /admin/support/agent-watcher     is it alive, and what has it used today
 *
 * ⛔⛔ WHY PUSH AND NOT PULL: the watcher runs on a laptop and the console runs
 * on loopcom. The console cannot read that machine, so anything an operator
 * needs to see has to arrive here AS IT HAPPENS. A run that only reported its
 * result would leave the operator blind for the ten-plus minutes that matter —
 * which is exactly the complaint this was built for ("I can't be blind like
 * this").
 *
 * ⛔ SUPER_ADMIN only, both directions. `steps` and `report` are internal by
 * construction: they quote other tenants, file paths and internal systems. There
 * is no customer-facing route in this file and a test fails if one appears.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supportReportReference } from "@connect/shared";

export type AgentRunRouteDeps = {
  db: any;
  /** The support console's own SUPER_ADMIN gate, injected so there is ONE implementation. */
  requireSuper: (req: any, reply: any) => Promise<any> | any;
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void };
};

/**
 * ⛔ Bounds, because the writer is a long-running agent on someone's laptop and
 * a runaway loop must not be able to fill the database. A truncated step is
 * still readable; an unbounded one is an outage waiting for a bad day.
 */
export const MAX_STEPS = 300;
export const MAX_STEP_TEXT = 2_000;
export const MAX_REPORT = 200_000;

export type AgentStep = { at: string; kind: string; text: string };

/** Keep the LAST MAX_STEPS — the end of a run is what someone is watching. */
export function sanitiseSteps(input: unknown): AgentStep[] {
  if (!Array.isArray(input)) return [];
  const out: AgentStep[] = [];
  for (const raw of input.slice(-MAX_STEPS)) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const text = String(s.text ?? "").slice(0, MAX_STEP_TEXT);
    if (!text) continue;
    out.push({
      at: String(s.at ?? new Date().toISOString()).slice(0, 40),
      // Free text from the writer, so pin it to a known set rather than trusting it.
      kind: ["tool", "text", "error", "system"].includes(String(s.kind)) ? String(s.kind) : "text",
      text,
    });
  }
  return out;
}

const runSchema = z.object({
  /** The watcher's own stable id for this run, so a re-push updates rather than duplicates. */
  runId: z.string().trim().min(6).max(120),
  ticketRef: z.string().trim().min(1).max(40),
  lane: z.enum(["customer", "platform"]).default("customer"),
  status: z.enum(["running", "done", "failed"]).default("running"),
  attempt: z.number().int().min(1).max(10).default(1),
  host: z.string().trim().max(80).optional(),
  sessionId: z.string().trim().max(80).optional(),
  tenantName: z.string().trim().max(200).optional(),
  requestSummary: z.string().trim().max(2000).optional(),
  startedAt: z.string().trim().max(40).optional(),
  endedAt: z.string().trim().max(40).optional(),
  steps: z.array(z.any()).max(2000).optional(),
  report: z.string().max(MAX_REPORT).optional(),
  error: z.string().max(4000).optional(),
});

const beatSchema = z.object({
  host: z.string().trim().min(1).max(80),
  state: z.string().trim().max(40).default("idle"),
  currentTicket: z.string().trim().max(40).nullish(),
  usedToday: z.record(z.string(), z.number()).optional(),
  caps: z.record(z.string(), z.number()).optional(),
  lastError: z.string().max(2000).nullish(),
  tokenExpiresAt: z.string().trim().max(40).nullish(),
  version: z.string().trim().max(40).optional(),
});

/** A reference (Q2FJRK) is what the watcher has; resolve it the way the console does. */
async function resolveEscalationId(db: any, reference: string): Promise<string | null> {
  const needle = String(reference || "").trim().toUpperCase();
  if (!needle) return null;
  if (needle.length > 20) return needle;
  const rows = await db.agentEscalation.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { id: true } });
  const hit = rows.find((r: any) => supportReportReference(r.id).toUpperCase() === needle);
  return hit?.id ?? null;
}

const asDate = (v: unknown): Date | undefined => {
  if (!v) return undefined;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export function registerAgentRunRoutes(app: FastifyInstance, deps: AgentRunRouteDeps): void {
  const { db } = deps;

  /** The watcher pushes here repeatedly during a run — start, steps, finish. */
  app.post("/admin/support/agent-runs", async (req: any, reply: any) => {
    const actor = await deps.requireSuper(req, reply);
    if (!actor) return reply;

    const parsed = runSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: "invalid_request", message: "Send at least a runId and a ticketRef.", detail: parsed.error.issues.slice(0, 4) });
    }
    const b = parsed.data;
    const escalationId = await resolveEscalationId(db, b.ticketRef).catch(() => null);

    const data: Record<string, unknown> = {
      ticketRef: b.ticketRef.toUpperCase(),
      lane: b.lane,
      status: b.status,
      attempt: b.attempt,
      escalationId,
    };
    // ⛔ Only overwrite what was actually sent. A steps-only push during a run
    // must not blank the tenant name the first push established.
    if (b.host) data.host = b.host;
    if (b.sessionId) data.sessionId = b.sessionId;
    if (b.tenantName) data.tenantName = b.tenantName;
    if (b.requestSummary) data.requestSummary = b.requestSummary;
    if (b.steps) data.steps = sanitiseSteps(b.steps);
    if (b.report) data.report = b.report;
    if (b.error) data.error = b.error;
    const started = asDate(b.startedAt);
    if (started) data.startedAt = started;
    const ended = asDate(b.endedAt);
    if (ended) data.endedAt = ended;

    const row = await db.supportAgentRun.upsert({
      where: { id: b.runId },
      create: { id: b.runId, ...data },
      update: data,
    });
    return reply.send({ ok: true, id: row.id, status: row.status });
  });

  /** The console's list. Deliberately light — no steps, no report. */
  app.get("/admin/support/agent-runs", async (req: any, reply: any) => {
    const actor = await deps.requireSuper(req, reply);
    if (!actor) return reply;

    const take = Math.max(1, Math.min(100, Number((req.query as any)?.take) || 30));
    const rows = await db.supportAgentRun.findMany({
      orderBy: { startedAt: "desc" },
      take,
      select: {
        id: true, ticketRef: true, escalationId: true, tenantName: true, requestSummary: true,
        lane: true, status: true, attempt: true, host: true, sessionId: true,
        startedAt: true, endedAt: true, error: true,
      },
    });
    // The step count is what makes a running row feel alive without shipping the steps.
    const counts = await db.supportAgentRun.findMany({
      where: { id: { in: rows.map((r: any) => r.id) } },
      select: { id: true, steps: true },
    });
    const stepCount = new Map(counts.map((c: any) => [c.id, Array.isArray(c.steps) ? c.steps.length : 0]));
    // The CUSTOMER half of each run — was the person told, did they read it,
    // what did they answer. ⛔ This is the difference between "the agent worked"
    // and "the loop closed": three runs on 2026-08-31 were done and the customer
    // was never told, and no screen could say so.
    const escIds = rows.map((r: any) => r.escalationId).filter(Boolean);
    const updates = escIds.length
      ? await db.supportUpdate.findMany({
          where: { escalationId: { in: escIds } },
          select: {
            escalationId: true, status: true, verdict: true,
            deliveredAt: true, readAt: true, answeredAt: true, heldReason: true,
          },
        })
      : [];
    const updateByEsc = new Map<string, any>(updates.map((u: any) => [u.escalationId, u]));
    return reply.send({
      runs: rows.map((r: any) => {
        const u = r.escalationId ? updateByEsc.get(r.escalationId) : null;
        return {
          ...r,
          steps: stepCount.get(r.id) ?? 0,
          elapsedMs: (r.endedAt ? new Date(r.endedAt).getTime() : Date.now()) - new Date(r.startedAt).getTime(),
          customer: u
            ? {
                status: u.status,
                verdict: u.verdict ?? null,
                deliveredAt: u.deliveredAt ?? null,
                readAt: u.readAt ?? null,
                answeredAt: u.answeredAt ?? null,
                heldReason: u.heldReason ?? null,
              }
            : null,
        };
      }),
    });
  });

  /**
   * The loop's loose ends — everything on this list is waiting for a PERSON.
   * Powers the "Needs a person" rail on the Agent runs tab.
   */
  app.get("/admin/support/loop-health", async (req: any, reply: any) => {
    const actor = await deps.requireSuper(req, reply);
    if (!actor) return reply;

    const now = Date.now();
    const [held, notFixed, unreadReplies, doneRuns] = await Promise.all([
      db.supportUpdate.findMany({
        where: { status: "held" },
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: { id: true, ticketRef: true, heldReason: true, updatedAt: true },
      }),
      db.supportUpdate.findMany({
        where: { status: "answered", verdict: "not_fixed", answeredAt: { gte: new Date(now - 14 * 86_400_000) } },
        orderBy: { answeredAt: "desc" },
        take: 10,
        select: { id: true, ticketRef: true, customerNote: true, answeredAt: true },
      }),
      db.supportMessage.findMany({
        where: { direction: "from_customer", readAt: null },
        orderBy: { createdAt: "asc" },
        take: 10,
        select: { id: true, ticketRef: true, body: true, createdAt: true, tenantId: true },
      }),
      // Customer-lane runs that finished but never produced a customer update —
      // the "worked, and the person was never told" class.
      db.supportAgentRun.findMany({
        where: { status: "done", lane: "customer", escalationId: { not: null } },
        orderBy: { startedAt: "desc" },
        take: 30,
        select: { id: true, ticketRef: true, escalationId: true, tenantName: true, endedAt: true },
      }),
    ]);

    const doneEscIds = doneRuns.map((r: any) => r.escalationId).filter(Boolean);
    const toldRows = doneEscIds.length
      ? await db.supportUpdate.findMany({
          where: { escalationId: { in: doneEscIds } },
          select: { escalationId: true },
        })
      : [];
    const told = new Set(toldRows.map((u: any) => u.escalationId));
    const seenRef = new Set<string>();
    const neverTold = doneRuns.filter((r: any) => {
      if (told.has(r.escalationId) || seenRef.has(r.ticketRef)) return false;
      seenRef.add(r.ticketRef);
      return true;
    });

    return reply.send({
      held: held.map((h: any) => ({ ticketRef: h.ticketRef, heldReason: h.heldReason ?? null, at: h.updatedAt })),
      notFixed: notFixed.map((n: any) => ({ ticketRef: n.ticketRef, note: n.customerNote ?? null, at: n.answeredAt })),
      unreadReplies: unreadReplies.map((m: any) => ({
        id: m.id, ticketRef: m.ticketRef ?? null, preview: String(m.body ?? "").slice(0, 160), at: m.createdAt,
      })),
      neverTold: neverTold.map((r: any) => ({ ticketRef: r.ticketRef, tenantName: r.tenantName ?? null, at: r.endedAt })),
    });
  });

  /** One run in full — this is what an operator opens to watch it work. */
  app.get("/admin/support/agent-runs/:id", async (req: any, reply: any) => {
    const actor = await deps.requireSuper(req, reply);
    if (!actor) return reply;

    const id = String((req.params as any)?.id ?? "").trim();
    const row = id ? await db.supportAgentRun.findUnique({ where: { id } }) : null;
    if (!row) return reply.status(404).send({ error: "not_found", message: "No such agent run." });
    return reply.send({
      run: {
        ...row,
        steps: Array.isArray(row.steps) ? row.steps : [],
        elapsedMs: (row.endedAt ? new Date(row.endedAt).getTime() : Date.now()) - new Date(row.startedAt).getTime(),
      },
    });
  });

  /** The watcher says it is alive. */
  app.post("/admin/support/agent-watcher", async (req: any, reply: any) => {
    const actor = await deps.requireSuper(req, reply);
    if (!actor) return reply;

    const parsed = beatSchema.safeParse(req.body || {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", message: "Send a host." });
    const b = parsed.data;
    const data = {
      lastBeatAt: new Date(),
      state: b.state,
      currentTicket: b.currentTicket ?? null,
      usedToday: b.usedToday ?? undefined,
      caps: b.caps ?? undefined,
      lastError: b.lastError ?? null,
      tokenExpiresAt: asDate(b.tokenExpiresAt) ?? null,
      version: b.version ?? undefined,
    };
    await db.supportAgentWatcher.upsert({ where: { host: b.host }, create: { host: b.host, ...data }, update: data });
    return reply.send({ ok: true });
  });

  /**
   * Is it running? ⛔ The console must be able to say "NOT RUNNING" loudly. The
   * whole reason this exists is that silence used to look identical to a quiet
   * week — the watcher was off for three days and three tickets went unseen.
   */
  app.get("/admin/support/agent-watcher", async (req: any, reply: any) => {
    const actor = await deps.requireSuper(req, reply);
    if (!actor) return reply;

    const rows = await db.supportAgentWatcher.findMany({ orderBy: { lastBeatAt: "desc" }, take: 10 });
    const now = Date.now();
    return reply.send({
      watchers: rows.map((w: any) => {
        const ageMs = now - new Date(w.lastBeatAt).getTime();
        return {
          host: w.host,
          state: w.state,
          currentTicket: w.currentTicket,
          usedToday: w.usedToday ?? null,
          caps: w.caps ?? null,
          lastError: w.lastError,
          tokenExpiresAt: w.tokenExpiresAt,
          version: w.version,
          lastBeatAt: w.lastBeatAt,
          ageMs,
          // The poll is 60s, so two missed beats is the earliest honest alarm.
          alive: ageMs < 5 * 60_000,
        };
      }),
    });
  });
}
