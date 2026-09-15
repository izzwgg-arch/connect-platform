/**
 * LoopCom Mobile — customer emails.
 *
 * Every template renders through the HARDENED billing shell
 * (`emailShell` in ../billing/emailTemplates — the Outlook-safe one with the
 * real Loopcom wordmark) with the eyebrow "LoopCom Mobile", so a mobile email
 * is visually the same document family as an invoice email while being
 * unmistakably the mobile product's.
 *
 * Delivery rides the platform's ONE outbound lane: rows in EmailJob, sent by
 * the existing worker under the 500/day cap. Nothing here opens a second SMTP
 * path, and nothing here is an ADMIN_ALERT (those are muted at the send door;
 * these are customer transactional emails, which flow).
 *
 * Recipient resolution (resolveMobileRecipients): the line's subscriber email
 * first, then the tenant's mobile billing contacts, deduped. An email with no
 * resolvable recipient is SKIPPED and audited — never mis-sent.
 */

import { ctaButton, emailShell, money } from "../billing/emailTemplates";
import { resolveInvoiceEmailBranding } from "../billing/invoiceBranding";
import { canonicalPortalOrigin } from "../publicOrigins";
import { writeMobileAuditSync } from "./mobileAudit";

const BRAND = resolveInvoiceEmailBranding({}, null);
const SHELL_OPTS = { eyebrow: "LoopCom Mobile", footerNote: "Sent by LoopCom Mobile.", includeSupportBlock: true } as const;

export type MobileEmail = { subject: string; html: string; text: string };

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function p(text: string): string {
  return `<p style="margin:0 0 14px;font-size:16px;line-height:25px;color:#1e293b;">${text}</p>`;
}

function factBox(rows: Array<[string, string]>): string {
  const body = rows
    .map(([label, value], i) => `<tr>
      <td class="summary-label" style="padding:10px 0;font-size:14px;line-height:21px;color:#64748b;${i ? "border-top:1px solid #e2e8f0;" : ""}">${esc(label)}</td>
      <td class="summary-value" style="padding:10px 0 10px 16px;font-size:15px;line-height:22px;color:#0f172a;font-weight:700;text-align:right;${i ? "border-top:1px solid #e2e8f0;" : ""}">${value}</td>
    </tr>`)
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;background:#f8fafc;border:1px solid #dbe4ee;border-radius:14px;margin:18px 0;">
  <tr><td bgcolor="#f8fafc" style="padding:16px 20px;background:#f8fafc;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table></td></tr>
</table>`;
}

function mobilePortalUrl(path = "/mobile"): string {
  return `${canonicalPortalOrigin()}${path}`;
}

function maskedNumber(phoneNumber: string | null, label: string): string {
  return phoneNumber ? esc(phoneNumber) : esc(label);
}

// ── Templates ────────────────────────────────────────────────────────────────

export function esimReadyEmail(input: { subscriberName: string | null; lineLabel: string; phoneNumber: string | null; planName: string | null }): MobileEmail {
  const who = input.subscriberName ? `${esc(input.subscriberName)}'s` : "Your";
  const subject = "Your LoopCom Mobile eSIM is ready to install";
  const url = mobilePortalUrl("/mobile/devices");
  const html = emailShell(
    "Your eSIM is ready",
    [
      p(`${who} new LoopCom Mobile line is set up and waiting — installing the eSIM takes about two minutes and needs only the phone it's going into.`),
      factBox([
        ["Line", maskedNumber(input.phoneNumber, input.lineLabel)],
        ...(input.planName ? ([["Plan", esc(input.planName)]] as Array<[string, string]>) : []),
        ["What you need", "The new phone, on Wi-Fi"],
      ]),
      p(`Open the install screen below on any computer or another phone, then scan the QR code with the new phone's camera from <b>Settings &rarr; Cellular &rarr; Add eSIM</b>.`),
      ctaButton(url, "Open the install screen"),
      p(`<span style="color:#64748b;font-size:14px;">The install code is shown only on that screen — we never send it by email.</span>`),
    ].join("\n"),
    BRAND,
    SHELL_OPTS,
  );
  const text = `${subject}\n\nInstalling takes about two minutes. Open ${url} and scan the QR code from the new phone's Settings > Cellular > Add eSIM. The install code is shown only on that screen.`;
  return { subject, html, text };
}

