/**
 * Mouse and keyboard injection for remote support.
 *
 * ⛔ WHAT ELECTRON CANNOT DO. There is no Electron API for moving the real
 * mouse or typing into other applications — `webContents.sendInputEvent` only
 * reaches our own window, which is useless for support. Driving the actual
 * desktop needs Windows' own `SendInput`, and reaching that from a pure-JS
 * Electron app means either a native addon or an out-of-process helper.
 *
 * This is the out-of-process helper: one long-lived PowerShell process that
 * P/Invokes `SendInput`, fed newline-delimited JSON on stdin. It was chosen
 * over a native addon deliberately, and the trade is worth stating plainly:
 *
 *   ✅ No native compilation, no electron-rebuild, no ABI pinning, no change to
 *      the build pipeline, and it works on every Windows machine as-is because
 *      .NET Framework ships with the OS.
 *   ⛔ Antivirus dislikes PowerShell calling SendInput — it is genuinely what
 *      malware looks like. Expect occasional false positives until the app is
 *      code-signed, and understand this is the piece most likely to need
 *      replacing with a small signed native addon later.
 *
 * The swap path is why `InputInjector` is an interface: everything above this
 * file talks to that shape and nothing else, so replacing the transport is a
 * one-file change.
 *
 * ⛔ TWO LIMITS THAT ARE NOT BUGS, and no amount of code here fixes either:
 *   1. Windows refuses input from a normal app to an ELEVATED window. UAC
 *      prompts, the login screen and parts of Settings will look frozen to the
 *      support person. Fixing that needs a service running as SYSTEM — a
 *      deliberate, separate decision.
 *   2. The helper runs as the signed-in user, so it can do exactly what that
 *      user can do, and nothing more.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export type PointerButton = "left" | "right" | "middle";

export type InputCommand =
  /** Absolute position as a 0..1 fraction of the screen, so the sender never
   *  needs to know the customer's resolution. */
  | { kind: "move"; x: number; y: number }
  | { kind: "down"; x: number; y: number; button: PointerButton }
  | { kind: "up"; x: number; y: number; button: PointerButton }
  | { kind: "click"; x: number; y: number; button: PointerButton; double?: boolean }
  | { kind: "scroll"; x: number; y: number; deltaY: number }
  /** Literal text. Sent as unicode so it does not depend on keyboard layout. */
  | { kind: "text"; text: string }
  /** A named non-printing key, optionally with modifiers held. */
  | { kind: "key"; key: string; modifiers?: string[] };

export interface InputInjector {
  send(command: InputCommand): void;
  stop(): void;
  readonly available: boolean;
}

/**
 * The helper. Reads one JSON command per line and performs it.
 *
 * Written as a file rather than passed with -EncodedCommand on purpose: an
 * encoded PowerShell command line is both unreadable when something goes wrong
 * and the single most malware-shaped thing a process can do. A plain script on
 * disk can at least be inspected by whoever is asking what this program does.
 */
