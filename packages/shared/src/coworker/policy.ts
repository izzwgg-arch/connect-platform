/**
 * THE SECURITY BOUNDARY.
 *
 * ⛔⛔ Everything the model wants to do passes through `decideToolCall()`. It is a
 * pure function: same inputs, same verdict, every time, with no network, no clock
 * of its own and no access to the model's reasoning. That is deliberate — a gate
 * you cannot exhaustively test is a gate you do not have. The test suite drives
 * every profile × every domain × every risk level and asserts the invariants below
 * hold for all of them.
 *
 * THE INVARIANTS THIS FILE EXISTS TO HOLD (from the mandate's non-negotiable list):
 *   #2  no silent active-desktop takeover
 *   #6  no bypassing approval policy
 *   #7  no destructive action because EXTERNAL CONTENT said so
 *   #8  no silently disabling Windows security controls
 *  #13  calling reliability is never traded away
 *
 * ⛔ THE ORDER OF THE CHECKS IS ITSELF THE SAFETY PROPERTY. Kill switch → spec
 * validity → hard prohibition → call-protection → DOMAIN DENY → injection
 * provenance → domain ASK → risk floor → approval. Reordering it changes what is
 * reachable. Two orderings in particular are load-bearing:
 *   - a domain the user set to "deny" is checked BEFORE provenance, so a denied
 *     domain denies OUTRIGHT rather than first showing a confirmation prompt;
 *   - provenance is checked BEFORE the domain ASK/allow, so a domain a user set to
 *     "allow" cannot be exercised by a website that talked the model into it.
 */

import {
  NEVER_AUTO_DOMAINS,
  resolveGrant,
  riskAtLeast,
  validateToolSpec,
  type CoworkerToolSpec,
  type PermissionDomain,
  type PermissionSettings,
  type RiskLevel,
} from "./types";
import type { Provenance } from "./trustBoundary";

export type PolicyVerdict = "allow" | "ask" | "deny";

export type PolicyDecision = {
  verdict: PolicyVerdict;
  /** Machine-readable reason. Audited; never shown raw to a user. */
  code: string;
  /**
   * Plain-English sentence for the approval prompt or the refusal notice.
   * ⛔ Written for a non-technical person (Phase 39): what, why, what changes.
   */
  message: string;
  /** Domains that forced an approval, for the consent UI to explain itself. */
  domains: readonly PermissionDomain[];
};

export type PolicyInput = {
  spec: CoworkerToolSpec;
  permissions: PermissionSettings;
  /**
   * Where the INSTRUCTION to run this tool came from. ⛔ Not where the data came
   * from — where the *authority* came from. See trustBoundary.ts.
   */
  provenance: Provenance;
  /** True when the user has already approved this exact action (hash-matched). */
  approved?: boolean;
  /** True while a Loopcom call is up. Gates anything that could disturb media. */
  callInProgress?: boolean;
  /** Master off switch: when false the coworker refuses everything. */
  coworkerEnabled?: boolean;
};

/**
 * ⛔⛔ ACTIONS NO PROFILE, NO OVERRIDE AND NO APPROVAL MAY EVER PERMIT.
 *
 * These are not "ask" — they are "no". A user cannot click through them and a model
 * cannot argue its way past them, because the harm is categorical and the coworker
 * is never the right actor. Each maps to a non-negotiable invariant.
 *
 * ⛔ Adding to this list is cheap; removing from it requires a human decision that
 * is recorded in CLAUDE.md. Never delete an entry to make a task pass.
 */
export const HARD_PROHIBITIONS: readonly { id: string; test: (s: CoworkerToolSpec) => boolean; why: string }[] = [
  {
    id: "security_product_tamper",
    test: (s) => /disable[_-]?(defender|antivirus|firewall)|stop[_-]?security|tamper[_-]?protection/i.test(s.name),
    why: "Loopcom will not switch off this computer's security protections, even to fix a problem.",
  },
  {
    id: "remote_access_listener",
    test: (s) => /(open|enable|start)[_-]?(rdp|vnc|remote[_-]?desktop|reverse[_-]?shell)/i.test(s.name),
    why: "Loopcom will not open this computer up to remote connections from the internet.",
  },
  {
    id: "arbitrary_remote_shell",
    test: (s) => s.category === "SHELL" && /^(remote|server)[_-]/i.test(s.name),
    why: "Loopcom support can run named checks on this computer, never free-form commands.",
  },
];

