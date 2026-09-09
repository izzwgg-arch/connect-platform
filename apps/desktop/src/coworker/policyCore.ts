/**
 * The Coworker's policy core, ON THE CUSTOMER'S COMPUTER.
 *
 * ⛔⛔ THIS IS THE SECURITY BOUNDARY FOR THE MACHINE. The agent on the server
 * proposes tool calls; this module decides — from the tool's DECLARED metadata,
 * the person's profile and the state of the phone — whether a call may run,
 * must ask, or is refused. It never reads the model's reasoning. The server,
 * the portal page and the model could all be compromised together and the
 * verdicts here would not change.
 *
 * ⛔ THIS IS A COPY of the pure parts of packages/shared/src/coworker/
 * {types,policy,paths,redaction}.ts. The desktop app bundles nothing from the
 * monorepo (electron-builder packs dist/** only), so the lists live here twice
 * and `coworkerHands.test.ts` reads the shared files and fails if the two ever
 * disagree on: PERMISSION_DOMAINS, NEVER_AUTO_DOMAINS, the three profile
 * baselines, HARD_PROHIBITIONS ids, and the order of decideToolCall's checks.
 *
 * ⛔ Pure. No fs, no os, no Electron. The runtime calls into this with facts.
 */

/* ────────────────────────────── risk ────────────────────────────── */

export const RISK_LEVELS = ["READ_ONLY", "LOW", "MEDIUM", "HIGH", "DESTRUCTIVE"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
const RISK_ORDER: Record<RiskLevel, number> = { READ_ONLY: 0, LOW: 1, MEDIUM: 2, HIGH: 3, DESTRUCTIVE: 4 };
export function riskAtLeast(actual: RiskLevel, floor: RiskLevel): boolean { return RISK_ORDER[actual] >= RISK_ORDER[floor]; }

export const TOOL_CATEGORIES = ["LOOPCOM_NATIVE", "MCP", "FILESYSTEM", "SHELL", "WINDOWS", "BROWSER", "COMPUTER_USE", "DIAGNOSTIC", "SUPPORT", "NETWORK"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/* ────────────────────── permission domains ──────────────────────── */

export const PERMISSION_DOMAINS = [
  "files.read", "files.write", "files.delete", "shell", "software.install", "browser", "browser.download", "browser.upload",
  "clipboard", "credentials", "mcp", "messages.send", "external.post", "system.settings", "network.config", "windows.services",
  "desktop.active", "diagnostics", "remediation", "loopcom.admin",
] as const;
export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];
export function isPermissionDomain(v: unknown): v is PermissionDomain { return typeof v === "string" && (PERMISSION_DOMAINS as readonly string[]).includes(v); }

export type CoworkerToolSpec = {
  name: string;
  description: string;
  category: ToolCategory;
  risk: RiskLevel;
  domains: readonly PermissionDomain[];
  destructive: boolean;
  networked: boolean;
  exfiltrationCapable: boolean;
  timeoutMs: number;
  maxRetries: number;
  alwaysRequireApproval?: boolean;
};

export const PERMISSION_PROFILES = ["SAFE", "TRUSTED", "AUTONOMOUS", "CUSTOM"] as const;
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];
export type PermissionGrant = "allow" | "ask" | "deny";
export type PermissionSettings = { profile: PermissionProfile; overrides: Partial<Record<PermissionDomain, PermissionGrant>> };

