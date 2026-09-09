/**
 * Autopay-block alarm (2026-09-09).
 *
 * WHY THIS EXISTS: the worker refuses to invoice or charge a tenant while a
 * MAPPED + active Sola recurring schedule on that tenant has not been cut over
 * (a correct double-charge guard). But the refusal was invisible: the T-3
 * reminder phase skipped with no event at all, and the due-date charge phase
 * wrote an hourly BillingEventLog row that nobody reads. Secro Selutions lost
 * its 2026-08-06 AND 2026-09-06 cycles that way — the "active" link was Fixup
 * Group's schedule, mis-mapped onto Secro in May — and the owner found out from
 * the customer both times. A block on a paying tenant must reach a person.
 *
 * Escalation only (SMS + email through agentEscalationDispatch). Never an
 * ADMIN_ALERT — that type is muted at the send door. De-duped per tenant + link
 * on a rolling window so a persistent block texts once per window, not every
 * hourly tick.
 */

export const AUTOPAY_BLOCK_ALARM_PREFIX = "Autopay blocked by an un-cutover Sola schedule";
export const AUTOPAY_BLOCK_ALARM_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ADMIN_ALERT_TENANT_ID = "connect-admin-tenant-v1";

export type AutopayBlockInput = {
  tenantId: string;
  tenantName: string;
  phase: "reminder" | "charge";
  linkId: string;
  solaScheduleId: string;
  /** Company name the Sola schedule itself carries — the tell for a mis-map. */
  linkCompanyName: string | null;
  paymentDate: string;
};

export function autopayBlockAlarmKey(input: Pick<AutopayBlockInput, "tenantId" | "linkId">): string {
  return `${AUTOPAY_BLOCK_ALARM_PREFIX} — ${input.tenantId} — ${input.linkId}`;
}

/** Pure: given the newest matching escalation, should a new one be raised now? */
export function decideAutopayBlockAlarm(input: {
  now: Date;
  recentCreatedAt: Date | null;
  windowMs?: number;
}): { raise: boolean; reason: string } {
  const windowMs = input.windowMs ?? AUTOPAY_BLOCK_ALARM_WINDOW_MS;
  if (!input.recentCreatedAt) return { raise: true, reason: "first_alarm" };
  const age = input.now.getTime() - input.recentCreatedAt.getTime();
  if (age < 0) return { raise: false, reason: "future_dated_row" };
  if (age < windowMs) return { raise: false, reason: "inside_window" };
  return { raise: true, reason: "window_elapsed" };
}

/**
 * "Secro Selutions" (Connect, as the customer typed it) vs "Secro solutions"
 * (Sola) is the SAME company — a mis-map call must survive a typo or two, or
 * every alarm reads as a mis-map and the real one stops standing out.
 */
export function sameCompany(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const tolerance = Math.max(2, Math.floor(Math.max(x.length, y.length) * 0.2));
  return levenshtein(x, y) <= tolerance;
}

function levenshtein(a: string, b: string): number {
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let left = i;
    let diag = i - 1;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(up + 1, left + 1, diag + cost);
      prev[j - 1] = left;
      left = val;
      diag = up;
    }
    prev[b.length] = left;
  }
  return prev[b.length];
}

export function buildAutopayBlockAlarmText(input: AutopayBlockInput): { summary: string; sms: string; report: string } {
  const key = autopayBlockAlarmKey(input);
  const label = input.linkCompanyName ? ` Sola labels that schedule "${input.linkCompanyName}".` : "";
  const mismap =
    input.linkCompanyName && !sameCompany(input.linkCompanyName, input.tenantName)
      ? ` That is not this tenant's name, so it is probably mapped to the wrong company.`
      : "";
  const verb = input.phase === "reminder" ? "invoiced" : "charged";
  const summary = `${key} — ${input.tenantName} (${input.phase} phase, payment date ${input.paymentDate})`;
  const sms =
    `Loopcom billing: ${input.tenantName} was NOT ${verb} for ${input.paymentDate}. ` +
    `Autopay is blocked by Sola schedule ${input.solaScheduleId} (link ${input.linkId}) that was never cut over.` +
    label +
    mismap +
    ` Fix on /admin/billing/sola-imports (unmap it, or complete the take-over), then collect the missed cycle by hand.`;
  const report =
    `ISSUE\nConnect autopay for ${input.tenantName} (${input.tenantId}) is blocked in the ${input.phase} phase for payment date ${input.paymentDate}.\n\n` +
    `FINDINGS\nBillingSolaExternalScheduleLink ${input.linkId} (Sola schedule ${input.solaScheduleId}) is MAPPED to this tenant, isActive, and its cutoverStatus is not CUTOVER_COMPLETE.${label}${mismap}\n` +
    `While it stands, the worker will neither create this tenant's invoice nor charge the card — every cycle is silently lost.\n\n` +
    `PROPOSED FIX\nOn /admin/billing/sola-imports: if the schedule belongs to another company, unmap it from ${input.tenantName} and map it to the right tenant; if it is this tenant's own live Sola schedule, complete the billing take-over so Sola is disabled and Connect charges from the next cycle. Then create and collect the missed cycle by hand.\n`;
  return { summary, sms, report };
}

/**
 * Raise the escalation (idempotent inside the window). Never throws — a failure
 * to alarm must not break the billing sweep that found the problem.
 */
export async function raiseAutopayBlockAlarm(
  database: any,
  input: AutopayBlockInput,
  opts: { now?: Date; log?: { warn?: (o: any, m?: string) => void; info?: (o: any, m?: string) => void } } = {},
): Promise<{ raised: boolean; reason: string }> {
  const now = opts.now ?? new Date();
  const key = autopayBlockAlarmKey(input);
  try {
    const recent = await database.agentEscalation.findFirst({
      where: { requestSummary: { startsWith: key } },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    });
    const decision = decideAutopayBlockAlarm({ now, recentCreatedAt: recent?.createdAt ?? null });
    if (!decision.raise) return { raised: false, reason: decision.reason };
    const text = buildAutopayBlockAlarmText(input);
    await database.agentEscalation.create({
      data: {
        tenantId: ADMIN_ALERT_TENANT_ID,
        tenantName: "Loopcom platform",
        clientUserId: null,
        userName: "autopay block guardrail",
        userEmail: null,
        requestSummary: text.summary,
        smsBody: text.sms,
        report: text.report,
        proposedFix: "",
        researchDegraded: false,
        status: "QUEUED",
      },
    });
    opts.log?.warn?.({ tenantId: input.tenantId, linkId: input.linkId, phase: input.phase }, "autopay-block: escalation raised");
    return { raised: true, reason: decision.reason };
  } catch (err: any) {
    opts.log?.warn?.({ err: String(err?.message || err), tenantId: input.tenantId }, "autopay-block: escalation failed");
    return { raised: false, reason: "error" };
  }
}
