/**
 * PHASE 3 — the support agent may ship a CODE fix, but only through this file.
 *
 * Izzy, 2026-09-15: the automatic agent "should be able to commit and deploy".
 * It is the same Claude with the same memory; what differs is that nobody is
 * watching the run, a customer's ticket is what starts it, and the main working
 * folder is shared with other sessions. So the model never holds git or deploy
 * powers. It STAGES edits through MCP tools; everything after that is this code:
 *
 *   stage_edit / stage_new_file  → exact edits in THIS ticket's own git worktree,
 *                                  only under the allowlisted paths
 *   request_ship                 → control-byte scan, commit by pathspec
 *   (watcher) checks             → npm test + typecheck in the worktree
 *   (watcher) owner notice       → "GO <code>" texted, naming the commit
 *   (watcher) after GO           → approved commit re-checked, rebase + re-test,
 *                                  fast-forward push, queue deploy (branch tip),
 *                                  verify container + health, text the result;
 *                                  verification failure → revert, push, redeploy
 *
 * ⛔ Never `--force`, never `git add -A`, never a pinned commitHash (that rolls
 * production back past other sessions' work), never resume a ship a crash
 * interrupted — a person is told instead.
 * ⛔ The worktree gets its own @connect/* junctions: the main folder's links point
 * at the main folder's packages, so without them a change to packages/shared
 * would be tested against someone else's uncommitted copy.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
export const SHIP_STATE_FILE = path.join(HERE, ".ship-state.json");
export const WORKTREE_ROOT = path.join(REPO, ".claude", "worktrees");
export const BRANCH = "feat/ivr-migration-takeover";
export const LOOPCOM_HOST = "root@45.14.194.179";
/** Code ships across ALL tickets per UTC day. */
export const SHIPS_PER_DAY = 3;
/** A staged change nobody submitted is thrown away after this long. */
export const STAGED_STALE_MS = 6 * 60 * 60 * 1000;

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BS = String.fromCharCode(92);

/** The only places a support-agent change may touch. */
export const ALLOWED_PREFIXES = Object.freeze([
  "apps/api/src/",
  "apps/portal/app/",
  "apps/portal/components/",
  "apps/portal/lib/",
  "apps/portal/navigation/",
  "apps/portal/services/",
  "apps/portal/hooks/",
  "apps/portal/contexts/",
  "packages/shared/src/",
]);

/** ⛔ The agent's own gates. A change to what bounds the agent is a person's change. */
export const FORBIDDEN_FILES = Object.freeze([
  "apps/api/src/support/actAsFilerRoutes.ts",
  "apps/api/src/support/supportAgentNotice.ts",
  "apps/api/src/support/customerUpdate.ts",
  "apps/api/src/support/customerUpdateSafety.ts",
  "apps/api/src/agentFixByText.ts",
]);

/** ⛔ Config, secrets, schema, dependencies and build files — never shipped by the agent. */
const FORBIDDEN_PATTERNS = [
  /(^|[/])[.]env/i,
  /[.]connect-ssh/i,
  /(^|[/])prisma([/]|$)/i,
  /migrations/i,
  /(^|[/])package[.]json$/i,
  /pnpm-lock/i,
  /tsconfig/i,
  /dockerfile/i,
  /docker-compose/i,
  /[.]github/i,
  /(^|[/])node_modules([/]|$)/i,
];

export function checkShipPath(raw) {
  const p = String(raw ?? "").split(BS).join("/").trim();
  if (!p || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) {
    return { ok: false, why: "Give a repo-relative path such as apps/api/src/x.ts." };
  }
  if (p.split("/").some((s) => s === ".." || s === "." || s === "")) {
    return { ok: false, why: "Relative or empty path segments are not allowed." };
  }
  if (FORBIDDEN_FILES.includes(p)) {
    return { ok: false, why: `${p} is one of the support agent's own gates; only a person changes it.` };
  }
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(p)) return { ok: false, why: `${p} is config, secrets, schema, dependencies or build files — not something the agent may ship.` };
  }
  if (!ALLOWED_PREFIXES.some((pre) => p.startsWith(pre))) {
    return { ok: false, why: `Only files under ${ALLOWED_PREFIXES.join(", ")} may be changed.` };
  }
  return { ok: true, path: p };
}

