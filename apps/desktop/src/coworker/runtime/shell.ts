/**
 * Controlled PowerShell. ONE script per call, killed at its timeout (process
 * tree, via taskkill), output capped, and a denylist of command shapes that
 * change the machine's security posture — refused here whatever the policy said,
 * because the policy judges the TOOL ("shell") and cannot see the script.
 *
 * ⛔ The denylist is a second fence, not the first: the first is the permission
 * domain `shell`, which asks under SAFE and TRUSTED and allows only under
 * AUTONOMOUS. Do not widen the allow by loosening this list.
 */
import { spawn, type ChildProcess } from "node:child_process";

export const MAX_SHELL_OUTPUT_CHARS = 30_000;
export const MAX_SHELL_TIMEOUT_SEC = 600;

/** Command shapes the Coworker will not run. Case-insensitive, tested against the whole script. */
export const SHELL_DENY_PATTERNS: readonly { id: string; re: RegExp; why: string }[] = [
  { id: "defender", re: /Set-MpPreference|Disable(?:Realtime|Antivirus)|MpCmdRun|Add-MpPreference\s+-Exclusion/i, why: "changes Windows Defender" },
  { id: "firewall", re: /netsh\s+advfirewall|Set-NetFirewall|New-NetFirewallRule|Remove-NetFirewallRule|Disable-NetFirewall/i, why: "changes the Windows firewall" },
  { id: "services", re: /\b(?:Stop|Start|Restart|Set|Remove|New)-Service\b|\bsc(?:\.exe)?\s+(?:stop|start|config|delete|create)\b|\bnet\s+(?:stop|start)\b/i, why: "changes Windows services" },
  { id: "users", re: /\b(?:New|Remove|Set|Enable|Disable)-LocalUser\b|\bAdd-LocalGroupMember\b|\bnet\s+(?:user|localgroup)\b/i, why: "changes Windows accounts" },
  { id: "registry_security", re: /HKLM:\\(?:SYSTEM|SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies|SOFTWARE\\Policies)|reg(?:\.exe)?\s+(?:add|delete)\s+HKLM/i, why: "writes machine-wide registry policy" },
  { id: "network_config", re: /\bSet-Net(?:IPAddress|IPInterface|Adapter|DnsClient|Route)\b|\bNew-NetRoute\b|\bRemove-NetRoute\b|\bnetsh\s+interface\b|\bipconfig\s+\/(?:release|renew|flushdns)\b|\bSet-DnsClientServerAddress\b|\bDisable-NetAdapter\b|\bEnable-NetAdapter\b/i, why: "changes the network configuration" },
  { id: "install", re: /\bwinget\s+(?:install|uninstall|upgrade)\b|\bchoco\s+(?:install|uninstall|upgrade)\b|\bmsiexec\b|\bInstall-Module\b|\bInstall-Package\b|\bAdd-AppxPackage\b|\bRemove-AppxPackage\b|\bInstall-WindowsFeature\b|\bDism(?:\.exe)?\b/i, why: "installs or removes software" },
  { id: "remote_access", re: /\bEnable-PSRemoting\b|\bwinrm\b|\bfDenyTSConnections\b|\bStart-Process\s+[^\n]*\b(?:mstsc|vnc)\b|\bssh(?:d)?\s+-R\b/i, why: "opens remote access" },
  { id: "power", re: /\b(?:Restart|Stop)-Computer\b|\bshutdown(?:\.exe)?\s+\/[rsh]\b|\blogoff\b/i, why: "restarts, shuts down or logs off the computer" },
  { id: "disk", re: /\bFormat-Volume\b|\bformat(?:\.com)?\s+[a-z]:|\bdiskpart\b|\bClear-Disk\b|\bRemove-Partition\b|\bbcdedit\b/i, why: "modifies disks or the boot configuration" },
  { id: "uac_policy", re: /EnableLUA|ConsentPromptBehaviorAdmin|Set-ExecutionPolicy\s+(?!.*-Scope\s+(?:Process|CurrentUser))/i, why: "changes system security policy" },
  { id: "encoded", re: /-(?:e|ec|enc|encodedcommand)\s+[A-Za-z0-9+/=]{20,}/i, why: "hides its command behind encoding" },
  { id: "credentials", re: /\bmimikatz\b|\bGet-Credential\b|\bcmdkey\b|\bvaultcmd\b|\bConvertTo-SecureString\b.*-AsPlainText/i, why: "handles credentials" },
];

