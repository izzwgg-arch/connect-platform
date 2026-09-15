/**
 * Screen control — the deterministic heart, proven exhaustively (no display needed).
 *
 *  - the pure session state machine: begin/pause/resume/asking/answered/end, the
 *    single-owner rule, ask-once-then-flow per task id, the hard ceiling;
 *  - the yield decision: our own injected input never pauses us, the person's does,
 *    and an unreadable event fails safe to "hand the mouse back";
 *  - the model-args → OS-command map goes through the same sanitizer as remote
 *    support, and refuses (never guesses) a malformed coordinate or key;
 *  - the catalogue declares the eight tools with the right risk/domains and each has
 *    a runtime case;
 *  - the RUNTIME integration against a fake controller: the per-machine opt-in gates
 *    begin; begin asks once (alwaysRequireApproval); a screen action with no session
 *    is refused outright (the mouse never moves by surprise); after one approval,
 *    500 rapid actions all run with ZERO further asks; a denied desktop.active
 *    override still wins; a live call defers it; the tools are hidden with no
 *    controller; administrator PowerShell always asks, honours the denylist, and is
 *    unavailable without the elevated helper.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ScreenControlSession, shouldYieldTo, screenArgsToCommand, STATE_FRAME,
  SCREEN_SESSION_MAX_MS, SCREEN_CONTROL_SIGNATURE, type ScreenControlState, type ScreenActionName,
} from "./screenControl/session";
import type { ScreenController } from "./screenControl/controller";
import { TOOL_CATALOG, findTool } from "./toolCatalog";
import { CoworkerRuntime, type RuntimeDeps } from "./runtime";
import { Journal } from "./runtime/journal";
import { McpManager } from "./runtime/mcp";

/* ───────────────────────── pure session ───────────────────────── */

test("session: begin opens control, pause/resume toggle, asking/answered, end is terminal", () => {
  let t = 1000;
  const s = new ScreenControlSession(() => t);
  assert.equal(s.getState(), "idle");
  assert.equal(s.frame(), "none");
  assert.equal(s.begin("task-A"), true);
  assert.equal(s.getState(), "working");
  assert.equal(s.frame(), "blue");
  assert.equal(s.owner(), "task-A");
  assert.equal(s.isApprovedFor("task-A"), true);
  assert.equal(s.isApprovedFor("task-B"), false, "consent is per task");
  assert.equal(s.pause(), true);
  assert.equal(s.getState(), "paused");
  assert.equal(s.frame(), "grey");
  assert.equal(s.isApprovedFor("task-A"), true, "a paused session is still the owner's");
  assert.equal(s.resume(), true);
  assert.equal(s.getState(), "working");
  s.asking();
  assert.equal(s.getState(), "asking");
  assert.equal(s.frame(), "amber");
  s.answered();
  assert.equal(s.getState(), "working");
  t = 1000 + SCREEN_SESSION_MAX_MS + 1;
  assert.ok(s.ageMs() > SCREEN_SESSION_MAX_MS, "the ceiling is measurable");
  s.end();
  assert.equal(s.getState(), "ended");
  assert.equal(s.frame(), "green");
  assert.equal(s.owner(), null);
  assert.equal(s.isApprovedFor("task-A"), false, "an ended session approves nothing");
});

test("session: one physical screen has one owner; a second task cannot inherit consent", () => {
  const s = new ScreenControlSession();
  assert.equal(s.begin("task-A"), true);
  assert.equal(s.begin("task-B"), false, "task B cannot begin while A drives");
  assert.equal(s.owner(), "task-A");
  assert.equal(s.begin("task-A"), true, "the same task re-begins fine (idempotent)");
  s.reset();
  assert.equal(s.getState(), "idle");
  assert.equal(s.begin("task-B"), true, "after reset a new task may take the screen");
});

test("session: pause/resume/asking/answered are no-ops from the wrong state", () => {
  const s = new ScreenControlSession();
  assert.equal(s.pause(), false, "cannot pause when idle");
  assert.equal(s.resume(), false, "cannot resume when idle");
  s.begin("t");
  assert.equal(s.resume(), false, "cannot resume when working");
  s.pause();
  assert.equal(s.pause(), false, "cannot pause twice");
  s.answered();
  assert.equal(s.getState(), "paused", "answered does nothing outside asking");
});

