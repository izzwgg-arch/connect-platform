/**
 * Admin → Onboarding: invite a customer, then read exactly what they did.
 *
 * Built to the mock-up Izzy approved on 2026-08-24. Three screens:
 *   - the invitation list (send / copy / resend / chase)
 *   - one invitation's story, step by step
 *   - the patterns across every sign-up
 *
 * ⛔ SUPER_ADMIN only, like every other route in this area. `requireOwner` is
 * passed in rather than imported so the gate is visible at the call site and a
 * new route cannot quietly forget it.
 */

import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { buildInvitationRow, countByFilter, type InvitationRowInput } from "./invitationList";
import { buildJourneyStory } from "./journeyStory";
import { buildJourneyPatterns } from "./journeyPatterns";
import { queueOnboardingInviteEmail } from "./inviteEmail";
import { onboardingLinkForToken } from "../publicOrigins";

const OPENED_MSG = "Customer opened the sign-up link";
const RETURNED_MSG = "Customer came back to the sign-up link";

/** Timeline markers for sending. Parsed back out to show "Sent 20 Aug". */
export const INVITE_SENT_PREFIX = "Invitation emailed to ";
export const INVITE_RESENT_PREFIX = "Invitation emailed again to ";

function secureToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * ⛔ VALIDATE THE BODY. Found by fuzzing the real route: without this it
 * accepted `{email:{}}` and stored the literal "[object Object]", coerced
 * `{email:123}` to "123", took a 50,000-character company name straight into
 * the database and into an email, 500'd on `{companyName:{toString:"x"}}`
 * (String() on an object whose toString is not a function throws), and — the
 * one that actually matters — stored
 * `a@b.com\r\nBcc: victim@example.com` verbatim in `toEmail`.
 *
 * ⛔ That last one is NOT safe merely because nodemailer happens to flatten
 * CR/LF: a mail header must not depend on a downstream library to be well
 * formed. It is refused here instead.
 *
 * These routes are SUPER_ADMIN-only, so none of this was reachable by a
 * customer — it is hygiene on the one screen that creates customer records
 * and sends the first email a customer ever sees.
 */
const EMAIL_MAX = 254; // RFC 5321
const COMPANY_MAX = 200; // matches createPublicLinkSchema, which this mirrors

const emailField = z
  .string()
  .trim()
  .min(3)
  .max(EMAIL_MAX)
  .refine((v) => !/[\r\n\u0000]/.test(v), "an address cannot contain a line break")
  .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v), "that does not look like an email address");

const createInvitationSchema = z.object({
  email: emailField.optional(),
  companyName: z.string().trim().max(COMPANY_MAX).optional(),
  send: z.boolean().optional().default(false),
});

const resendSchema = z.object({ email: emailField.optional() });

/** One plain-English sentence, never a zod dump. */
function firstProblem(err: z.ZodError, fallback: string): string {
  const issue = err.issues[0];
  if (!issue) return fallback;
  const field = issue.path[0] === "email" ? "email address" : issue.path[0] === "companyName" ? "company name" : "request";
  if (issue.code === "too_big") return `That ${field} is too long.`;
  if (issue.code === "too_small") return `That ${field} is too short.`;
  if (issue.code === "invalid_type") return `That ${field} is not valid.`;
  return issue.message && !/^Invalid/.test(issue.message) ? issue.message : `That ${field} is not valid.`;
}

const RE_REACHED = /^Reached "(.+?)"/;

type EventLite = { submissionId: string; type: string; message: string | null; createdAt: Date };

/**
 * Everything the list needs out of the event stream, in ONE query rather than
 * one per row. With 23 submissions that is a nicety; it stops being one the
 * first time this platform onboards properly.
 */
function summariseEvents(events: EventLite[]) {
  const bySubmission = new Map<
    string,
    { openedAt: Date | null; lastActivityAt: Date | null; currentStepLabel: string | null; inviteSentAt: Date | null }
  >();
  for (const e of events) {
    const cur =
      bySubmission.get(e.submissionId) ?? { openedAt: null, lastActivityAt: null, currentStepLabel: null, inviteSentAt: null };
    const msg = String(e.message ?? "");

    if (msg === OPENED_MSG && !cur.openedAt) cur.openedAt = e.createdAt;
    if (msg.startsWith(INVITE_SENT_PREFIX) || msg.startsWith(INVITE_RESENT_PREFIX)) {
      // The FIRST send is what "Sent 20 Aug" means; a resend does not restart
      // the clock, or a chased customer looks freshly invited.
      if (!cur.inviteSentAt) cur.inviteSentAt = e.createdAt;
    }
    const reached = msg.match(RE_REACHED);
    if (reached) cur.currentStepLabel = reached[1];
    if (msg === OPENED_MSG || msg === RETURNED_MSG || e.type === "AUTOSAVED" || reached || msg.startsWith("Stuck on ")) {
      if (!cur.lastActivityAt || e.createdAt > cur.lastActivityAt) cur.lastActivityAt = e.createdAt;
    }
    bySubmission.set(e.submissionId, cur);
  }
  return bySubmission;
}

