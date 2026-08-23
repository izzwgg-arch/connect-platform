// ── LoopCom's regulatory compliance calendar ─────────────────────────────────
//
// Izzy's ask (2026-08-23, the day the RMD was filed): a separate super-admin
// page listing every regulatory deadline, reminders that stay on the
// super-admin dashboard until each item is completed, and — starting a month
// before a due date and then once a week — a TEXT to his phone and an EMAIL.
//
// Shape (the yiddishLabsCreditWatch pattern, but with its own delivery):
//   - `ComplianceItem` rows are the state. Seeded federal items carry a stable
//     `key` so the boot seed is idempotent; hand-added items have key null.
//   - A pure decision function (`decideComplianceReminder`) says when to
//     remind: due within REMINDER_LEAD_DAYS, and no reminder in the last
//     ~week. It keeps firing weekly PAST the due date until someone marks the
//     item done — an overdue federal filing is the one you most need nagging
//     about.
//   - The sweep runs hourly with a boot kick (⛔ a bare interval with no boot
//     run is starved by deploy churn — the watchdog-heartbeat lesson), and the
//     cadence state lives on the ROW (`lastReminderAt`), never in a module
//     variable, so api restarts cannot re-send or skip.
//
// Delivery — deliberately NOT an AgentEscalation: the escalation channel
// de-dupes on an open row with the same summary, which makes every alarm key
// one-shot (the documented hole), and it texts BOTH owner numbers + the
// escalation mailbox. Izzy asked for a weekly cadence to HIS number and HIS
// email, so this sends directly:
//   - SMS via resolveBillingSmsSender() — the platform's own (845) 723-1213,
//     the same proven sender the pay-link texts and login codes use. Bounded
//     by construction: at most one text per item per week.
//   - Email as an EmailJob of type COMPLIANCE_REMINDER. ⛔ NEVER "ADMIN_ALERT"
//     — that category is muted at the send door and would build clean, log
//     clean and reach nobody.
//
// Completing a yearly item ROLLS ITS DUE DATE FORWARD one year (and clears the
// reminder state) instead of closing the row — the calendar's whole point is
// that March 1 comes back every year.

import { db } from "@connect/db";
import { z } from "zod";
import { resolveBillingSmsSender } from "./billing/billingSmsSender";
import { emailShell } from "./billing/emailTemplates";
import { resolveInvoiceEmailBranding } from "./billing/invoiceBranding";

type Log = { info?: (o: any, m?: string) => void; warn?: (o: any, m?: string) => void; error?: (o: any, m?: string) => void } | undefined;

export const COMPLIANCE_REMINDER_EMAIL_TYPE = "COMPLIANCE_REMINDER";

/** First reminder this many days before the due date. */
export const REMINDER_LEAD_DAYS = 30;
/**
 * Minimum gap between reminders for one item. 6.5 days, not 7, so an hourly
 * sweep that lands a little early never slips the cadence to 8 days.
 */
export const REMINDER_REPEAT_MS = Math.round(6.5 * 24 * 60 * 60 * 1000);

const DAY_MS = 24 * 60 * 60 * 1000;

function reminderSmsTo(): string {
  return (process.env.COMPLIANCE_REMINDER_SMS_TO || "+15622096644").trim();
}
function reminderEmailTo(): string {
  return (process.env.COMPLIANCE_REMINDER_EMAIL || "izzy@loopcom.net").trim();
}
/** EmailJob.tenantId is required; platform mail rides the admin tenant like the OTP emails do. */
function reminderTenantId(): string {
  return (process.env.COMPLIANCE_REMINDER_TENANT_ID || "connect-admin-tenant-v1").trim();
}

// ── The standing federal calendar ────────────────────────────────────────────
// Due dates are stored at NOON UTC on purpose: midnight UTC renders as the
// previous evening in New York, and a deadline that displays a day early (or
// late) on a screen is how a filing gets missed.

export type ComplianceSeed = {
  key: string;
  title: string;
  details: string;
  dueDate: string; // YYYY-MM-DD
  recurrence: "yearly" | null;
};