test("STATE_FRAME covers every state and maps to the mockup's four colours", () => {
  const states: ScreenControlState[] = ["idle", "working", "paused", "asking", "ended"];
  for (const st of states) assert.ok(STATE_FRAME[st], st);
  assert.deepEqual([STATE_FRAME.working, STATE_FRAME.paused, STATE_FRAME.asking, STATE_FRAME.ended], ["blue", "grey", "amber", "green"]);
});

/* ───────────────────────── yield decision ───────────────────────── */

test("yield: our own injected input never pauses us; the person's does; only while working; unreadable events fail safe", () => {
  // Our own events (synthetic true) never pause.
  assert.equal(shouldYieldTo({ synthetic: true, source: "mouse" }, "working"), false);
  assert.equal(shouldYieldTo({ synthetic: true, source: "keyboard" }, "working"), false);
  // The person's events pause us — but only while we are actually driving.
  assert.equal(shouldYieldTo({ synthetic: false, source: "mouse" }, "working"), true);
  assert.equal(shouldYieldTo({ synthetic: false, source: "keyboard" }, "working"), true);
  assert.equal(shouldYieldTo({ synthetic: false, source: "mouse" }, "paused"), false, "already paused");
  assert.equal(shouldYieldTo({ synthetic: false, source: "mouse" }, "idle"), false);
  assert.equal(shouldYieldTo({ synthetic: false, source: "mouse" }, "asking"), false, "an approval already stopped us");
  // Fail safe: an event we could not classify is treated as the person.
  assert.equal(shouldYieldTo({ synthetic: undefined as unknown as boolean, source: "mouse" }, "working"), true);
  assert.equal(SCREEN_CONTROL_SIGNATURE, 0x100cc01c, "the signature is a fixed 32-bit constant");
});

/* ───────────────────────── args → command ───────────────────────── */

test("args→command: valid actions map; malformed coordinates/keys are refused, never guessed", () => {
  assert.deepEqual(screenArgsToCommand("computer_screen_move", { x: 0.5, y: 0.25 }), { kind: "move", x: 0.5, y: 0.25 });
  assert.deepEqual(screenArgsToCommand("computer_screen_click", { x: 0.1, y: 0.2, button: "right" }), { kind: "click", x: 0.1, y: 0.2, button: "right", double: false });
  assert.deepEqual(screenArgsToCommand("computer_screen_click", { x: 0.1, y: 0.2, double: true }), { kind: "click", x: 0.1, y: 0.2, button: "left", double: true });
  assert.deepEqual(screenArgsToCommand("computer_screen_type", { text: "Invoice 2026" }), { kind: "text", text: "Invoice 2026" });
  assert.deepEqual(screenArgsToCommand("computer_screen_key", { key: "a", modifiers: ["ctrl"] }), { kind: "key", key: "a", modifiers: ["ctrl"] });
  assert.deepEqual(screenArgsToCommand("computer_screen_key", { key: "enter" }), { kind: "key", key: "enter", modifiers: [] });
  // scroll: notches → wheel units.
  assert.deepEqual(screenArgsToCommand("computer_screen_scroll", { x: 0.5, y: 0.5, amount: -3 }), { kind: "scroll", x: 0.5, y: 0.5, deltaY: -360 });
  // refusals — a dropped action beats an action nobody asked for.
  assert.equal(screenArgsToCommand("computer_screen_move", { x: 0.5 }), null, "missing y");
  assert.equal(screenArgsToCommand("computer_screen_move", { x: Infinity, y: 0.5 }), null, "non-finite refused, not clamped");
  assert.equal(screenArgsToCommand("computer_screen_click", { x: "0.5" as unknown as number, y: 0.5 }), null, "string coord refused");
  assert.equal(screenArgsToCommand("computer_screen_type", { text: "" }), null, "empty text");
  assert.equal(screenArgsToCommand("computer_screen_key", { key: "" }), null, "empty key");
  assert.equal(screenArgsToCommand("computer_screen_key", { key: "notarealkey" }), null, "multi-char non-named key refused by the sanitizer");
  assert.equal(screenArgsToCommand("computer_screen_scroll", { x: 0.5, y: 0.5, amount: 0 }), null, "zero scroll");
  // out-of-range fractions are clamped into the screen (a drag past the edge is normal).
  assert.deepEqual(screenArgsToCommand("computer_screen_move", { x: 1.4, y: -0.2 }), { kind: "move", x: 1, y: 0 });
});

