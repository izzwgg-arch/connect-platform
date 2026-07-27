/**
 * Intent detection (PLAN.md §4, §8). Heuristic now (works with no LLM keys),
 * with a clean seam for LLM extraction when keys land. Recognizes English and
 * Yiddish phrasings. Conservative: ambiguous → "chat" (never guess-execute an
 * action; the triage layer will ask a clarifying question instead).
 */
export type Intent =
  | { kind: "diagnostic"; extensionHint?: string; complaint: string }
  | { kind: "action"; actionType: ActionType; extensionHint?: string; targetHint?: string; untilHint?: string; enableHint?: "yes" | "no"; raw: string }
  | { kind: "chat"; raw?: string };

export type ActionType = "forward" | "dnd" | "moh" | "ivr_switch" | "vm_reset" | "unknown";

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
  { type: "moh", terms: ["hold music", "music on hold", "on-hold music", "waiting music", "האלט מוזיק"] },
  { type: "ivr_switch", terms: ["holiday menu", "switch ivr", "change the ivr", "change my menu", "holiday greeting", "night mode"] },
  { type: "vm_reset", terms: ["reset voicemail", "voicemail pin", "vm pin", "voicemail password"] },
];

const EXT_RE = /\b(?:ext(?:ension)?\.?\s*)?(\d{2,5})\b/i;

// DND direction: a DND request is "enable" unless the message clearly asks to
// clear it ("turn off dnd", "take me out of do not disturb", "cancel dnd"…).
// Conservative: only unmistakable disable words flip the direction.
const DND_DISABLE_RE = /\boff\b|\bdisable|\bremove\b|\bcancel|\bstop\b|\bdeactivat|\bun-?dnd\b|\bout of\b|\bresume\b|אויסשאַלט|נעם(?:ט)? אַראָפּ/i;

// MOH direction: "activate a profile" unless the message clearly asks to go
// back to the regular schedule ("turn off the holiday hold music", "back to
// the normal hold music", "change it back in 15 minutes", "revert").
export const MOH_DEACTIVATE_RE =
  /\boff\b|\bdisable|\bremove\b|\bcancel|\bdeactivat|\brevert\b|\bback to (?:the )?(?:schedule|normal|default|regular)\b|\bregular\b|\bnormal\b|\b(?:change|switch|put|set)\s+(?:it\s+|everything\s+|the\s+(?:hold\s+)?music\s+)?back\b/i;

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
        enableHint:
          p.type === "dnd"
            ? DND_DISABLE_RE.test(t)
              ? "no"
              : "yes"
            : p.type === "moh"
              ? MOH_DEACTIVATE_RE.test(t)
                ? "no"
                : "yes"
              : undefined,
        raw: text,
      };
    }
  }

  if (DIAG_TERMS.some((term) => t.includes(term))) {
    return { kind: "diagnostic", extensionHint: text.match(EXT_RE)?.[1], complaint: text };
  }

  // raw is carried so the triage layer can resume a pending clarification
  // (e.g. the bare profile name answering "Which hold music would you like?").
  return { kind: "chat", raw: text };
}
