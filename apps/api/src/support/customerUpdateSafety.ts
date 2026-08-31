/**
 * WHAT A CUSTOMER IS ALLOWED TO BE TOLD.
 *
 * A Claude agent investigates a support ticket and writes a technical report for
 * US. This gate decides whether the plain-English rewrite of that report is safe
 * to put in front of the person who filed it.
 *
 * ⛔⛔ IT REFUSES, IT DOES NOT REDACT. A message that had a secret cut out of it
 * is a message we already know was wrong, being sent on the hope that the
 * cutting was complete. There is no cost to holding one back — it waits for a
 * human — and there is no undo on a sent one.
 *
 * Pure: no I/O, no clock, no network. Everything it needs is an argument, so the
 * whole space can be driven by the stress suite.
 *
 * Izzy's brief, 2026-08-31: "no technical talk, no secrets, no potential
 * backhand stuff. Just explain in plain English what happened and how we fixed
 * it, and tell them to test it."
 */

export type SafetyIssue = {
  /** Why it was refused, in words a person can act on. */
  kind:
    | "secret"
    | "other_customer"
    | "internal_detail"
    | "blame"
    | "unearned_fix"
    | "shape"
    | "empty";
  detail: string;
  /** The matched text, trimmed. Kept for the operator, never shown to a customer. */
  evidence: string;
};

export type SafetyVerdict = {
  ok: boolean;
  issues: SafetyIssue[];
};

const MAX_CHARS = 1400;
const MIN_CHARS = 40;

/**
 * ⛔ Anything here would be a real leak. Ordered roughly by how bad it is.
 * Every pattern carries a plain-English `detail` because the operator reading a
 * held-back message needs to know what to change, not a regex.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/, "an API key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a JSON web token"],
  [/\b(?:password|passwd|secret|api[_ -]?key|token|bearer)\b\s*[:=]\s*\S+/i, "a credential"],
  [/\b(?:postgres(?:ql)?|mysql|redis|mongodb):\/\//i, "a database connection string"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bPT[a-f0-9]{20,}/i, "a SignalWire token"],
];

/**
 * Things a customer has no business seeing and would never need. Deliberately
 * NOT here: "voicemail", "extension", "phone", "number", "app", "call" — that is
 * the customer's OWN vocabulary and banning it makes every honest message fail.
 */
