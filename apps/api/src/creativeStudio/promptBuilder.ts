/**
 * Creative Studio — turning what a person asked for into what an engine is
 * sent. Pure functions: data in, strings out, no database and no network, so
 * every rule here is unit-testable.
 *
 * Three things go in besides the request:
 *   1. the company's brand kit (colours, fonts, voice, prohibitions),
 *   2. what the studio has learned about this person and this company,
 *   3. the safety rules, which are not negotiable by any of the above.
 */

export interface BrandKitInput {
  name?: string;
  colors?: Array<{ label: string; value: string }>;
  fonts?: Array<{ label: string; value: string }>;
  voice?: string;
  prohibitions?: string[];
  claims?: string[];
}

export interface MemoryClause {
  dimension: string;
  statement: string;
  value: unknown;
  confidence: number;
  status: string;
}

export interface BuildInput {
  request: string;
  kind?: "image" | "video";
  brandKit?: BrandKitInput | null;
  memory?: MemoryClause[];
  styleHint?: string;
  negativeExtra?: string;
  /** Set when a reference image carries the look, so we don't fight it. */
  hasReferences?: boolean;
}

export interface BuiltPrompt {
  prompt: string;
  negative: string;
  applied: string[];
}

/* ------------------------------------------------------------------ */
/* safety                                                              */
/* ------------------------------------------------------------------ */

/**
 * Other companies' marks, and real people. Refusing these protects the
 * customer: a generated Coca-Cola logo or a recognisable celebrity in their ad
 * is their legal problem, not the model's.
 *
 * ⛔ This list is deliberately small and about SHAPES of request, not a
 * blocklist of names — the check is "are you asking for someone else's brand
 * or a named real person", which a phrase test catches better than a
 * dictionary. Their OWN brand always passes, because it comes from the kit.
 */
