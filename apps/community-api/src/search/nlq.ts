/**
 * Deterministic natural-language interpretation for the search box — no LLM.
 * Pulls a location (gazetteer), a customer type ("serving nursing homes"),
 * a distance ("within 25 miles"), a type hint (installer → organizations),
 * and leaves the rest as the "service" the person is looking for.
 *
 * This is intentionally simple pattern-matching, not NLP: it is meant to
 * produce a short "Understood as: …" line a person can correct by editing
 * the facets, not to be always right.
 */

export type NlqType = "organizations" | "jobs" | "rfqs";

export type NlqResult = {
  service: string;
  customerType: string | null;
  location: string | null;
  distanceMiles: number | null;
  typeHint: NlqType | null;
  explain: string;
};

/** Canonical display form keyed by the lowercase gazetteer term. */
const GAZETTEER: Record<string, string> = {
  brooklyn: "Brooklyn",
  "boro park": "Boro Park",
  williamsburg: "Williamsburg",
  flatbush: "Flatbush",
  monsey: "Monsey",
  monroe: "Monroe",
  "kiryas joel": "Kiryas Joel",
  lakewood: "Lakewood",
  "spring valley": "Spring Valley",
  "new square": "New Square",
  queens: "Queens",
  manhattan: "Manhattan",
  "new jersey": "New Jersey",
  rockland: "Rockland",
  "orange county": "Orange County",
};

/** Longest terms first so "boro park" wins over a bare "park" (which isn't in the list anyway). */
const GAZETTEER_TERMS = Object.keys(GAZETTEER).sort((a, b) => b.length - a.length);

const TYPE_HINTS: Array<{ re: RegExp; type: NlqType }> = [
  { re: /\b(rfqs?|request for quote|quote|quotes)\b/, type: "rfqs" },
  { re: /\b(jobs?|hiring|vacanc(?:y|ies))\b/, type: "jobs" },
  { re: /\b(installers?|compan(?:y|ies)|agenc(?:y|ies)|suppliers?|vendors?)\b/, type: "organizations" },
];

/**
 * Lowercases, extracts distance/location/customerType/typeHint, and returns
 * whatever is left (with hyphens turned to spaces) as `service`.
 */
export function interpretQuery(raw: string): NlqResult {
  const original = (raw || "").toLowerCase();
  let text = ` ${original.trim()} `.replace(/\s+/g, " ");

  // 1) distance: "within 25 miles" / "within 10 mi"
  let distanceMiles: number | null = null;
  text = text.replace(/\bwithin\s+(\d+)\s*(?:miles?|mi)\b/, (_m, n) => {
    distanceMiles = Number(n);
    return " ";
  });

  // 2) location: a connector ("in"/"near"/"serving"/"to"/"at") + a gazetteer term wins first,
  //    then a bare gazetteer term anywhere in the text.
  let location: string | null = null;
  for (const term of GAZETTEER_TERMS) {
    const re = new RegExp(`\\b(?:in|near|serving|to|at)\\s+${term}\\b`, "i");
    const m = text.match(re);
    if (m) {
      location = GAZETTEER[term];
      text = text.replace(re, " ");
      break;
    }
  }
  if (!location) {
    for (const term of GAZETTEER_TERMS) {
      const re = new RegExp(`\\b${term}\\b`, "i");
      if (re.test(text)) {
        location = GAZETTEER[term];
        text = text.replace(re, " ");
        break;
      }
    }
  }

  // 3) customer type: "serving X" / "for X" where X is whatever is left before the next
  //    connector, a comma, a period, or the end of the string.
  let customerType: string | null = null;
  const ctRe = /\b(?:serving|for)\s+([a-z][a-z' -]{1,40}?)(?=\s+(?:in|near|within|to|at)\b|[.,]|$)/;
  const ctMatch = text.match(ctRe);
  if (ctMatch) {
    const phrase = ctMatch[1].trim();
    if (phrase) {
      customerType = phrase;
      text = text.replace(ctMatch[0], " ");
    }
  }

  // 4) type hint — scanned on the ORIGINAL text so removed words still count.
  let typeHint: NlqType | null = null;
  for (const { re, type } of TYPE_HINTS) {
    if (re.test(` ${original} `)) {
      typeHint = type;
      break;
    }
  }

  const service = text.replace(/-/g, " ").replace(/\s+/g, " ").trim();

  const parts: string[] = [];
  if (service) parts.push(`service = ${service}`);
  if (customerType) parts.push(`customer type = ${customerType}`);
  if (location) parts.push(`area = ${location}`);
  const explain = parts.length ? parts.join(" · ") : "Searching everything";

  return { service, customerType, location, distanceMiles, typeHint, explain };
}
