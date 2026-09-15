/**
 * Code folders — git — for the Coworker. Izzy, 2026-09-15: *"Assign a git repo."*
 *
 * The person attaches a project folder to a task; these let the Coworker answer
 * "what changed?", "what did we do last week?", save a checkpoint, switch branch,
 * get the latest, send changes up, or download a project.
 *
 * ⛔ GIT IS RUN DIRECTLY WITH AN ARGUMENT ARRAY, NEVER THROUGH A SHELL. No model
 * string is ever parsed as a command: a branch name, a message and a URL are single
 * arguments, validated first, and `--` separates options from operands wherever git
 * accepts it. The model cannot pass git flags of its own.
 *
 * ⛔ THE REPO PATH GOES THROUGH THE SAME FENCE AS EVERY FILE TOOL (resolveUserPath:
 * allowed roots, no `..`, junction re-check) and must actually be a git working tree.
 *
 * ⛔ NOTHING WAITS FOR A HUMAN AT A TERMINAL. GIT_TERMINAL_PROMPT=0 and
 * GCM_INTERACTIVE=never mean a push to a remote that needs a password FAILS with a
 * readable message instead of hanging a hidden process forever. Credentials are
 * whatever the person already set up in Git for Windows — never asked for, never seen.
 *
 * ⛔ An untrusted repository cannot run code on a read: every call passes
 * `-c core.fsmonitor=false`, and clone refuses `ext::`/`file://`/local-path sources.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { resolveUserPath, type FsEnv } from "./fs";

export const MAX_GIT_OUTPUT_CHARS = 40_000;
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;
export const NETWORK_GIT_TIMEOUT_MS = 10 * 60_000;

export type GitRun = { ok: boolean; code: number | null; stdout: string; stderr: string; timedOut: boolean; notInstalled: boolean };

export type GitDeps = {
  spawn?: typeof spawn;
  gitPath?: string;
  onSpawn?: (child: ChildProcess) => void;
  killTree?: (pid: number) => void;
};

const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,120}(?<![./])$/;
const REMOTE_RE = /^(?!-)[A-Za-z0-9._-]{1,60}$/;

export function isSafeBranchName(v: unknown): v is string {
  return typeof v === "string" && BRANCH_RE.test(v) && !v.endsWith(".lock");
}

/** https://… or git@host:owner/repo(.git). Everything else (ext::, file://, local paths, flags) is refused. */
export function isSafeCloneUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 500 || /\s/.test(v)) return false;
  if (/^https:\/\/[A-Za-z0-9.-]+(?::\d{2,5})?\/[A-Za-z0-9._~\/-]+?(?:\.git)?\/?$/.test(v)) return !/@/.test(v.split("/")[2] ?? "");
  return /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~\/-]+?(?:\.git)?$/.test(v);
}

export function runGit(args: string[], opts: { cwd?: string; timeoutMs?: number; deps?: GitDeps } = {}): Promise<GitRun> {
  const sp = opts.deps?.spawn ?? spawn;
  const exe = opts.deps?.gitPath ?? "git";
  const timeoutMs = Math.min(Math.max(1000, opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS), NETWORK_GIT_TIMEOUT_MS);
  return new Promise<GitRun>((resolve) => {
    let stdout = ""; let stderr = ""; let timedOut = false; let done = false;
    const cap = (cur: string, chunk: string) => (cur.length >= MAX_GIT_OUTPUT_CHARS ? cur : (cur + chunk).slice(0, MAX_GIT_OUTPUT_CHARS));
    let child: ChildProcess;
    try {
      child = sp(exe, ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "-c", "color.ui=never", ...args], {
        cwd: opts.cwd,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes", LC_ALL: "C.UTF-8" },
      });
    } catch (e: any) {
      resolve({ ok: false, code: null, stdout: "", stderr: String(e?.message ?? e), timedOut: false, notInstalled: e?.code === "ENOENT" });
      return;
    }
    opts.deps?.onSpawn?.(child);
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (child.pid) (opts.deps?.killTree ?? ((pid: number) => { try { spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* gone */ } }))(child.pid); } catch { /* gone */ }
      try { child.kill(); } catch { /* gone */ }
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout = cap(stdout, d.toString("utf8")); });
    child.stderr?.on("data", (d: Buffer) => { stderr = cap(stderr, d.toString("utf8")); });
    const finish = (code: number | null, notInstalled = false) => {
      if (done) return; done = true;
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), timedOut, notInstalled });
    };
    child.on("error", (e: any) => { stderr = cap(stderr, String(e?.message ?? e)); finish(null, e?.code === "ENOENT"); });
    child.on("close", (code) => finish(code));
  });
}

