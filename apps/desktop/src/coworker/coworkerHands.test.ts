/**
 * The Coworker's hands — proven on this machine, not asserted.
 *
 *  - the local policy core cannot drift from packages/shared (read from disk);
 *  - every catalogue tool has an implementation and every implementation a spec;
 *  - the filesystem hands are fenced (temp dir as home; `..`, C:\Windows, an
 *    unknown drive, a junction escaping home — all refused), and move/copy never
 *    overwrite;
 *  - the shell denylist refuses security-posture changes; an allowed script runs
 *    for real and is killed at its timeout;
 *  - xlsx round-trips through the writer and reader;
 *  - the runtime: deny → nothing runs; ask → the approval callback decides; a
 *    "No" is journaled as denied; cancel aborts a waiting approval;
 *  - the link client: hello → poll → run → result against a fake fetch, 401 →
 *    token re-read, 409 → hello again, cancel message → runtime.cancel;
 *  - the MCP client: initialize / tools/list / tools/call against the real
 *    acceptance server as a child process, and a dead server reports as such.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp, mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as local from "./policyCore";
import { TOOL_CATALOG, TOOL_NAMES, findTool } from "./toolCatalog";
import { fsCopy, fsDelete, fsList, fsMkdir, fsMove, fsRead, fsSearch, fsStat, fsWrite, resolveUserPath, globToRegExp, type FsEnv } from "./runtime/fs";
import { checkShellScript, runPowerShell, runPowerShellChecked, SHELL_DENY_PATTERNS } from "./runtime/shell";
import { buildXlsx, parseXlsx, colName, colIndex } from "./runtime/xlsx";
import { Journal } from "./runtime/journal";
import { CoworkerRuntime, type RuntimeDeps } from "./runtime";
import { DesktopLinkClient } from "./link";
import { McpClient, McpManager, mcpModelName, parseServerConfig } from "./runtime/mcp";
import { TOKEN_SCRIPT } from "./hands";

const SHARED = path.join(__dirname, "..", "..", "..", "..", "packages", "shared", "src", "coworker");
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const tmpRoot = () => mkdtempSync(path.join(os.tmpdir(), "lc-hands-"));

/* ─────────────── policy core drift guard ─────────────── */

