/**
 * SMS-to-email FORWARD guardrail — the alarm the forward half never had.
 *
 * The bridge emails a copy of every inbound text to the people on that
 * conversation. Two ways it can lose one, both found by load-stressing it on
 * 2026-08-24 and both previously INVISIBLE:
 *
 *   • the forward job only considers texts inside a short FRESH WINDOW (30 min
 *     by default). Anything not emailed inside that window is never emailed and
 *     never stamped — it just quietly disappears from scope. A stopped job, a
 *     database problem or a burst past the throughput ceiling (measured: 480
 *     texts per window) all end there.
 *   • an SMTP refusal used to return silently. It is audited now
 *     (`sms.email_send_failed`), but an audit row nobody reads is not an alarm.
 *
 * So this watches the OUTCOME, not the machinery: a text that aged out unsent is
 * a customer who was never told someone messaged them.
 *
 * ⛔ RAISES AN ESCALATION — never an ADMIN_ALERT. ADMIN_ALERT is SKIPPED at the
 *    send door platform-wide, so an alarm on that type builds clean, logs clean
 *    and reaches nobody. A guard test forbids it, and forbids this file growing
 *    its own email path.
 * ⛔ DE-DUPED OVER A WINDOW, deliberately NOT `raiseGuardrailEscalation`: that
 *    de-dupes on any open escalation with no time bound, and
 *    AgentEscalationStatus has no RESOLVED value, so each key would fire exactly
 *    ONCE, EVER. Texts going missing must keep nagging while it is happening.
 * ⛔ WRITES AN AUDIT ROW ON EVERY RUN, including clean ones, with `actor` AND
 *    `hash` — Prisma rejects the row without them, which is how an earlier
 *    monitor went blind while still logging that it was armed. **Proof it works
 *    is the row, never the boot line.**
 */
import { createHash } from "node:crypto";
import { db } from "@connect/db";

type Log = { info?: (o: any, m?: string) => void; warn?: (o: any, m?: string) => void };

/** The platform's own tenant, which owns platform-level escalations. */
const PLATFORM_TENANT_ID = "connect-admin-tenant-v1";

export const SWEEP_EVENT = "sms_forward.guardrail";
export const ALARM_KEY = "Text-message emails are being lost";
export const SEND_FAILURE_ALARM_KEY = "Text-message emails are failing to send";

/**
 * ⛔ THE CUTOVER IS WHAT STOPS A BACK-CATALOGUE BURST. There are 1,374 inbound
 * texts from before the bridge existed that were never in the job's scope and
 * are permanently unstamped; without this the first run would report every one
 * of them as lost. Measured 2026-08-24: unstamped texts AFTER this moment = 0,
 * so the baseline is exactly zero by construction and any hit is real.
 */
export const DEFAULT_CUTOVER_AT = "2026-08-20T11:36:00.000Z";

/** Mirrors the forward job's own window (apps/agent AGENT_SMS_EMAIL_FRESH_WINDOW_MIN). */
export const DEFAULT_FRESH_WINDOW_MIN = 30;
/** Grace on top of the window so a text the job is still allowed to send is never alarmed on. */
export const AGED_OUT_GRACE_MS = 5 * 60_000;

/** One lost text is a real loss; the measured baseline is 0, so this cannot false-positive. */
export const AGED_OUT_THRESHOLD = 1;
/**
 * An SMTP outage is audited once per PASS. At a 30s poll three rows is ~90
 * seconds of failing — long enough not to fire on a single blip, and ~28 minutes
 * before the fresh window starts destroying texts.
 */
export const SEND_FAILURE_WINDOW_MS = 30 * 60_000;
export const SEND_FAILURE_THRESHOLD = 3;
/** A persistent stamp failure means a database write problem, not a lost text. */
export const STAMP_FAILURE_WINDOW_MS = 60 * 60_000;
export const STAMP_FAILURE_THRESHOLD = 5;

