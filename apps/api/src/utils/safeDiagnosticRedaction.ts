/**
 * Safe diagnostic redaction helpers
 * - Pure string transforms
 * - No external dependencies
 * - Preserve enough structure for debugging while masking sensitive values
 */

const JWT_REGEX = /\b[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}\b/g;
const BEARER_REGEX = /(Authorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+\-=\/]+)\b/gi;

// Common sensitive env key fragments
const SECRET_KEY_FRAGMENTS = [
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'PASS',
  'API_KEY',
  'X_API_KEY',
  'PRIVATE',
  'AUTH',
  'SESSION',
  'COOKIE',
  'CREDENTIAL',
  'WEBHOOK_SECRET',
  'INTERNAL_DEPLOY_SECRET',
  'DEPLOY_QUEUE_TOKEN',
  'DATABASE_URL',
  'DB_URL',
];

// DB URL schemes to treat as highly sensitive
const DB_SCHEMES = [
  'postgres', 'postgresql', 'mysql', 'mariadb', 'sqlserver', 'mongodb', 'mongodb+srv', 'redis', 'rediss'
];

const URL_WITH_CREDS_REGEX = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s@]+)@/gi;
const DB_URL_REGEX = (() => {
  const schemes = DB_SCHEMES.map((s) => s.replace(/[+]/g, '\\+')).join('|');
  const pattern = `\\b(?:${schemes}):\\/\\/[^\\s'\"]+`;
  return new RegExp(pattern, 'gi');
})();

function replaceEnvAssignment(line: string): string {
  // Match KEY=VALUE on a full token or at start-of-line; support quoted values too
  const m = line.match(/^\s*([A-Z0-9_\.\-]+)\s*=\s*(.*)$/i);
  if (!m) return line;
  const key = m[1];
  const value = m[2] ?? '';
  const upper = key.toUpperCase();
  const isDbUrl = upper === 'DATABASE_URL' || upper.includes('DB_URL');
  const looksSensitive = SECRET_KEY_FRAGMENTS.some((frag) => upper.includes(frag));
  if (isDbUrl) return `${key}=[REDACTED_DB_URL]`;
  if (looksSensitive) return `${key}=[REDACTED_SECRET]`;
  // Not obviously sensitive — preserve as-is
  return `${key}=${value}`;
}

export function redactJwtLike(value: string): string {
  return value.replace(JWT_REGEX, '[REDACTED_JWT]');
}

export function redactBearerTokens(value: string): string {
  return value.replace(BEARER_REGEX, (_all, p1) => `${p1}[REDACTED_TOKEN]`);
}

export function redactSecrets(value: string): string {
  // 1) Env-style assignments per-line
  const redactedLines = value.split(/\r?\n/).map((line) => replaceEnvAssignment(line));
  let out = redactedLines.join('\n');

  // 2) Common query params like token=..., access_token=..., client_secret=...
  out = out.replace(/([?&](?:token|access_token|client_secret|secret|api_key|x-api-key)=)([^&#\s]+)/gi, (_m, p1) => `${p1}[REDACTED_TOKEN]`);

  // 3) Headers like x-internal-deploy-secret: ...
  out = out.replace(/(x-[a-z0-9-]*secret\s*:\s*)([^\r\n]+)/gi, (_m, p1) => `${p1}[REDACTED_SECRET]`);

  return out;
}

export function redactEnvAssignments(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => replaceEnvAssignment(line))
    .join('\n');
}

export function redactUrlsWithCredentials(value: string): string {
  let out = value.replace(URL_WITH_CREDS_REGEX, (_m, p1) => `${p1}[REDACTED_TOKEN]@`);
  out = out.replace(DB_URL_REGEX, '[REDACTED_DB_URL]');
  return out;
}

export function sanitizeDiagnosticOutput(value: string): string {
  let out = String(value ?? '');
  out = redactBearerTokens(out);
  out = redactJwtLike(out);
  out = redactUrlsWithCredentials(out);
  out = redactSecrets(out);
  out = redactEnvAssignments(out);

  // Optionally collapse very long absolute paths to reduce leakage
  out = out.replace(/(?:[A-Za-z]:\\|\/)\S{40,}/g, '[PATH]');

  return out;
}