export const COMPLIANCE_SEED_ITEMS: ComplianceSeed[] = [
  {
    key: "rmd-recertification",
    title: "Robocall Mitigation Database recertification",
    details:
      "Re-certify LoopCom's RMD filing (FRN 0038803722) at fccprod.servicenowservices.com/rmd. Review the mitigation plan first and update anything that changed (carriers, contacts, STIR/SHAKEN status).",
    dueDate: "2027-03-01",
    recurrence: "yearly",
  },
  {
    key: "cpni-certification",
    title: "CPNI certification (EB Docket 06-36)",
    details:
      "Annual officer certification that LoopCom protects customer proprietary network information. Filed in the FCC's ECFS under EB Docket 06-36, signed by an officer (Israel Weinstock).",
    dueDate: "2027-03-01",
    recurrence: "yearly",
  },
  {
    key: "form-499a-annual",
    title: "FCC Form 499-A annual revenue filing (USAC)",
    details:
      "The full annual 499-A in USAC E-File (EIN 42-4556370, dashed). Reports prior-year revenue; confirms de minimis status for USF. E-File quirk: buttons often need a second click.",
    dueDate: "2027-04-01",
    recurrence: "yearly",
  },
  {
    key: "cvaa-rcci-certification",
    title: "CVAA accessibility recordkeeping certification (RCCCI)",
    details:
      "Annual certification in the FCC's RCCCI registry that LoopCom keeps records of accessibility efforts (Section 255/716).",
    dueDate: "2027-04-01",
    recurrence: "yearly",
  },
  {
    key: "bdc-june-data",
    title: "Broadband Data Collection — June 30 subscriber data",
    details:
      "BDC filing of voice subscriber counts as of June 30, due September 1. FIRST ONE: confirm whether a filer this new owes the 2026 round before filing — if not, mark done to roll it to next year.",
    dueDate: "2026-09-01",
    recurrence: "yearly",
  },
  {
    key: "bdc-december-data",
    title: "Broadband Data Collection — December 31 subscriber data",
    details: "BDC filing of voice subscriber counts as of December 31, due March 1.",
    dueDate: "2027-03-01",
    recurrence: "yearly",
  },
  {
    key: "dc-agent-renewal",
    title: "D.C. agent for service of process — renewal",
    details:
      "Registered Agents Inc. ($150/yr, auto-renews on the Visa via washingtondcregisteredagent.com). Confirm the card on file is alive and the renewal went through — a lapsed agent invalidates the 499/RMD contact.",
    dueDate: "2027-08-20",
    recurrence: "yearly",
  },
];

