/**
 * Filesystem scoping — where the coworker may and may not reach.
 *
 * ⛔⛔ THE ATTACK THIS STOPS. The model proposes a path. That path may come from a
 * web page, a filename in an email, or an MCP server's response. `../../` is the
 * least of it: on Windows the real bypasses are 8.3 short names (`PROGRA~1`),
 * device namespaces (`\\?\`), UNC paths (`\\server\share`), alternate data streams
 * (`file.txt:hidden`), drive-relative paths (`C:foo`) and reserved device names
 * (`CON`, `NUL`, `LPT1`). Any one of them turns "inside Documents" into "anywhere".
 *
 * ⛔ THIS MODULE IS PURE STRING LOGIC AND THAT IS DELIBERATE. It normalises and
 * judges; it never touches the disk. The caller must ALSO resolve symlinks and
 * junctions on the real filesystem and re-check the resolved target — see
 * `requiresRealpathCheck` below. Both halves are required: string checks catch the
 * malicious path, realpath catches the malicious *link*. Neither alone is enough.
 */

export type PathVerdict =
  | { ok: true; normalized: string; root: string }
  | { ok: false; refused: string };

/** Windows reserved device names. Opening one can hang or hit hardware. */
const RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * Directories the coworker must never touch, whatever permission is granted.
 *
 * ⛔ These are matched against the NORMALIZED lowercase path. They are refused even
 * under AUTONOMOUS, because writing here is how you break a customer's Windows
 * install or plant persistence — and no office task legitimately needs to.
 */
const FORBIDDEN_ROOTS: readonly string[] = [
  "c:/windows",
  "c:/program files/windowsapps",
  "c:/programdata/microsoft/windows/start menu/programs/startup",
  "c:/$recycle.bin",
  "c:/system volume information",
];

/** Path segments that never belong in a coworker-supplied path. */
const FORBIDDEN_SEGMENTS: readonly string[] = ["$mft", "$logfile", "$bitmap"];

/**
 * Normalize to a comparable form: forward slashes, lowercase drive, no trailing
 * separator, `.` and `..` resolved lexically.
 *
 * ⛔ Lexical resolution is done HERE rather than trusting `path.resolve`, because
 * the caller may be validating a path for a different machine (a support job) where
 * the local `path` module's platform is wrong.
 */
export function normalizePath(input: string): string | null {
  if (typeof input !== "string" || !input.trim()) return null;

  let p = input.trim().replace(/\\/g, "/");

  // Strip the Windows extended-length / device prefixes rather than accepting them:
  // `\\?\C:\...` and `\\.\C:\...` bypass normalization in many Windows APIs.
  if (/^\/\/[?.]\//.test(p)) return null;
  // UNC network paths. A separate permission domain owns network shares; a plain
  // filesystem tool must not silently reach one.
  if (/^\/\//.test(p)) return null;

  // Drive-relative ("C:foo" means "foo relative to C:'s current dir") is ambiguous.
  if (/^[a-zA-Z]:[^/]/.test(p)) return null;

  // Alternate data stream: "file.txt:hidden". Allow only the drive colon at index 1.
  const colonCount = (p.match(/:/g) || []).length;
  if (colonCount > 1 || (colonCount === 1 && !/^[a-zA-Z]:/.test(p))) return null;

  const hasDrive = /^[a-zA-Z]:/.test(p);
  const drive = hasDrive ? p.slice(0, 2).toLowerCase() : "";
  let rest = hasDrive ? p.slice(2) : p;

  const absolute = rest.startsWith("/");
  const parts = rest.split("/").filter((s) => s.length > 0);
  const stack: string[] = [];

  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      // ⛔⛔ ANY `..` IS REFUSED OUTRIGHT — it is never lexically resolved.
      //
      // The obvious implementation pops the stack and only fails when it would go
      // above the drive root. That is strictly weaker, and the test suite caught it:
      // `C:/Users/bob/../../Windows/System32` pops cleanly and normalizes to
      // `c:/Windows/System32`, which LOOKS like a valid absolute path. It is then
      // only stopped by the separate scope check — so a future caller that forgets
      // `resolveScopedPath` silently gets directory traversal.
      //
      // A legitimate coworker path never needs `..`: paths come from directory
      // listings and from roots the user granted, both already absolute. Refusing
      // makes the property "no traversal, ever" instead of "traversal is normalized
      // and hopefully bounds-checked later", and it preserves the ATTEMPT in the
      // audit log rather than recording a laundered path.
      return null;
    }
    // Trailing dots/spaces are stripped by Windows, so "secret.txt." and
    // "secret.txt " open the same file — normalize so a denylist cannot be dodged.
    const cleaned = part.replace(/[. ]+$/, "");
    if (!cleaned) return null;
    const base = cleaned.split(".")[0].toLowerCase();
    if (RESERVED_NAMES.has(base)) return null;
    if (FORBIDDEN_SEGMENTS.includes(cleaned.toLowerCase())) return null;
    // 8.3 short name. Refuse: it aliases a long name and defeats prefix matching.
    if (/~\d+$/.test(cleaned.split(".")[0])) return null;
    stack.push(cleaned);
  }

  const joined = stack.join("/");
  if (hasDrive) return `${drive}/${joined}`;
  return absolute ? `/${joined}` : joined;
}

