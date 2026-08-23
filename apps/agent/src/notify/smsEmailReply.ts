/**
 * SMS-to-email reply routing — the PURE half of Part 3 (reply-to-text-back).
 *
 * The forward job puts `Reply-To: sms+<threadId>.<sig>@<replyDomain>` on every
 * SMS email (Gmail plus-addressing delivers that to the base mailbox, e.g.
 * sms@loopcom.net). This module owns:
 *
 *   • minting that address (the forward job calls mintSmsReplyAddress, so the
 *     mint and the verify can NEVER drift apart), and verifying it —
 *     HMAC-SHA256 over the threadId, base64url, first 24 chars, timing-safe
 *     compare. The address is the capability: only someone who received the
 *     forward email holds it.
 *   • pulling a person's actual words out of a reply email — mail clients bury
 *     them under quoted history, signatures and "Sent from my iPhone" lines,
 *     and every one of those would otherwise be TEXTED TO A CUSTOMER.
 *   • recognising auto-generated mail (out-of-office, bounces). An OOO
 *     responder replying to a forward must never become an SMS.
 *
 * ⛔ Nothing here transforms the message body's language or content — Yiddish
 * (or any RTL text) passes through byte-for-byte. Stripping only ever CUTS
 * whole trailing sections, it never rewrites a line the person typed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const b64url = (b: Buffer) => b.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");

export const SMS_REPLY_SIG_LENGTH = 24;

/** The signature half of the reply address. Byte-identical to what the forward job has always minted. */
export function mintSmsReplySignature(threadId: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(threadId).digest()).slice(0, SMS_REPLY_SIG_LENGTH);
}

/** Full reply address, e.g. `sms+cmxyz.AbC-12@loopcom.net`. */
export function mintSmsReplyAddress(threadId: string, secret: string, domain: string): string {
  return `sms+${threadId}.${mintSmsReplySignature(threadId, secret)}@${domain}`;
}

export interface ParsedSmsReplyAddress {
  threadId: string;
  sig: string;
  domain: string;
}

/** Parse one address of the `sms+<threadId>.<sig>@<domain>` shape. Null when it isn't one. */
export function parseSmsReplyAddress(address: string): ParsedSmsReplyAddress | null {
  const m = /^sms\+([A-Za-z0-9]+)\.([A-Za-z0-9_-]{16,64})@([^@\s]+)$/i.exec(String(address || "").trim());
  if (!m) return null;
  return { threadId: m[1], sig: m[2], domain: m[3].toLowerCase() };
}

export interface SmsReplyTargetResolution {
  /** "ok" = exactly one conversation is named and proven; route to `target`. */
  status: "ok" | "none" | "ambiguous";
  target: ParsedSmsReplyAddress | null;
  /** Distinct thread ids among the VERIFIED candidates (for the audit line). */
  threadIds: string[];
  /** How many addresses on our domain the mail carried at all. */
  candidateCount: number;
  /** True when addresses were present but not one of them verified. */
  sawUnverified: boolean;
  /** True when References/In-Reply-To picked between verified candidates. */
  usedThreadingHint: boolean;
}

/** `sms-thread-<threadId>@…` — the synthetic root id the forward job threads on. */
const THREAD_ROOT_RE = /sms-thread-([A-Za-z0-9]+)@/gi;

/**
 * WHICH conversation an incoming mail is a reply to.
 *
 * ⛔⛔ THE ORDER HERE IS THE WHOLE POINT: VERIFY FIRST, THEN COUNT.
 * The 2026-08-21 version counted the raw addresses first and refused anything
 * that carried more than one — and Gmail puts the SAME address in the mail
 * TWICE: once as sent (`To:`) and once with the local part LOWERCASED
 * (`Delivered-To:`). The signature is base64url, so those two strings differ,
 * and every real reply looked like two conversations and was refused. It was
 * invisible for three days because the only mails that ever succeeded were sent
 * FROM the bridge mailbox to itself, which Gmail does not stamp that way.
 * Measured on the live mailbox 2026-08-23: two customer replies, each ONE thread,
 * each counted as two. **Never count unverified strings.**
 *
 * The security property is unchanged and is stated in terms of CONVERSATIONS,
 * not strings: a mail that proves it holds the capability for two DIFFERENT
 * conversations has no single correct destination and is refused. Junk that
 * fails verification is ignored rather than allowed to veto a genuine reply —
 * counting it would let anyone kill a customer's replies just by CC'ing a
 * made-up `sms+…@` address.
 */
