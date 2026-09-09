/**
 * The local Loopcom diagnostic — MEASUREMENTS, each with a status, each time-boxed.
 *
 * ⛔ NEVER NAME A ROOT CAUSE WITHOUT THE MEASUREMENTS THAT SUPPORT IT (the
 * 2026-08-26 lesson: an escalation blamed a router's SIP ALG from call durations
 * while a different extension was losing 37% of its packets). This module only
 * measures and labels each measurement ok / warn / fail / unknown. Interpretation
 * belongs to the model AND stays bounded by the numbers it is given. A section
 * that could not measure says `unknown` — never "fine".
 *
 * Every check is a FIXED query (PowerShell, Node dns/net/dgram, HTTPS GET). No
 * model-supplied command reaches this file.
 */
import os from "node:os";
import dns from "node:dns";
import dgram from "node:dgram";
import { promises as fsp } from "node:fs";
import { runPowerShell, type ShellDeps } from "./shell";
import { systemInfo } from "./windows";
import { redactText } from "../policyCore";

export type DiagStatus = "ok" | "warn" | "fail" | "unknown";
export type DiagSection = { section: string; status: DiagStatus; measuredAt: string; durationMs: number; evidence: Record<string, unknown>; note?: string };

export type DiagDeps = {
  portalUrl: string;
  appVersion: string;
  logFile: string;
  phoneState: () => Record<string, unknown> | null;
  linkState: () => Record<string, unknown>;
  shell?: ShellDeps;
  stunServers?: string[];
};

export const DIAG_SECTIONS = ["processes", "phone", "backend", "dns", "network", "latency", "stun", "vpn", "audio", "resources", "logs", "events"] as const;
const SECTION_TIMEOUT_MS: Record<string, number> = { latency: 40_000, events: 30_000, default: 20_000 };

function timeBox<T>(p: Promise<T>, ms: number): Promise<T | { timedOut: true }> {
  return Promise.race([p, new Promise<{ timedOut: true }>((r) => setTimeout(() => r({ timedOut: true }), ms))]);
}

export async function runDiagnostics(deps: DiagDeps, sections?: unknown): Promise<{ ok: true; measuredAt: string; hostname: string; appVersion: string; summary: Record<DiagStatus, number>; sections: DiagSection[] }> {
  const wanted = Array.isArray(sections) && sections.length ? (sections as unknown[]).filter((s): s is string => typeof s === "string" && (DIAG_SECTIONS as readonly string[]).includes(s)) : [...DIAG_SECTIONS];
  const results: DiagSection[] = [];
  const portalHost = safeHost(deps.portalUrl);
  type Partial = { status: string; evidence: Record<string, unknown>; note?: string };
  const collectors: Record<string, () => Promise<Partial>> = {
    processes: () => processesCheck(deps),
    phone: async () => phoneCheck(deps),
    backend: () => backendCheck(deps.portalUrl),
    dns: () => dnsCheck(portalHost),
    network: () => networkCheck(deps.shell),
    latency: () => latencyCheck(portalHost, deps.shell),
    stun: () => stunCheck(deps.stunServers ?? ["stun.l.google.com:19302", "stun1.l.google.com:19302"]),
    vpn: () => vpnProxyCheck(deps.shell),
    audio: () => audioCheck(deps.shell),
    resources: () => resourcesCheck(deps.shell),
    logs: () => logsCheck(deps.logFile),
    events: () => eventsCheck(deps.shell),
  };
  // Run in parallel but with a bounded fan-out: PowerShell-heavy checks in twos.
  await Promise.all(wanted.map(async (section) => {
    const startedAt = Date.now();
    const timeout = SECTION_TIMEOUT_MS[section] ?? SECTION_TIMEOUT_MS.default;
    let out: Partial;
    try {
      const r = await timeBox(collectors[section](), timeout);
      out = "timedOut" in (r as object) && (r as { timedOut?: boolean }).timedOut ? { status: "unknown", evidence: {}, note: `did not finish within ${timeout / 1000}s` } : (r as Partial);
    } catch (e: any) {
      out = { status: "unknown", evidence: {}, note: `check failed: ${String(e?.message ?? e).slice(0, 200)}` };
    }
    const status: DiagStatus = out.status === "ok" || out.status === "warn" || out.status === "fail" ? out.status : "unknown";
    results.push({ section, measuredAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt, status, evidence: out.evidence, ...(out.note ? { note: out.note } : {}) });
  }));
  results.sort((a, b) => wanted.indexOf(a.section) - wanted.indexOf(b.section));
  const summary: Record<DiagStatus, number> = { ok: 0, warn: 0, fail: 0, unknown: 0 };
  for (const r of results) summary[r.status]++;
  return { ok: true, measuredAt: new Date().toISOString(), hostname: os.hostname(), appVersion: deps.appVersion, summary, sections: results };
}