const INTERNAL_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:asterisk|vitalpbx|pjsip|freepbx|kamailio|coturn)\b/i, "the name of a system we run"],
  [/\b(?:prisma|postgres(?:ql)?|psql|redis|docker|nginx|systemd|kubernetes|bullmq)\b/i, "infrastructure we run"],
  [/\b(?:localhost|127\.0\.0\.1)\b/, "an internal address"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/, "an IP address"],
  [/\b(?:apps|packages|scripts|tools)\/[a-z0-9._-]+\/[a-z0-9._/-]+/i, "a file path"],
  [/[A-Za-z]:\\[\\A-Za-z0-9._ -]+/, "a file path"],
  [/(?:^|\s)\/(?:var|opt|etc|root|usr|home)\/[a-z0-9._/-]+/i, "a file path"],
  [/\b[0-9a-f]{7,40}\b(?=\s*(?:commit|sha|revision)|\s*$)/i, "a code revision"],
  [/\bcommit\s+[0-9a-f]{7,}/i, "a code revision"],
  [/\b(?:git|ssh|scp|curl|grep|sed|awk)\s+[a-z-]+/i, "a command we ran"],
  [/```/, "a block of code"],
  [/\b(?:stack ?trace|null pointer|undefined is not|TypeError|ReferenceError)\b/i, "an error dump"],
  [/\b(?:CLAUDE\.md|README|schema\.prisma|package\.json|\.env)\b/i, "one of our internal files"],
  [/\b(?:deploy(?:ed|ment)?|rollback|container|staging|production server|codebase|repo(?:sitory)?)\b/i, "how we ship changes"],
  [/\b(?:database|table|column|query|migration|endpoint|webhook|cron)\b/i, "internals of how it is built"],
  [/\bext(?:ension)?\s*\d{2,4}\s+(?:on|of|belonging to)\s+\w/i, "another account's extension"],
  // ⛔ EVERYTHING BELOW WAS ADDED 2026-08-31, after the stress suite fed the gate
  // a REAL agent report and the whole thing passed clean. Each pattern is
  // something that report actually contained. A gate is only ever as good as the
  // text somebody has fed it — invented examples agree with the rules you wrote.
  [/\bapp-[a-z]+-\d+\b/i, "the name of a machine we run"],
  [/\b(?:build-)?commit\b/i, "a code revision"],
  [/\.(?:next|env|git|build-commit)\b/i, "one of our internal files"],
  // "restored 53 addresses across 21 tenants" — a count of other accounts is
  // both a technical detail AND a statement about other customers.
  [/\b\d+\s+(?:tenants?|accounts?|customers?|companies|businesses|mailboxes)\b/i, "how many accounts were involved"],
  [/@example\.com\b/i, "a placeholder address"],
  // 22:50:25Z is a log timestamp. A note to a customer says "this morning".
  [/\b\d{2}:\d{2}:\d{2}Z?\b/, "a log timestamp"],
  // WE write "ext 102"; the customer writes "extension 102". The abbreviation is
  // ours, so it reads as internal shorthand in a customer-facing message.
  [/\bext\.?\s*\d{2,4}\b/i, "internal shorthand"],
];

/**
 * ⛔ "No potential backhand stuff" — Izzy. These are the sentences that read
 * fine in the moment and badly when forwarded, screenshotted, or produced in a
 * dispute. An admission of a long-running fault is not ours to make on the
 * platform's behalf in an automated message; a person can choose to say it.
 */
const BLAME_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:our|a|the)\s+(?:bug|defect|fault|mistake|error|oversight|regression)\b/i, "an admission of fault"],
  [/\bwe\s+(?:broke|lost|failed to|never|forgot|missed|messed up|screwed)\b/i, "an admission of fault"],
  [/\b(?:has|have|had)\s+been\s+(?:broken|failing|down|wrong)\s+(?:for|since)\b/i, "how long it was wrong"],
  // ⛔ "for two months" slipped through the first version: the count was matched
  // as \d+ only, and people write durations in words far more often than digits.
  [/\b(?:for|over|across)\s+(?:\d+|a couple of|a few|several|many|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:seconds|minutes|hours|days|weeks|months|years)\b/i, "how long it was wrong"],
  [/\bnobody\s+(?:noticed|caught|saw|checked)\b/i, "that it went unnoticed"],
  [/\b(?:other|another|several|many|multiple)\s+(?:customers?|accounts?|businesses|companies)\b/i, "other customers"],
  // ⛔ "a similar issue affecting multiple accounts" got through the first cut:
  // the pattern matched the past tense only. Caught on a live run, 2026-08-31.
  [/\b(?:affect(?:ed|ing|s)?|impact(?:ed|ing|s)?)\s+(?:all|every|other|multiple|several|many)\b/i, "other customers"],
  [/\b(?:compensat|refund|credit your account|liab|negligen|lawsuit|legal)/i, "money or liability"],
  [/\bshould\s+(?:never|not)\s+have\b/i, "an admission of fault"],
];

/**
 * ⛔⛔ CLAIMING A FIX THAT NEVER HAPPENED.
 *
 * Caught on the FIRST real ticket to go through the live loop, 2026-08-31. The
 * agent's report opened *"Investigated and reported only. Nothing was changed on
 * Connect, the PBX, or the customer's account."* — and the rewrite told the
 * customer **"We've made some adjustments, and it should now be correctly
 * hidden."** That is a false statement, in writing, to a customer.
 *
 * The investigating agent CANNOT change anything — its tools forbid it — so in
 * this pipeline a claim of a change is always untrue. It is enforced here rather
 * than merely discouraged in the prompt, because the prompt is a request and
 * this is a promise. `changeWasMade` exists so the day a real fix rides this
 * loop, the claim becomes allowed for that message only.
 */
const FIX_CLAIM_PATTERNS: Array<[RegExp, string]> = [
  [/\bwe(?:'ve|'ve| have| had)?\s+(?:just\s+)?(?:fixed|resolved|corrected|repaired|sorted)\b/i, "that we fixed it"],
  [/\bwe(?:'ve|'ve| have)?\s+(?:just\s+)?(?:made|applied|pushed|rolled out)\s+(?:some\s+)?(?:a\s+)?(?:adjustments?|changes?|updates?|fix(?:es)?)\b/i, "that we changed something"],
  // ⛔ "We turned it on for you" — the object sits between the verb and the
  // particle, so a contiguous "turned on" misses it. Match the verb alone.
  [/\bwe(?:'ve|'ve| have)?\s+(?:just\s+)?(?:adjusted|changed|updated|switched|enabled|turned|moved|set|re-?configured)\b/i, "that we changed something"],
  // ⛔ "the issue has been addressed" reached a live run before this listed
  // "addressed" — the model reaches for a synonym the moment the obvious verbs
  // are refused, so the list has to cover the polite ones too.
  // "It has NOW been fixed" — the adverb can sit either side of "been".
  [/\b(?:has|have|had)\s+(?:now\s+)?been\s+(?:now\s+)?(?:fixed|resolved|corrected|updated|changed|addressed|handled|taken care of|sorted)\b/i, "that it was fixed"],
  [/\bwe(?:'ve| have)?\s+(?:since\s+)?(?:addressed|handled|taken care of)\b/i, "that we fixed it"],
  // "That issue is resolved" needs the optional noun between the determiner and
  // the verb — the first version demanded them adjacent and missed it.
  [/\b(?:this|that|the|it)(?:\s+(?:issue|problem|fault|trouble))?\s+(?:is|has been)\s+(?:now\s+)?(?:fixed|resolved|sorted|corrected)\b/i, "that it was fixed"],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Names of OTHER companies on the platform. A support message to one customer
 * that mentions another is the single worst thing this gate can let through.
 *
 * ⛔ Short and brand-shaped names are skipped on purpose: "Connect" and
 * "Loopcom" are both real tenant names AND ordinary words in our own product's
 * vocabulary, so matching them would refuse every honest message. Anything under
 * 4 characters is likewise too generic to match safely.
 */
export function otherCustomerHits(text: string, ownTenantName: string, allTenantNames: string[]): string[] {
  const own = String(ownTenantName ?? "").trim().toLowerCase();
  const brandish = /^(connect|loopcom|connect communications|loopcom platform|loopcom demo)$/i;
  const hits: string[] = [];
  for (const raw of allTenantNames ?? []) {
    const name = String(raw ?? "").trim();
    if (name.length < 4) continue;
    if (name.toLowerCase() === own) continue;
    if (brandish.test(name)) continue;
    const re = new RegExp(`\\b${escape(name)}\\b`, "i");
    const m = re.exec(text);
    if (m) hits.push(m[0]);
  }
  return hits;
}

/**
 * The whole decision. `allTenantNames` is every live company on the platform —
 * pass it, or the cross-customer check silently does nothing.
 */
export function reviewCustomerMessage(input: {
  text: string;
  tenantName: string;
  allTenantNames?: string[];
  /**
   * Did anything actually change? ⛔ Defaults to FALSE, because the investigating
   * agent is forbidden from changing anything — so unless a caller can prove
   * otherwise, a message claiming a fix is refused.
   */
  changeWasMade?: boolean;
}): SafetyVerdict {
  const text = String(input.text ?? "");
  const issues: SafetyIssue[] = [];
  const add = (kind: SafetyIssue["kind"], detail: string, evidence: string) =>
    issues.push({ kind, detail, evidence: evidence.slice(0, 80) });

  const trimmed = text.trim();
  if (!trimmed) {
    add("empty", "the message is empty", "");
    return { ok: false, issues };
  }
  if (trimmed.length < MIN_CHARS) add("shape", "the message is too short to be useful", trimmed);
  if (trimmed.length > MAX_CHARS) add("shape", "the message is too long for a support note", `${trimmed.length} characters`);

  for (const [re, detail] of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) add("secret", `it contains ${detail}`, m[0]);
  }
  for (const [re, detail] of INTERNAL_PATTERNS) {
    const m = re.exec(text);
    if (m) add("internal_detail", `it mentions ${detail}`, m[0]);
  }
  for (const [re, detail] of BLAME_PATTERNS) {
    const m = re.exec(text);
    if (m) add("blame", `it volunteers ${detail}`, m[0]);
  }
  if (!input.changeWasMade) {
    for (const [re, detail] of FIX_CLAIM_PATTERNS) {
      const m = re.exec(text);
      if (m) add("unearned_fix", `it claims ${detail}, and nothing was changed`, m[0]);
    }
  }
  for (const hit of otherCustomerHits(text, input.tenantName, input.allTenantNames ?? [])) {
    add("other_customer", "it names another company on the platform", hit);
  }

  return { ok: issues.length === 0, issues };
}

/**
 * The instruction given to the rewriting model. Exported so the stress suite can
 * assert the rules are actually stated — a gate that refuses everything because
 * the prompt never asked for the right thing is a broken loop, not a safe one.
 */
export const REWRITE_SYSTEM_PROMPT = [
  "You turn an internal engineering report into a short message for the customer who reported the problem.",
  "",
  "You are writing AS the phone company, to a small-business owner who is not technical.",
  "",
  "⛔ THE MOST IMPORTANT RULE: this was an INVESTIGATION, not a repair. Nobody has changed anything.",
  "NEVER say we fixed it, resolved it, adjusted it, updated it, changed it, or made any change —",
  "unless the report explicitly states that a change WAS made. Saying so otherwise is telling the",
  "customer something untrue, and it is the one mistake that matters most here.",
  "",
  "WRITE:",
  "- What they reported, in their own terms.",
  "- What we found, in one or two plain sentences.",
  "- What happens next: either that it is working and they should try it, or that we are on it and",
  "  they do not need to do anything, or what we need from them.",
  "- Then ask them to reply here and tell us whether it looks right to them.",
  "",
  "NEVER INCLUDE:",
  "- Technical words of any kind: no server, database, deploy, code, commit, container, file, log, API.",
  "- The names of any systems or tools we run.",
  "- Any other customer or company. Only ever refer to this customer's own account.",
  "- Any password, key, token, address or file path.",
  "- How long the problem existed, how many people it affected, or whose fault it was.",
  "- Apologising for a fault, admitting a defect, or anything about money, credit or liability.",
  "",
  "STYLE: four sentences or fewer. Warm, direct, no jargon, no bullet points, no headings.",
  "Do not invent anything the report does not say. If the report says the problem is NOT fixed,",
  "say plainly that we are still working on it and they do not need to do anything yet.",
].join("\n");

/**
 * The last line of defence for the operator's eyes: a one-line summary of why a
 * message is being held. Plain English on purpose — this appears on the support
 * desk, and "3 issues" tells nobody anything.
 */
export function describeIssues(issues: SafetyIssue[]): string {
  if (!issues.length) return "";
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const i of issues) {
    if (seen.has(i.detail)) continue;
    seen.add(i.detail);
    parts.push(i.detail);
  }
  return `Held back because ${parts.join("; ")}.`;
}
