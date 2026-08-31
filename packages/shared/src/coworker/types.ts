/**
 * The vocabulary of the Loopcom Coworker: risk, categories, tools, permissions.
 *
 * ⛔⛔ THE GOVERNING RULE OF THIS WHOLE SUBSYSTEM: THE MODEL IS NOT THE SECURITY
 * BOUNDARY. A tool is not "safe" because the model was told to be careful, and a
 * tool is not "allowed" because the model asked nicely. Every action carries
 * declared, deterministic metadata, and `policy.ts` decides from that metadata
 * alone — it never reads the model's reasoning, its confidence, or its prose.
 *
 * This mirrors a pattern this codebase already paid for three times:
 *   - apps/desktop/src/phoneSetup/capability.ts  (fixed op allowlist, creds by ref)
 *   - apps/api/src/supportWorkbench.ts           (shape → allowlist → secrets → rules)
 *   - apps/agent/src/tools/toolRegistry.ts       (minRole tiers, tenant-key stripping)
 *
 * ⛔ Do NOT introduce a fourth, differently-shaped gate. Extend these types.
 */

/* ────────────────────────────── risk ────────────────────────────── */

/**
 * How much damage a single call can do.
 *
 * ⛔ Risk describes the ACTION, never the caller. "Delete a file" is DESTRUCTIVE
 * whether an admin or the model asked for it; who may do it is a separate question
 * answered by the permission profile. Conflating the two is how "autonomous mode"
 * quietly becomes "unlimited authority over the machine".
 */