const TRADEMARK_HINTS = [
  /\b(coca[- ]?cola|pepsi|nike|adidas|apple|google|microsoft|amazon|disney|marvel|starbucks|mcdonald'?s|ferrari|rolex|louis vuitton|gucci|chanel|yealink|grandstream|cisco|polycom|avaya|ringcentral|vonage|8x8)\b/i,
  /\blogo of (?!our|my|the company|us\b)/i,
  /\b(trademark|branded as|in the style of the .* brand)\b/i,
];

const REAL_PERSON_HINTS = [
  /\b(elon musk|donald trump|joe biden|taylor swift|beyonce|cristiano ronaldo|lionel messi|oprah|kim kardashian|barack obama|the president|the king of|the pope)\b/i,
  /\b(celebrity|famous actor|famous actress|public figure) (called|named)\b/i,
  /\bdeep ?fake\b/i,
];

const UNSAFE_HINTS = [
  /\b(nude|naked|nsfw|porn|sexual)\b/i,
  /\b(gore|beheading|mutilat)/i,
  /\b(how to (make|build) (a )?(bomb|weapon))\b/i,
];

export type SafetyVerdict = { ok: true } | { ok: false; reason: string; kind: "trademark" | "person" | "unsafe" };

export function checkRequestSafety(request: string): SafetyVerdict {
  const text = String(request || "");
  for (const re of UNSAFE_HINTS) {
    if (re.test(text)) {
      return { ok: false, kind: "unsafe", reason: "That is not something Loopcom will make. Try describing the advert or picture you want instead." };
    }
  }
  for (const re of TRADEMARK_HINTS) {
    if (re.test(text)) {
      return {
        ok: false,
        kind: "trademark",
        reason:
          "That asks for another company's brand or logo, which you would not be allowed to use in your own advertising. I can make the same picture with your own branding, or with a plain unbranded product.",
      };
    }
  }
  for (const re of REAL_PERSON_HINTS) {
    if (re.test(text)) {
      return {
        ok: false,
        kind: "person",
        reason:
          "That asks for a real, identifiable person, which needs their permission. I can use one of your own approved people from the asset library, or an invented person who is nobody in particular.",
      };
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* learned preferences                                                 */
/* ------------------------------------------------------------------ */

/** How a learned preference is written into a prompt. */
const DIMENSION_CLAUSE: Record<string, (v: any) => string> = {
  style: (v) => `Overall look: ${v}.`,
  camera_movement: (v) => `Camera: ${v}.`,
  pacing: (v) => `Pacing: ${v}.`,
  people: (v) => `People: ${v}.`,
  typography: (v) => `Typography: ${v}.`,
  transitions: (v) => `Transitions: ${v}.`,
  color: (v) => `Colour treatment: ${v}.`,
  composition: (v) => `Composition: ${v}.`,
  logo: (v) => `Logo: ${v}.`,
  mood: (v) => `Mood: ${v}.`,
};

export function memoryClauses(memory: MemoryClause[] | undefined): { clauses: string[]; applied: string[] } {
  const clauses: string[] = [];
  const applied: string[] = [];
  for (const m of memory || []) {
    if (m.status === "disabled" || m.status === "suggested") continue;
    const fn = DIMENSION_CLAUSE[m.dimension];
    const value = typeof m.value === "string" ? m.value : (m.value as any)?.text;
    if (!fn || !value) continue;
    clauses.push(fn(value));
    applied.push(m.statement);
    if (clauses.length >= 8) break;
  }
  return { clauses, applied };
}

/* ------------------------------------------------------------------ */
/* the builder                                                         */
/* ------------------------------------------------------------------ */

const BASE_NEGATIVE_IMAGE = "warped hands, extra fingers, distorted faces, garbled text, watermarks, other companies' logos or trademarks";
const BASE_NEGATIVE_VIDEO = "warped hands, extra fingers, flickering between frames, morphing objects, garbled on-screen text, watermarks, other companies' logos or trademarks";

export function buildPrompt(input: BuildInput): BuiltPrompt {
  const kind = input.kind || "image";
  const parts: string[] = [];
  const applied: string[] = [];

  parts.push(String(input.request || "").trim());

  const kit = input.brandKit;
  if (kit) {
    const colors = (kit.colors || []).slice(0, 4).map((c) => `${c.label} ${c.value}`).join(", ");
    if (colors) {
      parts.push(`Brand colours: ${colors}.`);
      applied.push(`${kit.name || "Brand"} colours`);
    }
    if (kit.voice) {
      parts.push(`Brand feeling: ${kit.voice}`);
      applied.push("brand voice");
    }
    const no = (kit.prohibitions || []).slice(0, 6);
    if (no.length) applied.push("brand prohibitions");
  }

  if (input.styleHint) parts.push(`Style: ${input.styleHint}.`);

  const mem = memoryClauses(input.memory);
  parts.push(...mem.clauses);
  applied.push(...mem.applied);

  if (input.hasReferences) {
    parts.push("Keep the supplied reference image's subject consistent: same person, same product, same proportions.");
  }

  // House rules, last so they are not talked over by anything above.
  parts.push("Do not include any logo, brand name, or readable trademark other than one supplied as a reference image.");
  if (kind === "video") parts.push("No on-screen text unless it is explicitly asked for.");

  const negativeBits = [kind === "video" ? BASE_NEGATIVE_VIDEO : BASE_NEGATIVE_IMAGE];
  if (kit?.prohibitions?.length) negativeBits.push(kit.prohibitions.slice(0, 6).join(", "));
  if (input.negativeExtra) negativeBits.push(input.negativeExtra);

  return {
    prompt: parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 4000),
    negative: negativeBits.join(", ").slice(0, 600),
    applied,
  };
}

/**
 * The short, human sentence shown in the chat and the activity list. Never the
 * built prompt — nobody should have to read that to know what happened.
 */
export function describeRequest(kind: string, request: string): string {
  const trimmed = String(request || "").replace(/\s+/g, " ").trim();
  const short = trimmed.length > 70 ? `${trimmed.slice(0, 67)}…` : trimmed;
  if (kind.startsWith("video")) return `Rendering “${short}”`;
  if (kind.startsWith("image")) return `Making “${short}”`;
  if (kind.startsWith("audio.speech")) return "Recording the voiceover";
  if (kind.startsWith("audio.music")) return "Writing a music bed";
  return short;
}