export function usageWarningEmail(input: { lineLabel: string; phoneNumber: string | null; usedMb: number; includedMb: number; pct: number; overagePerGbCents: number | null; planName: string | null }): MobileEmail {
  const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
  const subject = `Heads up: ${input.phoneNumber ?? input.lineLabel} has used ${input.pct}% of its data`;
  const url = mobilePortalUrl("/mobile/usage");
  const overageLine = input.overagePerGbCents
    ? `After the allowance, data bills at ${money(input.overagePerGbCents)}/GB, rounded up to the cent at cycle close.`
    : `After the allowance, data slows for the rest of the cycle — nothing extra is billed.`;
  const html = emailShell(
    "Data allowance warning",
    [
      p(`This line has crossed <b>${input.pct}%</b> of its monthly data. No action is needed — this is the early warning you asked us to send.`),
      factBox([
        ["Line", maskedNumber(input.phoneNumber, input.lineLabel)],
        ...(input.planName ? ([["Plan", esc(input.planName)]] as Array<[string, string]>) : []),
        ["Used so far", `${gb(input.usedMb)} of ${gb(input.includedMb)}`],
      ]),
      p(overageLine),
      ctaButton(url, "See usage & options"),
      p(`<span style="color:#64748b;font-size:14px;">Moving to a bigger plan takes effect immediately with fair proration — the exact price is shown before you confirm.</span>`),
    ].join("\n"),
    BRAND,
    SHELL_OPTS,
  );
  const text = `${subject}\n\nUsed ${gb(input.usedMb)} of ${gb(input.includedMb)}. ${overageLine}\nSee usage: ${url}`;
  return { subject, html, text };
}

export function lineSuspendedEmail(input: { lineLabel: string; phoneNumber: string | null; lost: boolean; reason: string | null }): MobileEmail {
  const subject = input.lost
    ? `Service stopped on ${input.phoneNumber ?? input.lineLabel} — device reported lost`
    : `Service paused on ${input.phoneNumber ?? input.lineLabel}`;
  const url = mobilePortalUrl("/mobile/lines");
  const html = emailShell(
    input.lost ? "Device reported lost" : "Line paused",
    [
      p(
        input.lost
          ? `Service on this line stopped the moment it was reported lost or stolen. <b>The number is safe</b> — it stays reserved for you, and nothing can use the old eSIM.`
          : `This line was paused. Calls, texts and data are stopped; <b>the number is kept safe</b> and the line can be resumed any time.`,
      ),
      factBox([
        ["Line", maskedNumber(input.phoneNumber, input.lineLabel)],
        ["Status", input.lost ? "Suspended — lost device" : "Paused"],
        ...(input.reason ? ([["Reason", esc(input.reason)]] as Array<[string, string]>) : []),
      ]),
      p(input.lost ? `When you have a replacement phone, support can issue a new eSIM for the same number in minutes.` : `Resume it from the Lines page whenever you're ready.`),
      ctaButton(url, "Open Lines"),
    ].join("\n"),
    BRAND,
    SHELL_OPTS,
  );
  const text = `${subject}\n\nThe number is kept safe. Manage the line: ${url}`;
  return { subject, html, text };
}