export const GUARDRAIL_INTERVAL_MS = 10 * 60_000;
/**
 * ⛔ A bare setInterval is starved to nothing on a busy deploy day — the
 * voicemail watchdog's 67 silent minutes. The boot kick is mandatory beside it.
 */
export const GUARDRAIL_BOOT_DELAY_MS = 6 * 60_000;
export const DEFAULT_ALERT_WINDOW_MS = 6 * 60 * 60_000;

export interface SmsForwardAlarm {
  key: string;
  summary: string;
  sms: string;
  report: string;
}

export interface SmsForwardGuardrailInput {
  /** Inbound texts past the fresh window with no verdict at all. */
  agedOut: number;
  /** A few of them, for the report. */
  agedOutSample: Array<{ company: string; at: string }>;
  /** Passes that could not reach SMTP, recently. */
  sendFailurePasses: number;
  /** Rows the job emailed but could not mark done, recently. */
  stampFailures: number;
}

/**
 * PURE. Given what the database says, which alarms should fire.
 *
 * Aged-out and send-failure are deliberately SEPARATE alarms: the first is a
 * damage report (those texts are already gone), the second is an early warning
 * while the texts are still recoverable. Collapsing them would lose the
 * distinction that decides whether anyone needs to act in the next 20 minutes.
 */
export function decideSmsForwardAlarms(input: SmsForwardGuardrailInput): SmsForwardAlarm[] {
  const alarms: SmsForwardAlarm[] = [];

  if (input.agedOut >= AGED_OUT_THRESHOLD) {
    const who = input.agedOutSample.length
      ? input.agedOutSample.map((s) => `${s.company} (${s.at})`).join(", ")
      : "unknown";
    alarms.push({
      key: ALARM_KEY,
      summary: `${ALARM_KEY} — ${input.agedOut} text${input.agedOut === 1 ? "" : "s"} were never emailed`,
      sms: truncateAscii(
        `Loopcom: ${input.agedOut} inbound text${input.agedOut === 1 ? "" : "s"} were never emailed to the customer. They are past the resend window and will not be retried.`,
      ),
      report: [
        `${input.agedOut} inbound text message${input.agedOut === 1 ? " was" : "s were"} never emailed to the people on the conversation.`,
        "",
        "They are older than the forward job's fresh window, so the job will not pick them up again. Nothing will retry them.",
        "",
        `Earliest affected: ${who}`,
        "",
        "Most likely causes, in order: the agent container is not running the forward job; SMTP has been refusing for longer than the window; or a burst went past the throughput ceiling (480 texts per 30-minute window).",
        "",
        "Check: docker logs app-agent-1 | grep sms; and the sms.email_send_failed / sms.email_stamp_failed rows in AgentAuditLog.",
      ].join("\n"),
    });
  }

  if (input.sendFailurePasses >= SEND_FAILURE_THRESHOLD) {
    alarms.push({
      key: SEND_FAILURE_ALARM_KEY,
      summary: `${SEND_FAILURE_ALARM_KEY} — ${input.sendFailurePasses} passes refused`,
      sms: truncateAscii(
        `Loopcom: text-message emails are not sending (${input.sendFailurePasses} failed passes). Texts are still recoverable for about 30 minutes, then they are lost.`,
      ),
      report: [
        `The forward job has been unable to send for ${input.sendFailurePasses} passes.`,
        "",
        "This is the RECOVERABLE stage: the texts are still inside the fresh window and will be emailed as soon as SMTP works again. Once they age out of that window they are gone for good and nothing retries them.",
        "",
        "Check the bridge mailbox credentials (AGENT_SMS_SMTP_*) and whether Google is refusing — the one mailbox is capped at 500 sends a day and is shared with invoices and voicemail notifications.",
      ].join("\n"),
    });
  }

  if (input.stampFailures >= STAMP_FAILURE_THRESHOLD) {
    alarms.push({
      key: "Text-message emails cannot be marked done",
      summary: `Text-message emails cannot be marked done — ${input.stampFailures} in the last hour`,
      sms: truncateAscii(
        `Loopcom: the text-email bridge is emailing but cannot record it (${input.stampFailures} failures/hour). Customers may get a duplicate.`,
      ),
      report: [
        `${input.stampFailures} texts were emailed but could not be marked as done in the last hour.`,
        "",
        "The email went out; only the record failed. An in-process guard means each affected text costs at most ONE duplicate rather than one per pass, but it points at a database write problem.",
      ].join("\n"),
    });
  }

  return alarms;
}

