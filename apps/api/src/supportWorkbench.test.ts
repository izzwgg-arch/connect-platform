/**
 * The Workbench's gates. This is the module that can run commands on the
 * production server, so every refusal path is exercised here — a gate nobody
 * tested is a gate nobody has.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import {
  ALLOWED_BINARIES,
  checkCommandShape,
  decideCommandRun,
  listWorkspaceDir,
  readWorkspaceFile,
  resolveWorkspacePath,
  runCheckedCommand,
  tokeniseCommand,
} from "./supportWorkbench";
import { DEFAULT_GROUND_RULES } from "./supportGroundRules";
import { evaluateWatchman } from "./supportWatchman";

const SAFE_WATCH = evaluateWatchman({
  rules: { found: 2, missing: [] },
  server: { healthy: 2, unhealthy: [] },
  pbx: { reachable: true, readOnly: true },
});
const UNSAFE_WATCH = evaluateWatchman({ rules: null, server: { healthy: 2, unhealthy: [] }, pbx: { reachable: true, readOnly: true } });

// ───────────────────────────── shape + allowlist ─────────────────────────────

test("tokenise splits pipes and respects quotes", () => {
  assert.deepEqual(tokeniseCommand(`grep -r "hello world" src | wc -l`), [["grep", "-r", "hello world", "src"], ["wc", "-l"]]);
});

test("⛔ command chaining, substitution, redirects and sudo are all refused", () => {
  for (const bad of [
    "ls; rm -rf /",
    "ls && rm -rf /",
    "ls & whoami",
    "echo `whoami`",
    "echo $(whoami)",
    "cat file > /etc/passwd",
    "sudo systemctl restart nginx",
  ]) {
    const r = checkCommandShape(bad);
    assert.equal(r.ok, false, `must refuse: ${bad}`);
  }
});

test("⛔ every binary in EVERY pipe segment must be allowlisted", () => {
  assert.equal(checkCommandShape("ls -la").ok, true);
  assert.equal(checkCommandShape("docker ps | grep api").ok, true);
  // Second segment is not allowlisted → the whole command is refused.
  const r = checkCommandShape("cat file | rm -rf");
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /rm/);
});

test("⛔ mutating sub-commands of otherwise-safe binaries are refused", () => {
  for (const bad of [
    "git push origin main",
    "git reset --hard",
    "docker restart app-api-1",
    "docker exec app-api-1 sh",
    "systemctl restart nginx",
    "sed -i s/a/b/ file",
    "find . -delete",
  ]) {
    const r = checkCommandShape(bad);
    assert.equal(r.ok, false, `must refuse: ${bad}`);
  }
  // …while their read-only siblings are fine.
  assert.equal(checkCommandShape("git status").ok, true);
  assert.equal(checkCommandShape("docker ps -a").ok, true);
  assert.equal(checkCommandShape("systemctl status nginx").ok, true);
});

test("⛔ the allowlist contains no binary that can modify the server by itself", () => {
  for (const dangerous of ["rm", "mv", "cp", "chmod", "chown", "dd", "mkfs", "kill", "bash", "sh", "zsh", "python", "npm", "pnpm", "apt", "tee", "truncate"]) {
    assert.ok(!(ALLOWED_BINARIES as readonly string[]).includes(dangerous), `${dangerous} must not be allowlisted`);
  }
});

// ───────────────────────────── the gate order ─────────────────────────────

test("⛔ the Watchman is the FIRST gate — nothing runs when it says stop", () => {
  const d = decideCommandRun({ command: "ls -la", rules: DEFAULT_GROUND_RULES, watchman: UNSAFE_WATCH, confirmed: true });
  assert.equal(d.run, false);
  assert.equal((d as any).error, "not_safe_to_work");
});

test("⛔ English prose is not a runnable command — the shape gate refuses it", () => {
  // The rulebook classifier reads intent; the command door runs binaries. A
  // sentence reaches the door only by mistake, and is refused as such.
  const d = decideCommandRun({
    command: "write a new extension to the PBX",
    rules: DEFAULT_GROUND_RULES,
    watchman: SAFE_WATCH,
    confirmed: true,
  });
  assert.equal(d.run, false);
  assert.equal((d as any).error, "command_not_allowed");
});

test("⛔ the allowlist is checked BEFORE the rulebook — confirmation never buys a forbidden binary", () => {
  const d = decideCommandRun({ command: "rm -rf /tmp/x", rules: DEFAULT_GROUND_RULES, watchman: SAFE_WATCH, confirmed: true });
  assert.equal(d.run, false);
  assert.equal((d as any).error, "command_not_allowed");
});

test("⛔⛔ reading credentials is refused mechanically — `cat` is allowlisted, secrets are not", () => {
  for (const bad of [
    "cat /opt/connectcomms/env/.env.platform",
    "cat ~/.ssh/id_rsa",
    "grep -r password /app/.env",
    "cat .connect-ssh/connect2_ed25519",
    "cat certs/server.pem",
  ]) {
    const d = decideCommandRun({ command: bad, rules: DEFAULT_GROUND_RULES, watchman: SAFE_WATCH, confirmed: true });
    assert.equal(d.run, false, `must refuse: ${bad}`);
    assert.equal((d as any).error, "refused_secrets", `wrong refusal for: ${bad}`);
  }
});

test("an ASK-FIRST command needs an explicit confirmation, then runs", () => {
  // "docker ps" is read-only and allowlisted; a rulebook that asks about
  // containers must still be honoured.
  // ⛔ The rule must use words that appear in the command — "container" does
  // not match `docker ps`. That is the rulebook's honest limitation, and it is
  // why the allowlist (not the prose) is what guarantees read-only.
  const rules = { allowed: "Read files", never: "Payments", askFirst: "Anything about docker" };
  const unconfirmed = decideCommandRun({ command: "docker ps -a", rules, watchman: SAFE_WATCH, confirmed: false });
  assert.equal(unconfirmed.run, false);
  assert.equal((unconfirmed as any).error, "confirmation_required");
  assert.equal((unconfirmed as any).needsConfirm, true);

  const confirmed = decideCommandRun({ command: "docker ps -a", rules, watchman: SAFE_WATCH, confirmed: true });
  assert.equal(confirmed.run, true);
});

test("an ordinary read-only command runs without a confirmation prompt", () => {
  // ⛔ The deliberate asymmetry: an unrecognised command is NOT sent to ask —
  // the allowlist already proved it read-only, and prompting for `ls` teaches
  // people to click through the prompts that matter.
  for (const ok of ["git status", "ls -la", "docker ps", "tail -n 50 /var/log/nginx/access.log"]) {
    const d = decideCommandRun({ command: ok, rules: DEFAULT_GROUND_RULES, watchman: SAFE_WATCH, confirmed: false });
    assert.equal(d.run, true, `should run: ${ok}`);
  }
});

test("⛔ a NEVER subject still refuses a read-only command", () => {
  const rules = { allowed: "Read files", never: "Payments, billing or pension", askFirst: "" };
  const d = decideCommandRun({
    command: "psql -c 'select * from payments'",
    rules,
    watchman: SAFE_WATCH,
    confirmed: true,
  });
  assert.equal(d.run, false);
  assert.equal((d as any).error, "refused_by_ground_rules");
});

// ───────────────────────────── paths + files ─────────────────────────────

test("⛔ path traversal out of the workspace is refused", () => {
  const root = path.resolve("/srv/app");
  for (const bad of ["../etc/passwd", "../../root/.ssh/id_rsa", "/etc/passwd"]) {
    const r = resolveWorkspacePath(root, bad);
    if (r.ok) assert.ok(r.absolute.startsWith(root + path.sep), `escaped: ${bad} → ${r.absolute}`);
  }
  assert.equal(resolveWorkspacePath(root, "../../etc/passwd").ok, false);
});

test("⛔ credential files are refused by name, whatever the path", () => {
  const root = path.resolve("/srv/app");
  for (const secret of [".env", ".env.platform", "certs/server.key", "keys/private.pem", "id_rsa"]) {
    const r = resolveWorkspacePath(root, secret);
    assert.equal(r.ok, false, `must refuse: ${secret}`);
    assert.match((r as any).reason, /credential/i);
  }
});

test("the explorer lists a real directory, hides junk and never lists a secret", async () => {
  const root = await fsp.mkdtemp(path.join(tmpdir(), "wb-"));
  await fsp.writeFile(path.join(root, "index.ts"), "export const x = 1;\n");
  await fsp.writeFile(path.join(root, ".env"), "SECRET=1\n");
  await fsp.mkdir(path.join(root, "node_modules"));
  await fsp.mkdir(path.join(root, "src"));
  const entries = await listWorkspaceDir(root, "");
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("src"));
  assert.ok(names.includes("index.ts"));
  assert.ok(!names.includes(".env"), "a credential file must never be listed");
  assert.ok(!names.includes("node_modules"), "node_modules must not be listed");
  assert.equal(entries[0].kind, "dir", "directories sort first");
});

test("reading a file returns its text; reading a secret throws", async () => {
  const root = await fsp.mkdtemp(path.join(tmpdir(), "wb-"));
  await fsp.writeFile(path.join(root, "hello.txt"), "hi there");
  const out = await readWorkspaceFile(root, "hello.txt");
  assert.equal(out.text, "hi there");
  assert.equal(out.truncated, false);
  await fsp.writeFile(path.join(root, ".env"), "SECRET=1");
  await assert.rejects(() => readWorkspaceFile(root, ".env"), /credential/i);
});

// ───────────────────────────── execution ─────────────────────────────

test("runCheckedCommand really runs an allowed command and captures output", async () => {
  const root = await fsp.mkdtemp(path.join(tmpdir(), "wb-"));
  const out = await runCheckedCommand("echo workbench-ok", root);
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /workbench-ok/);
});

test("⛔ runCheckedCommand re-checks the shape itself — a caller that skips the gate is not a shell", async () => {
  const root = await fsp.mkdtemp(path.join(tmpdir(), "wb-"));
  await assert.rejects(() => runCheckedCommand("echo hi; rm -rf /", root), /chaining/i);
  await assert.rejects(() => runCheckedCommand("bash -c 'whoami'", root), /isn't on the list/i);
});