type Fail = { ok: false; error: string; message: string };
const fail = (error: string, message: string): Fail => ({ ok: false, error, message });

function gitFailure(r: GitRun, what: string): Fail {
  if (r.notInstalled) return fail("git_not_installed", "Git isn't installed on this computer, so the Coworker can't work with code projects yet. Install Git for Windows (git-scm.com), then try again.");
  if (r.timedOut) return fail("git_timeout", `Git took too long to ${what}.`);
  const text = `${r.stderr}\n${r.stdout}`;
  if (/Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey\)|403/i.test(text)) {
    return fail("git_needs_sign_in", `Git needs you to sign in to that server before it can ${what}. Sign in once with Git on this computer, then ask again.`);
  }
  if (/not a git repository/i.test(text)) return fail("not_a_repo", "That folder isn't a code project with version history (no git repository in it).");
  if (/Could not resolve host|unable to access|Connection timed out/i.test(text)) return fail("git_offline", `Git couldn't reach the server to ${what}. Check the internet connection.`);
  const firstLine = (r.stderr || r.stdout).split("\n").map((l) => l.replace(/^(fatal|error|hint):\s*/i, "").trim()).find(Boolean) ?? "unknown error";
  return fail("git_failed", `Git couldn't ${what}: ${firstLine.slice(0, 200)}`);
}

/** Resolve the repo path through the file fence, and require a git working tree. */
export async function resolveRepo(input: unknown, env: FsEnv, deps?: GitDeps): Promise<{ ok: true; abs: string; top: string } | Fail> {
  const r = await resolveUserPath(input, env, { mustExist: true });
  if (!r.ok) return { ok: false, error: r.error, message: r.message };
  const st = await fsp.stat(r.abs).catch(() => null);
  if (!st?.isDirectory()) return fail("not_a_folder", "That is a file, not a project folder.");
  const top = await runGit(["rev-parse", "--show-toplevel"], { cwd: r.abs, timeoutMs: 15_000, deps });
  if (!top.ok) return gitFailure(top, "open that project");
  const topAbs = path.win32.normalize(top.stdout.trim().replace(/\//g, "\\"));
  // ⛔ The repository root itself must be inside the fence too: a folder in home
  // whose .git lives above it (in a forbidden place) is not usable.
  const topCheck = await resolveUserPath(topAbs, env, { mustExist: true });
  if (!topCheck.ok) return { ok: false, error: "repo_outside_allowed_roots", message: "That project's version history lives outside the folders the Coworker may use." };
  return { ok: true, abs: r.abs, top: topCheck.abs };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function gitStatus(args: Record<string, unknown>, env: FsEnv, deps?: GitDeps) {
  const repo = await resolveRepo(args.repo, env, deps);
  if (!repo.ok) return repo;
  const r = await runGit(["status", "--porcelain=v2", "--branch", "--untracked-files=all"], { cwd: repo.top, deps });
  if (!r.ok) return gitFailure(r, "check what changed");
  let branch = ""; let ahead = 0; let behind = 0; let upstream = "";
  const changed: string[] = []; const added: string[] = []; const untracked: string[] = []; const conflicted: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice(14).trim();
    else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18).trim();
    else if (line.startsWith("# branch.ab ")) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) { ahead = Number(m[1]); behind = Number(m[2]); } }
    else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const file = line.startsWith("2 ") ? line.split("\t")[0].split(" ").slice(9).join(" ") : parts.slice(8).join(" ");
      if (xy[0] === "A") added.push(file); else changed.push(file);
    } else if (line.startsWith("u ")) conflicted.push(line.split(" ").slice(10).join(" "));
    else if (line.startsWith("? ")) untracked.push(line.slice(2));
  }
  const bits: string[] = [];
  if (!changed.length && !added.length && !untracked.length && !conflicted.length) bits.push("No unsaved changes");
  if (changed.length) bits.push(`${plural(changed.length, "file")} changed`);
  if (added.length + untracked.length) bits.push(`${plural(added.length + untracked.length, "new file")}`);
  if (conflicted.length) bits.push(`${plural(conflicted.length, "file")} with conflicts`);
  const where = branch ? ` on ${branch === "(detached)" ? "a detached checkout" : `branch ${branch}`}` : "";
  const sync = upstream ? (ahead || behind ? ` (${ahead ? `${ahead} to send up` : ""}${ahead && behind ? ", " : ""}${behind ? `${behind} to get` : ""})` : " (up to date)") : "";
  return {
    ok: true, repo: repo.top, branch, upstream: upstream || null, ahead, behind,
    changed: changed.slice(0, 500), added: added.slice(0, 500), untracked: untracked.slice(0, 500), conflicted,
    summary: `${bits.join(", ")}${where}${sync}`,
  };
}

