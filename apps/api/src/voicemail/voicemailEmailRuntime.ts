/**
 * Wiring: the two sweeps and the attachment hook.
 *
 * Kept out of server.ts so the moving parts are testable and so server.ts needs
 * only three lines: two timers and one attachment call.
 */
import { db } from "@connect/db";

import {
  loadVoicemailAudioAttachmentForEmailJob,
  type VoicemailAudioAttachment,
} from "./voicemailEmailAttachment";
import {
  VOICEMAIL_EMAIL_TYPE,
  processVoicemailForEmail,
  voicemailEmailEnabled,
  voicemailEmailExcludedTenantIds,
  type ExtensionEmailConfig,
} from "./voicemailEmailSender";
import {
  describeVoicemailEmailGaps,
  findVoicemailEmailGaps,
  gapsWorthAlerting,
  type VoicemailEmailGap,
} from "./voicemailEmailWatchdog";
import { extractVoicemailIdFromEmailBody } from "./voicemailEmail";
import {
  noteWatchdogFailure,
  noteWatchdogSuccess,
  recordHeartbeat,
  requeueDeadVoicemailEmails,
} from "./voicemailEmailGuardrails";

type Log = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };

/**
 * ⛔ A WIDE window on purpose. The design this replaces used 30 minutes, so a
 * voicemail that failed once aged out and was never seen again. Seven days means
 * a message can still be recovered days later — after an outage, a bad deploy,
 * or a mailbox address finally being filled in.
 */
export const SWEEP_WINDOW_MS = 7 * 24 * 3600_000;
export const SWEEP_BATCH = 50;

/**
 * The sweep's query, as one pure function so a test can hold it to account.
 *
 * ⛔⛔ Excluded tenants (Gesheft, still emailed by the PBX) MUST be filtered
 * HERE, in the query — never after the batch is chosen. Their voicemails are
 * deliberately never stamped (so they stay eligible the day they are
 * un-excluded), which makes them permanently `emailedAt: null`, permanently the
 * OLDEST rows, and therefore permanently the entire ascending batch of 50.
 * That is exactly what happened on 2026-08-18: every sweep for a day logged
 * `skipped: { excluded_tenant: 50 }` and no other tenant's voicemail was ever
 * looked at. Gesheft alone produces ~50 voicemails a day inside a 7-day window,
 * so the block can never clear on its own.
 *
 * `tenantId: null` (unresolved) rows are filtered for the same reason: the
 * sender cannot process them and never stamps them.
 */
export function buildVoicemailSweepWhere(input: { since: Date; excludedTenantIds: Iterable<string> }): {
  emailedAt: null;
  receivedAt: { gte: Date };
  deletedAt: null;
  tenantId: { not: null; notIn?: string[] };
} {
  const excluded = Array.from(new Set(Array.from(input.excludedTenantIds).map((s) => String(s || "").trim()).filter(Boolean)));
  return {
    emailedAt: null,
    receivedAt: { gte: input.since },
    deletedAt: null,
    // ⛔ `notIn` is only added when non-empty; keep `not: null` unconditional.
    tenantId: excluded.length > 0 ? { not: null, notIn: excluded } : { not: null },
  };
}

export const VOICEMAIL_EMAIL_SWEEP_INTERVAL_MS = 60_000;
export const VOICEMAIL_EMAIL_WATCHDOG_INTERVAL_MS = 15 * 60_000;

/** Attachment for a queued voicemail email. Null = do not send yet. */
export async function loadVoicemailAudioAttachment(job: {
  type: string;
  htmlBody?: string | null;
  textBody?: string | null;
}): Promise<VoicemailAudioAttachment | null> {
  if (job.type !== VOICEMAIL_EMAIL_TYPE) return null;
  return loadVoicemailAudioAttachmentForEmailJob(job, {
    findVoicemail: async (id) =>
      (await (db as any).voicemail.findUnique({
        where: { id },
        select: { localAudioPath: true, receivedAt: true },
      })) || null,
  });
}

async function loadExtensionConfig(tenantId: string, extension: string): Promise<ExtensionEmailConfig | null> {
  const ext = await (db as any).extension.findFirst({
    where: { tenantId, extNumber: extension, status: "ACTIVE" },
    select: {
      id: true, displayName: true, pbxUserEmail: true, vmEmailEnabled: true,
      voicemailEmailRecipients: { select: { email: true } },
    },
  });
  if (!ext) return null;
  return {
    id: ext.id,
    displayName: ext.displayName ?? null,
    pbxUserEmail: ext.pbxUserEmail ?? null,
    vmEmailEnabled: ext.vmEmailEnabled !== false,
    extraRecipients: (ext.voicemailEmailRecipients || []).map((r: { email: string }) => r.email),
  };
}

const VOICEMAIL_SELECT = {
  id: true, tenantId: true, extension: true, callerName: true, callerNumber: true,
  durationSec: true, receivedAt: true, transcript: true, transcriptLanguage: true,
  localAudioPath: true, audioGoneAt: true, emailedAt: true,
} as const;

