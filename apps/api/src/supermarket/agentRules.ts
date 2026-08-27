/**
 * House rules for the order brain (Izzy, 2026-08-27, dictating the first
 * three from real mistakes on the Gesheft training drafts: "a dozen eggs
 * means a pack of 12 large eggs… blue milk means Golden Flow 2% milk, red
 * milk means whole… if they just say milk, that means Golden Flow…
 * Balabusta with an A or an E is the same thing").
 *
 * A rule is ONE plain-English sentence the store owner writes. Rules are
 * injected VERBATIM into BOTH brain passes:
 *  - EXTRACT sees them so it can normalize spellings ("Balabusta" → the
 *    catalog's real brand wording) and expand conventions ("two dozen eggs"
 *    = qty 2 of the 12-pack) — the phrase it emits is what the candidate
 *    search runs on, so a spelling rule is what makes the right products
 *    reach the pool at all.
 *  - RESOLVE sees them so it can pick correctly among candidates ("no brand
 *    named means Golden Flow", "pick the cheapest in-stock dozen").
 *
 * ⛔ Rules are read fresh on every brain run — a correction takes effect on
 * the very next draft, no deploy, no cache. That immediacy is the feature
 * (Izzy: "every time I correct something, it should update the agent right
 * away").
 *
 * ⛔ Editing NEVER discards a wording: the prior text goes into `history`,
 * and rollback pops it back (re-filing the wording it replaced, so rollback
 * of a rollback works too). "If I make a mistake and I re-correct that same
 * correction… I should be able to roll back."
 */

export const MAX_RULES = 40;
export const MAX_RULE_CHARS = 300;
export const MAX_RULES_BLOCK_CHARS = 4000;
export const MAX_RULE_HISTORY = 20;

/**
 * The prompt block appended to both system prompts. Bounded three ways
 * (count, per-rule length, total) so a runaway rule list can never blow the
 * prompt budget. Empty input → empty string (the prompts stay byte-identical
 * to a tenant with no rules).
 */
export function rulesPromptBlock(rules: string[]): string {
  const cleaned = rules
    .map((r) => String(r ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_RULE_CHARS))
    .filter(Boolean)
    .slice(0, MAX_RULES);
  if (cleaned.length === 0) return "";
  let block = "\nSTORE RULES — written by the store owner; they override general assumptions:";
  for (const r of cleaned) {
    const line = `\n- ${r}`;
    if (block.length + line.length > MAX_RULES_BLOCK_CHARS) break;
    block += line;
  }
  return block;
}

/** Active rules, oldest first (the order the owner built them up in). */
export async function loadActiveRules(db: any, tenantId: string): Promise<string[]> {
  try {
    const rows = await db.supermarketAgentRule.findMany({
      where: { tenantId, active: true },
      orderBy: { createdAt: "asc" },
      take: MAX_RULES + 10,
      select: { text: true },
    });
    return (Array.isArray(rows) ? rows : []).map((r: any) => String(r.text ?? "")).filter(Boolean);
  } catch {
    // rules are an upgrade, never a gate — a missing table costs the rules,
    // never the draft
    return [];
  }
}

export type RuleHistoryEntry = { text: string; at: string };

function readHistory(v: unknown): RuleHistoryEntry[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((h: any) => ({ text: String(h?.text ?? ""), at: String(h?.at ?? "") }))
    .filter((h) => h.text.length > 0);
}

/**
 * Pure edit: the current wording is pushed onto history (newest first),
 * capped, and the new text becomes current. Returns null when the text is
 * unusable or unchanged.
 */
export function applyRuleEdit(
  rule: { text: string; history: unknown },
  newText: string,
  now: () => Date = () => new Date(),
): { text: string; history: RuleHistoryEntry[] } | null {
  const text = String(newText ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_RULE_CHARS);
  if (!text || text === rule.text) return null;
  const history = [{ text: rule.text, at: now().toISOString() }, ...readHistory(rule.history)].slice(0, MAX_RULE_HISTORY);
  return { text, history };
}

/**
 * Pure rollback: restore the newest history entry as the current wording.
 * The wording being rolled AWAY is itself filed into history, so a rollback
 * is reversible the same way an edit is. Null when there is nothing to
 * restore.
 */
export function rollbackRule(
  rule: { text: string; history: unknown },
  now: () => Date = () => new Date(),
): { text: string; history: RuleHistoryEntry[] } | null {
  const history = readHistory(rule.history);
  const restored = history[0];
  if (!restored) return null;
  const rest = history.slice(1);
  return { text: restored.text, history: [{ text: rule.text, at: now().toISOString() }, ...rest].slice(0, MAX_RULE_HISTORY) };
}
