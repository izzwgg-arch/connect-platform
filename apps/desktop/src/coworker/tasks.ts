/**
 * The Coworker's hands — the pure half that lives ON the customer's computer.
 *
 * ⛔⛔ THIS IS THE SECURITY BOUNDARY FOR THE COMPUTER. The server, the agent and the
 * portal can only ever ask for one of the task kinds below, on one of the folders
 * below, and this module decides whether that is allowed at all before anything
 * touches the filesystem. Same posture as phoneSetup/capability.ts: a smart head on
 * the server, dumb hands here — so a compromised server cannot reach past the list.
 *
 * ⛔ The KIND and FOLDER lists are a COPY of packages/shared/src/coworker/tasks.ts
 * (the desktop app bundles nothing from the monorepo). `coworker.test.ts` reads
 * that file and fails if the two lists ever differ.
 *
 * ⛔ Pure: no fs, no os, no Electron. Everything with a side effect is in
 * executor.ts and takes this module's decisions as input.
 */

export const COWORKER_TASK_KINDS = ["folder_summary", "organize_folder", "system_snapshot"] as const;
export type CoworkerTaskKind = (typeof COWORKER_TASK_KINDS)[number];

export const COWORKER_FOLDERS = ["downloads", "desktop", "documents"] as const;
export type CoworkerFolder = (typeof COWORKER_FOLDERS)[number];

export type CoworkerTask =
  | { kind: "folder_summary"; folder: CoworkerFolder; reason: string }
  | { kind: "organize_folder"; folder: CoworkerFolder; reason: string }
  | { kind: "system_snapshot"; reason: string };

/** The desktop-side permission profile. Stored in DesktopSettings; SAFE when absent. */
export const COWORKER_PROFILES = ["SAFE", "TRUSTED"] as const;
export type CoworkerProfile = (typeof COWORKER_PROFILES)[number];

export type LocalVerdict = { verdict: "allow" | "ask" | "deny"; code: string; message: string };

/** Strict parse: unknown kinds, folders and EXTRA KEYS are refusals. */
export function parseTask(raw: unknown): { ok: true; task: CoworkerTask } | { ok: false; refused: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, refused: "not_an_object" };
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (typeof kind !== "string" || !(COWORKER_TASK_KINDS as readonly string[]).includes(kind)) return { ok: false, refused: "unknown_task_kind" };
  const allowed = new Set(kind === "system_snapshot" ? ["kind", "reason"] : ["kind", "folder", "reason"]);
  for (const k of Object.keys(r)) if (!allowed.has(k)) return { ok: false, refused: `unexpected_field:${k.slice(0, 32)}` };
  const reason = typeof r.reason === "string" ? r.reason.slice(0, 200) : "";
  if (kind === "system_snapshot") return { ok: true, task: { kind, reason } };
  const folder = r.folder;
  if (typeof folder !== "string" || !(COWORKER_FOLDERS as readonly string[]).includes(folder)) return { ok: false, refused: "unknown_folder" };
  return { ok: true, task: { kind: kind as "folder_summary" | "organize_folder", folder: folder as CoworkerFolder, reason } };
}

/**
 * The local decision. Mirrors the SAFE/TRUSTED rows of the shared policy for the
 * three domains these tasks use: reads are always allowed, a write asks under SAFE
 * and is allowed under TRUSTED. ⛔ Nothing here can ever answer "allow" for a kind
 * that is not in the list, and the caller must still refuse to run without the
 * person's approval when the verdict is "ask".
 */
export function decideLocally(task: CoworkerTask, profile: CoworkerProfile, opts: { callActive: boolean }): LocalVerdict {
  if (task.kind === "folder_summary" || task.kind === "system_snapshot") {
    return { verdict: "allow", code: "read_only", message: "This only reads; nothing on the computer changes." };
  }
  // organize_folder: a write.
  if (opts.callActive) {
    // Not a media risk, but a customer mid-call should not have their files shuffled
    // under them; the task waits for the person's explicit press either way.
    return { verdict: "ask", code: "call_in_progress", message: "You are on a call — the Coworker will wait for your OK." };
  }
  if (profile === "TRUSTED") return { verdict: "allow", code: "trusted_profile_write", message: "Allowed by your Trusted setting: a reversible move inside your own folder." };
  return { verdict: "ask", code: "safe_profile_write", message: "This moves files, so the Coworker asks first." };
}

/* ────────────────────────── organizing ──────────────────────────── */

export const FILE_CATEGORIES = ["Images", "Documents", "Spreadsheets", "PDFs", "Presentations", "Installers", "Archives", "Videos", "Audio", "Other"] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

