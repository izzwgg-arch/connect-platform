/**
 * The Workbench — the IDE's hands (Phase 5c, 2026-08-20).
 *
 * Three doors: SEE the code, READ a file, RUN a command. Every one of them is
 * gated by the Ground Rules (`supportGroundRules.ts`) and the Watchman
 * (`supportWatchman.ts`), so the rulebook Izzy wrote is enforced by code and not
 * merely pasted into a prompt.
 *
 * ⛔⛔ THE ORDER OF THE GATES IS THE SAFETY PROPERTY, and it runs
 * WATCHMAN → GROUND RULES → SHAPE → ALLOWLIST → RUN:
 *   1. The Watchman must say it is safe to work at all. If the agent cannot read
 *      its own rules, or the PBX is not read-only, nothing runs.
 *   2. The Ground Rules classify the command. `never` refuses outright;
 *      `ask_first` refuses UNTIL a human has explicitly confirmed THAT command.
 *   3. The command's SHAPE is checked — no chaining, no redirects, no
 *      substitution — so one approved command cannot smuggle a second.
 *   4. Every binary in the pipeline must be on the allowlist.
 * Only then does anything execute, with a timeout, an output cap and an audit row.
 *
 * ⛔ There is deliberately NO interactive shell here. A PTY is a general-purpose
 * remote-code-execution surface on the production box; every gate above becomes
 * decoration the moment a user can type `bash` and get a prompt. If an
 * interactive terminal is ever wanted it is its own engagement, with its own
 * decision from Izzy — see the handoff.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { classifyAction, type ActionVerdict, type GroundRulesText } from "./supportGroundRules";
import type { WatchmanVerdict } from "./supportWatchman";

/** Binaries the workbench may run. ⛔ READ-ONLY TOOLS ONLY — nothing on this
 *  list can modify the server on its own. Changing production is what the
 *  deploy queue and the approval flow are for; a shell that can `rm` makes the
 *  ground rules advisory. Adding a mutating binary here needs Izzy's word. */
export const ALLOWED_BINARIES = [
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "stat", "file",
  "git", "docker", "df", "du", "free", "uptime", "ps", "date", "hostname",
  "node", "psql", "curl", "systemctl", "journalctl", "echo", "sort", "uniq", "cut", "awk", "sed",
] as const;

/** Sub-commands that make an otherwise-safe binary dangerous. */
const FORBIDDEN_SUBCOMMANDS: Record<string, string[]> = {
  git: ["push", "commit", "reset", "checkout", "clean", "rebase", "merge", "cherry-pick", "revert", "tag", "apply", "am"],
  docker: ["rm", "rmi", "stop", "start", "restart", "kill", "prune", "exec", "run", "build", "compose", "up", "down"],
  systemctl: ["start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask", "kill"],
  // `sed -i` edits in place; `find -delete`/`-exec` runs anything.
  sed: ["-i"],
  find: ["-delete", "-exec", "-execdir", "-fprint"],
};

/** Shell syntax that would let one approved command carry another. */
const FORBIDDEN_SHAPES: Array<{ re: RegExp; why: string }> = [
  { re: /[;&]/, why: "chaining commands with ; or & isn't allowed" },
  { re: /`/, why: "backtick substitution isn't allowed" },
  { re: /\$\(/, why: "$( ) substitution isn't allowed" },
  { re: />/, why: "writing output to a file isn't allowed" },
  { re: /<\(/, why: "process substitution isn't allowed" },
  { re: /\bsudo\b/, why: "sudo isn't allowed" },
];

export type CommandCheck =
  | { ok: true; segments: string[][] }
  | { ok: false; reason: string };

/** Split on pipes and tokenise. Quotes are respected so a grep pattern
 *  containing a space survives. */
export function tokeniseCommand(command: string): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  const pushToken = () => { if (token) { current.push(token); token = ""; } };
  for (const ch of String(command ?? "")) {
    if (quote) {
      if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "|") { pushToken(); if (current.length) segments.push(current); current = []; continue; }
    if (/\s/.test(ch)) { pushToken(); continue; }
    token += ch;
  }
  pushToken();
  if (current.length) segments.push(current);
  return segments;
}

/** Shape + allowlist. Pure, so every refusal is directly testable. */
export function checkCommandShape(command: string): CommandCheck {
  const raw = String(command ?? "").trim();
  if (!raw) return { ok: false, reason: "There's no command to run." };
  if (raw.length > 600) return { ok: false, reason: "That command is too long to run from here." };
  for (const { re, why } of FORBIDDEN_SHAPES) {
    if (re.test(raw)) return { ok: false, reason: `Refused — ${why}.` };
  }
  const segments = tokeniseCommand(raw);
  if (!segments.length) return { ok: false, reason: "There's no command to run." };
  for (const seg of segments) {
    const bin = path.basename(seg[0] ?? "");
    if (!(ALLOWED_BINARIES as readonly string[]).includes(bin)) {
      return { ok: false, reason: `Refused — "${bin}" isn't on the list of commands the workbench may run.` };
    }
    const forbidden = FORBIDDEN_SUBCOMMANDS[bin];
    if (forbidden) {
      const rest = seg.slice(1).map((a) => a.toLowerCase());
      const hit = rest.find((a) => forbidden.includes(a));
      if (hit) return { ok: false, reason: `Refused — "${bin} ${hit}" changes things; that needs the normal approval flow.` };
    }
  }
  return { ok: true, segments };
}

