/**
 * IVR prompt (system-recording) audio storage.
 *
 * TENANT-SCOPED filesystem — every prompt's bytes live under a subdirectory
 * derived from its owning tenantId so two tenants with the same filename
 * (e.g. both have a "Main" recording) cannot clobber each other's audio.
 *
 * Directory layout:
 *   <PROMPT_STORAGE_DIR>/tenants/<tenantId>/<sanitisedBaseName><ext>
 *   <PROMPT_STORAGE_DIR>/unassigned/<sanitisedBaseName><ext>   (super-admin only)
 *
 * Historical (pre-20260426) rows wrote flat paths directly under the root.
 * Those legacy files are ignored by the new reader and the migration nulls
 * their pointers. They'll be removed by the companion cleanup command.
 *
 * The audio bytes are the authoritative copy for playback; the row's sha256
 * is the cache key used by the PBX-host helper to avoid re-uploading
 * unchanged files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const DEFAULT_ROOT = path.resolve(process.cwd(), "data/ivr-prompts");

export function getPromptStorageRoot(): string {
  return (process.env.PROMPT_STORAGE_DIR || DEFAULT_ROOT).replace(/\/+$/, "");
}

/** HMAC secret for signed download URLs. Reuses MOH_URL_SIGNING_SECRET /
 *  CDR_INGEST_SECRET so no new env var is required on day one; production
 *  can set PROMPT_URL_SIGNING_SECRET to isolate blast radius. */
function signingSecret(): string {
  return (
    process.env.PROMPT_URL_SIGNING_SECRET ||
    process.env.MOH_URL_SIGNING_SECRET ||
    process.env.CDR_INGEST_SECRET ||
    "dev-signing-secret"
  ).trim();
}

const ALLOWED_EXTS = new Set([
  ".wav", ".mp3", ".ogg", ".gsm", ".g722", ".g729", ".sln", ".sln16",
  ".ulaw", ".alaw", ".m4a", ".aac",
]);

const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  ".wav":   "audio/wav",
  ".wav49": "audio/wav",
  ".mp3":   "audio/mpeg",
  ".ogg":   "audio/ogg",
  ".opus":  "audio/ogg",
  ".m4a":   "audio/mp4",
  ".aac":   "audio/aac",
  ".gsm":   "audio/x-gsm",
  ".g722":  "audio/G722",
  ".g729":  "audio/G729",
  ".sln":   "audio/basic",
  ".sln16": "audio/basic",
  ".ulaw":  "audio/basic",
  ".alaw":  "audio/basic",
};

export function contentTypeForFilename(filename: string): string {
  const ext = path.extname(filename || "").toLowerCase();
  return EXT_TO_CONTENT_TYPE[ext] ?? "audio/wav";
}

/** Allow only a-z, 0-9, _, - in the sanitised storage basename. */
export function sanitizeBaseName(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/\.(wav|mp3|ogg|gsm|g722|g729|sln\d*|ulaw|alaw|m4a|aac|wav49)$/i, "")
    .replace(/[^a-z0-9_\-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Resolve a storage key to an absolute path, refusing traversal. */
export function resolvePromptStoragePath(storageKey: string): string {
  const clean = String(storageKey || "").replace(/\\/g, "/");
  if (clean.includes("..")) throw new Error("invalid_storage_key");
  const root = getPromptStorageRoot();
  const full = path.resolve(root, clean);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new Error("invalid_storage_key_scope");
  }
  return full;
}

/** Sanitise a tenantId/slug into a safe directory name. The value is only
 *  ever derived from a trusted server-side id, but belt + braces. */
export function sanitizeTenantScope(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim();
  if (!s) return "unassigned";
  const safe = s.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 80);
  return safe || "unassigned";
}

/** Build the tenant-scoped relative storage key (no leading `/`). */
export function buildTenantStorageKey(
  tenantIdOrScope: string | null | undefined,
  base: string,
  ext: string,
): string {
  const scope = sanitizeTenantScope(tenantIdOrScope);
  const prefix = scope === "unassigned" ? "unassigned" : `tenants/${scope}`;
  return `${prefix}/${base}${ext}`;
}

