/**
 * The voicemail email itself.
 *
 * Design settled with Izzy 2026-08-16:
 *  - ⛔ NO "listen in Loopcom" button. The recording is ATTACHED, always.
 *  - The transcript rides along whenever there is one, in whichever language it
 *    came out. ⛔ 72% of ours are Yiddish, which is right-to-left — get that
 *    wrong and most of these emails read with the punctuation on the wrong end.
 *  - ⛔ No recording means no email at all, so this template never has to
 *    apologise for a missing attachment. That decision is made upstream in
 *    `decideVoicemailEmail`; this file assumes audio exists.
 *
 * Reuses `loopComShell` from userEmailTemplates rather than defining a second
 * shell — one place decides what a Loopcom email looks like.
 */
import { loopComShell } from "../userEmailTemplates";
import { transcriptIsRtl, voicemailEmailMarker } from "./voicemailEmail";

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

function esc(value: string | null | undefined): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "39 seconds", "1 min 12 sec" — spoken-language, not "00:01:12". */
export function formatVoicemailDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(seconds || 0)));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m} min` : `${m} min ${rem} sec`;
}

/**
 * A caller we can name reads better than a number, but the number is what they
 * call back on — so both, never one. "WIRELESS CALLER" is carrier noise, not a
 * name, and is dropped rather than shown as if it identified somebody.
 */
export function formatVoicemailCaller(name: string | null | undefined, number: string | null | undefined): string {
  const raw = String(name || "").trim();
  const junk = /^(wireless caller|unknown|unavailable|anonymous|private|restricted)$/i.test(raw);
  const cleanName = junk ? "" : raw;
  const num = String(number || "").trim();
  if (cleanName && num) return `${cleanName} · ${num}`;
  if (cleanName) return cleanName;
  return num || "Unknown caller";
}

export type VoicemailEmailTemplateInput = {
  voicemailId: string;
  callerName?: string | null;
  callerNumber?: string | null;
  /** Mailbox the message was left for. */
  extension: string;
  /** Human name of that mailbox, when we have one. */
  extensionName?: string | null;
  durationSec?: number | null;
  receivedAtLabel: string;
  transcript?: string | null;
  transcriptLanguage?: string | null;
  /** Filename shown beside the attachment note. */
  attachmentName: string;
  /**
   * The company whose mailbox this is — printed in the footer as "sent on behalf
   * of <name>". Left out, the footer says "your organization" as before; it is
   * never guessed.
   */
  organizationName?: string | null;
};

export function voicemailEmail(input: VoicemailEmailTemplateInput): {
  subject: string;
  html: string;
  text: string;
} {
  const caller = formatVoicemailCaller(input.callerName, input.callerNumber);
  const duration = formatVoicemailDuration(input.durationSec);
  const mailbox = input.extensionName
    ? `extension ${input.extension} · ${input.extensionName}`
    : `extension ${input.extension}`;

  const transcript = String(input.transcript || "").trim();
  const rtl = transcriptIsRtl(input.transcriptLanguage);

  // ⛔ dir + text-align together. Setting only one leaves Yiddish punctuation
  // stranded on the wrong side in several clients.
  const transcriptBlock = transcript
    ? `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f8fafc" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin:0 0 6px;">
  <tr><td style="padding:16px 18px;">
    <p style="margin:0 0 8px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#64748b;font-family:${FONT};">What they said</p>
    <p${rtl ? ' dir="rtl"' : ""} style="margin:0;font-size:15px;line-height:1.7;color:#1e293b;font-family:${FONT};text-align:${rtl ? "right" : "left"};">${esc(transcript)}</p>
  </td></tr>
</table>
<p style="margin:8px 0 0;font-size:12px;color:#94a3b8;">Typed out automatically &mdash; it can get words wrong. The recording attached is the record.</p>`
    : `<p style="margin:0 0 4px;color:#64748b;font-size:14.5px;">No typed-out version for this one &mdash; play the recording attached below.</p>`;

  const body = `
<p style="margin:0 0 6px;font-size:17px;font-weight:600;color:#1e293b;">From ${esc(caller)}</p>
<p style="margin:0 0 20px;color:#64748b;font-size:14px;">Left for ${esc(mailbox)} &middot; ${esc(input.receivedAtLabel)} &middot; ${esc(duration)}</p>
${transcriptBlock}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f1f8ff" style="background:#f1f8ff;border:1px solid #cfe6fb;border-left:3px solid #22a8ff;border-radius:12px;margin:20px 0 0;">
  <tr><td style="padding:14px 18px;font-family:${FONT};">
    <p style="margin:0;font-size:14.5px;color:#1e293b;"><strong>The recording is attached to this email.</strong></p>
    <p style="margin:4px 0 0;font-size:13px;color:#64748b;">${esc(input.attachmentName)}</p>
  </td></tr>
</table>
${voicemailEmailMarker(input.voicemailId)}`;

  const textLines = [
    `New voicemail from ${caller}`,
    ``,
    `Left for ${mailbox}`,
    `${input.receivedAtLabel} · ${duration}`,
    ``,
    ...(transcript
      ? [`What they said:`, transcript, ``, `(Typed out automatically - it can get words wrong. The recording attached is the record.)`, ``]
      : [`No typed-out version for this one - play the recording attached.`, ``]),
    `The recording is attached to this email (${input.attachmentName}).`,
  ];

  return {
    subject: `New voicemail from ${caller}`,
    html: loopComShell({
      preheaderText: `${caller} left a ${duration} message for ${mailbox}.`,
      headerTitle: "New voicemail",
      body,
      organizationName: input.organizationName,
    }),
    text: textLines.join("\n"),
  };
}