/** The one set of side effects the sender needs — shared by the sweep AND the watchdog's rescue. */
function senderDeps() {
  return {
    loadExtension: loadExtensionConfig,
    queueEmail: async (p: { tenantId: string; type: string; toEmail: string; subject: string; htmlBody: string; textBody: string }) =>
      (db as any).emailJob.create({
        data: {
          tenantId: p.tenantId, type: p.type, toEmail: p.toEmail,
          subject: p.subject, htmlBody: p.htmlBody, textBody: p.textBody,
        },
      }),
    markProcessed: async (id: string, reason: string | null) =>
      (db as any).voicemail.update({
        where: { id },
        data: { emailedAt: new Date(), emailSkipReason: reason },
      }),
  };
}

/** Process a list of voicemails; one bad message never stops the rest. */
async function processVoicemails(pending: any[], log: Log): Promise<{ queued: number; skipped: Record<string, number> }> {
  let queued = 0;
  const skipped: Record<string, number> = {};
  const deps = senderDeps();
  for (const vm of pending) {
    try {
      const out = await processVoicemailForEmail(vm, deps as any);
      if (out.queued) queued++;
      else skipped[out.reason] = (skipped[out.reason] || 0) + 1;
    } catch (err) {
      // ⛔ One bad voicemail must never stop the sweep for the rest. It stays
      // unstamped, so the next pass retries it.
      log.warn({ voicemailId: vm.id, err: (err as Error)?.message }, "voicemail-email: one message failed, will retry");
    }
  }
  return { queued, skipped };
}

/** Queue emails for voicemails that need one. Safe to run every minute. */
export async function runVoicemailEmailSweep(log: Log): Promise<void> {
  if (!voicemailEmailEnabled()) return;
  try {
    const since = new Date(Date.now() - SWEEP_WINDOW_MS);
    const pending = await (db as any).voicemail.findMany({
      where: buildVoicemailSweepWhere({ since, excludedTenantIds: voicemailEmailExcludedTenantIds() }),
      orderBy: { receivedAt: "asc" },
      take: SWEEP_BATCH,
      select: VOICEMAIL_SELECT,
    });
    // ⛔ Heartbeat on EVERY completed pass, including an empty one — the liveness
    // guard reads it, and "nothing to do" is the normal state most minutes.
    if (pending.length === 0) {
      await recordHeartbeat("sweep", { considered: 0, queued: 0 });
      return;
    }
    const { queued, skipped } = await processVoicemails(pending, log);
    if (queued > 0 || Object.keys(skipped).length > 0) {
      log.info({ queued, skipped, considered: pending.length }, "voicemail-email: sweep complete");
    }
    await recordHeartbeat("sweep", { considered: pending.length, queued });
  } catch (err) {
    log.warn({ err: (err as Error)?.message }, "voicemail-email: sweep failed");
  }
}

/**
 * Reconcile what happened against what should have happened, and escalate any
 * real loss.
 *
 * ⛔⛔ Escalation, NEVER an ADMIN_ALERT email — that type is marked SKIPPED at
 * the send door platform-wide, so an alert sent that way reaches nobody. This is
 * a safety net; a safety net that cannot raise its voice is decoration.
 */
