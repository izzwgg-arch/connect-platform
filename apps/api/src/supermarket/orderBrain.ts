/**
 * The order brain (Izzy, 2026-08-26): "the OpenAI agent needs to actually
 * fill in the draft and search... it needs intelligence behind it" — his
 * example: a shopper says "corn cakes, but I don't want this brand", and the
 * AI must pick corn cakes FROM A DIFFERENT BRAND, or hand the line to the rep
 * when it can't honour the instruction.
 *
 * Shape: two bounded OpenAI calls, no tool loop (the recorded trap: gpt-5
 * tools ride /v1/responses; plain JSON chat.completions is fine).
 *   1. EXTRACT — the (English) order text → shopping lines with quantities and
 *      CONSTRAINTS (brand exclusions/preferences, size wishes), plus WIC and
 *      free-text remarks.
 *   2. RESOLVE — per line the server searches the tenant's OWN catalog (name
 *      tokens, brand and size included) and the model picks the candidate that
 *      honours the constraints — or refuses the line into notes.
 *
 * ⛔ Money/catalog rules (the sibling voice-agent's rule too):
 *  - the model NEVER supplies a price or a product id of its own — every
 *    picked id is validated against the server-fetched candidate set, and
 *    price/name/code come from OUR catalog row. A hallucinated id is dropped
 *    to notes.
 *  - the OpenAI key is the TENANT'S OWN (ProviderCredential / OPENAI) — no
 *    platform fallback, ever.
 *  - any failure returns null and the caller falls back to the regex matcher:
 *    intelligence is an upgrade, never a gate on drafts existing.
 */

import { resolveIntegrationKey } from "./integrationCredentials";
import { posPhoneDigits } from "./posWithLogic";
import { detectWic, WIC_COMMENT, type DraftItem } from "./draftMatcher";
import { loadLessons, matchLessonsToLines } from "./phraseLessons";
import { loadActiveRules, rulesPromptBlock } from "./agentRules";
import { catalogCodePrefix, isKnownOutOfStock, rankCatalogRows, searchCatalogPool } from "./catalogSearch";

const OPENAI_BASE = "https://api.openai.com/v1";
const BRAIN_TIMEOUT_MS = 90_000;
export const DEFAULT_BRAIN_MODEL = "gpt-5";
export const MAX_BRAIN_LINES = 40;
const CANDIDATES_PER_LINE = 8;

export type BrainResult = {
  items: DraftItem[];
  comments: string[];
  notes: string[];
  model: string;
  /** Set when the message is NOT an order (a complaint, a question, chatter). */
  notAnOrder?: { reason: string };
  /** The account phone the customer STATED (10 digits, 845-defaulted), if any. */
  customerPhone?: string;
  /**
   * The extracted line list with per-line outcome — the desk's "what they
   * asked for" checklist (Izzy: "each item should be checked if it's in the
   * cart or not... next to it should be a reason why it's not").
   */
  lines?: BrainLine[];
};

export type BrainLine = {
  phrase: string;
  qty: number;
  constraints?: string;
  outcome: "in_cart" | "unsure" | "skipped";
  /** Set for in_cart/unsure — the product that landed on the order. */
  posProductId?: string;
  name?: string;
  /** Set for skipped — the brain's own reason, plain English. */
  reason?: string;
  /** Skipped lines carry the top catalog alternatives for one-click add. */
  suggestions?: Array<{ posProductId: string; code: string; name: string; unitPriceCents: number }>;
};

type ExtractedLine = { phrase: string; qty: number; constraints: string };

