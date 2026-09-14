/**
 * The support agent's texts to the owner: what it is doing, and his STOP / GO.
 *
 * Izzy, 2026-09-14: a change that only affects the ticket's own company → text
 * him what is being done and keep going unless he steps in; a change that
 * affects the whole system → text him and wait until he says go.
 *
 * ⛔ Same reading rule as `FIX <code>` (agentFixByText.ts): the WORD and the
 * 6-digit CODE, together. A bare "stop", "go", "ok" or a bare number is never a
 * decision — those are typed by reflex into a thread that carries other texts.
 * ⛔ A negation anywhere next to GO ("no go 123456", "don't go 123456") is
 * refused, never read as a yes. STOP is never refused for that reason: stopping
 * is always the safe direction.
 */

export const NOTICE_CODE_LENGTH = 6;

export type NoticeScope = "tenant" | "system";
export type NoticeReplyKind = "stop" | "go";

export interface ParsedNoticeReply {
  kind: NoticeReplyKind;
  code: string;
}

const NEGATIONS = new Set(["no", "not", "dont", "don", "never", "nope", "cancel", "wait", "hold"]);

export function parseNoticeReply(text: string | null | undefined): ParsedNoticeReply | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const expanded: string[] = [];
  for (const w of words) {
    const glued = /^(stop|go)([0-9]+)$/.exec(w);
    if (glued) expanded.push(glued[1], glued[2]);
    else expanded.push(w);
  }
  const hasStop = expanded.includes("stop");
  const hasGo = expanded.includes("go");
  // Neither word, or both (ambiguous): not a decision.
  if (hasStop === hasGo) return null;
  if (hasGo && expanded.some((w) => NEGATIONS.has(w))) return null;
  const codes = expanded.filter((w) => /^[0-9]+$/.test(w));
  if (codes.length !== 1 || codes[0].length !== NOTICE_CODE_LENGTH) return null;
  return { kind: hasStop ? "stop" : "go", code: codes[0] };
}

function sentence(text: string, max: number): string {
  const flat = String(text ?? "").trim().split(" ").filter(Boolean).join(" ");
  const clipped = flat.length <= max ? flat : flat.slice(0, max - 1).trimEnd() + "…";
  return /[.!?…]$/.test(clipped) ? clipped : clipped + ".";
}

export function renderOwnerNoticeSms(input: {
  scope: NoticeScope;
  reference: string;
  tenantName: string;
  userName: string;
  summary: string;
  code: string;
}): string {
  const summary = sentence(input.summary, 240);
  if (input.scope === "tenant") {
    return `Loopcom agent — ${input.tenantName} / ${input.userName}, ticket ${input.reference}. Doing now: ${summary} Reply STOP ${input.code} to stop it.`;
  }
  return `Loopcom agent — ticket ${input.reference} (${input.tenantName}) needs a change that affects ALL customers: ${summary} Reply GO ${input.code} to allow it or STOP ${input.code} to refuse. Nothing happens until you reply.`;
}

export type NoticeOutcomeKind =
  | "stopped"
  | "approved"
  | "already_stopped"
  | "already_decided"
  | "not_needed"
  | "unknown_code"
  | "expired";

export function renderNoticeOutcomeSms(kind: NoticeOutcomeKind, reference?: string | null): string {
  const t = reference ? ` on ticket ${reference}` : "";
  switch (kind) {
    case "stopped":
      return `Stopped${t}. The agent will make no more changes on it.`;
    case "approved":
      return `Go-ahead received${t}. The agent will carry out that change now.`;
    case "already_stopped":
      return `Already stopped${t}. Nothing more will change.`;
    case "already_decided":
      return `That request${t} was already decided. Nothing changed a second time.`;
    case "not_needed":
      return `That one${t} only affects one company, so it doesn't wait for GO. Reply STOP with the code to stop it.`;
    case "unknown_code":
      return "That code doesn't match any agent request. Nothing changed.";
    case "expired":
      return `That request${t} has expired. Nothing changed; the agent must ask again.`;
  }
}
