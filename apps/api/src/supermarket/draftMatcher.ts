/**
 * Draft-order matcher — turns what a customer SAID (a Yiddish voicemail
 * transcript, a text message) into a pre-filled draft against the synced
 * register catalog. Supermarket plan Phase 3.
 *
 * Honesty first: this is the CONSERVATIVE v1. It matches register item
 * numbers (digits read the same in every script) and exact-word product
 * names, and it deliberately refuses fuzzy guesses — a wrong item silently
 * added is worse than a line left for the rep, because every draft passes a
 * rep during the trial month and every correction is captured as training
 * data (that gauge is what earns auto-submit in Phase 7).
 *
 * Izzy's routing rule, verbatim from the intake: a WIC mention goes
 * AUTOMATICALLY into the order's COMMENTS; every other remark goes into the
 * order's NOTES.
 *
 * Pure module — no imports, no IO; the stress suite drives it with hostile
 * and randomized text.
 */

export type CatalogEntry = {
  posProductId: string;
  code: string;
  name: string;
  unitPriceCents: number;
};

export type DraftItem = {
  posProductId: string;
  code: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  /** "code" (item number keyed/said) or "name" (product name matched). */
  matchedFrom: "code" | "name";
};

export type DraftMatch = {
  items: DraftItem[];
  wicMentioned: boolean;
  /** Non-item remarks, bounded, for the order's NOTES field. */
  notes: string[];
};

const MAX_TEXT_CHARS = 8_000;
const MAX_ITEMS = 60;
const MAX_NOTES = 12;
const MAX_NOTE_CHARS = 240;
const MAX_QTY = 99;

/** Yiddish number words 1–12 (common order-taking range). */
const YIDDISH_NUMBERS: Record<string, number> = {
  "איין": 1, "איינס": 1, "א": 1,
  "צוויי": 2, "דריי": 3, "פיר": 4, "פינף": 5, "פינעף": 5,
  "זעקס": 6, "זיבן": 7, "אכט": 8, "ניין": 9, "צען": 10,
  "עלף": 11, "צוועלף": 12,
};

const ENGLISH_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  dozen: 12, "a": 1, "an": 1,
};

export function detectWic(text: string): boolean {
  const t = String(text ?? "");
  if (/\bw\.?i\.?c\.?\b/i.test(t)) return true;
  // Yiddish spellings heard in Gesheft's own voicemails: וויק / וו.י.ק
  if (/וויק|וו\.י\.ק/.test(t)) return true;
  return false;
}

function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9֐-׿]/g, "");
}

function wordNumber(token: string): number | null {
  const n = ENGLISH_NUMBERS[token] ?? YIDDISH_NUMBERS[token];
  return typeof n === "number" ? n : null;
}

export type CatalogIndex = {
  byCode: Map<string, CatalogEntry>;
  /** Single- and two-word names, key = normalized joined tokens. */
  byName: Map<string, CatalogEntry>;
  maxNameTokens: number;
};

export function buildCatalogIndex(entries: CatalogEntry[]): CatalogIndex {
  const byCode = new Map<string, CatalogEntry>();
  const byName = new Map<string, CatalogEntry>();
  let maxNameTokens = 1;
  for (const entry of entries) {
    const code = String(entry.code ?? "").trim();
    if (code && /^\d{2,8}$/.test(code) && !byCode.has(code)) byCode.set(code, entry);
    const tokens = String(entry.name ?? "")
      .split(/\s+/)
      .map(normalizeToken)
      .filter((t) => t.length >= 2);
    if (tokens.length >= 1 && tokens.length <= 3) {
      const key = tokens.join(" ");
      // First entry wins; an ambiguous name (two products, one name) is
      // dropped from name-matching entirely — ambiguity must reach the rep.
      if (byName.has(key)) {
        const existing = byName.get(key)!;
        if (existing.posProductId !== entry.posProductId) byName.set(key, { ...existing, posProductId: "" });
      } else {
        byName.set(key, entry);
      }
      if (tokens.length > maxNameTokens) maxNameTokens = tokens.length;
    }
  }
  return { byCode, byName, maxNameTokens };
}

function pushItem(items: DraftItem[], entry: CatalogEntry, qty: number, matchedFrom: "code" | "name") {
  const bounded = Math.max(1, Math.min(MAX_QTY, Math.floor(qty)));
  // ⛔ Merge on the PRODUCT alone — "2 milk" and "104 x3" are the same item,
  // and two line rows for one product would reach the register as a duplicate.
  const existing = items.find((i) => i.posProductId === entry.posProductId);
  if (existing) {
    existing.qty = Math.min(MAX_QTY, existing.qty + bounded);
    return;
  }
  if (items.length >= MAX_ITEMS) return;
  items.push({
    posProductId: entry.posProductId,
    code: entry.code,
    name: entry.name,
    qty: bounded,
    unitPriceCents: entry.unitPriceCents,
    matchedFrom,
  });
}

