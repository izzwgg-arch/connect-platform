/**
 * Evidence — the rule that separates what the assistant MEASURED from what it
 * merely REMEMBERED.
 *
 * ⛔⛔ THE FAILURE THIS EXISTS TO END, and it is not hypothetical. On
 * 2026-08-18 an escalation report about Trimpro stated, in the same confident
 * voice as its correct findings:
 *   - "Ext 101's mailbox is near its 9,999-message limit."  (it holds 47;
 *     9,432 is GESHEFT's mailbox)
 *   - "This account has no billing settings row at all."    (the row exists,
 *     and three invoices have been issued against it)
 * Both are documented facts about OTHER companies, restated as this one's. The
 * report offered no way to tell them from the findings it had actually
 * measured, because prose carries no provenance.
 *
 * ⛔ THE RULE: a finding may only be presented as a finding if it cites a query
 * that was really run and really returned. There is no query that returns "near
 * the 9,999 limit" for Trimpro, and none that returns "no billing settings row"
 * for a tenant with three invoices — so both claims fail this check
 * automatically, without anyone having to anticipate them.
 *
 * ⛔ UNCITED CLAIMS ARE RELABELLED, NEVER DELETED. A hunch is often the most
 * valuable line in a report ("this smells like the July provisioning bug"); the
 * damage is done when a hunch is dressed as a measurement. Moving it under a
 * heading that says nobody checked it keeps the insight and removes the
 * authority. Deleting it would also hide from the reader that the assistant is
 * guessing, which is the very thing being fixed.
 */

export interface EvidenceEntry {
  /** Short citable id — "E1", "E2", ... Kept tiny because it appears inline. */
  id: string;
  source: "connect" | "pbx";
  /** The statement as actually executed. */
  statement: string;
  rowCount: number;
  truncated: boolean;
  /** A small sample of the returned rows, for the reader to check the claim. */
  sample: unknown[];
  at: string;
}

/** How many rows of each result are kept as quotable proof. */
const SAMPLE_ROWS = 5;

export class EvidenceLog {
  private entries: EvidenceEntry[] = [];

  /**
   * Record a query that SUCCEEDED. A failed query is deliberately not evidence
   * — "I tried to check and it errored" must never be citable as proof of
   * anything, or a broken connection becomes a source of confident findings.
   */
  record(input: {
    source: "connect" | "pbx";
    statement: string;
    rows: unknown[];
    rowCount: number;
    truncated: boolean;
    at?: string;
  }): EvidenceEntry {
    const entry: EvidenceEntry = {
      id: `E${this.entries.length + 1}`,
      source: input.source,
      statement: input.statement.trim(),
      rowCount: input.rowCount,
      truncated: input.truncated,
      sample: (input.rows ?? []).slice(0, SAMPLE_ROWS),
      at: input.at ?? new Date().toISOString(),
    };
    this.entries.push(entry);
    return entry;
  }

  list(): EvidenceEntry[] {
    return [...this.entries];
  }

  ids(): string[] {
    return this.entries.map((e) => e.id);
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** The block appended to the report so a person can re-run any claim. */
  render(): string {
    if (!this.entries.length) return "EVIDENCE: none — no query was run.";
    const lines = this.entries.map((e) => {
      const trunc = e.truncated ? " (truncated at the row cap)" : "";
      const sample = e.sample.length
        ? `\n     returned: ${JSON.stringify(e.sample).slice(0, 400)}`
        : "";
      return `  [${e.id}] on ${e.source}: ${e.statement.replace(/\s+/g, " ").slice(0, 300)}\n     → ${e.rowCount} row(s)${trunc}${sample}`;
    });
    return `EVIDENCE (every finding above cites one of these):\n${lines.join("\n")}`;
  }
}

/** Citation ids referenced by a line, e.g. "…47 messages [E3]" → ["E3"]. */
export function citationsIn(line: string): string[] {
  const out: string[] = [];
  const re = /\[(E\d+(?:\s*,\s*E\d+)*)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    for (const part of m[1].split(",")) {
      const id = part.trim().toUpperCase();
      if (/^E\d+$/.test(id)) out.push(id);
    }
  }
  return out;
}

/**
 * A line is only checked when it actually asserts something. Blank lines,
 * headings and pure connectives are structure, not claims — demanding a
 * citation from them would bury the real ones in noise.
 */
export function isFactualClaim(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.length < 12) return false;
  if (/^[A-Z][A-Z \t]+:?$/.test(t)) return false;      // ALL-CAPS heading
  if (/^[-*\d.)\s]+$/.test(t)) return false;            // bullet/number with no text
  return true;
}

export interface PartitionedFindings {
  /** Lines that cite at least one real piece of evidence. */
  verified: string[];
  /** Lines that assert something with nothing behind them. */
  unverified: string[];
  /** Citations pointing at evidence that does not exist — a fabricated receipt. */
  danglingCitations: string[];
}

/**
 * Split a findings block into what is backed by a query and what is not.
 *
 * ⛔ A citation to an id that was never recorded is treated as UNVERIFIED, not
 * as verified. That case matters more than it looks: a model that learns it
 * must cite evidence can learn to write "[E7]" without running anything, which
 * would turn this whole mechanism into decoration. The dangling id is reported
 * separately so that behaviour is visible rather than silently tolerated.
 */
export function partitionFindings(findings: string, evidenceIds: string[]): PartitionedFindings {
  const known = new Set(evidenceIds.map((i) => i.toUpperCase()));
  const verified: string[] = [];
  const unverified: string[] = [];
  const dangling: string[] = [];

  for (const line of (findings ?? "").split("\n")) {
    if (!isFactualClaim(line)) {
      // Structure is preserved in the verified stream so the report still reads
      // as a report rather than as a list of orphaned sentences.
      verified.push(line);
      continue;
    }
    const cites = citationsIn(line);
    const real = cites.filter((c) => known.has(c));
    const fake = cites.filter((c) => !known.has(c));
    for (const f of fake) if (!dangling.includes(f)) dangling.push(f);

    if (real.length > 0) verified.push(line);
    else unverified.push(line.trim());
  }

  return { verified, unverified, danglingCitations: dangling };
}

/**
 * Rebuild the findings section with the unverified claims moved under a heading
 * that says plainly that nobody checked them.
 */
export function renderFindingsWithEvidenceRule(
  findings: string,
  evidence: EvidenceLog,
): { text: string; unverifiedCount: number; danglingCount: number } {
  const { verified, unverified, danglingCitations } = partitionFindings(findings, evidence.ids());

  let text = verified.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  if (unverified.length) {
    text +=
      "\n\nNOT CHECKED — the assistant believes these but ran no query to confirm them. " +
      "Treat them as leads, not facts:\n" +
      unverified.map((u) => `  - ${u.replace(/^[-*]\s*/, "")}`).join("\n");
  }

  if (danglingCitations.length) {
    text +=
      `\n\n⚠️ The assistant cited evidence that does not exist (${danglingCitations.join(", ")}). ` +
      "Those claims were moved to NOT CHECKED.";
  }

  return { text, unverifiedCount: unverified.length, danglingCount: danglingCitations.length };
}
