/**
 * Intent detection (PLAN.md §4, §8). Heuristic now (works with no LLM keys),
 * with a clean seam for LLM extraction when keys land. Recognizes English and
 * Yiddish phrasings. Conservative: ambiguous → "chat" (never guess-execute an
 * action; the triage layer will ask a clarifying question instead).
 */
export type Intent =
  | { kind: "diagnostic"; extensionHint?: string; complaint: string }
  | { kind: "action"; actionType: ActionType; extensionHint?: string; targetHint?: string; untilHint?: string; enableHint?: "yes" | "no"; statusQuery?: boolean; raw: string }
  | { kind: "chat"; raw?: string };

export type ActionType = "forward" | "dnd" | "moh" | "ivr_switch" | "pbx_config" | "vm_reset" | "unknown";

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
  // PBX config (M3 inbound routing / M4 IVR / M10 queues) — BEFORE moh so
  // "change the QUEUE hold music" routes to M10, not the tenant-wide M1.
  // The LLM extractor re-reads the message against the tenant's real catalog;
  // a non-config match ("what's on the lunch menu") falls back to plain chat.
  {
    type: "pbx_config",
    terms: [
      "queue", " ivr", "ivr ", "auto attendant", "auto-attendant", "menu option", "menu", "greeting",
      "press 0", "press 1", "press 2", "press 3", "press 4", "press 5", "press 6", "press 7", "press 8", "press 9",
      "option 0", "option 1", "option 2", "option 3", "option 4", "option 5", "option 6", "option 7", "option 8", "option 9",
      "inbound route", "call routing", "reroute", "re-route", "route my", "route the", "route our", "route calls",
      "point my number", "point the number", "point our number", "my number to", "number should go", "number should ring",
      "calls should go", "calls go to", "where does my number", "where do calls", "when people call", "when someone calls",
      "announcement",
    ],
  },
  { type: "moh", terms: ["hold music", "music on hold", "on-hold music", "waiting music", "האלט מוזיק"] },
  { type: "ivr_switch", terms: ["holiday menu", "switch ivr", "change the ivr", "change my menu", "holiday greeting", "night mode"] },
  { type: "vm_reset", terms: ["reset voicemail", "voicemail pin", "vm pin", "voicemail password"] },
];

// Legacy bare-number matcher — superseded by extractExtension() above, which
// refuses to read a duration as an extension. Kept only for reference.

/**
 * Extension extraction that refuses to read a DURATION as an extension.
 * "keep dnd on for 30 mins" filed objectId "30" on 2026-07-31 and died on the
 * scope fence — the bare-number regex above had matched the minutes. An
 * explicit "ext 101" always wins; a bare number is only accepted when it is
 * neither followed by a time unit ("30 mins", "5 pm", "9:30") nor introduced by
 * a duration preposition ("for 30", "in 15", "after 60").
 */
const EXT_EXPLICIT_RE = /\bext(?:ension)?\.?\s*(\d{2,5})\b/i;
const TIME_UNIT_AFTER_RE = /^\s*(?:mins?\b|minutes?\b|hrs?\b|hours?\b|secs?\b|seconds?\b|days?\b|weeks?\b|months?\b|[ap]\.?m\.?\b|:)/i;
const DURATION_BEFORE_RE = /\b(?:for|in|after|next|another|every|until|till)\s+$/i;

export function extractExtension(text: string): string | undefined {
  const explicit = text.match(EXT_EXPLICIT_RE);
  if (explicit) return explicit[1];
  for (const m of text.matchAll(/\b(\d{2,5})\b/g)) {
    const at = m.index ?? 0;
    const after = text.slice(at + m[0].length, at + m[0].length + 16);
    if (TIME_UNIT_AFTER_RE.test(after)) continue;
    const before = text.slice(Math.max(0, at - 12), at);
    if (DURATION_BEFORE_RE.test(before)) continue;
    return m[1];
  }
  return undefined;
}

/**
 * RELAY / MEMORY guard (trainer logs 2026-07-30 → 08-07).
 *
 * "please relay this SPECIFIC sentence: Teach me DND status", "Send this
 * exactly to them: …", "pass along: …" and "Remember "Status" has priority over
 * DND" all contain the word "dnd" — so every one of them EXECUTED a live DND
 * enable instead of being passed on or learned. A message that asks us to
 * carry, quote or memorise text is ABOUT that text — never a command to act on
 * it. These fall through to chat, where the LLM relays it or the trainer lesson
 * branch records it.
 */
