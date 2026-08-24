/**
 * SMS-to-email template — the email a person receives when a text lands on their
 * Loopcom number.
 *
 * ⛔⛔ REBUILT 2026-08-20 ONTO THE SHARED LOOPCOM SHELL. The original version of
 * this file was written 2026-07-26, three weeks BEFORE the Loopcom rebrand, and
 * it carried its own hand-rolled shell in the old Connect blue with no logo. It
 * was never revisited — so when the reply half (Part 3) shipped on 2026-08-20 it
 * changed the SENDER and left this template alone, and the bridge spent its
 * whole life emailing customers a pre-rebrand design. It was the only
 * customer-facing email still doing so.
 *
 * ⛔ The shell now comes from `@connect/shared` via `loopcomShellForAgent` — the
 * SAME renderer apps/api uses for the invite and voicemail emails. Do NOT
 * reintroduce a local shell here; that separation is exactly what let this drift
 * for weeks without anyone noticing.
 *
 * What is deliberately kept from the original:
 *  • the conversation as chat bubbles (incoming grey / your replies blue with a
 *    "Sent as text" tick) — a text email that does not look like a conversation
 *    is just a notification, and reading the thread is the whole point
 *  • the dashed "reply to text back" callout
 *  • the plain-text alternative, which is what a screen reader and a phone
 *    watch actually read out
 *
 * What changed beyond the shell:
 *  • ⛔ RIGHT-TO-LEFT IS NOW PER MESSAGE, not guessed once from the newest one.
 *    A large share of this customer base writes Yiddish; the old code sniffed
 *    only the latest message and applied the result to nothing at all. Get this
 *    wrong and the punctuation lands on the wrong end of every bubble.
 *  • light-only, because the shared shell pins `color-scheme: light`. The old
 *    file carried a full dark palette; the rebrand's shell decides this now.
 */
import { loopcomShellForAgent } from "./loopcomShell";

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
  /** Your Loopcom number that received the text (E.164 or raw). */
  yourNumber: string;
  /** Recent conversation, oldest → newest. The last item is the new inbound text. */
  messages: SmsEmailMessage[];
  /** True once reply-to-text-back is live, so the callout promises it. */
  replyEnabled?: boolean;
  brandName?: string;
  /**
   * The recipient's own company — the shell's footer names them instead of
   * saying "your organization". ⛔ Not the same thing as `brandName`, which is
   * OURS (Loopcom) and appears in the body copy. Null/blank is fine and keeps
   * the old generic wording.
   */
  organizationName?: string | null;
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

