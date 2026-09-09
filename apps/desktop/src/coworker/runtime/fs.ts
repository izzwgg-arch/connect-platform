/**
 * Filesystem hands. Every path the model supplies goes through
 * `resolveScopedPath` (string checks: no `..`, no device/UNC/ADS/8.3 names, no
 * Windows system folders) AND a realpath re-check of the nearest existing
 * ancestor (junction/symlink checks) before anything is touched.
 *
 * ⛔ The allowed roots are the person's home directory and the Coworker
 * workspace (plus any roots the person added in settings). Nothing outside.
 * ⛔ Move and copy never overwrite. Delete is destructive and is judged as such by
 * the policy (always asks) before this code ever runs.
 * ⛔ Every function is injected with its io so the tests drive it on a fake.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { resolveScopedPath, normalizePath, isInsideRoot } from "../policyCore";

export type FsEnv = {
  roots: string[];
  workspace: string;
  home: string;
};

export type FsError = { ok: false; error: string; message: string; path?: string };
const err = (error: string, message: string, p?: string): FsError => ({ ok: false, error, message, ...(p ? { path: p } : {}) });

export const MAX_READ_CHARS = 100_000;
export const MAX_WRITE_BYTES = 5 * 1024 * 1024;
export const MAX_LIST_ENTRIES = 5000;
export const MAX_SEARCH_RESULTS = 2000;
export const MAX_WALK_DEPTH = 8;

/** Resolve a model-supplied path to a real absolute path inside the roots, or refuse. */
export async function resolveUserPath(input: unknown, env: FsEnv, opts: { mustExist?: boolean } = {}): Promise<{ ok: true; abs: string; existed: boolean } | FsError> {
  if (typeof input !== "string" || !input.trim()) return err("bad_path", "A path is required.");
  let candidate = input.trim();
  // ⛔ Refuse `..` on the RAW input, before path.join gets a chance to resolve it
  // lexically — "..\escape.txt" relative to the workspace joins to a path that
  // LOOKS fine and would otherwise pass the fence (caught by the test suite).
  if (/(^|[\\/])\.\.([\\/]|$)/.test(candidate)) return err("unsafe_path", refusalText("unsafe_path"), candidate);
  // Expand the two shorthands people (and models) use.
  if (/^~([\\/]|$)/.test(candidate)) candidate = path.join(env.home, candidate.slice(1));
  candidate = candidate.replace(/%USERPROFILE%/gi, env.home).replace(/%HOMEPATH%/gi, env.home);
  if (!path.isAbsolute(candidate) && !/^[a-zA-Z]:/.test(candidate)) candidate = path.join(env.workspace, candidate);
  const scoped = resolveScopedPath(candidate, env.roots);
  if (!scoped.ok) return err(scoped.refused, refusalText(scoped.refused), candidate);
  const abs = path.win32.normalize(candidate.replace(/\//g, "\\"));
  // Realpath the nearest EXISTING ancestor and re-check: a junction inside home
  // that points at C:\Windows must fail closed even though the string passed.
  let probe = abs;
  let existed = true;
  for (;;) {
    try { await fsp.access(probe); break; } catch { /* keep walking up */ }
    const parent = path.dirname(probe);
    if (parent === probe) return err("unsafe_path", "That path has no reachable parent folder.", abs);
    probe = parent;
    existed = false;
  }
  let real: string;
  try { real = await fsp.realpath(probe); } catch { return err("unsafe_path", "That path could not be resolved on disk.", abs); }
  const reScoped = resolveScopedPath(real, env.roots);
  if (!reScoped.ok) return err("outside_allowed_roots", "That location points outside the folders the Coworker may use.", abs);
  if (opts.mustExist && !existed) return err("not_found", "Nothing exists at that path.", abs);
  return { ok: true, abs, existed };
}

export function refusalText(code: string): string {
  switch (code) {
    case "unsafe_path": return "That path is not one the Coworker will use (no '..', device names, network shares or short names).";
    case "forbidden_system_location": return "The Coworker never touches Windows system folders.";
    case "outside_allowed_roots": return "That location is outside the folders the Coworker may use (your own user folder and the coworker workspace).";
    case "no_allowed_roots": return "No folders are allowed for the Coworker on this computer.";
    default: return "The Coworker will not use that path.";
  }
}

function isoOrNull(d: Date | undefined): string | null { return d ? d.toISOString() : null; }

export async function fsStat(args: { path?: unknown }, env: FsEnv) {
  const r = await resolveUserPath(args.path, env);
  if (!r.ok) return r;
  try {
    const st = await fsp.stat(r.abs);
    return { ok: true, exists: true, path: r.abs, kind: st.isDirectory() ? "folder" : st.isFile() ? "file" : "other", sizeBytes: st.size, createdAt: isoOrNull(st.birthtime), modifiedAt: isoOrNull(st.mtime) };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { ok: true, exists: false, path: r.abs };
    return err("stat_failed", `Could not read that path (${e?.code ?? "error"}).`, r.abs);
  }
}

export async function fsList(args: { path?: unknown; recursive?: unknown; maxEntries?: unknown }, env: FsEnv) {
  const r = await resolveUserPath(args.path, env, { mustExist: true });
  if (!r.ok) return r;
  const max = Math.min(Math.max(1, Number(args.maxEntries) || 500), MAX_LIST_ENTRIES);
  const recursive = args.recursive === true;
  const entries: { name: string; path: string; kind: string; sizeBytes?: number; modifiedAt?: string | null }[] = [];
  let truncated = false;
  async function walk(dir: string, depth: number) {
    let list;
    try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of list) {
      if (entries.length >= max) { truncated = true; return; }
      const full = path.join(dir, d.name);
      const entry: (typeof entries)[number] = { name: d.name, path: full, kind: d.isDirectory() ? "folder" : d.isFile() ? "file" : d.isSymbolicLink() ? "link" : "other" };
      if (d.isFile()) { try { const st = await fsp.stat(full); entry.sizeBytes = st.size; entry.modifiedAt = isoOrNull(st.mtime); } catch { /* unreadable */ } }
      entries.push(entry);
      if (recursive && d.isDirectory() && !d.isSymbolicLink() && depth < 6) await walk(full, depth + 1);
    }
  }
  const st = await fsp.stat(r.abs);
  if (!st.isDirectory()) return err("not_a_folder", "That path is a file, not a folder.", r.abs);
  await walk(r.abs, 0);
  return { ok: true, path: r.abs, count: entries.length, truncated, entries };
}

export async function fsRead(args: { path?: unknown; maxChars?: unknown; offset?: unknown }, env: FsEnv) {
  const r = await resolveUserPath(args.path, env, { mustExist: true });
  if (!r.ok) return r;
  const max = Math.min(Math.max(100, Number(args.maxChars) || 20_000), MAX_READ_CHARS);
  const offset = Math.max(0, Number(args.offset) || 0);
  let st;
  try { st = await fsp.stat(r.abs); } catch { return err("not_found", "Nothing exists at that path.", r.abs); }
  if (st.isDirectory()) return err("is_a_folder", "That path is a folder; use computer_fs_list.", r.abs);
  if (st.size > 50 * 1024 * 1024) return err("too_large", `That file is ${st.size} bytes — too large to read here.`, r.abs);
  const buf = await fsp.readFile(r.abs);
  const probe = buf.subarray(0, Math.min(buf.length, 4096));
  const binary = probe.includes(0);
  if (binary) return { ok: true, path: r.abs, binary: true, sizeBytes: st.size, extension: path.extname(r.abs).toLowerCase(), note: "Binary file: contents not shown. For .xlsx use computer_xlsx_read." };
  const text = buf.toString("utf8");
  const slice = text.slice(offset, offset + max);
  return { ok: true, path: r.abs, sizeBytes: st.size, totalChars: text.length, offset, returnedChars: slice.length, truncated: offset + slice.length < text.length, content: slice };
}

export function globToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

export async function fsSearch(args: { path?: unknown; pattern?: unknown; maxResults?: unknown; includeFolders?: unknown }, env: FsEnv) {
  const r = await resolveUserPath(args.path, env, { mustExist: true });
  if (!r.ok) return r;
  const pattern = typeof args.pattern === "string" && args.pattern.trim() ? args.pattern.trim() : "*";
  const re = globToRegExp(pattern);
  const max = Math.min(Math.max(1, Number(args.maxResults) || 200), MAX_SEARCH_RESULTS);
  const includeFolders = args.includeFolders === true;
  const results: { name: string; path: string; kind: string; sizeBytes?: number; modifiedAt?: string | null }[] = [];
  let scanned = 0; let truncated = false;
  async function walk(dir: string, depth: number) {
    if (results.length >= max || scanned > 50_000) { truncated = true; return; }
    let list;
    try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      scanned++;
      const full = path.join(dir, d.name);
      if (d.isFile() && re.test(d.name)) {
        const entry: (typeof results)[number] = { name: d.name, path: full, kind: "file" };
        try { const st = await fsp.stat(full); entry.sizeBytes = st.size; entry.modifiedAt = isoOrNull(st.mtime); } catch { /* unreadable */ }
        results.push(entry);
      } else if (d.isDirectory() && includeFolders && re.test(d.name)) {
        results.push({ name: d.name, path: full, kind: "folder" });
      }
      if (results.length >= max) { truncated = true; return; }
      if (d.isDirectory() && !d.isSymbolicLink() && depth < MAX_WALK_DEPTH && !/^(node_modules|\.git|AppData)$/i.test(d.name)) await walk(full, depth + 1);
    }
  }
  await walk(r.abs, 0);
  return { ok: true, root: r.abs, pattern, count: results.length, truncated, results };
}