/** ⛔ Byte-for-byte the shared baselines (guarded by test). */
export const PROFILE_BASELINE: Record<Exclude<PermissionProfile, "CUSTOM">, Record<PermissionDomain, PermissionGrant>> = {
  SAFE: {
    "files.read": "allow", "files.write": "ask", "files.delete": "ask", shell: "ask", "software.install": "deny", browser: "ask",
    "browser.download": "ask", "browser.upload": "ask", clipboard: "ask", credentials: "ask", mcp: "ask", "messages.send": "ask",
    "external.post": "ask", "system.settings": "deny", "network.config": "deny", "windows.services": "deny", "desktop.active": "ask",
    diagnostics: "allow", remediation: "ask", "loopcom.admin": "ask",
  },
  TRUSTED: {
    "files.read": "allow", "files.write": "allow", "files.delete": "ask", shell: "ask", "software.install": "ask", browser: "allow",
    "browser.download": "allow", "browser.upload": "ask", clipboard: "allow", credentials: "ask", mcp: "allow", "messages.send": "ask",
    "external.post": "ask", "system.settings": "ask", "network.config": "ask", "windows.services": "ask", "desktop.active": "ask",
    diagnostics: "allow", remediation: "ask", "loopcom.admin": "ask",
  },
  AUTONOMOUS: {
    "files.read": "allow", "files.write": "allow", "files.delete": "ask", shell: "allow", "software.install": "ask", browser: "allow",
    "browser.download": "allow", "browser.upload": "allow", clipboard: "allow", credentials: "ask", mcp: "allow", "messages.send": "allow",
    "external.post": "ask", "system.settings": "ask", "network.config": "ask", "windows.services": "ask", "desktop.active": "ask",
    diagnostics: "allow", remediation: "allow", "loopcom.admin": "ask",
  },
};

/** ⛔⛔ The floor no profile and no override may cross: never "allow". */
export const NEVER_AUTO_DOMAINS: readonly PermissionDomain[] = [
  "credentials", "desktop.active", "software.install", "system.settings", "network.config", "windows.services", "loopcom.admin",
] as const;

export function normalizePermissions(raw: unknown): PermissionSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as { profile?: unknown; overrides?: unknown };
  const profile = typeof r.profile === "string" && (PERMISSION_PROFILES as readonly string[]).includes(r.profile) ? (r.profile as PermissionProfile) : "SAFE";
  const overrides: PermissionSettings["overrides"] = {};
  if (r.overrides && typeof r.overrides === "object") {
    for (const [k, v] of Object.entries(r.overrides as Record<string, unknown>)) {
      if (isPermissionDomain(k) && (v === "allow" || v === "ask" || v === "deny")) overrides[k] = v;
    }
  }
  return { profile, overrides };
}

export function resolveGrant(settings: PermissionSettings, domain: PermissionDomain): PermissionGrant {
  const override = settings.overrides?.[domain];
  let grant: PermissionGrant;
  if (override) grant = override;
  else if (settings.profile === "CUSTOM") grant = "ask";
  else grant = PROFILE_BASELINE[settings.profile]?.[domain] ?? "ask";
  if (grant === "allow" && NEVER_AUTO_DOMAINS.includes(domain)) return "ask";
  return grant;
}

/* ───────────────────────────── policy ───────────────────────────── */

export type PolicyVerdict = "allow" | "ask" | "deny";
export type PolicyDecision = { verdict: PolicyVerdict; code: string; message: string; domains: readonly PermissionDomain[] };
export type Provenance = "user" | "external";
export type PolicyInput = { spec: CoworkerToolSpec; permissions: PermissionSettings; provenance: Provenance; approved?: boolean; callInProgress?: boolean; coworkerEnabled?: boolean };

export const HARD_PROHIBITIONS: readonly { id: string; test: (s: CoworkerToolSpec) => boolean; why: string }[] = [
  { id: "security_product_tamper", test: (s) => /disable[_-]?(defender|antivirus|firewall)|stop[_-]?security|tamper[_-]?protection/i.test(s.name), why: "Loopcom will not switch off this computer's security protections, even to fix a problem." },
  { id: "remote_access_listener", test: (s) => /(open|enable|start)[_-]?(rdp|vnc|remote[_-]?desktop|reverse[_-]?shell)/i.test(s.name), why: "Loopcom will not open this computer up to remote connections from the internet." },
  { id: "arbitrary_remote_shell", test: (s) => s.category === "SHELL" && /^(remote|server)[_-]/i.test(s.name), why: "Loopcom support can run named checks on this computer, never free-form commands." },
];
const SECURITY_POSTURE_DOMAINS: readonly PermissionDomain[] = ["system.settings", "network.config", "windows.services", "software.install"];
const DEFERRED_DURING_CALL: readonly PermissionDomain[] = ["network.config", "windows.services", "system.settings", "software.install", "desktop.active"];

