/**
 * The meeting invite email.
 *
 * ⛔ It is built from `emailShell` + `ctaButton` in billing/emailTemplates —
 * NOT from new email HTML. Those carry the Outlook hardening (the fixed 600px
 * `[if mso]` wrapper, the VML `roundrect` that is the only thing that paints a
 * button in Word's renderer) that this repo has already paid for twice. A
 * hand-rolled invite would look right in Gmail and arrive in Outlook as bare
 * blue text, and nobody would find out for weeks.
 *
 * ⛔ Its type is MEETING_INVITE and must NEVER be ADMIN_ALERT — that category
 * is muted at the send door platform-wide, so the email would build clean, log
 * clean and reach nobody. Guarded by a test.
 *
 * Design is the mockup Izzy approved 2026-08-21 ("that is perfect! Build it!"):
 * eyebrow, meeting name as the heading, one line naming the host, a When panel,
 * the optional note, the button, the plain link, and the reassurance that no
 * account or download is needed.
 */
import { emailShell, ctaButton } from "../billing/emailTemplates";
import { resolveInvoiceEmailBranding } from "../billing/invoiceBranding";
import type { MeetingWhen } from "./meetingSchedule";

/** ⛔ Never "ADMIN_ALERT" — see the header. */
export const MEETING_INVITE_EMAIL_TYPE = "MEETING_INVITE";

function esc(v: string): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The link as a person reads it: no scheme, no trailing slash. */
export function displayJoinLink(url: string): string {
  return String(url || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

export type MeetingInviteEmailInput = {
  meetingTitle: string;
  /** Who is inviting, in words. Falls back to "Loopcom" upstream, never blank. */
  hostName: string;
  joinUrl: string;
  /** null for an instant meeting — the email then simply has no When panel. */
  when: MeetingWhen | null;
  message?: string | null;
};

export function buildMeetingInviteEmail(input: MeetingInviteEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const title = String(input.meetingTitle || "Video meeting").trim() || "Video meeting";
  const host = String(input.hostName || "Loopcom").trim() || "Loopcom";
  const url = String(input.joinUrl || "");
  const when = input.when;
  const message = String(input.message ?? "").trim();

  const subject = when ? `${title} — ${when.subjectWhen}` : `${host} invited you to a video meeting`;

  // ── When panel ──────────────────────────────────────────────────────────
  // Follows the E911 email's panel convention exactly (that is the most recent
  // customer email built on this shell). `bgcolor` is mandatory beside the CSS
  // background: Word drops the shorthand and paints nothing without it.
  const whenPanel = when
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;margin:22px 0;">
  <tr>
    <td bgcolor="#f8fafc" style="padding:18px 20px;background:#f8fafc;border:1px solid #e2e8f0;border-left:4px solid #22a8ff;border-radius:8px;">
      <p style="margin:0 0 6px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#64748b;">When</p>
      <p style="margin:0;font-size:17px;line-height:26px;font-weight:600;color:#0f172a;">${esc(when.dateLine)} &middot; ${esc(when.timeLine)}</p>
      <p style="margin:4px 0 0;font-size:14px;line-height:21px;color:#64748b;">${esc(when.zoneLine)}</p>
    </td>
  </tr>
</table>`
    : "";

  const messageBlock = message
    ? `<p style="margin:0 0 4px;font-size:16px;line-height:25px;color:#475569;">${esc(message).replace(/\r?\n/g, "<br>")}</p>`
    : "";

  const body = `
    <p style="margin:0 0 4px;font-size:16px;line-height:25px;color:#1e293b;">${esc(host)} has invited you to a video meeting.</p>
    ${whenPanel}
    ${messageBlock}
    ${ctaButton(url, "Join the meeting")}
    <p style="margin:0 0 18px;font-size:14px;line-height:21px;color:#64748b;">Or open this link: <a href="${esc(url)}" style="color:#22a8ff;text-decoration:none;">${esc(displayJoinLink(url))}</a></p>
    <p style="margin:0;font-size:14px;line-height:22px;color:#64748b;">No account or download needed — it opens right in your browser.${when ? " If the time doesn’t work, reply to this email." : ""}</p>
  `.trim();

  const html = emailShell(title, body, resolveInvoiceEmailBranding({} as any, null), {
    eyebrow: "Meeting invitation",
    footerNote: "Sent by Loopcom.",
    includeSupportBlock: false,
  });

  const text = [
    `${host} has invited you to a video meeting.`,
    "",
    title,
    ...(when ? [`${when.dateLine} · ${when.timeLine}`, when.zoneLine] : []),
    ...(message ? ["", message] : []),
    "",
    "Join the meeting:",
    url,
    "",
    "No account or download needed — it opens right in your browser.",
  ].join("\n");

  return { subject, html, text };
}
