/**
 * The email that sends a brand-new customer their sign-up link.
 *
 * Izzy, 2026-08-24: "I should be able to just enter somebody's email and it
 * would send him the link."
 *
 * ⛔ THIS DID NOT EXIST BEFORE. The Onboarding screen has had a "Main Email"
 * box since it shipped, which reads exactly like it emails the customer — it
 * only wrote the address onto the record so you could tell whose link it was.
 * Across 23 sign-ups, ZERO invitation emails have ever been sent by the
 * platform; every link reached its customer because a person pasted it
 * somewhere by hand. The `USER_INVITE` email people know is a different thing
 * entirely and goes out much later, once the tenant already exists.
 *
 * ⛔ TYPE IS `ONBOARDING_INVITE`, NEVER `ADMIN_ALERT`. Every ADMIN_ALERT job is
 * marked SKIPPED at the send door by the platform-wide alert mute, so an
 * invitation sent on that type would build clean, log clean, and reach nobody.
 * A guard in inviteEmail.test.ts pins this.
 *
 * ⛔ THE SHELL IS THE BILLING ONE, ON PURPOSE. It carries the Outlook
 * hardening — the `[if mso]` fixed-600px wrapper and the VML roundrect that is
 * the only thing that paints a button in Word's renderer. A hand-rolled
 * invitation looks perfect in Gmail and arrives in Outlook as bare blue text,
 * and nobody finds out for weeks. This is a customer's FIRST sight of Loopcom.
 */

import { emailShell } from "../billing/emailTemplates";
import { escapeHtml, resolveInvoiceEmailBranding } from "../billing/invoiceBranding";
import { onboardingLinkForToken, platformWebsite } from "../publicOrigins";

/** The admin tenant every platform-owned email is billed to. */
export const ONBOARDING_INVITE_TENANT_ID = "connect-admin-tenant-v1";

/** ⛔ Never "ADMIN_ALERT" — see the header. */
export const ONBOARDING_INVITE_EMAIL_TYPE = "ONBOARDING_INVITE";

export type InviteEmailInput = {
  publicToken: string;
  companyName?: string | null;
  /** Optional first name / contact name, when we have one worth greeting. */
  contactName?: string | null;
};

export type BuiltInviteEmail = { subject: string; html: string; text: string; link: string };

function greetingName(input: InviteEmailInput): string | null {
  const contact = String(input.contactName ?? "").trim();
  if (contact) return contact;
  const company = String(input.companyName ?? "").trim();
  return company || null;
}

export function buildOnboardingInviteEmail(input: InviteEmailInput): BuiltInviteEmail {
  const link = onboardingLinkForToken(input.publicToken);
  const who = greetingName(input);
  const subject = "Set up your Loopcom phone system";

  // The button is built by hand here rather than through ctaButton() so the
  // wording and radius match the approved mock-up exactly; the VML half is the
  // same shape the billing button uses, which is what Outlook needs.
  const safeLink = escapeHtml(link);
  const button = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;margin:22px 0 6px;">
      <tr>
        <td align="center" bgcolor="#22a8ff" style="border-radius:10px;background:#22a8ff;mso-padding-alt:14px 30px;">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeLink}" style="height:48px;v-text-anchor:middle;width:220px;" arcsize="21%" stroke="f" fillcolor="#22a8ff">
            <w:anchorlock/>
            <center style="color:#04121d;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">Start setting up</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-- -->
          <a href="${safeLink}" style="display:inline-block;padding:14px 30px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#04121d;text-decoration:none;border-radius:10px;">Start setting up</a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>`;

  const body = `
    <p style="margin:0 0 16px;font-size:17px;line-height:26px;color:#1e293b;">Hi${who ? ` ${escapeHtml(who)}` : " there"},</p>
    <p style="margin:0 0 16px;font-size:16px;line-height:25px;color:#475569;">Here's your link to set up your new phone system. You'll choose your phone number and add the people on your team — it takes about five minutes, and we handle the rest.</p>
    ${button}
    <p style="margin:14px 0 20px;font-size:13px;line-height:20px;color:#64748b;">Or paste this into your browser:<br><span style="font-family:Consolas,'Courier New',monospace;color:#0b62b0;word-break:break-all;">${safeLink}</span></p>
    <p style="margin:0 0 6px;font-size:14px;line-height:22px;color:#64748b;">This link is just for you — please don't forward it.</p>
    <p style="margin:0;font-size:14px;line-height:22px;color:#64748b;">Questions? Reply to this email and a person will get back to you.</p>
  `;

  const html = emailShell("Your phone system is ready to set up", body, resolveInvoiceEmailBranding({}, null), {
    eyebrow: "Getting started",
    footerNote: `Loopcom LLC · ${platformWebsite()}`,
    includeSupportBlock: false,
  });

  const text = [
    "Your phone system is ready to set up",
    "",
    `Hi${who ? ` ${who}` : " there"},`,
    "",
    "Here's your link to set up your new phone system. You'll choose your phone number and add the people on your team — it takes about five minutes, and we handle the rest.",
    "",
    link,
    "",
    "This link is just for you — please don't forward it.",
    "Questions? Reply to this email and a person will get back to you.",
    "",
    `Loopcom LLC · ${platformWebsite()}`,
  ].join("\n");

  return { subject, html, text, link };
}

/**
 * Queue the invitation. Returns the link either way, because the screen shows
 * it next to the confirmation so it can also be texted by hand.
 *
 * ⛔ Never throws: an invitation that fails to queue must surface as "we could
 * not send it, here is the link" rather than losing the link the admin just
 * created.
 */
export async function queueOnboardingInviteEmail(
  db: any,
  input: InviteEmailInput & { toEmail: string },
): Promise<{ sent: boolean; link: string; error?: string }> {
  const built = buildOnboardingInviteEmail(input);
  const toEmail = String(input.toEmail ?? "").trim();
  if (!toEmail) return { sent: false, link: built.link, error: "no_email" };
  try {
    await db.emailJob.create({
      data: {
        tenantId: ONBOARDING_INVITE_TENANT_ID,
        invoiceId: null,
        type: ONBOARDING_INVITE_EMAIL_TYPE,
        toEmail,
        subject: built.subject,
        htmlBody: built.html,
        textBody: built.text,
      },
    });
    return { sent: true, link: built.link };
  } catch (e: any) {
    return { sent: false, link: built.link, error: String(e?.message || e) };
  }
}