/** Domains whose use is inherently a security-posture change (invariant #8). */
const SECURITY_POSTURE_DOMAINS: readonly PermissionDomain[] = [
  "system.settings",
  "network.config",
  "windows.services",
  "software.install",
];

/**
 * ⛔ CALL RELIABILITY IS PRIORITY #1 (invariant #13). While a call is up, the
 * coworker may still think, read files and browse — but it may not touch the
 * machine's audio, network or service configuration, and it may not drive the
 * user's own desktop. A dropped customer call is a worse outcome than a delayed
 * background task, always.
 */
const DEFERRED_DURING_CALL: readonly PermissionDomain[] = [
  "network.config",
  "windows.services",
  "system.settings",
  "software.install",
  "desktop.active",
];

function list(domains: readonly PermissionDomain[]): string {
  return domains.join(", ");
}

export function decideToolCall(input: PolicyInput): PolicyDecision {
  const { spec, permissions, provenance } = input;

  /* 1 ─ master kill switch. Fails closed: undefined means "not enabled". */
  if (input.coworkerEnabled === false) {
    return {
      verdict: "deny",
      code: "coworker_disabled",
      message: "The AI Coworker is switched off.",
      domains: [],
    };
  }

  /* 2 ─ the spec itself must be well-formed. An MCP server that hands us a
        malformed or self-contradicting tool gets refused before anything else
        looks at it. */
  const validated = validateToolSpec(spec);
  if (!validated.ok) {
    return {
      verdict: "deny",
      code: "invalid_tool_spec",
      message: "That tool did not describe itself in a way Loopcom can check, so it was not run.",
      domains: [],
    };
  }

  /* 3 ─ hard prohibitions. No profile, no override, no approval. */
  for (const rule of HARD_PROHIBITIONS) {
    if (rule.test(spec)) {
      return { verdict: "deny", code: `prohibited:${rule.id}`, message: rule.why, domains: spec.domains };
    }
  }

  /* 4 ─ call protection. Checked BEFORE grants so an "allow" grant cannot let a
        network reconfiguration run in the middle of somebody's phone call. */
  if (input.callInProgress) {
    const clashing = spec.domains.filter((d) => DEFERRED_DURING_CALL.includes(d));
    if (clashing.length) {
      return {
        verdict: "deny",
        code: "deferred_during_call",
        message:
          "A phone call is in progress. Loopcom will not change audio, network or system settings while you are on a call — this can be run once the call ends.",
        domains: clashing,
      };
    }
  }

  /* 5 ─ DOMAIN DENY. ⛔ A domain the user set to "never" is a HARD no, and it is
        checked BEFORE provenance so that a denied domain denies outright rather
        than first showing an external-content confirmation prompt. Moving this
        earlier only ever makes more things deny — it can never weaken the gate. */
  const deniedEarly = spec.domains.filter((d) => resolveGrant(permissions, d) === "deny");
  if (deniedEarly.length) {
    return {
      verdict: "deny",
      code: "domain_denied",
      message: `Your Coworker permissions do not allow this (${list(deniedEarly)}). You can change this in Settings → AI Coworker → Permissions.`,
      domains: deniedEarly,
    };
  }

  /* 6 ─ PROVENANCE. ⛔⛔ THE PROMPT-INJECTION GATE (invariant #7).
        External content — a web page, an email, a document, an MCP tool result —
        is DATA. It may inform the model, and it may never confer authority. So an
        action whose instruction traces back to external content is held to a much
        harder line than the same action the user typed themselves. */
  if (provenance === "external") {
    if (spec.destructive || riskAtLeast(spec.risk, "HIGH")) {
      return {
        verdict: "deny",
        code: "external_content_cannot_authorize_high_risk",
        message:
          "Something Loopcom read on a website or in a document asked for this. Instructions found in content are never acted on — ask for it directly if you want it done.",
        domains: spec.domains,
      };
    }
    if (spec.exfiltrationCapable) {
      return {
        verdict: "deny",
        code: "external_content_cannot_send_data",
        message:
          "Something Loopcom read asked it to send information somewhere. Loopcom does not send data because a document told it to.",
        domains: spec.domains,
      };
    }
    // Everything else from external content still needs a human, even when the
    // profile would have allowed it outright.
    if (!input.approved) {
      return {
        verdict: "ask",
        code: "external_content_needs_confirmation",
        message: `Loopcom found an instruction while reading something, and wants your go-ahead before acting on it.`,
        domains: spec.domains,
      };
    }
  }

  /* 7 ─ remaining domain grants. Denies are already handled in step 5; here we
        only collect the domains that require an approval. */
  const asked: PermissionDomain[] = [];
  for (const domain of spec.domains) {
    if (resolveGrant(permissions, domain) === "ask") asked.push(domain);
  }

  /* 8 ─ the risk floor. Independent of domains: a DESTRUCTIVE action always faces
        a human, whatever the profile says, and however the domains resolved. */
  const needsApprovalForRisk = spec.destructive || spec.risk === "DESTRUCTIVE";
  const securityPosture = spec.domains.filter((d) => SECURITY_POSTURE_DOMAINS.includes(d));

  const mustAsk =
    asked.length > 0 ||
    needsApprovalForRisk ||
    spec.alwaysRequireApproval === true ||
    securityPosture.length > 0 ||
    spec.domains.some((d) => NEVER_AUTO_DOMAINS.includes(d));

  if (!mustAsk) {
    return { verdict: "allow", code: "allowed", message: "", domains: spec.domains };
  }

  /* 9 ─ an approval already given for THIS exact action satisfies the ask.
        ⛔ The caller proves that by hash — see approvalHash() — never by a boolean
        the model can set. */
  if (input.approved) {
    return { verdict: "allow", code: "approved_by_user", message: "", domains: spec.domains };
  }

  const reasonDomains = asked.length ? asked : securityPosture.length ? securityPosture : spec.domains;
  return {
    verdict: "ask",
    code: needsApprovalForRisk ? "destructive_needs_approval" : "domain_needs_approval",
    message: needsApprovalForRisk
      ? "This cannot be undone by Loopcom, so it needs your approval first."
      : `This needs your approval (${list(reasonDomains)}).`,
    domains: reasonDomains,
  };
}

