/**
 * Guardrails for the email pipeline — voicemail first, but the outbox checks
 * cover every customer email type.
 *
 * ⛔⛔ WHY THIS FILE EXISTS (Izzy, 2026-08-18, after voicemail email was dead for
 * ~20 hours and nobody was told): "What happened today could never, ever happen
 * again. Emails cannot stop working ever, especially voicemail. Put self-healing
 * on this." Three faults had stacked (AGENT_HANDOFF_VOICEMAIL_EMAIL_DEAD_2026-08-18):
 * the recipients were erased by a config change, the sweep was head-of-line
 * blocked by the excluded tenant, and the watchdog built to catch both had thrown
 * on every run since deploy. Each guard below maps to one of those, plus one for
 * "the alarm itself is dead".
 *
 * The shape, everywhere in this file:
 *  - a PURE decision function (testable, no db) …
 *  - … driven by a thin runner that reads the db and, when the decision says so,
 *    RAISES AN ESCALATION — never an ADMIN_ALERT (muted platform-wide at the send
 *    door; it would build clean and reach nobody). Escalations are the one channel
 *    proven to reach the owner (SMS + AGENT_ESCALATION email).
 *  - every escalation is DE-DUPLICATED on an open one with the same summary
 *    prefix, so a persistent fault texts once, not every tick.
 *  - state that must survive a restart lives in `AgentAuditLog`, never a module
 *    variable — the api restarts dozens of times on a busy day.
 */
import { createHash } from "node:crypto";

import { db } from "@connect/db";

import { VOICEMAIL_EMAIL_TYPE, voicemailEmailEnabled, voicemailEmailExcludedTenantIds } from "./voicemailEmailSender";

type Log = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };

/** Where every escalation raised here lands (the admin tenant that owns (845) 557-7768). */
const ADMIN_ALERT_TENANT_ID = "connect-admin-tenant-v1";

// ─── Heartbeats ──────────────────────────────────────────────────────────────

export const HEARTBEAT_EVENT = {
  sweep: "voicemail_email.sweep_heartbeat",
  watchdog: "voicemail_email.watchdog_heartbeat",
} as const;
export type HeartbeatKind = keyof typeof HEARTBEAT_EVENT;

/**
 * How stale a heartbeat may be before the liveness check escalates. The sweep
 * runs every 60 s and the watchdog every 15 min; the api can be down ~2 min for a
 * blue/green cutover. These are deliberately generous — a false "dead" text at
 * 3am is how an alarm gets muted by the human, which is the same as no alarm.
 */
export const HEARTBEAT_STALE_MS: Record<HeartbeatKind, number> = {
  sweep: 10 * 60_000,
  watchdog: 45 * 60_000,
};

/** After boot, give the timers this long to produce a first heartbeat before judging. */
export const LIVENESS_BOOT_GRACE_MS = 20 * 60_000;

/**
 * Pure: is a heartbeat missing? `lastAt` null = never recorded (this process or
 * any earlier one). `processUptimeMs` protects a fresh container from being
 * judged before its first tick.
 */
export function decideHeartbeatStale(input: {
  kind: HeartbeatKind;
  lastAt: Date | null;
  now: Date;
  processUptimeMs: number;
}): { stale: boolean; ageMs: number | null } {
  const stale = HEARTBEAT_STALE_MS[input.kind];
  if (input.processUptimeMs < LIVENESS_BOOT_GRACE_MS) {
    // Too soon to say anything about THIS process — but a heartbeat from a
    // previous process that is already very old is still a finding.
    if (!input.lastAt) return { stale: false, ageMs: null };
    const age = input.now.getTime() - input.lastAt.getTime();
    return { stale: age > stale + LIVENESS_BOOT_GRACE_MS, ageMs: age };
  }
  if (!input.lastAt) return { stale: true, ageMs: null };
  const age = input.now.getTime() - input.lastAt.getTime();
  return { stale: age > stale, ageMs: age };
}

