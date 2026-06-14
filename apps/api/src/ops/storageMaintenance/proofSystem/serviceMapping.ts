const SERVICE_PATTERNS: Array<{ service: string; patterns: RegExp[] }> = [
  { service: "api", patterns: [/^app-api(-\d+)?$/i, /app-api/i] },
  { service: "portal", patterns: [/^app-portal(-\d+)?$/i, /app-portal/i] },
  { service: "worker", patterns: [/^app-worker(-\d+)?$/i, /app-worker/i] },
  { service: "telephony", patterns: [/^app-telephony(-\d+)?$/i, /app-telephony/i] },
  { service: "realtime", patterns: [/^app-realtime(-\d+)?$/i, /app-realtime/i] },
  { service: "postgres", patterns: [/postgres/i] },
  { service: "redis", patterns: [/redis/i] },
  { service: "minio", patterns: [/minio/i] },
  { service: "grafana", patterns: [/grafana/i] },
  { service: "loki", patterns: [/loki/i, /promtail/i] },
  { service: "prometheus", patterns: [/prometheus/i] },
  { service: "kamailio", patterns: [/kamailio/i, /sbc-kamailio/i] },
  { service: "rtpengine", patterns: [/rtpengine/i, /sbc-rtpengine/i] },
];

export function resolveServiceName(containerName: string, image: string): string {
  const name = containerName.replace(/^\//, "").trim();
  const img = image.trim().toLowerCase();
  for (const { service, patterns } of SERVICE_PATTERNS) {
    if (patterns.some((p) => p.test(name) || p.test(img))) return service;
  }
  if (name) return name;
  return img || "unknown";
}

export function isRollbackImageRef(imageRef: string): boolean {
  const ref = imageRef.toLowerCase();
  return ref.includes("candidate") || ref.includes("_candidate");
}

export const CORE_ROLLBACK_SERVICES = ["api", "portal", "worker", "telephony", "realtime"] as const;
