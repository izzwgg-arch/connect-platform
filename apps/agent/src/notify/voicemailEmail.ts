/**
 * Voicemail-to-email template — the email a person receives when a new voicemail
 * lands in their mailbox. Built to match the approved Connect mockup on the dot:
 *
 *  • ONE HTML that renders as three faithful versions —
 *      Phone / Webmail  : responsive, rounded, with a live dark/light auto-switch
 *      Outlook (Windows): the Word engine ignores media queries, rounded corners
 *                         and shadows, so it naturally falls back to the flat,
 *                         boxy LIGHT version — exactly the Outlook mockup.
 *  • Connect blue throughout, in both themes.
 *  • Greets by the extension name, shows the ring-group prefix as a badge (just
 *    the word), caller name + number, duration, date/time, the typed-out message
 *    (optional), an attached recording note, and a footer.
 *
 * Email dark-mode gotcha handled here: inline styles outrank <style> rules, so
 * every themeable element carries a class AND the dark @media block overrides it
 * with !important. Apple Mail / iOS Mail / Outlook.com honour it; Windows Outlook
 * ignores it and keeps the light version (by design).
 */

export interface VoicemailEmailInput {
  /** Extension display name — the greeting uses this, never the email login. */
  recipientName: string;
  extensionNumber: string;
  /** Caller name with any ring-group prefix already stripped off. */
  callerName: string | null;
  /** Ring-group prefix shown as a badge (the word only, e.g. "Sales"). */
  ringGroupPrefix: string | null;
  callerNumber: string | null;
  durationSec: number;
  receivedAt: Date;
  /** Included only when the mailbox's "include the typed-out message" is on. */
  transcript?: string | null;
  attachmentName: string;
  /** False when the audio couldn't be fetched — wording drops the "attached". */
  recordingAttached?: boolean;
  /** Deep link back into Connect's voicemail page (optional). */
  listenUrl?: string | null;
  brandName?: string;
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

const C = {
  light: {
    bg: "#f6f8fb", card: "#ffffff", card2: "#f8fafc", ink: "#0f172a", ink2: "#475569",
    muted: "#94a3b8", line: "#e6ebf1", accent: "#3b82f6", accentInk: "#ffffff",
    accentSoft: "#eaf1fe", h1: "#2f6bff", h2: "#22a8ff",
  },
  dark: {
    bg: "#0c1218", card: "#141f2b", card2: "#1a2635", ink: "#e1e9f1", ink2: "#b7c5d3",
    muted: "#8ea0b2", line: "#26374a", accent: "#22a8ff", accentInk: "#04121e",
    accentSoft: "#12283a", h1: "#173a5e", h2: "#0f6fb8",
  },
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatVmDuration(sec: number): string {
  const s = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0;
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  const mm = `${m} minute${m === 1 ? "" : "s"}`;
  return r ? `${mm} ${r} sec` : mm;
}

export function formatVmPhone(num: string | null): string {
  if (!num) return "Unknown number";
  const d = num.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return num;
}

function formatVmDateTime(d: Date): { date: string; time: string } {
  const date = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return { date, time };
}

function firstName(recipientName: string): string {
  const w = recipientName.trim().split(/\s+/)[0];
  return w || recipientName.trim() || "there";
}

export function buildVoicemailEmail(input: VoicemailEmailInput): BuiltEmail {
  const brand = input.brandName ?? "Connect";
  const l = C.light;
  const caller = (input.callerName && input.callerName.trim()) || formatVmPhone(input.callerNumber) || "Unknown caller";
  const phone = formatVmPhone(input.callerNumber);
  const dur = formatVmDuration(input.durationSec);
  const { date, time } = formatVmDateTime(input.receivedAt);
  const transcript = input.transcript && input.transcript.trim() ? input.transcript.trim() : null;
  const prefix = input.ringGroupPrefix && input.ringGroupPrefix.trim() ? input.ringGroupPrefix.trim() : null;
  const attached = input.recordingAttached !== false;
  const subline = attached
    ? "Someone left you a voicemail. The recording is attached to this email, and here are the details."
    : "Someone left you a voicemail. Here are the details — open Connect to play the recording.";
  const isRtl = !!transcript && /[֐-׿]/.test(transcript);

  const subject = prefix
    ? `New voicemail (${prefix}) — ${caller}, ${dur}`
    : `New voicemail — ${caller}, ${dur}`;

  // ── plain-text fallback ────────────────────────────────────────────────
  const text = [
    `Hi ${firstName(input.recipientName)},`,
    ``,
    `You have a new voicemail.`,
    ``,
    prefix ? `Ring group: ${prefix}` : null,
    `From:      ${caller}`,
    `Phone:     ${phone}`,
    `Duration:  ${dur}`,
    `Received:  ${date} ${time}`,
    ``,
    transcript ? `What they said:\n${transcript}\n` : null,
    attached ? `The recording is attached (${input.attachmentName}).` : `Open Connect to play the recording.`,
    input.listenUrl ? `\nListen in ${brand}: ${input.listenUrl}` : null,
    ``,
    `— Sent by ${brand} because "Email my voicemails" is on for extension ${input.recipientName} (${input.extensionNumber}).`,
  ].filter((x) => x !== null).join("\n");

  // ── dark-mode <style> (overrides inline light styles with !important) ───
  const d = C.dark;
  const style = `
    :root{color-scheme:light dark;supported-color-schemes:light dark;}
    @media (prefers-color-scheme:dark){
      .vm-bg{background:${d.bg}!important;}
      .vm-card{background:${d.card}!important;border-color:${d.line}!important;}
      .vm-card2{background:${d.card2}!important;border-color:${d.line}!important;}
      .vm-ink{color:${d.ink}!important;}
      .vm-ink2{color:${d.ink2}!important;}
      .vm-muted{color:${d.muted}!important;}
      .vm-hair{border-color:${d.line}!important;}
      .vm-head{background:${d.h1}!important;}
      .vm-badge{background:${d.accentSoft}!important;color:${d.accent}!important;border-color:${d.accent}!important;}
      .vm-btn{background:${d.accent}!important;}
      .vm-btn a{color:${d.accentInk}!important;}
      .vm-key{color:${d.muted}!important;}
    }
    @media only screen and (max-width:600px){
      .vm-wrap{width:100%!important;}
      .vm-pad{padding-left:20px!important;padding-right:20px!important;}
      .vm-title{font-size:21px!important;}
    }
  `.replace(/\s+/g, " ").trim();

  const badge = prefix
    ? `<tr><td class="vm-pad" style="padding:0 24px 4px 24px;">
         <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td
           class="vm-badge" bgcolor="${l.accentSoft}"
           style="background:${l.accentSoft};color:${l.accent};border:1px solid ${l.accent};border-radius:6px;padding:6px 12px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;">
           ${esc(prefix)}
         </td></tr></table>
       </td></tr>`
    : "";

  const factRow = (k: string, v: string, sub?: string) => `
    <tr>
      <td class="vm-key" style="padding:12px 0;border-bottom:1px solid ${l.line};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${l.muted};width:110px;vertical-align:top;" class="vm-key vm-hair">${esc(k)}</td>
      <td class="vm-ink vm-hair" style="padding:12px 0;border-bottom:1px solid ${l.line};font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:${l.ink};">
        ${esc(v)}${sub ? `<div class="vm-ink2" style="font-weight:500;color:${l.ink2};font-size:13px;padding-top:2px;">${esc(sub)}</div>` : ""}
      </td>
    </tr>`;

  const transcriptBlock = transcript
    ? `<tr><td class="vm-pad" style="padding:18px 24px 0 24px;">
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           class="vm-card2" bgcolor="${l.card2}"
           style="background:${l.card2};border:1px solid ${l.line};border-radius:12px;">
           <tr><td style="padding:14px 16px;">
             <div class="vm-muted" style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${l.muted};padding-bottom:7px;">What they said</div>
             <div class="vm-ink" dir="${isRtl ? "rtl" : "ltr"}" style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:${l.ink};text-align:${isRtl ? "right" : "left"};">${esc(transcript)}</div>
             <div class="vm-muted" style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11.5px;color:${l.muted};padding-top:9px;">Typed out automatically from the recording — may not be word-perfect.</div>
           </td></tr>
         </table>
       </td></tr>`
    : "";

  const attachBlock = attached
    ? `<tr><td class="vm-pad" style="padding:16px 24px 0 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="vm-card2 vm-hair" bgcolor="${l.card2}" style="background:${l.card2};border:1px solid ${l.line};border-radius:12px;">
              <tr>
                <td width="46" style="padding:12px 0 12px 14px;vertical-align:middle;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="vm-badge" bgcolor="${l.accentSoft}" align="center" style="background:${l.accentSoft};color:${l.accent};width:34px;height:34px;border-radius:8px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:800;">&#9834;</td></tr></table>
                </td>
                <td style="padding:12px 14px;vertical-align:middle;">
                  <div class="vm-ink" style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:${l.ink};">${esc(input.attachmentName)}</div>
                  <div class="vm-muted" style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;color:${l.muted};padding-top:1px;">Voicemail recording &middot; attached</div>
                </td>
              </tr>
            </table>
          </td></tr>`
    : "";

  const cta = input.listenUrl
    ? `<tr><td class="vm-pad" style="padding:20px 24px 4px 24px;">
         <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(input.listenUrl)}" style="height:46px;v-text-anchor:middle;width:100%;" arcsize="0%" fillcolor="${l.accent}" stroke="f"><w:anchorlock/><center style="color:#ffffff;font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:bold;">Listen in ${esc(brand)}</center></v:roundrect><![endif]-->
         <!--[if !mso]><!-->
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="vm-btn" bgcolor="${l.accent}" style="background:${l.accent};border-radius:12px;">
           <tr><td align="center" style="padding:14px 18px;">
             <a href="${esc(input.listenUrl)}" style="color:${l.accentInk};text-decoration:none;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:800;display:block;">Listen in ${esc(brand)}</a>
           </td></tr>
         </table>
         <!--<![endif]-->
       </td></tr>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(subject)}</title>
<!--[if mso]><style>* {font-family:'Segoe UI',Arial,sans-serif !important;}</style><![endif]-->
<style>${style}</style>
</head>
<body class="vm-bg" style="margin:0;padding:0;background:${l.bg};" bgcolor="${l.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">New voicemail${prefix ? ` (${esc(prefix)})` : ""} from ${esc(caller)} — ${esc(dur)}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="vm-bg" bgcolor="${l.bg}" style="background:${l.bg};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="vm-wrap" style="width:600px;max-width:600px;">
      <tr><td>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="vm-card" bgcolor="${l.card}" style="background:${l.card};border:1px solid ${l.line};border-radius:18px;overflow:hidden;">

          <!-- header -->
          <tr><td class="vm-head" bgcolor="${l.h1}" style="background:${l.h1};background:linear-gradient(135deg,${l.h1},${l.h2});padding:22px 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:800;color:#ffffff;">◗ ${esc(brand)}</td>
            </tr></table>
            <div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#dbe8ff;padding:16px 0 3px;">New voicemail</div>
            <div class="vm-title" style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:23px;font-weight:800;color:#ffffff;line-height:1.15;">You have a new voicemail</div>
          </td></tr>

          <!-- greeting -->
          <tr><td class="vm-pad" style="padding:22px 24px 4px 24px;">
            <div class="vm-ink" style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:${l.ink};padding-bottom:4px;">Hi ${esc(firstName(input.recipientName))},</div>
            <div class="vm-ink2" style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:${l.ink2};padding-bottom:16px;">${esc(subline)}</div>
          </td></tr>

          ${badge}

          <!-- details -->
          <tr><td class="vm-pad" style="padding:8px 24px 0 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="vm-card2" bgcolor="${l.card2}" style="background:${l.card2};border:1px solid ${l.line};border-radius:14px;">
              <tr><td style="padding:2px 16px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  ${factRow("From", caller, "Their name from caller ID")}
                  ${factRow("Phone", phone)}
                  ${factRow("Duration", dur)}
                  <tr>
                    <td class="vm-key" style="padding:12px 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${l.muted};width:110px;vertical-align:top;">Received</td>
                    <td class="vm-ink" style="padding:12px 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:${l.ink};">${esc(date)}<div class="vm-ink2" style="font-weight:500;color:${l.ink2};font-size:13px;padding-top:2px;">${esc(time)}</div></td>
                  </tr>
                </table>
              </td></tr>
            </table>
          </td></tr>

          ${transcriptBlock}

          ${attachBlock}

          ${cta}

          <!-- footer -->
          <tr><td class="vm-pad vm-hair" style="padding:20px 24px 24px 24px;border-top:1px solid ${l.line};">
            <div class="vm-muted" style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.55;color:${l.muted};">
              Sent by <strong>${esc(brand)}</strong> because <strong>Email my voicemails</strong> is turned on for extension <strong>${esc(input.recipientName)} (${esc(input.extensionNumber)})</strong>. You can turn it off any time in Quick Controls on your Voicemail page.
            </div>
          </td></tr>

        </table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  return { subject, html, text };
}