function safeHost(url: string): string { try { return new URL(url).hostname; } catch { return "app.connectcomunications.com"; } }
function parseJson<T>(t: string): T | null { try { return JSON.parse(t) as T; } catch { return null; } }
function asArray<T>(v: T | T[] | null): T[] { return v == null ? [] : Array.isArray(v) ? v : [v]; }

async function processesCheck(deps: DiagDeps) {
  const run = await runPowerShell(`@(Get-Process -Name Loopcom -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ pid=$_.Id; workingSetBytes=[int64]$_.WorkingSet64; cpuSeconds=$(if($_.CPU){[math]::Round($_.CPU,1)}else{$null}); startTime=$(if($_.StartTime){$_.StartTime.ToString("o")}else{$null}) } }) | ConvertTo-Json -Compress`, { timeoutSec: 15, deps: deps.shell });
  const list = run.ok ? asArray<any>(parseJson<any>(run.stdout)) : null;
  if (!list) return { status: "unknown" as DiagStatus, evidence: { stderr: run.stderr.slice(0, 200) }, note: "could not list processes" };
  const total = list.reduce((a, p) => a + (p.workingSetBytes || 0), 0);
  return { status: list.length ? "ok" : "fail", evidence: { thisPid: process.pid, loopcomProcesses: list.length, totalWorkingSetBytes: total, processes: list, appVersion: deps.appVersion }, note: list.length ? undefined : "no Loopcom.exe process found (the app running this check may be a dev build)" };
}

function phoneCheck(deps: DiagDeps) {
  const s = deps.phoneState();
  if (!s) return { status: "unknown" as DiagStatus, evidence: { link: deps.linkState() }, note: "the phone engine has not reported a state yet (no extension signed in, or the main window is not loaded)" };
  const reg = String(s.registrationState ?? s.registered ?? s.status ?? "").toLowerCase();
  const registered = reg === "registered" || reg === "true" || reg === "connected";
  const evidence: Record<string, unknown> = { link: deps.linkState() };
  for (const k of ["registrationState", "registered", "status", "callState", "extension", "ringingSessionIds", "lastError", "wsState", "transport"]) if (k in s) evidence[k] = s[k];
  return { status: registered ? "ok" : reg ? "warn" : "unknown", evidence, note: registered ? undefined : reg ? `phone reports "${reg}"` : "registration state not present in the phone snapshot" };
}

async function httpProbe(url: string, timeoutMs = 8000) {
  const t0 = Date.now();
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctl.signal, redirect: "manual" });
    clearTimeout(timer);
    return { url, status: res.status, ms: Date.now() - t0, ok: res.status >= 200 && res.status < 400 };
  } catch (e: any) {
    return { url, status: null, ms: Date.now() - t0, ok: false, error: String(e?.cause?.code ?? e?.name ?? e?.message ?? e).slice(0, 120) };
  }
}

async function backendCheck(portalUrl: string) {
  const base = portalUrl.replace(/\/$/, "");
  const probes = await Promise.all([httpProbe(`${base}/api/health`), httpProbe(`${base}/agent-api/health`), httpProbe(`${base}/login`)]);
  const okCount = probes.filter((p) => p.ok).length;
  return { status: okCount === probes.length ? "ok" : okCount ? "warn" : "fail", evidence: { probes }, note: okCount === probes.length ? undefined : "one or more Loopcom endpoints did not answer 2xx/3xx" };
}

async function dnsCheck(host: string) {
  const t0 = Date.now();
  try {
    const addrs = await dns.promises.resolve4(host);
    const servers = dns.getServers();
    return { status: addrs.length ? "ok" : "fail", evidence: { host, addresses: addrs, ms: Date.now() - t0, resolvers: servers } };
  } catch (e: any) {
    return { status: "fail" as DiagStatus, evidence: { host, ms: Date.now() - t0, error: String(e?.code ?? e?.message).slice(0, 120), resolvers: dns.getServers() }, note: "DNS lookup of the Loopcom host failed" };
  }
}