/** Write audio bytes to disk (tenant-scoped) and return metadata. */
export async function writePromptFile(input: {
  /** Connect tenantId (cuid). null/undefined → "unassigned" scope. */
  tenantScope: string | null | undefined;
  baseName: string;           // e.g. "acme_welcome" or raw "custom/acme_welcome"
  originalFilename: string;   // e.g. "acme_welcome.wav"
  buffer: Buffer;
}): Promise<{ storageKey: string; sha256: string; sizeBytes: number; contentType: string; absolutePath: string }> {
  const base = sanitizeBaseName(input.baseName || input.originalFilename);
  if (!base) throw new Error("invalid_base_name");

  const rawExt = path.extname(input.originalFilename || "").toLowerCase();
  const ext = ALLOWED_EXTS.has(rawExt) ? rawExt : ".wav";
  const storageKey = buildTenantStorageKey(input.tenantScope, base, ext);
  const absolutePath = resolvePromptStoragePath(storageKey);

  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.promises.writeFile(absolutePath, input.buffer);

  const sha256 = crypto.createHash("sha256").update(input.buffer).digest("hex");
  const contentType = EXT_TO_CONTENT_TYPE[ext] ?? "audio/wav";
  return {
    storageKey,
    sha256,
    sizeBytes: input.buffer.length,
    contentType,
    absolutePath,
  };
}

export async function readPromptFile(storageKey: string): Promise<Buffer> {
  const p = resolvePromptStoragePath(storageKey);
  return fs.promises.readFile(p);
}

/** Is this storageKey under a tenant-scoped directory? Legacy flat keys
 *  (pre-20260426 migration) were written directly under the root and are
 *  now considered suspect because tenant isolation was not enforced when
 *  they were created. The stream endpoint calls this to refuse them. */
export function isTenantScopedStorageKey(storageKey: string | null | undefined): boolean {
  const s = String(storageKey || "").replace(/\\/g, "/").replace(/^\/+/, "");
  return s.startsWith("tenants/") || s.startsWith("unassigned/");
}

/**
 * Strip the leading Asterisk sounds path, language folder, or "custom/"
 * prefix so we can match the bare recording name. Accepts any of:
 *   "custom/KJ_Play_Center"
 *   "/var/lib/asterisk/sounds/custom/KJ_Play_Center.wav"
 *   "en/custom/foo"
 *   "KJ_Play_Center.WAV"
 */
