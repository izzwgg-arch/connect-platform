/**
 * Read-only guard for Docker Engine API access during storage inventory.
 * Only GET requests to inspection endpoints are permitted — no mutations.
 */
const ALLOWED_DOCKER_GET_PREFIXES = [
  "/images/json",
  "/images/",
  "/containers/json",
  "/volumes",
  "/system/df",
  "/info",
  "/version",
] as const;

export function assertReadOnlyDockerApiPath(path: string): void {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const allowed = ALLOWED_DOCKER_GET_PREFIXES.some((prefix) => {
    if (normalized === prefix || normalized.startsWith(`${prefix}?`)) return true;
    if (prefix === "/images/" && normalized.startsWith("/images/") && !normalized.includes("/push")) {
      return /^\/images\/(sha256:[a-f0-9]+|[a-f0-9]{64})(\/json)?$/i.test(normalized.split("?")[0] ?? normalized);
    }
    return false;
  });
  if (!allowed) {
    throw new Error(`storage_host_visibility_forbidden_docker_path:${normalized}`);
  }
}

export type HostVisibilityStatus = {
  hostInventoryRoot: string | null;
  dockerSocket: string;
  dockerSocketReachable: boolean;
  containerdMount: boolean;
  connectcommsMount: boolean;
  varLogMount: boolean;
};

export async function probeHostVisibility(
  hostInventoryRoot: string,
  dockerSocket: string,
  pathExists: (path: string) => Promise<boolean>,
  dockerSocketReachable: () => Promise<boolean>,
): Promise<HostVisibilityStatus> {
  const root = hostInventoryRoot.trim() || null;
  const prefix = root ?? "";
  return {
    hostInventoryRoot: root,
    dockerSocket,
    dockerSocketReachable: await dockerSocketReachable(),
    containerdMount: root ? await pathExists(`${prefix}/var/lib/containerd`) : false,
    connectcommsMount: root ? await pathExists(`${prefix}/opt/connectcomms`) : false,
    varLogMount: root ? await pathExists(`${prefix}/var/log`) : false,
  };
}

/** Strip container mount prefix so UI shows familiar host paths. */
export function toHostDisplayPath(path: string, hostInventoryRoot: string): string {
  const root = hostInventoryRoot.replace(/\/+$/, "");
  if (!root) return path;
  if (path === root) return "/";
  if (path.startsWith(`${root}/`)) return path.slice(root.length);
  return path;
}
