/**
 * Routes for the return half of a support ticket.
 *
 *   POST /admin/support/escalations/:reference/agent-report   the watcher hands back
 *   GET  /support/updates                 the customer's widget polls this
 *   POST /support/updates/:id/verdict     they tested it and said whether it works
 *
 * ⛔⛔ THE ONE RULE THIS FILE EXISTS TO HOLD: `technicalReport` never leaves the
 * building. The customer routes select their fields explicitly and there is a
 * test that fails if that projection ever grows. The report names other
 * tenants, file paths and internal systems by construction.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { supportReportReference } from "@connect/shared";
import { recordAgentReport, listUpdatesForUser, markDelivered, recordVerdict } from "./customerUpdate";

type JwtUser = { sub?: string; tenantId?: string };

export type SupportUpdateRouteDeps = {
  db: any;
  /**
   * The support console's own SUPER_ADMIN gate, injected so there is ONE
   * implementation of it.
   *
   * ⛔ This is an /admin route rather than an /internal one ON PURPOSE. The
   * watcher already holds a SUPER_ADMIN token — it is how it reads tickets at
   * all — so an internal door would have meant putting the platform's
   * machine-to-machine secret on a laptop as well, widening that secret's blast
   * radius to buy nothing. Same authority, one credential.
   */
  requireSuper: (req: any, reply: any) => Promise<any> | any;
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void };
};

/**
 * A reference (Q2FJRK) is what the watcher has, because it is what the SMS
 * carries. Resolve it the same way the console does rather than making the
 * caller find a cuid.
 */
export async function resolveEscalationId(db: any, reference: string): Promise<string | null> {
  const needle = String(reference || "").trim().toUpperCase();
  if (!needle) return null;
  if (needle.length > 20) return needle; // already an id
  const rows = await db.agentEscalation.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true },
  });
  const hit = rows.find((r: any) => supportReportReference(r.id).toUpperCase() === needle);
  return hit?.id ?? null;
}

export function registerSupportUpdateRoutes(app: FastifyInstance, deps: SupportUpdateRouteDeps): void {
  const { db } = deps;

  /** The watcher posts the agent's report here when a run finishes. */
  app.post("/admin/support/escalations/:reference/agent-report", async (req: any, reply: any) => {
    const actor = await deps.requireSuper(req, reply);
    if (!actor) return reply;

    const reference = String((req.params as any)?.reference ?? "").trim();
    const parsed = z
      .object({ report: z.string().trim().min(1).max(200_000) })
      .safeParse(req.body || {});
    if (!reference || !parsed.success) {
      return reply.status(400).send({ error: "invalid_request", message: "Send a ticket reference and the report text." });
    }

    const escalationId = await resolveEscalationId(db, reference);
    if (!escalationId) {
      return reply.status(404).send({ error: "not_found", message: `No recent ticket with reference ${reference}.` });
    }

    const out = await recordAgentReport(
      { db, log: deps.log },
      { escalationId, ticketRef: reference.toUpperCase(), report: parsed.data.report },
    );
    if (!out.ok) return reply.status(409).send({ error: "not_applicable", message: out.reason });
    return reply.send({ ok: true, status: out.status, reason: out.reason ?? null });
  });

  /**
   * What the assistant widget polls. Returns only messages that PASSED the
   * safety gate — a held one is invisible here and waits for a person.
   */
  app.get("/support/updates", async (req: any, reply: any) => {
    const user = req.user as JwtUser;
    if (!user?.sub || !user?.tenantId) return reply.status(401).send({ error: "unauthorized" });

    const rows = await listUpdatesForUser(db, user.sub, user.tenantId);
    // Serving it IS delivering it — stamped once, so "delivered" means a human's
    // browser really received it rather than that we intended to send it.
    await markDelivered(
      db,
      rows.filter((r: any) => r.status === "ready").map((r: any) => r.id),
    ).catch(() => {
      /* the badge is worth more than the bookkeeping */
    });

    return reply.send({
      updates: rows.map((r: any) => ({
        id: r.id,
        reference: r.ticketRef,
        message: r.plainMessage,
        at: r.createdAt,
        answered: false,
      })),
    });
  });

  /** They tested it. */
  app.post("/support/updates/:id/verdict", async (req: any, reply: any) => {
    const user = req.user as JwtUser;
    if (!user?.sub || !user?.tenantId) return reply.status(401).send({ error: "unauthorized" });

    const parsed = z
      .object({
        verdict: z.enum(["fixed", "not_fixed"]),
        note: z.string().trim().max(2000).optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        message: "Let us know whether it is working now.",
      });
    }

    const out = await recordVerdict(
      db,
      {
        updateId: String((req.params as any)?.id ?? ""),
        userId: user.sub,
        tenantId: user.tenantId,
        verdict: parsed.data.verdict,
        note: parsed.data.note,
      },
      deps.log,
    );
    if (!out.ok) return reply.status(409).send({ error: "not_applicable", message: out.reason });

    deps.log?.info?.(
      { updateId: (req.params as any)?.id, verdict: parsed.data.verdict, followUp: out.followUp ?? "none" },
      "support-update: customer answered",
    );
    // ⛔ Every sentence here is TRUE by construction. "reinvestigate" means a
    // follow-up ticket really was filed (texted to the owner, re-worked by the
    // agent); "needs_person"/"failed" promise only what actually happened.
    const message =
      parsed.data.verdict === "fixed"
        ? "Thanks for checking — glad that's sorted."
        : out.followUp === "reinvestigate"
          ? "Thanks for telling us — we've sent it back to the team for another look."
          : out.followUp === "needs_person"
            ? "Thanks for telling us. A person is being notified and will take it from here."
            : "Thanks for telling us.";
    return reply.send({ ok: true, message });
  });
}