const RELAY_META_RE = new RegExp(
  [
    String.raw`\bpass (?:this|that|it|the following)?\s*along\b`,
    String.raw`\bpass along\b`,
    String.raw`\bpass (?:this|that|it) (?:on |over )?to\b`,
    String.raw`\brelay (?:this|that|it|the following)\b`,
    String.raw`\bforward (?:this|that|it) (?:message |sentence |request )?to\b`,
    String.raw`\bsend (?:this|that|it) (?:exactly|verbatim|as[- ]is|message|sentence)\b`,
    String.raw`\bsend (?:this|that|it) (?:exactly )?to (?:the )?(?:admin|team|them|him|her)\b`,
    String.raw`\b(?:tell|ask|inform|notify) (?:the )?(?:admin|administrator|team|them)\b`,
    String.raw`\b(?:specific|exact) (?:sentence|message|words|wording)\b`,
    // memory / rule teaching — the trainer branch owns these, never an action
    String.raw`\b(?:remember|memori[sz]e|keep in mind|don'?t forget|note that|take note)\b`,
    String.raw`\badd (?:this|that|it) to (?:your |the )?memory\b`,
    String.raw`\bmake (?:this|that|it) a rule\b`,
    String.raw`\bteach (?:me|you|the assistant|yourself)\b`,
  ].join("|"),
  "i",
);

export function isRelayOrMemory(text: string): boolean {
  return RELAY_META_RE.test(text);
}

/**
 * DND STATUS question — answered read-only, NEVER executed.
 *
 * DND had no status detection at all (MOH has had one since July), so every
 * message containing "dnd" fell through to enableHint:"yes" and fired a live
 * write. Ezra asked "DND status?" 14 times across 9 days and got DND switched
 * ON 14 times; "DND status, do not disable or enable, just check status" on
 * 2026-08-07 enabled it too. Two layers:
 *   FORCE — the user explicitly says not to change it ("just check", "do not
 *           enable or disable"). Wins even though the words enable/disable
 *           appear in the sentence.
 *   ASK   — a status marker with no imperative verb ("dnd status", "is dnd on",
 *           "check dnd", "recent dnd changes").
 */