/** ⛔ Same order as the shared policy: kill switch → prohibitions → call → DENY → provenance → ASK → risk floor → approval. */
export function decideToolCall(input: PolicyInput): PolicyDecision {
  const { spec, permissions, provenance } = input;
  if (input.coworkerEnabled === false) return { verdict: "deny", code: "coworker_disabled", message: "The AI Coworker is switched off.", domains: [] };
  for (const d of spec.domains) if (!isPermissionDomain(d)) return { verdict: "deny", code: "invalid_tool_spec", message: "That tool did not describe itself in a way Loopcom can check, so it was not run.", domains: [] };
  for (const rule of HARD_PROHIBITIONS) if (rule.test(spec)) return { verdict: "deny", code: `prohibited:${rule.id}`, message: rule.why, domains: spec.domains };
  if (input.callInProgress) {
    const clashing = spec.domains.filter((d) => DEFERRED_DURING_CALL.includes(d));
    if (clashing.length) return { verdict: "deny", code: "deferred_during_call", message: "A phone call is in progress. Loopcom will not change audio, network or system settings while you are on a call — this can be run once the call ends.", domains: clashing };
  }
  const deniedEarly = spec.domains.filter((d) => resolveGrant(permissions, d) === "deny");
  if (deniedEarly.length) return { verdict: "deny", code: "domain_denied", message: `Your Coworker permissions do not allow this (${deniedEarly.join(", ")}). You can change this under the Coworker's Permissions.`, domains: deniedEarly };
  if (provenance === "external") {
    if (spec.destructive || riskAtLeast(spec.risk, "HIGH")) return { verdict: "deny", code: "external_content_cannot_authorize_high_risk", message: "Something Loopcom read on a website or in a document asked for this. Instructions found in content are never acted on — ask for it directly if you want it done.", domains: spec.domains };
    if (spec.exfiltrationCapable) return { verdict: "deny", code: "external_content_cannot_send_data", message: "Something Loopcom read asked it to send information somewhere. Loopcom does not send data because a document told it to.", domains: spec.domains };
    if (!input.approved) return { verdict: "ask", code: "external_content_needs_confirmation", message: "Loopcom found an instruction while reading something, and wants your go-ahead before acting on it.", domains: spec.domains };
  }
  const asked: PermissionDomain[] = spec.domains.filter((d) => resolveGrant(permissions, d) === "ask");
  const needsApprovalForRisk = spec.destructive || spec.risk === "DESTRUCTIVE";
  const securityPosture = spec.domains.filter((d) => SECURITY_POSTURE_DOMAINS.includes(d));
  const mustAsk = asked.length > 0 || needsApprovalForRisk || spec.alwaysRequireApproval === true || securityPosture.length > 0 || spec.domains.some((d) => NEVER_AUTO_DOMAINS.includes(d));
  if (!mustAsk) return { verdict: "allow", code: "allowed", message: "", domains: spec.domains };
  if (input.approved) return { verdict: "allow", code: "approved_by_user", message: "", domains: spec.domains };
  const reasonDomains = asked.length ? asked : securityPosture.length ? securityPosture : spec.domains;
  return {
    verdict: "ask",
    code: needsApprovalForRisk ? "destructive_needs_approval" : "domain_needs_approval",
    message: needsApprovalForRisk ? "This cannot be undone by Loopcom, so it needs your approval first." : `This needs your approval (${reasonDomains.join(", ")}).`,
    domains: reasonDomains,
  };
}

/* ────────────────────────────── paths ───────────────────────────── */

const RESERVED_NAMES = new Set(["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"]);
export const FORBIDDEN_ROOTS: readonly string[] = ["c:/windows", "c:/program files/windowsapps", "c:/programdata/microsoft/windows/start menu/programs/startup", "c:/$recycle.bin", "c:/system volume information"];
const FORBIDDEN_SEGMENTS: readonly string[] = ["$mft", "$logfile", "$bitmap"];