export async function fsMkdir(args: { path?: unknown }, env: FsEnv) {
  const r = await resolveUserPath(args.path, env);
  if (!r.ok) return r;
  try {
    const st = await fsp.stat(r.abs).catch(() => null);
    if (st?.isDirectory()) return { ok: true, path: r.abs, created: false, note: "The folder already existed." };
    if (st) return err("exists_as_file", "A file with that name already exists.", r.abs);
    await fsp.mkdir(r.abs, { recursive: true });
    const after = await fsp.stat(r.abs);
    return { ok: true, path: r.abs, created: true, verified: after.isDirectory() };
  } catch (e: any) {
    return err("mkdir_failed", `Could not create the folder (${e?.code ?? "error"}).`, r.abs);
  }
}

export async function fsWrite(args: { path?: unknown; content?: unknown; append?: unknown; overwrite?: unknown }, env: FsEnv) {
  const r = await resolveUserPath(args.path, env);
  if (!r.ok) return r;
  if (typeof args.content !== "string") return err("bad_content", "content must be a string.");
  const bytes = Buffer.byteLength(args.content, "utf8");
  if (bytes > MAX_WRITE_BYTES) return err("too_large", `The content is ${bytes} bytes; the limit is ${MAX_WRITE_BYTES}.`);
  try {
    const st = await fsp.stat(r.abs).catch(() => null);
    if (st?.isDirectory()) return err("is_a_folder", "That path is a folder.", r.abs);
    if (st && args.overwrite === false && args.append !== true) return err("exists", "The file already exists and overwrite was refused.", r.abs);
    await fsp.mkdir(path.dirname(r.abs), { recursive: true });
    if (args.append === true) await fsp.appendFile(r.abs, args.content, "utf8");
    else await fsp.writeFile(r.abs, args.content, "utf8");
    const after = await fsp.stat(r.abs);
    return { ok: true, path: r.abs, bytesWritten: bytes, sizeBytes: after.size, mode: args.append === true ? "appended" : st ? "overwritten" : "created" };
  } catch (e: any) {
    return err("write_failed", `Could not write the file (${e?.code ?? "error"}).`, r.abs);
  }
}