/** Parse a YYYY-MM-DD into noon-UTC, refusing garbage. */
export function complianceDate(ymd: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(`${ymd}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Round-trip so 2027-02-30 (which Date silently rolls to March) is refused.
  if (d.toISOString().slice(0, 10) !== ymd) return null;
  return d;
}

/** One year later, same month/day (Feb 29 lands on Feb 28). */
export function rollDueDateForwardOneYear(due: Date): Date {
  const y = due.getUTCFullYear() + 1;
  const m = due.getUTCMonth();
  const day = due.getUTCDate();
  const next = new Date(Date.UTC(y, m, day, 12, 0, 0));
  if (next.getUTCMonth() !== m) {
    // Feb 29 → Mar 1 overflow: pin to the last day of the intended month.
    return new Date(Date.UTC(y, m + 1, 0, 12, 0, 0));
  }
  return next;
}

export function daysUntil(due: Date, now: Date): number {
  return Math.ceil((due.getTime() - now.getTime()) / DAY_MS);
}

export type ComplianceReminderInput = {
  dueDate: Date;
  completedAt: Date | null;
  lastReminderAt: Date | null;
};

/**
 * The cadence Izzy asked for, verbatim: "a month and then once a week after
 * that". A completed item never reminds; an overdue item KEEPS reminding
 * weekly until completed.
 */
export function decideComplianceReminder(item: ComplianceReminderInput, now: Date): boolean {
  if (item.completedAt) return false;
  if (daysUntil(item.dueDate, now) > REMINDER_LEAD_DAYS) return false;
  if (item.lastReminderAt && now.getTime() - item.lastReminderAt.getTime() < REMINDER_REPEAT_MS) return false;
  return true;
}

function humanDate(d: Date): string {
  return d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" });
}

/**
 * ⛔ Plain ASCII on purpose — one emoji or curly quote flips the whole message
 * to UCS-2 and a 160-char segment becomes 70 (the escalation-SMS lesson).
 */
export function buildComplianceReminderSms(title: string, due: Date, now: Date): string {
  const days = daysUntil(due, now);
  const when =
    days > 1 ? `due in ${days} days (${humanDate(due)})` : days === 1 ? `due TOMORROW (${humanDate(due)})` : days === 0 ? `due TODAY` : `OVERDUE by ${Math.abs(days)} days (was due ${humanDate(due)})`;
  return `LoopCom compliance: ${title} is ${when}. Mark it done on the portal Compliance page when filed.`;
}

export function buildComplianceReminderEmail(title: string, details: string | null, due: Date, now: Date): { subject: string; html: string; text: string } {
  const days = daysUntil(due, now);
  const when =
    days > 1 ? `due in ${days} days, on ${humanDate(due)}` : days === 1 ? `due tomorrow, ${humanDate(due)}` : days === 0 ? `due today` : `overdue — it was due ${humanDate(due)}`;
  const subject = days >= 0 ? `Compliance deadline: ${title} — ${days} day${days === 1 ? "" : "s"} left` : `OVERDUE compliance filing: ${title}`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = `
    <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#111827;"><strong>${esc(title)}</strong> is ${esc(when)}.</p>
    ${details ? `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#374151;">${esc(details)}</p>` : ""}
    <p style="margin:0;font-size:14px;line-height:1.6;color:#374151;">When it is filed, mark it done on the portal's <strong>Admin &rarr; Compliance</strong> page — that stops these reminders${days >= 0 ? "" : " and clears the dashboard banner"}.</p>
  `;
  const html = emailShell("Compliance deadline", body, resolveInvoiceEmailBranding({}, null), {
    eyebrow: "Compliance",
    footerNote: "Sent by the Loopcom compliance calendar.",
    includeSupportBlock: false,
  });
  const text = `${title} is ${when}.\n\n${details || ""}\n\nMark it done on the portal's Admin -> Compliance page when filed.`;
  return { subject, html, text };
}

// ── Seed ─────────────────────────────────────────────────────────────────────

/**
 * Create any seeded item that does not exist yet. CREATE-ONLY on purpose: a
 * due date Izzy edited, an item he completed/rolled forward, must never be
 * reset by a deploy.
 */
export async function ensureComplianceSeed(dbc: any = db, log?: Log): Promise<number> {
  let created = 0;
  for (const seed of COMPLIANCE_SEED_ITEMS) {
    try {
      const existing = await dbc.complianceItem.findUnique({ where: { key: seed.key }, select: { id: true } });
      if (existing) continue;
      const due = complianceDate(seed.dueDate);
      if (!due) continue;
      await dbc.complianceItem.create({
        data: { key: seed.key, title: seed.title, details: seed.details, dueDate: due, recurrence: seed.recurrence },
      });
      created++;
    } catch (err: any) {
      log?.warn?.({ err: String(err?.message || err), key: seed.key }, "[COMPLIANCE] seed failed");
    }
  }
  if (created > 0) log?.info?.({ created }, "[COMPLIANCE] seeded calendar items");
  return created;
}

// ── The sweep ────────────────────────────────────────────────────────────────

export async function runComplianceReminderSweep(
  dbc: any = db,
  log?: Log,
  now = new Date(),
  // Injectable for tests only — production always uses the real billing sender.
  senderResolver: typeof resolveBillingSmsSender = resolveBillingSmsSender,
): Promise<{ considered: number; reminded: number; errors: string[] }> {
  const errors: string[] = [];
  let reminded = 0;
  let items: any[] = [];
  try {
    items = await dbc.complianceItem.findMany({ where: { completedAt: null }, orderBy: { dueDate: "asc" } });
  } catch (err: any) {
    errors.push(`query: ${String(err?.message || err).slice(0, 200)}`);
    log?.warn?.({ errors }, "[COMPLIANCE] sweep could not read items");
    return { considered: 0, reminded: 0, errors };
  }

  for (const item of items) {
    if (!decideComplianceReminder({ dueDate: item.dueDate, completedAt: item.completedAt, lastReminderAt: item.lastReminderAt }, now)) continue;

    // Claim the slot FIRST (updateMany conditioned on the value we read) so a
    // racing second api process cannot double-text — the reset-race lesson.
    try {
      const claim = await dbc.complianceItem.updateMany({
        where: { id: item.id, completedAt: null, lastReminderAt: item.lastReminderAt },
        data: { lastReminderAt: now, reminderCount: { increment: 1 } },
      });
      if (!claim?.count) continue;
    } catch (err: any) {
      errors.push(`claim ${item.id}: ${String(err?.message || err).slice(0, 160)}`);
      continue;
    }

    let smsOk = false;
    let emailOk = false;

    try {
      const sender = await senderResolver();
      if (sender.ok) {
        await sender.send({ tenantId: reminderTenantId(), to: reminderSmsTo(), body: buildComplianceReminderSms(item.title, item.dueDate, now) });
        smsOk = true;
      } else {
        errors.push(`sms ${item.id}: ${sender.error}`);
      }
    } catch (err: any) {
      errors.push(`sms ${item.id}: ${String(err?.message || err).slice(0, 160)}`);
    }

    try {
      const mail = buildComplianceReminderEmail(item.title, item.details, item.dueDate, now);
      await dbc.emailJob.create({
        data: {
          tenantId: reminderTenantId(),
          type: COMPLIANCE_REMINDER_EMAIL_TYPE,
          toEmail: reminderEmailTo(),
          subject: mail.subject,
          htmlBody: mail.html,
          textBody: mail.text,
        },
        select: { id: true },
      });
      emailOk = true;
    } catch (err: any) {
      errors.push(`email ${item.id}: ${String(err?.message || err).slice(0, 160)}`);
    }

    if (smsOk || emailOk) reminded++;
    log?.info?.({ item: item.key || item.id, title: item.title, smsOk, emailOk }, "[COMPLIANCE] reminder sent");
  }

  if (errors.length) log?.warn?.({ errors }, "[COMPLIANCE] sweep finished with errors");
  return { considered: items.length, reminded, errors };
}

// ── Boot wiring ──────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = Math.max(10 * 60_000, Number(process.env.COMPLIANCE_SWEEP_INTERVAL_MS || 60 * 60_000));
const BOOT_DELAY_MS = Math.max(30_000, Number(process.env.COMPLIANCE_SWEEP_BOOT_DELAY_MS || 3 * 60_000));
const DISABLED = () => process.env.COMPLIANCE_REMINDERS_DISABLED === "1";

export function startComplianceReminders(log?: Log): NodeJS.Timeout | null {
  if (DISABLED()) return null;
  log?.info?.({ intervalMs: SWEEP_INTERVAL_MS, smsTo: reminderSmsTo(), emailTo: reminderEmailTo() }, "COMPLIANCE_REMINDERS_ARMED");

  const first = setTimeout(() => {
    void ensureComplianceSeed(db, log).then(() => runComplianceReminderSweep(db, log)).catch(() => {});
  }, BOOT_DELAY_MS) as unknown as NodeJS.Timeout;
  (first as any).unref?.();

  const timer = setInterval(() => {
    void runComplianceReminderSweep(db, log).catch(() => {});
  }, SWEEP_INTERVAL_MS) as unknown as NodeJS.Timeout;
  (timer as any).unref?.();
  return timer;
}

// ── Routes ───────────────────────────────────────────────────────────────────

const createSchema = z.object({
  title: z.string().trim().min(3).max(200),
  details: z.string().trim().max(2000).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  recurrence: z.enum(["yearly"]).nullable().optional(),
});

const patchSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  details: z.string().trim().max(2000).nullable().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  recurrence: z.enum(["yearly"]).nullable().optional(),
});

