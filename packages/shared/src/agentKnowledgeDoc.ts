/**
 * Agent knowledge documents — the parsing and safety rules, in ONE place.
 *
 * The assistant reads two standing documents before it answers: the platform's
 * `system.md` and the ONE file belonging to the company the person is from.
 * Splitting per tenant is the whole point — a conversation never loads another
 * company's knowledge, so the corpus can grow to hundreds of companies without
 * growing any single prompt.
 *
 * ⛔ TWO AUDIENCES, ONE FILE. Everything outside `<!-- internal -->` markers is
 * customer-safe and may be spoken to the customer. Everything inside is
 * staff-only (other companies' names, credentials paths, PBX internals, money)
 * and reaches ONLY the escalation researcher, which writes for the owner. This
 * split is enforced here and nowhere else — if a caller wants the internal
 * half it must ask for audience "internal" explicitly, so the default is safe.
 *
 * ⛔ These files are NOT the `docs/ai-context/` handoffs. Those are written for
 * Claude sessions, are full of other tenants' failures, and must never be fed
 * to a customer-facing model. Knowledge for the assistant is written on
 * purpose, per company, in `docs/agent-knowledge/`.
 */

export type KnowledgeAudience = "customer" | "internal";

export interface ParsedKnowledgeDoc {
  /** From front matter: which company this belongs to. Absent on the system doc. */
  tenantId: string | null;
  /** From front matter: the company name, for humans and for a fallback match. */
  tenantName: string | null;
  scope: "system" | "tenant";
  title: string;
  /** Customer-safe markdown (internal sections removed). */
  body: string;
  /** Staff-only markdown (the internal sections, joined). Empty string when none. */
  internalBody: string;
  /** Problems that must stop this file being published. */
  errors: string[];
}

const INTERNAL_BLOCK = /<!--\s*internal\s*-->([\s\S]*?)<!--\s*\/internal\s*-->/gi;
/** An opened internal section that is never closed — fail closed, see below. */
const INTERNAL_OPEN = /<!--\s*internal\s*-->/i;

/**
 * Split `---` front matter off the top. Deliberately tiny: `key: value` lines
 * only, no nesting, no YAML dependency. Anything fancier belongs in the body.
 */
export function parseFrontMatter(text: string): { meta: Record<string, string>; rest: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, rest: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, rest: text.slice(m[0].length) };
}

/**
 * Parse one knowledge file. Never throws — a broken file reports `errors` and
 * the sync refuses to publish it, because publishing half a file could publish
 * the staff-only half.
 */
export function parseKnowledgeDoc(input: { text: string; slug: string; sourcePath?: string }): ParsedKnowledgeDoc {
  const errors: string[] = [];
  const { meta, rest } = parseFrontMatter(input.text);

  const scope: "system" | "tenant" = (meta.scope === "system" || input.slug === "system") ? "system" : "tenant";
  const tenantId = meta.tenantid?.trim() || null;
  const tenantName = meta.tenant || meta.name || null;

  if (scope === "tenant" && !tenantId && !tenantName) {
    errors.push("a tenant document must name its company: add `tenantId:` (preferred) or `tenant:` to the front matter");
  }
  if (scope === "system" && tenantId) {
    errors.push("the system document must not carry a tenantId");
  }

  // ⛔ Fail closed on a malformed internal section. An unterminated
  // `<!-- internal -->` would otherwise leave staff-only text in the
  // customer-safe body, which is the one mistake this file exists to prevent.
  const closers = (rest.match(/<!--\s*\/internal\s*-->/gi) ?? []).length;
  const openers = (rest.match(/<!--\s*internal\s*-->/gi) ?? []).length;
  if (openers !== closers) {
    errors.push(`unbalanced internal markers (${openers} opened, ${closers} closed) — every <!-- internal --> needs a <!-- /internal -->`);
  }

  const internalParts: string[] = [];
  let body = rest.replace(INTERNAL_BLOCK, (_all, inner: string) => {
    internalParts.push(String(inner).trim());
    return "";
  });
  // Belt and braces: if anything that opens an internal section survived the
  // replace (unbalanced file), drop everything from that marker onward.
  const stray = INTERNAL_OPEN.exec(body);
  if (stray) {
    internalParts.push(body.slice(stray.index).replace(INTERNAL_OPEN, "").trim());
    body = body.slice(0, stray.index);
  }

  body = body.replace(/\n{3,}/g, "\n\n").trim();
  const title = meta.title?.trim() || firstHeading(body) || (scope === "system" ? "Connect platform" : tenantName || input.slug);

  if (!body && scope === "tenant") errors.push("the customer-safe part of the document is empty");

  return {
    tenantId,
    tenantName,
    scope,
    title,
    body,
    internalBody: internalParts.filter(Boolean).join("\n\n"),
    errors,
  };
}

