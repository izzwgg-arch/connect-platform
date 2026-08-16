/**
 * "Fix it!" by text — what counts as an approval, and what it is allowed to say.
 *
 * The escalation SMS ends with a one-time code. The owner replies `FIX 481203`
 * and that exact fix is carried out, once. This file holds the pure half: how a
 * reply is read, and the wording of the messages. The gates live in
 * `apps/api/src/agentFixByText.ts` and `agentConfirmations.ts`.
 *
 * ⛔ THE PARSING RULE: an approval must be DELIBERATE and must name the fix.
 * A bare "ok", "yes", "do it", "approved" is NOT an approval here — those are
 * the words people type by reflex, into a thread that also carries ordinary
 * conversation, and one of them landing on a stale escalation would change a
 * customer's phone system by accident. The code is the whole safety story on
 * the reading side: it proves WHICH fix, and it proves the sender read the
 * message rather than glancing at a notification.
 */

/** Codes are digits only — unambiguous to read off a phone screen and to type. */
export const FIX_CODE_LENGTH = 6;
export const FIX_CODE_PATTERN = new RegExp(`^\\d{${FIX_CODE_LENGTH}}$`);

export interface ParsedFixReply {
  code: string;
}

/**
 * Read an inbound SMS as an approval, or null.
 *
 * Accepted, because these are what a person actually types:
 *   "FIX 481203" · "fix481203" · "Fix it 481203" · "FIX: 481203" · "481203 fix"
 * Refused, deliberately:
 *   "ok" · "yes" · "do it" · "approved" · "481203" on its own · "FIX" on its own
 *
 * A bare code is refused too: a number by itself is the most likely thing to be
 * typed for some other reason (a callback number, an extension), and the cost
 * of being wrong here is a live change to a customer's account.
 */
export function parseFixReply(text: string | null | undefined): ParsedFixReply | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  // Normalise: strip punctuation that phones and people add around the word.
  const cleaned = raw.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (!/\bfix\b|\bfix\d/.test(cleaned)) return null;

  // The code may be glued to the word ("fix481203") or separated by anything.
  const glued = /\bfix\s*(\d{4,10})\b/.exec(cleaned);
  const trailing = /\b(\d{4,10})\b(?=[^\d]*\bfix\b)/.exec(cleaned);
  const anywhere = /\b(\d{4,10})\b/.exec(cleaned);
  const digits = glued?.[1] ?? trailing?.[1] ?? anywhere?.[1];
  if (!digits || !FIX_CODE_PATTERN.test(digits)) return null;
  return { code: digits };
}

/** The line appended to an escalation SMS when a fix is ready to approve. */
export function renderFixOfferLine(code: string): string {
  return `Reply FIX ${code} to approve this fix. Nothing happens until you do.`;
}

export type FixOutcomeKind = "applied" | "refused" | "failed" | "unknown_code" | "expired" | "already_used";

/**
 * The reply the owner gets back. Every outcome answers the same two questions:
 * did anything change, and what does he need to do now.
 */
export function renderFixOutcomeSms(input: {
  kind: FixOutcomeKind;
  tenantName?: string | null;
  summary?: string | null;
  detail?: string | null;
}): string {
  const who = input.tenantName ? ` for ${input.tenantName}` : "";
  const what = input.summary ? ` ${input.summary}` : "";
  switch (input.kind) {
    case "applied":
      return `Done${who}.${what}`.trim();
    case "refused":
      return `Not done${who} —${input.detail ? ` ${input.detail}` : " the change was refused."} Nothing was changed.`.trim();
    case "failed":
      return `Tried and failed${who}.${input.detail ? ` ${input.detail}` : ""} Needs a person — the approval is spent, so send a new request rather than replying again.`.trim();
    case "unknown_code":
      return "That code doesn't match anything. Nothing was changed.";
    case "expired":
      return "That code has expired. Nothing was changed — ask the assistant again and a fresh one will come through.";
    case "already_used":
      return "That code was already used. Nothing was changed a second time.";
  }
}

/** Cap: SMS is 160 chars per segment and this rides the owner's phone. */
export function truncateSms(text: string, max = 300): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