async function networkCheck(shell?: ShellDeps) {
  const run = await runPowerShell(`
$cfg = Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.NetAdapter.Status -eq 'Up' } | ForEach-Object { [pscustomobject]@{ name=$_.InterfaceAlias; description=$_.InterfaceDescription; ipv4=@($_.IPv4Address | ForEach-Object { $_.IPAddress }); gateway=$(if($_.IPv4DefaultGateway){$_.IPv4DefaultGateway.NextHop}else{$null}); dns=@($_.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses } | ForEach-Object { $_ }) } }
$adapters = Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name=$_.Name; status=$_.Status; linkSpeed=$_.LinkSpeed; mediaType=$_.MediaType; description=$_.InterfaceDescription } }
[pscustomobject]@{ up=@($cfg); adapters=@($adapters) } | ConvertTo-Json -Depth 5 -Compress`, { timeoutSec: 18, deps: shell });
  const parsed = run.ok ? parseJson<any>(run.stdout) : null;
  if (!parsed) return { status: "unknown" as DiagStatus, evidence: { stderr: run.stderr.slice(0, 200) }, note: "could not read the network configuration" };
  const up = asArray<any>(parsed.up);
  const withGateway = up.filter((i) => i.gateway);
  return { status: withGateway.length ? "ok" : "fail", evidence: { interfacesUp: up, adapters: asArray<any>(parsed.adapters), defaultGateway: withGateway[0]?.gateway ?? null }, note: withGateway.length ? undefined : "no interface with a default gateway" };
}

async function latencyCheck(host: string, shell?: ShellDeps) {
  const run = await runPowerShell(`
$gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop
function Probe($target) {
  if (-not $target) { return $null }
  $r = Test-Connection -ComputerName $target -Count 6 -ErrorAction SilentlyContinue
  $times = @($r | ForEach-Object { if ($null -ne $_.Latency) { $_.Latency } elseif ($null -ne $_.ResponseTime) { $_.ResponseTime } })
  [pscustomobject]@{ target=$target; sent=6; received=$times.Count; times=$times }
}
[pscustomobject]@{ gateway=(Probe $gw); loopcom=(Probe '${host}') } | ConvertTo-Json -Depth 4 -Compress`, { timeoutSec: 38, deps: shell });
  const parsed = run.ok ? parseJson<any>(run.stdout) : null;
  if (!parsed) return { status: "unknown" as DiagStatus, evidence: { stderr: run.stderr.slice(0, 200) }, note: "ping could not run" };
  const stats = (p: any) => {
    if (!p) return null;
    const t: number[] = asArray<number>(p.times).map(Number).filter((n) => Number.isFinite(n));
    const loss = p.sent ? Math.round(((p.sent - t.length) / p.sent) * 100) : null;
    const avg = t.length ? t.reduce((a, b) => a + b, 0) / t.length : null;
    let jitter: number | null = null;
    if (t.length > 1) { let d = 0; for (let i = 1; i < t.length; i++) d += Math.abs(t[i] - t[i - 1]); jitter = d / (t.length - 1); }
    return { target: p.target, sent: p.sent, received: t.length, lossPercent: loss, minMs: t.length ? Math.min(...t) : null, avgMs: avg === null ? null : Math.round(avg * 10) / 10, maxMs: t.length ? Math.max(...t) : null, jitterMs: jitter === null ? null : Math.round(jitter * 10) / 10 };
  };
  const gw = stats(parsed.gateway); const lc = stats(parsed.loopcom);
  const worst = [gw, lc].filter(Boolean) as NonNullable<ReturnType<typeof stats>>[];
  let status: DiagStatus = "ok";
  if (!worst.length) status = "unknown";
  else if (worst.some((w) => (w.lossPercent ?? 100) >= 50)) status = "fail";
  else if (worst.some((w) => (w.lossPercent ?? 0) > 0 || (w.avgMs ?? 0) > 150 || (w.jitterMs ?? 0) > 30)) status = "warn";
  return { status, evidence: { gateway: gw, loopcom: lc }, note: status === "ok" ? undefined : "packet loss, latency above 150 ms or jitter above 30 ms was measured — see evidence" };
}