const DND_STATUS_FORCE_RE =
  /\bdo(?:n'?t| not)\s+(?:enable|disable|turn|change|set|activate|deactivate)\b|\b(?:just|only|simply)\s+(?:check|tell|show|report|read)\b|\bcheck (?:the )?status only\b/i;
const DND_STATUS_ASK_RE = new RegExp(
  [
    String.raw`\bstatus\b`,
    String.raw`\b(?:is|are)\s+(?:my\s+|the\s+)?(?:dnd|do not disturb)\b`,
    String.raw`\bis\b[^?]{0,30}\b(?:on|off|enabled|disabled|active)\b`,
    String.raw`\b(?:check|what'?s|what is|show|tell me)\b`,
    String.raw`\brecent\b[^?]{0,30}\bchanges?\b`,
    String.raw`\bcurrent(?:ly)?\b`,
  ].join("|"),
  "i",
);
/** An unmistakable command to CHANGE dnd — suppresses the ASK layer. */
const DND_IMPERATIVE_RE =
  /\b(?:enable|disable|turn|set|put|activate|deactivate|remove|cancel|keep|start|stop|silence)\b/i;

export function isDndStatusQuery(text: string): boolean {
  if (DND_STATUS_FORCE_RE.test(text)) return true;
  return DND_STATUS_ASK_RE.test(text) && !DND_IMPERATIVE_RE.test(text);
}

// DND direction: a DND request is "enable" unless the message clearly asks to
// clear it ("turn off dnd", "take me out of do not disturb", "cancel dnd"…).
// Conservative: only unmistakable disable words flip the direction.
const DND_DISABLE_RE = /\boff\b|\bdisable|\bremove\b|\bcancel|\bstop\b|\bdeactivat|\bun-?dnd\b|\bout of\b|\bresume\b|אויסשאַלט|נעם(?:ט)? אַראָפּ/i;

// MOH direction: "activate a profile" unless the message clearly asks to go
// back to the regular schedule ("turn off the holiday hold music", "back to
// the normal hold music", "change it back in 15 minutes", "revert").
export const MOH_DEACTIVATE_RE =
  /\boff\b|\bdisable|\bremove\b|\bcancel|\bdeactivat|\brevert\b|\bback to (?:the )?(?:schedule|normal|default|regular)\b|\bregular\b|\bnormal\b|\b(?:change|switch|put|set)\s+(?:it\s+|everything\s+|the\s+(?:hold\s+)?music\s+)?back\b/i;

// MOH status QUESTION ("which one am I on right now?", "what hold music is
// playing?") — answered read-only from the Connect mirror, never as a change.
// Question-word led so imperatives ("set the hold music to Main") never match.
export const MOH_STATUS_Q_RE = new RegExp(
  [
    String.raw`\b(?:which|what)\b[^?]{0,60}?\bam i on\b`,
    String.raw`\b(?:which|what)\b[^?]{0,60}?\bare we on\b`,
    String.raw`\b(?:which|what)\b[^?]{0,60}?\b(?:is|'s)\s+(?:it\s+|currently\s+)?playing\b`,
    String.raw`\b(?:which|what)\b[^?]{0,60}?\bplaying\s+(?:right\s+)?now\b`,
    String.raw`\b(?:which|what)\b[^?]{0,60}?\bcurrently\b`,
    String.raw`\bwhat(?:'s| is)\s+(?:the|our|my)\s+(?:current\s+)?hold[- ]?music\b`,
    String.raw`\bcurrent hold[- ]?music\b`,
    // Yiddish: "וועלכע מוזיק שפילט יעצט" (which music is playing now)
    String.raw`וועלכע[^?]{0,40}שפילט`,
  ].join("|"),
  "i",
);

export function detectIntent(text: string): Intent {
  const t = text.toLowerCase();

  // A relay ("pass this along"), a quote ("send this exactly to them") or a
  // memory instruction ("remember …") is ABOUT its text, never a command to
  // execute it. Checked before every action pattern — this is what turned
  // "relay this sentence: Teach me DND status" into a live DND write.
  if (isRelayOrMemory(text)) return { kind: "chat", raw: text };

  // Action first (more specific), then diagnostic.
  for (const p of ACTION_PATTERNS) {
    if (p.terms.some((term) => t.includes(term))) {
      const ext = extractExtension(text);
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
        statusQuery:
          p.type === "moh"
            ? MOH_STATUS_Q_RE.test(t)
            : p.type === "dnd"
              ? isDndStatusQuery(text)
              : undefined,
        raw: text,
      };
    }
  }

  // Loose PBX config (M3): a routing verb aimed at a bare number/extension —
  // "route 845 251 0249 to extension 101", "point 8455577768 to the queue".
  // The term list above only catches possessive phrasings ("route my number");
  // real client phrasing 2026-07-28 used the bare DID. Texting verbs excluded
  // so "send a message to 845..." never lands here.
  const loosePbxRoute =
    /\b(?:route|re-?route|point|redirect)\b[^.?!\n]{0,80}\bto\b/i.test(t) &&
    /\d{3,}/.test(t) &&
    !/\b(?:text|sms|message|fax|email)\b/i.test(t);
  if (loosePbxRoute) {
    return { kind: "action", actionType: "pbx_config", extensionHint: extractExtension(text), raw: text };
  }

  // Loose MOH: a change-verb near "music" without the word "hold" ("change my
  // music from classic to main" — real client phrasing 2026-07-27), or a
  // status question mentioning music ("what music is playing right now?").
  const looseMohChange = /\b(?:change|switch|set|put|play|update)\b[^.?!\n]{0,40}?\bmusic\b/i.test(t);
  const looseMohStatus = MOH_STATUS_Q_RE.test(t) && /\bmusic\b/i.test(t);
  if (looseMohChange || looseMohStatus) {
    return {
      kind: "action",
      actionType: "moh",
      extensionHint: extractExtension(text),
      enableHint: MOH_DEACTIVATE_RE.test(t) ? "no" : "yes",
      statusQuery: looseMohStatus,
      raw: text,
    };
  }

  if (DIAG_TERMS.some((term) => t.includes(term))) {
    return { kind: "diagnostic", extensionHint: extractExtension(text), complaint: text };
  }

  // raw is carried so the triage layer can resume a pending clarification
  // (e.g. the bare profile name answering "Which hold music would you like?").
  return { kind: "chat", raw: text };
}