/* ───────────────────────── catalogue ───────────────────────── */

test("catalogue: the eight screen tools declare desktop.active, the right risk, and buttons-first framing", () => {
  const names = ["computer_screen_begin", "computer_screen_read", "computer_screen_click", "computer_screen_type", "computer_screen_key", "computer_screen_scroll", "computer_screen_move", "computer_screen_capture", "computer_screen_end"];
  for (const n of names) assert.ok(findTool(n), `${n} is in the catalogue`);
  assert.equal(findTool("computer_screen_begin")!.spec.alwaysRequireApproval, true, "begin always asks");
  assert.deepEqual([...findTool("computer_screen_begin")!.spec.domains], ["desktop.active"]);
  assert.equal(findTool("computer_screen_begin")!.spec.category, "COMPUTER_USE");
  for (const n of ["computer_screen_click", "computer_screen_type", "computer_screen_key", "computer_screen_scroll", "computer_screen_move"]) {
    assert.ok(findTool(n)!.spec.domains.includes("desktop.active"), n);
    assert.equal(findTool(n)!.spec.risk, "LOW", n);
  }
  assert.equal(findTool("computer_screen_read")!.spec.risk, "READ_ONLY");
  assert.ok(findTool("computer_screen_capture")!.spec.domains.includes("files.write"));
  assert.deepEqual([...findTool("computer_screen_end")!.spec.domains], [], "ending control is always allowed");
  assert.match(findTool("computer_screen_click")!.description, /target/i);
  assert.equal(TOOL_CATALOG.filter((t) => t.name.startsWith("computer_screen_")).length, 9);
  // powershell learned an elevated option
  assert.ok((findTool("computer_powershell")!.parameters.properties as Record<string, unknown>).elevated);
});

/* ───────────────────────── runtime integration (fake controller) ───────────────────────── */

class FakeScreen implements ScreenController {
  readonly session = new ScreenControlSession();
  enabled = true;
  begins = 0; acts: { name: string; args: Record<string, unknown> }[] = []; reads = 0; captures = 0; ends = 0;
  isEnabled() { return this.enabled; }
  isApprovedFor(taskId: string) { return this.session.isApprovedFor(taskId); }
  async begin(taskId: string) { this.begins++; this.session.begin(taskId); return { ok: true, display: { width: 1920, height: 1080 } }; }
  async read(_taskId: string) { this.reads++; return { ok: true, window: "Invoices — File Explorer", controls: [{ ref: "c1", name: "Rename", kind: "button", enabled: true }] }; }
  async act(_taskId: string, name: ScreenActionName, args: Record<string, unknown>) { this.acts.push({ name, args }); return { ok: true }; }
  async capture(_taskId: string, saveAs: string | undefined) { this.captures++; return { ok: true, path: saveAs ?? "C:/ws/artifacts/shot.png" }; }
  async end() { this.ends++; this.session.end(); return { ok: true, ended: true }; }
}

function rt(opts: {
  profile?: "SAFE" | "TRUSTED" | "AUTONOMOUS"; overrides?: Record<string, "allow" | "ask" | "deny">;
  screen?: FakeScreen | null; approve?: boolean; callActive?: boolean;
  runElevated?: RuntimeDeps["runElevatedPowerShell"];
} = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lc-screen-"));
  mkdirSync(path.join(dir, "ws"), { recursive: true });
  const asks: any[] = [];
  const screen = opts.screen === null ? undefined : (opts.screen ?? new FakeScreen());
  const deps: RuntimeDeps = {
    home: dir, workspace: path.join(dir, "ws"), extraRoots: () => [],
    permissions: () => ({ profile: opts.profile ?? "SAFE", overrides: (opts.overrides ?? {}) as any }),
    isCallActive: () => opts.callActive ?? false, coworkerEnabled: () => true,
    askApproval: async (req) => { asks.push(req); return { approved: opts.approve !== false, how: "test" }; },
    browser: { cancel() {}, currentUrl: () => null } as any,
    screen: screen as ScreenController | undefined,
    runElevatedPowerShell: opts.runElevated,
    mcp: new McpManager(() => {}),
    journal: new Journal(path.join(dir, "j")),
    openPath: async () => {}, showInFolder: () => {},
    diagnostics: { portalUrl: "https://x.invalid", appVersion: "t", logFile: path.join(dir, "l.log"), phoneState: () => null, linkState: () => ({}) },
    log: () => {},
  };
  return { runtime: new CoworkerRuntime(deps), asks, screen: screen as FakeScreen, dir };
}

