import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  COWORKER_TASK_KINDS, COWORKER_FOLDERS, parseTask, decideLocally, planOrganize, summarize,
  nextFreeName, admitTask, newGate, MAX_TASKS_PER_HOUR, categorize, type DirEntry,
} from "./tasks";
import { runCoworkerTask, type FsLike } from "./executor";
import { registerCoworkerHands, COWORKER_DECIDE_CHANNEL, COWORKER_RUN_CHANNEL, normalizeProfile } from "./mainWiring";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/* ───────────── drift guard: the desktop copy must match the shared allowlist ───────────── */

test("the desktop allowlist matches packages/shared exactly (kinds and folders)", () => {
  const shared = read(path.resolve(__dirname, "../../../../packages/shared/src/coworker/tasks.ts"));
  const kinds = /COWORKER_TASK_KINDS = \[([^\]]+)\]/.exec(shared)?.[1]?.match(/"[a-z_]+"/g)?.map((s) => s.replace(/"/g, ""));
  const folders = /COWORKER_FOLDERS = \[([^\]]+)\]/.exec(shared)?.[1]?.match(/"[a-z_]+"/g)?.map((s) => s.replace(/"/g, ""));
  assert.deepEqual(kinds, [...COWORKER_TASK_KINDS]);
  assert.deepEqual(folders, [...COWORKER_FOLDERS]);
});

test("the desktop half imports nothing from the monorepo and nothing from the network", () => {
  for (const f of ["tasks.ts", "executor.ts", "mainWiring.ts"]) {
    const src = read(path.join(__dirname, f)).split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    assert.ok(!/@connect\//.test(src), `${f} imports from the monorepo`);
    assert.ok(!/node:http|node:https|fetch\(|child_process|exec\(|spawn\(/.test(src), `${f} reaches the network or a shell`);
  }
  const exec = read(path.join(__dirname, "executor.ts")).split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
  assert.ok(!/\b(unlink|rm|rmdir|rmSync|unlinkSync|writeFile)\b/.test(exec), "the executor deletes or overwrites — v1 is moves only");
});

/* ───────────── parse + local decision ───────────── */

test("parse refuses unknown kinds, unknown folders and any extra key", () => {
  assert.equal(parseTask({ kind: "organize_folder", folder: "downloads", reason: "r" }).ok, true);
  assert.deepEqual(parseTask({ kind: "run_command", reason: "r" }), { ok: false, refused: "unknown_task_kind" });
  assert.deepEqual(parseTask({ kind: "folder_summary", folder: "C:/", reason: "r" }), { ok: false, refused: "unknown_folder" });
  assert.deepEqual(parseTask({ kind: "folder_summary", folder: "desktop", path: "x" }), { ok: false, refused: "unexpected_field:path" });
  assert.equal(parseTask(undefined).ok, false);
});

test("reads always allow; a write asks under SAFE, allows under TRUSTED, and always asks during a call", () => {
  const read1 = { kind: "folder_summary" as const, folder: "downloads" as const, reason: "" };
  const write = { kind: "organize_folder" as const, folder: "downloads" as const, reason: "" };
  assert.equal(decideLocally(read1, "SAFE", { callActive: false }).verdict, "allow");
  assert.equal(decideLocally(write, "SAFE", { callActive: false }).verdict, "ask");
  assert.equal(decideLocally(write, "TRUSTED", { callActive: false }).verdict, "allow");
  assert.equal(decideLocally(write, "TRUSTED", { callActive: true }).verdict, "ask");
  assert.equal(normalizeProfile("ADMIN"), "SAFE");
  assert.equal(normalizeProfile("TRUSTED"), "TRUSTED");
});

/* ───────────── planning ───────────── */

const entry = (name: string, extra: Partial<DirEntry> = {}): DirEntry => ({ name, isFile: true, isDirectory: false, isSymlink: false, sizeBytes: 10, ...extra });

test("planOrganize moves top-level files only — never folders, symlinks, hidden, system or in-flight downloads", () => {
  const plan = planOrganize([
    entry("report.pdf"), entry("photo.JPG"), entry("setup.exe"), entry("notes"),
    entry("Images", { isFile: false, isDirectory: true }),
    entry("link.pdf", { isSymlink: true }),
    entry(".hidden"), entry("~$draft.docx"), entry("desktop.ini"), entry("big.iso.crdownload"),
  ]);
  assert.deepEqual(plan, [
    { name: "report.pdf", toFolder: "PDFs" },
    { name: "photo.JPG", toFolder: "Images" },
    { name: "setup.exe", toFolder: "Installers" },
    { name: "notes", toFolder: "Other" },
  ]);
  assert.equal(categorize("archive.tar.gz"), "Archives");
});

test("summarize counts files by category and never counts a folder or symlink as a file", () => {
  const s = summarize([entry("a.pdf", { sizeBytes: 100 }), entry("b.png", { sizeBytes: 50 }), entry("sub", { isFile: false, isDirectory: true }), entry("l.pdf", { isSymlink: true })]);
  assert.equal(s.totalFiles, 2);
  assert.equal(s.totalBytes, 150);
  assert.equal(s.subfolders, 1);
  assert.equal(s.largest[0].name, "a.pdf");
});

test("nextFreeName never overwrites", () => {
  const taken = new Set(["a.pdf", "a (2).pdf"]);
  assert.equal(nextFreeName("a.pdf", (n) => taken.has(n)), "a (3).pdf");
  assert.equal(nextFreeName("b.pdf", (n) => taken.has(n)), "b.pdf");
});

test("the local gate caps tasks per hour and spaces writes per folder", () => {
  const g = newGate();
  const w = { kind: "organize_folder" as const, folder: "downloads" as const, reason: "" };
  const T = 100_000;
  assert.equal(admitTask(g, w, T).ok, true);
  assert.deepEqual(admitTask(g, w, T + 1_000), { ok: false, refused: "too_soon_for_this_folder" });
  assert.equal(admitTask(g, { ...w, folder: "desktop" }, T + 1_000).ok, true, "a different folder is not spaced by the first");
  assert.equal(admitTask(g, w, T + 61_000).ok, true, "the same folder is fine again after a minute");
  const g2 = newGate();
  for (let i = 0; i < MAX_TASKS_PER_HOUR; i++) assert.equal(admitTask(g2, { kind: "system_snapshot", reason: "" }, T + i).ok, true);
  assert.deepEqual(admitTask(g2, { kind: "system_snapshot", reason: "" }, T + MAX_TASKS_PER_HOUR), { ok: false, refused: "rate_limited" });
});

/* ───────────── executor against a fake filesystem ───────────── */

function fakeFs(opts: { home: string; folder: string; real?: string; files: DirEntry[]; existing?: string[]; failRename?: string[] }) {
  const calls: string[] = [];
  const existing = new Set(opts.existing ?? []);
  const fs: FsLike = {
    async readdir(dir) { calls.push(`readdir ${dir}`); return opts.files; },
    async realpath(p) { calls.push(`realpath ${p}`); if (p !== opts.folder) throw new Error("ENOENT"); return opts.real ?? opts.folder; },
    async mkdir(dir) { calls.push(`mkdir ${dir}`); },
    async exists(p) { return existing.has(p); },
    async rename(from, to) {
      calls.push(`rename ${from} -> ${to}`);
      if (opts.failRename?.some((f) => from.endsWith(f))) throw new Error("EBUSY");
      existing.add(to);
    },
  };
  return { fs, calls };
}

const HOME = "C:\\Users\\izzy";
const DL = "C:\\Users\\izzy\\Downloads";

test("organize_folder moves by rename only, never overwrites, and skips a locked file without failing the task", async () => {
  const { fs, calls } = fakeFs({ home: HOME, folder: DL, files: [entry("a.pdf"), entry("b.pdf"), entry("locked.pdf")], existing: [`${DL}\\PDFs\\b.pdf`], failRename: ["locked.pdf"] });
  const r = await runCoworkerTask({ kind: "organize_folder", folder: "downloads", reason: "" }, { fs, homeDir: HOME, folderPath: () => DL });
  assert.equal(r.ok, true);
  assert.equal(r.moves!.length, 2);
  assert.ok(calls.includes(`rename ${DL}\\a.pdf -> ${DL}\\PDFs\\a.pdf`));
  assert.ok(calls.includes(`rename ${DL}\\b.pdf -> ${DL}\\PDFs\\b (2).pdf`), "collision gets (2), never overwritten");
  assert.match(r.summary, /moved 2 files into 1 folder, left 1 alone/);
  assert.ok(r.details!.some((d) => d.includes("locked.pdf")));
  assert.ok(!calls.some((c) => /unlink|rm/.test(c)));
});

test("a folder whose realpath leaves the home directory is refused before anything is read", async () => {
  const { fs, calls } = fakeFs({ home: HOME, folder: DL, real: "C:\\Windows\\System32", files: [entry("a.pdf")] });
  const r = await runCoworkerTask({ kind: "organize_folder", folder: "downloads", reason: "" }, { fs, homeDir: HOME, folderPath: () => DL });
  assert.equal(r.ok, false);
  assert.equal(r.code, "folder_outside_home");
  assert.ok(!calls.some((c) => c.startsWith("readdir")), "nothing was read");
  assert.ok(!calls.some((c) => c.startsWith("rename")), "nothing was moved");
});

test("folder_summary reads and never writes; system_snapshot names no path", async () => {
  const { fs, calls } = fakeFs({ home: HOME, folder: DL, files: [entry("a.pdf", { sizeBytes: 2048 }), entry("b.png")] });
  const r = await runCoworkerTask({ kind: "folder_summary", folder: "downloads", reason: "" }, { fs, homeDir: HOME, folderPath: () => DL });
  assert.equal(r.ok, true);
  assert.match(r.summary, /2 files/);
  assert.ok(!calls.some((c) => /rename|mkdir/.test(c)));
  const s = await runCoworkerTask({ kind: "system_snapshot", reason: "" }, { system: () => ({ platform: "Windows 11", release: "10.0", uptimeSec: 7200, totalMem: 16e9, freeMem: 4e9, cpus: 8, hostname: "PC" }) });
  assert.equal(s.ok, true);
  assert.ok(!/[A-Za-z]:[\\/]/.test(s.summary + s.details!.join(" ")));
});

/* ───────────── the IPC wiring ───────────── */

function fakeIpc() {
  const handlers = new Map<string, (e: unknown, ...a: any[]) => any>();
  return { ipcMain: { handle: (c: string, fn: any) => { handlers.set(c, fn); } }, call: (c: string, ...a: any[]) => handlers.get(c)!({}, ...a), channels: () => [...handlers.keys()] };
}

test("exactly two channels are registered and both refuse anything off the allowlist", async () => {
  const ipc = fakeIpc();
  registerCoworkerHands({ ipcMain: ipc.ipcMain, getProfile: () => "SAFE", isCallActive: () => false });
  assert.deepEqual(ipc.channels().sort(), [COWORKER_DECIDE_CHANNEL, COWORKER_RUN_CHANNEL].sort());
  assert.deepEqual(ipc.call(COWORKER_DECIDE_CHANNEL, { kind: "shell", cmd: "rm" }), { ok: false, refused: "unknown_task_kind" });
  assert.deepEqual(await ipc.call(COWORKER_RUN_CHANNEL, { id: "t1", task: { kind: "organize_folder", folder: "downloads", path: "C:/" } }), { ok: false, refused: "unexpected_field:path" });
  assert.deepEqual(await ipc.call(COWORKER_RUN_CHANNEL, { task: { kind: "system_snapshot", reason: "" } }), { ok: false, refused: "missing_task_id" });
});

test("run strips the move paths from what goes back to the page, and a throw never leaks its message", async () => {
  const ipc = fakeIpc();
  const { fs } = fakeFs({ home: HOME, folder: DL, files: [entry("a.pdf")] });
  registerCoworkerHands({ ipcMain: ipc.ipcMain, getProfile: () => "TRUSTED", isCallActive: () => false, executor: { fs, homeDir: HOME, folderPath: () => DL } });
  const r = await ipc.call(COWORKER_RUN_CHANNEL, { id: "t1", task: { kind: "organize_folder", folder: "downloads", reason: "" } });
  assert.equal(r.ok, true);
  assert.equal("moves" in r.result, false);
  assert.ok(!JSON.stringify(r).includes(HOME), "no path reaches the renderer");
  const ipc2 = fakeIpc();
  registerCoworkerHands({ ipcMain: ipc2.ipcMain, getProfile: () => "TRUSTED", isCallActive: () => false, executor: { fs: { ...fs, realpath: async () => { throw new Error("secret C:\\x"); } }, homeDir: HOME, folderPath: () => DL } });
  const r2 = await ipc2.call(COWORKER_RUN_CHANNEL, { id: "t2", task: { kind: "folder_summary", folder: "downloads", reason: "" } });
  assert.ok(!JSON.stringify(r2).includes("secret"));
});

test("the run channel re-decides at run time: a write during a call comes back 'ask', not a move", () => {
  const ipc = fakeIpc();
  let onCall = false;
  registerCoworkerHands({ ipcMain: ipc.ipcMain, getProfile: () => "TRUSTED", isCallActive: () => onCall });
  assert.equal(ipc.call(COWORKER_DECIDE_CHANNEL, { kind: "organize_folder", folder: "downloads", reason: "" }).verdict.verdict, "allow");
  onCall = true;
  assert.equal(ipc.call(COWORKER_DECIDE_CHANNEL, { kind: "organize_folder", folder: "downloads", reason: "" }).verdict.verdict, "ask");
});

/* ───────────── wiring guards (read SOURCE — the defect class here is a caller) ───────────── */

test("main.ts registers the hands with the call state and the stored profile; preload exposes decideTask + runTask on the same two channels", () => {
  const main = read(path.resolve(__dirname, "../main.ts"));
  assert.ok(/registerCoworkerHands\(\{/.test(main), "main.ts does not register the coworker hands");
  assert.ok(/getProfile:\s*\(\)\s*=>\s*settings\.coworkerPermissions/.test(main), "profile must come from DesktopSettings.coworkerPermissions");
  assert.ok(/isCallActive:\s*\(\)\s*=>\s*isPhoneOnCall\(\)/.test(main), "call protection must read the live phone state");
  const preload = read(path.resolve(__dirname, "../preload.ts"));
  assert.ok(preload.includes(`ipcRenderer.invoke("${COWORKER_DECIDE_CHANNEL}"`), "preload decideTask channel");
  assert.ok(preload.includes(`ipcRenderer.invoke("${COWORKER_RUN_CHANNEL}"`), "preload runTask channel");
  assert.ok(!/coworker:(shell|exec|open|path)/.test(preload), "no extra coworker channel may exist");
  const types = read(path.resolve(__dirname, "../types.ts"));
  assert.ok(/coworkerPermissions\?: "SAFE" \| "TRUSTED"/.test(types));
});