export function extractPromptBaseKey(raw: string | null | undefined): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/\\/g, "/");
  // Drop any asterisk sounds root prefix.
  s = s.replace(/^\/?(?:var\/lib\/)?asterisk\/sounds\//i, "");
  s = s.replace(/^\/?usr\/share\/asterisk\/sounds\//i, "");
  // Drop "custom/" anywhere at the start (possibly preceded by an
  // Asterisk language folder like "en/").
  s = s.replace(/^(?:[a-z]{2}(?:_[A-Z]{2})?\/)?custom\//i, "");
  // Drop a trailing known audio extension.
  s = s.replace(/\.(wav49|wav|mp3|ogg|opus|gsm|g722|g729|sln\d*|ulaw|alaw|m4a|aac)$/i, "");
  // Drop any remaining path segments (take the last one).
  const lastSlash = s.lastIndexOf("/");
  if (lastSlash >= 0) s = s.slice(lastSlash + 1);
  return s;
}

/** Generate all lookup candidates we'd be willing to accept as the cached
 *  audio for a prompt row. Order matters: most specific first.
 *  TENANT-SCOPED: every candidate is prefixed with the row's tenant scope
 *  so tenant A's matcher will never resolve to tenant B's file bytes on
 *  disk, even if the filenames collide. */
export function candidateStorageKeysForRow(row: {
  storageKey?: string | null;
  fileBaseName?: string | null;
  promptRef?: string | null;
  displayName?: string | null;
  relativePath?: string | null;
  tenantId?: string | null;
}): string[] {
  const seeds = [
    row.fileBaseName,
    extractPromptBaseKey(row.promptRef),
    extractPromptBaseKey(row.relativePath),
    extractPromptBaseKey(row.displayName),
  ].filter((x): x is string => typeof x === "string" && x.length > 0);

  const seen = new Set<string>();
  const out: string[] = [];
  const push = (k: string): void => {
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };

  // The row's own (canonical) storage key is always the first choice. It
  // may be a legacy flat path from before the tenant isolation fix;
  // readPromptFile will refuse to serve it because the reader is scoped
  // to the tenant dir, but we still list it for auto-heal diagnostics.
  if (row.storageKey) push(row.storageKey);

  const COMMON_EXTS = [".wav", ".mp3", ".ogg", ".gsm"];
  const ALL_EXTS = [".wav", ".mp3", ".ogg", ".gsm", ".g722", ".g729", ".ulaw", ".alaw", ".sln", ".sln16", ".m4a", ".aac"];

  const scope = sanitizeTenantScope(row.tenantId);
  const tenantPrefix = scope === "unassigned" ? "unassigned" : `tenants/${scope}`;

  // 1) Raw-case seeds under the tenant directory.
  for (const seed of seeds) {
    for (const ext of COMMON_EXTS) push(`${tenantPrefix}/${seed}${ext}`);
  }

  // 2) Sanitised lower-case forms under the tenant directory (what
  //    writePromptFile writes today).
  for (const seed of seeds) {
    const sanitised = sanitizeBaseName(seed);
    if (!sanitised) continue;
    for (const ext of ALL_EXTS) push(`${tenantPrefix}/${sanitised}${ext}`);
  }
  return out;
}

/** One-shot lookup: return the first candidate key that actually exists on
 *  disk under PROMPT_STORAGE_DIR. Scoped to the row's tenant directory so
 *  this cannot return another tenant's file even if filenames collide.
 *  Does one `readdir` per tenant dir so we match case-insensitively even
 *  on case-sensitive filesystems. */
export async function findCachedAudioForRow(row: {
  storageKey?: string | null;
  fileBaseName?: string | null;
  promptRef?: string | null;
  displayName?: string | null;
  relativePath?: string | null;
  tenantId?: string | null;
}): Promise<{
  storageKey: string;
  absolutePath: string;
  contentType: string;
  sizeBytes: number;
  matchedBy: "storageKey" | "exact" | "case-insensitive";
  candidatesTried: string[];
} | null> {
  const scope = sanitizeTenantScope(row.tenantId);
  const tenantPrefix = scope === "unassigned" ? "unassigned" : `tenants/${scope}`;
  const root = getPromptStorageRoot();
  const tenantDir = path.join(root, ...tenantPrefix.split("/"));

  let tenantEntries: string[];
  try {
    tenantEntries = await fs.promises.readdir(tenantDir);
  } catch {
    return null;
  }

  const byLower = new Map<string, string>();
  for (const e of tenantEntries) byLower.set(e.toLowerCase(), e);

  const candidates = candidateStorageKeysForRow(row);
  if (candidates.length === 0) return null;

  const tryKey = async (
    key: string,
    matchedBy: "storageKey" | "exact" | "case-insensitive",
  ): Promise<{
    storageKey: string; absolutePath: string; contentType: string; sizeBytes: number;
    matchedBy: "storageKey" | "exact" | "case-insensitive"; candidatesTried: string[];
  } | null> => {
    // Security: refuse any candidate that isn't under the tenant prefix.
    // Legacy flat keys (e.g. "main.wav") get rejected here so we never
    // cross-serve audio from another tenant's dir.
    if (!key.startsWith(`${tenantPrefix}/`)) return null;
    const abs = resolvePromptStoragePath(key);
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isFile()) return null;
      return {
        storageKey: key,
        absolutePath: abs,
        contentType: contentTypeForFilename(key),
        sizeBytes: st.size,
        matchedBy,
        candidatesTried: candidates,
      };
    } catch {
      return null;
    }
  };

  // 1) Exact hit — only consider candidates whose tail exists in this
  //    tenant's directory.
  for (const cand of candidates) {
    const tail = cand.startsWith(`${tenantPrefix}/`) ? cand.slice(tenantPrefix.length + 1) : null;
    if (tail && tenantEntries.includes(tail)) {
      const hit = await tryKey(cand, cand === row.storageKey ? "storageKey" : "exact");
      if (hit) return hit;
    }
  }
  // 2) Case-insensitive fallback within the tenant's directory.
  for (const cand of candidates) {
    const tail = cand.startsWith(`${tenantPrefix}/`) ? cand.slice(tenantPrefix.length + 1) : null;
    if (!tail) continue;
    const real = byLower.get(tail.toLowerCase());
    if (!real) continue;
    const hit = await tryKey(`${tenantPrefix}/${real}`, "case-insensitive");
    if (hit) return hit;
  }
  return null;
}