test("runtime: screen tools are hidden when no controller is wired; present when it is", () => {
  const none = rt({ screen: null });
  assert.equal(none.runtime.manifestTools().some((t) => t.name.startsWith("computer_screen_")), false);
  const on = rt({});
  assert.ok(on.runtime.manifestTools().some((t) => t.name === "computer_screen_begin"));
});

test("runtime: begin needs the per-machine opt-in, then asks once; a screen action with no session is refused; end is always allowed", async () => {
  const off = rt({}); off.screen.enabled = false;
  const r0 = await off.runtime.handle({ id: "s0", name: "computer_screen_begin", args: { reason: "rename files" }, taskId: "T" });
  assert.equal((r0.content as any).error, "screen_control_off");
  assert.equal(off.asks.length, 0, "a disabled feature never even asks");
  assert.equal(off.screen.begins, 0);

  // action before begin → refused outright, controller never touched, no ask
  const a = rt({});
  const rBefore = await a.runtime.handle({ id: "s1", name: "computer_screen_click", args: { target: "Rename" }, taskId: "T" });
  assert.equal((rBefore.content as any).error, "screen_not_started");
  assert.equal(a.asks.length, 0);
  assert.equal(a.screen.acts.length, 0, "the mouse never moved by surprise");

  // begin asks once (alwaysRequireApproval), even though this is SAFE and desktop.active
  const rBegin = await a.runtime.handle({ id: "s2", name: "computer_screen_begin", args: { reason: "rename 8 files" }, taskId: "T" });
  assert.equal(rBegin.ok, true, JSON.stringify(rBegin.content));
  assert.equal(a.asks.length, 1);
  assert.equal(a.asks[0].tool, "computer_screen_begin");
  assert.match(a.asks[0].what, /rename 8 files/);
  assert.equal(a.screen.begins, 1);
  assert.equal(a.screen.isApprovedFor("T"), true);

  // end is allowed with no ask
  const rEnd = await a.runtime.handle({ id: "s3", name: "computer_screen_end", args: {}, taskId: "T" });
  assert.equal(rEnd.ok, true);
  assert.equal(a.screen.ends, 1);
});

test("runtime: ASK ONCE THEN FLOW — after begin, screen actions run without ever asking again (stress: 500 actions, 0 asks)", async () => {
  const a = rt({ profile: "SAFE" });
  await a.runtime.handle({ id: "b", name: "computer_screen_begin", args: { reason: "work the screen" }, taskId: "T" });
  assert.equal(a.asks.length, 1, "exactly one ask, for begin");

  // a read (buttons-first eyes), then a click by target, then typing — none ask.
  await a.runtime.handle({ id: "r", name: "computer_screen_read", args: {}, taskId: "T" });
  const click = await a.runtime.handle({ id: "c", name: "computer_screen_click", args: { target: "Rename" }, taskId: "T" });
  assert.equal(click.ok, true);
  assert.deepEqual(a.screen.acts[0], { name: "computer_screen_click", args: { target: "Rename" } });

  for (let i = 0; i < 500; i++) {
    const kind = i % 4;
    const call = kind === 0 ? { name: "computer_screen_click", args: { target: `item-${i}` } }
      : kind === 1 ? { name: "computer_screen_type", args: { text: `row ${i}` } }
      : kind === 2 ? { name: "computer_screen_key", args: { key: "tab" } }
      : { name: "computer_screen_move", args: { x: (i % 100) / 100, y: 0.5 } };
    const out = await a.runtime.handle({ id: `x${i}`, name: call.name, args: call.args, taskId: "T" });
    assert.equal(out.ok, true, `${call.name} #${i}: ${JSON.stringify(out.content)}`);
  }
  assert.equal(a.asks.length, 1, "STILL exactly one ask after 500 actions — ask-once holds");
  assert.equal(a.screen.reads, 1);
  assert.ok(a.screen.acts.length >= 501);

  // a DIFFERENT task is not covered by this session — it must begin (and ask) itself.
  const other = await a.runtime.handle({ id: "o", name: "computer_screen_click", args: { target: "x" }, taskId: "OTHER" });
  assert.equal((other.content as any).error, "screen_not_started", "consent does not leak across tasks");
});