export async function fsMove(args: { from?: unknown; to?: unknown }, env: FsEnv) {
  const a = await resolveUserPath(args.from, env, { mustExist: true });
  if (!a.ok) return a;
  let toInput = args.to;
  // "rename to X" with a bare name: keep it beside the source.
  if (typeof toInput === "string" && !/[\\/]/.test(toInput) && !/^[a-zA-Z]:/.test(toInput)) toInput = path.join(path.dirname(a.abs), toInput);
  const b = await resolveUserPath(toInput, env);
  if (!b.ok) return b;
  try {
    let dest = b.abs;
    const destStat = await fsp.stat(dest).catch(() => null);
    if (destStat?.isDirectory()) dest = path.join(dest, path.basename(a.abs));
    if (await fsp.stat(dest).catch(() => null)) return err("exists", "Something already exists at the destination; the Coworker never overwrites.", dest);
    if (isInsideRoot(dest, a.abs) && normalizePath(dest) !== normalizePath(a.abs)) return err("into_itself", "A folder cannot be moved inside itself.", dest);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.rename(a.abs, dest);
    } catch (e: any) {
      if (e?.code !== "EXDEV") throw e;
      await fsp.cp(a.abs, dest, { recursive: true, errorOnExist: true, force: false });
      await fsp.rm(a.abs, { recursive: true });
    }
    const sourceGone = !(await fsp.stat(a.abs).catch(() => null));
    const destExists = !!(await fsp.stat(dest).catch(() => null));
    return { ok: sourceGone && destExists, from: a.abs, to: dest, verified: { sourceGone, destExists } };
  } catch (e: any) {
    return err("move_failed", `Could not move it (${e?.code ?? e?.message ?? "error"}).`, a.abs);
  }
}