const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ConnectInput
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    // Fractions of the virtual desktop, so a multi-monitor setup works and the
    // sender never has to know the customer's resolution.
    static void SendMouse(uint flags, double fx, double fy, uint data)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].u.mi.dwFlags = flags;
        inputs[0].u.mi.mouseData = data;
        if ((flags & MOUSEEVENTF_ABSOLUTE) != 0)
        {
            inputs[0].u.mi.dx = (int)Math.Round(fx * 65535.0);
            inputs[0].u.mi.dy = (int)Math.Round(fy * 65535.0);
        }
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void MoveTo(double fx, double fy)
    {
        SendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, fx, fy, 0);
    }

    public static void Button(string button, bool down, double fx, double fy)
    {
        MoveTo(fx, fy);
        uint flags;
        if (button == "right") flags = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
        else if (button == "middle") flags = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
        else flags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
        SendMouse(flags, 0, 0, 0);
    }

    public static void Scroll(double fx, double fy, int amount)
    {
        MoveTo(fx, fy);
        SendMouse(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)amount));
    }

    // Unicode path: types the character itself rather than pressing whatever
    // key happens to be in that position on the customer's layout.
    public static void TypeChar(char c)
    {
        INPUT[] inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wScan = c;
        inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
        inputs[1] = inputs[0];
        inputs[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Key(ushort vk, bool down)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = vk;
        inputs[0].u.ki.dwFlags = down ? 0u : KEYEVENTF_KEYUP;
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@

$VK = @{
  'backspace'=0x08; 'tab'=0x09; 'enter'=0x0D; 'shift'=0x10; 'ctrl'=0x11; 'alt'=0x12;
  'pause'=0x13; 'capslock'=0x14; 'escape'=0x1B; 'space'=0x20; 'pageup'=0x21;
  'pagedown'=0x22; 'end'=0x23; 'home'=0x24; 'left'=0x25; 'up'=0x26; 'right'=0x27;
  'down'=0x28; 'printscreen'=0x2C; 'insert'=0x2D; 'delete'=0x2E; 'meta'=0x5B;
  'f1'=0x70; 'f2'=0x71; 'f3'=0x72; 'f4'=0x73; 'f5'=0x74; 'f6'=0x75; 'f7'=0x76;
  'f8'=0x77; 'f9'=0x78; 'f10'=0x79; 'f11'=0x7A; 'f12'=0x7B
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  try {
    $c = $line | ConvertFrom-Json
    switch ($c.kind) {
      'move'   { [ConnectInput]::MoveTo([double]$c.x, [double]$c.y) }
      'down'   { [ConnectInput]::Button([string]$c.button, $true,  [double]$c.x, [double]$c.y) }
      'up'     { [ConnectInput]::Button([string]$c.button, $false, [double]$c.x, [double]$c.y) }
      'click'  {
        [ConnectInput]::Button([string]$c.button, $true,  [double]$c.x, [double]$c.y)
        [ConnectInput]::Button([string]$c.button, $false, [double]$c.x, [double]$c.y)
        if ($c.double) {
          [ConnectInput]::Button([string]$c.button, $true,  [double]$c.x, [double]$c.y)
          [ConnectInput]::Button([string]$c.button, $false, [double]$c.x, [double]$c.y)
        }
      }
      'scroll' { [ConnectInput]::Scroll([double]$c.x, [double]$c.y, [int]$c.deltaY) }
      'text'   { foreach ($ch in [string]$c.text.ToCharArray()) { [ConnectInput]::TypeChar($ch) } }
      'key'    {
        $mods = @()
        if ($c.modifiers) { $mods = @($c.modifiers) }
        foreach ($m in $mods) { if ($VK.ContainsKey([string]$m)) { [ConnectInput]::Key([uint16]$VK[[string]$m], $true) } }
        $k = [string]$c.key
        if ($VK.ContainsKey($k)) { [ConnectInput]::Key([uint16]$VK[$k], $true); [ConnectInput]::Key([uint16]$VK[$k], $false) }
        elseif ($k.Length -eq 1) { [ConnectInput]::TypeChar($k[0]) }
        # Modifiers released in reverse, so Ctrl+Shift+X does not leave Ctrl stuck.
        for ($i = $mods.Count - 1; $i -ge 0; $i--) {
          $m = [string]$mods[$i]
          if ($VK.ContainsKey($m)) { [ConnectInput]::Key([uint16]$VK[$m], $false) }
        }
      }
    }
    [Console]::Out.WriteLine('ok')
  } catch {
    # ⛔ Never rethrow. One malformed command must not take the helper down and
    # strand a live support session with a frozen mouse.
    [Console]::Out.WriteLine('err ' + $_.Exception.Message)
  }
}
`;

/** Keys the helper knows by name. Anything else is typed as a character. */
export const NAMED_KEYS = new Set([
  "backspace", "tab", "enter", "shift", "ctrl", "alt", "pause", "capslock",
  "escape", "space", "pageup", "pagedown", "end", "home", "left", "up",
  "right", "down", "printscreen", "insert", "delete", "meta",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);

/**
 * Clamp a FINITE pointer position into the screen.
 *
 * ⛔ Exported and unit-tested because a bad fraction here is a mouse warped to
 * a corner of someone's real desktop, and that is not something to discover
 * during a support call.
 *
 * ⛔ Non-finite input is NOT clamped — it returns null so the caller refuses
 * the whole command. NaN and Infinity mean the message was malformed, and
 * silently turning malformed into "click the top-left corner" is how a support
 * tool clicks something nobody asked it to. Slightly-out-of-range values are a
 * different thing entirely (a pointer dragged past the window edge, which is
 * normal) and those are clamped.
 */
export function clampFraction(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Reject anything that is not a command we understand.
 *
 * The commands arrive over the network from the support side, so this is a
 * trust boundary, not a formality — it is the last thing between a remote
 * message and Windows' own input queue.
 */
export function sanitizeCommand(raw: unknown): InputCommand | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const kind = String(c.kind || "");
  const button: PointerButton =
    c.button === "right" || c.button === "middle" ? (c.button as PointerButton) : "left";

  // Pointer commands need real coordinates. A missing or malformed one refuses
  // the command rather than defaulting it to a corner of the screen.
  const POINTER_KINDS = new Set(["move", "down", "up", "click", "scroll"]);
  const cx = clampFraction(Number(c.x));
  const cy = clampFraction(Number(c.y));
  if (POINTER_KINDS.has(kind) && (cx === null || cy === null)) return null;
  const x = cx ?? 0;
  const y = cy ?? 0;

  switch (kind) {
    case "move":
      return { kind: "move", x, y };
    case "down":
      return { kind: "down", x, y, button };
    case "up":
      return { kind: "up", x, y, button };
    case "click":
      return { kind: "click", x, y, button, double: c.double === true };
    case "scroll": {
      const deltaY = Number(c.deltaY);
      if (!Number.isFinite(deltaY) || deltaY === 0) return null;
      // Bounded so a runaway wheel event cannot scroll a document forever.
      return { kind: "scroll", x, y, deltaY: Math.max(-2400, Math.min(2400, Math.round(deltaY))) };
    }
    case "text": {
      const text = typeof c.text === "string" ? c.text : "";
      if (!text) return null;
      // Newlines would be typed as literal characters and do nothing useful;
      // the sender is expected to use the "enter" key command instead.
      const cleaned = text.replace(/[\r\n]/g, "").slice(0, 500);
      return cleaned ? { kind: "text", text: cleaned } : null;
    }
    case "key": {
      const key = String(c.key || "").toLowerCase();
      if (!key) return null;
      if (!NAMED_KEYS.has(key) && key.length !== 1) return null;
      const mods = Array.isArray(c.modifiers)
        ? c.modifiers
            .map((m) => String(m).toLowerCase())
            .filter((m) => ["shift", "ctrl", "alt", "meta"].includes(m))
        : [];
      return { kind: "key", key, modifiers: mods };
    }
    default:
      return null;
  }
}

/** Windows-only, by construction — the helper is PowerShell and P/Invoke. */
export function inputInjectionSupported(platform: string = process.platform): boolean {
  return platform === "win32";
}

export class PowerShellInputInjector implements InputInjector {
  private child: ChildProcessWithoutNullStreams | null = null;
  private scriptPath: string;
  private stopped = false;

  constructor(scriptPath: string) {
    this.scriptPath = scriptPath;
  }

  get available(): boolean {
    return this.child !== null && !this.child.killed;
  }

  start(onExit?: (reason: string) => void): boolean {
    if (!inputInjectionSupported()) return false;
    try {
      mkdirSync(dirname(this.scriptPath), { recursive: true });
      writeFileSync(this.scriptPath, HELPER_SCRIPT, "utf8");

      this.child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          // Scoped to this process only — nothing about the machine's policy
          // is changed, and nothing persists after the helper exits.
          "-ExecutionPolicy", "Bypass",
          "-File", this.scriptPath,
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );

      this.child.on("exit", (code) => {
        this.child = null;
        if (!this.stopped) onExit?.(`helper_exited_${code ?? "unknown"}`);
      });
      this.child.on("error", () => {
        this.child = null;
        if (!this.stopped) onExit?.("helper_failed_to_start");
      });
      return true;
    } catch {
      this.child = null;
      return false;
    }
  }

  send(command: InputCommand): void {
    if (!this.child || this.child.killed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    } catch {
      // A dead pipe is handled by the exit handler; dropping one event is
      // always better than throwing inside a live session.
    }
  }

  stop(): void {
    this.stopped = true;
    if (!this.child) return;
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      /* already gone */
    }
    this.child = null;
  }
}

/** Where the helper script is written. */
export function helperScriptPath(userDataDir: string): string {
  return join(userDataDir, "remote-support", "input-helper.ps1");
}