export function resolveSmsReplyTarget(opts: {
  candidates: string[];
  replyDomain: string;
  secret: string;
  /**
   * Raw References / In-Reply-To text. Used ONLY to choose between addresses
   * that have ALREADY been verified — never to route on its own. It is
   * client-supplied, so it can express a preference among capabilities the
   * sender demonstrably holds and nothing more.
   */
  threadingHint?: string | null;
}): SmsReplyTargetResolution {
  const want = String(opts.replyDomain || "").trim().toLowerCase();
  const secret = String(opts.secret || "");
  const empty: SmsReplyTargetResolution = {
    status: "none", target: null, threadIds: [], candidateCount: 0, sawUnverified: false, usedThreadingHint: false,
  };
  if (!want || !secret) return empty;

  const parsed: ParsedSmsReplyAddress[] = [];
  for (const c of opts.candidates || []) {
    const p = parseSmsReplyAddress(c);
    if (p && p.domain === want) parsed.push(p);
  }
  if (parsed.length === 0) return empty;

  // Verify BEFORE counting. A candidate proves nothing until its signature does.
  const verified = parsed.filter((p) => verifySmsReplySignature(p.threadId, p.sig, secret));
  if (verified.length === 0) {
    return { ...empty, candidateCount: parsed.length, sawUnverified: true };
  }

  // Group by conversation. ⛔ Case-insensitively: an MTA that lowercased the
  // local part lowercased the thread id too, so the two copies of ONE id must
  // not read as two conversations. The surviving candidate keeps its own case.
  const groups = new Map<string, ParsedSmsReplyAddress>();
  for (const p of verified) {
    const key = p.threadId.toLowerCase();
    if (!groups.has(key)) groups.set(key, p);
  }
  const threadIds = Array.from(groups.values()).map((p) => p.threadId);
  if (groups.size === 1) {
    return {
      status: "ok", target: groups.values().next().value ?? null,
      threadIds, candidateCount: parsed.length, sawUnverified: parsed.length !== verified.length,
      usedThreadingHint: false,
    };
  }

  // More than one PROVEN conversation. Let the mail client say which one it was
  // replying to — but only as a tie-break among capabilities already held.
  const hint = String(opts.threadingHint || "");
  if (hint) {
    const named = new Set<string>();
    for (const m of hint.matchAll(THREAD_ROOT_RE)) named.add(m[1].toLowerCase());
    const picked = Array.from(groups.entries()).filter(([key]) => named.has(key));
    if (picked.length === 1) {
      return {
        status: "ok", target: picked[0][1], threadIds,
        candidateCount: parsed.length, sawUnverified: parsed.length !== verified.length,
        usedThreadingHint: true,
      };
    }
  }
  return {
    status: "ambiguous", target: null, threadIds,
    candidateCount: parsed.length, sawUnverified: parsed.length !== verified.length,
    usedThreadingHint: false,
  };
}