/** Return the filenames currently on disk grouped by tenant scope:
 *    Map<scope, Map<lowercase_filename, on_disk_filename>>
 *  where `scope` is the tenantId or "unassigned". Used by the list
 *  endpoint to compute `hasAudio` for many rows in one pair of disk
 *  scans. */
export async function listStoredAudioFilenames(): Promise<Map<string, Map<string, string>>> {
  const root = getPromptStorageRoot();
  const out = new Map<string, Map<string, string>>();

  const addDir = async (scope: string, abs: string): Promise<void> => {
    try {
      const entries = await fs.promises.readdir(abs, { withFileTypes: true });
      const map = new Map<string, string>();
      for (const e of entries) if (e.isFile()) map.set(e.name.toLowerCase(), e.name);
      if (map.size > 0) out.set(scope, map);
    } catch {
      /* dir missing → no audio for this scope */
    }
  };

  // Read tenants/<id>/ subdirs.
  try {
    const tenantsRoot = path.join(root, "tenants");
    const tenants = await fs.promises.readdir(tenantsRoot, { withFileTypes: true });
    for (const t of tenants) {
      if (!t.isDirectory()) continue;
      await addDir(t.name, path.join(tenantsRoot, t.name));
    }
  } catch {
    /* no tenants dir yet — first run after migration */
  }

  // Unassigned bucket.
  await addDir("unassigned", path.join(root, "unassigned"));

  return out;
}

/** Fast check — does any of the row's candidate keys resolve to a file in
 *  the provided per-tenant filename map? Returns the *actual on-disk
 *  storageKey* (tenant-scoped) so the UI and auto-heal step use the real
 *  path. NEVER crosses tenant boundaries. */
export function rowHasCachedAudio(
  row: {
    storageKey?: string | null;
    fileBaseName?: string | null;
    promptRef?: string | null;
    displayName?: string | null;
    relativePath?: string | null;
    tenantId?: string | null;
  },
  storedByScope: Map<string, Map<string, string>>,
): { hit: true; storageKey: string } | { hit: false } {
  const scope = sanitizeTenantScope(row.tenantId);
  const tenantPrefix = scope === "unassigned" ? "unassigned" : `tenants/${scope}`;
  const filenames = storedByScope.get(scope);
  if (!filenames || filenames.size === 0) return { hit: false };

  const candidates = candidateStorageKeysForRow(row);
  for (const c of candidates) {
    if (!c.startsWith(`${tenantPrefix}/`)) continue;
    const tail = c.slice(tenantPrefix.length + 1);
    const onDisk = filenames.get(tail.toLowerCase());
    if (onDisk) return { hit: true, storageKey: `${tenantPrefix}/${onDisk}` };
  }
  return { hit: false };
}

export async function deletePromptFile(storageKey: string): Promise<void> {
  const p = resolvePromptStoragePath(storageKey);
  await fs.promises.rm(p, { force: true });
}

/** Build a signed download URL (used by the PBX-host helper if it ever needs
 *  to *pull* from Connect — today we go the other direction, but keeping the
 *  helper symmetric keeps future S3/R2 migrations trivial). */
export function buildSignedDownloadUrl(
  publicBaseUrl: string,
  storageKey: string,
  expiresInSec: number = 600,
): string {
  const exp = Math.floor(Date.now() / 1000) + Math.max(10, expiresInSec);
  const sig = crypto
    .createHmac("sha256", signingSecret())
    .update(`${storageKey}:${exp}`)
    .digest("hex");
  const base = publicBaseUrl.replace(/\/+$/, "");
  return `${base}/voice/ivr/prompts/download/${encodeURIComponent(storageKey)}?exp=${exp}&sig=${sig}`;
}

export function verifySignedDownload(
  storageKey: string,
  expRaw: string | undefined,
  sigRaw: string | undefined,
): { ok: true } | { ok: false; reason: "expired" | "invalid" } {
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  if (typeof sigRaw !== "string" || sigRaw.length !== 64) {
    return { ok: false, reason: "invalid" };
  }
  const expected = crypto
    .createHmac("sha256", signingSecret())
    .update(`${storageKey}:${exp}`)
    .digest("hex");
  const a = Buffer.from(sigRaw, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true };
}
