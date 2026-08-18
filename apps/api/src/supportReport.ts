/**
 * "Something not working?" — filing a customer's fault report.
 *
 * ⛔ WHY THIS EXISTS AT ALL, because it looks like a duplicate of the assistant
 * and is not. Until now the only route from a customer to Izzy ran through the
 * AGENT noticing that its own reply promised to pass something along
 * (`apps/agent/src/escalation/escalations.ts` matches the assistant's REPLY
 * text). When the model volunteers, an AgentEscalation row is written and the
 * owner's phone rings. When it doesn't, nothing happens and nobody is told —
 * silently. A customer whose phones are dead had to phrase the problem well
 * enough to talk the assistant into escalating.
 *
 * This route writes the escalation itself, from what the customer typed. No
 * model in the path, nothing to match, nothing to hope for.
 *
 * ⛔ IT DELIBERATELY REUSES THE EXISTING DELIVERY HALF. `agentEscalationDispatch.ts`
 * already turns a QUEUED AgentEscalation into an SMS to the owner's phones and
 * an AGENT_ESCALATION email — the one mail category the platform-wide alert
 * mute still lets through. A second delivery path would be a second thing to
 * keep working, and the first one to rot. Everything here ends at that row.
 *
 * ⛔ FAILURE DIRECTION: the escalation is written FIRST and everything else is
 * best-effort. The text thread, the customer's confirmation and the audit row
 * may all fail without losing the report. The reverse order — confirming to
 * the customer and then failing to record it — would tell someone their dead
 * phone system had been reported when it had not.
 */
import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import { z } from "zod";
import { db } from "@connect/db";
import {
  SUPPORT_REPORT_AREA_IDS,
  SUPPORT_REPORT_NO_FIX,
  SUPPORT_REPORT_PROBLEM_MAX,
  SUPPORT_REPORT_PROBLEM_MIN,
  buildSupportReportEmail,
  buildSupportReportSms,
  supportReportCustomerSms,
  supportReportReference,
  supportReportSummary,
  type SupportReportInput,
} from "@connect/shared";
import { normalizeUsPhone } from "./billing/billingSmsSender";
import { findOrCreateConnectChatSmsThread, sendConnectChatSmsMessage, type JwtUser } from "./connectChatRoutes";

/**
 * How often one person can page the owner's phone. Generous enough for a real
 * outage (report it, remember a detail, report again) and low enough that a
 * stuck retry loop in a browser cannot text him all night.
 *
 * ⛔ These count EVERY escalation from the person, including ones the assistant
 * raised on their behalf. That is deliberate: the limit protects one phone, and
 * that phone does not care which door the message came through.
 */
const PER_USER_LIMIT = Number(process.env.SUPPORT_REPORT_USER_HOURLY_LIMIT || 3);
const PER_USER_WINDOW_MS = 60 * 60 * 1000;
const PER_TENANT_LIMIT = Number(process.env.SUPPORT_REPORT_TENANT_DAILY_LIMIT || 12);
const PER_TENANT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The number the owner's escalations already come from — see agentEscalationDispatch. */
const SUPPORT_DESK_NUMBER = () => normalizeUsPhone(process.env.AGENT_ESCALATION_SMS_FROM) || "+18455577768";

type SupportDesk = { tenantId: string; user: JwtUser };

/**
 * Who sends the customer's confirmation text, and where that conversation
 * lives. ⛔ It is the ADMIN tenant that owns the support number — NOT the
 * customer's own tenant. A thread on their tenant would send from THEIR number
 * (so the customer would be texting themselves) and would sit in an inbox their
 * colleagues can read. This one lands in the same admin inbox as every reply to
 * an escalation, which is where Izzy already looks.
 *
 * Returns null rather than throwing: no support desk means no text thread, and
 * the report must still be filed.
 */
