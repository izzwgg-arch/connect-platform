/**
 * "Something not working?" — the customer's own way to reach a person.
 *
 * Until now the ONLY route from a customer to Izzy ran through the assistant
 * deciding, of its own accord, to say it was passing something along: the
 * escalation detector matches the assistant's REPLY text
 * (`apps/agent/src/escalation/escalations.ts`). That works when the model
 * volunteers and silently does nothing when it doesn't — so a customer whose
 * phones are dead had to phrase the problem well enough to talk the assistant
 * into escalating.
 *
 * The report button removes the gamble: it writes the escalation itself. What
 * the customer typed IS the report — no model in the path, nothing to match.
 *
 * These builders are pure on purpose. The API composes the row from them and
 * the portal renders the same area list, so the two can never disagree about
 * what "Texting" means; and the exact words that reach the owner's phone are
 * testable without a database, a carrier or an LLM.
 */
import { truncateSms } from "./agentFixByText";

/**
 * Where the customer thinks the problem is. Deliberately short and in plain
 * language — this is a hint that helps triage, never a routing decision, so a
 * customer picking "Something else" costs nothing.
 */
export const SUPPORT_REPORT_AREAS = [
  { id: "calls", label: "Calls" },
  { id: "voicemail", label: "Voicemail" },
  { id: "texting", label: "Texting" },
  { id: "app", label: "The app" },
  { id: "billing", label: "Billing" },
  { id: "other", label: "Something else" },
] as const;

export type SupportReportArea = (typeof SUPPORT_REPORT_AREAS)[number]["id"];

export const SUPPORT_REPORT_AREA_IDS: SupportReportArea[] = SUPPORT_REPORT_AREAS.map((a) => a.id);

export function isSupportReportArea(value: unknown): value is SupportReportArea {
  return typeof value === "string" && (SUPPORT_REPORT_AREA_IDS as string[]).includes(value);
}

export function supportReportAreaLabel(id: string): string {
  return SUPPORT_REPORT_AREAS.find((a) => a.id === id)?.label ?? "Something else";
}

export const SUPPORT_REPORT_PROBLEM_MIN = 10;
export const SUPPORT_REPORT_PROBLEM_MAX = 2000;

/**
 * The number both sides quote. Derived from the escalation row's own id so
 * there is nothing extra to store and nothing that can drift out of sync.
 *
 * ⛔ Letters that read as digits are removed (I/L/O/S/1/0/5) — this number gets
 * read down a phone line, and "was that an O or a zero?" wastes exactly the
 * minute this feature exists to save.
 */
export function supportReportReference(escalationId: string): string {
  const cleaned = String(escalationId || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/[ILOS150]/g, "");
  const tail = cleaned.slice(-6);
  return tail.padStart(6, "X");
}

export type SupportReportInput = {
  tenantName: string;
  userName: string;
  userEmail?: string | null;
  /** What the customer typed, verbatim. Never summarised by a model. */
  problem: string;
  area: string;
  /** The customer ticked "our phones are down right now". */
  urgent: boolean;
  /** Already normalised to E.164 by the caller; shown as given. */
  callbackPhone: string;
  /** The page they were on when they reported it — free triage context. */
  page?: string | null;
  reference: string;
};

/** One line for screens and for the escalation row's `requestSummary`. */
export function supportReportSummary(input: SupportReportInput): string {
  const head = input.urgent ? "Phones down" : supportReportAreaLabel(input.area);
  return truncateSms(`${head} — ${input.problem}`, 240);
}

/**
 * The text that reaches Izzy's phone. Urgency leads, because the whole point
 * of the switch is that a dead phone system must not look like a billing
 * question in a list of notifications. Capped at two segments.
 */
export function buildSupportReportSms(input: SupportReportInput): string {
  // ⛔ Each line is capped on its own and only THEN joined. Passing the joined
  // text through `truncateSms` would work — and would collapse every newline
  // into a space, because that helper flattens whitespace by design. The line
  // breaks are what make this readable on a phone at 2am.
  // ⛔ Plain ASCII only. One emoji switches the whole message to UCS-2, which
  // cuts a segment from 160 characters to 70 — a two-segment report would
  // arrive as five texts instead, on every report, forever.
  const lines = [
    `${input.urgent ? "** PHONES DOWN ** " : ""}Loopcom support - ${truncateSms(input.tenantName, 40)}`,
    `${truncateSms(input.userName, 40)} - ${supportReportAreaLabel(input.area)}`,
    truncateSms(input.problem, 150),
    `Call back: ${input.callbackPhone}`,
    // Last and shortest on purpose: whatever else gets clipped, the number the
    // customer will quote back survives.
    `Ref ${input.reference}`,
  ];
  return lines.join("\n");
}

/**
 * The full report for the email. The dispatcher already prints the company,
 * the person and a header, so this is the detail underneath it.
 */
export function buildSupportReportEmail(input: SupportReportInput & { textThreadNote: string }): string {
  const lines: string[] = [
    `REPORTED BY THE CUSTOMER — this did not come from the assistant.`,
    ``,
    `Reference:      ${input.reference}`,
    `Urgency:        ${input.urgent ? "PHONES ARE DOWN RIGHT NOW" : "Normal"}`,
    `Area:           ${supportReportAreaLabel(input.area)}`,
    `Call back on:   ${input.callbackPhone}`,
  ];
  if (input.page) lines.push(`Was looking at: ${input.page}`);
  lines.push(``, `What they said:`, input.problem.trim(), ``, input.textThreadNote);
  return lines.join("\n");
}

/**
 * The confirmation the CUSTOMER receives. It is what opens the text thread, so
 * it must be worth receiving on its own — it names us, names the reference and
 * says what happens next. No link: the point is that they can simply reply.
 */
export function supportReportCustomerSms(input: { reference: string; urgent: boolean }): string {
  return truncateSms(
    input.urgent
      ? `Loopcom: we have your report (ref ${input.reference}) and we're on it now. Reply to this text and it reaches us directly.`
      : `Loopcom: we got your report (ref ${input.reference}). Someone will get back to you. Reply to this text and it reaches us directly.`,
    300,
  );
}

/** Written onto the escalation when the report could not be filed as an action. */
export const SUPPORT_REPORT_NO_FIX = "None — reported by the customer, a person needs to look at it.";
