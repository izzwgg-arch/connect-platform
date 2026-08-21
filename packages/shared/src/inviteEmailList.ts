/**
 * Reading a pasted list of email addresses.
 *
 * ⛔ This lives in packages/shared because BOTH sides need the identical rule:
 * the portal's chip input shows the host what will be sent, and the API decides
 * what actually is. Two implementations would drift, and the drift would show
 * up as a chip the host can see being silently refused by the server.
 *
 * Pure — no db, no network, browser-safe, so it is fine on the root export.
 */

/** Hard cap per meeting. Well under the shared mailbox's 500/day allowance
 *  (see the one-mailbox rule in CLAUDE.md) and far more than a real meeting. */
export const MAX_INVITES_PER_MEETING = 50;


/** Deliberately permissive but not a parser: something@something.tld with no
 *  spaces or angle brackets left in it. The provider is the real validator —
 *  our job is to catch typos and refuse obvious junk, not to re-implement
 *  RFC 5322 (which would reject addresses that genuinely work). */
/** ⛔ The domain side MUST allow dots. A first cut used a dot-free class for
 *  the label before the TLD, which silently refused every `.co.uk`,
 *  `.com.au` and subdomained address — caught by driving it, not by a
 *  fixture, because the fixture used `@x.com`. */
const EMAIL_RE = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[A-Za-z]{2,}$/;

export type ParsedInviteList = {
  /** Valid, lowercased, de-duplicated, in the order first seen. */
  emails: string[];
  /** Fragments that looked like an address attempt but did not parse. */
  invalid: string[];
  /** True when the list was cut at MAX_INVITES_PER_MEETING. */
  truncated: boolean;
};

/** Pull the address out of `Display Name <a@b.com>`, leaving a bare address
 *  untouched. Outlook and Gmail both paste in this form. */
function unwrapAngleAddress(token: string): string {
  const m = /<([^<>]+)>/.exec(token);
  return (m ? m[1] : token).trim();
}

export function parseInviteEmails(raw: unknown): ParsedInviteList {
  const source = Array.isArray(raw) ? raw.map((x) => String(x ?? "")).join("\n") : String(raw ?? "");

  // ⛔ Angle-bracket addresses are lifted out BEFORE splitting. Splitting
  // first shreds `Sara Klein <sara@x.com>` into three tokens and reports the
  // person's first and last name back as errors — a host pasting an ordinary
  // Outlook list would get a wall of nonsense complaints.
  const lifted: string[] = [];
  const flattened = source.replace(/<([^<>]*)>/g, (_m, inner) => {
    lifted.push(String(inner));
    return " ";
  });

  const tokens = [...lifted, ...flattened.split(/[\s,;]+/)]
    .map((t) => t.trim())
    .filter(Boolean);

  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let truncated = false;

  for (const token of tokens) {
    const candidate = unwrapAngleAddress(token).replace(/^mailto:/i, "").trim();
    if (!candidate) continue;
    // A fragment with no "@" is part of a display name ("Sara", "Klein").
    // Ignore it silently — only something that TRIED to be an address and
    // failed is worth telling the host about.
    if (!candidate.includes("@")) continue;
    if (!EMAIL_RE.test(candidate)) {
      // Cap what we echo back so a pasted essay cannot become the error text.
      if (invalid.length < 10 && !invalid.includes(candidate)) invalid.push(candidate.slice(0, 80));
      continue;
    }
    const normalized = candidate.toLowerCase();
    if (seen.has(normalized)) continue;
    if (emails.length >= MAX_INVITES_PER_MEETING) {
      truncated = true;
      continue;
    }
    seen.add(normalized);
    emails.push(normalized);
  }

  return { emails, invalid, truncated };
}