async function resolveSupportDesk(): Promise<SupportDesk | null> {
  const phoneE164 = SUPPORT_DESK_NUMBER();
  const numberRow = await db.tenantSmsNumber.findFirst({
    where: { phoneE164, tenantId: { not: null } },
    select: { tenantId: true },
  });
  const tenantId = numberRow?.tenantId;
  if (!tenantId) return null;
  // A SUPER_ADMIN if that tenant has one, otherwise its longest-standing admin.
  // ⛔ Never an admin from a DIFFERENT tenant — the send path scopes the thread
  // and its participants to one tenant, and a cross-tenant sender would be
  // refused at the participant check in a way that reads like a broken feature.
  const admin =
    (await db.user.findFirst({
      where: { tenantId, role: "SUPER_ADMIN", status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, role: true },
    })) ??
    (await db.user.findFirst({
      where: { tenantId, role: "TENANT_ADMIN", status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, role: true },
    }));
  if (!admin) return null;
  return { tenantId, user: { sub: admin.id, tenantId, email: admin.email, role: String(admin.role) } };
}

function personName(u: { displayName?: string | null; firstName?: string | null; lastName?: string | null; email: string }): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return (u.displayName || full || u.email).trim();
}

export function registerSupportReportRoutes(app: FastifyInstance, deps: { smsQueue: Queue }): void {
  /**
   * What the report form can fill in for them. Kept separate from the panel's
   * own opening so the assistant costs nothing extra to open — this is only
   * fetched once someone actually taps "Something not working?".
   */
  app.get("/support/context", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!user?.sub) return reply.status(401).send({ error: "unauthorized" });
    const row = await db.user.findUnique({ where: { id: user.sub }, select: { phone: true } });
    return reply.send({ callbackPhone: normalizeUsPhone(row?.phone || "") || null });
  });

  app.post("/support/report", async (req, reply) => {
    const user = req.user as JwtUser;
    if (!user?.sub || !user?.tenantId) return reply.status(401).send({ error: "unauthorized" });

    const parsed = z
      .object({
        problem: z.string().trim().min(SUPPORT_REPORT_PROBLEM_MIN).max(SUPPORT_REPORT_PROBLEM_MAX),
        area: z.enum(SUPPORT_REPORT_AREA_IDS as unknown as [string, ...string[]]),
        urgent: z.boolean().optional().default(false),
        callbackPhone: z.string().trim().min(7).max(32),
        page: z.string().trim().max(80).optional(),
      })
      // ⛔ safeParse, not parse: this is the one screen a customer reaches when
      // something is already broken. A raw validation throw would render as an
      // error code in the panel — see the portal's .body/.payload trap.
      .safeParse(req.body || {});
    if (!parsed.success) {
      const tooShort = parsed.error.issues.some((i) => i.path[0] === "problem");
      return reply.status(400).send({
        error: "invalid_report",
        message: tooShort
          ? "Please tell us a little more about what's happening."
          : "Something in that report didn't look right. Please check it and try again.",
      });
    }
    const input = parsed.data;

    const callbackPhone = normalizeUsPhone(input.callbackPhone);
    if (!callbackPhone) {
      return reply.status(400).send({
        error: "invalid_phone",
        message: "That doesn't look like a US phone number we can call back on.",
      });
    }

    const now = Date.now();
    const [userRecent, tenantRecent] = await Promise.all([
      (db as any).agentEscalation.count({
        where: { clientUserId: user.sub, createdAt: { gte: new Date(now - PER_USER_WINDOW_MS) } },
      }),
      (db as any).agentEscalation.count({
        where: { tenantId: user.tenantId, createdAt: { gte: new Date(now - PER_TENANT_WINDOW_MS) } },
      }),
    ]);
    if (userRecent >= PER_USER_LIMIT || tenantRecent >= PER_TENANT_LIMIT) {
      // ⛔ Never a bare "too many requests". Someone hitting this limit is
      // someone with a problem we have already been told about — the useful
      // answer is how to reach a person right now.
      return reply.status(429).send({
        error: "too_many_reports",
        message: "We already have your last report and we're on it. If it's urgent, call us on (845) 723-1213.",
      });
    }

    const [tenant, me] = await Promise.all([
      db.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true } }),
      db.user.findUnique({
        where: { id: user.sub },
        select: { email: true, displayName: true, firstName: true, lastName: true },
      }),
    ]);

    const base: Omit<SupportReportInput, "reference"> = {
      tenantName: tenant?.name || "Unknown company",
      userName: me ? personName(me) : user.email || "Unknown user",
      userEmail: me?.email || user.email || null,
      problem: input.problem,
      area: input.area,
      urgent: !!input.urgent,
      callbackPhone,
      page: input.page || null,
    };

    // ⛔ The reference is derived from the row's own id, so the row has to exist
    // before its own text can be composed. Both writes run in ONE transaction:
    // the dispatcher sweeps QUEUED rows every 30s and must never be able to
    // read the placeholder — outside a transaction that race sends an empty
    // report to the owner's phone.
    let row: { id: string };
    try {
      row = await db.$transaction(async (tx) => {
        const created = await (tx as any).agentEscalation.create({
          data: {
            tenantId: user.tenantId,
            tenantName: base.tenantName,
            clientUserId: user.sub,
            userName: base.userName,
            userEmail: base.userEmail,
            requestSummary: "…",
            smsBody: "…",
            report: "…",
            proposedFix: SUPPORT_REPORT_NO_FIX,
            researchDegraded: false,
            status: "QUEUED",
          },
          select: { id: true },
        });
        const full: SupportReportInput = { ...base, reference: supportReportReference(created.id) };
        return (tx as any).agentEscalation.update({
          where: { id: created.id },
          data: {
            requestSummary: supportReportSummary(full),
            smsBody: buildSupportReportSms(full),
            report: buildSupportReportEmail({ ...full, textThreadNote: "Text thread: opening…" }),
          },
          select: { id: true },
        });
      });
    } catch (err: any) {
      req.log?.error?.({ err: String(err?.message || err), userId: user.sub }, "[SUPPORT_REPORT] could not file report");
      return reply.status(500).send({
        error: "report_not_filed",
        message: "We couldn't send that just now. Please call us on (845) 723-1213 and we'll pick it up straight away.",
      });
    }

    const full: SupportReportInput = { ...base, reference: supportReportReference(row.id) };

    // ── Everything below is best-effort. The report is already filed. ────────
    let confirmationTexted = false;
    let threadNote = "Text thread: not opened (no support desk number configured).";
    try {
      const desk = await resolveSupportDesk();
      if (desk) {
        const thread = await findOrCreateConnectChatSmsThread({
          tenantId: desk.tenantId,
          userId: desk.user.sub,
          externalPhone: callbackPhone,
          title: `Support — ${base.tenantName}`,
        });
        if (thread.ok) {
          const sent = await sendConnectChatSmsMessage({
            deps,
            user: desk.user,
            tenantId: desk.tenantId,
            threadId: thread.threadId,
            body: supportReportCustomerSms({ reference: full.reference, urgent: full.urgent }),
          });
          confirmationTexted = sent.ok;
          threadNote = sent.ok
            ? `Text thread with ${callbackPhone} is open — reply to it in Chat and it reaches them.`
            : `Text thread opened but the confirmation text failed (${"error" in sent ? sent.error : "unknown"}). Nobody has texted them.`;
        } else {
          threadNote = `Text thread could not be opened (${thread.error}). Call ${callbackPhone} instead.`;
        }
      }
    } catch (err: any) {
      threadNote = `Text thread failed: ${String(err?.message || err).slice(0, 160)}. Call ${callbackPhone} instead.`;
    }

    // Fold the outcome into the email body. ⛔ Best-effort by design: if the
    // dispatcher already sent the email, the note simply isn't in it — a late
    // note is worth having, a delayed report is not.
    await (db as any).agentEscalation
      .update({ where: { id: row.id }, data: { report: buildSupportReportEmail({ ...full, textThreadNote: threadNote }) } })
      .catch(() => undefined);

    await db.auditLog
      .create({
        data: {
          tenantId: user.tenantId,
          action: "SUPPORT_REPORT_FILED",
          entityType: "AgentEscalation",
          entityId: row.id,
          actorUserId: user.sub,
          metadata: {
            reference: full.reference,
            area: full.area,
            urgent: full.urgent,
            page: full.page,
            confirmationTexted,
          },
        },
      })
      .catch(() => undefined);

    req.log?.info?.(
      { escalationId: row.id, reference: full.reference, urgent: full.urgent, area: full.area, confirmationTexted },
      "[SUPPORT_REPORT] filed",
    );

    return reply.send({
      ok: true,
      reference: full.reference,
      callbackPhone,
      confirmationTexted,
    });
  });
}
