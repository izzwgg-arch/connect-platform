import type { DockerContainerRow } from "../scanner";
import type { HealthGateResult, HealthGateServiceRow } from "../types";

const REQUIRED_SERVICES: Array<{
  key: string;
  label: string;
  match: (name: string, image: string) => boolean;
}> = [
  { key: "api", label: "API", match: (n) => n.includes("app-api") && !n.includes("candidate") },
  { key: "portal", label: "Portal", match: (n) => n.includes("app-portal") && !n.includes("candidate") },
  { key: "worker", label: "Worker", match: (n) => n.includes("app-worker") },
  { key: "telephony", label: "Telephony", match: (n) => n.includes("app-telephony") },
  { key: "realtime", label: "Realtime", match: (n) => n.includes("app-realtime") },
  { key: "postgres", label: "Postgres", match: (n, i) => n.includes("postgres") || i.includes("postgres:15") },
  { key: "redis", label: "Redis", match: (n, i) => n.includes("redis") || i.includes("redis:7") },
  { key: "minio", label: "MinIO", match: (n, i) => n.includes("minio") || i.includes("minio/minio") },
  { key: "kamailio", label: "Kamailio", match: (n) => n.includes("kamailio") },
  { key: "rtpengine", label: "RTPengine", match: (n) => n.includes("rtpengine") },
  { key: "grafana", label: "Grafana", match: (n) => n.includes("grafana") && !n.includes("promtail") && !n.includes("loki") },
  { key: "prometheus", label: "Prometheus", match: (n) => n.includes("prometheus") },
  { key: "loki", label: "Loki", match: (n) => n.includes("loki") },
  { key: "alertmanager", label: "Alertmanager", match: (n) => n.includes("alertmanager") },
];

function containerName(row: DockerContainerRow): string {
  return (row.Names?.[0] ?? "").replace(/^\//, "");
}

export function evaluateHealthGate(containers: DockerContainerRow[]): HealthGateResult {
  const rows: HealthGateServiceRow[] = [];
  const failures: string[] = [];

  for (const svc of REQUIRED_SERVICES) {
    const match = containers.find((c) => {
      const name = containerName(c);
      const image = c.Image ?? "";
      return svc.match(name, image);
    });
    const running = Boolean(match && String(match.State ?? "").toLowerCase().includes("running"));
    rows.push({
      service: svc.key,
      label: svc.label,
      containerName: match ? containerName(match) : null,
      running,
      healthy: running,
      detail: match ? `state=${match.State}` : "container_not_found",
    });
    if (!running) failures.push(`service_not_running:${svc.key}`);
  }

  return {
    passed: failures.length === 0,
    checkedAt: new Date().toISOString(),
    services: rows,
    failures,
  };
}