export async function gitLog(args: Record<string, unknown>, env: FsEnv, deps?: GitDeps) {
  const repo = await resolveRepo(args.repo, env, deps);
  if (!repo.ok) return repo;
  const limit = Math.min(Math.max(1, Math.trunc(Number(args.limit) || 20)), 200);
  const gitArgs = ["log", `-n${limit}`, "--date=iso-strict", "--pretty=format:%h%x1f%an%x1f%ad%x1f%s"];
  if (typeof args.path === "string" && args.path.trim()) {
    const p = await resolveUserPath(path.isAbsolute(args.path) ? args.path : path.join(repo.top, args.path), env, { mustExist: true });
    if (!p.ok) return { ok: false, error: p.error, message: p.message };
    gitArgs.push("--", p.abs);
  }
  const r = await runGit(gitArgs, { cwd: repo.top, deps });
  if (!r.ok) {
    if (/does not have any commits/i.test(r.stderr)) return { ok: true, repo: repo.top, commits: [], summary: "No saved checkpoints yet" };
    return gitFailure(r, "read the history");
  }
  const commits = r.stdout.split("\n").filter(Boolean).map((l) => { const [hash, author, date, subject] = l.split("\x1f"); return { hash, author, date, subject }; });
  return { ok: true, repo: repo.top, commits, summary: commits.length ? `${plural(commits.length, "checkpoint")}; latest: “${commits[0].subject}” by ${commits[0].author}` : "No saved checkpoints yet" };
}

export async function gitDiff(args: Record<string, unknown>, env: FsEnv, deps?: GitDeps) {
  const repo = await resolveRepo(args.repo, env, deps);
  if (!repo.ok) return repo;
  const staged = args.staged === true;
  const maxChars = Math.min(Math.max(1000, Math.trunc(Number(args.maxChars) || 20_000)), MAX_GIT_OUTPUT_CHARS);
  const base = ["diff", ...(staged ? ["--cached"] : []), "--no-ext-diff", "--no-textconv"];
  const stat = await runGit([...base, "--shortstat"], { cwd: repo.top, deps });
  if (!stat.ok) return gitFailure(stat, "look at the changes");
  const patch = await runGit([...base, "--stat", "--patch"], { cwd: repo.top, deps });
  if (!patch.ok) return gitFailure(patch, "look at the changes");
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stat.stdout);
  const files = Number(m?.[1] ?? 0); const plus = Number(m?.[2] ?? 0); const minus = Number(m?.[3] ?? 0);
  return {
    ok: true, repo: repo.top, staged, files, insertions: plus, deletions: minus,
    patch: patch.stdout.slice(0, maxChars), truncated: patch.stdout.length > maxChars,
    summary: files ? `${plural(files, "file")} changed, ${plus} line${plus === 1 ? "" : "s"} added, ${minus} removed` : "No changes to show",
  };
}

