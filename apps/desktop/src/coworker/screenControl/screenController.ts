/**
 * Screen control — the Electron surface (⏳ the leg that needs a human on a real
 * screen to prove; the decision core in session.ts + the runtime gate are proven
 * by unit test). OFF by default: `begin` refuses unless the person opted in.
 *
 * What it wires together:
 *   - CAPTURE: Electron `desktopCapturer` at full display resolution → a PNG saved
 *     into the workspace artifacts (a record; not model vision — the model reads
 *     controls by name with `read`, the buttons-first path Izzy chose).
 *   - READ / CLICK-BY-TARGET: Windows UI Automation via PowerShell — the foreground
 *     window's controls as {ref,name,kind,enabled,rect}, and Invoke on one by ref
 *     with NO cursor movement (buttons-first). A target with no Invoke pattern falls
 *     back to a real click at its centre.
 *   - CURSOR / KEYBOARD FALLBACK: the SAME proven SendInput helper remote support
 *     uses (`PowerShellInputInjector`), driven from the pure `screenArgsToCommand`.
 *   - THE OVERLAY: the blue edge frame (overlay.ts), its colour following the session.
 *   - YIELD + ESCAPE: a non-swallowing low-level hook reports the person's input; we
 *     classify our own injected events by timing (see `markInject`) so we never pause
 *     ourselves, and hand the mouse straight back — Escape ends the run.
 *
 * ⛔ This class ACTS; it does not decide policy. The runtime's gate + the ask-once
 * session rule have already said yes before any method here runs.
 */
import path from "node:path";
import { promises as fsp } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { App, BrowserWindow as BW, Screen, DesktopCapturer, NativeImage } from "electron";
import { ScreenControlSession, screenArgsToCommand, shouldYieldTo, SCREEN_SESSION_MAX_MS, RESUME_AFTER_IDLE_MS, type ScreenActionName, type ObservedInput } from "./session";
import { ScreenOverlay, type OverlayFrame } from "./overlay";
import type { ScreenController, ScreenActionResult } from "./controller";
import { PowerShellInputInjector, helperScriptPath, type InputCommand, type InputInjector } from "../../remoteSupport/inputInjector";
import { runPowerShell } from "../runtime/shell";

export type ScreenControllerDeps = {
  app: App;
  BrowserWindow: typeof BW;
  screen: Screen;
  desktopCapturer: DesktopCapturer;
  assetPath: (file: string) => string;
  preloadPath: string;
  artifactsDir: () => string;
  /** The per-machine opt-in ("Let the Coworker control the screen"). Default off. */
  isEnabled: () => boolean;
  isCallActive: () => boolean;
  log: (line: string) => void;
  attachDiag?: (win: BW, tag: string) => void;
  /** Called when a session ends by Escape / ceiling — the runtime cancels that task. */
  onEnded?: (taskId: string, reason: string) => void;
  /** Register a produced artifact in the journal. */
  registerArtifact?: (a: { path: string; label: string; sizeBytes: number }) => void;
  /** Injectable for tests. */
  makeInjector?: () => InputInjector;
  makeOverlay?: () => ScreenOverlay;
  now?: () => number;
};

/** How long after one of our injected events we still treat activity as "ours". */
const OWN_EVENT_WINDOW_MS = 220;

/** The injector plus its concrete `start` (not on the shared interface). */
type StartableInjector = InputInjector & { start?(onExit?: (reason: string) => void): boolean };

export class ElectronScreenController implements ScreenController {
  readonly session: ScreenControlSession;
  private overlay: ScreenOverlay;
  private injector: StartableInjector | null = null;
  private watcher: ChildProcessWithoutNullStreams | null = null;
  private lastInjectAt = 0;
  private lastActivityAt = 0;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private ceilingTimer: ReturnType<typeof setTimeout> | null = null;
  private refs = new Map<string, { automationId?: string; name: string; rect?: { x: number; y: number; w: number; h: number } }>();
  private reason = "";
  private now: () => number;

  constructor(private deps: ScreenControllerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.session = new ScreenControlSession(this.now);
    this.overlay = deps.makeOverlay
      ? deps.makeOverlay()
      : new ScreenOverlay({ BrowserWindow: deps.BrowserWindow, screen: deps.screen, assetPath: deps.assetPath, preloadPath: deps.preloadPath, log: deps.log, attachDiag: deps.attachDiag });
  }

