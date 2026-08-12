/**
 * Agent escalation dispatcher — the delivery half of "passed to the human team".
 *
 * The AGENT detects an escalation mid-chat, researches it, and writes an
 * AgentEscalation row (status QUEUED). This sweeper — living in the api on
 * purpose, because the api redeploys freely while the agent is a manual
 * rebuild — turns each row into:
 *
 *   • an SMS to the owner's phones, FROM Connect's escalation number, carrying
 *     the tenant name, the user's name, the issue and the ready-to-approve fix
 *   • an EmailJob (type AGENT_ESCALATION) with the full report to the alert
 *     inbox — the ONLY mail category still allowed to reach that inbox
 *
 * Owner directive (Izzy, 2026-08-12): SMS to (562) 209-6644 and (845) 723-1213,
 * from (845) 557-7768; email to the alert address; every other alert to that
 * address stops (see the ADMIN_ALERT gate in processEmailJobsBatch).
 *
 * SAFETY: a runaway agent bug must not text the owner's phone all night. SMS
 * sends are capped per rolling 24h; over the cap, the email still goes out and
 * the SMS is skipped with the cap noted on the row. Rows retry a few times and
 * then park as FAILED — visible, never silently dropped.
 */

import { db } from "@connect/db";
import { resolvePlatformSmsSender, normalizeUsPhone } from "./billing/billingSmsSender";

const ESCALATION_SMS_FROM = () => normalizeUsPhone(process.env.AGENT_ESCALATION_SMS_FROM) || "+18455577768";
const ESCALATION_SMS_TO = (): string[] =>
  (process.env.AGENT_ESCALATION_SMS_TO || "+15622096644,+18457231213")
    .split(",")
    .map((v) => normalizeUsPhone(v))
    .filter((v): v is string => !!v);
const ESCALATION_EMAIL = () => (process.env.AGENT_ESCALATION_EMAIL || "tod10950@gmail.com").trim();
const SMS_DAILY_CAP = () => Math.max(1, Number(process.env.AGENT_ESCALATION_SMS_DAILY_CAP || 40));
const MAX_ATTEMPTS = 4;

let running = false;

export async function dispatchAgentEscalationsBatch(log?: { info: (o: any, m: string) => void; warn: (o: any, m: string) => void }): Promise<void> {
  if (running) return;
  running = true;
  try {
    const rows = await (db as any).agentEscalation.findMany({
      where: { status: { in: ["QUEUED", "FAILED"] }, attempts: { lt: MAX_ATTEMPTS } },
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    if (!rows.length) return;

    for (const row of rows) {
      await (db as any).agentEscalation.update({ where: { id: row.id }, data: { attempts: row.attempts + 1 } });
      const errors: string[] = [];

      // ── SMS (both numbers, capped per rolling 24h) ────────────────────────
      let smsSentAt: Date | null = row.smsSentAt ?? null;
      if (!smsSentAt) {
        const since = new Date(Date.now() - 24 * 3600 * 1000);
        const sentToday = await (db as any).agentEscalation.count({ where: { smsSentAt: { gte: since } } });
        if (sentToday >= SMS_DAILY_CAP()) {
          errors.push(`sms_daily_cap (${sentToday}/${SMS_DAILY_CAP()}) — email still sent`);
        } else {
          const sender = await resolvePlatformSmsSender(ESCALATION_SMS_FROM());
          if (!sender.ok) {
            errors.push(`sms_unavailable: ${sender.error}`);
          } else {
            let delivered = 0;
            for (const to of ESCALATION_SMS_TO()) {
              try {
                await sender.send({ tenantId: row.tenantId, to, body: row.smsBody });
                delivered++;
              } catch (err: any) {
                errors.push(`sms_to_${to}: ${String(err?.message || err).slice(0, 160)}`);
              }
            }
            // Partial delivery counts as sent — the point is that the owner's
            // phone rang; a one-number carrier hiccup must not re-text the
            // other number on every retry.
            if (delivered > 0) smsSentAt = new Date();
          }
        }
      }

      // ── Email (full report) — rides the EmailJob queue for quota visibility ─
      let emailQueuedAt: Date | null = row.emailQueuedAt ?? null;
      if (!emailQueuedAt) {
        try {
          const subject = `[Connect Assistant] Escalation — ${row.tenantName} / ${row.userName}`;
          const textBody = [
            `Company: ${row.tenantName}`,
            `User: ${row.userName}${row.userEmail ? ` <${row.userEmail}>` : ""}`,
            `Conversation: ${row.conversationId ?? "n/a"}`,
            row.researchDegraded ? `NOTE: research was unavailable — raw request below.` : ``,
            ``,
            row.report,
          ].filter(Boolean).join("\n");
          await db.emailJob.create({
            data: {
              tenantId: row.tenantId,
              type: "AGENT_ESCALATION",
              toEmail: ESCALATION_EMAIL(),
              subject,
              textBody,
              htmlBody: `<pre style="font-family:inherit;white-space:pre-wrap">${textBody
                .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`,
            },
          });
          emailQueuedAt = new Date();
        } catch (err: any) {
          errors.push(`email_queue: ${String(err?.message || err).slice(0, 160)}`);
        }
      }

      const done = !!emailQueuedAt && (!!smsSentAt || errors.some((e) => e.startsWith("sms_daily_cap")));
      await (db as any).agentEscalation.update({
        where: { id: row.id },
        data: {
          smsSentAt,
          emailQueuedAt,
          status: done ? "SENT" : "FAILED",
          lastError: errors.length ? errors.join(" | ").slice(0, 900) : null,
        },
      });
      (done ? log?.info : log?.warn)?.(
        { escalationId: row.id, tenantName: row.tenantName, userName: row.userName, smsSent: !!smsSentAt, emailQueued: !!emailQueuedAt, errors },
        done ? "agent escalation dispatched" : "agent escalation dispatch incomplete",
      );
    }
  } finally {
    running = false;
  }
}