/** Which production services a set of files needs deployed. */
export function servicesFor(files) {
  const s = new Set();
  for (const f of files ?? []) {
    if (f.startsWith("apps/api/")) s.add("api");
    else if (f.startsWith("apps/portal/")) s.add("portal");
    else if (f.startsWith("packages/shared/")) {
      s.add("api");
      s.add("portal");
    }
  }
  return ["api", "portal"].filter((x) => s.has(x));
}

/** Which packages' tests and typecheck must pass. A shared change is checked where it is used too. */
export function packagesFor(files) {
  const s = new Set();
  for (const f of files ?? []) {
    if (f.startsWith("apps/api/")) s.add("apps/api");
    else if (f.startsWith("apps/portal/")) s.add("apps/portal");
    else if (f.startsWith("packages/shared/")) {
      s.add("packages/shared");
      s.add("apps/api");
      s.add("apps/portal");
    }
  }
  return ["packages/shared", "apps/api", "apps/portal"].filter((x) => s.has(x));
}

/** ⛔ A real control byte makes git store a source file as BINARY (no diff, no review). CRLF is fine. */
export function hasStrayControlBytes(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8");
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 13 && b[i + 1] === 10) {
      i++;
      continue;
    }
    if (c === 9 || c === 10) continue;
    if (c < 32) return true;
  }
  return false;
}

export function validRef(ref) {
  return /^[A-Z0-9]{4,12}$/.test(String(ref ?? "").toUpperCase());
}

export function worktreePathFor(ref) {
  return path.join(WORKTREE_ROOT, "support-ship-" + String(ref).toLowerCase());
}

/** ⛔ shell:false — arguments are never concatenated through a shell. */
export function defaultExec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 15 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: (r.stderr ?? "") + (r.error ? " " + r.error.message : "") };
}

export function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function loadShips(file = SHIP_STATE_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function saveShips(ships, file = SHIP_STATE_FILE) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(ships, null, 2));
  fs.renameSync(tmp, file);
}

export function shipsSubmittedToday(ships, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  return Object.values(ships ?? {}).filter((e) => String(e?.submittedAt ?? "").slice(0, 10) === day).length;
}

/** Give the worktree its OWN @connect/* packages (junctions), so shared code is tested as it will ship. */
export function linkWorkspacePackages(wt) {
  const linked = [];
  const scope = path.join(wt, "node_modules", "@connect");
  fs.mkdirSync(scope, { recursive: true });
  for (const group of ["apps", "packages"]) {
    const dir = path.join(wt, group);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const pj = path.join(dir, name, "package.json");
      if (!fs.existsSync(pj)) continue;
      let pkgName = "";
      try {
        pkgName = String(JSON.parse(fs.readFileSync(pj, "utf8")).name ?? "");
      } catch {
        continue;
      }
      if (!pkgName.startsWith("@connect/")) continue;
      const link = path.join(scope, pkgName.slice("@connect/".length));
      if (fs.existsSync(link)) continue;
      fs.symlinkSync(path.join(dir, name), link, "junction");
      linked.push(pkgName);
    }
  }
  return linked;
}

export function ensureWorktree(ref, deps = {}) {
  const exec = deps.exec ?? defaultExec;
  const wt = worktreePathFor(ref);
  if (fs.existsSync(path.join(wt, ".git"))) return { wt, created: false };
  const f = exec("git", ["-C", REPO, "fetch", "-q", "origin", BRANCH]);
  if (f.code !== 0) throw new Error("git fetch failed: " + f.err.slice(0, 200));
  fs.mkdirSync(WORKTREE_ROOT, { recursive: true });
  const a = exec("git", ["-C", REPO, "worktree", "add", "--detach", wt, "origin/" + BRANCH]);
  if (a.code !== 0) throw new Error("git worktree add failed: " + a.err.slice(0, 200));
  const base = exec("git", ["-C", wt, "rev-parse", "HEAD"]).out.trim();
  const linked = (deps.link ?? linkWorkspacePackages)(wt);
  return { wt, created: true, base, linked };
}

