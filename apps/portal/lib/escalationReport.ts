/**
 * Parse the agent's escalation research report into its sections.
 *
 * The report format is authored in apps/agent/src/escalation/escalations.ts
 * (RESEARCH_SYSTEM_PROMPT → parseReportSections): plain text with the headings
 * ISSUE / FINDINGS / PROPOSED FIX / APPROVAL, sometimes with NOT CHECKED (the
 * evidence rule: an unbackable claim is relabelled, never deleted). The portal
 * cannot import across apps, so this is a deliberate mirror — kept forgiving,
 * because the text is model-written: headings may carry trailing spaces or
 * appear mid-document, and a degraded report may have no headings at all.
 *
 * ⛔ When no headings are found, `hasSections` is false and the caller must
 * render `raw` whole — a degraded report is often just the customer's own
 * words, and dropping it because it didn't match a regex would hide exactly
 * the escalations that most need a human.
 */

export type EscalationReportSections = {
  issue: string;
  findings: string;
  proposedFix: string;
  approval: string;
  notChecked: string;
  /** Any text before the first heading (a preamble line, a title, etc.). */
  preamble: string;
  raw: string;
  hasSections: boolean;
};

const HEADING_RE = /^[ \t]*(ISSUE|FINDINGS|PROPOSED FIX|APPROVAL|NOT CHECKED)[ \t]*:[ \t]*/gim;

const KEY_BY_HEADING: Record<string, keyof Pick<EscalationReportSections, "issue" | "findings" | "proposedFix" | "approval" | "notChecked">> = {
  ISSUE: "issue",
  FINDINGS: "findings",
  "PROPOSED FIX": "proposedFix",
  APPROVAL: "approval",
  "NOT CHECKED": "notChecked",
};

export function parseEscalationReport(text: string): EscalationReportSections {
  const raw = String(text ?? "");
  const out: EscalationReportSections = {
    issue: "",
    findings: "",
    proposedFix: "",
    approval: "",
    notChecked: "",
    preamble: "",
    raw,
    hasSections: false,
  };
  const marks: Array<{ key: keyof typeof KEY_BY_HEADING; start: number; bodyStart: number }> = [];
  HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(raw))) {
    marks.push({ key: m[1].toUpperCase() as keyof typeof KEY_BY_HEADING, start: m.index, bodyStart: m.index + m[0].length });
  }
  if (!marks.length) return out;
  out.hasSections = true;
  out.preamble = raw.slice(0, marks[0].start).trim();
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : raw.length;
    const body = raw.slice(marks[i].bodyStart, end).trim();
    const key = KEY_BY_HEADING[marks[i].key as string];
    // A duplicated heading keeps the FIRST occurrence — the model sometimes
    // restates a heading inside its own prose, and the restatement is body.
    if (key && !out[key]) out[key] = body;
  }
  return out;
}

/** Short human wording for the fix-by-text state on an escalation row. */
export function fixStatusLabel(fixStatus: string | null | undefined, hasFixAction: boolean): string | null {
  switch (fixStatus) {
    case "offered":
      return "Fix ready";
    case "applied":
      return "Fix applied";
    case "refused":
      return "Fix refused";
    case "failed":
      return "Fix failed";
    default:
      return hasFixAction ? "Fix drafted" : null;
  }
}