/** Light palette, aligned with the shared shell's card. */
const C = {
  ink: "#0f172a",
  ink2: "#475569",
  muted: "#94a3b8",
  line: "#e6ebf1",
  accent: "#22a8ff",
  accentInk: "#ffffff",
  inBub: "#eef1f5",
  inInk: "#1f2733",
  tick: "#12a150",
  calloutBg: "#f8fafc",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A contact name as it may appear in a mail HEADER (the Subject).
 *
 * ⛔ Measured 2026-08-23: 18 of 12,160 real contacts have a control character
 * in their display name, and that name is interpolated straight into the
 * subject. Nodemailer flattens a CR/LF to a space rather than letting a header
 * be injected — so this is not a hole today — but the subject is also HALF of
 * the one-email-thread-per-number promise, and a header should never depend on
 * a downstream library's sanitising to be well formed. Strips control
 * characters, collapses whitespace, and caps the length (longest real name is
 * 78 chars, so the cap moves nobody today).
 */
export function headerSafeName(s: string): string {
  const flat = Array.from(String(s ?? ""))
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp < 0x20 || cp === 0x7f ? " " : ch; // control chars can never reach a header
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 120 ? flat.slice(0, 119) + "…" : flat;
}

export function formatSmsPhone(num: string | null): string {
  if (!num) return "Unknown number";
  const d = num.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return num;
}

function timeOf(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * ⛔ Per-message, never once for the whole thread. Hebrew-script covers Yiddish,
 * which is a large share of the messages on this platform; Arabic is included
 * because the same rule applies and costs nothing.
 */
export function messageIsRtl(body: string): boolean {
  return /[֐-׿؀-ۿיִ-ﭏ]/.test(body);
}

function bubble(m: SmsEmailMessage, name: string): string {
  const out = m.direction === "OUT";
  const rtl = messageIsRtl(m.body);
  const dirAttr = rtl ? ` dir="rtl"` : "";
  const align = out ? "right" : "left";
  const bg = out ? C.accent : C.inBub;
  const fg = out ? C.accentInk : C.inInk;
  const who = out ? "You" : name;
  const tick = out
    ? `<span style="color:${C.tick};font-size:11px;"> &#10003; Sent as text</span>`
    : "";
  // Bubbles are tables, not divs with border-radius — Outlook drops the radius
  // but keeps the table, so it degrades to a flat box rather than to nothing.
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 10px;">
  <tr>
    <td align="${align}">
      <div style="font-family:${FONT};font-size:11px;color:${C.muted};padding:0 4px 3px;">${esc(who)} &middot; ${esc(timeOf(m.at))}${tick}</div>
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="max-width:430px;">
        <tr>
          <td bgcolor="${bg}" style="background:${bg};border-radius:14px;padding:10px 14px;font-family:${FONT};font-size:14.5px;line-height:1.5;color:${fg};word-break:break-word;"${dirAttr}>${esc(m.body).replace(/\n/g, "<br>")}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

export function buildSmsEmail(input: SmsEmailInput): BuiltEmail {
  const brand = input.brandName ?? "Loopcom";
  const name = (input.contactName && input.contactName.trim()) || formatSmsPhone(input.contactNumber);
  const number = formatSmsPhone(input.contactNumber);
  const yourNum = formatSmsPhone(input.yourNumber);
  const msgs = input.messages.slice(-8); // keep it a readable snippet
  const latest = msgs[msgs.length - 1];
  const preview = latest ? latest.body.slice(0, 140) : "";

  // ⛔ Stable subject — this is HALF of "one email thread per phone number".
  // The sender pins References to a per-thread root id; a subject that varied
  // per message would still split the conversation in most mail clients.
  const subject = `Text with ${headerSafeName(name)}`;

  // ── plain-text alternative ────────────────────────────────────────────
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

  // ── the conversation, then the callout ────────────────────────────────
  const conversation = msgs.map((m) => bubble(m, name)).join("\n");

  const callout = `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:22px 0 0;">
  <tr>
    <td bgcolor="${C.calloutBg}" style="background:${C.calloutBg};border:1px dashed ${C.line};border-radius:12px;padding:14px 16px;">
      <div style="font-family:${FONT};font-size:14px;font-weight:700;color:${C.ink};padding-bottom:3px;">${
        input.replyEnabled ? "Reply to text back" : `Reply from ${esc(brand)}`
      }</div>
      <div style="font-family:${FONT};font-size:13.5px;line-height:1.6;color:${C.ink2};">${
        input.replyEnabled
          ? `Just hit reply. Your message is sent to ${esc(name)} as a text from ${esc(yourNum)}.`
          : `Open ${esc(brand)} to answer this message.`
      }</div>
    </td>
  </tr>
</table>`;

  const footnote = `<div style="font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};padding:16px 0 0;">
  Sent because &ldquo;SMS to Email&rdquo; is on for your account. Every message with ${esc(name)} stays in this one email thread.
</div>`;

  const html = loopcomShellForAgent({
    preheaderText: preview || `New text from ${name}`,
    headerTitle: `Text from ${name}`,
    headerSubtitle: `${number} → your ${brand} number ${yourNum}`,
    body: `${conversation}\n${callout}\n${footnote}`,
    organizationName: input.organizationName,
  });

  return { subject, html, text };
}
