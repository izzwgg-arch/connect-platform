/**
 * SUPPORT-LOOP guardrail — the server watches the whole ticket loop, because the
 * watcher cannot watch itself.
 *
 * ⛔⛔ WHY THIS EXISTS: on 2026-08-31 a Ctrl+C in the watcher's console killed it
 * AND its restart wrapper. It sat dead for 18 hours with three tickets stranded,
 * and nothing said so — `status.mjs` is an alarm nobody runs on a timer, and it
 * lives on the same machine that failed. This sweep runs ON THE SERVER, so a
 * dead watcher, a dead PC, a burned cap and a killed console all look the same
 * to it: tickets sitting unworked, and a heartbeat that stopped.
 *
 * It watches the OUTCOME, not the machinery:
 *   • the watcher's heartbeat went quiet          → early warning
 *   • tickets sitting unworked for hours          → the damage itself
 *   • customer replies held by the safety gate    → people silently untold
 *   • a customer wrote back and nobody read it    → a person waiting on us
 *   • the watcher's token is about to expire      → the next outage, scheduled
 *
 * ⛔ RAISES AN ESCALATION — never an ADMIN_ALERT (muted at the send door; an
 *    alarm on that type builds clean, logs clean and reaches nobody).
 * ⛔ DE-DUPED OVER A WINDOW, deliberately NOT `raiseGuardrailEscalation` (that
 *    de-dupes on any open escalation forever — each key would fire ONCE, ever).
 * ⛔ EVERY SUMMARY CARRIES THE NEEDS-PERSON MARKER, so the watcher's triage
 *    skips these alarms instead of spawning an agent to investigate its own
 *    monitor — the circular case where "tickets are unworked" is itself an
 *    unworked ticket.
 * ⛔ WRITES AN AUDIT ROW ON EVERY RUN, clean or not, with `actor` AND `hash` —
 *    the row is the proof it ran; the boot line proves nothing.
 */
import { createHash } from "node:crypto";
import { db } from "@connect/db";
import { NEEDS_PERSON_MARKER } from "./customerUpdate";

type Log = { info?: (o: any, m?: string) => void; warn?: (o: any, m?: string) => void };

/** The platform's own tenant, which owns platform-level escalations. */
const PLATFORM_TENANT_ID = "connect-admin-tenant-v1";
/**
 * ⛔ This EXACT userName is also in the watcher's triage skip list
 * (tools/loopcom-support-mcp/triage.mjs) — renaming it re-opens the circular
 * "agent investigates its own down-detector" case.
 */
export const GUARDRAIL_USERNAME = "support loop guardrail";

export const SWEEP_EVENT = "support_loop.sweep";

export const WATCHER_DOWN_KEY = "The support agent watcher is down";
export const UNWORKED_KEY = "Support tickets are sitting unworked";
export const HELD_KEY = "Customer support replies are held by the safety gate";
export const UNREAD_REPLY_KEY = "A customer replied to support and nobody has read it";
export const TOKEN_KEY = "The support watcher's token expires soon";

/**
 * ⛔ THE CUTOVER STOPS A BACK-CATALOGUE BURST. Twenty-odd escalations predate
 * the watcher (tests, alarms, tickets handled by hand); without this the first
 * sweep would page about every one of them as "unworked".
 */
export const DEFAULT_CUTOVER_AT = "2026-09-01T12:00:00.000Z";

/** The watcher beats every ~60s, and beats DURING runs. 30 min is many missed beats. */
export const WATCHER_STALE_MS = 30 * 60_000;
/** A ticket the agent has not touched in this long is stuck — caps, dead watcher, or dead PC. */
export const UNWORKED_AFTER_MS = 3 * 60 * 60_000;
/** A held reply older than this means nobody has told the customer anything. */
export const HELD_AFTER_MS = 30 * 60_000;
/** A customer message unread this long is a person waiting on us. */
export const UNREAD_REPLY_AFTER_MS = 2 * 60 * 60_000;
export const TOKEN_WARN_DAYS = 7;

export const GUARDRAIL_INTERVAL_MS = 15 * 60_000;
/** ⛔ A bare setInterval is starved on a busy deploy day; the boot kick is mandatory. */
export const GUARDRAIL_BOOT_DELAY_MS = 5 * 60_000;
export const DEFAULT_ALERT_WINDOW_MS = 6 * 60 * 60_000;
/** Token expiry moves once a month — nagging every 6 h about it teaches people to ignore alarms. */
export const TOKEN_ALERT_WINDOW_MS = 3 * 24 * 60 * 60_000;

export interface SupportLoopAlarm {
  key: string;
  summary: string;
  sms: string;
  report: string;
  windowMs?: number;
}