function nowIso(deps) {
  return new Date((deps.now ?? Date.now)()).toISOString();
}

function openEntry(ships, ref, deps) {
  let entry = ships[ref];
  if (entry && entry.status !== "staged") {
    throw new Error(`Ticket ${ref} already has a change that is ${entry.status}; a new one waits until that one is finished.`);
  }
  if (!entry) {
    const w = (deps.ensureWorktree ?? ensureWorktree)(ref, deps);
    entry = ships[ref] = { ref, worktree: w.wt, base: w.base ?? null, status: "staged", files: [], createdAt: nowIso(deps), log: [] };
  }
  return entry;
}

function addFile(entry, rel) {
  if (!entry.files.includes(rel)) entry.files.push(rel);
}

function prepRef(raw) {
  const ref = String(raw ?? "").trim().toUpperCase();
  if (!validRef(ref)) throw new Error("A ticket reference like 3GTH9M is required.");
  return ref;
}

/** One exact replacement in the ticket's ship worktree. */
export function stageEdit(input, deps = {}) {
  const ref = prepRef(input?.ref);
  const check = checkShipPath(input?.path);
  if (!check.ok) throw new Error(check.why);
  let oldS = String(input?.oldString ?? "");
  let newS = String(input?.newString ?? "");
  if (!oldS) throw new Error("oldString must be the exact existing text to replace.");
  if (oldS === newS) throw new Error("oldString and newString are identical.");
  if (hasStrayControlBytes(newS)) {
    throw new Error("newString contains control characters. Write escapes as text (for example a backslash then 'n'), never as the raw character.");
  }
  const load = deps.load ?? loadShips;
  const save = deps.save ?? saveShips;
  const ships = load();
  const entry = openEntry(ships, ref, deps);
  const file = path.join(entry.worktree, check.path);
  if (!fs.existsSync(file)) throw new Error(`${check.path} does not exist in the ship worktree — use stage_new_file for a new file.`);
  const text = fs.readFileSync(file, "utf8");
  // A Windows checkout stores CRLF; the text the agent read shows plain line breaks.
  if (text.includes(CR + NL) && !oldS.includes(CR + NL)) {
    oldS = oldS.split(NL).join(CR + NL);
    newS = newS.split(NL).join(CR + NL);
  }
  const count = text.split(oldS).length - 1;
  if (count !== 1) {
    save(ships);
    throw new Error(count === 0 ? "oldString was not found in that file." : `oldString matches ${count} places; include more surrounding text so it matches exactly one.`);
  }
  fs.writeFileSync(file, text.replace(oldS, () => newS));
  addFile(entry, check.path);
  save(ships);
  return { ok: true, ref, file: check.path, files: entry.files.slice() };
}

