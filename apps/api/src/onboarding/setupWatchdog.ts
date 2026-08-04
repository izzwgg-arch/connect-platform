import { db } from "@connect/db";
import { applyOnboardingNumber } from "./voipMsProvisioning";
import { runOnboardingSetup } from "./setupOrchestrator";

/**
 * setupWatchdog — the safety net under runOnboardingSetup.
 *
 * The orchestrator's own stale-in-flight detection only runs when something
 * CALLS it. If the API restarts while a paid sign-up is mid-build, nothing
 * ever calls it again: the row sits in "building"/"syncing"/"inviting"
 * forever, the customer's progress page spins forever, and no failure report
 * goes out (live audit finding 2026-08-04).
 *
 * This sweep runs on a timer from server boot and re-kicks any paid,
 * not-finished submission that nothing has touched for longer than the stale
 * window. Both applyOnboardingNumber and runOnboardingSetup are idempotent and
 * resume where they left off, so re-kicking is always safe.
 *
 * A submission that keeps stalling is not retried forever: after
 * MAX_WATCHDOG_RESUMES automatic resumes (counted from the event timeline, so
 * the count survives restarts) the watchdog stops touching it and sends ONE
 * plain-English admin alert email instead.
 */

/** Resume events must START with this so the timeline doubles as the retry counter. */
export const WATCHDOG_RESUME_MESSAGE = "Watchdog resumed a stalled setup";
const WATCHDOG_GIVE_UP_PREFIX = "Watchdog gave up";
const MAX_WATCHDOG_RESUMES = 5;

// Same ADMIN_ALERT EmailJob channel as adminSignupReport.ts / the billing alerts.
const ADMIN_ALERT_TENANT_ID = "connect-admin-tenant-v1";

function recipient(): string {
  return (process.env.ADMIN_ALERT_EMAIL || "tod10950@gmail.com").trim();
}

function staleMs(): number {
  return Number(process.env.ONBOARDING_INFLIGHT_STALE_MS || 15 * 60_000);
}

/** Every pbxSetupStatus that means "the customer paid but has no working system yet". */
const UNFINISHED_SETUP_STATUSES = ["queued", "building", "syncing", "inviting", "failed"] as const;

/**
 * Paid, not canceled, setup not finished, and nothing has touched the row for
 * longer than the stale window — i.e. no run is alive, and none will start on
 * its own. Shared with the public progress endpoint so the customer's screen
 * and the watchdog agree on what "stuck" means.
 */
export function isSetupStalled(
  row: { paidAt?: Date | null; status?: string | null; pbxSetupStatus?: string | null; updatedAt?: Date | string | null } | null | undefined,
  now = Date.now(),
): boolean {
  if (!row || !row.paidAt) return false;
  if (String(row.status || "") === "CANCELED") return false;
  const setup = row.pbxSetupStatus == null ? null : String(row.pbxSetupStatus);
  if (setup !== null && !(UNFINISHED_SETUP_STATUSES as readonly string[]).includes(setup)) return false;
  return now - new Date(row.updatedAt || 0).getTime() >= staleMs();
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function queueGiveUpAlert(row: any): Promise<void> {
  const company = String(row.companyName || "an unnamed sign-up");
  const lines = [
    `${company} paid for their phone system, but the automatic setup keeps getting stuck.`,
    "",
    `The system already restarted it ${MAX_WATCHDOG_RESUMES} times on its own and it still did not finish, so it has stopped retrying.`,
    `Where it is stuck: ${row.pbxSetupStatus ? `"${row.pbxSetupStatus}"` : "it never started"}.`,
    ...(row.setupError ? [`The system's reason, roughly: ${String(row.setupError)}`] : []),
    ...(row.mainEmail ? [`Customer email: ${String(row.mainEmail)}`] : []),
    "",
    "This customer has paid and is waiting. Open the admin onboarding page for this sign-up, look at the timeline, and use the Retry button once the underlying problem is fixed.",
  ];
  await (db as any).emailJob.create({
    data: {
      tenantId: ADMIN_ALERT_TENANT_ID,
      invoiceId: null,
      type: "ADMIN_ALERT",
      toEmail: recipient(),
      subject: `[Connect] Onboarding stuck: ${company} — automatic retries exhausted`,
      htmlBody: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;white-space:pre-wrap">${lines.map(escapeHtml).join("<br/>")}</div>`,
      textBody: lines.join("\n"),
    },
  });
}

async function logEvent(submissionId: string, message: string): Promise<void> {
  try {
    await (db as any).onboardingEvent.create({
      data: { submissionId, type: "STATUS_CHANGED", message: message.slice(0, 480) },
    });
  } catch {
    /* event logging is best-effort */
  }
}

export type WatchdogSweepSummary = { scanned: number; resumed: number; alerted: number };

let sweepRunning = false;

export async function sweepStalledOnboardingSetups(): Promise<WatchdogSweepSummary> {
  const summary: WatchdogSweepSummary = { scanned: 0, resumed: 0, alerted: 0 };
  if (sweepRunning) return summary; // a resumed build can outlive the interval — never overlap
  sweepRunning = true;
  try {
    const cutoff = new Date(Date.now() - staleMs());
    const rows = await (db as any).onboardingSubmission.findMany({
      where: {
        paidAt: { not: null },
        status: { not: "CANCELED" },
        updatedAt: { lt: cutoff },
        OR: [
          { pbxSetupStatus: null },
          { pbxSetupStatus: { in: [...UNFINISHED_SETUP_STATUSES] } },
        ],
      },
      select: {
        id: true,
        companyName: true,
        mainEmail: true,
        status: true,
        paidAt: true,
        pbxSetupStatus: true,
        setupError: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "asc" },
      take: 20,
    });
    summary.scanned = rows.length;

    for (const row of rows) {
      // The timeline is the retry counter: it survives restarts, and the admin
      // page shows every attempt.
      const priorResumes = await (db as any).onboardingEvent.count({
        where: { submissionId: row.id, message: { startsWith: WATCHDOG_RESUME_MESSAGE } },
      });

      if (priorResumes >= MAX_WATCHDOG_RESUMES) {
        const alreadyGaveUp = await (db as any).onboardingEvent.findFirst({
          where: { submissionId: row.id, message: { startsWith: WATCHDOG_GIVE_UP_PREFIX } },
        });
        if (!alreadyGaveUp) {
          await logEvent(
            row.id,
            `${WATCHDOG_GIVE_UP_PREFIX} after ${MAX_WATCHDOG_RESUMES} automatic resumes — a human needs to look. Admin alerted by email.`,
          );
          await queueGiveUpAlert(row).catch(() => { /* the give-up event still marks it handled */ });
          summary.alerted++;
        }
        continue;
      }

      const stuckFor = Math.round((Date.now() - new Date(row.updatedAt || 0).getTime()) / 60_000);
      await logEvent(
        row.id,
        `${WATCHDOG_RESUME_MESSAGE} (stuck in "${row.pbxSetupStatus || "not started"}" for ${stuckFor} min) — attempt ${priorResumes + 1} of ${MAX_WATCHDOG_RESUMES}.`,
      );
      await applyOnboardingNumber(row.id).catch(() => { /* logged inside */ });
      await runOnboardingSetup(row.id).catch(() => { /* failure recorded on the row */ });
      summary.resumed++;
    }
  } finally {
    sweepRunning = false;
  }
  return summary;
}