export async function runVoicemailEmailWatchdog(log: Log): Promise<VoicemailEmailGap[]> {
  if (!voicemailEmailEnabled()) return [];
  try {
    const since = new Date(Date.now() - SWEEP_WINDOW_MS);
    const excluded = voicemailEmailExcludedTenantIds();

    // ⛔ `Voicemail` has a `tenantId` COLUMN and NO `tenant` RELATION. Selecting
    // `tenant: { select: { name } }` here is a Prisma validation error, and it
    // made this watchdog throw on every run from its first deploy until
    // 2026-08-18 — a warn line nobody read, while the sweep it was built to
    // audit sat blocked for a day. Names are looked up separately.
    const rows = await (db as any).voicemail.findMany({
      where: { receivedAt: { gte: since }, deletedAt: null, tenantId: { not: null } },
      orderBy: { receivedAt: "desc" },
      take: 2000,
      select: {
        id: true, tenantId: true, extension: true, receivedAt: true,
        emailedAt: true, emailSkipReason: true,
      },
    });

    const tenantIds = Array.from(new Set(rows.map((r: any) => r.tenantId).filter(Boolean))) as string[];
    const tenantNameById = new Map<string, string | null>();
    if (tenantIds.length > 0) {
      const tenants = await (db as any).tenant.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, name: true },
      });
      for (const t of tenants) tenantNameById.set(t.id, t.name ?? null);
    }

    const eligible = rows
      .filter((r: any) => r.tenantId && !excluded.has(r.tenantId))
      .map((r: any) => ({
        id: r.id, tenantId: r.tenantId, tenantName: tenantNameById.get(r.tenantId) ?? null,
        extension: r.extension, receivedAt: r.receivedAt,
        emailedAt: r.emailedAt, emailSkipReason: r.emailSkipReason,
      }));
    if (eligible.length === 0) {
      noteWatchdogSuccess();
      await recordHeartbeat("watchdog", { eligible: 0, gaps: 0, rescued: 0 });
      return [];
    }

    // Map voicemail id -> the outcome of its email job, via the body marker.
    const jobs = await (db as any).emailJob.findMany({
      where: { type: VOICEMAIL_EMAIL_TYPE, createdAt: { gte: since } },
      select: { htmlBody: true, textBody: true, status: true, lastErrorMessage: true },
      take: 5000,
    });
    const jobStatusByVoicemailId = new Map<string, { status: string; lastErrorMessage?: string | null }>();
    for (const j of jobs) {
      const id = extractVoicemailIdFromEmailBody(`${j.htmlBody || ""}\n${j.textBody || ""}`);
      if (!id) continue;
      const prev = jobStatusByVoicemailId.get(id);
      // A SENT job wins over a failed earlier attempt for the same voicemail.
      if (!prev || j.status === "SENT") jobStatusByVoicemailId.set(id, { status: j.status, lastErrorMessage: j.lastErrorMessage });
    }

    let gaps = findVoicemailEmailGaps({ eligible, jobStatusByVoicemailId });

    // ── SELF-HEAL 1: a voicemail the sweep never reached is processed HERE, by
    // the watchdog, through its own query — so a blocked or dead sweep can no
    // longer strand anything (2026-08-18: Gesheft filled the sweep's batch for
    // a day and 7 customer voicemails sat behind it). Same sender, same
    // decision layer, same stamps; the only difference is who calls it.
    const stranded = gaps.filter((g) => g.problem === "never_processed").map((g) => g.voicemailId);
    if (stranded.length > 0) {
      const rows = await (db as any).voicemail.findMany({
        where: { id: { in: stranded.slice(0, 200) } },
        select: VOICEMAIL_SELECT,
      });
      const healed = await processVoicemails(rows, log);
      log.warn({ stranded: stranded.length, ...healed }, "voicemail-email: watchdog rescued voicemails the sweep never reached");
      // Re-judge: what was just queued/stamped is no longer a gap.
      const stampedNow = new Set(rows.map((r: any) => r.id));
      gaps = gaps.filter((g) => !(g.problem === "never_processed" && stampedNow.has(g.voicemailId)));
    }

    // ── SELF-HEAL 2: emails the outbox gave up on get another life once the
    // outbox has proven it can send again (bounded — see decideRequeue).
    await requeueDeadVoicemailEmails(log);

    const alertable = gapsWorthAlerting(gaps);

    if (gaps.length > 0) {
      log.warn(
        { total: gaps.length, alertable: alertable.length, byProblem: countBy(gaps) },
        "voicemail-email: watchdog found gaps",
      );
    }

    if (alertable.length > 0) {
      const summary = describeVoicemailEmailGaps(alertable);
      await raiseVoicemailEscalation(summary, alertable.length, log);
    }
    noteWatchdogSuccess();
    await recordHeartbeat("watchdog", { eligible: eligible.length, gaps: gaps.length, rescued: stranded.length });
    return gaps;
  } catch (err) {
    // ⛔ A watchdog that cannot run must scream — its silent failure is exactly
    // how the 2026-08-18 outage went unnoticed. Three in a row escalates.
    await noteWatchdogFailure(err, log);
    return [];
  }
}

function countBy(gaps: VoicemailEmailGap[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of gaps) out[g.problem] = (out[g.problem] || 0) + 1;
  return out;
}

/**
 * ⛔ De-duplicated: one open escalation at a time. Without this a persistent
 * fault texts on every sweep until the phone is unusable and the alarm is muted
 * by the human — which is the same as having no alarm.
 */
async function raiseVoicemailEscalation(summary: string, count: number, log: Log): Promise<void> {
  try {
    const open = await (db as any).agentEscalation.findFirst({
      where: { requestSummary: { startsWith: "Voicemail emails did not go out" }, status: { in: ["QUEUED", "SENT"] } },
      select: { id: true, createdAt: true },
    });
    if (open) {
      log.info({ existing: open.id }, "voicemail-email: gap already escalated, not re-alerting");
      return;
    }
    const tenant = await (db as any).tenant.findFirst({ select: { id: true, name: true } });
    if (!tenant) return;
    await (db as any).agentEscalation.create({
      data: {
        tenantId: tenant.id,
        tenantName: tenant.name || "Loopcom",
        userName: "voicemail watchdog",
        requestSummary: `Voicemail emails did not go out (${count})`,
        smsBody: `Loopcom: ${count} voicemail email${count === 1 ? "" : "s"} did not reach anyone. Check the voicemail watchdog.`,
        report: summary,
        proposedFix: "Check the email outbox and the voicemail sender log. Affected messages are listed above and can be re-sent once the cause is fixed.",
      },
    });
    log.warn({ count }, "voicemail-email: escalation raised");
  } catch (err) {
    log.warn({ err: (err as Error)?.message }, "voicemail-email: could not raise escalation");
  }
}