function timingSafeEq(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Timing-safe signature check.
 *
 * ⛔ Accepts the signature as minted, AND the all-lowercase form of that exact
 * signature — because a receiving MTA (Gmail, measured) lowercases the whole
 * local part when it stamps `Delivered-To:`, and base64url is case-significant.
 * This is NOT a case-insensitive compare of arbitrary input: the candidate must
 * itself be entirely lower-case, and must then equal the lower-cased true
 * signature, so exactly ONE derived string is accepted beyond the original.
 * Without it, a reply whose only surviving copy is the MTA-stamped one is
 * refused as forged — a silent drop of a genuine customer message.
 */
export function verifySmsReplySignature(threadId: string, sig: string, secret: string): boolean {
  if (!threadId || !sig || !secret) return false;
  const expected = mintSmsReplySignature(threadId, secret);
  const candidate = String(sig);
  if (timingSafeEq(expected, candidate)) return true;
  if (candidate !== candidate.toLowerCase()) return false; // only an MTA-flattened copy qualifies
  return timingSafeEq(expected.toLowerCase(), candidate);
}

/**
 * True for mail no human wrote — vacation responders, bounces, list mail.
 * `headers` keys must be lower-cased. Texting an out-of-office blurb to a
 * customer is the failure this exists to prevent.
 */
export function isAutoGeneratedEmail(headers: Record<string, string>, subject: string): boolean {
  const h = (name: string) => String(headers?.[name] ?? "").trim().toLowerCase();
  const autoSubmitted = h("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") return true;
  const precedence = h("precedence");
  if (precedence === "bulk" || precedence === "junk" || precedence === "auto_reply" || precedence === "list") return true;
  if (headers && ("x-autoreply" in headers || "x-autorespond" in headers)) return true;
  if (h("x-auto-response-suppress")) return true;
  if (h("return-path") === "<>") return true; // bounce
  const subj = String(subject || "").trim().toLowerCase();
  if (/^(automatic reply|auto(-|\s)?reply|out of office|autosvar|automatische antwort|réponse automatique)/i.test(subj)) return true;
  if (/^(delivery status notification|undeliverable|mail delivery failed)/i.test(subj)) return true;
  return false;
}

// ── reply-text extraction ─────────────────────────────────────────────────────

/** Very small HTML→text for replies that carry no text/plain part. */
export function htmlToReplyText(html: string): string {
  let s = String(html || "");
  // Gmail wraps the quoted history in a well-known container — drop it whole.
  s = s.replace(/<(div|blockquote)[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*$/i, "");
  s = s.replace(/<blockquote[\s\S]*$/i, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<br\s*\/?>(\n)?/gi, "\n").replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return s;
}

const ATTRIBUTION_RE = /^On .{0,300}wrote:\s*$/; // "On Tue, Aug 20 ... <x@y> wrote:"
const ORIGINAL_MESSAGE_RE = /^\s*-{2,}\s*(Original|Forwarded) Message\s*-{2,}\s*$/i;
const OUTLOOK_DIVIDER_RE = /^_{5,}\s*$/;
const SIGNATURE_RE = /^--\s*$/;
const SENT_FROM_RE = /^(sent from my|get outlook for)/i;

/**
 * The person's own words, with quoted history / signatures / client footers cut
 * off. Prefers the text/plain part; falls back to a crude HTML conversion.
 * Returns "" when nothing human remains.
 */
export function extractSmsReplyText(text: string | null | undefined, html?: string | null): string {
  let raw = String(text ?? "").trim() ? String(text) : htmlToReplyText(String(html ?? ""));
  raw = raw.replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Gmail attribution ("On ... wrote:") — may wrap onto a second/third line.
    // ⛔ Join only CONSECUTIVE NON-EMPTY lines: a real attribution never wraps
    // across a blank line, while a person's own message may well START with
    // "On my way" right above the quoted block.
    if (/^On\b/.test(trimmed)) {
      let joined = trimmed;
      let isAttribution = ATTRIBUTION_RE.test(joined);
      for (let j = i + 1; !isAttribution && j <= i + 2; j++) {
        const cont = lines[j]?.trim();
        if (!cont) break;
        joined = `${joined} ${cont}`;
        isAttribution = /^On .{0,400}wrote:$/.test(joined);
      }
      if (isAttribution) break;
    }
    if (ORIGINAL_MESSAGE_RE.test(trimmed) || OUTLOOK_DIVIDER_RE.test(trimmed)) break;
    // Outlook top-posting block: "From: ..." followed shortly by Sent:/Date:/To:
    if (/^From:\s*.+$/i.test(trimmed)) {
      const next = [lines[i + 1]?.trim() ?? "", lines[i + 2]?.trim() ?? ""];
      if (next.some((n) => /^(Sent|Date|To):\s/i.test(n))) break;
    }
    if (trimmed.startsWith(">")) break; // plain quoted block
    if (SIGNATURE_RE.test(line)) break; // "-- " signature divider
    kept.push(line);
  }

  // Drop trailing client footers ("Sent from my iPhone") and blank lines.
  while (kept.length > 0) {
    const last = kept[kept.length - 1].trim();
    if (!last || SENT_FROM_RE.test(last)) kept.pop();
    else break;
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