function itemView(row: any, now = new Date()) {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    details: row.details,
    dueDate: row.dueDate ? new Date(row.dueDate).toISOString().slice(0, 10) : null,
    recurrence: row.recurrence,
    completedAt: row.completedAt,
    lastCompletedAt: row.lastCompletedAt,
    lastReminderAt: row.lastReminderAt,
    reminderCount: row.reminderCount,
    daysLeft: row.dueDate && !row.completedAt ? daysUntil(new Date(row.dueDate), now) : null,
  };
}

export function registerComplianceRoutes(deps: {
  app: any;
  db: any;
  /** SUPER_ADMIN gate — resolves the admin or replies 403 itself and returns falsy. */
  requireSuper: (req: any, reply: any) => Promise<any | undefined | null>;
}): void {
  const { app, db: dbc, requireSuper } = deps;

  app.get("/admin/compliance/items", async (req: any, reply: any) => {
    const admin = await requireSuper(req, reply);
    if (!admin) return reply;
    const rows = await dbc.complianceItem.findMany({ orderBy: { dueDate: "asc" } });
    const now = new Date();
    return { items: rows.map((r: any) => itemView(r, now)) };
  });

  app.post("/admin/compliance/items", async (req: any, reply: any) => {
    const admin = await requireSuper(req, reply);
    if (!admin) return reply;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Give the item a title and a real due date (YYYY-MM-DD)." });
    const due = complianceDate(parsed.data.dueDate);
    if (!due) return reply.code(400).send({ error: "bad_due_date", message: "That due date is not a real calendar day." });
    const row = await dbc.complianceItem.create({
      data: {
        title: parsed.data.title,
        details: parsed.data.details || null,
        dueDate: due,
        recurrence: parsed.data.recurrence || null,
      },
    });
    return { item: itemView(row) };
  });

  app.patch("/admin/compliance/items/:id", async (req: any, reply: any) => {
    const admin = await requireSuper(req, reply);
    if (!admin) return reply;
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "validation_error", message: "Nothing usable to change." });
    const existing = await dbc.complianceItem.findUnique({ where: { id: String(req.params?.id || "") } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const data: any = {};
    if (parsed.data.title !== undefined) data.title = parsed.data.title;
    if (parsed.data.details !== undefined) data.details = parsed.data.details;
    if (parsed.data.recurrence !== undefined) data.recurrence = parsed.data.recurrence;
    if (parsed.data.dueDate !== undefined) {
      const due = complianceDate(parsed.data.dueDate);
      if (!due) return reply.code(400).send({ error: "bad_due_date", message: "That due date is not a real calendar day." });
      data.dueDate = due;
      // A moved deadline restarts its own reminder clock.
      data.lastReminderAt = null;
    }
    const row = await dbc.complianceItem.update({ where: { id: existing.id }, data });
    return { item: itemView(row) };
  });

  app.post("/admin/compliance/items/:id/complete", async (req: any, reply: any) => {
    const admin = await requireSuper(req, reply);
    if (!admin) return reply;
    const existing = await dbc.complianceItem.findUnique({ where: { id: String(req.params?.id || "") } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    if (existing.completedAt) return { item: itemView(existing), note: "already done" };
    const now = new Date();
    const by = String(admin.email || admin.sub || "super-admin");
    let row;
    if (existing.recurrence === "yearly") {
      // Roll forward: the row stays open for next year with a fresh reminder clock.
      row = await dbc.complianceItem.update({
        where: { id: existing.id },
        data: {
          dueDate: rollDueDateForwardOneYear(new Date(existing.dueDate)),
          lastCompletedAt: now,
          completedBy: by,
          lastReminderAt: null,
          reminderCount: 0,
        },
      });
    } else {
      row = await dbc.complianceItem.update({
        where: { id: existing.id },
        data: { completedAt: now, lastCompletedAt: now, completedBy: by },
      });
    }
    return { item: itemView(row), rolledForward: existing.recurrence === "yearly" };
  });

  app.delete("/admin/compliance/items/:id", async (req: any, reply: any) => {
    const admin = await requireSuper(req, reply);
    if (!admin) return reply;
    const existing = await dbc.complianceItem.findUnique({ where: { id: String(req.params?.id || "") } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    if (existing.key) {
      // Seeded items are the standing law of the calendar; deleting one would
      // just be re-created by the next boot's seed. Mark it done instead.
      return reply.code(409).send({ error: "seeded_item", message: "This is a standing federal deadline — mark it done instead of deleting it." });
    }
    await dbc.complianceItem.delete({ where: { id: existing.id } });
    return { ok: true };
  });
}