/**
 * Is `child` inside `root`?
 *
 * ⛔ SEGMENT-WISE, NEVER `startsWith`. A raw prefix test says `c:/users/bobby` is
 * inside `c:/users/bob`. That single mistake is the whole bug class.
 */
export function isInsideRoot(child: string, root: string): boolean {
  const c = normalizePath(child);
  const r = normalizePath(root);
  if (!c || !r) return false;
  if (c === r) return true;
  return c.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/**
 * Validate a proposed path against the allowed roots.
 *
 * ⛔ An EMPTY roots list refuses everything. Fail closed: a misconfigured scope must
 * not mean "the whole disk".
 */
export function resolveScopedPath(input: string, allowedRoots: readonly string[]): PathVerdict {
  const normalized = normalizePath(input);
  if (!normalized) return { ok: false, refused: "unsafe_path" };

  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    return { ok: false, refused: "no_allowed_roots" };
  }

  const lower = normalized.toLowerCase();
  for (const bad of FORBIDDEN_ROOTS) {
    if (lower === bad || lower.startsWith(`${bad}/`)) return { ok: false, refused: "forbidden_system_location" };
  }

  for (const root of allowedRoots) {
    const r = normalizePath(root);
    if (!r) continue;
    if (isInsideRoot(normalized, r)) return { ok: true, normalized, root: r };
  }
  return { ok: false, refused: "outside_allowed_roots" };
}

/**
 * ⛔⛔ THE HALF THIS MODULE CANNOT DO. A path can pass every check above and still
 * point somewhere else, because a directory inside the allowed root is a symlink,
 * junction or mount point aimed at `C:\Windows`. The caller MUST, on the real
 * filesystem: resolve the final target (`fs.realpath`), then re-run
 * `resolveScopedPath` on the RESOLVED path before touching it.
 *
 * This constant exists so the requirement is greppable and so the test suite can
 * assert every filesystem tool honours it.
 */
export const requiresRealpathCheck = true;

/**
 * Archive extraction safety ("zip slip").
 *
 * ⛔ An archive entry named `../../../../Windows/System32/evil.dll` escapes the
 * extraction directory on extraction, not on download. Every entry is checked
 * against the destination root before a single byte is written.
 */
export function isSafeArchiveEntry(entryName: string, destRoot: string): boolean {
  if (typeof entryName !== "string" || !entryName) return false;
  if (entryName.includes("\0")) return false;
  // Absolute entries are always wrong inside an archive.
  if (/^([a-zA-Z]:)?[/\\]/.test(entryName)) return false;
  const joined = `${destRoot.replace(/[/\\]+$/, "")}/${entryName}`;
  const normalized = normalizePath(joined);
  if (!normalized) return false;
  return isInsideRoot(normalized, destRoot);
}
