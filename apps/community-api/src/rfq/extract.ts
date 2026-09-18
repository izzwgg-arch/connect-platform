import { CATEGORY_KEYWORDS, GAZETTEER } from "./policy.js";

export type ExtractedRfq = {
  quantity: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  deadline: string | null; // ISO date
  location: string | null;
  requirements: string[];
  categorySlug: string | null;
};

const QUANTITY_UNITS = [
  "jackets?",
  "shirts?",
  "t-shirts?",
  "polos?",
  "hats?",
  "caps?",
  "units?",
  "pieces?",
  "pcs\\.?",
  "boxes?",
  "cartons?",
  "signs?",
  "banners?",
  "copies",
  "reams?",
  "vests?",
  "jerseys?",
  "uniforms?",
  "seats?",
  "desks?",
  "phones?",
  "computers?",
  "laptops?",
  "licenses?",
  "employees?",
  "rooms?",
  "tables?",
  "chairs?",
];
const QUANTITY_RE = new RegExp(`\\b(\\d{1,3}(?:,\\d{3})*)\\s+(?:[a-z-]+\\s+){0,3}?(?:${QUANTITY_UNITS.join("|")})\\b`, "i");

function num(s: string): number {
  return parseFloat(s.replace(/,/g, ""));
}

function extractQuantity(text: string): string | null {
  const m = text.match(QUANTITY_RE);
  return m ? m[1].replace(/,/g, "") : null;
}

function extractBudget(text: string): { budgetMin: number | null; budgetMax: number | null } {
  const dashRange = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(k)?\s*[-–—]\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(k)?\b/i);
  if (dashRange) {
    return {
      budgetMin: num(dashRange[1]) * (dashRange[2] ? 1000 : 1),
      budgetMax: num(dashRange[3]) * (dashRange[4] ? 1000 : 1),
    };
  }
  const toRange = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(k)?\s+to\s+\$?\s*([\d,]+(?:\.\d+)?)\s*(k)?\b/i);
  if (toRange) {
    return {
      budgetMin: num(toRange[1]) * (toRange[2] ? 1000 : 1),
      budgetMax: num(toRange[3]) * (toRange[4] ? 1000 : 1),
    };
  }
  const under = text.match(/\bunder\s+\$?\s*([\d,]+(?:\.\d+)?)\s*(k)?\b/i);
  if (under) return { budgetMin: null, budgetMax: num(under[1]) * (under[2] ? 1000 : 1) };
  const budgetWord = text.match(/\bbudget(?:\s+(?:is|of|around))?\s*\$?\s*([\d,]+(?:\.\d+)?)\s*(k)?\b/i);
  if (budgetWord) return { budgetMin: num(budgetWord[1]) * (budgetWord[2] ? 1000 : 1), budgetMax: null };
  const lone = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(k)?\b/);
  if (lone) return { budgetMin: num(lone[1]) * (lone[2] ? 1000 : 1), budgetMax: null };
  return { budgetMin: null, budgetMax: null };
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
  jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function nextOrSameYear(month: number, day: number, now: Date): Date {
  let year = now.getFullYear();
  let d = new Date(Date.UTC(year, month, day));
  if (d.getTime() < now.getTime() - 86_400_000) {
    year += 1;
    d = new Date(Date.UTC(year, month, day));
  }
  return d;
}

function extractDeadline(text: string, now: Date = new Date()): string | null {
  const monthDay = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (monthDay) {
    const month = MONTHS[monthDay[1].toLowerCase()];
    const day = parseInt(monthDay[2], 10);
    if (month !== undefined && day >= 1 && day <= 31) return nextOrSameYear(month, day, now).toISOString().slice(0, 10);
  }
  const slash = text.match(/\bby\s+(\d{1,2})\/(\d{1,2})\b/i) || text.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (slash) {
    const month = parseInt(slash[1], 10) - 1;
    const day = parseInt(slash[2], 10);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) return nextOrSameYear(month, day, now).toISOString().slice(0, 10);
  }
  const weeks = text.match(/\bin\s+(\d+)\s+weeks?\b/i);
  if (weeks) return new Date(now.getTime() + parseInt(weeks[1], 10) * 7 * 86_400_000).toISOString().slice(0, 10);
  const days = text.match(/\bin\s+(\d+)\s+days?\b/i);
  if (days) return new Date(now.getTime() + parseInt(days[1], 10) * 86_400_000).toISOString().slice(0, 10);
  if (/\bnext\s+month\b/i.test(text)) {
    const d = new Date(now);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

function extractLocation(text: string): string | null {
  let best: { name: string; index: number } | null = null;
  for (const place of GAZETTEER) {
    const idx = text.toLowerCase().indexOf(place.toLowerCase());
    if (idx >= 0 && (best === null || idx < best.index)) best = { name: place, index: idx };
  }
  return best?.name ?? null;
}

const REQUIREMENT_RE = /\b(must|need|needs|sample|delivered|deliver|rush|minimum)\b/i;

function extractRequirements(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sentences.filter((s) => REQUIREMENT_RE.test(s)).slice(0, 8);
}

function extractCategorySlug(text: string): string | null {
  const lower = text.toLowerCase();
  for (const entry of CATEGORY_KEYWORDS) {
    if (entry.keywords.some((kw) => lower.includes(kw))) return entry.slug;
  }
  return null;
}

/** Deterministic field extraction from a plain-English RFQ description. No LLM. */
export function extractRfq(text: string, now: Date = new Date()): ExtractedRfq {
  const { budgetMin, budgetMax } = extractBudget(text);
  return {
    quantity: extractQuantity(text),
    budgetMin,
    budgetMax,
    deadline: extractDeadline(text, now),
    location: extractLocation(text),
    requirements: extractRequirements(text),
    categorySlug: extractCategorySlug(text),
  };
}