async function openaiJson(apiKey: string, model: string, system: string, user: string, maxTokens: number): Promise<any | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), BRAIN_TIMEOUT_MS);
  try {
    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        // ⛔ gpt-5 family: max_completion_tokens (thinking shares the budget —
        // never shrink this to save money, it truncates after paying to think).
        max_completion_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const text = j?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) return null;
    return JSON.parse(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const EXTRACT_SYSTEM = `You read a customer message to a kosher supermarket in Kiryas Joel (voicemail transcript or text message, already in English).
FIRST decide: is this actually a NEW grocery order — a request for the store to supply items? A complaint about a past delivery ("you sent me X instead of Y"), a thank-you, a question, delivery/payment chatter, or a confirmation is NOT an order. For a non-order output STRICT JSON: {"isOrder":false,"reason":"<one short sentence for the store rep, plain English>"} and nothing else.
For a real order output STRICT JSON:
{"isOrder":true,"customerPhone":"<the phone number the customer states for their account, digits only, or empty>","lines":[{"phrase":"<the item as asked for, normalized English>","qty":<integer 1-99>,"constraints":"<brand/size/substitution instructions for THIS item, or empty>"}],"remarks":["<anything that is not an item: delivery instructions, payment remarks, greetings worth keeping>"]}
Customers identify their account by SPEAKING their phone number — always capture it when stated; seven digits is normal (the area code is implied).
Rules: one line per distinct item; quantities default 1; keep item numbers/codes the customer spoke as the phrase; put "not brand X" / "only brand Y" / "the small one" style instructions into that line's constraints verbatim; do NOT invent items; at most ${MAX_BRAIN_LINES} lines.`;

const RESOLVE_SYSTEM = `You fill a kosher-supermarket order from the store's own catalog. For each requested line you get the store's candidate products (id, name, brand, size, price). You may also get customerUsuals — products THIS customer ordered before. Pick the candidate that best honours the request AND its constraints — a "not brand X" constraint means you must pick a DIFFERENT brand. A brand the customer NAMES ("Gold's pads", "Ta'am Tov cream of lox") is a hard constraint: never pick another brand's product just because a generic word matches (pads, milk, cream). When a request is ambiguous ("cookie sheet" against several cookie-sheet products), prefer the one the customer usually buys, else the most LITERAL name match — "cookie sheet" is the plain cookie sheet, not "cookie sheet pan".
The words name the TYPE of product — take them literally: "bread" means a loaf of bread, never bread crumbs, bread bags, breadsticks or breaded chicken; "eggs" means a carton of eggs, never egg kichel or egg salad; "milk" means drinking milk, never milk chocolate. When the customer names no brand, variety or grade, pick the PLAIN, REGULAR version — never a premium or specialty variant (organic, sugar-free, gluten-free, spelt, whole wheat) — and among comparable regular candidates prefer the CHEAPEST one that is in stock. "Organic eggs" selects organic; plain "eggs" never does.
The request text comes from a speech transcription that GARBLES brand names phonetically ("Ostreicher's" arrives as "Schrieber's", "duck sauce" as "Doc's Sauce") — match brands by SOUND when a candidate's brand is phonetically close to what was asked. A candidate marked learned:true was chosen by a store rep for this same phrase on a past order — strongly prefer it.
When the EXACT item isn't offered but a close variant is (a 5-pack when they asked for one, a different size, count or brand of the same TYPE of product), PICK the closest variant and set "unsure":true — the store rep will confirm it with the customer. A candidate marked inStock:false is out of stock — prefer an in-stock one; when only an out-of-stock candidate matches, still pick it with "unsure":true. REFUSING A LINE IS THE LAST RESORT: refuse only when nothing of that product type exists among the candidates at all — an empty line costs the store a sale, while an unsure pick just gets a question mark for the rep. Output STRICT JSON:
{"picks":[{"line":<index>,"id":"<candidate id>","qty":<integer 1-99>,"unsure":<true ONLY for a close-variant pick>}],"refused":[{"line":<index>,"reason":"<one short sentence for the store rep, plain English>"}]}
Never invent an id that is not among that line's candidates or customerUsuals. Never change prices.`;

function normalizeQty(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 99) : 1;
}

/**
 * Server-side candidate search — the SHARED catalog rule (catalogSearch.ts)
 * against the tenant's own catalog.
 *
 * ⛔ The token/where logic lives in catalogSearch.ts because the DESK's own
 * search boxes must behave identically: a rep correcting the agent has to be
 * able to find at least everything the agent could (2026-08-27 — the desk
 * was searching name-only and "golden flow orange juice" found nothing).
 */