  isEnabled(): boolean {
    try { return this.deps.isEnabled(); } catch { return false; }
  }
  isApprovedFor(taskId: string): boolean {
    return this.session.isApprovedFor(taskId);
  }

  /* ───────────────────────── begin / end ───────────────────────── */

  async begin(taskId: string, reason: string, signal: AbortSignal): Promise<ScreenActionResult & { display?: { width: number; height: number } }> {
    if (!this.isEnabled()) return { ok: false, error: "screen_control_off", message: "Screen control is turned off in the Coworker's settings." };
    if (this.deps.isCallActive()) return { ok: false, error: "deferred_during_call", message: "A phone call is in progress." };
    if (!this.session.begin(taskId)) return { ok: false, error: "screen_busy", message: "The Coworker is already controlling the screen for another task." };
    this.reason = String(reason || "").slice(0, 240);
    try {
      this.startInjector();
      this.startWatcher();
      this.overlay.show("blue", this.statusText());
      this.armCeiling(taskId);
      signal.addEventListener("abort", () => { void this.end(taskId, "cancelled"); }, { once: true });
      const d = this.deps.screen.getPrimaryDisplay();
      this.deps.log(`screen control began for ${taskId}: ${this.reason}`);
      return { ok: true, note: "Screen control is on. Read controls with computer_screen_read, then click by target. Press Escape to stop.", display: { width: d.size.width, height: d.size.height } };
    } catch (e) {
      await this.end(taskId, "begin_failed");
      return { ok: false, error: "begin_failed", message: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }

  async end(taskId?: string, reason = "ended"): Promise<ScreenActionResult> {
    const owner = this.session.owner();
    if (taskId && owner && owner !== taskId) return { ok: true, ended: false, note: "A different task owns the screen; nothing changed." };
    this.session.end();
    this.overlay.update("green", "Finished");
    // let the green flash show briefly, then drop the frame
    setTimeout(() => { try { this.overlay.hide(); } catch { /* gone */ } }, 700);
    this.stopWatcher();
    this.stopInjector();
    this.clearTimers();
    this.refs.clear();
    this.session.reset();
    if (owner && reason !== "ended") { try { this.deps.onEnded?.(owner, reason); } catch { /* best effort */ } }
    this.deps.log(`screen control ended (${reason})`);
    return { ok: true, ended: true };
  }

  /* ───────────────────────── read (UI Automation) ───────────────────────── */

  async read(_taskId: string, args: Record<string, unknown>): Promise<ScreenActionResult> {
    const max = Math.min(Math.max(1, Number(args.maxControls) || 120), 400);
    const script = uiaSnapshotScript(max);
    const r = await runPowerShell(script, { timeoutSec: 25 });
    if (!r.ok) return { ok: false, error: "uia_failed", message: r.stderr?.slice(0, 200) || "Could not read the window." };
    let parsed: { window?: string; controls?: RawControl[] };
    try { parsed = JSON.parse(r.stdout || "{}"); } catch { return { ok: false, error: "uia_unreadable", message: "The window reader returned nothing usable." }; }
    this.refs.clear();
    const controls = (parsed.controls ?? []).slice(0, max).map((c, i) => {
      const ref = `c${i + 1}`;
      this.refs.set(ref, { automationId: c.automationId || undefined, name: c.name || "", rect: c.rect });
      return { ref, name: c.name || "", kind: c.type || "", enabled: c.enabled !== false, rect: c.rect };
    });
    this.overlay.update(this.session.frame() as OverlayFrame, this.statusText());
    return { ok: true, window: parsed.window || "", controls };
  }

  /* ───────────────────────── act ───────────────────────── */

  async act(taskId: string, name: ScreenActionName, args: Record<string, unknown>): Promise<ScreenActionResult> {
    if (!this.session.isApprovedFor(taskId)) return { ok: false, error: "screen_not_started", message: "Start with computer_screen_begin." };
    // Withdrawing permission mid-session stops it at the next action.
    if (!this.isEnabled()) { void this.end(taskId, "disabled"); return { ok: false, error: "screen_control_off", message: "Screen control was turned off, so the Coworker stopped controlling the screen." }; }
    if (this.session.getState() === "paused") return { ok: false, error: "paused_by_person", message: "The person is using the mouse or keyboard right now, so the Coworker stepped aside. Try again in a moment." };

    // buttons-first: a click with a target goes through UI Automation, no cursor moves.
    if (name === "computer_screen_click" && typeof args.target === "string" && args.target.trim()) {
      const invoked = await this.invokeTarget(args.target.trim());
      if (invoked.ok) return invoked;
      // fall through to a coordinate click only if the target resolved to a rect
      if (invoked.rect) {
        const cx = invoked.rect.x + invoked.rect.w / 2;
        const cy = invoked.rect.y + invoked.rect.h / 2;
        const frac = this.pointToFraction(cx, cy);
        if (frac) { this.inject({ kind: "click", x: frac.x, y: frac.y, button: "left" }); return { ok: true, via: "cursor_fallback", target: args.target }; }
      }
      return invoked;
    }

    const cmd = screenArgsToCommand(name, args);
    if (!cmd) return { ok: false, error: "bad_action", message: "That action was missing a valid position, text or key, so it was not performed." };
    if (!this.injector || !this.injector.available) return { ok: false, error: "input_unavailable", message: "The input helper is not running." };
    this.inject(cmd);
    return { ok: true, via: cmd.kind };
  }

  /* ───────────────────────── capture ───────────────────────── */

  async capture(_taskId: string, saveAs: string | undefined): Promise<ScreenActionResult & { path?: string }> {
    try {
      const display = this.deps.screen.getPrimaryDisplay();
      const scale = display.scaleFactor || 1;
      const width = Math.round(display.size.width * scale);
      const height = Math.round(display.size.height * scale);
      const sources = await this.deps.desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
      const primary = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      const img: NativeImage | undefined = primary?.thumbnail;
      if (!img || img.isEmpty()) return { ok: false, error: "capture_failed", message: "Could not capture the screen." };
      const png = img.toPNG();
      const dest = saveAs ?? path.join(this.deps.artifactsDir(), `screen-${Date.now()}.png`);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, png);
      const size = png.byteLength;
      try { this.deps.registerArtifact?.({ path: dest, label: "Screen snapshot", sizeBytes: size }); } catch { /* best effort */ }
      const s = img.getSize();
      return { ok: true, path: dest, width: s.width, height: s.height, bytes: size, note: "Saved a snapshot. To act on the screen, read controls with computer_screen_read." };
    } catch (e) {
      return { ok: false, error: "capture_failed", message: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }

  /* ───────────────────────── internals ───────────────────────── */

  private inject(cmd: InputCommand): void {
    try { this.injector?.send(cmd); } catch { /* one dropped event beats a throw */ }
    this.markInject();
  }
  /** Record that WE just caused input, so the watcher's next events are treated as ours. */
  private markInject(): void {
    this.lastInjectAt = this.now();
  }

  private async invokeTarget(target: string): Promise<ScreenActionResult & { rect?: { x: number; y: number; w: number; h: number } }> {
    const known = this.refs.get(target);
    const automationId = known?.automationId;
    const name = known?.name ?? target;
    const script = uiaInvokeScript(automationId, name);
    const r = await runPowerShell(script, { timeoutSec: 15 });
    if (r.ok && /INVOKED/.test(r.stdout || "")) return { ok: true, via: "ui_automation", target };
    return { ok: false, error: "target_not_found", message: `Could not find a control matching "${target}". Read the window again with computer_screen_read.`, rect: known?.rect };
  }

  private pointToFraction(px: number, py: number): { x: number; y: number } | null {
    try {
      const displays = this.deps.screen.getAllDisplays();
      // virtual desktop bounds
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const d of displays) { minX = Math.min(minX, d.bounds.x); minY = Math.min(minY, d.bounds.y); maxX = Math.max(maxX, d.bounds.x + d.bounds.width); maxY = Math.max(maxY, d.bounds.y + d.bounds.height); }
      const w = maxX - minX, h = maxY - minY;
      if (!(w > 0 && h > 0)) return null;
      return { x: (px - minX) / w, y: (py - minY) / h };
    } catch { return null; }
  }

  private statusText(): string {
    const st = this.session.getState();
    if (st === "paused") return "Paused — you're using the mouse";
    if (st === "asking") return "Waiting for your OK…";
    return this.reason ? `Working: ${this.reason}` : "Working on your screen…";
  }

  private startInjector(): void {
    if (this.injector) return;
    this.injector = this.deps.makeInjector ? this.deps.makeInjector() : new PowerShellInputInjector(helperScriptPath(this.deps.app.getPath("userData")));
    try { this.injector.start?.((reason) => this.deps.log(`screen injector down: ${reason}`)); } catch (e) { this.deps.log(`screen injector start failed: ${String(e)}`); }
  }
  private stopInjector(): void {
    try { this.injector?.stop(); } catch { /* gone */ }
    this.injector = null;
  }

  /* ── yield + Escape: a non-swallowing low-level hook reports the PERSON's input ── */

  private startWatcher(): void {
    if (this.watcher) return;
    try {
      this.watcher = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.watcher.stdin.write(YIELD_WATCH_SCRIPT);
      this.watcher.stdin.end();
      let buf = "";
      this.watcher.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) this.onWatchLine(line); }
      });
      this.watcher.stdout.on("error", () => { /* read side */ });
      this.watcher.on("exit", () => { this.watcher = null; });
      this.watcher.on("error", () => { this.watcher = null; });
    } catch (e) {
      this.deps.log(`yield watcher failed to start: ${String(e)}`);
    }
  }
  private stopWatcher(): void {
    const w = this.watcher; this.watcher = null;
    try { w?.stdin.end(); } catch { /* gone */ }
    try { w?.kill(); } catch { /* gone */ }
  }

  /** A line from the hook: "activity" (mouse/key) or "escape". Classify ours vs the person's by timing. */
  private onWatchLine(line: string): void {
    const isEscape = line.includes("escape");
    const source: ObservedInput["source"] = line.includes("key") || isEscape ? "keyboard" : "mouse";
    // Ours iff it landed inside the window right after we injected.
    const synthetic = this.now() - this.lastInjectAt <= OWN_EVENT_WINDOW_MS;
    const event: ObservedInput = { synthetic, source };
    if (isEscape && !synthetic) {
      const owner = this.session.owner();
      if (owner) void this.end(owner, "escape");
      return;
    }
    if (shouldYieldTo(event, this.session.getState())) {
      this.lastActivityAt = this.now();
      if (this.session.pause()) { this.overlay.update("grey", this.statusText()); this.scheduleResume(); }
    } else if (this.session.getState() === "paused" && !synthetic) {
      this.lastActivityAt = this.now();
      this.scheduleResume();
    }
  }

  private scheduleResume(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      if (this.session.getState() !== "paused") return;
      if (this.now() - this.lastActivityAt >= RESUME_AFTER_IDLE_MS) {
        if (this.session.resume()) this.overlay.update("blue", this.statusText());
      } else {
        this.scheduleResume();
      }
    }, RESUME_AFTER_IDLE_MS);
  }

  private armCeiling(taskId: string): void {
    this.clearTimers();
    this.ceilingTimer = setTimeout(() => { void this.end(taskId, "time_limit"); }, SCREEN_SESSION_MAX_MS);
  }
  private clearTimers(): void {
    if (this.resumeTimer) { clearTimeout(this.resumeTimer); this.resumeTimer = null; }
    if (this.ceilingTimer) { clearTimeout(this.ceilingTimer); this.ceilingTimer = null; }
  }
}

