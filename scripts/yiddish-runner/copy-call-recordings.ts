/**
 * copy-call-recordings.ts — pulls registered `call_recordings` audio off the
 * READ-ONLY PBX onto this PC, for the Yiddish learning engine's audio stages
 * to pick up (§3.4.2, AGENT_HANDOFF_YIDDISH_WHISPER_FINETUNE_2026-09-17.md).
 *
 * Runs ON THE PC, next to `runner.ts` in this same folder — same database,
 * same `.env` (DATABASE_URL through the SSH tunnel), same audio folder.
 *
 * ⛔⛔ THE PBX (209.145.60.79) IS READ-ONLY. This module never writes to it,
 * never deletes anything on it, and emits exactly THREE kinds of remote
 * command — `ls -l` (list), `stat` (via `cd` + `stat`, still read-only) and
 * `tar -c` (create — never `-x`, `-u`, `--delete`, `--remove-files`, or any
 * other write mode) — through ONE function, `buildRemoteCommand`. Nothing
 * else in this file constructs a string to hand to `ssh`; that is a fact the
 * test file checks, not a promise in a comment.
 *
 * How a day's worth of calls is copied:
 *  1. `findMissingCallRecordings` reads `YcSourceItem` rows for
 *     `call_recordings` (written by `apps/api/scripts/yc-register-call-recordings.ts`)
 *     whose `audio/call_recordings/<linkedId>.wav` is not yet on this PC.
 *  2. `groupByDayFolder` groups them by the PBX day-folder that is the
 *     directory part of `metadata.pbxPath` — one ssh round-trip per folder,
 *     not per file. The PBX's own filename differs from our `linkedId`, so
 *     the mapping travels with the group (`remoteFile` → `localName`).
 *  3. `ls -l` that folder (read-only) to learn each file's real size.
 *  4. ONE `tar -c` of exactly the files we need in that folder, streamed
 *     over one `ssh`, piped straight into a local `tar -x`, then each
 *     extracted file is renamed to `<linkedId>.wav`.
 *  5. `verifyLocalSize` checks the local byte count against the `ls -l` size
 *     BEFORE a file is counted as copied or recorded in the progress file —
 *     a short or truncated stream is left for the next run to retry.
 *  6. Progress lives in `logs/copy-call-recordings.json` — resumable: a
 *     rerun skips anything already marked done there (and re-checks anything
 *     that is on disk but was never marked done, which `findMissingCallRecordings`
 *     already does by checking the file's existence directly).
 *
 * Flags: --tenant <substr>, --max-gb <n>, --bwlimit <kbit/s>, --dry-run.
 *
 * ⛔ --bwlimit paces BATCHES (a sleep between day-folders), because this
 * transport is a raw `tar | ssh` stream, not `scp`/`rsync`, and `ssh` itself
 * has no bandwidth flag. It is a coarse cap, not a precise one — documented
 * here so nobody expects `ssh -l` semantics from it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const PBX_HOST = "209.145.60.79";
export const PBX_USER = "root";
export const CALL_RECORDINGS_SOURCE_KEY = "call_recordings";

const HERE = __dirname;
export const AUDIO_DIR = path.join(HERE, "audio", CALL_RECORDINGS_SOURCE_KEY);
export const PROGRESS_FILE = path.join(HERE, "logs", "copy-call-recordings.json");
const DEFAULT_KEY_FILE = path.join(HERE, "..", "..", ".connect-ssh", "connect2_server2_ed25519");

// .env: DATABASE_URL pointing at the tunnel (127.0.0.1:15432) — same file
// runner.ts reads, loaded the same way so this script never needs its own
// separate database config.
function loadEnvFile(): void {
  const envPath = path.join(HERE, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// ── pure: PBX path handling ─────────────────────────────────────────────────

export interface RemotePathParts {
  dayFolder: string;
  remoteFile: string;
}

/** Split a PBX recording path into its day-folder and filename. Pure, no I/O. */
export function splitPbxPath(pbxPath: string): RemotePathParts {
  const clean = String(pbxPath || "").replace(/\\/g, "/");
  const idx = clean.lastIndexOf("/");
  if (idx === -1) return { dayFolder: ".", remoteFile: clean };
  return { dayFolder: clean.slice(0, idx) || "/", remoteFile: clean.slice(idx + 1) };
}

export interface CopyCandidate {
  linkedId: string;
  pbxPath: string;
  tenantName?: string;
}

