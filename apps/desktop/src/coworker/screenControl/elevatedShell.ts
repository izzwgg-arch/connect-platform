/**
 * Run ONE PowerShell script as administrator — "PowerShell as admin, with
 * permission" (Izzy, 2026-09-15). Windows shows ITS OWN elevation prompt and the
 * person clicks Yes; we never type into it and never see a password.
 *
 * ⛔ The Coworker's denylist has already refused security/firewall/service/etc.
 * scripts before this is called (runtime/index.ts), and the runtime always asks
 * the person first (elevated runs raise the risk to HIGH + alwaysRequireApproval).
 * This module only performs the elevation and captures the output.
 *
 * Mechanism: the elevated child cannot inherit our stdio (the elevation boundary
 * drops the handles), so it writes its combined output and exit code to two files
 * in our own userData (the elevated process runs as the SAME user, just High
 * integrity, so it can write there and we can read it). A declined UAC prompt makes
 * Start-Process throw, which we report as "declined" — never as a silent failure.
 *
 * ⏳ Needs a real machine + a real UAC click to prove; there is nothing to unit-test.
 */
import path from "node:path";
import { promises as fsp } from "node:fs";
import { runPowerShell } from "../runtime/shell";
import type { RunElevatedPowerShell } from "./controller";

export function makeRunElevatedPowerShell(userDataDir: string): RunElevatedPowerShell {
  return async (script, opts) => {
    if (typeof script !== "string" || !script.trim()) return { ok: false, error: "empty_script", message: "script is required." };
    const dir = path.join(userDataDir, "coworker", "elevated");
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const scriptFile = path.join(dir, `run-${stamp}.ps1`);
    const outFile = path.join(dir, `out-${stamp}.txt`);
    const codeFile = path.join(dir, `code-${stamp}.txt`);
    const q = (p: string) => JSON.stringify(p);
    try {
      await fsp.mkdir(dir, { recursive: true });
      // The elevated script: run the person's script, capture ALL streams and the outcome.
      const wrapped =
        `$ErrorActionPreference='Continue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
        `try { & {\n${script}\n} *>&1 | Out-File -FilePath ${q(outFile)} -Encoding utf8; ` +
        `'0' | Out-File -FilePath ${q(codeFile)} -Encoding utf8 } ` +
        `catch { $_ | Out-File -FilePath ${q(outFile)} -Encoding utf8; '1' | Out-File -FilePath ${q(codeFile)} -Encoding utf8 }`;
      await fsp.writeFile(scriptFile, wrapped, "utf8");

      // The (non-elevated) launcher: raise the UAC prompt and WAIT for the run.
      const launcher =
        `try { Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru ` +
        `-ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', ${q(scriptFile)}) | Out-Null; 'LAUNCHED' } ` +
        `catch { 'DECLINED' }`;

      const timeoutSec = Math.min(Math.max(5, opts.timeoutSec ?? 120), 600);
      const launch = await runPowerShell(launcher, { timeoutSec });
      if (opts.signal?.aborted) return { ok: false, error: "task_cancelled", message: "The person cancelled the task." };
      if (launch.timedOut) return { ok: false, error: "timed_out", message: `The administrator run did not finish within ${timeoutSec}s.`, timedOut: true };
      if (/DECLINED/.test(launch.stdout || "") || launch.stderr) {
        return { ok: false, error: "declined_uac", message: "You didn't approve the Windows administrator prompt, so nothing ran." };
      }
      const stdout = await fsp.readFile(outFile, "utf8").catch(() => "");
      const codeRaw = (await fsp.readFile(codeFile, "utf8").catch(() => "1")).trim();
      const exitCode = codeRaw === "0" ? 0 : 1;
      return { ok: exitCode === 0, stdout: stdout.slice(0, 30_000).trimEnd(), exitCode };
    } catch (e) {
      return { ok: false, error: "elevation_failed", message: String((e as Error)?.message ?? e).slice(0, 200) };
    } finally {
      for (const f of [scriptFile, outFile, codeFile]) fsp.rm(f, { force: true }).catch(() => undefined);
    }
  };
}
