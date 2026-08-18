/**
 * The watchdog. This is the piece that makes "it can never silently fail" true.
 *
 * ⛔ The sender is not trusted to be correct. This reconciles what actually
 * happened — every voicemail that should have produced an email, against every
 * email that actually reached SENT — and reports the difference.
 *
 * ⛔⛔ ALERTS MUST NOT USE `ADMIN_ALERT`. That type is muted at the send door
 * platform-wide: `processEmailJobsBatch` marks every ADMIN_ALERT job SKIPPED
 * with `ALERTS_MUTED` and it is never delivered. A watchdog built on it would be
 * a safety net that silently catches nothing — the exact shape of the bug it
 * exists to prevent. Escalations are the only channel proven to reach Izzy.
 */

/** A voicemail that should have produced an email and did not. */
export type VoicemailEmailGap = {
  voicemailId: string;
  tenantId: string | null;
  tenantName: string | null;
  extension: string;
  receivedAt: Date | null;
  /** What went wrong, in words a person can act on. */
  problem:
    /** Never processed at all — the sender never reached it. */
    | "never_processed"
    /** Queued, but the outbox gave up after maxAttempts. */
    | "delivery_failed"
    /** Queued and stamped, but no job row exists — it was lost. */
    | "job_missing"
    /** Nobody is configured to receive this mailbox's voicemail. */
    | "no_recipient";
  detail?: string | null;
};

export type WatchdogInput = {
  /** Voicemails in the window that were eligible (audio, long enough, tenant not excluded). */
  eligible: Array<{
    id: string;
    tenantId: string | null;
    tenantName: string | null;
    extension: string;
    receivedAt: Date | null;
    emailedAt: Date | null;
    emailSkipReason: string | null;
  }>;
  /** Outcome of the email job for a voicemail id, when one exists. */
  jobStatusByVoicemailId: Map<string, { status: string; lastErrorMessage?: string | null }>;
};

/** Skip reasons that are correct behaviour and must never raise an alarm. */
const DELIBERATE_SKIPS = new Set([
  "disabled",
  "no_recording",
  "too_short",
  "already_queued",
  "predates_feature",
]);

/**
 * ⛔ Read the whole comparison before changing a branch. Each case answers a
 * different question, and collapsing them is how a real miss gets filed as
 * normal.
 */
/**
 * How long a voicemail may sit unprocessed before "never_processed" is a real
 * finding. The sweep runs every 60 s and an api deploy restarts it, so a message
 * that arrived moments before a watchdog tick is not a loss — it is next in the
 * queue. Without this, every watchdog run raced the sweep and could text the
 * owner about a voicemail that emailed thirty seconds later.
 */
export const NEVER_PROCESSED_GRACE_MS = 10 * 60_000;

export function findVoicemailEmailGaps(input: WatchdogInput, now: Date = new Date()): VoicemailEmailGap[] {
  const gaps: VoicemailEmailGap[] = [];

  for (const vm of input.eligible) {
    const base = {
      voicemailId: vm.id,
      tenantId: vm.tenantId,
      tenantName: vm.tenantName,
      extension: vm.extension,
      receivedAt: vm.receivedAt,
    };

    // Deliberately skipped — correct behaviour, silent.
    if (vm.emailSkipReason && DELIBERATE_SKIPS.has(vm.emailSkipReason)) continue;

    // Nobody to send to. Not a bug in us, but it IS a customer not being told,
    // so it is reported every time until an address is added.
    if (vm.emailSkipReason === "no_recipient") {
      gaps.push({ ...base, problem: "no_recipient", detail: "no email address on this mailbox" });
      continue;
    }

    // Never touched by the sender at all — but only once it has had time to be.
    if (!vm.emailedAt) {
      const ageMs = vm.receivedAt ? now.getTime() - vm.receivedAt.getTime() : Number.POSITIVE_INFINITY;
      if (ageMs < NEVER_PROCESSED_GRACE_MS) continue;
      gaps.push({ ...base, problem: "never_processed", detail: "the sender never reached this voicemail" });
      continue;
    }

    // Stamped as queued — so a job must exist and must have been delivered.
    const job = input.jobStatusByVoicemailId.get(vm.id);
    if (!job) {
      gaps.push({ ...base, problem: "job_missing", detail: "marked as queued but no email job exists" });
      continue;
    }
    if (job.status === "FAILED" || job.status === "SKIPPED") {
      gaps.push({
        ...base,
        problem: "delivery_failed",
        detail: job.lastErrorMessage || `email job ended ${job.status}`,
      });
      continue;
    }
    // QUEUED is fine — it is still in the retry ladder, not a miss yet.
  }

  return gaps;
}

/** One line per gap, in plain English. This is what Izzy actually reads. */
export function describeVoicemailEmailGaps(gaps: VoicemailEmailGap[]): string {
  if (gaps.length === 0) return "All voicemail emails went out.";
  const byProblem = new Map<string, VoicemailEmailGap[]>();
  for (const g of gaps) {
    if (!byProblem.has(g.problem)) byProblem.set(g.problem, []);
    byProblem.get(g.problem)!.push(g);
  }
  const words: Record<VoicemailEmailGap["problem"], string> = {
    never_processed: "never picked up by the sender",
    delivery_failed: "the email failed to send",
    job_missing: "marked sent but no email exists",
    no_recipient: "no email address on the mailbox",
  };
  const lines: string[] = [`${gaps.length} voicemail${gaps.length === 1 ? "" : "s"} did not reach anyone:`];
  for (const [problem, list] of byProblem) {
    lines.push(`\n${list.length} × ${words[problem as VoicemailEmailGap["problem"]]}:`);
    for (const g of list.slice(0, 10)) {
      const when = g.receivedAt ? new Date(g.receivedAt).toISOString().replace("T", " ").slice(0, 16) : "unknown time";
      lines.push(`  • ${g.tenantName || g.tenantId || "unknown tenant"} ext ${g.extension} — ${when}`);
    }
    if (list.length > 10) lines.push(`  …and ${list.length - 10} more`);
  }
  return lines.join("\n");
}

/**
 * ⛔ `no_recipient` is a standing condition — 66 of 154 extensions have no
 * address today — so it must not re-alert every sweep or the alarm becomes
 * noise and gets ignored. Real delivery failures alert every time.
 */
export function gapsWorthAlerting(gaps: VoicemailEmailGap[]): VoicemailEmailGap[] {
  return gaps.filter((g) => g.problem !== "no_recipient");
}
