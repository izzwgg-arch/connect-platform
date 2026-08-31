/**
 * Secret detection and redaction — the last thing that runs before anything leaves
 * this computer.
 *
 * ⛔⛔ RELEASE-BLOCKING RULE (Phase 38): a secret reaching the support backend, an
 * AI provider, a log, a metric or a crash dump is a failure, not a bug. Every path
 * that ships data off the machine — diagnostics, support cases, audit records,
 * telemetry, model context — runs through here first.
 *
 * ⛔ REGEX IS THE SECOND LINE, NOT THE FIRST. Pattern matching cannot recognise a
 * password that looks like a word, and this codebase already knows it: the
 * documented VoIP.ms SIP passwords, the PBX AMI password and the robot panel
 * password are all ordinary-looking strings that no regex would flag. So detection
 * is structural FIRST — `redactStructured()` walks objects and redacts by KEY NAME,
 * which is what actually catches `{ password: "swordfish" }` — and only then does
 * the pattern sweep run over free text.
 *
 * ⛔ The two halves are not interchangeable. Deleting either one leaks.
 */

export const REDACTED = "[redacted]";

/* ─────────────────── structural detection (primary) ─────────────── */

/**
 * Key names whose VALUE is a secret regardless of what it looks like.
 *
 * ⛔ Matched after lowercasing and stripping non-letters, so `API_KEY`, `api-key`,
 * `apiKey` and `x_api_key` all collapse to `apikey`. Substring matching is
 * deliberate: `sipPassword`, `db_password_2` and `oldPassword` must all match.
 */
const SECRET_KEY_FRAGMENTS: readonly string[] = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "token",
  "bearer",
  "authorization",
  "credential",
  "sessionid",
  "cookie",
  "setcookie",
  "signature",
  "clientsecret",
  "refreshtoken",
  "accesstoken",
  "idtoken",
  "sasl",
  "amipassword",
  "masterkey",
  "encryptionkey",
  "connectionstring",
  "dsn",
  "pin",
  "otp",
  "mfacode",
  "recoverycode",
  "seed",
  "mnemonic",
];

/**
 * Keys that CONTAIN a secret-ish fragment but are safe and useful to keep.
 *
 * ⛔ This list is why diagnostics stay diagnostic. Redacting `tokenExpiresAt` or
 * `hasPassword` throws away the exact evidence a support engineer needs ("the token
 * expired at 04:12") while protecting nothing. Every entry here is a fact ABOUT a
 * secret rather than the secret itself.
 */
const SAFE_KEY_EXACT: readonly string[] = [
  "tokenexpiresat",
  "tokenexpiry",
  "tokentype",
  "haspassword",
  "hastoken",
  "hasapikey",
  "passwordset",
  "passwordlastchanged",
  "passwordage",
  "credentialref",
  "credentialname",
  "secretname",
  "secretref",
  "keyid",
  "tokencount",
  "tokensused",
  "totaltokens",
  "inputtokens",
  "outputtokens",
  "cookiecount",
  "signaturevalid",
  "signaturealgorithm",
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

export function isSecretKey(key: string): boolean {
  const n = normalizeKey(key);
  if (!n) return false;
  if (SAFE_KEY_EXACT.includes(n)) return false;
  return SECRET_KEY_FRAGMENTS.some((frag) => n.includes(frag));
}

/* ────────────────── pattern detection (secondary) ───────────────── */

/**
 * High-confidence secret shapes in free text.
 *
 * ⛔ These are for text where there is no key to inspect — a log line, a config
 * file dump, stdout from a command. Ordered most-specific first so a JWT is not
 * half-eaten by the generic long-string rule.
 */
const SECRET_PATTERNS: readonly { id: string; re: RegExp }[] = [
  // Structured provider keys, most specific first.
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

  // Private key blocks. The whole body goes, not just the header.
  { id: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },

  // Headers and assignments carrying a value.
  { id: "auth_header", re: /\b(Authorization|Proxy-Authorization)\s*:\s*\S+/gi },
  { id: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g },
  { id: "basic_auth", re: /\bBasic\s+[A-Za-z0-9+/=]{12,}/g },
  { id: "cookie_header", re: /\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi },

  // key=value / key: "value" in configs, env files and logs.
  {
    id: "assigned_secret",
    re: /\b([A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Za-z0-9_.-]*)\s*[:=]\s*(?:"[^"\n]{1,512}"|'[^'\n]{1,512}'|[^\s,;)}\]]{1,512})/gi,
  },

  // Credentials embedded in a URL: scheme://user:pass@host
  { id: "url_credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s:/@]+)@/gi },

  // The repo's own master-key shape: 64 hex chars.
  { id: "hex64_key", re: /\b[0-9a-fA-F]{64}\b/g },
];

/**
 * ⛔ Patterns that must NOT be redacted even though they resemble a secret.
 * A 40-char git SHA and a sha256 checksum are evidence, not credentials, and
 * redacting them makes diagnostics useless. Checked before the generic sweeps.
 */
const KNOWN_SAFE_PATTERNS: readonly RegExp[] = [
  /\bsha256:[0-9a-f]{64}\b/i,
  /\b(?:commit|sha|checksum|digest|hash)\s*[:=]\s*[0-9a-f]{7,64}\b/i,
];

export type RedactionReport = {
  text: string;
  /** Pattern ids that fired, for the audit trail. Never contains the values. */
  hits: string[];
  redactionCount: number;
};

/**
 * Redact secrets from free text.
 *
 * ⛔ `url_credentials` keeps the scheme and host — losing "which host" destroys the
 * diagnostic value while protecting nothing extra. Only the userinfo goes.
 */
export function redactText(input: string): RedactionReport {
  if (typeof input !== "string" || !input) return { text: input ?? "", hits: [], redactionCount: 0 };

  const safeSpans: Array<[number, number]> = [];
  for (const re of KNOWN_SAFE_PATTERNS) {
    const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = rx.exec(input)) !== null) {
      safeSpans.push([m.index, m.index + m[0].length]);
      if (m.index === rx.lastIndex) rx.lastIndex++;
    }
  }
  const inSafeSpan = (start: number, end: number) =>
    safeSpans.some(([s, e]) => start >= s && end <= e);

  const hits = new Set<string>();
  let count = 0;
  let text = input;

  for (const { id, re } of SECRET_PATTERNS) {
    const rx = new RegExp(re.source, re.flags);
    text = text.replace(rx, (match, ...groups) => {
      const offset = groups[groups.length - 2] as number;
      if (typeof offset === "number" && inSafeSpan(offset, offset + match.length)) return match;

      hits.add(id);
      count++;

      if (id === "url_credentials") {
        const scheme = groups[0] as string;
        const user = groups[1] as string;
        return `${scheme}${user}:${REDACTED}@`;
      }
      if (id === "assigned_secret") {
        const key = groups[0] as string;
        return `${key}=${REDACTED}`;
      }
      if (id === "auth_header" || id === "cookie_header") {
        const header = groups[0] as string;
        return `${header}: ${REDACTED}`;
      }
      return REDACTED;
    });
  }

  return { text, hits: Array.from(hits).sort(), redactionCount: count };
}