export async function searchCandidates(db: any, tenantId: string, phrase: string): Promise<any[]> {
  const codePrefix = catalogCodePrefix(phrase);
  if (codePrefix) {
    return db.posCatalogItem.findMany({
      where: { tenantId, isActive: true, code: { startsWith: codePrefix } },
      select: { posProductId: true, code: true, name: true, brand: true, sizeText: true, unitPriceCents: true, onHand: true },
      take: CANDIDATES_PER_LINE,
    });
  }
  // ⛔ POOL then RANK then cut (searchCatalogPool) — never `take: 8` per
  // tier. The 2026-08-30 bug: per-tier truncation ordered by NAME meant an
  // "eggs" line's whole candidate pool was egg KICHEL and egg SALAD — the
  // $3.99 "Eggs Large" never reached the model, so no prompt rule could
  // make it pick right. Ranking also means the 8 candidates the model pays
  // prompt tokens for are the 8 most relevant, cheapest-first among equals.
  const pool = await searchCatalogPool(db, tenantId, phrase, {
    posProductId: true,
    code: true,
    name: true,
    brand: true,
    sizeText: true,
    unitPriceCents: true,
    onHand: true,
  });
  return rankCatalogRows(pool, phrase).slice(0, CANDIDATES_PER_LINE);
}

export type BrainDeps = {
  db: any;
  /** injected for tests */
  llm?: typeof openaiJson;
  search?: typeof searchCandidates;
  model?: string;
  keyResolver?: typeof resolveIntegrationKey;
};

/**
 * What THIS customer ordered before — the first learning layer (Izzy,
 * 2026-08-26: "the agent has to get smarter every day"). Free: read from our
 * own SUBMITTED drafts, prices refreshed from the live catalog row.
 */
export async function customerUsuals(db: any, tenantId: string, customerPhone: string | undefined): Promise<any[]> {
  const phone10 = posPhoneDigits(String(customerPhone ?? ""));
  if (!phone10) return [];
  try {
    const prior = await db.supermarketOrderDraft.findMany({
      where: { tenantId, customerPhone: phone10, status: "SUBMITTED" },
      orderBy: { submittedAt: "desc" },
      take: 5,
      select: { items: true },
    });
    const ids: string[] = [];
    for (const d of prior) {
      for (const it of Array.isArray(d.items) ? d.items : []) {
        const id = String((it as any)?.posProductId ?? "");
        if (id && !ids.includes(id)) ids.push(id);
      }
    }
    if (ids.length === 0) return [];
    // ⛔ prices come from the LIVE catalog row, never a historical draft
    return await db.posCatalogItem.findMany({
      where: { tenantId, isActive: true, posProductId: { in: ids.slice(0, 12) } },
      select: { posProductId: true, code: true, name: true, brand: true, sizeText: true, unitPriceCents: true, onHand: true },
      take: 12,
    });
  } catch {
    return [];
  }
}

/**
 * Fill a draft intelligently from English order text. Null on ANY failure —
 * the caller keeps the regex matcher's answer instead.
 */
