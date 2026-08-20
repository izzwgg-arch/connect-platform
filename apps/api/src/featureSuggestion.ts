/**
 * "Suggest a feature" — the customer's way to ask for something new.
 *
 * ⛔ THIS IS DELIBERATELY NOT THE SUPPORT-REPORT PATH. "Report a problem"
 * (supportReport.ts) writes an AgentEscalation, which texts the owner's phones —
 * the right thing for a dead phone system and the wrong thing for an idea. A
 * suggestion is an EMAIL to the product inbox and nothing else; nobody's phone
 * rings at 2am for a feature request. supportReport.test.ts pins that the
 * report module never grows its own emailJob.create — which is exactly why this
 * lives in its own file rather than beside it.
 *
 * ⛔ THE EMAIL TYPE MUST NEVER BE "ADMIN_ALERT". The send door in server.ts
 * drops every ADMIN_ALERT job with lastErrorCode ALERTS_MUTED (owner directive
 * 2026-08-12) — a suggestion filed on that type would build clean, log clean
 * and reach nobody. Same rule as PORT_COMPLETE and E911_ACTIVATED; a test
 * asserts it.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import {
  FEATURE_SUGGESTION_MAX,
  FEATURE_SUGGESTION_MIN,
  buildFeatureSuggestionEmail,
} from "@connect/shared";
import type { JwtUser } from "./connectChatRoutes";

/** Any string OTHER than ADMIN_ALERT sends; ADMIN_ALERT is muted at the send door. */
export const FEATURE_SUGGESTION_EMAIL_TYPE = "FEATURE_SUGGESTION";

/**
 * Where suggestions land. ⛔ info@loopcom.net is Izzy's explicit destination
 * (2026-08-20) — a literal on purpose, because it is a mail RECIPIENT, not a
 * platform link, so it must not follow PLATFORM_MAIL_DOMAIN (which still
 * defaults to the old domain). Env-overridable so a mailbox change is a
 * restart, not a deploy.
 */
const SUGGESTION_INBOX = () => (process.env.FEATURE_SUGGESTION_EMAIL || "info@loopcom.net").trim();

/**
 * Generous for a person with ideas, tight enough that a stuck retry loop in a
 * browser cannot spend the shared mailbox's 500/day send allowance — every
 * email the platform sends rides one Google mailbox (CLAUDE.md, the mail-quota
 * outage of 2026-08-06).
 */
const PER_USER_LIMIT = Number(process.env.FEATURE_SUGGESTION_USER_DAILY_LIMIT || 5);
const PER_TENANT_LIMIT = Number(process.env.FEATURE_SUGGESTION_TENANT_DAILY_LIMIT || 15);
const WINDOW_MS = 24 * 60 * 60 * 1000;

function personName(u: { displayName?: string | null; firstName?: string | null; lastName?: string | null; email: string }): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return (u.displayName || full || u.email).trim();
}

export function registerFeatureSuggestionRoutes(app: FastifyInstance): void {
  app.post("/support/feature-suggestion", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!user?.sub || !user?.tenantId) return reply.status(401).send({ error: "unauthorized" });

    const parsed = z
      .object({
        suggestion: z.string().trim().min(FEATURE_SUGGESTION_MIN).max(FEATURE_SUGGESTION_MAX),
        page: z.string().trim().max(80).optional(),
      })
      // ⛔ safeParse, not parse — the portal renders the `message` field
      // verbatim, and a raw zod throw would show the customer a slug.
      .safeParse(req.body || {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_suggestion",
        message: "Please tell us a little more about the feature you'd like.",
      });
    }
    const input = parsed.data;

    const since = new Date(Date.now() - WINDOW_MS);
    const [userRecent, tenantRecent] = await Promise.all([
      db.auditLog.count({
        where: { actorUserId: user.sub, action: "FEATURE_SUGGESTION_SENT", createdAt: { gte: since } },
      }),
      db.emailJob.count({
        where: { tenantId: user.tenantId, type: FEATURE_SUGGESTION_EMAIL_TYPE, createdAt: { gte: since } },
      }),
    ]);
    if (userRecent >= PER_USER_LIMIT || tenantRecent >= PER_TENANT_LIMIT) {
      // Never a bare refusal — say what happened and what to do instead.
      return reply.status(429).send({
        error: "too_many_suggestions",
        message: "Thanks — we've got your recent suggestions and a person will read them. Give it a day before sending more.",
      });
    }

    const [tenant, me] = await Promise.all([
      db.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } }),
      db.user.findUnique({
        where: { id: user.sub },
        select: { email: true, displayName: true, firstName: true, lastName: true },
      }),
    ]);

    const mail = buildFeatureSuggestionEmail({
      tenantName: tenant?.name || "Unknown company",
      userName: me ? personName(me) : user.email || "Unknown user",
      userEmail: me?.email || user.email || null,
      suggestion: input.suggestion,
      page: input.page || null,
    });

    // The email job and the audit row land together or not at all — the audit
    // row is what the per-user limit counts, so it must never over- or
    // under-count what was actually queued.
    try {
      await db.$transaction(async (tx) => {
        const job = await tx.emailJob.create({
          data: {
            tenantId: user.tenantId,
            invoiceId: null,
            type: FEATURE_SUGGESTION_EMAIL_TYPE,
            toEmail: SUGGESTION_INBOX(),
            subject: mail.subject,
            htmlBody: mail.html,
            textBody: mail.text,
          },
          select: { id: true },
        });
        await tx.auditLog.create({
          data: {
            tenantId: user.tenantId,
            action: "FEATURE_SUGGESTION_SENT",
            entityType: "EmailJob",
            entityId: job.id,
            actorUserId: user.sub,
            metadata: { page: input.page || null },
          },
        });
      });
    } catch (err: any) {
      req.log?.error?.({ err: String(err?.message || err), userId: user.sub }, "[FEATURE_SUGGESTION] could not queue suggestion");
      return reply.status(500).send({
        error: "suggestion_not_sent",
        message: "We couldn't send that just now. Please try again in a minute.",
      });
    }

    req.log?.info?.({ userId: user.sub, tenantId: user.tenantId, page: input.page || null }, "[FEATURE_SUGGESTION] queued");
    return reply.send({ ok: true });
  });
}