/** Forward slashes, lowercase drive, no `..` ever, no device/UNC/ADS/8.3 tricks. Null = unsafe. */
export function normalizePath(input: string): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const p = input.trim().replace(/\\/g, "/");
  if (/^\/\/[?.]\//.test(p)) return null;
  if (/^\/\//.test(p)) return null;
  if (/^[a-zA-Z]:[^/]/.test(p)) return null;
  const colonCount = (p.match(/:/g) || []).length;
  if (colonCount > 1 || (colonCount === 1 && !/^[a-zA-Z]:/.test(p))) return null;
  const hasDrive = /^[a-zA-Z]:/.test(p);
  const drive = hasDrive ? p.slice(0, 2).toLowerCase() : "";
  const rest = hasDrive ? p.slice(2) : p;
  const absolute = rest.startsWith("/");
  const stack: string[] = [];
  for (const part of rest.split("/").filter((s) => s.length > 0)) {
    if (part === ".") continue;
    if (part === "..") return null;
    const cleaned = part.replace(/[. ]+$/, "");
    if (!cleaned) return null;
    const base = cleaned.split(".")[0].toLowerCase();
    if (RESERVED_NAMES.has(base)) return null;
    if (FORBIDDEN_SEGMENTS.includes(cleaned.toLowerCase())) return null;
    if (/~\d+$/.test(cleaned.split(".")[0])) return null;
    stack.push(cleaned);
  }
  const joined = stack.join("/");
  if (hasDrive) return `${drive}/${joined}`;
  return absolute ? `/${joined}` : joined;
}

/** Segment-wise containment (never a raw startsWith: c:/users/bobby is not inside c:/users/bob). */
export function isInsideRoot(child: string, root: string): boolean {
  const c = normalizePath(child); const r = normalizePath(root);
  if (!c || !r) return false;
  const cl = c.toLowerCase(); const rl = r.toLowerCase();
  if (cl === rl) return true;
  return cl.startsWith(rl.endsWith("/") ? rl : `${rl}/`);
}

export type PathVerdict = { ok: true; normalized: string; root: string } | { ok: false; refused: string };
export function resolveScopedPath(input: string, allowedRoots: readonly string[]): PathVerdict {
  const normalized = normalizePath(input);
  if (!normalized) return { ok: false, refused: "unsafe_path" };
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) return { ok: false, refused: "no_allowed_roots" };
  const lower = normalized.toLowerCase();
  for (const bad of FORBIDDEN_ROOTS) if (lower === bad || lower.startsWith(`${bad}/`)) return { ok: false, refused: "forbidden_system_location" };
  for (const root of allowedRoots) {
    const r = normalizePath(root);
    if (!r) continue;
    if (isInsideRoot(normalized, r)) return { ok: true, normalized, root: r };
  }
  return { ok: false, refused: "outside_allowed_roots" };
}

/* ─────────────────────────── redaction ──────────────────────────── */