/** A brand-new file in the ticket's ship worktree. Never overwrites. */
export function stageNewFile(input, deps = {}) {
  const ref = prepRef(input?.ref);
  const check = checkShipPath(input?.path);
  if (!check.ok) throw new Error(check.why);
  const content = String(input?.content ?? "");
  if (!content.trim()) throw new Error("content is empty.");
  if (hasStrayControlBytes(content)) throw new Error("content contains control characters. Write escapes as text, never as the raw character.");
  const load = deps.load ?? loadShips;
  const save = deps.save ?? saveShips;
  const ships = load();
  const entry = openEntry(ships, ref, deps);
  const file = path.join(entry.worktree, check.path);
  if (fs.existsSync(file)) {
    save(ships);
    throw new Error(`${check.path} already exists — use stage_edit to change it.`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  addFile(entry, check.path);
  save(ships);
  return { ok: true, ref, file: check.path, files: entry.files.slice() };
}

/** Commit the staged change in its worktree. Does NOT ship: the watcher tests it and asks the owner. */
export function requestShip(input, deps = {}) {
  const ref = prepRef(input?.ref);
  const summary = String(input?.summary ?? "").trim().split(NL).join(" ");
  if (summary.length < 10 || summary.length > 300) throw new Error("summary must be one plain sentence (10–300 characters).");
  const load = deps.load ?? loadShips;
  const save = deps.save ?? saveShips;
  const exec = deps.exec ?? defaultExec;
  const ships = load();
  const entry = ships[ref];
  if (!entry || entry.status !== "staged" || !entry.files?.length) throw new Error("Nothing is staged for this ticket.");
  const now = (deps.now ?? Date.now)();
  if (shipsSubmittedToday(ships, now) >= SHIPS_PER_DAY) {
    throw new Error(`${SHIPS_PER_DAY} code changes were already submitted today; this one waits for a person or tomorrow.`);
  }
  for (const f of entry.files) {
    if (hasStrayControlBytes(fs.readFileSync(path.join(entry.worktree, f)))) {
      throw new Error(`${f} contains stray control characters — git would store it as binary. Fix that first.`);
    }
  }
  const add = exec("git", ["-C", entry.worktree, "add", "--", ...entry.files]);
  if (add.code !== 0) throw new Error("git add failed: " + add.err.slice(0, 200));
  const msg = [
    `fix(support-agent): ${summary.slice(0, 72)}`,
    "",
    `Prepared by the automatic support agent for ticket ${ref}. Not deployed until the`,
    "owner replies GO; the tests and typecheck run first.",
    "",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
  ].join(NL);
  const commit = exec("git", ["-C", entry.worktree, "commit", "-q", "-F", "-", "--", ...entry.files], { input: msg });
  if (commit.code !== 0) throw new Error("git commit failed: " + (commit.err || commit.out).slice(0, 200));
  const sha = exec("git", ["-C", entry.worktree, "rev-parse", "HEAD"]).out.trim();
  entry.status = "submitted";
  entry.sha = sha;
  entry.summary = summary;
  entry.services = servicesFor(entry.files);
  entry.submittedAt = new Date(now).toISOString();
  entry.log.push(`${entry.submittedAt} committed ${sha.slice(0, 8)} (${entry.files.length} files)`);
  save(ships);
  return {
    ok: true,
    ref,
    sha,
    services: entry.services,
    next: "The watcher now runs the tests and typecheck. Only if they pass is the owner texted for GO; only after his GO is it pushed, deployed and verified. Report that it is waiting — it is NOT shipped.",
  };
}

export function shipStatus(input, deps = {}) {
  const ref = prepRef(input?.ref);
  const entry = (deps.load ?? loadShips)()[ref];
  if (!entry) return { ref, status: "none" };
  const { worktree, ...rest } = entry;
  return { ...rest, log: (entry.log ?? []).slice(-12) };
}

/** npm test + typecheck for every package the change touches. Typecheck: no errors in the changed files. */
export function runChecks(entry, deps = {}) {
  const exec = deps.exec ?? defaultExec;
  const results = [];
  for (const pkg of packagesFor(entry.files)) {
    const cwd = path.join(entry.worktree, pkg);
    const t = exec("cmd.exe", ["/d", "/s", "/c", "npm run test"], { cwd, timeoutMs: 25 * 60 * 1000 });
    results.push({ pkg, step: "test", ok: t.code === 0, tail: (t.out + t.err).slice(-800) });
    if (t.code !== 0) return { ok: false, results };
    const tc = exec("cmd.exe", ["/d", "/s", "/c", "npm run typecheck"], { cwd, timeoutMs: 25 * 60 * 1000 });
    const errors = (tc.out + tc.err).split(NL).filter((l) => l.includes("error TS"));
    const tails = entry.files.map((f) => f.split("/").slice(-2).join("/"));
    const inChanged = errors.filter((l) => {
      const norm = l.split(BS).join("/");
      return tails.some((tail) => norm.includes(tail));
    });
    results.push({ pkg, step: "typecheck", ok: inChanged.length === 0, errorsInChangedFiles: inChanged.slice(0, 10), totalErrors: errors.length });
    if (inChanged.length) return { ok: false, results };
  }
  return { ok: true, results };
}

/** The GO text names the exact commit and what it touches. */
export function noticeSummary(entry) {
  const names = entry.files.slice(0, 3).map((f) => f.split("/").slice(-1)[0]).join(", ");
  const more = entry.files.length > 3 ? ` +${entry.files.length - 3} more` : "";
  const plural = entry.files.length === 1 ? "" : "s";
  const s = `Ship code fix ${String(entry.sha).slice(0, 8)} to ${entry.services.join(" + ")} (${entry.files.length} file${plural}: ${names}${more}), tests passed: ${entry.summary}`;
  return s.slice(0, 400);
}

/** Pure: what to do with a ship waiting on the owner. */
export function decideShip(entry, notices, now) {
  if (entry?.status !== "awaiting_go") return { action: "none" };
  const n = (notices ?? []).find((x) => x.id === entry.noticeId);
  if (!n) return { action: "wait", why: "notice not found" };
  if (n.status === "stopped") return { action: "discard", why: "the owner replied STOP" };
  if (n.status === "approved") return { action: "ship" };
  if (new Date(n.expiresAt).getTime() <= now) return { action: "discard", why: "no GO within the notice's lifetime" };
  return { action: "wait", why: "waiting for GO" };
}

/**
 * Runs ON loopcom over ssh, args: service ref sha branch.
 * ⛔ Deploys the BRANCH (tip), never a pinned commitHash; waits with bracketed
 * patterns so the wait cannot match its own command line; health is probed with
 * --resolve to the local nginx listener, not hairpinned through the public IP.
 */
export function remoteDeployScript() {
  return [
    "set -u",
    'SVC="$1"; REF="$2"; SHA="$3"; BR="$4"',
    'case "$SVC" in api|portal) ;; *) echo "SHIP_RESULT status=bad_service"; exit 2;; esac',
    "for i in $(seq 1 60); do",
    '  if ! ps -eo cmd | grep -qE "[d]eploy-portal.sh|[d]eploy-api.sh|[r]un-heavy.sh"; then',
    `    curl -s -m 5 http://127.0.0.1:3910/ops/deploy/status | grep -q '"runningCount":0' && break`,
    "  fi",
    "  sleep 15",
    "done",
    `BODY=$(printf '{"service":"%s","branch":"%s","requestedBy":"support-agent:%s","reason":"support agent ship %s","source":"auto"}' "$SVC" "$BR" "$REF" "$SHA")`,
    `J=$(curl -s -m 20 -X POST http://127.0.0.1:3910/ops/deploy/enqueue -H 'Content-Type: application/json' -d "$BODY" | grep -oE '"id":"[^"]*"' | head -1 | cut -d'"' -f4)`,
    'if [ -z "$J" ]; then echo "SHIP_RESULT status=enqueue_failed"; exit 3; fi',
    "sleep 5",
    `S=unknown; for i in $(seq 1 240); do S=$(curl -s -m 5 "http://127.0.0.1:3910/ops/deploy/jobs/$J" | grep -oE '"status":"[a-z_]+"' | head -1 | cut -d'"' -f4); case "$S" in success|failed|cancelled) break;; esac; sleep 10; done`,
    'HEAVY=0; grep -q "HEAVY JOB ALREADY RUNNING" "/var/log/connect-deploys/$J.log" 2>/dev/null && HEAVY=1',
    `BUILD=$(docker exec "app-$SVC-1" sh -c 'cat /app/.build-commit' 2>/dev/null)`,
    'ANC=0; ( cd /opt/connectcomms/app && git merge-base --is-ancestor "$SHA" "$BUILD" ) >/dev/null 2>&1 && ANC=1',
    `HA=$(curl -s -o /dev/null -m 15 --resolve app.loopcom.net:443:127.0.0.1 -w '%{http_code}' https://app.loopcom.net/api/health)`,
    `HB=$(curl -s -o /dev/null -m 15 --resolve app.connectcomunications.com:443:127.0.0.1 -w '%{http_code}' https://app.connectcomunications.com/api/health)`,
    `HP=$(curl -s -o /dev/null -m 15 --resolve app.loopcom.net:443:127.0.0.1 -w '%{http_code}' https://app.loopcom.net/)`,
    'echo "SHIP_RESULT status=$S job=$J heavy=$HEAVY build=$BUILD ancestor=$ANC health_api=$HA health_api2=$HB health_portal=$HP"',
  ].join(NL);
}

export function parseShipResult(text) {
  const line = String(text ?? "").split(NL).map((l) => l.trim()).reverse().find((l) => l.startsWith("SHIP_RESULT"));
  if (!line) return null;
  const out = {};
  for (const tok of line.slice("SHIP_RESULT".length).trim().split(" ")) {
    const i = tok.indexOf("=");
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return out;
}

/** Deployed AND verified: the job succeeded, the container holds the commit, and the site answers. */
export function shipVerdict(r, service) {
  if (!r) return { ok: false, why: "no result from the server" };
  if (r.status !== "success") return { ok: false, why: `deploy job ${r.job ?? "?"} ended ${r.status}` };
  if (r.ancestor !== "1") return { ok: false, why: `the running ${service} container (${String(r.build ?? "").slice(0, 8)}) does not contain the commit` };
  if (r.health_api !== "200" || r.health_api2 !== "200") return { ok: false, why: `api health ${r.health_api}/${r.health_api2}` };
  if (service === "portal") {
    const code = Number(r.health_portal);
    if (!(code >= 200 && code < 400)) return { ok: false, why: `portal answered ${r.health_portal}` };
  }
  return { ok: true };
}

export function sshBinary() {
  const gitSsh = "C:/Program Files/Git/usr/bin/ssh.exe";
  return fs.existsSync(gitSsh) ? gitSsh : "ssh";
}

export function sshRun(script, args, deps = {}) {
  const exec = deps.exec ?? defaultExec;
  const key = path.join(REPO, ".connect-ssh", "connect2_ed25519");
  return exec(
    sshBinary(),
    ["-i", key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", LOOPCOM_HOST, "bash", "-s", "--", ...args],
    { input: script, timeoutMs: 50 * 60 * 1000 },
  );
}

/** One service deploy, retried only when another session's heavy job blocked it. */
export function deployService(service, ref, sha, deps = {}) {
  const sleep = deps.sleep ?? defaultSleep;
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = (deps.sshRun ?? sshRun)(remoteDeployScript(), [service, ref, sha, BRANCH], deps);
    last = parseShipResult(res.out);
    if (last && last.status === "failed" && last.heavy === "1" && attempt < 3) {
      sleep(120_000);
      continue;
    }
    return last;
  }
  return last;
}

function isNonFastForward(err) {
  return /rejected|non-fast-forward|fetch first/i.test(String(err ?? ""));
}

/** Rebase onto the tip, re-test if anything moved, fast-forward push. Never force. */
function pushToBranch(entry, deps, note) {
  const exec = deps.exec ?? defaultExec;
  const checks = deps.runChecks ?? runChecks;
  let checkedSha = entry.sha;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const f = exec("git", ["-C", entry.worktree, "fetch", "-q", "origin", BRANCH]);
    if (f.code !== 0) return { ok: false, why: "git fetch failed: " + f.err.slice(0, 160) };
    const reb = exec("git", ["-C", entry.worktree, "rebase", "origin/" + BRANCH]);
    if (reb.code !== 0) {
      exec("git", ["-C", entry.worktree, "rebase", "--abort"]);
      return { ok: false, why: "it conflicts with newer changes on the branch" };
    }
    const sha = exec("git", ["-C", entry.worktree, "rev-parse", "HEAD"]).out.trim();
    if (sha !== checkedSha) {
      note(`rebased to ${sha.slice(0, 8)}; re-running checks`);
      const c = checks({ ...entry, sha }, deps);
      if (!c.ok) return { ok: false, why: "the tests failed after rebasing onto the latest branch", checks: c };
      checkedSha = sha;
    }
    const p = exec("git", ["-C", entry.worktree, "push", "origin", "HEAD:refs/heads/" + BRANCH]);
    if (p.code === 0) return { ok: true, sha };
    if (!isNonFastForward(p.err)) return { ok: false, why: "git push failed: " + p.err.slice(0, 160) };
    note("push rejected (the branch moved); retrying");
  }
  return { ok: false, why: "the branch kept moving; gave up after 3 tries" };
}

/** Revert the shipped commit on the tip, push, redeploy. */
function rollback(entry, deps, note) {
  const exec = deps.exec ?? defaultExec;
  const f = exec("git", ["-C", entry.worktree, "fetch", "-q", "origin", BRANCH]);
  if (f.code !== 0) return { ok: false, why: "git fetch failed" };
  const co = exec("git", ["-C", entry.worktree, "checkout", "-q", "--detach", "origin/" + BRANCH]);
  if (co.code !== 0) return { ok: false, why: "could not check out the branch tip" };
  const rv = exec("git", ["-C", entry.worktree, "revert", "--no-edit", entry.shippedSha]);
  if (rv.code !== 0) {
    exec("git", ["-C", entry.worktree, "revert", "--abort"]);
    return { ok: false, why: "git revert failed" };
  }
  const revertSha = exec("git", ["-C", entry.worktree, "rev-parse", "HEAD"]).out.trim();
  const pushed = pushToBranch({ ...entry, sha: revertSha }, { ...deps, runChecks: () => ({ ok: true }) }, note);
  if (!pushed.ok) return { ok: false, why: "revert push failed: " + pushed.why };
  for (const svc of entry.services) {
    const r = deployService(svc, entry.ref, pushed.sha, deps);
    const v = shipVerdict(r, svc);
    if (!v.ok) return { ok: false, why: `redeploy of ${svc} after revert: ${v.why}` };
  }
  return { ok: true, sha: pushed.sha };
}

/** After the owner's GO. Synchronous by design: one ship at a time. */
export async function shipEntry(entry, deps = {}) {
  const exec = deps.exec ?? defaultExec;
  const tell = deps.tell ?? (async () => {});
  const note = (m) => entry.log.push(`${nowIso(deps)} ${m}`);
  const fail = async (why, status = "failed") => {
    entry.status = status;
    entry.failure = why;
    note(`${status}: ${why}`);
    await tell(`Code fix ${String(entry.sha).slice(0, 8)} was NOT shipped: ${why}. Nothing changed in production.`);
    return entry;
  };

  // ⛔ The GO approved THIS commit. Anything else in the worktree is not approved.
  const head = exec("git", ["-C", entry.worktree, "rev-parse", "HEAD"]).out.trim();
  if (head !== entry.sha) return fail("the worktree no longer holds the commit you approved");
  const dirty = exec("git", ["-C", entry.worktree, "status", "--porcelain", "--untracked-files=no"]).out.trim();
  if (dirty) return fail("there are uncommitted changes the approval did not cover");

  entry.status = "shipping";
  note("GO received; pushing");
  const pushed = pushToBranch(entry, deps, note);
  if (!pushed.ok) return fail(pushed.why);
  entry.shippedSha = pushed.sha;
  note(`pushed ${pushed.sha.slice(0, 8)}`);

  entry.status = "deploying";
  for (const svc of entry.services) {
    note(`deploying ${svc}`);
    const r = deployService(svc, entry.ref, pushed.sha, deps);
    const v = shipVerdict(r, svc);
    if (!v.ok) {
      note(`${svc} not verified: ${v.why}; rolling back`);
      entry.status = "rolling_back";
      const rb = rollback(entry, deps, note);
      if (rb.ok) {
        entry.status = "rolled_back";
        entry.failure = v.why;
        await tell(`Code fix ${pushed.sha.slice(0, 8)} failed verification on ${svc} (${v.why}). ROLLED BACK: revert ${rb.sha.slice(0, 8)} is deployed.`);
        return entry;
      }
      entry.status = "rollback_failed";
      entry.failure = `${v.why}; rollback: ${rb.why}`;
      await tell(`URGENT: code fix ${pushed.sha.slice(0, 8)} failed on ${svc} (${v.why}) and the ROLLBACK FAILED (${rb.why}). Needs a person now.`);
      return entry;
    }
    note(`${svc} verified (job ${r.job}, container ${String(r.build).slice(0, 8)})`);
  }
  entry.status = "shipped";
  entry.shippedAt = nowIso(deps);
  await tell(`Shipped code fix ${pushed.sha.slice(0, 8)} to ${entry.services.join(" + ")}; deployed and verified (health 200).`);
  return entry;
}

let activeRef = null;

export function discardWorktree(entry, deps = {}) {
  const exec = deps.exec ?? defaultExec;
  exec("git", ["-C", REPO, "worktree", "remove", "--force", entry.worktree]);
}

/**
 * Called from the watcher every poll. Does at most ONE step, so the poll loop
 * keeps moving between the long ones.
 */
export async function processShips(cfg, deps = {}) {
  const load = deps.load ?? loadShips;
  const save = deps.save ?? saveShips;
  const api = deps.api;
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? Date.now)();
  const ships = load();

  for (const entry of Object.values(ships)) {
    const tell = async (message) => {
      try {
        await api.postOwnerUpdate(cfg, entry.ref, message);
      } catch (e) {
        log("  ⛔ owner update failed: " + String(e?.message ?? e).slice(0, 120));
      }
    };

    // ⛔ A ship a crash interrupted is never resumed — a person is told.
    if (["shipping", "deploying", "rolling_back"].includes(entry.status) && activeRef !== entry.ref) {
      entry.status = "interrupted";
      entry.log.push(`${new Date(now).toISOString()} interrupted mid-ship; not resumed`);
      save(ships);
      await tell(`A code fix for this ticket was interrupted mid-ship (the watcher restarted). It was NOT resumed — check the branch and deploys by hand.`);
      return "interrupted";
    }

    if (entry.status === "staged" && now - new Date(entry.createdAt).getTime() > STAGED_STALE_MS) {
      entry.status = "discarded";
      entry.log.push(`${new Date(now).toISOString()} staged but never submitted; discarded`);
      discardWorktree(entry, deps);
      save(ships);
      return "discarded";
    }

    if (entry.status === "submitted") {
      log(`  SHIP ${entry.ref}: running checks for ${String(entry.sha).slice(0, 8)}`);
      deps.beat?.({ state: "ship_checks", ticket: entry.ref });
      const c = (deps.runChecks ?? runChecks)(entry, deps);
      entry.checks = c.results;
      if (!c.ok) {
        entry.status = "checks_failed";
        entry.log.push(`${new Date(now).toISOString()} checks failed`);
        save(ships);
        await tell(`The agent's code fix ${String(entry.sha).slice(0, 8)} FAILED its tests/typecheck, so you were not asked to approve it. Nothing shipped.`);
        return "checks_failed";
      }
      const notice = await api.postOwnerNotice(cfg, entry.ref, { scope: "system", summary: noticeSummary(entry) });
      entry.noticeId = notice?.noticeId ?? null;
      entry.status = entry.noticeId ? "awaiting_go" : "checks_passed_notice_failed";
      entry.log.push(`${new Date(now).toISOString()} checks passed; GO requested`);
      save(ships);
      return entry.status;
    }

    if (entry.status === "awaiting_go") {
      const res = await api.getOwnerNotices(cfg, entry.ref);
      const d = decideShip(entry, res?.notices, now);
      if (d.action === "wait") continue;
      if (d.action === "discard") {
        entry.status = "discarded";
        entry.log.push(`${new Date(now).toISOString()} ${d.why}`);
        discardWorktree(entry, deps);
        save(ships);
        return "discarded";
      }
      if (d.action === "ship") {
        log(`  SHIP ${entry.ref}: GO received — shipping ${String(entry.sha).slice(0, 8)}`);
        deps.beat?.({ state: "shipping", ticket: entry.ref });
        activeRef = entry.ref;
        entry.status = "shipping";
        save(ships);
        try {
          await shipEntry(entry, { ...deps, tell, save: () => save(ships) });
        } finally {
          activeRef = null;
          save(ships);
        }
        return entry.status;
      }
    }
  }
  return "idle";
}