/**
 * Match one free-text message against the catalog.
 * Quantities: a number (digits or word, English or Yiddish) directly BEFORE
 * the match, or an `xN`/`×N` directly after. Absent → 1.
 */
export function matchDraftText(text: string, index: CatalogIndex): DraftMatch {
  const bounded = String(text ?? "").slice(0, MAX_TEXT_CHARS);
  const wicMentioned = detectWic(bounded);
  const items: DraftItem[] = [];
  const lines = bounded.split(/[\n.!?;]+/);
  const notes: string[] = [];

  for (const line of lines) {
    const rawTokens = line.split(/\s+/).filter(Boolean);
    const tokens = rawTokens.map(normalizeToken);
    let lineMatched = false;
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      if (!token) {
        i++;
        continue;
      }
      // Quantity looking ahead: "<qty> <thing>"
      const qtyBefore = /^\d{1,2}$/.test(token) ? Number(token) : wordNumber(token);

      // 1) item number: 2–8 digits that exist in the catalog.
      if (/^\d{2,8}$/.test(token) && index.byCode.has(token)) {
        const entry = index.byCode.get(token)!;
        let qty = 1;
        const next = tokens[i + 1] ?? "";
        const mult = next.match(/^x(\d{1,2})$/);
        if (mult) qty = Number(mult[1]);
        pushItem(items, entry, qty, "code");
        lineMatched = true;
        i += mult ? 2 : 1;
        continue;
      }

      // 2) product name: try longest window first.
      let nameHit = false;
      for (let span = Math.min(index.maxNameTokens, 3); span >= 1; span--) {
        const window = tokens.slice(i, i + span).filter(Boolean);
        if (window.length !== span) continue;
        const key = window.join(" ");
        const entry = index.byName.get(key);
        if (entry && entry.posProductId) {
          let qty = qtyBefore && i > 0 ? 0 : 1; // qtyBefore consumed below
          // "2 milk" — the quantity token precedes the match window start.
          const prev = tokens[i - 1] ?? "";
          const prevQty = /^\d{1,2}$/.test(prev) ? Number(prev) : wordNumber(prev);
          if (prevQty) qty = prevQty;
          const after = tokens[i + span] ?? "";
          const mult = after.match(/^x(\d{1,2})$/);
          if (mult) qty = Number(mult[1]);
          pushItem(items, entry, qty || 1, "name");
          lineMatched = true;
          i += span + (mult ? 1 : 0);
          nameHit = true;
          break;
        }
      }
      if (nameHit) continue;
      i++;
    }
    // Non-item remark → notes (skip empty and pure-WIC lines; WIC has its own home).
    const trimmed = line.trim();
    if (!lineMatched && trimmed.length >= 3 && notes.length < MAX_NOTES) {
      const isOnlyWic = detectWic(trimmed) && normalizeToken(trimmed).length <= 8;
      if (!isOnlyWic) notes.push(trimmed.slice(0, MAX_NOTE_CHARS));
    }
  }

  return { items, wicMentioned, notes };
}

/** The standard comment Izzy's rule writes when WIC is mentioned. */
export const WIC_COMMENT = "Customer says they are paying with WIC.";

/**
 * Correction capture (the Phase 3/7 training signal): diff the agent's frozen
 * guess against what the rep approved. Pure; stored on the draft at approval.
 */
export function computeCorrections(
  agentItems: Array<{ posProductId: string; qty: number }>,
  approvedItems: Array<{ posProductId: string; qty: number }>,
): { added: number; removed: number; qtyChanged: number; unchanged: number; correctionRatePct: number } {
  const agent = new Map(agentItems.map((i) => [i.posProductId, i.qty]));
  const approved = new Map(approvedItems.map((i) => [i.posProductId, i.qty]));
  let added = 0;
  let removed = 0;
  let qtyChanged = 0;
  let unchanged = 0;
  for (const [id, qty] of approved) {
    if (!agent.has(id)) added++;
    else if (agent.get(id) !== qty) qtyChanged++;
    else unchanged++;
  }
  for (const id of agent.keys()) {
    if (!approved.has(id)) removed++;
  }
  const total = added + removed + qtyChanged + unchanged;
  const correctionRatePct = total === 0 ? 0 : Math.round(((added + removed + qtyChanged) / total) * 1000) / 10;
  return { added, removed, qtyChanged, unchanged, correctionRatePct };
}
