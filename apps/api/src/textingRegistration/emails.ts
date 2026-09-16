/**
 * Customer emails for 10DLC texting registration (2026-09-16).
 *
 * Izzy, 2026-09-16: "The email should not say anything about Telnyx or
 * anything like that. It should just explain that these are the regulations,
 * and to continue using SMS, you need to fill out the 10DLC form. That's it."
 * … "Then a link to the form."
 *
 * ⛔ Built on the ONE Loopcom email shell (`loopComShell`) and its CTA button —
 * never hand-written email HTML (Outlook hardening lives there).
 * ⛔ No carrier name, no price, no marketing wording. A source guard pins this.
 * ⛔ The EmailJob type is its own string, never ADMIN_ALERT (muted at the send door).
 */
import { lcCtaButton, loopComShell } from "../userEmailTemplates";

export const INVITE_EMAIL_TYPE = "TEXTING_REGISTRATION_INVITE";
export const READY_EMAIL_TYPE = "TEXTING_REGISTRATION_READY";

function esc(v: string | null | undefined): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const P = (html: string) => `<p style="margin:0 0 16px;">${html}</p>`;

export function buildInviteEmail(input: { displayName: string; firstName?: string | null; formUrl: string }): { subject: string; html: string; text: string } {
  const hi = input.firstName ? `Hi ${input.firstName},` : "Hello,";
  const subject = `Action needed: complete the 10DLC form for ${input.displayName}`;
  const reg =
    "US mobile carriers now require every business that sends text messages to register its business and how it uses texting. This registration is called 10DLC.";
  const act = `To continue using SMS for ${input.displayName}, please fill out the 10DLC form:`;
  const body = [
    P(esc(hi)),
    P(esc(reg)),
    P(esc(act)),
    lcCtaButton("Fill out the 10DLC form", input.formUrl),
    `<p style="margin:18px 0 0;font-size:13px;color:#64748b;word-break:break-all;">${esc(input.formUrl)}</p>`,
  ].join("\n");
  const html = loopComShell({
    preheaderText: "To continue using SMS, please fill out the 10DLC form.",
    headerTitle: "Complete your 10DLC form",
    body,
    organizationName: input.displayName,
  });
  const text = [hi, "", reg, "", act, input.formUrl].join("\n");
  return { subject, html, text };
}

export function buildReadyEmail(input: { displayName: string; firstName?: string | null }): { subject: string; html: string; text: string } {
  const hi = input.firstName ? `Hi ${input.firstName},` : "Hello,";
  const subject = `Texting is ready for ${input.displayName}`;
  const line = `Your 10DLC registration for ${input.displayName} is approved, and your business can text customers from your Loopcom numbers.`;
  const html = loopComShell({
    preheaderText: "Your 10DLC registration is approved.",
    headerTitle: "Texting is ready",
    body: [P(esc(hi)), P(esc(line))].join("\n"),
    organizationName: input.displayName,
  });
  return { subject, html, text: [hi, "", line].join("\n") };
}