export const REDACTED = "[redacted]";
const SECRET_KEY_FRAGMENTS: readonly string[] = ["password", "passwd", "pwd", "secret", "apikey", "accesskey", "secretkey", "privatekey", "token", "bearer", "authorization", "credential", "sessionid", "cookie", "setcookie", "signature", "clientsecret", "refreshtoken", "accesstoken", "idtoken", "sasl", "amipassword", "masterkey", "encryptionkey", "connectionstring", "dsn", "pin", "otp", "mfacode", "recoverycode", "seed", "mnemonic"];
const SAFE_KEY_EXACT: readonly string[] = ["tokenexpiresat", "tokenexpiry", "tokentype", "haspassword", "hastoken", "hasapikey", "passwordset", "passwordlastchanged", "passwordage", "credentialref", "credentialname", "secretname", "secretref", "keyid", "tokencount", "tokensused", "totaltokens", "inputtokens", "outputtokens", "cookiecount", "signaturevalid", "signaturealgorithm"];
function normalizeKey(key: string): string { return key.toLowerCase().replace(/[^a-z]/g, ""); }
export function isSecretKey(key: string): boolean {
  const n = normalizeKey(key);
  if (!n) return false;
  if (SAFE_KEY_EXACT.includes(n)) return false;
  return SECRET_KEY_FRAGMENTS.some((frag) => n.includes(frag));
}
const SECRET_PATTERNS: readonly { id: string; re: RegExp }[] = [
  { id: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { id: "elevenlabs_key", re: /\bsk_[A-Za-z0-9]{32,}/g },
  { id: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "google_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { id: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: "stripe_key", re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { id: "twilio_sid", re: /\bAC[0-9a-fA-F]{32}\b/g },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { id: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { id: "auth_header", re: /\b(Authorization|Proxy-Authorization)\s*:\s*\S+/gi },
  { id: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g },
  { id: "basic_auth", re: /\bBasic\s+[A-Za-z0-9+/=]{12,}/g },
  { id: "cookie_header", re: /\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi },
  { id: "assigned_secret", re: /\b([A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Za-z0-9_.-]*)\s*[:=]\s*(?:"[^"\n]{1,512}"|'[^'\n]{1,512}'|[^\s,;)}\]]{1,512})/gi },
  { id: "url_credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s:/@]+)@/gi },
  { id: "hex64_key", re: /\b[0-9a-fA-F]{64}\b/g },
];
const KNOWN_SAFE_PATTERNS: readonly RegExp[] = [/\bsha256:[0-9a-f]{64}\b/i, /\b(?:commit|sha|checksum|digest|hash)\s*[:=]\s*[0-9a-f]{7,64}\b/i];

export type RedactionReport = { text: string; hits: string[]; redactionCount: number };
export function redactText(input: string): RedactionReport {
  if (typeof input !== "string" || !input) return { text: input ?? "", hits: [], redactionCount: 0 };
  const safeSpans: Array<[number, number]> = [];
  for (const re of KNOWN_SAFE_PATTERNS) {
    const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(input)) !== null) { safeSpans.push([m.index, m.index + m[0].length]); if (m.index === rx.lastIndex) rx.lastIndex++; }
  }
  const inSafeSpan = (s: number, e: number) => safeSpans.some(([a, b]) => s >= a && e <= b);
  const hits = new Set<string>(); let count = 0; let text = input;
  for (const { id, re } of SECRET_PATTERNS) {
    text = text.replace(new RegExp(re.source, re.flags), (match, ...groups) => {
      const offset = groups[groups.length - 2] as number;
      if (typeof offset === "number" && inSafeSpan(offset, offset + match.length)) return match;
      hits.add(id); count++;
      if (id === "url_credentials") return `${groups[0]}${groups[1]}:${REDACTED}@`;
      if (id === "assigned_secret") return `${groups[0]}=${REDACTED}`;
      if (id === "auth_header" || id === "cookie_header") return `${groups[0]}: ${REDACTED}`;
      return REDACTED;
    });
  }
  return { text, hits: Array.from(hits).sort(), redactionCount: count };
}

export function redactStructured<T = unknown>(value: T, opts?: { maxDepth?: number }): { value: T; hits: string[]; redactionCount: number } {
  const maxDepth = opts?.maxDepth ?? 12; const hits = new Set<string>(); let count = 0; const seen = new WeakSet<object>();
  function walk(node: unknown, depth: number): unknown {
    if (node === null || node === undefined) return node;
    if (depth > maxDepth) return "[truncated: too deep]";
    if (typeof node === "string") { const r = redactText(node); if (r.redactionCount) { r.hits.forEach((h) => hits.add(h)); count += r.redactionCount; } return r.text; }
    if (typeof node === "number" || typeof node === "boolean" || typeof node === "bigint") return node;
    if (typeof node === "function" || typeof node === "symbol") return "[omitted]";
    if (typeof node === "object") {
      if (seen.has(node as object)) return "[circular]";
      seen.add(node as object);
      if (Array.isArray(node)) return node.map((i) => walk(i, depth + 1));
      if (node instanceof Date) return node.toISOString();
      if (node instanceof Error) return { name: node.name, message: redactText(node.message).text };
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (isSecretKey(k)) { out[k] = REDACTED; hits.add(`key:${normalizeKey(k)}`); count++; continue; }
        out[k] = walk(v, depth + 1);
      }
      return out;
    }
    return node;
  }
  return { value: walk(value, 0) as T, hits: Array.from(hits).sort(), redactionCount: count };
}
export function containsLikelySecret(text: string): { clean: boolean; hits: string[] } {
  const r = redactText(text);
  return { clean: r.redactionCount === 0, hits: r.hits };
}