export async function gitBranches(args: Record<string, unknown>, env: FsEnv, deps?: GitDeps) {
  const repo = await resolveRepo(args.repo, env, deps);
  if (!repo.ok) return repo;
  const r = await runGit(["branch", "--all", "--format=%(HEAD)%1f%(refname:short)%1f%(committerdate:iso-strict)"], { cwd: repo.top, deps });
  if (!r.ok) return gitFailure(r, "list the branches");
  const branches = r.stdout.split("\n").filter(Boolean).map((l) => { const [head, name, date] = l.split("\x1f"); return { name, current: head === "*", remote: name.startsWith("remotes/") || name.includes("/"), lastChange: date || null }; })
    .filter((b) => !/HEAD$/.test(b.name));
  const current = branches.find((b) => b.current)?.name ?? null;
  return { ok: true, repo: repo.top, current, branches: branches.slice(0, 300), summary: `${plural(branches.filter((b) => !b.remote).length, "branch", "branches")}${current ? `; working on ${current}` : ""}` };
}

export async function gitCommit(args: Record<string, unknown>, env: FsEnv, deps?: GitDeps) {
  const repo = await resolveRepo(args.repo, env, deps);
  if (!repo.ok) return repo;
  const message = typeof args.message === "string" ? args.message.replace(/\r\n?/g, "\n").trim() : "";
  if (!message) return fail("empty_message", "A checkpoint needs a short note describing it.");
  if (message.length > 2000) return fail("message_too_long", "Keep the checkpoint note under 2000 characters.");
  if (args.includeAll !== false) {
    const add = await runGit(["add", "--all"], { cwd: repo.top, deps });
    if (!add.ok) return gitFailure(add, "gather the changes");
  }
  const r = await runGit(["commit", "--no-verify", "-m", message], { cwd: repo.top, deps });
  if (!r.ok) {
    if (/nothing to commit|no changes added to commit/i.test(`${r.stdout}\n${r.stderr}`)) return { ok: true, repo: repo.top, committed: false, summary: "There was nothing new to save" };
    if (/Please tell me who you are|user\.email/i.test(r.stderr)) return fail("git_identity_missing", "Git on this computer doesn't know your name and email yet, so it can't save a checkpoint. Set them once in Git, then try again.");
    return gitFailure(r, "save the checkpoint");
  }
  const head = await runGit(["rev-parse", "--short", "HEAD"], { cwd: repo.top, deps });
  return { ok: true, repo: repo.top, committed: true, hash: head.stdout.trim(), summary: `Saved checkpoint “${message.split("\n")[0].slice(0, 80)}”${head.ok ? ` (${head.stdout.trim()})` : ""}` };
}

export async function gitCheckout(args: Record<string, unknown>, env: FsEnv, deps?: GitDeps) {
  const repo = await resolveRepo(args.repo, env, deps);
  if (!repo.ok) return repo;
  if (!isSafeBranchName(args.branch)) return fail("bad_branch", "That isn't a valid branch name.");
  const r = await runGit(args.create === true ? ["switch", "-c", args.branch] : ["switch", args.branch], { cwd: repo.top, deps });
  if (!r.ok) {
    if (/would be overwritten|Please commit your changes or stash/i.test(r.stderr)) return fail("unsaved_changes", "There are unsaved changes that switching would overwrite. Save a checkpoint first.");
    return gitFailure(r, `switch to ${args.branch}`);
  }
  return { ok: true, repo: repo.top, branch: args.branch, created: args.create === true, summary: `${args.create === true ? "Created and switched to" : "Switched to"} ${args.branch}` };
}

