import { emailShell } from "../billing/emailTemplates";
import { resolveInvoiceEmailBranding } from "../billing/invoiceBranding";
import type { E911Address } from "./e911Address";

/**
 * The email a customer gets once their 911 address is registered.
 *
 * Izzy, 2026-08-17: once onboarding is finished, tell the customer that E911
 * was activated and **state the address a dispatcher will be given** if anyone
 * on their phones dials 911. He picked the short wording (option A) from
 * <https://claude.ai/code/artifact/4ed02ad7-f4ec-4701-bfae-619b2fd1499a> and
 * asked that it say **E911** in so many words.
 *
 * ⛔ THE TYPE IS THE WHOLE POINT, exactly as with PORT_COMPLETE. An
 * `ADMIN_ALERT` is dropped at the send door with `lastErrorCode:
 * "ALERTS_MUTED"` under the 2026-08-12 owner directive — it would build clean,
 * log clean and reach nobody. This must stay anything other than ADMIN_ALERT,
 * and the test asserts it.
 */
export const E911_ACTIVATED_EMAIL_TYPE = "E911_ACTIVATED";

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The address on one line, as the emergency service holds it.
 *
 * ⛔ Built from the REGISTERED address, never from what the customer typed. The
 * entire point of the email is to show what a dispatcher actually receives, and
 * those differ often here — the emergency database uses the municipality, so a
 * customer who wrote Monsey is registered in Spring Valley and one who wrote
 * Monroe is registered in Kiryas Joel.
 */