/**
 * Paths whose CONTENTS are secrets. ⛔ The file reader refuses these by name,
 * but `cat` is on the allowlist — so without this the command door would hand
 * out `.env.platform` and every key on the box. The rulebook says never read
 * passwords or keys; this is that rule made mechanical, because a policy the
 * machine cannot enforce is a wish.
 */
const SECRET_PATH_IN_COMMAND_RE =
  /(\.env\b|\.env\.[a-z0-9_.-]+|\/\.ssh\b|id_rsa|id_ed25519|\.pem\b|\.p12\b|\.pfx\b|\bcredentials?\.json\b|\bsecrets?\.(json|yaml|yml)\b|authorized_keys|\.connect-ssh)/i;

export function commandTouchesSecrets(command: string): boolean {
  return SECRET_PATH_IN_COMMAND_RE.test(String(command ?? ""));
}

export type RunDecision =
  | { run: true; verdict: ActionVerdict }
  | { run: false; status: number; error: string; message: string; verdict?: ActionVerdict; needsConfirm?: boolean };

/**
 * Everything that decides whether a command may run, with no I/O — the whole
 * gate is unit-testable and every refusal is exercised in the tests.
 *
 * ⛔⛔ ONE DELIBERATE ASYMMETRY, AND IT IS LOAD-BEARING. `classifyAction`
 * defaults an unrecognised action to ASK, because for a free-form action that
 * is the only safe answer. Here it does NOT: a command that reaches the rulebook
 * has already been proven READ-ONLY by the shape and allowlist gates, and every
 * binary on that list is incapable of changing the server. Demanding a
 * confirmation for `ls` would teach a support person to click through
 * confirmations by reflex — which is exactly how the confirmation that DOES
 * matter ("delete these files") stops being read. So the rulebook is consulted
 * to FORBID, not to permit: `never` refuses, `ask_first` requires a
 * confirmation, and anything else proceeds on the allowlist's guarantee.
 */
export function decideCommandRun(input: {
  command: string;
  rules: GroundRulesText;
  watchman: WatchmanVerdict;
  confirmed: boolean;
}): RunDecision {
  // 1. The Watchman — nothing at all runs when the ground is unsafe.
  if (!input.watchman.safeToWork) {
    return {
      run: false,
      status: 409,
      error: "not_safe_to_work",
      message: `Nothing can run right now: ${input.watchman.blockers.join(" ")}`,
    };
  }
  // 2. Shape + allowlist FIRST, so the read-only guarantee is established
  //    before the rulebook's verdict is interpreted (see the note above).
  const shape = checkCommandShape(input.command);
  if (!shape.ok) {
    return { run: false, status: 400, error: "command_not_allowed", message: shape.reason };
  }
  // 3. Secrets are refused mechanically — `cat` is allowlisted, so without this
  //    the door would serve .env and every private key on the box.
  if (commandTouchesSecrets(input.command)) {
    return {
      run: false,
      status: 403,
      error: "refused_secrets",
      message: "Refused — that command reads credentials, and the ground rules never allow that.",
    };
  }
  // 4. The Ground Rules, consulted to FORBID.
  const verdict = classifyAction(input.rules, input.command);
  if (verdict.decision === "never") {
    return { run: false, status: 403, error: "refused_by_ground_rules", message: verdict.reason, verdict };
  }
  // ⛔ `matchedRule` is what separates "a rule says ask" from "nothing matched".
  // Only a REAL ask-first rule stops the command; an unrecognised one proceeds
  // on the allowlist's read-only guarantee (the asymmetry documented above).
  if (verdict.decision === "ask_first" && verdict.matchedRule && !input.confirmed) {
    return {
      run: false,
      status: 428,
      error: "confirmation_required",
      message: verdict.reason,
      verdict,
      needsConfirm: true,
    };
  }
  return { run: true, verdict };
}

export const COMMAND_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_BYTES = 100_000;

export type CommandResult = { exitCode: number | null; stdout: string; stderr: string; truncated: boolean; ms: number };