/* ───────────────────── structured redaction ─────────────────────── */

const MAX_DEPTH = 12;

/**
 * Walk a value and redact by key name, then sweep remaining strings for patterns.
 *
 * ⛔⛔ THE KEY CHECK RUNS FIRST AND WINS. `{ password: "hunter2" }` is redacted
 * because of the KEY, not because "hunter2" looks like anything — that is the whole
 * reason this function exists and why regex alone is not enough.
 *
 * ⛔ Cycles are handled (a diagnostic object graph can easily be circular) and depth
 * is capped, so a hostile or pathological payload cannot hang the redactor. A
 * redactor that can be made to hang is a redactor an attacker can skip.
 */
export function redactStructured<T = unknown>(
  value: T,
  opts?: { maxDepth?: number },
): { value: T; hits: string[]; redactionCount: number } {
  const maxDepth = opts?.maxDepth ?? MAX_DEPTH;
  const hits = new Set<string>();
  let count = 0;
  const seen = new WeakSet<object>();

  function walk(node: unknown, depth: number): unknown {
    if (node === null || node === undefined) return node;
    if (depth > maxDepth) return "[truncated: too deep]";

    if (typeof node === "string") {
      const r = redactText(node);
      if (r.redactionCount) {
        r.hits.forEach((h) => hits.add(h));
        count += r.redactionCount;
      }
      return r.text;
    }
    if (typeof node === "number" || typeof node === "boolean" || typeof node === "bigint") return node;
    if (typeof node === "function" || typeof node === "symbol") return "[omitted]";

    if (typeof node === "object") {
      if (seen.has(node as object)) return "[circular]";
      seen.add(node as object);

      if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));

      if (node instanceof Date) return node.toISOString();
      if (node instanceof Error) {
        return { name: node.name, message: redactText(node.message).text };
      }

      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (isSecretKey(k)) {
          // ⛔ Preserve TYPE and PRESENCE, never the value. "there was a password
          // and it was 14 characters" is useful; the password is not.
          out[k] = REDACTED;
          hits.add(`key:${normalizeKey(k)}`);
          count++;
          continue;
        }
        out[k] = walk(v, depth + 1);
      }
      return out;
    }
    return node;
  }

  return { value: walk(value, 0) as T, hits: Array.from(hits).sort(), redactionCount: count };
}

/**
 * The assertion used by tests and by the diagnostic upload path.
 *
 * ⛔ Called immediately BEFORE transmission, on the exact bytes being sent — not on
 * the object that was redacted earlier. Anything that re-serialises, re-formats or
 * re-attaches after redaction gets caught here. This is the difference between
 * "we redact" and "the payload is clean".
 */
export function containsLikelySecret(text: string): { clean: boolean; hits: string[] } {
  const r = redactText(text);
  return { clean: r.redactionCount === 0, hits: r.hits };
}
