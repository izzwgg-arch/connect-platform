import { emailShell } from "../billing/emailTemplates";
import { resolveInvoiceEmailBranding } from "../billing/invoiceBranding";

/**
 * The email a customer gets the moment their ported number goes live.
 *
 * ⛔ THE TYPE IS THE WHOLE POINT. Port completion already queues an email —
 * `[Connect] Port complete: …`, the internal one to the owner — and that is an
 * `ADMIN_ALERT`, which the send door in `server.ts` drops with
 * `lastErrorCode: "ALERTS_MUTED"` under the 2026-08-12 owner directive.
 * Building the customer email on that type would produce something that looks
 * finished, logs no error, and never reaches anybody. This type must stay
 * anything other than ADMIN_ALERT, and `portCompleteEmail.test.ts` asserts it.
 */
export const PORT_COMPLETE_EMAIL_TYPE = "PORT_COMPLETE";

/** "9293598299" → "(929) 359-8299". Anything else is returned untouched. */
export function formatTenDigitsForHumans(did: string | null | undefined): string {
  const v = String(did ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const m = /^(\d{3})(\d{3})(\d{4})$/.exec(v);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(did ?? "").trim();
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type PortCompleteEmailInput = {
  /** The customer's real number, now live. Ten digits. */
  portedDid: string;
  /**
   * The temporary number we lent them, now switched off. Omit when there never
   * was one — a hand-filed port may have gone straight to the real number, and
   * telling that customer to stop using a number they never had is nonsense.
   */
  tempDid?: string | null;
};

/**
 * Option C, the short note — the wording Izzy picked on 2026-08-17 from
 * <https://claude.ai/code/artifact/6cc32750-47dc-401c-a466-b3bb1f15f6b5>.
 *
 * ⛔ No CTA button and no support card, deliberately. "Reply to this email" is
 * the whole support path, which is what keeps this working without depending on
 * a new mailbox: replies go to the platform sender's address.
 */
export function buildPortCompleteEmail(input: PortCompleteEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const ported = formatTenDigitsForHumans(input.portedDid);
  const temp = input.tempDid ? formatTenDigitsForHumans(input.tempDid) : "";

  const subject = `Your number is live — ${ported}`;

  const tempParaHtml = temp
    ? `<p style="margin:0 0 16px;font-size:16px;line-height:25px;color:#475569;"><strong style="color:#0f172a;">One thing:</strong> the temporary number we lent you during the move, ${escapeHtml(temp)}, is switched off. If you gave it out anywhere, put your real number back.</p>`
    : "";

  const body = `
    <p style="margin:0 0 16px;font-size:17px;line-height:26px;color:#1e293b;">${escapeHtml(ported)} finished moving to Loopcom today. Calls and texts to it reach your team now, and there is nothing for you to set up.</p>
    ${tempParaHtml}
    <p style="margin:0;font-size:16px;line-height:25px;color:#475569;">Anything not working the way you expect? Just reply to this email.</p>
  `;

  const html = emailShell("Your number is live", body, resolveInvoiceEmailBranding({}, null), {
    eyebrow: null,
    footerNote: "Sent by Loopcom.",
    includeSupportBlock: false,
  });

  const text = [
    subject,
    "",
    `${ported} finished moving to Loopcom today. Calls and texts to it reach your team now, and there is nothing for you to set up.`,
    ...(temp
      ? [
          "",
          `One thing: the temporary number we lent you during the move, ${temp}, is switched off. If you gave it out anywhere, put your real number back.`,
        ]
      : []),
    "",
    "Anything not working the way you expect? Just reply to this email.",
  ].join("\n");

  return { subject, html, text };
}
