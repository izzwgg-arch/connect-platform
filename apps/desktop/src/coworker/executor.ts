/**
 * The Coworker's hands — the half that touches the computer. Takes a task that
 * tasks.ts already accepted, resolves the named folder itself, and does exactly the
 * work planOrganize()/summarize() described, nothing more.
 *
 * ⛔ THE FOLDER IS RESOLVED HERE, FROM THE NAME, NEVER FROM A PATH IN THE REQUEST.
 * Downloads/Desktop/Documents under the signed-in user's own profile. Before any
 * write, the folder is realpath-resolved and re-checked to still be under the
 * home directory — a junction pointing Downloads at C:\Windows must fail closed.
 *
 * ⛔ MOVES ONLY. `rename` within the same folder tree; never `unlink`, never
 * `rm`, never an overwrite (a colliding name gets " (2)"). A file that cannot be
 * moved (open, locked, permission) is SKIPPED and reported, never retried, never
 * forced. Every move is recorded so the list can be shown and, later, undone.
 *
 * ⛔ Every filesystem call is injected so the tests drive this against a fake and
 * the real module is proven to call exactly the operations the fake saw.
 */
import { promises as realFs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CoworkerTask, type DirEntry, type CoworkerFolder,
  planOrganize, summarize, nextFreeName, formatBytes, FILE_CATEGORIES,
} from "./tasks";

