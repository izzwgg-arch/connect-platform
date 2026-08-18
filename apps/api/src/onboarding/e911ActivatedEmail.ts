import { emailShell } from "../billing/emailTemplates";
import { resolveInvoiceEmailBranding } from "../billing/invoiceBranding";
import type { E911Address } from "./e911Address";

/**
 * The email a customer gets once their 911 address is registered.
 *
 * Izzy, 2026-08-17: once onboarding is finished, tell the customer that 911 was
 * activated and **state the address a dispatcher will be given** if anyone on
 * their phones dials 911.
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
 * Built from the REGISTERED address, never from what the customer typed — the
 * point of the email is to show what a dispatcher actually receives.
 */
export function formatRegisteredAddress(a: E911Address): string {
  const unit = a.addressType ? `${a.addressType} ${a.addressNumber}`.trim() : "";
  const street = [a.streetNumber, a.streetName, unit].filter(Boolean).join(" ");
  const cityLine = [a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [street, cityLine].filter(Boolean).join(", ");
}

export type E911ActivatedEmailInput = {
  /** The number the address is registered against. Ten digits. */
  did: string;
  /** The address as REGISTERED — i.e. after any correction. */
  address: E911Address;
  /**
   * Fields the emergency database corrected, e.g. ["city → SPRING VALLEY"].
   *
   * ⛔ When this is non-empty the customer is about to read a town they did not
   * type, and without a word of explanation that reads as us getting their
   * address wrong. It is extremely common here — the 911 database uses the
   * municipality, not the postal town, so Monsey becomes Spring Valley and
   * Monroe becomes Kiryas Joel.
   */
  corrected?: string[] | null;
};

export function buildE911ActivatedEmail(input: E911ActivatedEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const where = formatRegisteredAddress(input.address);
  const wasCorrected = !!(input.corrected && input.corrected.length);

  const subject = "911 is set up for your phones";

  const correctionHtml = wasCorrected
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#475569;">If the town looks different from what you wrote, that is normal — the emergency system uses the official town name for your street, which is not always the one the post office uses.</p>`
    : "";

  const body = `
    <p style="margin:0 0 18px;font-size:17px;line-height:26px;color:#1e293b;">Emergency calling is now active on your phones. If anyone dials 911, this is the address the dispatcher will be given:</p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;">
      <tr>
        <td style="padding:18px 20px;background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #dc2626;border-radius:8px;">
          <p style="margin:0 0 4px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#64748b;">Your 911 address</p>
          <p style="margin:0;font-size:17px;line-height:26px;font-weight:600;color:#0f172a;">${escapeHtml(where)}</p>
        </td>
      </tr>
    </table>

    ${correctionHtml}

    <p style="margin:0 0 16px;font-size:16px;line-height:25px;color:#475569;"><strong style="color:#0f172a;">Please check it is right.</strong> Help is sent to this address no matter which phone dials 911 or where that phone happens to be, so it needs to be the place your phones actually are.</p>

    <p style="margin:0;font-size:16px;line-height:25px;color:#475569;">If anything is wrong, or you move, reply to this email and we will change it straight away.</p>
  `;

  const html = emailShell("911 is set up for your phones", body, resolveInvoiceEmailBranding({}, null), {
    eyebrow: null,
    footerNote: "Sent by Loopcom.",
    includeSupportBlock: false,
  });

  const text = [
    subject,
    "",
    "Emergency calling is now active on your phones. If anyone dials 911, this is the address the dispatcher will be given:",
    "",
    `    ${where}`,
    "",
    ...(wasCorrected
      ? [
          "If the town looks different from what you wrote, that is normal — the emergency system uses the official town name for your street, which is not always the one the post office uses.",
          "",
        ]
      : []),
    "Please check it is right. Help is sent to this address no matter which phone dials 911 or where that phone happens to be, so it needs to be the place your phones actually are.",
    "",
    "If anything is wrong, or you move, reply to this email and we will change it straight away.",
  ].join("\n");

  return { subject, html, text };
}