export function checkShellScript(script: string): { ok: true } | { ok: false; error: string; message: string } {
  for (const d of SHELL_DENY_PATTERNS) {
    if (d.re.test(script)) return { ok: false, error: `shell_refused:${d.id}`, message: `The Coworker will not run this script because it ${d.why}. These are never allowed, whatever the permission profile.` };
  }
  return { ok: true };
}

export type ShellRun = { ok: boolean; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number; truncated: boolean };

export type ShellDeps = {
  spawn?: typeof spawn;
  killTree?: (pid: number) => void;
  powershellPath?: string;
};

function killTreeWindows(pid: number) {
  try { spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* best effort */ }
}

/** Run a script (no denylist here — callers check first; see runPowerShellChecked). */
export function runPowerShell(script: string, opts: { timeoutSec?: number; cwd?: string; deps?: ShellDeps; onSpawn?: (child: ChildProcess) => void } = {}): Promise<ShellRun> {
  const sp = opts.deps?.spawn ?? spawn;
  const killTree = opts.deps?.killTree ?? killTreeWindows;
  const exe = opts.deps?.powershellPath ?? "powershell.exe";
  const timeoutMs = Math.min(Math.max(1, opts.timeoutSec ?? 60), MAX_SHELL_TIMEOUT_SEC) * 1000;
  const startedAt = Date.now();
  return new Promise<ShellRun>((resolve) => {
    let stdout = ""; let stderr = ""; let truncated = false; let timedOut = false; let done = false;
    const cap = (cur: string, chunk: string) => {
      if (cur.length >= MAX_SHELL_OUTPUT_CHARS) { truncated = true; return cur; }
      const next = cur + chunk;
      if (next.length > MAX_SHELL_OUTPUT_CHARS) { truncated = true; return next.slice(0, MAX_SHELL_OUTPUT_CHARS); }
      return next;
    };
    let child: ChildProcess;
    try {
      child = sp(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-Command", "-"], { cwd: opts.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e: any) {
      resolve({ ok: false, exitCode: null, stdout: "", stderr: `could not start PowerShell: ${e?.message ?? e}`, timedOut: false, durationMs: 0, truncated: false });
      return;
    }
    opts.onSpawn?.(child);
    const timer = setTimeout(() => { timedOut = true; if (child.pid) killTree(child.pid); try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout = cap(stdout, d.toString("utf8")); });
    child.stderr?.on("data", (d: Buffer) => { stderr = cap(stderr, d.toString("utf8")); });
    const finish = (code: number | null) => {
      if (done) return; done = true;
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, exitCode: code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), timedOut, durationMs: Date.now() - startedAt, truncated });
    };
    child.on("error", (e) => { stderr = cap(stderr, String(e?.message ?? e)); finish(null); });
    child.on("close", (code) => finish(code));
    try {
      // Force UTF-8 output so names with accents survive, then the script itself.
      child.stdin?.write("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'Continue';\n" + script + "\n");
      child.stdin?.end();
    } catch (e: any) {
      stderr = cap(stderr, String(e?.message ?? e));
    }
  });
}

/** The tool entry: denylist first, then run. */
export async function runPowerShellChecked(args: { script?: unknown; timeoutSec?: unknown; cwd?: unknown }, opts: { defaultCwd: string; deps?: ShellDeps; onSpawn?: (child: ChildProcess) => void }) {
  const script = typeof args.script === "string" ? args.script : "";
  if (!script.trim()) return { ok: false, error: "empty_script", message: "script is required." };
  if (script.length > 20_000) return { ok: false, error: "script_too_long", message: "Scripts are limited to 20000 characters." };
  const check = checkShellScript(script);
  if (!check.ok) return check;
  const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : opts.defaultCwd;
  const run = await runPowerShell(script, { timeoutSec: typeof args.timeoutSec === "number" ? args.timeoutSec : undefined, cwd, deps: opts.deps, onSpawn: opts.onSpawn });
  return { ...run, cwd };
}