const EXT: Record<string, FileCategory> = {
  jpg: "Images", jpeg: "Images", png: "Images", gif: "Images", webp: "Images", bmp: "Images", heic: "Images", svg: "Images", tif: "Images", tiff: "Images",
  doc: "Documents", docx: "Documents", txt: "Documents", rtf: "Documents", odt: "Documents", md: "Documents",
  xls: "Spreadsheets", xlsx: "Spreadsheets", csv: "Spreadsheets", ods: "Spreadsheets",
  pdf: "PDFs",
  ppt: "Presentations", pptx: "Presentations", odp: "Presentations",
  exe: "Installers", msi: "Installers", msix: "Installers", appx: "Installers",
  zip: "Archives", rar: "Archives", "7z": "Archives", gz: "Archives", tar: "Archives",
  mp4: "Videos", mov: "Videos", avi: "Videos", mkv: "Videos", wmv: "Videos", webm: "Videos",
  mp3: "Audio", wav: "Audio", m4a: "Audio", flac: "Audio", ogg: "Audio", aac: "Audio",
};

export function categorize(fileName: string): FileCategory {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "Other";
  return EXT[fileName.slice(dot + 1).toLowerCase()] ?? "Other";
}

/** What the executor tells us about one directory entry. Symlinks are NOT files here. */
export type DirEntry = { name: string; isFile: boolean; isDirectory: boolean; isSymlink: boolean; sizeBytes?: number; mtimeMs?: number };

/** Names Windows or the user rely on staying where they are. */
const NEVER_MOVE = new Set(["desktop.ini", "thumbs.db", ".ds_store"]);

export type PlannedMove = { name: string; toFolder: FileCategory };

/**
 * Which files an organize would move, and where. ⛔ Moves only top-level FILES
 * (never folders, never symlinks/junctions, never hidden/system names, never a file
 * already sitting in a category folder — those are one level down and never listed
 * here), into a subfolder named after its category. The executor is not allowed to
 * move anything this function did not name.
 */
export function planOrganize(entries: readonly DirEntry[]): PlannedMove[] {
  const moves: PlannedMove[] = [];
  for (const e of entries) {
    if (!e.isFile || e.isDirectory || e.isSymlink) continue;
    const lower = e.name.toLowerCase();
    if (lower.startsWith(".") || lower.startsWith("~$") || NEVER_MOVE.has(lower)) continue;
    if (/\.(crdownload|part|tmp|download)$/i.test(lower)) continue; // a download still in flight
    moves.push({ name: e.name, toFolder: categorize(e.name) });
  }
  return moves;
}

export type FolderSummary = {
  totalFiles: number;
  totalBytes: number;
  byCategory: Record<FileCategory, { files: number; bytes: number }>;
  subfolders: number;
  largest: { name: string; bytes: number }[];
};

export function summarize(entries: readonly DirEntry[]): FolderSummary {
  const byCategory = Object.fromEntries(FILE_CATEGORIES.map((c) => [c, { files: 0, bytes: 0 }])) as FolderSummary["byCategory"];
  let totalFiles = 0, totalBytes = 0, subfolders = 0;
  const files: { name: string; bytes: number }[] = [];
  for (const e of entries) {
    if (e.isDirectory) { subfolders++; continue; }
    if (!e.isFile || e.isSymlink) continue;
    const c = categorize(e.name);
    const bytes = e.sizeBytes ?? 0;
    byCategory[c].files++; byCategory[c].bytes += bytes;
    totalFiles++; totalBytes += bytes;
    files.push({ name: e.name, bytes });
  }
  files.sort((a, b) => b.bytes - a.bytes);
  return { totalFiles, totalBytes, byCategory, subfolders, largest: files.slice(0, 5) };
}

/** A name that does not collide: "report.pdf" → "report (2).pdf" → "report (3).pdf" … */
export function nextFreeName(name: string, exists: (candidate: string) => boolean): string {
  if (!exists(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error("no_free_name");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/* ─────────────────────────── rate limits ────────────────────────── */

/**
 * ⛔ Enforced HERE, on the customer's machine, because the server is the thing that
 * might be compromised. A server that asks to organize the same folder two hundred
 * times gets refused locally.
 */
export const MIN_MS_BETWEEN_WRITES_PER_FOLDER = 60_000;
export const MAX_TASKS_PER_HOUR = 30;

export type Gate = { lastWriteAt: Map<string, number>; taskTimes: number[] };
export function newGate(): Gate { return { lastWriteAt: new Map(), taskTimes: [] }; }

export function admitTask(gate: Gate, task: CoworkerTask, now: number): { ok: true } | { ok: false; refused: string } {
  gate.taskTimes = gate.taskTimes.filter((t) => now - t < 3_600_000);
  if (gate.taskTimes.length >= MAX_TASKS_PER_HOUR) return { ok: false, refused: "rate_limited" };
  if (task.kind === "organize_folder") {
    const last = gate.lastWriteAt.get(task.folder) ?? 0;
    if (now - last < MIN_MS_BETWEEN_WRITES_PER_FOLDER) return { ok: false, refused: "too_soon_for_this_folder" };
    gate.lastWriteAt.set(task.folder, now);
  }
  gate.taskTimes.push(now);
  return { ok: true };
}
