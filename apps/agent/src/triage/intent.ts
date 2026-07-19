/**
 * Intent detection (PLAN.md §4, §8). Heuristic now (works with no LLM keys),
 * with a clean seam for LLM extraction when keys land. Recognizes English and
 * Yiddish phrasings. Conservative: ambiguous → "chat" (never guess-execute an
 * action; the triage layer will ask a clarifying question instead).
 */
export type Intent =
  | { kind: "diagnostic"; extensionHint?: string; complaint: string }
  | { kind: "action"; actionType: ActionType; extensionHint?: string; targetHint?: string; untilHint?: string; raw: string }
  | { kind: "chat" };

export type ActionType = "forward" | "dnd" | "ivr_switch" | "vm_reset" | "unknown";

const DIAG_TERMS = [
  "not ringing", "won't ring", "wont ring", "doesn't ring", "no calls", "not receiving", "can't hear", "cant hear",
  "one way", "one-way", "no audio", "dropping", "cutting out", "dead", "not working", "broken", "no dial tone",
  "voicemail not", "can't call", "cant call",
  // Yiddish
  "קלינגט נישט", "נישט קלינגען", "הערט נישט", "נישט הערן", "טוט נישט", "צעבראכן", "נישט ארבעט",
];

const ACTION_PATTERNS: Array<{ type: ActionType; terms: string[] }> = [
  { type: "forward", terms: ["forward my call", "forward call", "transfer my call", "send my call", "divert", "forward to", "פארוואַרד", "אריבערפירן", "טראַנספער"] },
  { type: "dnd", terms: ["do not disturb", "dnd", "silence my", "don't ring me", "נישט שטערן"] },
  { type: "ivr_switch", terms: ["holiday menu", "switch ivr", "change the ivr", "change my menu", "holiday greeting", "night mode"] },
  { type: "vm_reset", terms: ["reset voicemail", "voicemail pin", "vm pin", "voicemail password"] },
];

const EXT_RE = /\b(?:ext(?:ension)?\.?\s*)?(\d{2,5})\b/i;

export function detectIntent(text: string): Intent {
  const t = text.toLowerCase();

  // Action first (more specific), then diagnostic.
  for (const p of ACTION_PATTERNS) {
    if (p.terms.some((term) => t.includes(term))) {
      const ext = text.match(EXT_RE)?.[1];
      const targetMatch = t.match(/to (?:ext(?:ension)?\.?\s*)?(\d{2,5})/);
      const untilMatch = t.match(/(?:until|till|til|through|bis)\s+([^.,\n]+)/i);
      return {
        kind: "action",
        actionType: p.type,
        extensionHint: ext,
        targetHint: targetMatch?.[1],
        untilHint: untilMatch?.[1]?.trim(),
        raw: text,
      };
    }
  }

  if (DIAG_TERMS.some((term) => t.includes(term))) {
    return { kind: "diagnostic", extensionHint: text.match(EXT_RE)?.[1], complaint: text };
  }

  return { kind: "chat" };
}
