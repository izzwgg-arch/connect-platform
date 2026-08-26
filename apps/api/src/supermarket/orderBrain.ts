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

const OPENAI_BASE = "https://api.openai.com/v1";
const BRAIN_TIMEOUT_MS = 90_000;
export const DEFAULT_BRAIN_MODEL = "gpt-5";
export const MAX_BRAIN_LINES = 40;
const CANDIDATES_PER_LINE = 6;

export type BrainResult = {
  items: DraftItem[];
  comments: string[];
  notes: string[];
  model: string;
  /** Set when the message is NOT an order (a complaint, a question, chatter). */
  notAnOrder?: { reason: string };
  /** The account phone the customer STATED (10 digits, 845-defaulted), if any. */
  customerPhone?: string;
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

const RESOLVE_SYSTEM = `You fill a kosher-supermarket order from the store's own catalog. For each requested line you get the store's candidate products (id, name, brand, size, price). Pick the candidate that best honours the request AND its constraints — a "not brand X" constraint means you must pick a DIFFERENT brand; if no candidate honours the constraints, refuse the line. Output STRICT JSON:
{"picks":[{"line":<index>,"id":"<candidate id>","qty":<integer 1-99>}],"refused":[{"line":<index>,"reason":"<one short sentence for the store rep, plain English>"}]}
Never invent an id that is not among that line's candidates. Never change prices. When two candidates fit, prefer the one whose name/size matches the request most literally.`;

function normalizeQty(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 99) : 1;
}

/** Server-side candidate search — name tokens against the tenant's own catalog. */
export async function searchCandidates(db: any, tenantId: string, phrase: string): Promise<any[]> {
  const tokens = String(phrase ?? "")
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length >= 3)
    .slice(0, 4);
  const numeric = String(phrase ?? "").match(/^\s*(\d{2,14})\s*$/);
  if (numeric) {
    return db.posCatalogItem.findMany({
      where: { tenantId, isActive: true, code: { startsWith: numeric[1] } },
      select: { posProductId: true, code: true, name: true, brand: true, sizeText: true, unitPriceCents: true },
      take: CANDIDATES_PER_LINE,
    });
  }
  if (tokens.length === 0) return [];
  const seen = new Map<string, any>();
  // most-specific first: all tokens, then each token
  const wheres = [
    { AND: tokens.map((t) => ({ name: { contains: t, mode: "insensitive" } })) },
    ...tokens.map((t) => ({ name: { contains: t, mode: "insensitive" } })),
  ];
  for (const nameWhere of wheres) {
    if (seen.size >= CANDIDATES_PER_LINE) break;
    const rows = await db.posCatalogItem.findMany({
      where: { tenantId, isActive: true, ...nameWhere },
      select: { posProductId: true, code: true, name: true, brand: true, sizeText: true, unitPriceCents: true },
      take: CANDIDATES_PER_LINE,
    });
    for (const row of rows) {
      if (!seen.has(row.posProductId)) seen.set(row.posProductId, row);
      if (seen.size >= CANDIDATES_PER_LINE) break;
    }
  }
  return [...seen.values()];
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
 * Fill a draft intelligently from English order text. Null on ANY failure —
 * the caller keeps the regex matcher's answer instead.
 */
export async function runOrderBrain(deps: BrainDeps, tenantId: string, englishText: string): Promise<BrainResult | null> {
  const text = String(englishText ?? "").trim();
  if (!text) return null;
  const resolveKey = deps.keyResolver ?? resolveIntegrationKey;
  const key = await resolveKey(deps.db, tenantId, "OPENAI");
  if (!key) return null;
  const llm = deps.llm ?? openaiJson;
  const search = deps.search ?? searchCandidates;
  const model = deps.model ?? String(process.env.SUPERMARKET_BRAIN_MODEL || DEFAULT_BRAIN_MODEL);

  // 1) EXTRACT
  const extracted = await llm(key.apiKey, model, EXTRACT_SYSTEM, text.slice(0, 6000), 4000);
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

  // 2) candidates per line, from OUR catalog only
  const candidateSets: any[][] = [];
  for (const line of lines) candidateSets.push(await search(deps.db, tenantId, line.phrase));

  // 3) RESOLVE
  const resolveUser = JSON.stringify({
    lines: lines.map((l, i) => ({
      line: i,
      request: l.phrase,
      qty: l.qty,
      constraints: l.constraints,
      candidates: candidateSets[i].map((c) => ({
        id: c.posProductId,
        name: c.name,
        brand: c.brand ?? undefined,
        size: c.sizeText ?? undefined,
        price: (c.unitPriceCents / 100).toFixed(2),
      })),
    })),
  });
  const resolved = await llm(key.apiKey, model, RESOLVE_SYSTEM, resolveUser, 4000);
  if (!resolved || !Array.isArray(resolved.picks)) return null;

  const items: DraftItem[] = [];
  const notes: string[] = [...remarks];
  const pickedLines = new Set<number>();
  for (const pick of resolved.picks.slice(0, MAX_BRAIN_LINES)) {
    const lineIdx = Math.floor(Number(pick?.line));
    if (!Number.isFinite(lineIdx) || lineIdx < 0 || lineIdx >= lines.length || pickedLines.has(lineIdx)) continue;
    // ⛔ the id MUST be one of THAT line's server-fetched candidates
    const candidate = candidateSets[lineIdx]?.find((c) => c.posProductId === String(pick?.id ?? ""));
    if (!candidate) continue;
    pickedLines.add(lineIdx);
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
      });
    }
  }
  if (Array.isArray(resolved.refused)) {
    for (const r of resolved.refused.slice(0, MAX_BRAIN_LINES)) {
      const lineIdx = Math.floor(Number(r?.line));
      const line = Number.isFinite(lineIdx) ? lines[lineIdx] : null;
      const reason = String(r?.reason ?? "").slice(0, 200);
      if (line) notes.push(`${line.qty > 1 ? `${line.qty}x ` : ""}${line.phrase}${line.constraints ? ` (${line.constraints})` : ""} — ${reason || "needs a person"}`);
    }
  }
  // lines the model neither picked nor refused still reach the rep
  for (let i = 0; i < lines.length; i++) {
    if (!pickedLines.has(i) && !(Array.isArray(resolved.refused) && resolved.refused.some((r: any) => Math.floor(Number(r?.line)) === i))) {
      notes.push(`${lines[i].qty > 1 ? `${lines[i].qty}x ` : ""}${lines[i].phrase}${lines[i].constraints ? ` (${lines[i].constraints})` : ""} — not matched`);
    }
  }
  const comments = detectWic(text) ? [WIC_COMMENT] : [];
  return { items, comments, notes: notes.slice(0, 20), model, customerPhone: statedPhone };
}
