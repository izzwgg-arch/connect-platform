import { interpretQuery } from "../search/nlq.js";

/**
 * Turns a plain-English request into a structured intent. With ANTHROPIC_API_KEY
 * set, Claude does the understanding through a strict tool schema; without it,
 * the deterministic interpreter from the search domain does. Either way the
 * output is only ever used to SEARCH — never to state facts about anyone.
 */
export type Intent = {
  kind: "find_vendor" | "find_customer" | "find_person" | "find_job" | "find_event" | "find_group" | "post_rfq" | "unclear";
  service: string | null;
  customerType: string | null;
  location: string | null;
  radiusMiles: number | null;
  quantity: string | null;
  deadline: string | null;
  budget: string | null;
  summary: string;
  source: "ai" | "rules";
};

export const CLAUDE_MODEL = "claude-sonnet-5";

const TOOL = {
  name: "set_intent",
  description: "Record the structured meaning of a business request made on a professional network.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["find_vendor", "find_customer", "find_person", "find_job", "find_event", "find_group", "post_rfq", "unclear"] },
      service: { type: ["string", "null"], description: "The product or service needed, as the person would search for it" },
      customerType: { type: ["string", "null"], description: "Who the vendor must serve, e.g. nursing homes, schools" },
      location: { type: ["string", "null"], description: "Place or area named, e.g. Brooklyn, Monroe NY" },
      radiusMiles: { type: ["number", "null"] },
      quantity: { type: ["string", "null"] },
      deadline: { type: ["string", "null"], description: "ISO date when a date is given, else null" },
      budget: { type: ["string", "null"] },
      summary: { type: "string", description: "One sentence restating the request neutrally, no invented details" },
    },
    required: ["kind", "service", "customerType", "location", "radiusMiles", "quantity", "deadline", "budget", "summary"],
  },
} as const;

export async function understand(question: string, fetchImpl: typeof fetch = fetch): Promise<Intent> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    try {
      const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 400,
          system:
            "You extract the structured meaning of requests made on Loopcom Community, a professional B2B network. Use ONLY what the request says. Never invent companies, quantities, budgets or places. If the request is not about finding a vendor, customer, person, job, event, group, or posting a request for quotes, set kind to unclear.",
          tools: [TOOL],
          tool_choice: { type: "tool", name: "set_intent" },
          messages: [{ role: "user", content: question.slice(0, 2000) }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const body = (await res.json()) as any;
        const use = (body.content as any[]).find((c) => c.type === "tool_use");
        if (use?.input?.kind) return { ...(use.input as Omit<Intent, "source">), source: "ai" };
      }
    } catch {
      /* fall through to rules */
    }
  }
  return rulesIntent(question);
}

export function rulesIntent(question: string): Intent {
  const q = question.trim();
  const nlq = interpretQuery(q);
  const lower = q.toLowerCase();
  let kind: Intent["kind"] = "unclear";
  if (/\b(hire|hiring|candidate|employee|recruit)\b/.test(lower)) kind = "find_person";
  else if (/\b(job|position|employment|work for)\b/.test(lower)) kind = "find_job";
  else if (/\b(event|meetup|breakfast|expo|conference)\b/.test(lower)) kind = "find_event";
  else if (/\b(group|community|forum)\b/.test(lower)) kind = "find_group";
  else if (/\b(customers?|clients?|buyers?|who (needs|buys))\b/.test(lower)) kind = "find_customer";
  else if (/\b(quote|quotes|rfq|bids?)\b/.test(lower)) kind = "post_rfq";
  else if (nlq.typeHint === "organizations" || nlq.location || nlq.customerType || /\b(need|needs|looking for|find|who (can|does|makes|sells)|vendor|supplier|company|companies|installer|manufacturer|shop|contractor|agency)\b/.test(lower)) kind = "find_vendor";
  // "25 custom embroidered jackets" — a number followed within a few words by a plural noun.
  const qty = lower.match(/\b(\d{1,6}(?:,\d{3})*)\s+(?:[a-z-]+\s+){0,3}(?:pcs|pieces|units|boxes|jackets|shirts|items|cases|[a-z]{3,}s)\b/);
  const budget = lower.match(/\$\s?\d[\d,]*(?:\s?[-–]\s?\$?\d[\d,]*)?|\bunder \$?\d[\d,]*k?\b|\bbudget (?:of )?\$?\d[\d,]*k?\b/);
  const deadline = lower.match(/\b(?:by|before|until)\s+([a-z]+\s+\d{1,2}|\d{1,2}\/\d{1,2})/);
  return {
    kind,
    service: nlq.service || null,
    customerType: nlq.customerType,
    location: nlq.location,
    radiusMiles: nlq.distanceMiles,
    quantity: qty ? qty[1] : null,
    deadline: deadline ? deadline[1] : null,
    budget: budget ? budget[0] : null,
    summary: q.length > 140 ? `${q.slice(0, 137)}…` : q,
    source: "rules",
  };
}