/* ───────────────────── approval binding ─────────────────────────── */

/**
 * ⛔⛔ AN APPROVAL IS BOUND TO EXACT ARGUMENTS, NOT TO A TOOL NAME.
 *
 * Without this, "yes, delete that one temp file" becomes standing permission to
 * call the delete tool with any path for the rest of the task. The runtime hashes
 * (task, tool, canonical args) at the moment it asks, shows the user the rendered
 * action, and refuses to execute unless the hash still matches when the answer
 * comes back. This is the same discipline as the existing agent's `paramsHash`.
 *
 * ⛔ Deterministic key ordering matters: `{a:1,b:2}` and `{b:2,a:1}` are the same
 * action and must produce the same hash, or an attacker reorders keys to dodge a
 * denial. `canonicalJson` sorts recursively.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** The string an approval is bound to. Hashed by the caller with node:crypto. */
export function approvalSubject(taskId: string, toolName: string, args: unknown): string {
  return `coworker:v1:${taskId}:${toolName}:${canonicalJson(args)}`;
}

/* ─────────────────── escalation levels (Phase 20) ───────────────── */

export const SUPPORT_LEVELS = ["LEVEL_1", "LEVEL_2", "LEVEL_3"] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

const LEVEL_MAX_RISK: Record<SupportLevel, RiskLevel> = {
  LEVEL_1: "READ_ONLY",
  LEVEL_2: "MEDIUM",
  LEVEL_3: "HIGH",
};

/**
 * What a support technician may drive at each level.
 *
 * ⛔ A technician can never silently escalate: the level is granted by the person
 * at the machine, and this function only ever narrows what the local policy already
 * permits. It is applied IN ADDITION to `decideToolCall`, never instead of it.
 * ⛔ No level reaches DESTRUCTIVE, and no level grants `desktop.active` implicitly —
 * Level 3 still requires its own explicit local consent (invariant #2).
 */
export function decideSupportAction(level: SupportLevel, spec: CoworkerToolSpec): PolicyDecision {
  if (spec.destructive || spec.risk === "DESTRUCTIVE") {
    return {
      verdict: "deny",
      code: "support_cannot_run_destructive",
      message: "Loopcom support cannot run actions that permanently remove or overwrite your data.",
      domains: spec.domains,
    };
  }
  if (!riskAtLeast(LEVEL_MAX_RISK[level], spec.risk)) {
    return {
      verdict: "deny",
      code: "support_level_too_low",
      message: "Loopcom support does not have your permission for this yet.",
      domains: spec.domains,
    };
  }
  if (spec.domains.includes("desktop.active") && level !== "LEVEL_3") {
    return {
      verdict: "deny",
      code: "support_level_too_low_for_desktop",
      message: "Watching or controlling your screen needs your explicit permission first.",
      domains: ["desktop.active"],
    };
  }
  return { verdict: "allow", code: "support_level_ok", message: "", domains: spec.domains };
}