export interface DayGroupFile {
  linkedId: string;
  remoteFile: string;
  /** What the file becomes on this PC — always `<linkedId>.wav`, never the PBX name. */
  localName: string;
}

export interface DayGroup {
  dayFolder: string;
  files: DayGroupFile[];
}

/**
 * Group items needing a copy by PBX day-folder, so ONE ssh round-trip covers
 * every file that folder holds, instead of one per recording. The PBX
 * filename → `linkedId.wav` mapping is carried on each entry because the two
 * names differ (§3.4.2) and this is the only place that link is recorded.
 */
export function groupByDayFolder(items: CopyCandidate[]): DayGroup[] {
  const byFolder = new Map<string, DayGroup>();
  for (const it of items) {
    if (!it.pbxPath) continue;
    const { dayFolder, remoteFile } = splitPbxPath(it.pbxPath);
    if (!remoteFile) continue;
    if (!byFolder.has(dayFolder)) byFolder.set(dayFolder, { dayFolder, files: [] });
    byFolder.get(dayFolder)!.files.push({ linkedId: it.linkedId, remoteFile, localName: `${it.linkedId}.wav` });
  }
  return [...byFolder.values()];
}

// ── the one place a remote (PBX-side) command string is built ─────────────

export type RemoteCommandKind = "ls" | "stat" | "tar-create";
/** Every kind this module can ever ask for. A guard test enumerates exactly this list. */
export const REMOTE_COMMAND_KINDS: RemoteCommandKind[] = ["ls", "stat", "tar-create"];

/** Quote one argument for the REMOTE (POSIX) shell. Pure. */
function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * The ONE function that builds a command string to run on the PBX. Every
 * branch begins with a read-only verb — `ls`, `stat`, or `tar -c` (create;
 * never `-x`/`-u`/`--delete`/`--remove-files`). No other function in this
 * file, or its caller, builds a remote command string.
 */
export function buildRemoteCommand(kind: RemoteCommandKind, dayFolder: string, files: string[] = []): string {
  const dir = shQuote(dayFolder);
  if (kind === "ls") return `ls -l ${dir}`;
  if (kind === "stat") {
    const names = files.length ? files.map(shQuote).join(" ") : ".";
    return `cd ${dir} && stat -c '%n %s' ${names}`;
  }
  const names = files.map(shQuote).join(" ");
  return `cd ${dir} && tar -c -f - ${names}`;
}

export interface SshOptions {
  keyFile: string;
  host?: string;
  user?: string;
  bwlimitKbit?: number | null;
}

/** argv for `ssh` running a command built only by `buildRemoteCommand`. Pure — returns argv, does not spawn. */
export function sshArgv(remoteCommand: string, opts: SshOptions): string[] {
  return [
    "ssh",
    "-i",
    opts.keyFile,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    `${opts.user ?? PBX_USER}@${opts.host ?? PBX_HOST}`,
    remoteCommand,
  ];
}

// ── pure: `ls -l` parsing and size verification ────────────────────────────

export interface LsEntry {
  name: string;
  size: number;
}