export async function fsCopy(args: { from?: unknown; to?: unknown }, env: FsEnv) {
  const a = await resolveUserPath(args.from, env, { mustExist: true });
  if (!a.ok) return a;
  const b = await resolveUserPath(args.to, env);
  if (!b.ok) return b;
  try {
    let dest = b.abs;
    const destStat = await fsp.stat(dest).catch(() => null);
    if (destStat?.isDirectory()) dest = path.join(dest, path.basename(a.abs));
    if (await fsp.stat(dest).catch(() => null)) return err("exists", "Something already exists at the destination; the Coworker never overwrites.", dest);
    const src = await fsp.stat(a.abs);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (src.isDirectory()) await fsp.cp(a.abs, dest, { recursive: true, errorOnExist: true, force: false });
    else await fsp.copyFile(a.abs, dest, 1 /* COPYFILE_EXCL */);
    const after = await fsp.stat(dest);
    return { ok: true, from: a.abs, to: dest, bytes: src.isDirectory() ? null : after.size, sameSize: src.isDirectory() ? null : after.size === src.size };
  } catch (e: any) {
    return err("copy_failed", `Could not copy it (${e?.code ?? e?.message ?? "error"}).`, a.abs);
  }
}

export async function fsDelete(args: { path?: unknown; recursive?: unknown }, env: FsEnv) {
  const r = await resolveUserPath(args.path, env, { mustExist: true });
  if (!r.ok) return r;
  // ⛔ Never a root itself, never home, never the workspace root.
  for (const root of [env.home, env.workspace, ...env.roots]) if (normalizePath(root) === normalizePath(r.abs)) return err("refused_root", "The Coworker will not delete that folder.", r.abs);
  try {
    const st = await fsp.stat(r.abs);
    if (st.isDirectory()) {
      const inside = await fsp.readdir(r.abs);
      if (inside.length && args.recursive !== true) return err("not_empty", "The folder is not empty; pass recursive:true only if the person asked for everything inside to go.", r.abs);
      await fsp.rm(r.abs, { recursive: true });
    } else {
      await fsp.unlink(r.abs);
    }
    const gone = !(await fsp.stat(r.abs).catch(() => null));
    return { ok: gone, path: r.abs, deleted: gone };
  } catch (e: any) {
    return err("delete_failed", `Could not delete it (${e?.code ?? "error"}).`, r.abs);
  }
}
