import type { StorageMaintenanceConfig } from "./types";

/** Prefixes that must never appear in a cleanup target or command. */
export const PROTECTED_PATH_PREFIXES = [
  "/opt/connectcomms/data",
  "/opt/connectcomms/env",
  "/var/lib/connect",
  "/var/lib/postgresql",
] as const;

export const PROTECTED_VOLUME_NAME_PREFIXES = [
  "app_chat-attachments",
  "app_crm-lead-docs",
  "app_crm-voicemail-drops",
  "app_ivr-prompts",
  "app_moh-assets",
  "obs_",
] as const;

export const PROTECTED_BIND_SUBSTRINGS = [
  "/opt/connectcomms/data/postgres",
  "/opt/connectcomms/data/redis",
  "/opt/connectcomms/data/minio",
] as const;

export const FORBIDDEN_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\brm\s+-\w*r\w*f\b/i,
  /\bfind\b.+\s-delete\b/i,
  /\btruncate\b/i,
  /\bshred\b/i,
  /\bdocker\s+system\s+prune\b/i,
  /\bdocker\s+volume\s+prune\b/i,
  /\bdocker\s+container\s+prune\b/i,
  /\bdocker\s+system\s+prune\s+--volumes\b/i,
  /\*\s*$/,
  /\s\*\s/,
  />\s*\/dev\/null\s*;?\s*rm\b/i,
];

export const FORBIDDEN_COMMAND_SUBSTRINGS = [
  "docker volume prune",
  "docker system prune --volumes",
  "docker system prune -a --volumes",
  "rm -rf",
] as const;

export function buildProtectedPaths(config: StorageMaintenanceConfig): string[] {
  return [
    config.dataRoot,
    config.envRoot,
    config.appCloneRoot,
    `${config.dataRoot}/postgres`,
    `${config.dataRoot}/redis`,
    `${config.dataRoot}/minio`,
    config.backupsRoot,
    "/var/lib/connect/chat-attachments",
    "/var/lib/connect/crm-lead-docs",
    "/var/lib/connect/crm-voicemail-drops",
    "/var/lib/connect/ivr-prompts",
    "/var/lib/connect/moh-assets",
  ];
}

export function isProtectedPath(path: string, config: StorageMaintenanceConfig): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const protectedPaths = buildProtectedPaths(config);
  for (const prefix of [...PROTECTED_PATH_PREFIXES, ...protectedPaths]) {
    const p = prefix.replace(/\/+$/, "");
    if (normalized === p || normalized.startsWith(`${p}/`)) return true;
  }
  return false;
}

export function isProtectedVolumeName(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  for (const prefix of PROTECTED_VOLUME_NAME_PREFIXES) {
    if (n === prefix || n.startsWith(prefix)) return true;
  }
  return false;
}

export function isProtectedImageRef(repository: string, tag: string, containers: number): boolean {
  const repo = repository.trim().toLowerCase();
  if (containers > 0) return true;
  const activeRepos = ["app-api", "app-portal", "app-worker", "app-telephony", "app-realtime"];
  if (activeRepos.some((r) => repo === r || repo.endsWith(`/${r}`))) return true;
  if (repo.includes("postgres") && tag === "15") return true;
  if (repo.includes("redis")) return true;
  if (repo.includes("minio")) return true;
  if (repo.includes("prometheus") || repo.includes("grafana") || repo.includes("loki")) return true;
  if (repo.includes("kamailio") || repo.includes("rtpengine")) return true;
  return false;
}

export function commandContainsWildcard(command: string): boolean {
  return /\*/.test(command);
}

export function validateCleanupCommand(command: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: "empty_command" };
  for (const sub of FORBIDDEN_COMMAND_SUBSTRINGS) {
    if (trimmed.toLowerCase().includes(sub)) {
      return { ok: false, reason: `forbidden_substring:${sub}` };
    }
  }
  for (const pattern of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: `forbidden_pattern:${pattern.source}` };
    }
  }
  if (commandContainsWildcard(trimmed)) {
    return { ok: false, reason: "wildcards_forbidden" };
  }
  return { ok: true };
}

export function scanCommandForProtectedPaths(
  command: string,
  config: StorageMaintenanceConfig,
): string[] {
  const hits: string[] = [];
  for (const prefix of buildProtectedPaths(config)) {
    if (command.includes(prefix)) hits.push(prefix);
  }
  for (const sub of PROTECTED_BIND_SUBSTRINGS) {
    if (command.includes(sub)) hits.push(sub);
  }
  return [...new Set(hits)];
}