type RawControl = { name?: string; type?: string; enabled?: boolean; automationId?: string; rect?: { x: number; y: number; w: number; h: number } };

/* ───────────────────── the PowerShell sensors ─────────────────────
 * ⏳ These run against a real desktop only; there is nothing to unit-test here.
 * They are written to be safe (read-only snapshot; Invoke by name) and to fail
 * closed (return nothing usable → the tool reports it could not act). */

/** UI Automation snapshot of the foreground window's controls, as JSON. */
function uiaSnapshotScript(max: number): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type @"
using System;using System.Runtime.InteropServices;
public static class FG { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
"@
  $h = [FG]::GetForegroundWindow()
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  if ($root -eq $null) { '{"window":"","controls":[]}'; exit 0 }
  $title = $root.Current.Name
  $cond = [System.Windows.Automation.Condition]::TrueCondition
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  $out = New-Object System.Collections.ArrayList
  $count = 0
  foreach ($e in $all) {
    if ($count -ge ` + max + String.raw`) { break }
    try {
      $ct = $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''
      if ($ct -eq 'Pane' -or $ct -eq 'Custom' -or $ct -eq 'Separator') { continue }
      $n = $e.Current.Name
      if ([string]::IsNullOrWhiteSpace($n) -and $ct -ne 'Edit') { continue }
      $r = $e.Current.BoundingRectangle
      $obj = [ordered]@{ name=$n; type=$ct; enabled=$e.Current.IsEnabled; automationId=$e.Current.AutomationId; rect=@{ x=[int]$r.X; y=[int]$r.Y; w=[int]$r.Width; h=[int]$r.Height } }
      [void]$out.Add($obj); $count++
    } catch {}
  }
  $res = [ordered]@{ window=$title; controls=$out }
  $res | ConvertTo-Json -Depth 5 -Compress
} catch { '{"window":"","controls":[]}' }
`;
}

/** Invoke (click) a control by AutomationId or exact Name — no cursor movement. */
function uiaInvokeScript(automationId: string | undefined, name: string): string {
  const idJson = JSON.stringify(automationId ?? "");
  const nameJson = JSON.stringify(name ?? "");
  return String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type @"
using System;using System.Runtime.InteropServices;
public static class FG2 { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
"@
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([FG2]::GetForegroundWindow())
  if ($root -eq $null) { 'NOT_FOUND'; exit 0 }
  $aid = ` + idJson + String.raw`
  $nm = ` + nameJson + String.raw`
  $el = $null
  if ($aid -ne '') {
    $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $aid)
    $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
  }
  if ($el -eq $null -and $nm -ne '') {
    $c2 = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $nm)
    $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c2)
  }
  if ($el -eq $null) { 'NOT_FOUND'; exit 0 }
  $pat = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pat)) { $pat.Invoke(); 'INVOKED'; exit 0 }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pat)) { $pat.Toggle(); 'INVOKED'; exit 0 }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pat)) { $pat.Select(); 'INVOKED'; exit 0 }
  'NO_PATTERN'
} catch { 'NOT_FOUND' }
`;
}