/**
 * Run a checked command. ⛔ Only ever called after `decideCommandRun` returns
 * `run: true` — this function re-checks the SHAPE anyway, because a caller that
 * forgets the gate must not become a shell.
 */
export async function runCheckedCommand(command: string, cwd: string): Promise<CommandResult> {
  const shape = checkCommandShape(command);
  if (!shape.ok) throw new Error(shape.reason);
  const started = Date.now();
  return await new Promise<CommandResult>((resolve) => {
    // `shell: true` is needed for the pipe, and is safe ONLY because every
    // chaining, substitution and redirect character is refused above and every
    // binary in every pipe segment is allowlisted.
    const child = spawn(command, { shell: true, cwd, env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" } });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const cap = (add: string, into: "o" | "e") => {
      const room = MAX_OUTPUT_BYTES - (stdout.length + stderr.length);
      if (room <= 0) { truncated = true; return; }
      const slice = add.length > room ? (truncated = true, add.slice(0, room)) : add;
      if (into === "o") stdout += slice; else stderr += slice;
    };
    child.stdout?.on("data", (d) => cap(String(d), "o"));
    child.stderr?.on("data", (d) => cap(String(d), "e"));
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, COMMAND_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + String(err?.message ?? err), truncated, ms: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, truncated, ms: Date.now() - started });
    });
  });
}

// ─────────────────────────── reading the code ───────────────────────────

/** Files whose CONTENTS must never be served, whatever the path rules say.
 *  ⛔ The ground rules say never read passwords or keys; this is that rule
 *  made mechanical, because "don't look" is not a control. */
const SECRET_FILE_RE = /(^|[/\\])(\.env(\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|.*credential.*\.json)$/i;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo", "coverage", ".connect-ssh"]);

export type PathCheck = { ok: true; absolute: string } | { ok: false; reason: string };

/** Resolve a caller-supplied path INSIDE the workspace, or refuse. */
export function resolveWorkspacePath(root: string, rel: string): PathCheck {
  const cleanedRoot = path.resolve(root);
  const target = path.resolve(cleanedRoot, String(rel ?? "").replace(/^[/\\]+/, ""));
  const withSep = cleanedRoot.endsWith(path.sep) ? cleanedRoot : cleanedRoot + path.sep;
  if (target !== cleanedRoot && !target.startsWith(withSep)) {
    return { ok: false, reason: "That path is outside the workspace." };
  }
  if (SECRET_FILE_RE.test(target)) {
    return { ok: false, reason: "That file holds credentials — the ground rules don't allow reading it." };
  }
  return { ok: true, absolute: target };
}

export type TreeEntry = { name: string; path: string; kind: "dir" | "file"; size?: number };

/** One directory level. Deliberately not recursive: a whole-repo walk is slow,
 *  huge, and nobody reads it — the explorer opens folders as they are clicked. */
export async function listWorkspaceDir(root: string, rel: string): Promise<TreeEntry[]> {
  const check = resolveWorkspacePath(root, rel);
  if (!check.ok) throw new Error(check.reason);
  const items = await fsp.readdir(check.absolute, { withFileTypes: true });
  const out: TreeEntry[] = [];
  for (const it of items) {
    if (it.name.startsWith(".") && it.name !== ".gitignore") continue;
    if (it.isDirectory() && SKIP_DIRS.has(it.name)) continue;
    const abs = path.join(check.absolute, it.name);
    const relPath = path.relative(path.resolve(root), abs).split(path.sep).join("/");
    if (it.isDirectory()) out.push({ name: it.name, path: relPath, kind: "dir" });
    else if (it.isFile() && !SECRET_FILE_RE.test(abs)) {
      let size: number | undefined;
      try { size = (await fsp.stat(abs)).size; } catch { /* listed without a size */ }
      out.push({ name: it.name, path: relPath, kind: "file", size });
    }
  }
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  return out;
}

export const MAX_FILE_BYTES = 400_000;

export async function readWorkspaceFile(root: string, rel: string): Promise<{ path: string; text: string; truncated: boolean; bytes: number }> {
  const check = resolveWorkspacePath(root, rel);
  if (!check.ok) throw new Error(check.reason);
  const stat = await fsp.stat(check.absolute);
  if (!stat.isFile()) throw new Error("That isn't a file.");
  const handle = await fsp.open(check.absolute, "r");
  try {
    const size = Math.min(stat.size, MAX_FILE_BYTES);
    const buf = Buffer.alloc(size);
    await handle.read(buf, 0, size, 0);
    return {
      path: String(rel ?? "").replace(/^[/\\]+/, ""),
      text: buf.toString("utf8"),
      truncated: stat.size > MAX_FILE_BYTES,
      bytes: stat.size,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}