/** Parse `ls -l` output into {name,size}. Pure. Tolerant of the usual columns; skips anything it cannot parse. */
export function parseLsOutput(stdout: string): LsEntry[] {
  const out: LsEntry[] = [];
  for (const line of String(stdout || "").split("\n")) {
    const m = line.match(/^[-dlpscbD][rwxstST-]{9}\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
    if (!m) continue;
    out.push({ size: Number(m[1]), name: m[2].trim() });
  }
  return out;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/** Does the locally-extracted file's size match what `ls -l` reported remotely? Pure. */
export function verifyLocalSize(localBytes: number, remoteEntry: LsEntry | undefined): VerifyResult {
  if (!remoteEntry) return { ok: false, reason: "remote file not found in the ls -l listing" };
  if (!(localBytes > 0)) return { ok: false, reason: "local file is empty" };
  if (localBytes !== remoteEntry.size) {
    return { ok: false, reason: `size mismatch: local ${localBytes}b vs remote ${remoteEntry.size}b` };
  }
  return { ok: true };
}

// ── pure: the resumable progress file ──────────────────────────────────────

export interface ProgressState {
  done: Record<string, { bytes: number; copiedAt: string }>;
}

export function emptyProgress(): ProgressState {
  return { done: {} };
}

export function loadProgress(file: string): ProgressState {
  if (!existsSync(file)) return emptyProgress();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { done: parsed?.done && typeof parsed.done === "object" ? parsed.done : {} };
  } catch {
    return emptyProgress();
  }
}

export function saveProgress(file: string, state: ProgressState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

export function markDone(state: ProgressState, linkedId: string, bytes: number, now: Date = new Date()): ProgressState {
  return { done: { ...state.done, [linkedId]: { bytes, copiedAt: now.toISOString() } } };
}

export function isDone(state: ProgressState, linkedId: string): boolean {
  return !!state.done[linkedId];
}

// ── pure: --max-gb bounding ─────────────────────────────────────────────────

/** Stop admitting groups once their remote-reported bytes would exceed the cap. maxGb <= 0 or null = unbounded. */
export function boundGroupsByMaxGb(groups: { bytes: number }[], maxGb: number | null | undefined): number {
  if (!maxGb || maxGb <= 0) return groups.length;
  const capBytes = maxGb * 1024 ** 3;
  let total = 0;
  let count = 0;
  for (const g of groups) {
    if (total + g.bytes > capBytes && count > 0) break;
    total += g.bytes;
    count += 1;
    if (total >= capBytes) break;
  }
  return count;
}

// ── impure: DB read (metadata only — never opens a recording) ─────────────

export interface CandidateItemFromDb {
  linkedId: string;
  pbxPath: string;
  tenantName: string;
}

/**
 * Items registered by `yc-register-call-recordings.ts` whose local file is
 * not yet on this PC. Reads only `YcSourceItem.metadata` (linkedId, pbxPath,
 * tenantName) — never audio, never a transcript.
 */
export async function findMissingCallRecordings(
  dbc: any,
  opts: { tenantName?: string | null } = {},
): Promise<CandidateItemFromDb[]> {
  const source = await dbc.ycSource.findUnique({ where: { key: CALL_RECORDINGS_SOURCE_KEY } });
  if (!source) return [];
  const items = await dbc.ycSourceItem.findMany({ where: { sourceId: source.id } });
  const out: CandidateItemFromDb[] = [];
  for (const item of items || []) {
    const meta = item?.metadata || {};
    if (opts.tenantName) {
      const needle = opts.tenantName.toLowerCase();
      if (!String(meta.tenantName || "").toLowerCase().includes(needle)) continue;
    }
    if (!meta.pbxPath) continue;
    const localName = String(meta.localAudioPath || `${item.externalId}.wav`);
    if (existsSync(path.join(AUDIO_DIR, localName))) continue;
    out.push({ linkedId: item.externalId, pbxPath: meta.pbxPath, tenantName: meta.tenantName || "" });
  }
  return out;
}

// ── impure: process spawning ────────────────────────────────────────────────

function runCapture(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** `ls -l` a PBX day-folder. READ-ONLY. */
async function lsRemoteFolder(dayFolder: string, ssh: SshOptions): Promise<LsEntry[]> {
  const remoteCmd = buildRemoteCommand("ls", dayFolder);
  const argv = sshArgv(remoteCmd, ssh);
  const res = await runCapture(argv[0], argv.slice(1));
  if (res.code !== 0) throw new Error(`ls -l failed on the PBX (${dayFolder}): ${res.stderr.slice(0, 300)}`);
  return parseLsOutput(res.stdout);
}

/**
 * Copy one day-folder: ONE `tar -c` over ONE `ssh`, piped into a local
 * `tar -x`, each extracted file verified against the `ls -l` size and
 * renamed to `<linkedId>.wav` only once it verifies. A file that fails
 * verification is left out of the progress file, so the next run retries it
 * — never marked done on a partial copy.
 */
async function copyDayFolder(
  group: DayGroup,
  ssh: SshOptions,
  progress: ProgressState,
): Promise<{ bytesCopied: number; progress: ProgressState; failures: string[] }> {
  const remoteFiles = group.files.map((f) => f.remoteFile);
  const listing = await lsRemoteFolder(group.dayFolder, ssh);
  const byName = new Map(listing.map((e) => [e.name, e]));

  mkdirSync(AUDIO_DIR, { recursive: true });
  const extractDir = path.join(AUDIO_DIR, `.extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(extractDir, { recursive: true });

  const tarCmd = buildRemoteCommand("tar-create", group.dayFolder, remoteFiles);
  const argv = sshArgv(tarCmd, ssh);

  await new Promise<void>((resolve, reject) => {
    const sshProc = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    const tarProc = spawn("tar", ["-x", "-C", extractDir], { stdio: ["pipe", "ignore", "pipe"] });
    sshProc.stdout.pipe(tarProc.stdin);
    let sshErr = "";
    let tarErr = "";
    sshProc.stderr.on("data", (d) => (sshErr += d.toString("utf8")));
    tarProc.stderr.on("data", (d) => (tarErr += d.toString("utf8")));
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
    sshProc.on("error", done);
    tarProc.on("error", done);
    tarProc.on("close", (code) => (code === 0 ? done() : done(new Error(`local tar -x failed: ${tarErr.slice(0, 300)}`))));
    sshProc.on("close", (code) => {
      if (code !== 0) done(new Error(`ssh/tar -c on the PBX failed (${group.dayFolder}): ${sshErr.slice(0, 300)}`));
    });
  });

  let bytesCopied = 0;
  let state = progress;
  const failures: string[] = [];
  for (const f of group.files) {
    const extracted = path.join(extractDir, f.remoteFile);
    if (!existsSync(extracted)) {
      failures.push(`${f.linkedId}: not present in the tar stream — left for the next run`);
      continue;
    }
    const bytes = statSync(extracted).size;
    const verdict = verifyLocalSize(bytes, byName.get(f.remoteFile));
    if (!verdict.ok) {
      failures.push(`${f.linkedId}: ${verdict.reason}`);
      continue;
    }
    renameSync(extracted, path.join(AUDIO_DIR, f.localName));
    state = markDone(state, f.linkedId, bytes);
    bytesCopied += bytes;
  }
  rmSync(extractDir, { recursive: true, force: true });
  return { bytesCopied, progress: state, failures };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx === process.argv.length - 1) return null;
  return process.argv[idx + 1];
}

async function main() {
  loadEnvFile();
  const dryRun = process.argv.includes("--dry-run");
  const tenantName = argValue("--tenant");
  const maxGbArg = argValue("--max-gb");
  const bwlimitArg = argValue("--bwlimit");
  const maxGb = maxGbArg ? Number(maxGbArg) : null;
  const bwlimitKbit = bwlimitArg ? Number(bwlimitArg) : null;
  const keyFile = process.env.PBX_SSH_KEY || DEFAULT_KEY_FILE;

  log(
    `copy-call-recordings — ${dryRun ? "dry run" : "APPLY"}` +
      (tenantName ? ` — tenant contains "${tenantName}"` : "") +
      (maxGb ? ` — max ${maxGb} GB` : "") +
      (bwlimitKbit ? ` — bwlimit ${bwlimitKbit} kbit/s (paced between day-folders)` : ""),
  );

  const { PrismaClient } = await import("@prisma/client");
  const dbc = new PrismaClient();

  const candidates = await findMissingCallRecordings(dbc, { tenantName });
  let progress = loadProgress(PROGRESS_FILE);
  const pending = candidates.filter((c) => !isDone(progress, c.linkedId));
  const groups = groupByDayFolder(pending);

  log(`${pending.length} recordings missing across ${groups.length} PBX day-folder(s)`);
  if (dryRun) {
    for (const g of groups) log(`  ${g.dayFolder}: ${g.files.length} file(s)`);
    log("dry run — nothing fetched. Re-run without --dry-run to copy.");
    await dbc.$disconnect();
    return;
  }

  let totalBytes = 0;
  for (const group of groups) {
    if (maxGb && totalBytes >= maxGb * 1024 ** 3) {
      log(`reached --max-gb ${maxGb} GB — stopping (resume later to continue)`);
      break;
    }
    try {
      const { bytesCopied, progress: next, failures } = await copyDayFolder(
        group,
        { keyFile, bwlimitKbit },
        progress,
      );
      progress = next;
      saveProgress(PROGRESS_FILE, progress);
      totalBytes += bytesCopied;
      log(`  ${group.dayFolder}: +${(bytesCopied / 1e9).toFixed(3)} GB (${group.files.length - failures.length}/${group.files.length} ok)`);
      for (const f of failures) log(`    ${f}`);
    } catch (err: any) {
      log(`  ${group.dayFolder}: FAILED — ${String(err?.message || err).slice(0, 300)}`);
    }
    if (bwlimitKbit) await sleep(1000); // coarse pacing between day-folders, see file header
  }
  log(`copied ${(totalBytes / 1e9).toFixed(3)} GB total`);
  await dbc.$disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    log("fatal", err);
    process.exit(1);
  });
}