export type FsLike = {
  readdir(dir: string): Promise<DirEntry[]>;
  realpath(p: string): Promise<string>;
  mkdir(dir: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  rename(from: string, to: string): Promise<void>;
};

export type ExecutorDeps = {
  fs?: FsLike;
  /** The signed-in user's home directory (os.homedir()). */
  homeDir?: string;
  /** Where the three named folders live. Defaults to the standard Windows layout. */
  folderPath?: (folder: CoworkerFolder) => string;
  system?: () => { platform: string; release: string; uptimeSec: number; totalMem: number; freeMem: number; cpus: number; hostname: string };
  now?: () => number;
  log?: (line: string) => void;
};

export type TaskResult = { ok: boolean; summary: string; details?: string[]; code?: string; moves?: { from: string; to: string }[] };

export const realFsLike: FsLike = {
  async readdir(dir) {
    const list = await realFs.readdir(dir, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const d of list) {
      const entry: DirEntry = { name: d.name, isFile: d.isFile(), isDirectory: d.isDirectory(), isSymlink: d.isSymbolicLink() };
      if (entry.isFile) {
        try { const st = await realFs.stat(path.join(dir, d.name)); entry.sizeBytes = st.size; entry.mtimeMs = st.mtimeMs; } catch { /* unreadable: size unknown */ }
      }
      out.push(entry);
    }
    return out;
  },
  realpath: (p) => realFs.realpath(p),
  mkdir: (dir) => realFs.mkdir(dir, { recursive: true }).then(() => undefined),
  exists: (p) => realFs.access(p).then(() => true, () => false),
  rename: (from, to) => realFs.rename(from, to),
};

function defaultFolderPath(home: string): (folder: CoworkerFolder) => string {
  return (folder) => path.join(home, folder === "downloads" ? "Downloads" : folder === "desktop" ? "Desktop" : "Documents");
}

function isInside(child: string, root: string): boolean {
  const c = path.resolve(child).toLowerCase().replace(/\\/g, "/");
  const r = path.resolve(root).toLowerCase().replace(/\\/g, "/").replace(/\/$/, "");
  return c === r || c.startsWith(`${r}/`);
}

export async function runCoworkerTask(task: CoworkerTask, deps: ExecutorDeps = {}): Promise<TaskResult> {
  const fs = deps.fs ?? realFsLike;
  const home = deps.homeDir ?? os.homedir();
  const folderPath = deps.folderPath ?? defaultFolderPath(home);
  const log = deps.log ?? (() => {});

  if (task.kind === "system_snapshot") {
    const s = deps.system?.() ?? {
      platform: `${os.type()} ${os.release()}`, release: os.release(), uptimeSec: os.uptime(),
      totalMem: os.totalmem(), freeMem: os.freemem(), cpus: os.cpus().length, hostname: os.hostname(),
    };
    const up = Math.round(s.uptimeSec / 3600);
    const details = [
      `Windows: ${s.platform}`,
      `Running for about ${up} hour${up === 1 ? "" : "s"} since the last restart`,
      `Memory: ${formatBytes(s.freeMem)} free of ${formatBytes(s.totalMem)}`,
      `Processors: ${s.cpus}`,
    ];
    return { ok: true, summary: `This computer runs ${s.platform}, has been up about ${up} hours, and has ${formatBytes(s.freeMem)} of ${formatBytes(s.totalMem)} memory free.`, details };
  }

  // Folder tasks: resolve the NAME to the real folder, then prove it is still home.
  const requested = folderPath(task.folder);
  let real: string;
  try { real = await fs.realpath(requested); } catch { return { ok: false, code: "folder_missing", summary: `Your ${task.folder} folder could not be found on this computer.` }; }
  if (!isInside(real, home)) {
    log(`coworker refused: ${task.folder} resolves outside the home directory`);
    return { ok: false, code: "folder_outside_home", summary: `Your ${task.folder} folder points somewhere the Coworker will not touch, so nothing was done.` };
  }

  let entries: DirEntry[];
  try { entries = await fs.readdir(real); } catch { return { ok: false, code: "folder_unreadable", summary: `Your ${task.folder} folder could not be read.` }; }

  if (task.kind === "folder_summary") {
    const s = summarize(entries);
    const details = FILE_CATEGORIES.filter((c) => s.byCategory[c].files > 0).map((c) => `${c}: ${s.byCategory[c].files} file${s.byCategory[c].files === 1 ? "" : "s"}, ${formatBytes(s.byCategory[c].bytes)}`);
    if (s.subfolders) details.push(`${s.subfolders} subfolder${s.subfolders === 1 ? "" : "s"} (not counted)`);
    for (const l of s.largest.slice(0, 3)) details.push(`Largest: ${l.name} (${formatBytes(l.bytes)})`);
    return { ok: true, summary: `${s.totalFiles} file${s.totalFiles === 1 ? "" : "s"} (${formatBytes(s.totalBytes)}) in your ${task.folder} folder.`, details };
  }

  // organize_folder
  const plan = planOrganize(entries);
  if (plan.length === 0) return { ok: true, summary: `Your ${task.folder} folder has no loose files to organize — nothing was moved.`, details: [] };
  const moves: { from: string; to: string }[] = [];
  const skipped: string[] = [];
  const counts = new Map<string, number>();
  for (const m of plan) {
    const targetDir = path.join(real, m.toFolder);
    const from = path.join(real, m.name);
    try {
      if (!isInside(targetDir, real)) throw new Error("target_outside_folder");
      await fs.mkdir(targetDir);
      let finalName = m.name;
      // Never overwrite: probe the destination and pick a free name.
      for (let i = 2; await fs.exists(path.join(targetDir, finalName)); i++) {
        const dot = m.name.lastIndexOf(".");
        finalName = dot > 0 ? `${m.name.slice(0, dot)} (${i})${m.name.slice(dot)}` : `${m.name} (${i})`;
        if (i > 999) throw new Error("no_free_name");
      }
      const to = path.join(targetDir, finalName);
      await fs.rename(from, to);
      moves.push({ from, to });
      counts.set(m.toFolder, (counts.get(m.toFolder) ?? 0) + 1);
    } catch (err) {
      skipped.push(m.name);
      log(`coworker organize skipped ${m.name}: ${String((err as Error)?.message ?? err)}`);
    }
  }
  const details = [...counts.entries()].map(([folder, n]) => `Moved ${n} file${n === 1 ? "" : "s"} to ${folder}`);
  if (skipped.length) details.push(`Left alone (open or locked): ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? ` and ${skipped.length - 8} more` : ""}`);
  const ok = moves.length > 0 || skipped.length === 0;
  return {
    ok,
    code: ok ? undefined : "nothing_moved",
    summary: `Organized your ${task.folder} folder: moved ${moves.length} file${moves.length === 1 ? "" : "s"} into ${counts.size} folder${counts.size === 1 ? "" : "s"}${skipped.length ? `, left ${skipped.length} alone` : ""}.`,
    details,
    moves,
  };
}