export function lineResumedEmail(input: { lineLabel: string; phoneNumber: string | null }): MobileEmail {
  const subject = `Service is back on ${input.phoneNumber ?? input.lineLabel}`;
  const html = emailShell(
    "Line resumed",
    [
      p(`This line is being turned back on — service usually returns within a couple of minutes.`),
      factBox([["Line", maskedNumber(input.phoneNumber, input.lineLabel)], ["Status", "Active"]]),
    ].join("\n"),
    BRAND,
    SHELL_OPTS,
  );
  return { subject, html, text: `${subject}\n\nService usually returns within a couple of minutes.` };
}

export function planChangedEmail(input: { lineLabel: string; phoneNumber: string | null; planName: string; monthlyPriceCents: number }): MobileEmail {
  const subject = `Plan updated on ${input.phoneNumber ?? input.lineLabel}`;
  const html = emailShell(
    "Plan updated",
    [
      p(`The plan on this line was changed. The new allowance applies from now; the invoice prorates by day, so you only ever pay for the days on each plan.`),
      factBox([
        ["Line", maskedNumber(input.phoneNumber, input.lineLabel)],
        ["New plan", esc(input.planName)],
        ["Monthly price", `${money(input.monthlyPriceCents)}/mo`],
      ]),
      ctaButton(mobilePortalUrl("/mobile/plans"), "View plans"),
    ].join("\n"),
    BRAND,
    SHELL_OPTS,
  );
  return { subject, html, text: `${subject}\n\nNew plan: ${input.planName} at ${money(input.monthlyPriceCents)}/mo, prorated by day.` };
}

const PORT_STATUS_COPY: Record<string, { title: string; body: string }> = {
  submitted: { title: "Your number transfer is filed", body: "We filed the transfer with the carrier. The usual check takes 1–2 business days; your old service keeps working the whole time." },
  pending: { title: "Your number transfer is in review", body: "The carriers are checking the details. Your old service keeps working until the moment the number moves." },
  foc: { title: "Your transfer date is set", body: "The carriers agreed on a transfer date. On that day the old SIM goes dark and your LoopCom line takes over — usually within minutes." },
  action_required: { title: "Your number transfer needs something from you", body: "The carrier needs more information before the transfer can move (most often the account number or transfer PIN from your old carrier)." },
  completed: { title: "Your number has moved to LoopCom Mobile", body: "The transfer is complete. The number now lives on your LoopCom Mobile line — your old SIM is dark and can be discarded." },
  rejected: { title: "Your number transfer was rejected", body: "The old carrier rejected the request — usually a name, account-number or PIN mismatch. Nothing is lost: fix the detail and we refile it." },
  cancelled: { title: "Your number transfer was cancelled", body: "This transfer was cancelled. Your number stays exactly where it is; start a new transfer any time." },
};

export function portStatusEmail(input: { phoneNumber: string; status: string; focDate: Date | null; carrier: string | null }): MobileEmail {
  const copy = PORT_STATUS_COPY[input.status] ?? { title: `Transfer update: ${input.status.replace(/_/g, " ")}`, body: "The status of your number transfer changed." };
  const subject = `${copy.title} — ${input.phoneNumber}`;
  const rows: Array<[string, string]> = [["Number", esc(input.phoneNumber)], ["Status", esc(copy.title)]];
  if (input.carrier) rows.push(["From carrier", esc(input.carrier)]);
  if (input.focDate) rows.push(["Transfer date", esc(input.focDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }))]);
  const html = emailShell(
    copy.title,
    [p(copy.body), factBox(rows), ctaButton(mobilePortalUrl("/mobile/porting"), "Track the transfer")].join("\n"),
    BRAND,
    SHELL_OPTS,
  );
  return { subject, html, text: `${subject}\n\n${copy.body}\nTrack it: ${mobilePortalUrl("/mobile/porting")}` };
}