export interface SupportLoopInput {
  /** Minutes since the newest watcher heartbeat; null when no watcher has ever reported. */
  watcherBeatAgeMin: number | null;
  watcherHost: string | null;
  /** Escalations past the unworked window with no agent run at all. */
  unworked: Array<{ reference: string; tenantName: string; ageHours: number }>;
  /** Held customer updates past the held window. */
  held: Array<{ ticketRef: string; heldReason: string | null }>;
  /** Customer replies nobody has read, past the window. */
  unreadReplies: Array<{ ticketRef: string | null; ageHours: number }>;
  /** Days until the watcher token expires; null when unknown. */
  tokenDaysLeft: number | null;
}

/** PURE. Given what the database says, which alarms should fire. */
export function decideSupportLoopAlarms(input: SupportLoopInput): SupportLoopAlarm[] {
  const alarms: SupportLoopAlarm[] = [];

  // ⛔ Only when a watcher EXISTS and went quiet. "Never reported" is the
  // pre-rollout state, not an outage — the unworked check covers real damage.
  if (input.watcherBeatAgeMin != null && input.watcherBeatAgeMin * 60_000 >= WATCHER_STALE_MS) {
    const h = Math.round(input.watcherBeatAgeMin / 60);
    const ago = input.watcherBeatAgeMin < 120 ? `${Math.round(input.watcherBeatAgeMin)} min` : `${h} hours`;
    alarms.push({
      key: WATCHER_DOWN_KEY,
      summary: `${WATCHER_DOWN_KEY} — last heartbeat ${ago} ago`,
      sms: `Loopcom: the support ticket agent on ${input.watcherHost ?? "the PC"} has been quiet for ${ago}. New tickets are not being worked. Start it: Start-ScheduledTask "Loopcom support ticket watcher".`,
      report: [
        `The support-ticket watcher last reported in ${ago} ago (host: ${input.watcherHost ?? "unknown"}).`,
        "",
        "While it is down, customer tickets are not investigated and nobody is told anything.",
        "",
        "On that machine: node tools/loopcom-support-mcp/status.mjs, then",
        'Start-ScheduledTask -TaskName "Loopcom support ticket watcher".',
        "The watchdog task normally restarts it by itself within 10 minutes — this alarm firing means the watchdog could not.",
      ].join("\n"),
    });
  }

  if (input.unworked.length > 0) {
    const who = input.unworked
      .slice(0, 4)
      .map((u) => `${u.reference} (${u.tenantName}, ${u.ageHours}h)`)
      .join(", ");
    alarms.push({
      key: UNWORKED_KEY,
      summary: `${UNWORKED_KEY} — ${input.unworked.length} for over ${Math.round(UNWORKED_AFTER_MS / 3600_000)}h`,
      sms: `Loopcom: ${input.unworked.length} support ticket${input.unworked.length === 1 ? "" : "s"} ha${input.unworked.length === 1 ? "s" : "ve"} sat unworked for hours: ${who}`.slice(0, 300),
      report: [
        `${input.unworked.length} ticket${input.unworked.length === 1 ? "" : "s"} the agent has never touched, oldest first: ${who}.`,
        "",
        "Likely causes, in order: the watcher is down (see its own alarm), the daily cap is burned, or the run keeps failing.",
        "The Agent runs tab on /admin/support shows which.",
      ].join("\n"),
    });
  }

  if (input.held.length > 0) {
    const refs = input.held.slice(0, 5).map((h) => h.ticketRef).join(", ");
    alarms.push({
      key: HELD_KEY,
      summary: `${HELD_KEY} — ${input.held.length} waiting`,
      sms: `Loopcom: ${input.held.length} customer repl${input.held.length === 1 ? "y is" : "ies are"} HELD by the safety gate (${refs}). The customer has been told nothing until a person releases or rewrites it.`.slice(0, 300),
      report: [
        `${input.held.length} held update${input.held.length === 1 ? "" : "s"}: ${refs}.`,
        "",
        "A held message is invisible to the customer BY DESIGN — nothing wrong goes out, but nothing goes out at all until a person acts.",
        "Reasons: " + input.held.map((h) => `${h.ticketRef}: ${h.heldReason ?? "(no reason recorded)"}`).slice(0, 5).join(" · "),
      ].join("\n"),
    });
  }

  if (input.unreadReplies.length > 0) {
    const refs = input.unreadReplies.map((r) => r.ticketRef ?? "no ticket").slice(0, 5).join(", ");
    alarms.push({
      key: UNREAD_REPLY_KEY,
      summary: `${UNREAD_REPLY_KEY} — ${input.unreadReplies.length} waiting`,
      sms: `Loopcom: ${input.unreadReplies.length} customer message${input.unreadReplies.length === 1 ? "" : "s"} to support ha${input.unreadReplies.length === 1 ? "s" : "ve"} sat unread for hours (${refs}). Open /admin/support.`.slice(0, 300),
      report: `${input.unreadReplies.length} customer repl${input.unreadReplies.length === 1 ? "y" : "ies"} nobody has read (${refs}). Open the ticket on /admin/support — reading the thread marks them read.`,
    });
  }

  if (input.tokenDaysLeft != null && input.tokenDaysLeft <= TOKEN_WARN_DAYS) {
    alarms.push({
      key: TOKEN_KEY,
      summary: `${TOKEN_KEY} — ${input.tokenDaysLeft} day${input.tokenDaysLeft === 1 ? "" : "s"} left`,
      sms: `Loopcom: the support agent's access token expires in ${input.tokenDaysLeft} day${input.tokenDaysLeft === 1 ? "" : "s"}. When it does, ticket investigation stops. Re-mint it on the watcher machine.`,
      report: `The watcher's LoopCom token expires in ${input.tokenDaysLeft} day${input.tokenDaysLeft === 1 ? "" : "s"}. Re-mint it and update the loopcom-support MCP config on the watcher machine, then restart the watcher task.`,
      windowMs: TOKEN_ALERT_WINDOW_MS,
    });
  }

  return alarms;
}