function auditRow(event: string, payload: Record<string, unknown>) {
  const body = { actor: "system", event, ts: new Date().toISOString(), payload };
  return {
    actor: body.actor,
    event: body.event,
    payload: body.payload,
    // ⛔ `hash` has no default; the agent hashes the row body, so mirror that.
    hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
}

/** Never throws — a heartbeat that could fail the thing it measures is a liability. */
export async function recordHeartbeat(kind: HeartbeatKind, payload: Record<string, unknown> = {}, database: any = db): Promise<void> {
  try {
    await database.agentAuditLog.create({ data: auditRow(HEARTBEAT_EVENT[kind], payload) });
  } catch {
    /* ignore */
  }
}

async function lastHeartbeatAt(kind: HeartbeatKind, database: any = db): Promise<Date | null> {
  const row = await database.agentAuditLog.findFirst({
    where: { event: HEARTBEAT_EVENT[kind] },
    orderBy: { ts: "desc" },
    select: { ts: true },
  });
  return row?.ts ?? null;
}

// ─── Escalation (the only alarm channel that reaches a person) ────────────────

export type GuardrailAlarm = {
  /** Stable prefix; the de-dupe key. */
  key: string;
  summary: string;
  sms: string;
  report: string;
  fix: string;
};

export const ALARM_PREFIX = {
  sweepDead: "Voicemail email sweep has stopped",
  watchdogDead: "Voicemail email watchdog has stopped",
  watchdogFailing: "Voicemail email watchdog is failing",
  recipientsLost: "Voicemail email addresses disappeared",
  outboxStalled: "Email outbox is not sending",
  outboxFailing: "Emails are failing to send",
} as const;

/**
 * Raise once. De-duplicated on an OPEN escalation whose summary starts with the
 * same key. Returns true when a new escalation was written.
 */
export async function raiseGuardrailEscalation(alarm: GuardrailAlarm, log?: Log, database: any = db): Promise<boolean> {
  try {
    const open = await database.agentEscalation.findFirst({
      where: { requestSummary: { startsWith: alarm.key }, status: { in: ["QUEUED", "SENT"] } },
      select: { id: true },
    });
    if (open) {
      log?.info({ existing: open.id, key: alarm.key }, "email-guardrail: already escalated, not re-alerting");
      return false;
    }
    await database.agentEscalation.create({
      data: {
        tenantId: ADMIN_ALERT_TENANT_ID,
        tenantName: "Loopcom platform",
        clientUserId: null,
        userName: "email guardrail",
        userEmail: null,
        requestSummary: alarm.summary,
        smsBody: alarm.sms,
        report: alarm.report,
        proposedFix: alarm.fix,
        researchDegraded: false,
        status: "QUEUED",
      },
    });
    log?.warn({ key: alarm.key }, "email-guardrail: escalation raised");
    return true;
  } catch (err) {
    log?.warn({ err: (err as Error)?.message, key: alarm.key }, "email-guardrail: could not raise escalation");
    return false;
  }
}

// ─── Guard 4: the alarm's alarm — liveness of the sweep and the watchdog ──────

export const LIVENESS_INTERVAL_MS = 5 * 60_000;

export async function runVoicemailEmailLivenessCheck(log: Log, database: any = db, now: Date = new Date()): Promise<void> {
  if (!voicemailEmailEnabled()) return;
  try {
    for (const kind of ["sweep", "watchdog"] as HeartbeatKind[]) {
      const lastAt = await lastHeartbeatAt(kind, database);
      const verdict = decideHeartbeatStale({ kind, lastAt, now, processUptimeMs: process.uptime() * 1000 });
      if (!verdict.stale) continue;
      const ageMin = verdict.ageMs == null ? null : Math.round(verdict.ageMs / 60_000);
      const key = kind === "sweep" ? ALARM_PREFIX.sweepDead : ALARM_PREFIX.watchdogDead;
      await raiseGuardrailEscalation(
        {
          key,
          summary: `${key} — last heartbeat ${ageMin == null ? "never" : `${ageMin} min ago`}`,
          sms: `Loopcom: the voicemail email ${kind} has not run for ${ageMin == null ? "as long as we can see" : `${ageMin} min`}. Voicemail emails may not be going out.`,
          report: [
            `The voicemail email ${kind} writes a heartbeat every time it completes. It has not completed since ${lastAt ? lastAt.toISOString() : "(never)"}.`,
            `Threshold: ${Math.round(HEARTBEAT_STALE_MS[kind] / 60_000)} min. Checked at ${now.toISOString()} in api process up ${Math.round(process.uptime() / 60)} min.`,
            "",
            "What to check: `docker logs app-api-1 | grep voicemail-email` — a `sweep failed` / `watchdog failed` line names the cause. If the api container is healthy but the timer never fires, an api redeploy restarts both timers.",
            "Nothing is lost: voicemails stay eligible for 7 days and email the moment the sweep runs again.",
          ].join("\n"),
          fix: "Read the api log for `voicemail-email:` warnings; redeploy the api if the timers are dead. Voicemails within the last 7 days will still be emailed once the sweep runs.",
        },
        log,
        database,
      );
    }
  } catch (err) {
    log.warn({ err: (err as Error)?.message }, "email-guardrail: liveness check failed");
  }
}

// ─── Guard 3: a watchdog that cannot run must scream ─────────────────────────

export const WATCHDOG_FAILURES_BEFORE_ALARM = 3;
let consecutiveWatchdogFailures = 0;

/** Called by the watchdog's catch. Escalates on the Nth consecutive failure. */
export async function noteWatchdogFailure(err: unknown, log: Log, database: any = db): Promise<void> {
  consecutiveWatchdogFailures += 1;
  const message = String((err as Error)?.message || err || "unknown error").slice(0, 600);
  log.warn({ err: message, consecutive: consecutiveWatchdogFailures }, "voicemail-email: watchdog failed");
  if (consecutiveWatchdogFailures < WATCHDOG_FAILURES_BEFORE_ALARM) return;
  await raiseGuardrailEscalation(
    {
      key: ALARM_PREFIX.watchdogFailing,
      summary: `${ALARM_PREFIX.watchdogFailing} — ${consecutiveWatchdogFailures} runs in a row`,
      sms: `Loopcom: the voicemail email watchdog has failed ${consecutiveWatchdogFailures} times in a row. Voicemail emails are UNGUARDED until it is fixed.`,
      report: [
        `The watchdog threw on ${consecutiveWatchdogFailures} consecutive runs. Last error:`,
        message,
        "",
        "While it is failing, nothing reconciles voicemails against sent emails, and a silent stop in the sweep would not be caught. This is exactly how the 2026-08-18 outage went unnoticed for 20 hours.",
      ].join("\n"),
      fix: "Fix the watchdog error (usually a Prisma select/where shape after a schema change) and redeploy the api. Until then, check `EmailJob` rows of type VOICEMAIL_NOTIFICATION by hand.",
    },
    log,
    database,
  );
}

export function noteWatchdogSuccess(): void {
  consecutiveWatchdogFailures = 0;
}

/** Test hook. */
export function _resetWatchdogFailureCounter(): void {
  consecutiveWatchdogFailures = 0;
}

// ─── Guard 1: recipient coverage — an address must never vanish silently ─────

export const RECIPIENT_COVERAGE_EVENT = "voicemail_email.recipient_coverage";
export const RECIPIENT_COVERAGE_INTERVAL_MS = 60 * 60_000;

/**
 * Pure: has the number of mailboxes with SOMEONE to email dropped enough to be
 * an erasure rather than churn? A drop of ≥ 3 mailboxes AND ≥ 20 % is the shape
 * of a config change (the 2026-08-17 cutover took 55 → 0 in one afternoon); a
 * customer removing one address in Settings is not.
 */
export function decideRecipientCoverageDrop(input: { previous: number | null; current: number }): {
  dropped: boolean;
  lost: number;
} {
  if (input.previous == null) return { dropped: false, lost: 0 };
  const lost = input.previous - input.current;
  if (lost < 3) return { dropped: false, lost: Math.max(0, lost) };
  return { dropped: lost / input.previous >= 0.2, lost };
}

export async function runRecipientCoverageCheck(log: Log, database: any = db): Promise<{ current: number; previous: number | null; dropped: boolean } | null> {
  if (!voicemailEmailEnabled()) return null;
  try {
    const excluded = Array.from(voicemailEmailExcludedTenantIds());
    const rows = await database.extension.findMany({
      where: {
        status: "ACTIVE",
        tenant: { pbxRemovedAt: null },
        ...(excluded.length ? { tenantId: { notIn: excluded } } : {}),
      },
      select: {
        tenantId: true,
        pbxUserEmail: true,
        voicemailEmailRecipients: { select: { id: true }, take: 1 },
        tenant: { select: { name: true } },
      },
    });
    const covered = rows.filter((r: any) => (r.pbxUserEmail && String(r.pbxUserEmail).includes("@")) || (r.voicemailEmailRecipients || []).length > 0);
    const current = covered.length;
    const last = await database.agentAuditLog.findFirst({
      where: { event: RECIPIENT_COVERAGE_EVENT },
      orderBy: { ts: "desc" },
      select: { payload: true, ts: true },
    });
    const previous: number | null = typeof last?.payload?.covered === "number" ? last.payload.covered : null;
    const verdict = decideRecipientCoverageDrop({ previous, current });

    // Per-tenant view for the report (only when we are about to alert).
    if (verdict.dropped) {
      const byTenantNow: Record<string, number> = {};
      for (const r of covered) byTenantNow[r.tenant?.name || r.tenantId] = (byTenantNow[r.tenant?.name || r.tenantId] || 0) + 1;
      const byTenantBefore: Record<string, number> = (last?.payload?.byTenant as Record<string, number>) || {};
      const lostBy = Object.entries(byTenantBefore)
        .map(([t, n]) => [t, n - (byTenantNow[t] || 0)] as const)
        .filter(([, d]) => d > 0)
        .sort((a, b) => b[1] - a[1]);
      await raiseGuardrailEscalation(
        {
          key: ALARM_PREFIX.recipientsLost,
          summary: `${ALARM_PREFIX.recipientsLost} — ${verdict.lost} mailboxes lost their address (${previous} -> ${current})`,
          sms: `Loopcom: ${verdict.lost} voicemail mailboxes lost their email address since the last check (${previous} -> ${current}). Those customers will get NO voicemail emails.`,
          report: [
            `Mailboxes with at least one voicemail email address: ${previous} an hour ago, ${current} now.`,
            "Lost, by company:",
            ...lostBy.map(([t, d]) => `  ${t}: -${d}`),
            "",
            "This is the shape of a config change, not a customer edit. On 2026-08-17 the PBX cutover blanked the PBX email field and the extension sync mirrored the blank into Connect — 55 mailboxes went dark in one afternoon.",
            "The sync now promotes a blanked PBX address into VoicemailEmailRecipient before nulling the mirror, so a repeat of that exact cause is prevented; this alarm is for whatever the next cause is.",
          ].join("\n"),
          fix: "Restore the addresses into VoicemailEmailRecipient (Settings -> voicemail email, or the restore recipe in AGENT_HANDOFF_VOICEMAIL_EMAIL_DEAD_2026-08-18.md §6b), then clear `emailedAt` on any voicemail stamped no_recipient since the drop.",
        },
        log,
        database,
      );
    }

    const byTenant: Record<string, number> = {};
    for (const r of covered) byTenant[r.tenant?.name || r.tenantId] = (byTenant[r.tenant?.name || r.tenantId] || 0) + 1;
    await database.agentAuditLog.create({
      data: auditRow(RECIPIENT_COVERAGE_EVENT, { covered: current, total: rows.length, previous, byTenant, dropped: verdict.dropped }),
    });
    if (verdict.dropped) log.warn({ previous, current }, "email-guardrail: recipient coverage dropped");
    return { current, previous, dropped: verdict.dropped };
  } catch (err) {
    log.warn({ err: (err as Error)?.message }, "email-guardrail: recipient coverage check failed");
    return null;
  }
}

// ─── Guard 1b: the sync must never erase an address (self-heal at the source) ─

/**
 * Pure: is the PBX address about to disappear from Connect? Only a real value
 * going to nothing counts. A CHANGE (a@ -> b@) is not an erasure and is left to
 * the mirror; a value staying, or nothing staying nothing, needs no action.
 */
export function decidePreservePbxEmail(input: { previous: string | null | undefined; next: string | null | undefined }): string | null {
  const prev = String(input.previous ?? "").trim().toLowerCase();
  const next = String(input.next ?? "").trim().toLowerCase();
  if (!prev || !prev.includes("@")) return null;
  if (next) return null;
  return prev;
}

/**
 * Called by `pbxExtensionSync` right before it mirrors the PBX email onto the
 * Connect extension. If the PBX value went from an address to blank, the old
 * address is written into `VoicemailEmailRecipient` (create-only; an existing
 * row is left alone) so the mailbox keeps a recipient. Never throws.
 */
export async function preserveBlankedPbxEmail(
  database: any,
  input: { tenantId: string; extNumber: string; nextPbxUserEmail: string | null },
  log?: Log,
): Promise<boolean> {
  try {
    const existing = await database.extension.findUnique({
      where: { tenantId_extNumber: { tenantId: input.tenantId, extNumber: input.extNumber } },
      select: { id: true, pbxUserEmail: true },
    });
    if (!existing) return false;
    const keep = decidePreservePbxEmail({ previous: existing.pbxUserEmail, next: input.nextPbxUserEmail });
    if (!keep) return false;
    await database.voicemailEmailRecipient.upsert({
      where: { extensionId_email: { extensionId: existing.id, email: keep } },
      create: { tenantId: input.tenantId, extensionId: existing.id, email: keep },
      update: {},
    });
    log?.warn({ tenantId: input.tenantId, extNumber: input.extNumber }, "voicemail-email: PBX address blanked — kept as a Connect recipient");
    return true;
  } catch (err) {
    log?.warn({ err: (err as Error)?.message }, "voicemail-email: could not preserve a blanked PBX address");
    return false;
  }
}

// ─── Guard 5: outbox health — every customer email type ──────────────────────

export const OUTBOX_CHECK_INTERVAL_MS = 5 * 60_000;
export const OUTBOX_STALL_MS = 20 * 60_000;
export const OUTBOX_FAILURE_WINDOW_MS = 60 * 60_000;
export const OUTBOX_FAILURES_BEFORE_ALARM = 5;

/**
 * Pure. Two independent findings:
 *  - stalled: something is QUEUED (or retryable FAILED) with attempts left, older
 *    than OUTBOX_STALL_MS, and its own nextRunAt has passed — the sender loop is
 *    not picking it up.
 *  - failing: at least N final failures (attempts exhausted, or a fresh failure)
 *    in the last hour — the mailbox / provider is refusing us.
 * ADMIN_ALERT is excluded everywhere: it is deliberately SKIPPED at the send door.
 */
export function decideOutboxHealth(input: {
  oldestOverdueQueuedAgeMs: number | null;
  failuresLastHour: number;
}): { stalled: boolean; failing: boolean } {
  return {
    stalled: input.oldestOverdueQueuedAgeMs != null && input.oldestOverdueQueuedAgeMs >= OUTBOX_STALL_MS,
    failing: input.failuresLastHour >= OUTBOX_FAILURES_BEFORE_ALARM,
  };
}

export async function runOutboxHealthCheck(log: Log, database: any = db, now: Date = new Date()): Promise<void> {
  try {
    const oldest = await database.emailJob.findFirst({
      where: {
        type: { not: "ADMIN_ALERT" },
        status: { in: ["QUEUED", "FAILED"] },
        attempts: { lt: 5 },
        nextRunAt: { lte: new Date(now.getTime() - OUTBOX_STALL_MS) },
      },
      orderBy: { nextRunAt: "asc" },
      select: { id: true, type: true, nextRunAt: true, createdAt: true, toEmail: true },
    });
    const overdueCount = oldest
      ? await database.emailJob.count({
          where: { type: { not: "ADMIN_ALERT" }, status: { in: ["QUEUED", "FAILED"] }, attempts: { lt: 5 }, nextRunAt: { lte: new Date(now.getTime() - OUTBOX_STALL_MS) } },
        })
      : 0;
    const failedRecent = await database.emailJob.findMany({
      where: {
        type: { not: "ADMIN_ALERT" },
        status: "FAILED",
        updatedAt: { gte: new Date(now.getTime() - OUTBOX_FAILURE_WINDOW_MS) },
      },
      select: { type: true, lastErrorCode: true, lastErrorMessage: true, attempts: true },
      take: 500,
    });

    const verdict = decideOutboxHealth({
      oldestOverdueQueuedAgeMs: oldest ? now.getTime() - new Date(oldest.nextRunAt).getTime() : null,
      failuresLastHour: failedRecent.length,
    });

    if (verdict.stalled && oldest) {
      const ageMin = Math.round((now.getTime() - new Date(oldest.nextRunAt).getTime()) / 60_000);
      await raiseGuardrailEscalation(
        {
          key: ALARM_PREFIX.outboxStalled,
          summary: `${ALARM_PREFIX.outboxStalled} — ${overdueCount} email(s) waiting, oldest ${ageMin} min`,
          sms: `Loopcom: ${overdueCount} email${overdueCount === 1 ? "" : "s"} have been sitting in the outbox for ${ageMin}+ min without being sent (oldest: ${oldest.type}). Voicemail/invoice/invite emails are stuck.`,
          report: [
            `The email sender loop has not picked up ${overdueCount} due job(s). Oldest: ${oldest.type} to ${oldest.toEmail}, due ${new Date(oldest.nextRunAt).toISOString()}, created ${new Date(oldest.createdAt).toISOString()}.`,
            "The sender runs inside the api (`processEmailJobsBatch`); if the api is healthy but jobs sit QUEUED, the loop has died or is wedged on one job.",
          ].join("\n"),
          fix: "Check `docker logs app-api-1 | grep -i emailjob`; a redeploy of the api restarts the sender loop. Jobs are not lost — they send once the loop runs.",
        },
        log,
        database,
      );
    }
    if (verdict.failing) {
      const byErr: Record<string, number> = {};
      for (const f of failedRecent) {
        const k = `${f.type}: ${(f.lastErrorCode || "").slice(0, 40)} ${(f.lastErrorMessage || "").slice(0, 120)}`.trim();
        byErr[k] = (byErr[k] || 0) + 1;
      }
      const top = Object.entries(byErr).sort((a, b) => b[1] - a[1]).slice(0, 5);
      await raiseGuardrailEscalation(
        {
          key: ALARM_PREFIX.outboxFailing,
          summary: `${ALARM_PREFIX.outboxFailing} — ${failedRecent.length} failures in the last hour`,
          sms: `Loopcom: ${failedRecent.length} emails failed to send in the last hour. Top cause: ${(top[0]?.[0] || "unknown").slice(0, 100)}`,
          report: [`${failedRecent.length} email jobs FAILED in the last hour. By cause:`, ...top.map(([k, n]) => `  ${n} x ${k}`), "", "If the cause is the Gmail 500/day cap (550 quota), it clears on a rolling 24 h window; failed voicemail emails are re-queued automatically by the watchdog once sends succeed again."].join("\n"),
          fix: "Read the top cause. Provider refusal (550 quota / 454 login) = wait or use the second mailbox; bad recipient = fix the address; anything else = read the api log.",
        },
        log,
        database,
      );
    }
  } catch (err) {
    log.warn({ err: (err as Error)?.message }, "email-guardrail: outbox health check failed");
  }
}

// ─── Guard 2b: self-heal — re-queue dead voicemail emails, bounded ────────────

export const REQUEUE_EVENT = "voicemail_email.job_requeued";
export const MAX_REQUEUES_PER_JOB = 2;
export const REQUEUE_MIN_AGE_MS = 60 * 60_000;

/**
 * Pure: may this dead job be given another life? Only when it has sat dead for
 * an hour (so we are not hammering a refusing provider), only while the outbox
 * has proven it can send SOMETHING since the failure (a SENT job newer than the
 * failure — proof the cause has cleared), and at most MAX_REQUEUES_PER_JOB times.
 */
export function decideRequeue(input: {
  failedAt: Date;
  lastSentAnywhereAt: Date | null;
  priorRequeues: number;
  now: Date;
}): boolean {
  if (input.priorRequeues >= MAX_REQUEUES_PER_JOB) return false;
  if (input.now.getTime() - input.failedAt.getTime() < REQUEUE_MIN_AGE_MS) return false;
  if (!input.lastSentAnywhereAt) return false;
  return input.lastSentAnywhereAt.getTime() > input.failedAt.getTime();
}

/** Re-queue voicemail email jobs the outbox gave up on. Returns how many. */
export async function requeueDeadVoicemailEmails(log: Log, database: any = db, now: Date = new Date()): Promise<number> {
  try {
    const dead = await database.emailJob.findMany({
      where: { type: VOICEMAIL_EMAIL_TYPE, status: "FAILED", attempts: { gte: 5 }, createdAt: { gte: new Date(now.getTime() - 7 * 24 * 3600_000) } },
      select: { id: true, updatedAt: true, toEmail: true },
      take: 200,
    });
    if (dead.length === 0) return 0;
    const lastSent = await database.emailJob.findFirst({
      where: { status: "SENT", type: { not: "ADMIN_ALERT" } },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    });
    const priorRows = await database.agentAuditLog.findMany({
      where: { event: REQUEUE_EVENT, ts: { gte: new Date(now.getTime() - 14 * 24 * 3600_000) } },
      select: { payload: true },
      take: 2000,
    });
    const priorByJob = new Map<string, number>();
    for (const r of priorRows) {
      const id = (r.payload as any)?.jobId;
      if (id) priorByJob.set(id, (priorByJob.get(id) || 0) + 1);
    }
    let requeued = 0;
    for (const j of dead) {
      const ok = decideRequeue({
        failedAt: new Date(j.updatedAt),
        lastSentAnywhereAt: lastSent?.sentAt ? new Date(lastSent.sentAt) : null,
        priorRequeues: priorByJob.get(j.id) || 0,
        now,
      });
      if (!ok) continue;
      await database.emailJob.update({
        where: { id: j.id },
        data: { status: "QUEUED", attempts: 0, nextRunAt: now, lastErrorCode: "REQUEUED_BY_WATCHDOG" },
      });
      await database.agentAuditLog.create({ data: auditRow(REQUEUE_EVENT, { jobId: j.id, toEmail: j.toEmail, priorRequeues: priorByJob.get(j.id) || 0 }) });
      requeued += 1;
    }
    if (requeued > 0) log.warn({ requeued }, "voicemail-email: dead email jobs re-queued by the watchdog");
    return requeued;
  } catch (err) {
    log.warn({ err: (err as Error)?.message }, "voicemail-email: requeue of dead jobs failed");
    return 0;
  }
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

/** Start the standalone timers (liveness, recipient coverage, outbox health). */
export function startEmailGuardrails(log: Log): NodeJS.Timeout[] {
  const timers: NodeJS.Timeout[] = [];
  // setTimeout/setInterval type as `number` under this tsconfig (pre-existing
  // quirk, see server.ts beside the voicemail timers) — cast at the boundary.
  const add = (t: unknown) => { const timer = t as NodeJS.Timeout; (timer as any).unref?.(); timers.push(timer); return timer; };
  // Liveness: first look after the boot grace, then every 5 min.
  add(setTimeout(() => { void runVoicemailEmailLivenessCheck(log); }, LIVENESS_BOOT_GRACE_MS + 60_000));
  add(setInterval(() => { void runVoicemailEmailLivenessCheck(log); }, LIVENESS_INTERVAL_MS));
  // Recipient coverage: 3 min after boot (so a deploy-day never leaves it un-run), then hourly.
  add(setTimeout(() => { void runRecipientCoverageCheck(log); }, 3 * 60_000));
  add(setInterval(() => { void runRecipientCoverageCheck(log); }, RECIPIENT_COVERAGE_INTERVAL_MS));
  // Outbox: 2 min after boot, then every 5 min.
  add(setTimeout(() => { void runOutboxHealthCheck(log); }, 2 * 60_000));
  add(setInterval(() => { void runOutboxHealthCheck(log); }, OUTBOX_CHECK_INTERVAL_MS));
  return timers;
}