function firstHeading(body: string): string | null {
  const m = /^#{1,3}\s+(.+)$/m.exec(body);
  return m ? m[1].trim() : null;
}

/**
 * Trim a document to a character budget on a SECTION boundary, so the model
 * never reads half a sentence and never sees a heading whose content was cut
 * away. Sections are `##`-level; anything before the first heading is kept.
 */
export function capKnowledgeText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const t = text.trim();
  if (t.length <= maxChars) return { text: t, truncated: false };
  const sections = t.split(/\n(?=#{1,3}\s)/);
  let out = "";
  for (const s of sections) {
    if (out.length + s.length + 1 > maxChars) break;
    out += (out ? "\n" : "") + s;
  }
  // A single section larger than the whole budget: hard-cut it rather than
  // return nothing, but on a line boundary.
  if (!out) {
    out = t.slice(0, maxChars);
    out = out.slice(0, Math.max(out.lastIndexOf("\n"), 0) || out.length);
  }
  return { text: out.trim(), truncated: true };
}

export interface KnowledgeBlockInput {
  system?: { title: string; body: string; internalBody?: string | null } | null;
  tenant?: { title: string; body: string; internalBody?: string | null } | null;
  audience: KnowledgeAudience;
  /** Character budget per document. Two documents, so the prompt cost is 2×. */
  maxCharsPerDoc?: number;
  /** The company name, so the block can say whose knowledge this is. */
  tenantName?: string | null;
}

export const DEFAULT_KNOWLEDGE_CHARS_PER_DOC = 12000;

/**
 * Render the system prompt block the engine injects. Returns null when there is
 * nothing to say — an agent with no knowledge documents must behave exactly as
 * it did before this feature existed.
 */
export function renderKnowledgeBlock(input: KnowledgeBlockInput): string | null {
  const budget = input.maxCharsPerDoc ?? DEFAULT_KNOWLEDGE_CHARS_PER_DOC;
  const parts: string[] = [];

  const take = (doc: { title: string; body: string; internalBody?: string | null } | null | undefined, heading: string) => {
    if (!doc) return;
    let text = doc.body ?? "";
    if (input.audience === "internal" && doc.internalBody) {
      text = `${text}\n\n## Staff-only notes\n${doc.internalBody}`;
    }
    const capped = capKnowledgeText(text, budget);
    if (!capped.text) return;
    parts.push(`### ${heading}: ${doc.title}\n${capped.text}${capped.truncated ? "\n\n(…this document is longer; ask for specifics if you need more.)" : ""}`);
  };

  take(input.system, "Connect platform");
  take(input.tenant, input.tenantName ? `This customer — ${input.tenantName}` : "This customer");

  if (parts.length === 0) return null;

  const rules =
    input.audience === "internal"
      ? "STANDING KNOWLEDGE — everything below is verified fact about the platform and about THIS customer's account, including staff-only notes. Use it to research and to propose an exact fix."
      : [
          "STANDING KNOWLEDGE — verified facts about the platform and about THIS customer's account.",
          "Use it to answer directly instead of guessing or passing the question on.",
          "It describes THIS customer only; never mention another company.",
          "If it contradicts something you inferred, the knowledge wins.",
          "If it does not cover the question, say what you do know and hand it to the team — never invent a detail to fill the gap.",
        ].join(" ");

  return `${rules}\n\n${parts.join("\n\n")}`;
}