/** ⛔ Plain ASCII, single line: one emoji flips the whole SMS to UCS-2 and 160 chars becomes 70. */
function truncateAscii(s: string, max = 300): string {
  const flat = s.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}.` : flat;
}

function auditRow(event: string, payload: Record<string, unknown>) {
  const body = { actor: "system", event, ts: new Date().toISOString(), payload };
  return {
    actor: body.actor,
    event: body.event,
    payload: body.payload,
    // ⛔ `hash` has no default; mirror how the agent hashes the row body.
    hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
}

/** De-duped over a WINDOW so it keeps nagging while the problem stands. */
export async function raiseSmsForwardEscalation(
  alarm: SmsForwardAlarm,
  opts: { windowMs: number; log?: Log; database?: any },
): Promise<boolean> {
  const database = opts.database ?? db;
  try {
    const since = new Date(Date.now() - opts.windowMs);
    const recent = await database.agentEscalation.findFirst({
      where: { requestSummary: { startsWith: alarm.key }, createdAt: { gte: since } },
      select: { id: true },
    });
    if (recent) {
      opts.log?.info?.({ existing: recent.id, key: alarm.key }, "sms-forward-guardrail: already alerted inside the window");
      return false;
    }
    await database.agentEscalation.create({
      data: {
        tenantId: PLATFORM_TENANT_ID,
        tenantName: "Loopcom platform",
        clientUserId: null,
        userName: "sms forward guardrail",
        userEmail: null,
        requestSummary: alarm.summary,
        smsBody: alarm.sms,
        report: alarm.report,
        proposedFix: null,
        researchDegraded: false,
        status: "QUEUED",
      },
    });
    opts.log?.warn?.({ key: alarm.key }, "sms-forward-guardrail: escalation raised");
    return true;
  } catch (err) {
    opts.log?.warn?.({ err: (err as Error)?.message, key: alarm.key }, "sms-forward-guardrail: could not raise escalation");
    return false;
  }
}

function freshWindowMs(): number {
  const min = Number(process.env.AGENT_SMS_EMAIL_FRESH_WINDOW_MIN || DEFAULT_FRESH_WINDOW_MIN) || DEFAULT_FRESH_WINDOW_MIN;
  return min * 60_000;
}

function cutoverAt(): Date {
  const raw = process.env.SMS_FORWARD_GUARDRAIL_CUTOVER_AT || DEFAULT_CUTOVER_AT;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date(DEFAULT_CUTOVER_AT) : d;
}

/**
 * One pass. Never throws — a guard that can crash the process it protects is a
 * liability. Always leaves an audit row, clean or not.
 */
export async function runSmsForwardGuardrail(
  log: Log,
  database: any = db,
  now: Date = new Date(),
): Promise<{ agedOut: number; alarms: string[] } | null> {
  if (process.env.SMS_FORWARD_GUARDRAIL_DISABLED === "1") return null;
  try {
    const agedOutBefore = new Date(now.getTime() - freshWindowMs() - AGED_OUT_GRACE_MS);
    const cutover = cutoverAt();

    // ⛔ Mirrors the forward job's OWN filters exactly. A row the job would never
    //    have considered (wrong type, deleted for everyone) must not read as lost.
    const lostWhere = {
      direction: "INBOUND",
      type: { in: ["TEXT", "IMAGE"] },
      deletedForEveryoneAt: null,
      emailForwardedAt: null,
      createdAt: { gt: cutover, lt: agedOutBefore },
    };

    const [agedOut, sample, sendFailurePasses, stampFailures] = await Promise.all([
      database.connectChatMessage.count({ where: lostWhere }),
      database.connectChatMessage.findMany({
        where: lostWhere,
        orderBy: { createdAt: "asc" },
        take: 3,
        select: { createdAt: true, tenantId: true },
      }),
      database.agentAuditLog.count({
        where: { event: "sms.email_send_failed", ts: { gte: new Date(now.getTime() - SEND_FAILURE_WINDOW_MS) } },
      }),
      database.agentAuditLog.count({
        where: { event: "sms.email_stamp_failed", ts: { gte: new Date(now.getTime() - STAMP_FAILURE_WINDOW_MS) } },
      }),
    ]);

    const names = new Map<string, string>();
    for (const row of sample as Array<{ tenantId: string }>) {
      if (names.has(row.tenantId)) continue;
      const t = await database.tenant.findUnique({ where: { id: row.tenantId }, select: { name: true } }).catch(() => null);
      names.set(row.tenantId, t?.name ?? row.tenantId);
    }

    const input: SmsForwardGuardrailInput = {
      agedOut,
      agedOutSample: (sample as Array<{ createdAt: Date; tenantId: string }>).map((r) => ({
        company: names.get(r.tenantId) ?? r.tenantId,
        at: new Date(r.createdAt).toISOString(),
      })),
      sendFailurePasses,
      stampFailures,
    };
    const alarms = decideSmsForwardAlarms(input);

    for (const alarm of alarms) {
      await raiseSmsForwardEscalation(alarm, {
        windowMs: Number(process.env.SMS_FORWARD_ALERT_WINDOW_MS || DEFAULT_ALERT_WINDOW_MS) || DEFAULT_ALERT_WINDOW_MS,
        log,
        database,
      });
    }

    // ⛔ ALWAYS, including a clean run — the row is the only proof this ran.
    await database.agentAuditLog
      .create({
        data: auditRow(SWEEP_EVENT, {
          agedOut,
          sendFailurePasses,
          stampFailures,
          alarmed: alarms.map((a) => a.key),
          cutoverAt: cutover.toISOString(),
          freshWindowMin: freshWindowMs() / 60_000,
        }),
      })
      .catch(() => {});

    return { agedOut, alarms: alarms.map((a) => a.key) };
  } catch (err) {
    log.warn?.({ err: (err as Error)?.message }, "sms-forward-guardrail: pass failed");
    await database.agentAuditLog
      .create({ data: auditRow(SWEEP_EVENT, { error: String((err as Error)?.message ?? err).slice(0, 200) }) })
      .catch(() => {});
    return null;
  }
}

export function startSmsForwardGuardrail(log: Log): NodeJS.Timeout[] {
  const timers: NodeJS.Timeout[] = [];
  const add = (t: unknown) => {
    const timer = t as NodeJS.Timeout;
    (timer as any).unref?.();
    timers.push(timer);
    return timer;
  };
  // ⛔ BOTH: a bare interval is starved to nothing on a busy deploy day.
  add(setTimeout(() => { void runSmsForwardGuardrail(log); }, GUARDRAIL_BOOT_DELAY_MS));
  add(setInterval(() => { void runSmsForwardGuardrail(log); }, GUARDRAIL_INTERVAL_MS));
  log.info?.(
    { intervalMs: GUARDRAIL_INTERVAL_MS, bootDelayMs: GUARDRAIL_BOOT_DELAY_MS, cutoverAt: cutoverAt().toISOString() },
    "SMS_FORWARD_GUARDRAIL_ARMED",
  );
  return timers;
}