function auditRow(event: string, payload: Record<string, unknown>) {
  const body = { actor: "system", event, ts: new Date().toISOString(), payload };
  return {
    actor: body.actor,
    event: body.event,
    payload: body.payload,
    // ⛔ `hash` has no default; a row without it is rejected and the monitor goes blind.
    hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
}

/** De-duped over a WINDOW so it keeps nagging while the problem stands. */
export async function raiseSupportLoopEscalation(
  alarm: SupportLoopAlarm,
  opts: { windowMs: number; log?: Log; database?: any },
): Promise<boolean> {
  const database = opts.database ?? db;
  try {
    const since = new Date(Date.now() - (alarm.windowMs ?? opts.windowMs));
    // ⛔ `contains`, not startsWith: the summary opens with the needs-person
    // marker, so a startsWith on the key would never match and every sweep
    // would page again.
    const recent = await database.agentEscalation.findFirst({
      where: { requestSummary: { contains: alarm.key }, createdAt: { gte: since } },
      select: { id: true },
    });
    if (recent) {
      opts.log?.info?.({ existing: recent.id, key: alarm.key }, "support-loop-guardrail: already alerted inside the window");
      return false;
    }
    await database.agentEscalation.create({
      data: {
        tenantId: PLATFORM_TENANT_ID,
        tenantName: "Loopcom platform",
        clientUserId: null,
        userName: GUARDRAIL_USERNAME,
        userEmail: null,
        // The marker tells the watcher's triage to leave this for a person.
        requestSummary: `${NEEDS_PERSON_MARKER} ${alarm.summary}`,
        smsBody: asciiLine(alarm.sms),
        report: alarm.report,
        // ⛔ Required column — `null` is a swallowed PrismaClientValidationError.
        proposedFix: "",
        researchDegraded: false,
        status: "QUEUED",
      },
    });
    opts.log?.warn?.({ key: alarm.key }, "support-loop-guardrail: escalation raised");
    return true;
  } catch (err) {
    opts.log?.warn?.({ err: (err as Error)?.message, key: alarm.key }, "support-loop-guardrail: could not raise escalation");
    return false;
  }
}

/** ⛔ Plain ASCII, single line: one emoji flips the whole SMS to UCS-2 and 160 chars becomes 70. */
function asciiLine(s: string, max = 300): string {
  const flat = String(s).replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}.` : flat;
}

function cutoverAt(): Date {
  const raw = process.env.SUPPORT_LOOP_GUARDRAIL_CUTOVER_AT || DEFAULT_CUTOVER_AT;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date(DEFAULT_CUTOVER_AT) : d;
}

/**
 * One pass. Never throws — a guard that can crash the process it protects is a
 * liability. Always leaves an audit row, clean or not.
 */
export async function runSupportLoopGuardrail(
  log: Log,
  database: any = db,
  now: Date = new Date(),
): Promise<{ alarms: string[] } | null> {
  if (process.env.SUPPORT_LOOP_GUARDRAIL_DISABLED === "1") return null;
  try {
    const cutover = cutoverAt();

    const [watchers, staleEscalations, heldRows, unreadRows] = await Promise.all([
      database.supportAgentWatcher.findMany({ orderBy: { lastBeatAt: "desc" }, take: 5 }),
      database.agentEscalation.findMany({
        where: {
          createdAt: { gt: cutover, lt: new Date(now.getTime() - UNWORKED_AFTER_MS) },
          // ⛔ Our own alarms and hand-to-human tickets are excluded, or the
          // guardrail alarms about its own alarms forever.
          userName: { not: GUARDRAIL_USERNAME },
          NOT: { requestSummary: { startsWith: NEEDS_PERSON_MARKER } },
        },
        orderBy: { createdAt: "asc" },
        take: 25,
        select: { id: true, tenantName: true, createdAt: true },
      }),
      database.supportUpdate.findMany({
        where: { status: "held", updatedAt: { lt: new Date(now.getTime() - HELD_AFTER_MS) } },
        orderBy: { updatedAt: "asc" },
        take: 10,
        select: { ticketRef: true, heldReason: true },
      }),
      database.supportMessage.findMany({
        where: {
          direction: "from_customer",
          readAt: null,
          createdAt: { gt: cutover, lt: new Date(now.getTime() - UNREAD_REPLY_AFTER_MS) },
        },
        orderBy: { createdAt: "asc" },
        take: 10,
        select: { ticketRef: true, createdAt: true },
      }),
    ]);

    // "Unworked" = the agent never even STARTED on it. SupportAgentRun rows are
    // pushed at run start, so their absence is the honest test.
    let unworked: SupportLoopInput["unworked"] = [];
    if (staleEscalations.length) {
      const runs = await database.supportAgentRun.findMany({
        where: { escalationId: { in: staleEscalations.map((e: any) => e.id) } },
        select: { escalationId: true },
      });
      const started = new Set(runs.map((r: any) => r.escalationId));
      const { supportReportReference } = await import("@connect/shared");
      unworked = staleEscalations
        .filter((e: any) => !started.has(e.id))
        .map((e: any) => ({
          reference: supportReportReference(e.id),
          tenantName: String(e.tenantName ?? ""),
          ageHours: Math.round((now.getTime() - new Date(e.createdAt).getTime()) / 3600_000),
        }));
    }

    const newest = watchers[0] ?? null;
    const tokenAt = newest?.tokenExpiresAt ? new Date(newest.tokenExpiresAt).getTime() : null;
    const input: SupportLoopInput = {
      watcherBeatAgeMin: newest ? (now.getTime() - new Date(newest.lastBeatAt).getTime()) / 60_000 : null,
      watcherHost: newest?.host ?? null,
      unworked,
      held: heldRows.map((h: any) => ({ ticketRef: h.ticketRef, heldReason: h.heldReason ?? null })),
      unreadReplies: unreadRows.map((r: any) => ({
        ticketRef: r.ticketRef ?? null,
        ageHours: Math.round((now.getTime() - new Date(r.createdAt).getTime()) / 3600_000),
      })),
      tokenDaysLeft: tokenAt != null ? Math.floor((tokenAt - now.getTime()) / 86_400_000) : null,
    };

    const alarms = decideSupportLoopAlarms(input);
    for (const alarm of alarms) {
      await raiseSupportLoopEscalation(alarm, {
        windowMs: Number(process.env.SUPPORT_LOOP_ALERT_WINDOW_MS || DEFAULT_ALERT_WINDOW_MS) || DEFAULT_ALERT_WINDOW_MS,
        log,
        database,
      });
    }

    // ⛔ ALWAYS, including a clean run — the row is the only proof this ran.
    await database.agentAuditLog
      .create({
        data: auditRow(SWEEP_EVENT, {
          watcherBeatAgeMin: input.watcherBeatAgeMin == null ? null : Math.round(input.watcherBeatAgeMin),
          unworked: input.unworked.length,
          held: input.held.length,
          unreadReplies: input.unreadReplies.length,
          tokenDaysLeft: input.tokenDaysLeft,
          alarmed: alarms.map((a) => a.key),
          cutoverAt: cutover.toISOString(),
        }),
      })
      .catch(() => {});

    return { alarms: alarms.map((a) => a.key) };
  } catch (err) {
    log.warn?.({ err: (err as Error)?.message }, "support-loop-guardrail: pass failed");
    await database.agentAuditLog
      .create({ data: auditRow(SWEEP_EVENT, { error: String((err as Error)?.message ?? err).slice(0, 200) }) })
      .catch(() => {});
    return null;
  }
}

export function startSupportLoopGuardrail(log: Log): NodeJS.Timeout[] {
  const timers: NodeJS.Timeout[] = [];
  const add = (t: unknown) => {
    const timer = t as NodeJS.Timeout;
    (timer as any).unref?.();
    timers.push(timer);
    return timer;
  };
  // ⛔ BOTH: a bare interval is starved to nothing on a busy deploy day.
  add(setTimeout(() => { void runSupportLoopGuardrail(log); }, GUARDRAIL_BOOT_DELAY_MS));
  add(setInterval(() => { void runSupportLoopGuardrail(log); }, GUARDRAIL_INTERVAL_MS));
  log.info?.(
    { intervalMs: GUARDRAIL_INTERVAL_MS, bootDelayMs: GUARDRAIL_BOOT_DELAY_MS, cutoverAt: cutoverAt().toISOString() },
    "SUPPORT_LOOP_GUARDRAIL_ARMED",
  );
  return timers;
}