export async function registerOnboardingInvitationRoutes(
  app: FastifyInstance,
  requireOwner: (req: any, reply: any) => Promise<{ sub?: string; role?: string } | null>,
) {
  // ── The list ──────────────────────────────────────────────────────────────
  app.get("/admin/onboarding/invitations", async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;

    const rows = await (db as any).onboardingSubmission.findMany({
      orderBy: { updatedAt: "desc" },
      take: 300,
      include: { _count: { select: { requestedExtensions: true } } },
    });
    const ids = rows.map((r: any) => r.id);
    const events: EventLite[] = ids.length
      ? await (db as any).onboardingEvent.findMany({
          where: { submissionId: { in: ids } },
          select: { submissionId: true, type: true, message: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        })
      : [];
    const summary = summariseEvents(events);
    const now = new Date();

    const invitations = rows.map((r: any) => {
      const s = summary.get(r.id) ?? { openedAt: null, lastActivityAt: null, currentStepLabel: null, inviteSentAt: null };
      const input: InvitationRowInput = {
        id: r.id,
        publicToken: r.publicToken,
        companyName: r.companyName,
        contactFirstName: r.contactFirstName,
        contactLastName: r.contactLastName,
        mainEmail: r.mainEmail,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        submittedAt: r.submittedAt,
        paidAt: r.paidAt,
        createdTenantId: r.createdTenantId,
        extensionCount: r._count?.requestedExtensions ?? 0,
        ...s,
      };
      return buildInvitationRow(input, now);
    });

    return { invitations, counts: countByFilter(invitations) };
  });

  // ── Is this address already a Loopcom login? ──────────────────────────────
  // ⛔ The trap this closes: an onboarding email address must be unique across
  // the WHOLE platform, so inviting an address that already has a login runs
  // the entire sign-up and then silently fails to send that person their
  // welcome email at the very end. Catching it as the admin types costs one
  // indexed lookup and saves an hour of confusion.
  app.get("/admin/onboarding/email-check", async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const email = String((req.query as any)?.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) return { taken: false };
    const user = await (db as any).user
      .findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true, status: true, tenant: { select: { name: true } } },
      })
      .catch(() => null);
    if (!user) return { taken: false };
    return { taken: true, tenantName: String(user.tenant?.name || "").trim() || null, userStatus: user.status ?? null };
  });

  // ── Create a link, and optionally email it ────────────────────────────────
  app.post("/admin/onboarding/invitations", async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const parsed = createInvitationSchema.safeParse((req as any).body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: firstProblem(parsed.error, "That request is not valid.") });
    }
    const email = parsed.data.email ?? "";
    const companyName = parsed.data.companyName ?? "";
    const send = parsed.data.send;

    if (send && !email) {
      return reply.code(400).send({ error: "email_required", message: "Enter an email address to send the invitation to." });
    }

    const token = secureToken();
    const created = await (db as any).onboardingSubmission.create({
      data: {
        publicToken: token,
        companyName: companyName || null,
        mainEmail: email || null,
        status: "INVITE_SENT",
        events: { create: { type: "CREATED", message: "Admin-created link" } },
      },
    });

    const link = onboardingLinkForToken(token);
    if (!send) return { ok: true, submissionId: created.id, link, sent: false };

    const result = await queueOnboardingInviteEmail(db as any, {
      publicToken: token,
      companyName: companyName || null,
      toEmail: email,
    });
    await (db as any).onboardingEvent
      .create({
        data: {
          submissionId: created.id,
          type: "STATUS_CHANGED",
          message: result.sent ? `${INVITE_SENT_PREFIX}${email}` : `Invitation to ${email} could not be sent`,
        },
      })
      .catch(() => {});

    return { ok: true, submissionId: created.id, link, sent: result.sent, emailError: result.error ?? null };
  });

  // ── Resend the SAME link ──────────────────────────────────────────────────
  // ⛔ Never mints a new token. Making a fresh link per chase is exactly how
  // this account ended up with eleven orphaned links nobody could match to a
  // customer, and it would also invalidate nothing — the old link keeps
  // working, so the customer ends up holding two.
  app.post("/admin/onboarding/submissions/:id/resend", async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const { id } = (req.params as any) as { id: string };
    const row = await (db as any).onboardingSubmission.findUnique({
      where: { id },
      select: { id: true, publicToken: true, companyName: true, contactFirstName: true, mainEmail: true, status: true },
    });
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (!row.publicToken) return reply.code(409).send({ error: "no_link", message: "This sign-up has no link to send." });

    const parsedResend = resendSchema.safeParse((req as any).body ?? {});
    if (!parsedResend.success) {
      return reply.code(400).send({ error: "invalid_request", message: firstProblem(parsedResend.error, "That email address is not valid.") });
    }
    const to = parsedResend.data.email ?? String(row.mainEmail ?? "").trim();
    if (!to || !emailField.safeParse(to).success) {
      return reply.code(409).send({ error: "no_email", message: "There's no usable email address on this invitation to send it to." });
    }

    const result = await queueOnboardingInviteEmail(db as any, {
      publicToken: row.publicToken,
      companyName: row.companyName,
      contactName: row.contactFirstName,
      toEmail: to,
    });
    if (!result.sent) {
      return reply.code(502).send({ error: "send_failed", message: "We couldn't queue that email. The link still works — copy it and send it yourself." });
    }
    if (to !== row.mainEmail) {
      await (db as any).onboardingSubmission.update({ where: { id }, data: { mainEmail: to } }).catch(() => {});
    }
    await (db as any).onboardingEvent
      .create({ data: { submissionId: id, type: "STATUS_CHANGED", message: `${INVITE_RESENT_PREFIX}${to}` } })
      .catch(() => {});
    return { ok: true, sent: true, link: result.link };
  });

  // ── One invitation's story ────────────────────────────────────────────────
  app.get("/admin/onboarding/submissions/:id/story", async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const { id } = (req.params as any) as { id: string };
    const row = await (db as any).onboardingSubmission.findUnique({
      where: { id },
      select: {
        id: true,
        publicToken: true,
        companyName: true,
        contactFirstName: true,
        contactLastName: true,
        mainEmail: true,
        status: true,
        createdAt: true,
        submittedAt: true,
        paidAt: true,
        paidAmountCents: true,
        provisionedDid: true,
        numberStatus: true,
        pbxSetupStatus: true,
        setupError: true,
        createdTenantId: true,
        requestedExtensions: { select: { extNumber: true, displayName: true, email: true } },
      },
    });
    if (!row) return reply.code(404).send({ error: "not_found" });

    const events = await (db as any).onboardingEvent.findMany({
      where: { submissionId: id },
      select: { id: true, type: true, message: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    const story = buildJourneyStory(events, row);
    return {
      submission: {
        id: row.id,
        companyName: String(row.companyName || "").trim(),
        contactName: [row.contactFirstName, row.contactLastName].filter(Boolean).join(" ").trim(),
        mainEmail: String(row.mainEmail || "").trim(),
        status: row.status,
        publicPath: row.publicToken ? `/onboarding/${encodeURIComponent(row.publicToken)}` : null,
        paidAmountCents: row.paidAmountCents ?? null,
        provisionedDid: row.provisionedDid ?? null,
        pbxSetupStatus: row.pbxSetupStatus ?? null,
        setupError: row.setupError ?? null,
        createdTenantId: row.createdTenantId ?? null,
        extensions: row.requestedExtensions ?? [],
      },
      story,
    };
  });

  // ── Export the raw story, for analysing later ─────────────────────────────
  app.get("/admin/onboarding/submissions/:id/story.csv", async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const { id } = (req.params as any) as { id: string };
    const row = await (db as any).onboardingSubmission.findUnique({
      where: { id },
      select: { id: true, companyName: true },
    });
    if (!row) return reply.code(404).send({ error: "not_found" });
    const events = await (db as any).onboardingEvent.findMany({
      where: { submissionId: id },
      select: { type: true, message: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = ["when,type,what"];
    for (const e of events) {
      lines.push([esc(new Date(e.createdAt).toISOString()), esc(e.type), esc(e.message)].join(","));
    }
    const name = (String(row.companyName || "signup").trim() || "signup").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename=${JSON.stringify(`${name}-journey.csv`)}`);
    return lines.join("\n");
  });

  // ── Patterns across every sign-up ─────────────────────────────────────────
  app.get("/admin/onboarding/patterns", async (req, reply) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const events = await (db as any).onboardingEvent.findMany({
      where: { type: "STATUS_CHANGED" },
      select: { message: true, createdAt: true },
    });
    const considered = await (db as any).onboardingSubmission.count();
    return buildJourneyPatterns(events, considered);
  });
}