export async function runOrderBrain(deps: BrainDeps, tenantId: string, englishText: string, opts: { customerPhone?: string } = {}): Promise<BrainResult | null> {
  const text = String(englishText ?? "").trim();
  if (!text) return null;
  const resolveKey = deps.keyResolver ?? resolveIntegrationKey;
  const key = await resolveKey(deps.db, tenantId, "OPENAI");
  if (!key) return null;
  const llm = deps.llm ?? openaiJson;
  const search = deps.search ?? searchCandidates;
  const model = deps.model ?? String(process.env.SUPERMARKET_BRAIN_MODEL || DEFAULT_BRAIN_MODEL);

  // House rules — the store owner's own conventions (agentRules.ts), read
  // FRESH on every run so a correction reaches the very next draft.
  // ⛔ Injected into BOTH passes on purpose: EXTRACT needs spelling/quantity
  // conventions ("Balabusta" → the catalog's brand wording, "two dozen eggs"
  // = 2× the 12-pack) because the phrase it emits is what the candidate
  // search runs on; RESOLVE needs the pick rules ("no brand milk = Golden
  // Flow", "cheapest in-stock dozen"). One pass alone leaves half the rule
  // unenforceable.
  const rulesBlock = rulesPromptBlock(await loadActiveRules(deps.db, tenantId));

  // 1) EXTRACT
  const extracted = await llm(key.apiKey, model, EXTRACT_SYSTEM + rulesBlock, text.slice(0, 6000), 16000);
  if (!extracted) return null;
  // ⛔ Izzy, 2026-08-26 ("the agent needs to use common sense. It's not
  // supposed to be a draft"): a complaint / question / chatter is NOT an
  // order — say so and skip the resolve pass entirely.
  if (extracted.isOrder === false) {
    const reason = String(extracted.reason ?? "Not an order.").slice(0, 200);
    return { items: [], comments: [], notes: [reason], model, notAnOrder: { reason } };
  }
  if (!Array.isArray(extracted.lines)) return null;
  const statedPhone = posPhoneDigits(String(extracted.customerPhone ?? "")) ?? undefined;
  const lines: ExtractedLine[] = extracted.lines
    .slice(0, MAX_BRAIN_LINES)
    .map((l: any) => ({
      phrase: String(l?.phrase ?? "").slice(0, 160),
      qty: normalizeQty(l?.qty),
      constraints: String(l?.constraints ?? "").slice(0, 240),
    }))
    .filter((l: ExtractedLine) => l.phrase.trim().length > 0);
  const remarks: string[] = Array.isArray(extracted.remarks)
    ? extracted.remarks.map((r: any) => String(r).slice(0, 240)).filter(Boolean).slice(0, 12)
    : [];
  if (lines.length === 0) {
    return { items: [], comments: detectWic(text) ? [WIC_COMMENT] : [], notes: remarks, model, customerPhone: statedPhone };
  }

  // 2) candidates per line, from OUR catalog only — plus what this customer
  //    usually orders (their own approved history, ids equally valid picks)
  const candidateSets: any[][] = [];
  for (const line of lines) candidateSets.push(await search(deps.db, tenantId, line.phrase));
  const usuals = await customerUsuals(deps.db, tenantId, opts.customerPhone ?? statedPhone);

  // 2b) phrase LESSONS — products a rep chose for this same garbled phrase on
  //     a past submitted order, re-fetched LIVE from the catalog and appended
  //     as candidates marked learned:true. A hint the model judges, never a
  //     forced pick (learning layer 2).
  const learnedByLine = new Map<number, Set<string>>();
  try {
    const lessons = await loadLessons(deps.db, tenantId);
    if (lessons.length) {
      const matched = matchLessonsToLines(lessons, lines.map((l) => l.phrase));
      for (const [li, ids] of matched) learnedByLine.set(li, new Set(ids));
      const wantedIds = [...new Set([...matched.values()].flat())];
      if (wantedIds.length) {
        const rows = await deps.db.posCatalogItem.findMany({
          where: { tenantId, isActive: true, posProductId: { in: wantedIds } },
          select: { posProductId: true, code: true, name: true, brand: true, sizeText: true, unitPriceCents: true, onHand: true },
        });
        const byId = new Map((rows ?? []).map((r: any) => [r.posProductId, r]));
        for (const [lineIdx, ids] of matched) {
          for (const id of ids) {
            const row = byId.get(id);
            if (!row) continue;
            const set = candidateSets[lineIdx];
            const existing = set.find((c: any) => c.posProductId === id);
            if (existing) existing.learned = true;
            else set.push({ ...row, learned: true });
          }
        }
      }
    }
  } catch {
    /* lessons are best-effort — never block a draft */
  }

  // 3) RESOLVE
  const asCandidate = (c: any) => ({
    id: c.posProductId,
    name: c.name,
    brand: c.brand ?? undefined,
    size: c.sizeText ?? undefined,
    price: (c.unitPriceCents / 100).toFixed(2),
    // ⛔ ZERO only — a NEGATIVE onHand is register drift (unknown), and
    // telling the model it is out of stock is how "cheapest in stock" landed
    // on organic eggs while the $3.99 dozen sat at onHand -75 (2026-08-30).
    ...(isKnownOutOfStock(c) ? { inStock: false } : {}),
    ...(c.learned ? { learned: true } : {}),
  });
  const resolveUser = JSON.stringify({
    lines: lines.map((l, i) => ({
      line: i,
      request: l.phrase,
      qty: l.qty,
      constraints: l.constraints,
      candidates: candidateSets[i].map(asCandidate),
    })),
    ...(usuals.length ? { customerUsuals: usuals.map(asCandidate) } : {}),
  });
  const resolved = await llm(key.apiKey, model, RESOLVE_SYSTEM + rulesBlock, resolveUser, 16000);
  if (!resolved || !Array.isArray(resolved.picks)) return null;

  const items: DraftItem[] = [];
  const notes: string[] = [...remarks];
  const pickedLines = new Set<number>();
  const lineOutcome = new Map<number, { outcome: "in_cart" | "unsure"; posProductId: string; name: string }>();
  const lineReason = new Map<number, string>();
  for (const pick of resolved.picks.slice(0, MAX_BRAIN_LINES)) {
    const lineIdx = Math.floor(Number(pick?.line));
    if (!Number.isFinite(lineIdx) || lineIdx < 0 || lineIdx >= lines.length || pickedLines.has(lineIdx)) continue;
    // ⛔ the id MUST be one of THAT line's server-fetched candidates — or one
    // of this customer's own usuals (also server-fetched, live-priced)
    const pickId = String(pick?.id ?? "");
    const candidate = candidateSets[lineIdx]?.find((c) => c.posProductId === pickId) ?? usuals.find((c) => c.posProductId === pickId);
    if (!candidate) continue;
    pickedLines.add(lineIdx);
    // the "auto-filled N×" gauge: the pick came off a stored lesson.
    // ⛔ try/catch, not .catch() — a missing accessor throws SYNCHRONOUSLY
    // before any promise exists (the documented voicemail-footer trap).
    if (learnedByLine.get(lineIdx)?.has(pickId)) {
      try {
        await deps.db.supermarketPhraseLesson.updateMany({ where: { tenantId, posProductId: pickId }, data: { timesUsed: { increment: 1 } } });
      } catch {
        /* a gauge, never a blocker */
      }
    }
    lineOutcome.set(lineIdx, {
      outcome: pick?.unsure === true ? "unsure" : "in_cart",
      posProductId: candidate.posProductId,
      name: candidate.name,
    });
    const existing = items.find((i) => i.posProductId === candidate.posProductId);
    const qty = normalizeQty(pick?.qty ?? lines[lineIdx].qty);
    if (existing) existing.qty = Math.min(99, existing.qty + qty);
    else {
      items.push({
        posProductId: candidate.posProductId,
        code: candidate.code,
        name: candidate.name,
        qty,
        unitPriceCents: candidate.unitPriceCents,
        matchedFrom: "name",
        // closest-variant pick — filled in with a "?" for the rep, never empty
        ...(pick?.unsure === true ? { unsure: true } : {}),
      });
    }
  }
  if (Array.isArray(resolved.refused)) {
    for (const r of resolved.refused.slice(0, MAX_BRAIN_LINES)) {
      const lineIdx = Math.floor(Number(r?.line));
      const line = Number.isFinite(lineIdx) ? lines[lineIdx] : null;
      const reason = String(r?.reason ?? "").slice(0, 200);
      if (line && !pickedLines.has(lineIdx)) {
        lineReason.set(lineIdx, reason || "needs a person");
        notes.push(`${line.qty > 1 ? `${line.qty}x ` : ""}${line.phrase}${line.constraints ? ` (${line.constraints})` : ""} — ${reason || "needs a person"}`);
      }
    }
  }
  // lines the model neither picked nor refused still reach the rep
  for (let i = 0; i < lines.length; i++) {
    if (!pickedLines.has(i) && !lineReason.has(i)) {
      lineReason.set(i, "No match found in the catalog");
      notes.push(`${lines[i].qty > 1 ? `${lines[i].qty}x ` : ""}${lines[i].phrase}${lines[i].constraints ? ` (${lines[i].constraints})` : ""} — not matched`);
    }
  }
  // The per-line checklist the desk renders — every asked-for item with its
  // outcome, and for a skipped line the reason plus the top catalog
  // alternatives ("if the brand doesn't exist, auto-suggest alternatives").
  const brainLines: BrainLine[] = lines.map((l, i) => {
    const hit = lineOutcome.get(i);
    if (hit) {
      return { phrase: l.phrase, qty: l.qty, ...(l.constraints ? { constraints: l.constraints } : {}), outcome: hit.outcome, posProductId: hit.posProductId, name: hit.name };
    }
    return {
      phrase: l.phrase,
      qty: l.qty,
      ...(l.constraints ? { constraints: l.constraints } : {}),
      outcome: "skipped" as const,
      reason: lineReason.get(i) ?? "No match found in the catalog",
      suggestions: (candidateSets[i] ?? []).slice(0, 4).map((c: any) => ({
        posProductId: c.posProductId,
        code: c.code,
        name: c.name,
        unitPriceCents: c.unitPriceCents,
      })),
    };
  });
  const comments = detectWic(text) ? [WIC_COMMENT] : [];
  return { items, comments, notes: notes.slice(0, 20), model, customerPhone: statedPhone, lines: brainLines };
}
