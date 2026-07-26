/**
 * SMS-to-email template — the email a person receives when a text lands on their
 * Connect number. Built to match the approved Connect SMS mockups on the dot:
 *
 *  • ONE HTML that renders as three faithful versions —
 *      Phone / Webmail  : responsive, rounded chat bubbles, live dark/light switch
 *      Outlook (Windows): the Word engine ignores media queries / rounded corners /
 *                         shadows, so it naturally falls back to the flat, boxy LIGHT
 *                         version — exactly the Outlook mockup.
 *  • Connect blue banner ("New text message"), the sender's name + number, the
 *    conversation as bubbles (incoming grey / your replies blue with a "Sent as
 *    text" tick), a dashed "reply to text back" callout, and a footer.
 *
 * Threading (one email thread per phone number) is done by the SENDER via stable
 * Message-ID / References headers + a stable subject — not in this template.
 *
 * Email dark-mode gotcha handled here (same as the voicemail template): inline
 * styles outrank <style> rules, so every themeable element carries a class AND the
 * dark @media block overrides it with !important. Windows Outlook ignores it and
 * keeps the light version (by design).
 */

export interface SmsEmailMessage {
  /** IN = they texted you; OUT = you replied (shown as a blue "Sent as text" bubble). */
  direction: "IN" | "OUT";
  body: string;
  at: Date;
}

export interface SmsEmailInput {
  /** Sender's name from contacts, or null → we show the formatted number. */
  contactName: string | null;
  /** The other person's number (E.164 or raw). */
  contactNumber: string;
  /** Your Connect number that received the text (E.164 or raw). */
  yourNumber: string;
  /** Recent conversation, oldest → newest. The last item is the new inbound text. */
  messages: SmsEmailMessage[];
  /** True once reply-to-text-back is live, so the callout promises it. */
  replyEnabled?: boolean;
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
    inBub: "#eceef3", inInk: "#1f2733", tick: "#12a150",
  },
  dark: {
    bg: "#0c1218", card: "#141f2b", card2: "#1a2635", ink: "#e1e9f1", ink2: "#b7c5d3",
    muted: "#8ea0b2", line: "#26374a", accent: "#22a8ff", accentInk: "#04121e",
    accentSoft: "#12283a", h1: "#173a5e", h2: "#0f6fb8",
    inBub: "#22303f", inInk: "#e1e9f1", tick: "#4ade80",
  },
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatSmsPhone(num: string | null): string {
  if (!num) return "Unknown number";
  const d = num.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return num;
}

function initials(name: string, number: string): string {
  const n = name.trim();
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] ?? "";
    const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (a + b).toUpperCase() || "#";
  }
  const d = number.replace(/\D/g, "");
  return d ? d.slice(-2) : "#";
}