/**
 * The yield + Escape sensor: a low-level mouse + keyboard hook that NEVER swallows
 * (always CallNextHookEx), writing one line per PERSON event. We classify ours vs
 * theirs by timing in JS, so this stays a dumb reporter. Escape is reported as
 * "escape"; other keys as "key"; mouse as "mouse".
 * ⏳ Runs against a real desktop only.
 */
const YIELD_WATCH_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;using System.Runtime.InteropServices;
public class LLHook {
  public const int WH_MOUSE_LL=14, WH_KEYBOARD_LL=13, WM_KEYDOWN=0x100, WM_SYSKEYDOWN=0x104;
  public delegate IntPtr Proc(int n, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, Proc cb, IntPtr mod, uint th);
  [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr h, int n, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(string n);
  [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint msg; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
}
"@
$mouseCb = [LLHook+Proc]{ param($n,$w,$l) if ($n -ge 0) { [Console]::Out.WriteLine('mouse') } ; return [LLHook]::CallNextHookEx([IntPtr]::Zero,$n,$w,$l) }
$keyCb = [LLHook+Proc]{ param($n,$w,$l)
  if ($n -ge 0 -and ($w.ToInt32() -eq [LLHook]::WM_KEYDOWN -or $w.ToInt32() -eq [LLHook]::WM_SYSKEYDOWN)) {
    $vk = [Runtime.InteropServices.Marshal]::ReadInt32($l)
    if ($vk -eq 0x1B) { [Console]::Out.WriteLine('escape') } else { [Console]::Out.WriteLine('key') }
  }
  return [LLHook]::CallNextHookEx([IntPtr]::Zero,$n,$w,$l)
}
$mod = [LLHook]::GetModuleHandle($null)
$hm = [LLHook]::SetWindowsHookEx([LLHook]::WH_MOUSE_LL, $mouseCb, $mod, 0)
$hk = [LLHook]::SetWindowsHookEx([LLHook]::WH_KEYBOARD_LL, $keyCb, $mod, 0)
$msg = New-Object LLHook+MSG
while ([LLHook]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0) -gt 0) { }
[LLHook]::UnhookWindowsHookEx($hm) | Out-Null
[LLHook]::UnhookWindowsHookEx($hk) | Out-Null
`;