export const RISK_LEVELS = ["READ_ONLY", "LOW", "MEDIUM", "HIGH", "DESTRUCTIVE"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const RISK_ORDER: Record<RiskLevel, number> = {
  READ_ONLY: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  DESTRUCTIVE: 4,
};

export function riskAtLeast(actual: RiskLevel, floor: RiskLevel): boolean {
  return RISK_ORDER[actual] >= RISK_ORDER[floor];
}

export function isRiskLevel(v: unknown): v is RiskLevel {
  return typeof v === "string" && (RISK_LEVELS as readonly string[]).includes(v);
}

/* ──────────────────────────── categories ────────────────────────── */

/**
 * Where a tool executes. This drives which permission domain gates it and which
 * execution surface runs it (in-process, worker, browser, isolated desktop).
 */
export const TOOL_CATEGORIES = [
  "LOOPCOM_NATIVE",
  "MCP",
  "FILESYSTEM",
  "SHELL",
  "WINDOWS",
  "BROWSER",
  "COMPUTER_USE",
  "DIAGNOSTIC",
  "SUPPORT",
  "NETWORK",
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/**
 * ⛔ THE EXECUTION HIERARCHY, AS DATA. Lower number = preferred. The planner must
 * pick the lowest-numbered surface that can do the job: a structured API beats
 * driving a mouse, every time. Mouse-and-keyboard automation against a machine that
 * has a real API for the same job is fragile, unauditable and unreviewable.
 */
export const CATEGORY_PREFERENCE: Record<ToolCategory, number> = {
  LOOPCOM_NATIVE: 1,
  MCP: 2,
  DIAGNOSTIC: 2,
  SUPPORT: 2,
  FILESYSTEM: 3,
  NETWORK: 3,
  WINDOWS: 4,
  SHELL: 4,
  BROWSER: 5,
  COMPUTER_USE: 6,
};

/* ────────────────────── permission domains ──────────────────────── */

/**
 * The things a user grants or withholds. Deliberately phrased as capabilities a
 * non-technical person can reason about, because these strings drive the consent UI.
 */
export const PERMISSION_DOMAINS = [
  "files.read",
  "files.write",
  "files.delete",
  "shell",
  "software.install",
  "browser",
  "browser.download",
  "browser.upload",
  "clipboard",
  "credentials",
  "mcp",
  "messages.send",
  "external.post",
  "system.settings",
  "network.config",
  "windows.services",
  "desktop.active",
  "diagnostics",
  "remediation",
  "loopcom.admin",
] as const;
export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];

export function isPermissionDomain(v: unknown): v is PermissionDomain {
  return typeof v === "string" && (PERMISSION_DOMAINS as readonly string[]).includes(v);
}

/* ────────────────────────── tool spec ───────────────────────────── */

/**
 * Everything the policy engine needs to judge a tool, declared by the tool itself.
 *
 * ⛔ EVERY FIELD IS REQUIRED ON PURPOSE (no optional risk, no optional domain). A
 * tool author who forgets to declare risk gets a compile error, not a default of
 * "probably fine". `validateToolSpec` re-checks at runtime because MCP servers hand
 * us specs at run time that TypeScript never saw.
 */
export type CoworkerToolSpec = {
  /** Stable id. MCP tools are namespaced `mcp:<serverId>:<tool>` — see mcpToolName(). */
  name: string;
  description: string;
  category: ToolCategory;
  risk: RiskLevel;
  /** Domains the caller must hold. ALL of them — this is an AND, never an OR. */
  domains: readonly PermissionDomain[];
  /** True when the effect cannot be undone by the coworker itself. */
  destructive: boolean;
  /** True when the tool reaches the network (SSRF surface, data egress surface). */
  networked: boolean;
  /**
   * True when this tool can carry data OFF the machine or in front of another human
   * (send an email, post a form, upload a file). Used by the injection defense: an
   * exfiltration-capable tool triggered by external content is refused outright.
   */
  exfiltrationCapable: boolean;
  /** Hard ceiling in ms. The runtime kills the call and its process tree at this. */
  timeoutMs: number;
  /** How many times the runtime may retry on a transient failure. 0 = never. */
  maxRetries: number;
  /**
   * Forces an approval prompt regardless of profile. ⛔ A tool may raise its own
   * floor but can never lower the profile's — see `policy.ts`.
   */
  alwaysRequireApproval?: boolean;
};

export type ToolSpecProblem = { field: string; problem: string };

const MAX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes. Nothing legitimate needs longer.
const MAX_RETRIES = 5;

/**
 * Runtime validation of a spec. Used for MCP-supplied tools, which arrive from an
 * untrusted server and must never be trusted to declare themselves harmless.
 */
export function validateToolSpec(spec: unknown): { ok: true; spec: CoworkerToolSpec } | { ok: false; problems: ToolSpecProblem[] } {
  const problems: ToolSpecProblem[] = [];
  const s = spec as Partial<CoworkerToolSpec> | null;

  if (!s || typeof s !== "object") return { ok: false, problems: [{ field: "spec", problem: "not_an_object" }] };

  if (typeof s.name !== "string" || !s.name.trim()) problems.push({ field: "name", problem: "missing" });
  else if (s.name.length > 200) problems.push({ field: "name", problem: "too_long" });
  else if (!/^[A-Za-z0-9_:.-]+$/.test(s.name)) problems.push({ field: "name", problem: "illegal_characters" });

  if (typeof s.description !== "string" || !s.description.trim()) problems.push({ field: "description", problem: "missing" });

  if (!s.category || !(TOOL_CATEGORIES as readonly string[]).includes(s.category)) {
    problems.push({ field: "category", problem: "unknown_category" });
  }
  if (!isRiskLevel(s.risk)) problems.push({ field: "risk", problem: "unknown_risk" });

  if (!Array.isArray(s.domains)) problems.push({ field: "domains", problem: "missing" });
  else {
    for (const d of s.domains) {
      if (!isPermissionDomain(d)) problems.push({ field: "domains", problem: `unknown_domain:${String(d)}` });
    }
  }

  if (typeof s.destructive !== "boolean") problems.push({ field: "destructive", problem: "missing" });
  if (typeof s.networked !== "boolean") problems.push({ field: "networked", problem: "missing" });
  if (typeof s.exfiltrationCapable !== "boolean") problems.push({ field: "exfiltrationCapable", problem: "missing" });

  if (typeof s.timeoutMs !== "number" || !Number.isFinite(s.timeoutMs) || s.timeoutMs <= 0) {
    problems.push({ field: "timeoutMs", problem: "missing_or_invalid" });
  } else if (s.timeoutMs > MAX_TIMEOUT_MS) {
    problems.push({ field: "timeoutMs", problem: "exceeds_maximum" });
  }

  if (typeof s.maxRetries !== "number" || !Number.isInteger(s.maxRetries) || s.maxRetries < 0) {
    problems.push({ field: "maxRetries", problem: "missing_or_invalid" });
  } else if (s.maxRetries > MAX_RETRIES) {
    problems.push({ field: "maxRetries", problem: "exceeds_maximum" });
  }

  // ⛔ COHERENCE CHECKS. A spec can be individually well-formed and still lie about
  // itself in a way that would weaken the gate. These catch a hostile MCP server
  // declaring "delete everything" as READ_ONLY with no domains.
  if (s.destructive === true && isRiskLevel(s.risk) && !riskAtLeast(s.risk, "HIGH")) {
    problems.push({ field: "risk", problem: "destructive_tool_must_be_high_or_destructive" });
  }
  if (Array.isArray(s.domains) && s.domains.length === 0 && isRiskLevel(s.risk) && s.risk !== "READ_ONLY") {
    problems.push({ field: "domains", problem: "non_read_only_tool_must_declare_a_domain" });
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, spec: s as CoworkerToolSpec };
}

/* ──────────────────── permission profiles ───────────────────────── */

export const PERMISSION_PROFILES = ["SAFE", "TRUSTED", "AUTONOMOUS", "CUSTOM"] as const;
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

export type PermissionGrant =
  /** Runs without asking. */
  | "allow"
  /** Runs only after the user approves THIS action. */
  | "ask"
  /** Never runs. */
  | "deny";

export type PermissionSettings = {
  profile: PermissionProfile;
  /** Per-domain overrides. Always consulted; CUSTOM simply has no baseline. */
  overrides: Partial<Record<PermissionDomain, PermissionGrant>>;
};

/**
 * The built-in profiles.
 *
 * ⛔⛔ READ THE `AUTONOMOUS` COLUMN CAREFULLY. Even at the most permissive profile,
 * `credentials`, `software.install`, `system.settings`, `network.config`,
 * `windows.services`, `desktop.active` and `loopcom.admin` are still `ask`, and
 * `files.delete` and `external.post` are still `ask`. "Autonomous" means the
 * coworker does not interrupt you for routine, reversible work — it does NOT mean
 * it may weaken Windows security, install software, or spend money unattended.
 * Non-negotiable invariants #2, #7, #8.
 */
const PROFILE_BASELINE: Record<Exclude<PermissionProfile, "CUSTOM">, Record<PermissionDomain, PermissionGrant>> = {
  SAFE: {
    "files.read": "allow",
    "files.write": "ask",
    "files.delete": "ask",
    shell: "ask",
    "software.install": "deny",
    browser: "ask",
    "browser.download": "ask",
    "browser.upload": "ask",
    clipboard: "ask",
    credentials: "ask",
    mcp: "ask",
    "messages.send": "ask",
    "external.post": "ask",
    "system.settings": "deny",
    "network.config": "deny",
    "windows.services": "deny",
    "desktop.active": "ask",
    diagnostics: "allow",
    remediation: "ask",
    "loopcom.admin": "ask",
  },
  TRUSTED: {
    "files.read": "allow",
    "files.write": "allow",
    "files.delete": "ask",
    shell: "ask",
    "software.install": "ask",
    browser: "allow",
    "browser.download": "allow",
    "browser.upload": "ask",
    clipboard: "allow",
    credentials: "ask",
    mcp: "allow",
    "messages.send": "ask",
    "external.post": "ask",
    "system.settings": "ask",
    "network.config": "ask",
    "windows.services": "ask",
    "desktop.active": "ask",
    diagnostics: "allow",
    remediation: "ask",
    "loopcom.admin": "ask",
  },
  AUTONOMOUS: {
    "files.read": "allow",
    "files.write": "allow",
    "files.delete": "ask",
    shell: "allow",
    "software.install": "ask",
    browser: "allow",
    "browser.download": "allow",
    "browser.upload": "allow",
    clipboard: "allow",
    credentials: "ask",
    mcp: "allow",
    "messages.send": "allow",
    "external.post": "ask",
    "system.settings": "ask",
    "network.config": "ask",
    "windows.services": "ask",
    "desktop.active": "ask",
    diagnostics: "allow",
    remediation: "allow",
    "loopcom.admin": "ask",
  },
};

/**
 * ⛔⛔ THE FLOOR THAT NO PROFILE AND NO OVERRIDE MAY CROSS.
 *
 * A user (or a compromised settings file, or a model that talked its way into
 * writing settings) cannot set these to "allow". The strongest a grant may be for
 * these domains is "ask". This is the code form of invariants #2, #6 and #8 — the
 * ones that say a human must consent to desktop takeover, credential access and
 * anything that weakens the machine's security posture.
 *
 * `resolveGrant()` clamps to this AFTER applying overrides, so the order of
 * settings edits can never matter.
 */
export const NEVER_AUTO_DOMAINS: readonly PermissionDomain[] = [
  "credentials",
  "desktop.active",
  "software.install",
  "system.settings",
  "network.config",
  "windows.services",
  "loopcom.admin",
] as const;

export const DEFAULT_PERMISSIONS: PermissionSettings = { profile: "SAFE", overrides: {} };

/**
 * Resolve one domain to a grant, applying: baseline → override → hard floor.
 *
 * ⛔ CUSTOM has NO baseline and defaults every unset domain to "ask", never
 * "allow". An unconfigured capability must interrupt, not proceed — fail closed.
 */
export function resolveGrant(settings: PermissionSettings, domain: PermissionDomain): PermissionGrant {
  const override = settings.overrides?.[domain];
  let grant: PermissionGrant;

  if (override) {
    grant = override;
  } else if (settings.profile === "CUSTOM") {
    grant = "ask";
  } else {
    grant = PROFILE_BASELINE[settings.profile]?.[domain] ?? "ask";
  }

  // The floor. Applied last so nothing can get underneath it.
  if (grant === "allow" && NEVER_AUTO_DOMAINS.includes(domain)) return "ask";
  return grant;
}

/** Public read of a profile's baseline, for the settings UI. */
export function profileBaseline(profile: Exclude<PermissionProfile, "CUSTOM">): Record<PermissionDomain, PermissionGrant> {
  return { ...PROFILE_BASELINE[profile] };
}