function timeOf(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function dayLabel(d: Date): string {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return "Today";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function buildSmsEmail(input: SmsEmailInput): BuiltEmail {
  const brand = input.brandName ?? "Connect";
  const l = C.light;
  const d = C.dark;
  const name = (input.contactName && input.contactName.trim()) || formatSmsPhone(input.contactNumber);
  const number = formatSmsPhone(input.contactNumber);
  const yourNum = formatSmsPhone(input.yourNumber);
  const av = initials(input.contactName ?? "", input.contactNumber);
  const msgs = input.messages.slice(-8); // keep it a readable snippet
  const latest = msgs[msgs.length - 1];
  const preview = latest ? latest.body.slice(0, 140) : "";
  const isRtl = /[֐-׿]/.test(preview);

  const subject = `Text with ${name}`;

  // ── plain-text fallback ───────────────────────────────────────────────
  const text = [
    `New text on your ${brand} number ${yourNum}.`,
    ``,
    `From: ${name}  (${number})`,
    ``,
    ...msgs.map((m) => `${m.direction === "OUT" ? "You" : name} · ${timeOf(m.at)}\n${m.body}`),
    ``,
    input.replyEnabled
      ? `Reply to this email and it will be sent to ${name} as a text from your number.`
      : `Open ${brand} to reply.`,
    ``,
    `— Sent by ${brand} because "SMS to Email" is on. Every message from ${name} stays in this one thread.`,
  ].join("\n");

  // ── dark-mode <style> (overrides inline light styles with !important) ──
  const style = `
    :root{color-scheme:light dark;supported-color-schemes:light dark;}
    @media (prefers-color-scheme:dark){
      .s-bg{background:${d.bg}!important;}
      .s-card{background:${d.card}!important;border-color:${d.line}!important;}
      .s-card2{background:${d.card2}!important;border-color:${d.line}!important;}
      .s-ink{color:${d.ink}!important;}
      .s-ink2{color:${d.ink2}!important;}
      .s-muted{color:${d.muted}!important;}
      .s-hair{border-color:${d.line}!important;}
      .s-head{background:${d.h1}!important;}
      .s-inbub{background:${d.inBub}!important;}
      .s-inink{color:${d.inInk}!important;}
      .s-callout{background:${d.accentSoft}!important;border-color:${d.accent}!important;}
      .s-avatar{background:${d.accent}!important;color:${d.accentInk}!important;}
      .s-tick{color:${d.tick}!important;}
    }
    @media only screen and (max-width:600px){
      .s-wrap{width:100%!important;}
      .s-pad{padding-left:18px!important;padding-right:18px!important;}
      .s-title{font-size:21px!important;}
      .s-bub{max-width:82%!important;}
    }
  `.replace(/\s+/g, " ").trim();

  const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  // ── one chat bubble (aligned left for IN, right for OUT) ───────────────
  const bubble = (m: SmsEmailMessage) => {
    const rtl = /[֐-׿]/.test(m.body);
    if (m.direction === "OUT") {
      return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="right" style="padding:3px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="s-bub" style="max-width:60%;"><tr><td
          bgcolor="${l.accent}" style="background:${l.accent};border-radius:16px;border-bottom-right-radius:5px;padding:9px 14px;font-family:${FONT};font-size:14.5px;line-height:1.45;color:#ffffff;text-align:${rtl ? "right" : "left"};" dir="${rtl ? "rtl" : "ltr"}">${esc(m.body)}</td></tr></table>
        <div class="s-muted" style="font-family:${FONT};font-size:11px;color:${l.muted};padding:3px 3px 0 0;"><span class="s-tick" style="color:${l.tick};font-weight:700;">&#10003;</span> Sent as text &middot; ${timeOf(m.at)}</div>
      </td></tr></table>`;
    }
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="left" style="padding:3px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="s-bub" style="max-width:60%;"><tr><td
          class="s-inbub s-inink" bgcolor="${l.inBub}" style="background:${l.inBub};border-radius:16px;border-bottom-left-radius:5px;padding:9px 14px;font-family:${FONT};font-size:14.5px;line-height:1.45;color:${l.inInk};text-align:${rtl ? "right" : "left"};" dir="${rtl ? "rtl" : "ltr"}">${esc(m.body)}</td></tr></table>
        <div class="s-muted" style="font-family:${FONT};font-size:11px;color:${l.muted};padding:3px 0 0 3px;">${timeOf(m.at)}</div>
      </td></tr></table>`;
  };

  // group bubbles under a single day label (the newest text's day)
  const dayChip = latest
    ? `<tr><td align="center" style="padding:4px 0 12px;"><span class="s-muted" style="font-family:${FONT};font-size:11px;font-weight:600;color:${l.muted};">${esc(dayLabel(latest.at))}</span></td></tr>`
    : "";

  const bubbles = msgs.map((m) => `<tr><td class="s-pad" style="padding:0 24px;">${bubble(m)}</td></tr>`).join("");

  const callout = `
    <tr><td class="s-pad" style="padding:16px 24px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="s-callout" bgcolor="${l.accentSoft}" style="background:${l.accentSoft};border:1px dashed ${l.accent};border-radius:12px;">
        <tr>
          <td width="46" valign="top" style="padding:14px 0 14px 14px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="s-avatar" align="center" bgcolor="${l.accent}" style="background:${l.accent};color:#ffffff;width:32px;height:32px;border-radius:8px;font-family:${FONT};font-size:16px;font-weight:800;">&#8617;</td></tr></table>
          </td>
          <td style="padding:13px 14px;">
            <div class="s-ink" style="font-family:${FONT};font-size:14px;font-weight:700;color:${l.ink};padding-bottom:2px;">${input.replyEnabled ? "Reply to text back" : "Reply from Connect"}</div>
            <div class="s-ink2" style="font-family:${FONT};font-size:12.5px;line-height:1.45;color:${l.ink2};">${input.replyEnabled
              ? `Whatever you type in your reply is delivered to ${esc(name)} as a text from your number.`
              : `Open ${esc(brand)} to reply — texting back from email is coming soon.`}</div>
          </td>
        </tr>
      </table>
    </td></tr>`;

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
<body class="s-bg" style="margin:0;padding:0;background:${l.bg};" bgcolor="${l.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(name)}: ${esc(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="s-bg" bgcolor="${l.bg}" style="background:${l.bg};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="s-wrap" style="width:600px;max-width:600px;">
      <tr><td>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="s-card" bgcolor="${l.card}" style="background:${l.card};border:1px solid ${l.line};border-radius:18px;overflow:hidden;">

          <!-- header -->
          <tr><td class="s-head" bgcolor="${l.h1}" style="background:${l.h1};background:linear-gradient(135deg,${l.h1},${l.h2});padding:20px 24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="font-family:${FONT};font-size:15px;font-weight:800;color:#ffffff;">&#9689; ${esc(brand)}</td>
              <td align="right" style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#dbe8ff;">New text message</td>
            </tr></table>
          </td></tr>

          <!-- sender -->
          <tr><td class="s-pad s-hair" style="padding:18px 24px 16px;border-bottom:1px solid ${l.line};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td width="52" valign="middle" style="padding-right:12px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="s-avatar" align="center" bgcolor="${l.accent}" style="background:linear-gradient(135deg,${l.h1},${l.h2});color:#ffffff;width:44px;height:44px;border-radius:50%;font-family:${FONT};font-size:16px;font-weight:800;">${esc(av)}</td></tr></table>
              </td>
              <td valign="middle">
                <div class="s-title s-ink" style="font-family:${FONT};font-size:19px;font-weight:800;color:${l.ink};line-height:1.2;">Text with ${esc(name)}</div>
                <div class="s-muted" style="font-family:${FONT};font-size:13px;color:${l.muted};padding-top:2px;">${esc(number)} &middot; ${input.replyEnabled ? "reply to this email to text back" : "on your number " + esc(yourNum)}</div>
              </td>
            </tr></table>
          </td></tr>

          <!-- conversation -->
          <tr><td style="padding:18px 0 6px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${dayChip}
              ${bubbles}
            </table>
          </td></tr>

          ${callout}

          <!-- footer -->
          <tr><td class="s-pad s-hair" style="padding:18px 24px 22px;border-top:1px solid ${l.line};">
            <div class="s-muted" style="font-family:${FONT};font-size:12px;line-height:1.55;color:${l.muted};">
              Sent by <strong>${esc(brand)}</strong> because <strong>SMS to Email</strong> is on for <strong>${esc(yourNum)}</strong>. Every message from ${esc(name)} stays in this one thread. Turn it off any time in Quick Controls.
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