export function mobileInvoiceEmail(input: { number: string; totalCents: number; periodStart: Date; periodEnd: Date; lineCount: number }): MobileEmail {
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const subject = `LoopCom Mobile invoice ${input.number} — ${money(input.totalCents)}`;
  const url = mobilePortalUrl("/mobile/billing");
  const html = emailShell(
    "Your LoopCom Mobile invoice",
    [
      p(`Your mobile-service invoice is ready. It's separate from any phone-system invoice — same account, its own ledger.`),
      factBox([
        ["Invoice", esc(input.number)],
        ["Service period", `${fmt(input.periodStart)} – ${fmt(input.periodEnd)}`],
        ["Lines billed", String(input.lineCount)],
        ["Total", `<span style="font-size:19px;font-weight:800;">${money(input.totalCents)}</span>`],
      ]),
      ctaButton(url, "View the invoice"),
      p(`<span style="color:#64748b;font-size:14px;">Every line item names the line it came from, so any charge can be traced in one click.</span>`),
    ].join("\n"),
    BRAND,
    SHELL_OPTS,
  );
  return { subject, html, text: `${subject}\n\nPeriod ${fmt(input.periodStart)} - ${fmt(input.periodEnd)}, ${input.lineCount} lines. View: ${url}` };
}

// ── Delivery ────────────────────────────────────────────────────────────────

export type MobileEmailKind = "esim_ready" | "usage_warning" | "line_suspended" | "line_resumed" | "plan_changed" | "port_status" | "invoice";

/** Subscriber email first, then the tenant's mobile billing contacts, deduped. */
export async function resolveMobileRecipients(db: any, tenantId: string, subscriberEmail?: string | null): Promise<string[]> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    const s = String(v ?? "").trim().toLowerCase();
    if (s && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) out.add(s);
  };
  add(subscriberEmail);
  try {
    const settings = await db.mobileTenantSettings.findUnique({ where: { tenantId } });
    for (const e of Array.isArray(settings?.billingEmails) ? settings.billingEmails : []) add(e);
    if (out.size === 0) {
      // Same fallback ladder the billing engine uses: the tenant's configured
      // billing email (comma-separated allowed), then billing-capable users —
      // so day-one tenants with no mobile settings row still hear about their
      // own service.
      const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { billingSettings: { select: { billingEmail: true } } } }).catch(() => null);
      for (const part of String((tenant as any)?.billingSettings?.billingEmail ?? "").split(",")) add(part);
      if (out.size === 0) {
        const users = await db.user.findMany({
          where: { tenantId, status: "ACTIVE", role: { in: ["BILLING_ADMIN", "BILLING", "TENANT_ADMIN", "ADMIN"] } },
          select: { email: true },
          take: 3,
        }).catch(() => []);
        for (const u of users) add(u?.email);
      }
    }
  } catch {
    /* recipient resolution must never throw into the action path */
  }
  return [...out];
}

/**
 * Queue one mobile email into the platform's outbound lane (EmailJob). Never
 * throws — a failed queue is audited and the triggering action still succeeds.
 */
export async function queueMobileEmail(db: any, input: {
  tenantId: string;
  kind: MobileEmailKind;
  email: MobileEmail;
  to: string[];
  entityType?: string;
  entityId?: string;
}): Promise<number> {
  let queued = 0;
  for (const to of input.to) {
    try {
      await db.emailJob.create({
        data: {
          tenantId: input.tenantId,
          invoiceId: null,
          type: `MOBILE_${input.kind.toUpperCase()}`,
          toEmail: to,
          subject: input.email.subject,
          htmlBody: input.email.html,
          textBody: input.email.text,
        },
      });
      queued += 1;
    } catch {
      /* fall through to the audit below */
    }
  }
  await writeMobileAuditSync({
    tenantId: input.tenantId,
    action: queued > 0 ? `mobile.email.${input.kind}` : `mobile.email.${input.kind}_skipped`,
    entityType: input.entityType ?? "MobileEmail",
    entityId: input.entityId ?? input.kind,
    metadata: { recipients: queued, requested: input.to.length },
  }).catch(() => undefined);
  return queued;
}