test("runtime: a denied desktop.active override still wins over the session; a live call defers screen control", async () => {
  const denied = rt({ profile: "AUTONOMOUS", overrides: { "desktop.active": "deny" } });
  const r = await denied.runtime.handle({ id: "d", name: "computer_screen_begin", args: { reason: "x" }, taskId: "T" });
  assert.equal((r.content as any).error, "domain_denied");
  assert.equal(denied.asks.length, 0);

  const oncall = rt({ callActive: true });
  const r2 = await oncall.runtime.handle({ id: "call", name: "computer_screen_begin", args: { reason: "x" }, taskId: "T" });
  assert.equal((r2.content as any).error, "deferred_during_call", "a phone call is priority #1");
});

test("runtime: administrator PowerShell always asks (even AUTONOMOUS), honours the denylist, and is unavailable without the helper", async () => {
  const calls: { script: string }[] = [];
  const run: RuntimeDeps["runElevatedPowerShell"] = async (script) => { calls.push({ script }); return { ok: true, stdout: "admin-ok", exitCode: 0 }; };

  // AUTONOMOUS allows plain shell without asking — but elevated ALWAYS asks.
  const a = rt({ profile: "AUTONOMOUS", runElevated: run });
  const plain = await a.runtime.handle({ id: "p1", name: "computer_powershell", args: { script: "hostname" }, taskId: "T" });
  assert.equal(a.asks.length, 0, "plain PowerShell under AUTONOMOUS does not ask");
  assert.equal(plain.ok, true);
  const adm = await a.runtime.handle({ id: "p2", name: "computer_powershell", args: { script: "Get-Process", elevated: true }, taskId: "T" });
  assert.equal(a.asks.length, 1, "elevated always asks");
  assert.match(a.asks[0].what, /ADMINISTRATOR/);
  assert.equal(adm.ok, true);
  assert.equal(calls.length, 1);
  assert.equal((adm.content as any).stdout, "admin-ok");

  // the denylist still applies to elevated scripts
  const refused = await a.runtime.handle({ id: "p3", name: "computer_powershell", args: { script: "Stop-Service Spooler", elevated: true }, taskId: "T" });
  assert.equal((refused.content as any).error, "shell_refused:services");
  assert.equal(calls.length, 1, "a refused elevated script never reaches the helper");

  // without the helper wired, elevation is unavailable (and still asked first)
  const noHelper = rt({ profile: "AUTONOMOUS" });
  const un = await noHelper.runtime.handle({ id: "p4", name: "computer_powershell", args: { script: "Get-Process", elevated: true }, taskId: "T" });
  assert.equal((un.content as any).error, "elevation_unavailable");
  assert.equal(noHelper.asks.length, 1, "still asked before discovering the helper is missing");
});

test("runtime: capture writes only inside the fenced workspace and returns a path", async () => {
  const a = rt({});
  await a.runtime.handle({ id: "b", name: "computer_screen_begin", args: { reason: "x" }, taskId: "T" });
  const cap = await a.runtime.handle({ id: "cap", name: "computer_screen_capture", args: {}, taskId: "T" });
  assert.equal(cap.ok, true);
  assert.equal(a.screen.captures, 1);
  // a saveAs outside the fence is refused before the controller is called
  const bad = await a.runtime.handle({ id: "cap2", name: "computer_screen_capture", args: { saveAs: "C:/Windows/x.png" }, taskId: "T" });
  assert.equal(bad.ok, false);
  assert.equal(a.screen.captures, 1, "the fence refused before the controller ran");
});