export async function gitPull(args: Record<string, unknown>, env: FsEnv, deps?: GitDeps) {
  const repo = await resolveRepo(args.repo, env, deps);
  if (!repo.ok) return repo;
  const r = await runGit(["pull", "--ff-only", "--no-edit"], { cwd: repo.top, timeoutMs: NETWORK_GIT_TIMEOUT_MS, deps });
  if (!r.ok) {
    if (/Not possible to fast-forward|diverged/i.test(r.stderr)) return fail("pull_needs_merge", "Both this computer and the server have new changes, so they can't be combined automatically. A person needs to merge them.");
    if (/no tracking information/i.test(r.stderr)) return fail("no_upstream", "This branch isn't linked to one on the server, so there is nothing to get.");
    return gitFailure(r, "get the latest changes");
  }
  const upToDate = /Already up to date/i.test(r.stdout);
  return { ok: true, repo: repo.top, updated: !upToDate, summary: upToDate ? "Already up to date" : "Got the latest changes" };
}

export async function gitPush(args: Record<string, unknown>, env: FsEnv, deps?: GitDeps) {
  const repo = await resolveRepo(args.repo, env, deps);
  if (!repo.ok) return repo;
  const remote = typeof args.remote === "string" && args.remote ? args.remote : "origin";
  if (!REMOTE_RE.test(remote)) return fail("bad_remote", "That isn't a valid remote name.");
  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo.top, deps });
  if (!branch.ok || !isSafeBranchName(branch.stdout.trim())) return fail("detached", "This project isn't on a branch right now, so there is nothing to send.");
  const r = await runGit(["push", "--set-upstream", remote, branch.stdout.trim()], { cwd: repo.top, timeoutMs: NETWORK_GIT_TIMEOUT_MS, deps });
  if (!r.ok) {
    if (/rejected|fetch first|non-fast-forward/i.test(r.stderr)) return fail("push_rejected", "The server has newer changes. Get the latest first, then send again.");
    return gitFailure(r, "send the changes");
  }
  return { ok: true, repo: repo.top, remote, branch: branch.stdout.trim(), summary: /Everything up-to-date/i.test(r.stderr) ? "Nothing new to send" : `Sent ${branch.stdout.trim()} to ${remote}` };
}

export async function gitClone(args: Record<string, unknown>, env: FsEnv, deps?: GitDeps) {
  if (!isSafeCloneUrl(args.url)) return fail("bad_url", "Only https:// or git@ project addresses can be downloaded.");
  const name = (/([^/:]+?)(?:\.git)?\/?$/.exec(args.url)?.[1] ?? "project").replace(/[^A-Za-z0-9._-]/g, "_");
  const target = typeof args.into === "string" && args.into.trim() ? args.into : path.join(env.workspace, name);
  const dest = await resolveUserPath(target, env);
  if (!dest.ok) return { ok: false, error: dest.error, message: dest.message };
  if (dest.existed) return fail("destination_exists", "Something already exists at that place. Pick a new folder name.");
  await fsp.mkdir(path.dirname(dest.abs), { recursive: true });
  const r = await runGit(["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", "clone", "--", args.url, dest.abs], { cwd: path.dirname(dest.abs), timeoutMs: NETWORK_GIT_TIMEOUT_MS, deps });
  if (!r.ok) return gitFailure(r, "download that project");
  return { ok: true, url: args.url, path: dest.abs, summary: `Downloaded the project into ${path.basename(dest.abs)}` };
}

/** Is git on this computer at all? Cached for the life of the app once it answers yes. */
let gitKnownInstalled = false;
export async function gitInstalled(deps?: GitDeps): Promise<boolean> {
  if (gitKnownInstalled) return true;
  const r = await runGit(["--version"], { timeoutMs: 10_000, deps });
  gitKnownInstalled = r.ok;
  return r.ok;
}

/** Is this folder the top of (or inside) a git working tree? For the attach dialog. */
export async function isGitRepoFolder(abs: string, deps?: GitDeps): Promise<boolean> {
  try {
    const st = await fsp.stat(path.join(abs, ".git")).catch(() => null);
    if (st) return true;
    const r = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: abs, timeoutMs: 10_000, deps });
    return r.ok && r.stdout.trim() === "true";
  } catch { return false; }
}
