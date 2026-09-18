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

/* ───────────────────────── services (Phase 10) ───────────────────────── */

const SERVICE_NAME_RE = /^[A-Za-z0-9_.\- ]{1,120}$/;

export async function services(args: { name?: unknown; status?: unknown; limit?: unknown }, deps?: ShellDeps) {
  const name = typeof args.name === "string" && SERVICE_NAME_RE.test(args.name.trim()) ? args.name.trim() : "";
  const status = args.status === "running" || args.status === "stopped" ? args.status : "all";
  const limit = Math.min(Math.max(1, Number(args.limit) || 50), 300);
  const esc = (v: string) => v.replace(/'/g, "''");
  const ps = `
$svc = Get-Service ${name ? `| Where-Object { $_.Name -like '*${esc(name)}*' -or $_.DisplayName -like '*${esc(name)}*' }` : ""} ${status !== "all" ? `| Where-Object { $_.Status -eq '${status === "running" ? "Running" : "Stopped"}' }` : ""} | Sort-Object Name | Select-Object -First ${limit}
@($svc | ForEach-Object { [pscustomobject]@{ name=$_.Name; displayName=$_.DisplayName; status=$_.Status.ToString(); startType=$(try { $_.StartType.ToString() } catch { $null }); canStop=$_.CanStop } }) | ConvertTo-Json -Depth 3 -Compress`;
  const run = await runPowerShell(ps, { timeoutSec: 25, deps });
  const parsed = run.ok ? asArray<any>(parseJson<any>(run.stdout)) : null;
  if (!parsed) return { ok: false, error: "service_list_failed", message: run.stderr.slice(0, 300) || "PowerShell returned nothing." };
  return { ok: true, measuredAt: new Date().toISOString(), filter: name || null, status, count: parsed.length, services: parsed };
}

/** start/stop/restart as the signed-in user (many services need admin — the error says so). */
export async function serviceControl(name: string, action: "start" | "stop" | "restart", deps?: ShellDeps) {
  if (!SERVICE_NAME_RE.test(name)) return { ok: false, error: "bad_service_name", message: "That is not a valid service name." };
  const verb = action === "restart" ? "Restart-Service" : action === "start" ? "Start-Service" : "Stop-Service";
  const n = name.replace(/'/g, "''");
  const ps = `
try {
  $before = (Get-Service -Name '${n}' -ErrorAction Stop).Status.ToString()
  ${verb} -Name '${n}' -ErrorAction Stop
  Start-Sleep -Milliseconds 800
  $s = Get-Service -Name '${n}'
  [pscustomobject]@{ ok=$true; name=$s.Name; displayName=$s.DisplayName; before=$before; status=$s.Status.ToString() } | ConvertTo-Json -Compress
} catch {
  $m = $_.Exception.Message
  $denied = ($m -match 'denied|Access is denied|Cannot open|not permitted')
  [pscustomobject]@{ ok=$false; error=$(if ($denied) { 'needs_admin' } else { 'service_control_failed' }); message=$m } | ConvertTo-Json -Compress
}`;
  const run = await runPowerShell(ps, { timeoutSec: 60, deps });
  const parsed = parseJson<any>(run.stdout);
  if (!parsed) return { ok: false, error: "service_control_failed", message: run.stderr.slice(0, 300) || "PowerShell returned nothing." };
  if (parsed.ok !== true && parsed.error === "needs_admin") return { ...parsed, action, message: `${parsed.message} — Windows requires administrator rights for this service. Retry with elevated:true (the person will see the Windows prompt).` };
  return { ...parsed, action, verified: parsed.ok === true && (action === "stop" ? parsed.status === "Stopped" : parsed.status === "Running") };
}

/* ───────────────────────── networking (Phase 12) ───────────────────────── */

export async function networkInfo(deps?: ShellDeps) {
  const ps = `
$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object {
  $a = $_
  $ips = @(Get-NetIPAddress -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress })
  [pscustomobject]@{ name=$a.Name; description=$a.InterfaceDescription; status=$a.Status.ToString(); mac=$a.MacAddress; linkSpeed=$a.LinkSpeed; ips=$ips; virtual=[bool]$a.Virtual; ifIndex=$a.ifIndex }
})
$routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | ForEach-Object { [pscustomobject]@{ gateway=$_.NextHop; ifIndex=$_.ifIndex; metric=$_.RouteMetric } })
$dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses } | ForEach-Object { [pscustomobject]@{ ifIndex=$_.InterfaceIndex; servers=@($_.ServerAddresses) } })
$proxy = try { $p = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction Stop; [pscustomobject]@{ enabled=[bool]$p.ProxyEnable; server=$p.ProxyServer; autoConfig=$p.AutoConfigURL } } catch { $null }
$vpn = @($adapters | Where-Object { $_.status -eq 'Up' -and ($_.description -match 'VPN|WireGuard|Tap-Windows|TAP|OpenVPN|Cisco AnyConnect|Fortinet|GlobalProtect|Tailscale|ZeroTier|Wintun|PANGP|NordLynx|Proton') } | ForEach-Object { $_.name })
$conn = try { @(Get-NetConnectionProfile -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ name=$_.Name; category=$_.NetworkCategory.ToString(); ipv4=$_.IPv4Connectivity.ToString(); ipv6=$_.IPv6Connectivity.ToString() } }) } catch { @() }
[pscustomobject]@{ adapters=$adapters; defaultRoutes=$routes; dns=$dns; proxy=$proxy; vpnAdaptersUp=$vpn; connectionProfiles=@($conn) } | ConvertTo-Json -Depth 5 -Compress`;
  const run = await runPowerShell(ps, { timeoutSec: 35, deps });
  const parsed = run.ok ? parseJson<any>(run.stdout) : null;
  if (!parsed) return { ok: false, error: "network_info_failed", message: run.stderr.slice(0, 300) || "PowerShell returned nothing." };
  return { ok: true, measuredAt: new Date().toISOString(), hostname: os.hostname(), ...parsed, adapters: asArray<any>(parsed.adapters), defaultRoutes: asArray<any>(parsed.defaultRoutes), dns: asArray<any>(parsed.dns), vpnAdaptersUp: asArray<any>(parsed.vpnAdaptersUp), connectionProfiles: asArray<any>(parsed.connectionProfiles) };
}

export async function networkTest(args: { host?: unknown; port?: unknown; count?: unknown }, deps?: ShellDeps) {
  const host = typeof args.host === "string" ? args.host.trim() : "";
  if (!/^[A-Za-z0-9.\-:]{1,253}$/.test(host)) return { ok: false, error: "bad_host", message: "host must be a hostname or IP address." };
  const port = args.port === 0 ? 0 : Math.min(Math.max(0, Number(args.port) || 443), 65535);
  const count = Math.min(Math.max(1, Number(args.count) || 4), 10);
  const ps = `
$target = '${host.replace(/'/g, "''")}'
$dns = try { @((Resolve-DnsName -Name $target -ErrorAction Stop -DnsOnly | Where-Object { $_.Type -in 'A','AAAA' } | ForEach-Object { $_.IPAddress })) } catch { @() }
$tcp = $null
if (${port} -gt 0) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $client = New-Object System.Net.Sockets.TcpClient
  try { $ar = $client.BeginConnect($target, ${port}, $null, $null); $okc = $ar.AsyncWaitHandle.WaitOne(4000); if ($okc) { $client.EndConnect($ar) }; $tcp = [pscustomobject]@{ port=${port}; connected=[bool]($okc -and $client.Connected); ms=[int]$sw.ElapsedMilliseconds } } catch { $tcp = [pscustomobject]@{ port=${port}; connected=$false; ms=[int]$sw.ElapsedMilliseconds; error=$_.Exception.Message } } finally { $client.Close() }
}
$ping = New-Object System.Net.NetworkInformation.Ping
$times = @(); $lost = 0
for ($i = 0; $i -lt ${count}; $i++) { try { $r = $ping.Send($target, 2000); if ($r.Status -eq 'Success') { $times += [int]$r.RoundtripTime } else { $lost++ } } catch { $lost++ } }
$avg = if ($times.Count) { [math]::Round(($times | Measure-Object -Average).Average, 1) } else { $null }
$jit = if ($times.Count -gt 1) { $d = @(); for ($j = 1; $j -lt $times.Count; $j++) { $d += [math]::Abs($times[$j] - $times[$j-1]) }; [math]::Round(($d | Measure-Object -Average).Average, 1) } else { $null }
[pscustomobject]@{ host=$target; resolved=$dns; tcp=$tcp; ping=[pscustomobject]@{ sent=${count}; lost=$lost; lossPercent=[math]::Round($lost*100/${count}); avgMs=$avg; minMs=$(if ($times.Count) { ($times | Measure-Object -Minimum).Minimum } else { $null }); maxMs=$(if ($times.Count) { ($times | Measure-Object -Maximum).Maximum } else { $null }); jitterMs=$jit } } | ConvertTo-Json -Depth 4 -Compress`;
  const run = await runPowerShell(ps, { timeoutSec: 50, deps });
  const parsed = run.ok ? parseJson<any>(run.stdout) : null;
  if (!parsed) return { ok: false, error: "network_test_failed", message: run.stderr.slice(0, 300) || "PowerShell returned nothing." };
  return { ok: true, measuredAt: new Date().toISOString(), ...parsed, resolved: asArray<any>(parsed.resolved).filter((x) => typeof x === "string") };
}