export function formatRegisteredAddress(a: E911Address): string {
  const unit = a.addressType ? `${a.addressType} ${a.addressNumber}`.trim() : "";
  const street = [a.streetNumber, a.streetName, unit].filter(Boolean).join(" ");
  const cityLine = [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [street, cityLine].filter(Boolean).join(", ");
}

export type E911ActivatedEmailInput = {
  /** The address as REGISTERED — i.e. after any correction. */
  address: E911Address;
};

export function buildE911ActivatedEmail(input: E911ActivatedEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const where = formatRegisteredAddress(input.address);
  const subject = "E911 is set for your phones";

  const body = `
    <p style="margin:0 0 18px;font-size:17px;line-height:26px;color:#1e293b;">E911 is set on your phones. If anyone dials 911, this is the address the dispatcher gets:</p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;">
      <tr>
        <td style="padding:18px 20px;background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #dc2626;border-radius:8px;">
          <p style="margin:0 0 4px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#64748b;">Your E911 address</p>
          <p style="margin:0;font-size:17px;line-height:26px;font-weight:600;color:#0f172a;">${escapeHtml(where)}</p>
        </td>
      </tr>
    </table>

    <p style="margin:0;font-size:16px;line-height:25px;color:#475569;">If that is not where your phones are, reply to this email and we will fix it.</p>
  `;

  const html = emailShell(subject, body, resolveInvoiceEmailBranding({}, null), {
    eyebrow: null,
    footerNote: "Sent by Loopcom.",
    includeSupportBlock: false,
  });

  const text = [
    subject,
    "",
    "E911 is set on your phones. If anyone dials 911, this is the address the dispatcher gets:",
    "",
    `    ${where}`,
    "",
    "If that is not where your phones are, reply to this email and we will fix it.",
  ].join("\n");

  return { subject, html, text };
}

/**
 * Queue the customer's "E911 is set" email for a finished sign-up.
 *
 * ⛔⛔ IT ONLY SENDS WHEN 911 IS ACTUALLY REGISTERED. `answers.provisioning.e911`
 * records every outcome, including the ones that need a person — an address we
 * could not validate, a sign-up with no address, a provider outage. Emailing
 * "E911 is set" off the back of any of those tells a customer help will reach
 * them when it will not. Silence is bad; a false reassurance about 911 is worse.
 *
 * ⛔ It also needs the ADDRESS, not just a status. An `already_registered`
 * verdict on a re-run carries none of its own, which is why applyE911ForDid
 * keeps the earlier run's address on the record.
 *
 * Sends once (`emailedAt`), never throws, and records what it did either way.
 */
export async function queueE911ActivatedEmail(deps: {
  db: any;
  submissionId: string;
  log: (message: string) => Promise<void> | void;
}): Promise<{ sent: boolean; reason: string }> {
  const { db, submissionId, log } = deps;
  try {
    const row = await db.onboardingSubmission.findUnique({ where: { id: submissionId } });
    if (!row) return { sent: false, reason: "submission_not_found" };

    const answers: any = row.answers || {};
    const state: any = answers?.provisioning?.e911 || null;
    if (!state) return { sent: false, reason: "no_e911_attempt" };
    if (state.emailedAt) return { sent: false, reason: "already_emailed" };

    if (state.status !== "provisioned" && state.status !== "already_registered") {
      await log(`E911 email not sent — 911 is not registered (${state.status}). The customer must not be told it is set.`);
      return { sent: false, reason: `not_registered:${state.status}` };
    }
    if (!state.address) {
      // Registered but we cannot say where. An email that claims E911 is set
      // without the address is exactly the one thing this email exists to do.
      await log("E911 email not sent — 911 is registered but the address was not recorded, so the email could not state it.");
      return { sent: false, reason: "no_address_recorded" };
    }

    const tenantId = String(row.createdTenantId || "");
    const recipient = await resolveE911EmailRecipient(db, row, tenantId);
    if (!recipient) {
      await log("E911 email not sent — the sign-up has no reachable email address.");
      return { sent: false, reason: "no_recipient" };
    }

    const template = buildE911ActivatedEmail({ address: state.address as E911Address });
    await db.emailJob.create({
      data: {
        // Billed and scoped to the customer's own tenant, like every other
        // customer email — never the platform tenant.
        tenantId: tenantId || null,
        type: E911_ACTIVATED_EMAIL_TYPE,
        toEmail: recipient.email,
        subject: template.subject,
        htmlBody: template.html,
        textBody: template.text,
        status: "QUEUED",
        attempts: 0,
        nextRunAt: new Date(),
      },
    });

    const next = { ...(answers.provisioning || {}), e911: { ...state, emailedAt: new Date().toISOString() } };
    await db.onboardingSubmission.update({
      where: { id: submissionId },
      data: { answers: { ...answers, provisioning: next } },
    });

    await log(
      `Told ${recipient.email} their E911 address is set${recipient.source === "mainEmail" ? "" : ` (via ${recipient.source})`}.`,
    );
    return { sent: true, reason: "queued" };
  } catch (e: any) {
    // Never fatal — a finished sign-up must not fail because an email did not
    // queue. Recorded so the silence is visible.
    // `log` may be sync or async, so it cannot be `.catch()`ed — and a logger
    // that throws must not turn a lost email into a failed sign-up.
    try {
      await log(`E911 email could not be queued: ${String(e?.message || e).slice(0, 160)}`);
    } catch {
      /* the logger itself failed; nothing further to do */
    }
    return { sent: false, reason: "error" };
  }
}

/**
 * Who gets told. Same chain as the port-complete email, and deliberately the
 * same shape: the sign-up's own contacts first, then the tenant's oldest admin
 * — on a sign-up-built tenant that is the account owner, because onboarding
 * promotes the first extension's owner to TENANT_ADMIN.
 */
export async function resolveE911EmailRecipient(
  db: any,
  row: { mainEmail?: string | null; billingEmail?: string | null },
  connectTenantId: string,
): Promise<{ email: string; source: "mainEmail" | "billingEmail" | "tenantAdmin" } | null> {
  const main = String(row?.mainEmail || "").trim();
  if (main) return { email: main, source: "mainEmail" };
  const billing = String(row?.billingEmail || "").trim();
  if (billing) return { email: billing, source: "billingEmail" };
  if (!connectTenantId) return null;
  try {
    const admin = await db.user.findFirst({
      where: { tenantId: connectTenantId, role: "TENANT_ADMIN" },
      orderBy: { createdAt: "asc" },
      select: { email: true },
    });
    const email = String(admin?.email || "").trim();
    return email ? { email, source: "tenantAdmin" } : null;
  } catch {
    return null;
  }
}
