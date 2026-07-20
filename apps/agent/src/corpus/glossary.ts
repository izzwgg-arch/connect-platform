/**
 * Dialect glossary (YIDDISH_TUNING.md). Heimishe NY-Yiddish slang, loshn-koydesh,
 * names, and Yinglish code-switch terms. Two jobs:
 *   1) provide a phrase-boost list to the STT provider so these transcribe right
 *      immediately (Everett/Whisper keyword-boost hooks);
 *   2) detect term hits in a transcript for analytics + language-model seeding.
 *
 * The glossary lives in the DB (AgentDialectTerm) and grows from corrections.
 * A small seed set ships in code so the system is useful on day one.
 */
export type TermCategory = "slang" | "loshn_koydesh" | "name" | "yinglish" | "business" | "place";

export interface DialectTerm {
  term: string;
  variants?: string[];
  category: TermCategory;
  gloss?: string;
  englishForm?: string;
  weight?: number;
}

/** Day-one seed (illustrative; team expands via corrections). Kept small +
 *  neutral — real vocabulary is added by native reviewers. */
export const SEED_GLOSSARY: DialectTerm[] = [
  { term: "אַ שיינעם דאַנק", variants: ["a sheynem dank"], category: "slang", gloss: "thank you very much" },
  { term: "בעזראת השם", variants: ["b'ezras hashem", "beezras hashem"], category: "loshn_koydesh", gloss: "with God's help" },
  { term: "אי\"ה", variants: ["im yirtzeh hashem", "iy'h"], category: "loshn_koydesh", gloss: "God willing" },
  { term: "עקסטענשאן", variants: ["extension", "עקסטענשן"], category: "yinglish", gloss: "phone extension", englishForm: "extension" },
  { term: "אַפּוינטמענט", variants: ["appointment"], category: "yinglish", gloss: "appointment", englishForm: "appointment" },
  { term: "אינשורענס", variants: ["insurance"], category: "yinglish", gloss: "insurance", englishForm: "insurance" },
  { term: "אָפיס", variants: ["office"], category: "yinglish", gloss: "office", englishForm: "office" },
  { term: "וואוסמעיל", variants: ["voicemail", "וואיסמעיל"], category: "yinglish", gloss: "voicemail", englishForm: "voicemail" },
];

/** Phrase-boost list handed to the STT provider (canonical + variants). */
export function boostPhrases(terms: DialectTerm[]): string[] {
  const out = new Set<string>();
  for (const t of terms) {
    out.add(t.term);
    for (const v of t.variants ?? []) out.add(v);
  }
  return [...out];
}

/** Detect which glossary terms appear in a transcript (canonical or variant). */
export function detectTerms(text: string, terms: DialectTerm[]): Array<{ term: string; category: TermCategory }> {
  const lower = text.toLowerCase();
  const hits: Array<{ term: string; category: TermCategory }> = [];
  for (const t of terms) {
    const forms = [t.term, ...(t.variants ?? [])];
    if (forms.some((f) => lower.includes(f.toLowerCase()))) hits.push({ term: t.term, category: t.category });
  }
  return hits;
}

/** Rough code-switch signal: fraction of latin-script tokens in Hebrew-script text.
 *  High mix → "yi-en"; helps route to code-switch-aware handling. */
export function codeSwitchRatio(text: string): number {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const latin = tokens.filter((w) => /[a-z]/i.test(w)).length;
  return latin / tokens.length;
}

export function classifyLanguage(text: string): "en" | "yi" | "yi-en" {
  const hasHebrew = /[֐-׿]/.test(text);
  const cs = codeSwitchRatio(text);
  if (!hasHebrew) return "en";
  return cs >= 0.15 ? "yi-en" : "yi";
}