test("⛔ the local policy core matches packages/shared: domains, NEVER_AUTO, the three baselines, prohibition ids, check order", () => {
  const types = read(path.join(SHARED, "types.ts"));
  const policy = read(path.join(SHARED, "policy.ts"));
  const domainsBlock = /export const PERMISSION_DOMAINS = \[([\s\S]*?)\] as const;/.exec(types)![1];
  const sharedDomains = [...domainsBlock.matchAll(/"([a-z.]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...local.PERMISSION_DOMAINS], sharedDomains);
  const neverBlock = /export const NEVER_AUTO_DOMAINS: readonly PermissionDomain\[\] = \[([\s\S]*?)\] as const;/.exec(types)![1];
  assert.deepEqual([...local.NEVER_AUTO_DOMAINS], [...neverBlock.matchAll(/"([a-z.]+)"/g)].map((m) => m[1]));
  for (const profile of ["SAFE", "TRUSTED", "AUTONOMOUS"] as const) {
    const block = new RegExp(`${profile}: \\{([\\s\\S]*?)\\n  \\},`).exec(types)![1];
    const grants = Object.fromEntries([...block.matchAll(/"?([a-z.]+)"?: "(allow|ask|deny)"/g)].map((m) => [m[1], m[2]]));
    assert.deepEqual(local.PROFILE_BASELINE[profile], grants, `${profile} baseline drifted`);
  }
  const sharedIds = [...policy.matchAll(/id: "([a-z_]+)",\n\s+test:/g)].map((m) => m[1]);
  assert.deepEqual(local.HARD_PROHIBITIONS.map((h) => h.id), sharedIds);
  // Order of the checks, as the shared file documents it.
  const localSrc = read(path.join(__dirname, "policyCore.ts"));
  const order = ["coworker_disabled", "prohibited:", "deferred_during_call", "domain_denied", "external_content_cannot_authorize_high_risk", "external_content_needs_confirmation", "approved_by_user", "domain_needs_approval"];
  let last = -1;
  for (const code of order) { const i = localSrc.indexOf(code); assert.ok(i > last, `check ${code} out of order`); last = i; }
  // The floor: no override can allow a NEVER_AUTO domain.
  for (const d of local.NEVER_AUTO_DOMAINS) assert.equal(local.resolveGrant({ profile: "AUTONOMOUS", overrides: { [d]: "allow" } }, d), "ask");
  assert.equal(local.resolveGrant({ profile: "CUSTOM", overrides: {} }, "files.read"), "ask", "CUSTOM fails closed");
});

test("verdicts: SAFE asks for a write, TRUSTED allows it, delete asks everywhere, shell only allows under AUTONOMOUS, a call blocks system domains, provenance external is held", () => {
  const write = findTool("computer_fs_write")!.spec; const del = findTool("computer_fs_delete")!.spec; const shell = findTool("computer_powershell")!.spec;
  const p = (profile: local.PermissionProfile) => ({ profile, overrides: {} });
  assert.equal(local.decideToolCall({ spec: write, permissions: p("SAFE"), provenance: "user" }).verdict, "ask");
  assert.equal(local.decideToolCall({ spec: write, permissions: p("TRUSTED"), provenance: "user" }).verdict, "allow");
  for (const prof of ["SAFE", "TRUSTED", "AUTONOMOUS"] as const) assert.equal(local.decideToolCall({ spec: del, permissions: p(prof), provenance: "user" }).verdict, "ask", prof);
  assert.equal(local.decideToolCall({ spec: shell, permissions: p("TRUSTED"), provenance: "user" }).verdict, "ask");
  assert.equal(local.decideToolCall({ spec: shell, permissions: p("AUTONOMOUS"), provenance: "user" }).verdict, "allow");
  assert.equal(local.decideToolCall({ spec: shell, permissions: { profile: "AUTONOMOUS", overrides: { shell: "deny" } }, provenance: "user" }).code, "domain_denied");
  const sys = { ...write, domains: ["system.settings" as const] };
  assert.equal(local.decideToolCall({ spec: sys, permissions: p("AUTONOMOUS"), provenance: "user", callInProgress: true }).code, "deferred_during_call");
  assert.equal(local.decideToolCall({ spec: write, permissions: p("AUTONOMOUS"), provenance: "external" }).code, "external_content_needs_confirmation");
  assert.equal(local.decideToolCall({ spec: del, permissions: p("AUTONOMOUS"), provenance: "external", approved: true }).verdict, "deny", "external provenance cannot launder a destructive action even with approval");
  assert.equal(local.decideToolCall({ spec: { ...shell, name: "disable_defender" }, permissions: p("AUTONOMOUS"), provenance: "user", approved: true }).code, "prohibited:security_product_tamper");
  assert.equal(local.decideToolCall({ spec: write, permissions: p("AUTONOMOUS"), provenance: "user", coworkerEnabled: false }).code, "coworker_disabled");
});

test("paths: traversal, devices, UNC, ADS, short names and Windows folders are refused; containment is segment-wise", () => {
  for (const bad of ["C:\\Users\\bob\\..\\..\\Windows", "\\\\server\\share\\x", "\\\\?\\C:\\x", "C:foo", "C:\\a\\file.txt:hidden", "C:\\PROGRA~1\\x", "CON", "C:\\Windows\\System32\\drivers"]) {
    assert.equal(local.resolveScopedPath(bad, ["C:\\Users\\bob"]).ok, false, bad);
  }
  assert.equal(local.isInsideRoot("c:/users/bobby/x", "c:/users/bob"), false);
  assert.equal(local.isInsideRoot("C:\\Users\\bob\\Desktop\\a.txt", "C:\\Users\\bob"), true);
  assert.equal(local.resolveScopedPath("x", []).ok, false, "no roots = refuse");
});

test("redaction: by key first, patterns second, safe keys survive", () => {
  const r = local.redactStructured({ password: "swordfish", tokenExpiresAt: "2026", nested: { apiKey: "abc", note: "Bearer abcdefghijklmnopqrstuvwxyz" } });
  assert.equal((r.value as any).password, "[redacted]");
  assert.equal((r.value as any).tokenExpiresAt, "2026");
  assert.equal((r.value as any).nested.apiKey, "[redacted]");
  assert.match((r.value as any).nested.note, /\[redacted\]/);
  assert.equal(local.redactText("commit: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef").redactionCount, 0, "a documented hash is evidence");
});

/* ─────────────── catalogue ↔ runtime ─────────────── */

test("every catalogue tool has a runtime case, every runtime case is in the catalogue, names are model-safe, specs coherent", () => {
  const src = read(path.join(__dirname, "runtime", "index.ts"));
  const cases = [...src.matchAll(/case "(computer_[a-z_]+)":/g)].map((m) => m[1]);
  for (const t of TOOL_CATALOG) {
    assert.ok(cases.includes(t.name), `${t.name} has no runtime case`);
    assert.match(t.name, /^[a-z][a-z0-9_]{0,63}$/);
    assert.ok(t.description.length > 20 && t.description.length <= 2000);
    assert.equal(t.parameters.type, "object");
    if (t.spec.destructive) assert.ok(local.riskAtLeast(t.spec.risk, "HIGH"));
    if (t.spec.risk !== "READ_ONLY") assert.ok(t.spec.domains.length > 0, `${t.name} must declare a domain`);
    assert.ok(t.spec.timeoutMs > 0 && t.spec.timeoutMs <= 30 * 60 * 1000);
  }
  for (const c of new Set(cases)) assert.ok(TOOL_NAMES.includes(c), `${c} implemented but not in the catalogue`);
  assert.ok(findTool("computer_fs_delete")!.spec.destructive);
  assert.ok(findTool("computer_browser_submit")!.spec.exfiltrationCapable);
  assert.equal(findTool("computer_powershell")!.spec.category, "SHELL");
});

/* ─────────────── filesystem hands on a real temp dir ─────────────── */

async function fsEnv(): Promise<FsEnv & { dir: string }> {
  const dir = tmpRoot();
  const workspace = path.join(dir, "LoopcomCoworkerAcceptance");
  await fsp.mkdir(workspace, { recursive: true });
  return { dir, home: dir, workspace, roots: [dir, workspace] };
}

test("filesystem: mkdir / write / stat / read / list / search / move / copy inside the fence; refusals outside it; never overwrite", async () => {
  const env = await fsEnv();
  const mk = await fsMkdir({ path: "Project Alpha" }, env);
  assert.equal((mk as any).created, true);
  assert.ok(existsSync(path.join(env.workspace, "Project Alpha")));
  const w = await fsWrite({ path: "Project Alpha/notes.txt", content: "Loopcom coworker filesystem test" }, env);
  assert.equal((w as any).mode, "created");
  assert.equal(readFileSync(path.join(env.workspace, "Project Alpha", "notes.txt"), "utf8"), "Loopcom coworker filesystem test");
  const st = await fsStat({ path: path.join(env.workspace, "Project Alpha", "notes.txt") }, env);
  assert.equal((st as any).kind, "file");
  const rd = await fsRead({ path: "Project Alpha/notes.txt" }, env);
  assert.equal((rd as any).content, "Loopcom coworker filesystem test");
  const ls = await fsList({ path: env.workspace, recursive: true }, env);
  assert.ok((ls as any).entries.some((e: any) => e.name === "notes.txt"));
  for (const v of ["Vendor A", "Vendor B", "Vendor C"]) assert.equal((await fsMkdir({ path: v }, env) as any).ok, true);
  const mv = await fsMove({ from: "Project Alpha/notes.txt", to: "project-notes.txt" }, env);
  assert.equal((mv as any).ok, true);
  assert.ok(!existsSync(path.join(env.workspace, "Project Alpha", "notes.txt")));
  assert.ok(existsSync(path.join(env.workspace, "Project Alpha", "project-notes.txt")));
  const cp = await fsCopy({ from: "Project Alpha/project-notes.txt", to: "Vendor A" }, env);
  assert.equal((cp as any).sameSize, true);
  assert.equal(readFileSync(path.join(env.workspace, "Vendor A", "project-notes.txt"), "utf8"), "Loopcom coworker filesystem test");
  const cpAgain = await fsCopy({ from: "Project Alpha/project-notes.txt", to: "Vendor A" }, env);
  assert.equal((cpAgain as any).error, "exists", "copy never overwrites");
  const mv2 = await fsMove({ from: "Vendor A/project-notes.txt", to: "Vendor B/project-notes.txt" }, env);
  assert.equal((mv2 as any).verified.sourceGone && (mv2 as any).verified.destExists, true);
  const found = await fsSearch({ path: env.workspace, pattern: "*.txt" }, env);
  assert.deepEqual((found as any).results.map((r: any) => r.path).sort(), [path.join(env.workspace, "Project Alpha", "project-notes.txt"), path.join(env.workspace, "Vendor B", "project-notes.txt")].sort());
  assert.ok(globToRegExp("invoice*.csv").test("Invoice-2026.CSV"));
  // fences
  assert.equal((await fsWrite({ path: "C:\\Windows\\Temp\\x.txt", content: "x" }, env) as any).error, "forbidden_system_location");
  assert.equal((await fsWrite({ path: "..\\escape.txt", content: "x" }, env) as any).error, "unsafe_path");
  assert.equal((await fsRead({ path: "Q:\\nowhere\\x.txt" }, env) as any).error, "outside_allowed_roots");
  assert.equal((await fsDelete({ path: env.workspace }, env) as any).error, "refused_root");
  // overwrite refused when asked, allowed by default
  assert.equal((await fsWrite({ path: "Project Alpha/project-notes.txt", content: "v2", overwrite: false }, env) as any).error, "exists");
  assert.equal((await fsWrite({ path: "Project Alpha/project-notes.txt", content: "v2" }, env) as any).mode, "overwritten");
  // delete: file ok, non-empty folder needs recursive
  assert.equal((await fsDelete({ path: "Vendor B" }, env) as any).error, "not_empty");
  assert.equal((await fsDelete({ path: "Vendor B/project-notes.txt" }, env) as any).deleted, true);
  assert.equal((await fsDelete({ path: "Vendor B" }, env) as any).deleted, true);
});

test("filesystem: a junction inside home that points outside home fails closed (realpath re-check)", async () => {
  const env = await fsEnv();
  const outside = mkdtempSync(path.join(os.tmpdir(), "lc-outside-"));
  const link = path.join(env.workspace, "escape");
  try { execFileSync("cmd", ["/c", "mklink", "/J", link, outside], { stdio: "ignore" }); } catch { return; /* junction not permitted here; nothing to prove */ }
  const r = await resolveUserPath(path.join(link, "x.txt"), env);
  assert.equal(r.ok, false);
  assert.equal((r as any).error, "outside_allowed_roots");
});

/* ─────────────── shell ─────────────── */

test("shell: the denylist refuses security-posture changes; an allowed script really runs; a runaway script is killed", async () => {
  for (const s of ["Set-MpPreference -DisableRealtimeMonitoring $true", "netsh advfirewall set allprofiles state off", "Stop-Service -Name Spooler", "New-LocalUser x", "winget install foo", "Enable-PSRemoting", "Restart-Computer", "reg add HKLM\\SOFTWARE\\Policies\\x", "powershell -enc AAAAAAAAAAAAAAAAAAAAAAAAAAAA"]) {
    assert.equal(checkShellScript(s).ok, false, s);
  }
  assert.ok(SHELL_DENY_PATTERNS.length >= 12);
  assert.equal(checkShellScript("Get-Process | Select -First 3").ok, true);
  assert.equal(checkShellScript("Set-ExecutionPolicy -Scope Process Bypass").ok, true, "process-scoped execution policy is fine");
  const dir = tmpRoot();
  const r = await runPowerShellChecked({ script: "$env:COMPUTERNAME; 'proof' | Out-File -FilePath (Join-Path $PWD 'ps.txt') -Encoding utf8" }, { defaultCwd: dir });
  assert.equal((r as any).ok, true, JSON.stringify(r));
  assert.equal((r as any).stdout.trim().toUpperCase(), os.hostname().toUpperCase());
  assert.ok(existsSync(path.join(dir, "ps.txt")));
  const slow = await runPowerShell("Start-Sleep -Seconds 20; 'late'", { timeoutSec: 2 });
  assert.equal(slow.timedOut, true);
  assert.ok(slow.durationMs < 10_000);
});

/* ─────────────── xlsx ─────────────── */

test("xlsx: writer → reader round trip, columns, numbers and strings", () => {
  const buf = buildXlsx([{ name: "Invoices", rows: [["vendor", "amount"], ["Vendor A", 120.5], ["Vendor <B>", 99]] }, { name: "Notes", rows: [["ok"]] }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50, "a zip");
  const back = parseXlsx(buf);
  assert.deepEqual(back.sheets.map((s) => s.name), ["Invoices", "Notes"]);
  assert.deepEqual(back.sheets[0].rows, [["vendor", "amount"], ["Vendor A", 120.5], ["Vendor <B>", 99]]);
  assert.equal(colName(27), "AB");
  assert.equal(colIndex("AB1"), 27);
  // Formulas and numeric-looking strings (the O4 lesson: "=SUM(D2:D4)" and "1250.50" must be live cells).
  const f = buildXlsx([{ name: "S", rows: [["amount"], ["1250.50"], ["$980.00"], ["=SUM(A2:A3)"]] }]);
  const xml = require("./runtime/xlsx").readZip(f).get("xl/worksheets/sheet1.xml").toString("utf8");
  assert.match(xml, /<c r="A2"><v>1250.5<\/v><\/c>/);
  assert.match(xml, /<c r="A3"><v>980<\/v><\/c>/);
  assert.match(xml, /<c r="A4"><f>SUM\(A2:A3\)<\/f><\/c>/);
});

test("runtime: xlsx accepts object rows and refuses a sheet of empty placeholders", async () => {
  const env = await fsEnv();
  const r = runtimeFor("AUTONOMOUS", env);
  const empty = await r.runtime.handle({ id: "x1", name: "computer_xlsx_write", args: { path: "empty.xlsx", sheets: [{ name: "S", rows: [["a", "b"], [null, null], [null, null], ["", ""]] }] }, taskId: "t" });
  assert.equal((empty.content as any).error, "rows_mostly_empty");
  assert.ok(!existsSync(path.join(env.workspace, "empty.xlsx")));
  const objs = await r.runtime.handle({ id: "x2", name: "computer_xlsx_write", args: { path: "objs.xlsx", sheets: [{ name: "S", rows: [["vendor", "amount"], { vendor: "A", amount: 1 }, { vendor: "B", amount: 2 }] }] }, taskId: "t" });
  assert.equal(objs.ok, true, JSON.stringify(objs.content));
  const back = parseXlsx(readFileSync(path.join(env.workspace, "objs.xlsx")));
  assert.deepEqual(back.sheets[0].rows, [["vendor", "amount"], ["A", 1], ["B", 2]]);
});

/* ─────────────── runtime: verdict → approval → run → journal ─────────────── */

function runtimeFor(profile: "SAFE" | "TRUSTED" | "AUTONOMOUS", env: FsEnv & { dir: string }, opts: { approve?: boolean; onAsk?: (req: any, signal: AbortSignal) => Promise<{ approved: boolean; how: string }>; onActivity?: (n: number) => void } = {}) {
  const journal = new Journal(path.join(env.dir, `journal-${Math.random().toString(36).slice(2, 8)}`));
  const asks: any[] = [];
  const deps: RuntimeDeps = {
    home: env.home, workspace: env.workspace, extraRoots: () => [],
    permissions: () => ({ profile, overrides: {} }), isCallActive: () => false, coworkerEnabled: () => true,
    askApproval: opts.onAsk ?? (async (req) => { asks.push(req); return { approved: opts.approve !== false, how: "test" }; }),
    browser: { cancel() {}, currentUrl: () => null } as any,
    mcp: new McpManager(() => {}),
    journal,
    openPath: async () => {}, showInFolder: () => {},
    diagnostics: { portalUrl: "https://example.invalid", appVersion: "test", logFile: path.join(env.dir, "none.log"), phoneState: () => null, linkState: () => ({}) },
    log: () => {},
    onActivity: opts.onActivity,
  };
  return { runtime: new CoworkerRuntime(deps), journal, asks };
}

test("runtime: activity is reported 1 → 0 around every call (drives the bubble's badge), and a throwing listener never breaks the call", async () => {
  const env = await fsEnv();
  const seen: number[] = [];
  const r = runtimeFor("SAFE", env, { onActivity: (n) => seen.push(n) });
  const out = await r.runtime.handle({ id: "act1", name: "computer_workspace", args: {}, taskId: "t-act" });
  assert.equal(out.ok, true);
  assert.deepEqual(seen, [1, 0]);
  // While an approval is pending the call counts as active (the popover must not hide on blur).
  const during: number[] = [];
  const asking = runtimeFor("SAFE", env, { onActivity: (n) => during.push(n), onAsk: async () => { during.push(asking.runtime.activeCalls().length); return { approved: false, how: "test" }; } });
  await asking.runtime.handle({ id: "act2", name: "computer_fs_write", args: { path: "act.txt", content: "x" }, taskId: "t-act" });
  assert.deepEqual(during, [1, 1, 0]);
  const bad = runtimeFor("SAFE", env, { onActivity: () => { throw new Error("badge exploded"); } });
  assert.equal((await bad.runtime.handle({ id: "act3", name: "computer_workspace", args: {}, taskId: "t-act" })).ok, true);
});

test("runtime: SAFE asks before a write and runs on Yes; a No runs nothing and is journaled; deny never asks; unknown tool refused", async () => {
  const env = await fsEnv();
  const yes = runtimeFor("SAFE", env, { approve: true });
  const r1 = await yes.runtime.handle({ id: "c1", name: "computer_fs_write", args: { path: "hello.txt", content: "hi" }, taskId: "t1" });
  assert.equal(r1.ok, true);
  assert.equal(yes.asks.length, 1);
  assert.equal(yes.asks[0].tool, "computer_fs_write");
  assert.ok(existsSync(path.join(env.workspace, "hello.txt")));
  const no = runtimeFor("SAFE", env, { approve: false });
  const r2 = await no.runtime.handle({ id: "c2", name: "computer_fs_write", args: { path: "nope.txt", content: "x" }, taskId: "t1" });
  assert.equal(r2.ok, false);
  assert.equal((r2.content as any).error, "needs_approval");
  assert.ok(!existsSync(path.join(env.workspace, "nope.txt")));
  const j = await no.journal.recent(10);
  assert.deepEqual(j.calls.map((c) => c.outcome), ["denied", "asked"]);
  const denied = runtimeFor("SAFE", env);
  const r3 = await denied.runtime.handle({ id: "c3", name: "computer_fs_write", args: { path: "C:\\Windows\\x.txt", content: "x" }, taskId: "t1" });
  assert.equal(r3.ok, false, "policy asks, approval yes, but the PATH fence refuses");
  const r4 = await denied.runtime.handle({ id: "c4", name: "no_such_tool", args: {}, taskId: "t1" });
  assert.equal((r4.content as any).error, "unknown_tool");
  // A read never asks under SAFE.
  const reads = runtimeFor("SAFE", env);
  const r5 = await reads.runtime.handle({ id: "c5", name: "computer_fs_stat", args: { path: "hello.txt" }, taskId: "t1" });
  assert.equal(r5.ok, true); assert.equal(reads.asks.length, 0);
  // TRUSTED writes without asking; PowerShell still asks; AUTONOMOUS runs it.
  const trusted = runtimeFor("TRUSTED", env);
  assert.equal((await trusted.runtime.handle({ id: "c6", name: "computer_fs_mkdir", args: { path: "T" }, taskId: "t2" })).ok, true);
  assert.equal(trusted.asks.length, 0);
  await trusted.runtime.handle({ id: "c7", name: "computer_powershell", args: { script: "'x'" }, taskId: "t2" });
  assert.equal(trusted.asks.length, 1);
  const auto = runtimeFor("AUTONOMOUS", env);
  const ps = await auto.runtime.handle({ id: "c8", name: "computer_powershell", args: { script: "hostname" }, taskId: "t3" });
  assert.equal(ps.ok, true); assert.equal(auto.asks.length, 0);
  assert.equal((ps.content as any).stdout.trim().toUpperCase(), os.hostname().toUpperCase());
  const refused = await auto.runtime.handle({ id: "c9", name: "computer_powershell", args: { script: "Stop-Service Spooler" }, taskId: "t3" });
  assert.equal((refused.content as any).error, "shell_refused:services");
});

test("runtime: cancel aborts a pending approval and the call comes back cancelled; workspace tool reports the fence", async () => {
  const env = await fsEnv();
  const r = runtimeFor("SAFE", env, { onAsk: (_req, signal) => new Promise((resolve) => { signal.addEventListener("abort", () => resolve({ approved: false, how: "cancelled" })); }) });
  const p = r.runtime.handle({ id: "c1", name: "computer_fs_write", args: { path: "x.txt", content: "x" }, taskId: "job" });
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(r.runtime.cancel("job"), 1);
  const out = await p;
  assert.equal((out.content as any).error, "task_cancelled");
  const ws = await r.runtime.handle({ id: "c2", name: "computer_workspace", args: {}, taskId: "job2" });
  assert.equal((ws.content as any).workspace, env.workspace);
  assert.deepEqual((ws.content as any).allowedRoots, env.roots);
});

/* ─────────────── link client against a fake server ─────────────── */

test("link: hello → poll → run → result; 401 re-reads the token; 409 says hello again; a cancel message reaches the runtime", async () => {
  const env = await fsEnv();
  const r = runtimeFor("AUTONOMOUS", env);
  const seen: string[] = [];
  let tokens = 0; let cancelled: string | null = "unset";
  r.runtime.cancel = ((taskId: string | null) => { cancelled = taskId; return 0; }) as any;
  // Per-path queues: the client legitimately interleaves the result POST with the
  // next poll, so a single ordered list would race (it did, before this).
  const queues: Record<string, any[]> = {
    "/agent-api/coworker/hello": [{ status: 401 }, { status: 200, json: { ok: true, tools: 3 } }, { status: 200, json: { ok: true, tools: 3 } }],
    "/agent-api/coworker/next": [
      { status: 200, json: { message: { kind: "call", id: "call-1", name: "computer_fs_write", args: { path: "from-link.txt", content: "via link" }, taskId: "t" } } },
      { status: 409 }, // not registered → hello again
      { status: 200, json: { message: { kind: "cancel", taskId: "t" } } },
    ],
    "/agent-api/coworker/result": [{ status: 200, json: { ok: true, accepted: true } }],
  };
  const fakeFetch = (async (url: string, init: any) => {
    const p = new URL(url).pathname;
    seen.push(`${init.method} ${p}`);
    const next = queues[p]?.shift() ?? { status: 204 };
    return { status: next.status, text: async () => (next.json ? JSON.stringify(next.json) : "") } as any;
  }) as unknown as typeof fetch;
  const link = new DesktopLinkClient({ portalUrl: "https://portal.invalid", getToken: async () => { tokens++; return "a.b.c"; }, runtime: r.runtime, manifest: () => ({ desktopId: "d", tools: r.runtime.manifestTools() }), log: (l) => { if (process.env.LC_LINK_DEBUG) console.log("[link]", l); }, fetchImpl: fakeFetch }, "d");
  link.start();
  const until = Date.now() + 8000;
  while (Date.now() < until && !existsSync(path.join(env.workspace, "from-link.txt"))) await new Promise((res) => setTimeout(res, 50));
  assert.ok(existsSync(path.join(env.workspace, "from-link.txt")), "the call from the wire ran on disk");
  while (Date.now() < until && cancelled === "unset") await new Promise((res) => setTimeout(res, 50));
  assert.equal(cancelled, "t", "the cancel message reached the runtime");
  assert.ok(tokens >= 2, "401 made the client re-read the token");
  assert.ok(seen.filter((s) => s === "POST /agent-api/coworker/hello").length >= 2, "409 made it say hello again");
  assert.ok(seen.includes("POST /agent-api/coworker/result"));
  await link.stop();
  assert.equal(link.status().state, "off");
});

/* ─────────────── MCP client against the real acceptance server ─────────────── */

test("mcp: initialize, tools/list and tools/call against the acceptance server; model names; a dead server is reported", async () => {
  const server = path.join(__dirname, "..", "..", "scripts", "acceptance-mcp-server.js");
  const logDir = tmpRoot();
  const cfg = parseServerConfig({ id: "acceptance", name: "Acceptance", command: server, args: ["--log-dir", logDir], enabled: true })!;
  assert.ok(cfg);
  assert.equal(parseServerConfig({ id: "bad id!", command: "x" }), null);
  const lines: string[] = [];
  const client = new McpClient(cfg, (l) => lines.push(l));
  await client.connect();
  assert.equal(client.state, "connected", lines.join("\n"));
  assert.deepEqual(client.tools.map((t) => t.modelName).sort(), ["mcp_acceptance_acceptance_add", "mcp_acceptance_acceptance_echo", "mcp_acceptance_acceptance_token"]);
  assert.equal(mcpModelName("acceptance", "acceptance_token"), "mcp_acceptance_acceptance_token");
  assert.equal(client.tools[0].spec.domains[0], "mcp");
  const token = readFileSync(path.join(logDir, "current-token.txt"), "utf8").trim();
  const r = await client.callTool("acceptance_token", {});
  assert.equal(r.ok, true);
  assert.match(String((r.content as any).result), new RegExp(token));
  const add = await client.callTool("acceptance_add", { a: 20, b: 22 });
  assert.equal((add.content as any).structured.sum, 42);
  const logText = readFileSync(path.join(logDir, "mcp-invocations.log"), "utf8");
  assert.match(logText, /tools\/call acceptance_add/);
  const bad = await client.callTool("nope", {});
  assert.equal(bad.ok, false);
  client.disconnect();
  assert.equal(client.state, "stopped");
  // A command that exits immediately → dead/error, never a hang.
  const dead = new McpClient(parseServerConfig({ id: "dead", command: process.execPath, args: ["-e", "process.exit(3)"], enabled: true })!, () => {});
  await dead.connect();
  assert.ok(dead.state === "dead" || dead.state === "error", dead.state);
  const late = await dead.callTool("x", {});
  assert.equal((late.content as any).error, "mcp_not_connected");
  // The manager: apply / disable / remove.
  const mgr = new McpManager(() => {});
  await mgr.apply([cfg]);
  assert.equal(mgr.status()[0].state, "connected");
  assert.ok(mgr.find("mcp_acceptance_acceptance_token"));
  await mgr.apply([{ ...cfg, enabled: false }]);
  assert.equal(mgr.status()[0].state, "disabled");
  await mgr.apply([]);
  assert.equal(mgr.status().length, 0);
});

/* ─────────────── source guards ─────────────── */

test("source guards: main starts the hands after the main window, stops them on quit, the tray has the connections entry; preload publishes the two bridges; the token script reads the portal's keys", () => {
  const main = read(path.join(__dirname, "..", "main.ts"));
  assert.ok(main.indexOf("createFullWindow(!shouldStartHidden())") < main.indexOf("startHands();"));
  assert.match(main, /void hands\?\.stop\(\)/);
  assert.match(main, /Coworker Settings & Connections…/);
  assert.match(main, /Stop the Coworker's current task/);
  const preload = read(path.join(__dirname, "..", "preload.ts"));
  assert.match(preload, /exposeInMainWorld\("coworkerApproval"/);
  assert.match(preload, /exposeInMainWorld\("coworkerAdmin"/);
  const fa = read(path.join(__dirname, "..", "..", "..", "portal", "components", "FloatingAssistant.tsx"));
  for (const key of ["token", "cc-token", "authToken"]) { assert.ok(fa.includes(`localStorage.getItem("${key}")`)); assert.ok(TOKEN_SCRIPT.includes(`localStorage.getItem("${key}")`)); }
  const html = read(path.join(__dirname, "..", "..", "assets", "coworkerApproval.html"));
  assert.match(html, /coworker-approval|coworkerApproval/);
  assert.match(html, /button \{ -webkit-app-region: no-drag;/, "buttons must opt out of the drag region (a button inside one never gets its click on Windows)");
  for (const f of ["policyCore.ts", "toolCatalog.ts", "runtime/index.ts", "runtime/fs.ts", "runtime/shell.ts", "runtime/browser.ts", "runtime/xlsx.ts", "runtime/mcp.ts", "runtime/diagnostics.ts", "link.ts", "hands.ts", "approvalWindow.ts"]) {
    const src = readFileSync(path.join(__dirname, f), "utf8");
    const bad = [...src].filter((c) => { const x = c.charCodeAt(0); return x < 32 && x !== 9 && x !== 10 && x !== 13; });
    assert.equal(bad.length, 0, `${f} carries raw control bytes (git would treat it as binary)`);
  }
});

test("journal: rows are redacted and bounded", async () => {
  const dir = tmpRoot();
  const j = new Journal(dir);
  await j.append({ ts: new Date().toISOString(), kind: "call", taskId: "t", tool: "x", outcome: "done", args: { password: "hunter2", big: "y".repeat(5000) } });
  const r = await j.recent(5);
  assert.equal((r.calls[0].args as any).truncated ?? (r.calls[0].args as any).password, (r.calls[0].args as any).truncated ? true : "[redacted]");
  assert.doesNotMatch(readFileSync(path.join(dir, "journal.jsonl"), "utf8"), /hunter2/);
  mkdirSync(path.join(dir, "x"), { recursive: true }); writeFileSync(path.join(dir, "x", "a.txt"), "a");
});
