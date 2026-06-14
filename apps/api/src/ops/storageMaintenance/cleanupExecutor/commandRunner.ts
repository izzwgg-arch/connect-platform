import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateCleanupCommand } from "../protectionRules";
import { APK_HOST_DOWNLOADS } from "./executionPaths";

const execFileAsync = promisify(execFile);

export type CommandRunResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

async function run(command: string, args: string[], timeoutMs: number): Promise<CommandRunResult> {
  const started = Date.now();
  const full = [command, ...args].join(" ");
  const check = validateCleanupCommand(full);
  if (!check.ok) throw new Error(check.reason);

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      command: full,
      exitCode: 0,
      stdout: String(stdout),
      stderr: String(stderr),
      durationMs: Date.now() - started,
    };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      command: full,
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? String(err)),
      durationMs: Date.now() - started,
    };
  }
}

export async function dockerImageRm(imageRef: string): Promise<CommandRunResult> {
  if (!/^[\w./:@-]+$/.test(imageRef)) throw new Error("invalid_image_ref");
  return run("docker", ["image", "rm", imageRef], 120_000);
}

export async function dockerBuilderPruneUnusedOnly(retentionDays: number): Promise<CommandRunResult> {
  const hours = Math.max(24, Math.round(retentionDays * 24));
  const filter = `unused-for=${hours}h`;
  const dry = await run("docker", ["builder", "prune", "--filter", filter, "--dry-run"], 300_000);
  if (dry.exitCode !== 0) return dry;
  return run("docker", ["builder", "prune", "--filter", filter, "--force"], 600_000);
}

export async function dockerBuilderPruneDryRun(retentionDays: number): Promise<CommandRunResult> {
  const hours = Math.max(24, Math.round(retentionDays * 24));
  return run("docker", ["builder", "prune", "--filter", `unused-for=${hours}h`, "--dry-run"], 300_000);
}

export async function removeApkViaHostBind(hostApkPath: string): Promise<CommandRunResult> {
  if (!hostApkPath.startsWith(`${APK_HOST_DOWNLOADS}/`)) throw new Error("apk_path_outside_downloads");
  const base = hostApkPath.slice(`${APK_HOST_DOWNLOADS}/`.length);
  if (!base || base.includes("..") || base.includes("/")) throw new Error("invalid_apk_basename");

  const started = Date.now();
  const inner = `rm -f /dl/${base}`;
  const args = [
    "run",
    "--rm",
    "-v",
    `${APK_HOST_DOWNLOADS}:/dl:rw`,
    "alpine:3.20",
    "sh",
    "-c",
    inner,
  ];
  const check = validateCleanupCommand(inner);
  if (!check.ok) throw new Error(check.reason);

  try {
    const { stdout, stderr } = await execFileAsync("docker", args, { timeout: 60_000, maxBuffer: 1024 * 1024 });
    return {
      command: `docker ${args.join(" ")}`,
      exitCode: 0,
      stdout: String(stdout),
      stderr: String(stderr),
      durationMs: Date.now() - started,
    };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      command: `docker ${args.join(" ")}`,
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? String(err)),
      durationMs: Date.now() - started,
    };
  }
}

export async function journalVacuumTo1G(): Promise<CommandRunResult> {
  const started = Date.now();
  const inner = "journalctl --vacuum-size=1G";
  const args = [
    "run",
    "--rm",
    "--privileged",
    "--pid=host",
    "-v",
    "/:/host",
    "debian:bookworm-slim",
    "chroot",
    "/host",
    "journalctl",
    "--vacuum-size=1G",
  ];
  const check = validateCleanupCommand(inner);
  if (!check.ok) throw new Error(check.reason);

  try {
    const { stdout, stderr } = await execFileAsync("docker", args, { timeout: 300_000, maxBuffer: 2 * 1024 * 1024 });
    return {
      command: `docker ${args.join(" ")}`,
      exitCode: 0,
      stdout: String(stdout),
      stderr: String(stderr),
      durationMs: Date.now() - started,
    };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      command: `docker ${args.join(" ")}`,
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? String(err)),
      durationMs: Date.now() - started,
    };
  }
}

export async function journalDiskUsage(): Promise<CommandRunResult> {
  const started = Date.now();
  const args = [
    "run",
    "--rm",
    "--privileged",
    "--pid=host",
    "-v",
    "/:/host",
    "debian:bookworm-slim",
    "chroot",
    "/host",
    "journalctl",
    "--disk-usage",
  ];
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
    return {
      command: `docker ${args.join(" ")}`,
      exitCode: 0,
      stdout: String(stdout),
      stderr: String(stderr),
      durationMs: Date.now() - started,
    };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      command: `docker ${args.join(" ")}`,
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? String(err)),
      durationMs: Date.now() - started,
    };
  }
}

export async function verifyBuildDryRun(service: string): Promise<CommandRunResult> {
  const allowed = ["api", "portal", "worker", "telephony"];
  if (!allowed.includes(service)) throw new Error("invalid_build_service");
  const started = Date.now();
  const args = [
    "compose",
    "-f",
    "/host-inventory/opt/connectcomms/docker-compose.app.yml",
    "build",
    service,
    "--dry-run",
  ];
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return {
      command: `docker ${args.join(" ")}`,
      exitCode: 0,
      stdout: String(stdout),
      stderr: String(stderr),
      durationMs: Date.now() - started,
    };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      command: `docker ${args.join(" ")}`,
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? String(err)),
      durationMs: Date.now() - started,
    };
  }
}