/** A STUN Binding request; the reply's XOR-MAPPED-ADDRESS is our public address. */
function stunBinding(server: string, timeoutMs = 4000): Promise<{ server: string; ok: boolean; ms: number; mapped?: string; error?: string }> {
  return new Promise((resolve) => {
    const [host, portStr] = server.split(":"); const port = Number(portStr) || 3478;
    const sock = dgram.createSocket("udp4"); const t0 = Date.now();
    const txid = Buffer.from(Array.from({ length: 12 }, () => Math.floor(Math.random() * 256)));
    const msg = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), txid]);
    const done = (r: { ok: boolean; mapped?: string; error?: string }) => { try { sock.close(); } catch { /* closed */ } resolve({ server, ms: Date.now() - t0, ...r }); };
    const timer = setTimeout(() => done({ ok: false, error: "timeout" }), timeoutMs);
    sock.on("error", (e) => { clearTimeout(timer); done({ ok: false, error: String(e.message).slice(0, 80) }); });
    sock.on("message", (buf) => {
      clearTimeout(timer);
      if (buf.length < 20 || buf.readUInt16BE(0) !== 0x0101) return done({ ok: false, error: "unexpected_reply" });
      let i = 20; let mapped: string | undefined;
      while (i + 4 <= buf.length) {
        const type = buf.readUInt16BE(i); const len = buf.readUInt16BE(i + 2);
        if (type === 0x0020 && len >= 8) { const p = buf.readUInt16BE(i + 6) ^ 0x2112; const ip = [buf[i + 8] ^ 0x21, buf[i + 9] ^ 0x12, buf[i + 10] ^ 0xa4, buf[i + 11] ^ 0x42].join("."); mapped = `${ip}:${p}`; break; }
        if (type === 0x0001 && len >= 8 && !mapped) { const p = buf.readUInt16BE(i + 6); const ip = [buf[i + 8], buf[i + 9], buf[i + 10], buf[i + 11]].join("."); mapped = `${ip}:${p}`; }
        i += 4 + len + ((4 - (len % 4)) % 4);
      }
      done({ ok: true, mapped });
    });
    dns.promises.lookup(host).then(({ address }) => sock.send(msg, port, address)).catch((e) => { clearTimeout(timer); done({ ok: false, error: `dns:${String(e?.code ?? e).slice(0, 60)}` }); });
  });
}

async function stunCheck(servers: string[]) {
  const results = await Promise.all(servers.map((s) => stunBinding(s)));
  const ok = results.filter((r) => r.ok);
  return { status: ok.length ? "ok" : "fail", evidence: { results, publicAddress: ok[0]?.mapped ?? null }, note: ok.length ? undefined : "no STUN server answered over UDP — NAT traversal for calls may fail" };
}

async function vpnProxyCheck(shell?: ShellDeps) {
  const run = await runPowerShell(`
$vpnAdapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and ($_.InterfaceDescription -match 'VPN|TAP|TUN|WireGuard|Fortinet|Cisco AnyConnect|GlobalProtect|OpenVPN|ZeroTier|Tailscale|Hamachi' -or $_.Name -match 'VPN|WireGuard|Tailscale') } | ForEach-Object { $_.Name + ' (' + $_.InterfaceDescription + ')' })
$vpnConns = @(Get-VpnConnection -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name=$_.Name; status=$_.ConnectionStatus } })
$reg = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue
[pscustomobject]@{ vpnAdapters=$vpnAdapters; vpnConnections=$vpnConns; proxyEnable=[int]$reg.ProxyEnable; proxyServer=$reg.ProxyServer; autoConfigUrl=$reg.AutoConfigURL } | ConvertTo-Json -Depth 3 -Compress`, { timeoutSec: 18, deps: shell });
  const parsed = run.ok ? parseJson<any>(run.stdout) : null;
  const envProxy = Object.keys(process.env).filter((k) => /^(https?|all)_proxy$/i.test(k));
  if (!parsed) return { status: "unknown" as DiagStatus, evidence: { envProxyVars: envProxy }, note: "could not read adapters/proxy settings" };
  const vpnUp = asArray<any>(parsed.vpnAdapters).length > 0 || asArray<any>(parsed.vpnConnections).some((c) => String(c.status).toLowerCase() === "connected");
  const proxy = parsed.proxyEnable === 1 || !!parsed.autoConfigUrl || envProxy.length > 0;
  return { status: vpnUp || proxy ? "warn" : "ok", evidence: { vpnAdaptersUp: asArray<any>(parsed.vpnAdapters), vpnConnections: asArray<any>(parsed.vpnConnections), proxyEnabled: parsed.proxyEnable === 1, proxyServer: parsed.proxyServer ?? null, autoConfigUrl: parsed.autoConfigUrl ?? null, envProxyVars: envProxy }, note: vpnUp ? "a VPN adapter/connection is active — VPNs commonly interfere with call audio" : proxy ? "a system proxy is configured" : undefined };
}

