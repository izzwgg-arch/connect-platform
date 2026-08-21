/**
 * What each holiday is CALLED, in English and in Yiddish.
 *
 * These are not transliterations I chose. Every name was run through Yiddish
 * Labs twice — the English hebcal ships → Yiddish → English again — and Izzy
 * approved the result on 2026-08-21. The round trip is what turns hebcal's
 * ISRAELI transliterations into ASHKENAZI ones, which is what this customer
 * base actually reads: Sukkot → Succos, Shavuot → Shavuos, Simchat Torah →
 * Simchas Torah, Shabbat → Shabbos.
 *
 * The full audit trail — what Yiddish Labs returned for each, which nine were
 * overridden and why — is docs/ai-context/jewish-holiday-names-yiddishlabs-2026-08-21.json.
 *
 * ⛔ `Yom Tov` came back from the round trip as **"Good day"** — a literally
 * correct translation and a completely wrong name. A machine cannot tell that
 * apart from "Simchas Torah"; both are just "the string changed". So nine rows
 * are human overrides, and NOTHING here should be regenerated automatically.
 *
 * ⛔ Keys are matched with apostrophes NORMALISED. The approved set uses a curly
 * apostrophe (’) and the generated table a straight one (') — matching on the
 * raw string silently lost Ta'anit Esther, Tish'a B'Av, Asara B'Tevet and
 * Ta'anit Bechorot.
 *
 * ⛔ A name with no entry renders in ENGLISH, never a guess. That is the same
 * rule the rest of the portal's Yiddish follows: a half-Yiddish screen is
 * honest, an invented Yiddish one is not.
 */
export interface HolidayName { en: string; yi: string }

/** Straight-apostrophe, trimmed — the form both sides are compared in. */
export function normaliseHolidayKey(name: string): string {
  return String(name ?? "").replace(/[\u2018\u2019\u02BC]/g, "'").trim();
}

const NAMES: Record<string, HolidayName> = {
  "Asara B'Tevet": { en: "Asara B’Teves", yi: "עשרה בטבת" },
  "Candle lighting": { en: "Candle lighting", yi: "ליכט צינדן" },
  "Chanukah": { en: "Chanukah", yi: "חנוכה" },
  "Chol Hamoed": { en: "Chol HaMoed", yi: "חול המועד" },
  "Chol Hamoed Pesach": { en: "Chol HaMoed Pesach", yi: "חול המועד פסח" },
  "Chol Hamoed Sukkot": { en: "Chol HaMoed Succos", yi: "חול המועד סוכות" },
  "Erev Pesach": { en: "Erev Pesach", yi: "ערב פסח" },
  "Erev Rosh Hashana": { en: "Erev Rosh Hashanah", yi: "ערב ראש השנה" },
  "Erev Shabbat": { en: "Erev Shabbos", yi: "ערב שבת" },
  "Erev Shavuot": { en: "Erev Shavuos", yi: "ערב שבועות" },
  "Erev Sukkot": { en: "Erev Succos", yi: "ערב סוכות" },
  "Erev Yom Kippur": { en: "Erev Yom Kippur", yi: "ערב יום כיפור" },
  "Fast day": { en: "Fast day", yi: "תענית" },
  "Havdalah": { en: "Havdalah", yi: "הבדלה" },
  "Hoshana Rabbah": { en: "Hoshana Rabba", yi: "הושענא רבה" },
  "Lag BaOmer": { en: "Lag Ba’omer", yi: "ל\"ג בעומר" },
  "Leil Selichot": { en: "Leil Selichos", yi: "ליל סליחות" },
  "Nightfall": { en: "Nightfall", yi: "צאת הכוכבים" },
  "Pesach": { en: "Pesach", yi: "פסח" },
  "Purim": { en: "Purim", yi: "פורים" },
  "Rosh Chodesh": { en: "Rosh Chodesh", yi: "ראש חודש" },
  "Rosh Hashana": { en: "Rosh Hashanah", yi: "ראש השנה" },
  "Shabbat": { en: "Shabbos", yi: "שבת" },
  "Shabbat Shuva": { en: "Shabbos Shuvah", yi: "שבת שובה" },
  "Shavuot": { en: "Shavuos", yi: "שבועות" },
  "Shmini Atzeret": { en: "Shemini Atzeres", yi: "שמיני עצרת" },
  "Shushan Purim": { en: "Shushan Purim", yi: "שושן פורים" },
  "Simchat Torah": { en: "Simchas Torah", yi: "שמחת תורה" },
  "Sukkot": { en: "Succos", yi: "סוכות" },
  "Ta'anit Bechorot": { en: "Taanis Bechoros", yi: "תענית בכורות" },
  "Ta'anit Esther": { en: "Taanis Esther", yi: "תענית אסתר" },
  "Tish'a B'Av": { en: "Tisha B’Av", yi: "תשעה באב" },
  "Tu BiShvat": { en: "Tu B’Shvat", yi: "ט\"ו בשבט" },
  "Tzom Gedaliah": { en: "Tzom Gedaliah", yi: "צום גדליה" },
  "Tzom Tammuz": { en: "Shiva Asar B’Tammuz", yi: "שבעה עשר בתמוז" },
  "Yom Kippur": { en: "Yom Kippur", yi: "יום כיפור" },
  "Yom Tov": { en: "Yom Tov", yi: "יום טוב" },};

/**
 * The holidays worth showing a business on a settings screen.
 *
 * ⛔ The generated table is deliberately COMPLETE — it carries Chag HaBanot,
 * Rosh Hashana LaBehemot, Purim Meshulash and other days almost nobody marks.
 * Correct in the table, noise in a list of "what should the phone do". This is
 * the list the UI renders; the table stays whole.
 */
export const COMMON_HOLIDAYS: readonly string[] = [
  "Rosh Hashana", "Tzom Gedaliah", "Yom Kippur", "Sukkot", "Shmini Atzeret", "Simchat Torah",
  "Chanukah", "Asara B'Tevet", "Tu BiShvat", "Ta'anit Esther", "Purim", "Shushan Purim",
  "Ta'anit Bechorot", "Pesach", "Lag BaOmer", "Shavuot", "Tzom Tammuz", "Tish'a B'Av",
];

export function isCommonHoliday(name: string): boolean {
  const k = normaliseHolidayKey(name);
  return COMMON_HOLIDAYS.some((c) => normaliseHolidayKey(c) === k);
}

/** The approved pair for a holiday, or null when it was never translated. */
export function holidayNamePair(name: string): HolidayName | null {
  return NAMES[normaliseHolidayKey(name)] ?? null;
}

/**
 * How a holiday should read on screen.
 *
 * ⛔ `lang` changes the WORD ONLY. The caller must not flip the page: a Yiddish
 * name goes in its own `dir="rtl"` span with `unicode-bidi: isolate`, inside an
 * otherwise left-to-right layout. Izzy was explicit about this.
 */
export function holidayDisplayName(name: string, lang: "en" | "yi" = "en"): string {
  const pair = holidayNamePair(name);
  if (!pair) return name;                 // never invent one
  return lang === "yi" ? (pair.yi || pair.en || name) : (pair.en || name);
}

/** True when the string should be rendered right-to-left inside its own span. */
export function isHebrewScript(text: string): boolean {
  return /[\u0590-\u05FF]/.test(String(text ?? ""));
}
