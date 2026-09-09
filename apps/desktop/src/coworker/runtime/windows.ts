/**
 * Windows facts: version, uptime, CPU, memory, disks, processes. Named checks
 * only — each one runs a FIXED PowerShell query (never a model-supplied one) and
 * parses its JSON. Declared under the `diagnostics` domain because that is what
 * they are: measurements, changing nothing.
 */
import os from "node:os";
import { runPowerShell, type ShellDeps } from "./shell";

function parseJson<T>(text: string): T | null {
  try { return JSON.parse(text) as T; } catch { return null; }
}

/** PowerShell's ConvertTo-Json emits a bare object for one item, an array for many. */
function asArray<T>(v: T | T[] | null): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export async function systemInfo(deps?: ShellDeps) {
  const ps = `
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { [pscustomobject]@{ drive=$_.DeviceID; freeBytes=[int64]$_.FreeSpace; totalBytes=[int64]$_.Size; label=$_.VolumeName } }
$cpuLoad = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
[pscustomobject]@{
  caption=$os.Caption; version=$os.Version; build=$os.BuildNumber; lastBoot=$os.LastBootUpTime.ToString("o");
  totalMemBytes=[int64]$cs.TotalPhysicalMemory; freeMemBytes=[int64]$os.FreePhysicalMemory*1024;
  cpuLoadPercent=$cpuLoad; manufacturer=$cs.Manufacturer; model=$cs.Model; disks=@($disks)
} | ConvertTo-Json -Depth 4 -Compress`;
  const run = await runPowerShell(ps, { timeoutSec: 25, deps });
  const parsed = run.ok ? parseJson<any>(run.stdout) : null;
  const uptimeSec = os.uptime();
  const base = {
    ok: true,
    measuredAt: new Date().toISOString(),
    hostname: os.hostname(),
    username: os.userInfo().username,
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuCount: os.cpus().length,
    uptimeSeconds: Math.round(uptimeSec),
    uptimeHuman: humanDuration(uptimeSec),
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem(), usedBytes: os.totalmem() - os.freemem(), usedPercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100), totalHuman: humanBytes(os.totalmem()), usedHuman: humanBytes(os.totalmem() - os.freemem()), freeHuman: humanBytes(os.freemem()) },
    note: "Human sizes are 1024-based, the way Windows Task Manager and Explorer show them (24.0 GB here = 25.8 GB decimal). Quote the *Human fields for the person.",
  };
  if (!parsed) return { ...base, windows: null, disks: [], note: `PowerShell detail unavailable: ${run.stderr.slice(0, 200) || "no output"}` };
  return {
    ...base,
    windows: { edition: parsed.caption, version: parsed.version, build: parsed.build, lastBoot: parsed.lastBoot, manufacturer: parsed.manufacturer, model: parsed.model },
    cpuLoadPercent: typeof parsed.cpuLoadPercent === "number" ? parsed.cpuLoadPercent : null,
    memory: { ...base.memory, totalBytes: parsed.totalMemBytes || base.memory.totalBytes, freeBytes: parsed.freeMemBytes || base.memory.freeBytes },
    disks: asArray<any>(parsed.disks).map((d) => ({ drive: d.drive, label: d.label ?? "", freeBytes: d.freeBytes, totalBytes: d.totalBytes, freePercent: d.totalBytes ? Math.round((d.freeBytes / d.totalBytes) * 100) : null, freeHuman: humanBytes(d.freeBytes), totalHuman: humanBytes(d.totalBytes) })),
  };
}

export async function processes(args: { sortBy?: unknown; limit?: unknown; nameFilter?: unknown }, deps?: ShellDeps) {
  const sortBy = args.sortBy === "cpu" ? "cpu" : "memory";
  const limit = Math.min(Math.max(1, Number(args.limit) || 10), 200);
  const filter = typeof args.nameFilter === "string" ? args.nameFilter.replace(/[^\w .\-]/g, "").slice(0, 60) : "";
  const sortExpr = sortBy === "cpu" ? "CPU" : "WorkingSet64";
  const ps = `
$list = Get-Process ${filter ? `| Where-Object { $_.ProcessName -like '*${filter.replace(/'/g, "''")}*' }` : ""} | Sort-Object -Property ${sortExpr} -Descending | Select-Object -First ${limit} ProcessName, Id, WorkingSet64, CPU, StartTime
@($list | ForEach-Object { [pscustomobject]@{ name=$_.ProcessName; pid=$_.Id; workingSetBytes=[int64]$_.WorkingSet64; cpuSeconds=$(if ($_.CPU) { [math]::Round($_.CPU,1) } else { $null }); startTime=$(if ($_.StartTime) { $_.StartTime.ToString("o") } else { $null }) } }) | ConvertTo-Json -Depth 3 -Compress`;
  const run = await runPowerShell(ps, { timeoutSec: 25, deps });
  const parsed = run.ok ? asArray<any>(parseJson<any>(run.stdout)) : null;
  if (!parsed) return { ok: false, error: "process_list_failed", message: run.stderr.slice(0, 300) || "PowerShell returned nothing." };
  return {
    ok: true, measuredAt: new Date().toISOString(), sortBy, filter: filter || null, count: parsed.length,
    processes: parsed.map((p) => ({ ...p, workingSetHuman: humanBytes(p.workingSetBytes) })),
  };
}

export function humanBytes(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "unknown";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function humanDuration(sec: number): string {
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d} day${d === 1 ? "" : "s"}`);
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  return parts.join(", ");
}