async function audioCheck(shell?: ShellDeps) {
  const run = await runPowerShell(`
$eps = @(Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'OK' } | ForEach-Object { $_.FriendlyName })
$devs = @(Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name=$_.Name; status=$_.Status } })
[pscustomobject]@{ endpoints=$eps; devices=$devs } | ConvertTo-Json -Depth 3 -Compress`, { timeoutSec: 18, deps: shell });
  const parsed = run.ok ? parseJson<any>(run.stdout) : null;
  if (!parsed) return { status: "unknown" as DiagStatus, evidence: { stderr: run.stderr.slice(0, 200) }, note: "could not enumerate audio devices" };
  const endpoints = asArray<string>(parsed.endpoints);
  const mics = endpoints.filter((e) => /microphone|mic|headset|line in|input|capture/i.test(e));
  const outs = endpoints.filter((e) => /speaker|headphone|headset|output|monitor|display audio|digital/i.test(e) && !/microphone/i.test(e));
  return { status: endpoints.length === 0 ? "fail" : mics.length && outs.length ? "ok" : "warn", evidence: { endpoints, likelyMicrophones: mics, likelyOutputs: outs, soundDevices: asArray<any>(parsed.devices) }, note: endpoints.length === 0 ? "no active audio endpoint" : !mics.length ? "no endpoint looks like a microphone" : !outs.length ? "no endpoint looks like a speaker/headset" : undefined };
}

async function resourcesCheck(shell?: ShellDeps) {
  const s = await systemInfo(shell);
  const disks = (s.disks ?? []) as { drive: string; freePercent: number | null; freeBytes: number }[];
  const lowDisk = disks.filter((d) => d.freePercent !== null && d.freePercent < 10);
  const memHigh = s.memory.usedPercent >= 90;
  const cpuHigh = typeof (s as any).cpuLoadPercent === "number" && (s as any).cpuLoadPercent >= 90;
  return { status: lowDisk.length || memHigh || cpuHigh ? "warn" : "ok", evidence: { cpuCount: s.cpuCount, cpuLoadPercent: (s as any).cpuLoadPercent ?? null, memory: s.memory, disks, uptime: s.uptimeHuman, windows: (s as any).windows ?? null }, note: lowDisk.length ? `low disk space on ${lowDisk.map((d) => d.drive).join(", ")}` : memHigh ? "memory use above 90%" : cpuHigh ? "CPU load above 90%" : undefined };
}

async function logsCheck(logFile: string) {
  try {
    const st = await fsp.stat(logFile);
    const text = await fsp.readFile(logFile, "utf8");
    const lines = text.split("\n");
    const tail = lines.slice(-3000);
    const errors = tail.filter((l) => /\b(error|failed|render-process-gone|unresponsive|init-failed)\b/i.test(l));
    const last = errors.slice(-8).map((l) => redactText(l.slice(0, 240)).text);
    return { status: errors.length > 50 ? "warn" : "ok", evidence: { file: logFile, sizeBytes: st.size, linesScanned: tail.length, errorLikeLines: errors.length, lastErrorLines: last }, note: errors.length > 50 ? "many error-like lines in the recent app log" : undefined };
  } catch (e: any) {
    return { status: "unknown" as DiagStatus, evidence: { file: logFile, error: String(e?.code ?? e).slice(0, 60) }, note: "app log not readable" };
  }
}

async function eventsCheck(shell?: ShellDeps) {
  const run = await runPowerShell(`
$ev = @(Get-WinEvent -FilterHashtable @{ LogName='System'; Level=1,2; StartTime=(Get-Date).AddHours(-24) } -MaxEvents 15 -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ time=$_.TimeCreated.ToString('o'); provider=$_.ProviderName; id=$_.Id; level=$_.LevelDisplayName; message=$(if($_.Message){ $_.Message.Substring(0,[math]::Min(200,$_.Message.Length)) }else{''}) } })
$ev | ConvertTo-Json -Depth 3 -Compress`, { timeoutSec: 28, deps: shell });
  if (!run.ok) return { status: "unknown" as DiagStatus, evidence: { stderr: run.stderr.slice(0, 200) }, note: "could not read the Windows System event log" };
  const list = asArray<any>(parseJson<any>(run.stdout || "[]")).map((e) => ({ ...e, message: redactText(String(e.message ?? "")).text }));
  return { status: list.length >= 10 ? "warn" : "ok", evidence: { last24hCriticalOrError: list.length, events: list }, note: list.length >= 10 ? "10 or more critical/error system events in the last 24 hours" : undefined };
}
