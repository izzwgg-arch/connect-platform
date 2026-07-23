// Delivery dispatcher API client (portal). Self-contained: mirrors apiClient's
// baseUrl + localStorage token conventions so it works on every nginx host.

function baseUrl(): string {
  const baked = process.env.NEXT_PUBLIC_API_URL;
  const fromEnv = baked != null && String(baked).trim() !== "" ? String(baked).trim().replace(/\/$/, "") : "";
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") return `${window.location.origin.replace(/\/$/, "")}/api`;
  return (process.env.PORTAL_API_INTERNAL_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
}

function token(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
}

function tenantContext(): string {
  if (typeof window === "undefined") return "";
  const scope = localStorage.getItem("cc-admin-scope") || "TENANT";
  if (scope === "GLOBAL") return "";
  return localStorage.getItem("cc-tenant-id") || "";
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const tc = tenantContext();
  if (tc) headers["x-tenant-context"] = tc;
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status, body: data });
  return data as T;
}

// ── Types (loose; server is source of truth) ────────────────────────────────
export interface DashboardTile { key: string; label: string; value: number; tone: "neutral" | "positive" | "warn" | "danger" }
export interface AttentionItem { kind: string; ref: string; detail: string }
export interface DashboardResponse {
  counts: Record<string, number>;
  tiles: DashboardTile[];
  attention: AttentionItem[];
  needsIntervention: boolean;
}
export interface DeliveryOrderRow {
  id: string; sourceId: string; status: string; storeId: string;
  addrLine1: string; addrUnit?: string | null; customerName?: string | null; createdAt: string;
  priority?: string; notifyConsent?: boolean;
  driverId?: string | null; driverName?: string | null; runId?: string | null;
}
export interface DriverRow {
  id: string; userId: string; name: string; status: string; active: boolean;
  activeRunId?: string | null; stores: { storeId: string }[]; storeCount: number;
  lastSyncAt?: string | null; batteryPct?: number | null;
}
export interface RunRow {
  id: string; storeId: string; status: string; driverId?: string | null; driverName?: string | null;
  windowStart?: string | null; windowEnd?: string | null; startedAt?: string | null;
  stopsTotal: number; stopsDone: number;
}
export interface MapMarker {
  runId: string; driverId?: string | null; storeId: string;
  position: { lat: number; lng: number; heading?: number | null } | null;
  movement: "moving" | "stopped" | "stale" | "offline" | "unknown"; lastUpdateSec: number | null;
}
export interface ReportSummary {
  sinceDays: number; ordersReceived: number; delivered: number; failed: number;
  successRatePct: number; firstAttemptPct: number; avgDeliveryMinutes: number; etaAccuracyPct: number;
  topFailedReasons: { reason: string; count: number }[]; approximateMetrics: string[];
}
export interface ExceptionRow {
  id: string; orderId: string; sourceId: string; status: string; address: string;
  customerName?: string | null; reasonCode: string; reasonLabel: string;
  severity: "high" | "medium"; needsApproval: boolean; hasPhoto: boolean;
  note?: string | null; driverId?: string | null; occurredAt: string;
}

export const deliveryApi = {
  dashboard: (storeId?: string) => req<DashboardResponse>("GET", `/delivery/dashboard${storeId ? `?storeId=${encodeURIComponent(storeId)}` : ""}`),
  orders: (params: { status?: string; storeId?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.storeId) q.set("storeId", params.storeId);
    const qs = q.toString();
    return req<DeliveryOrderRow[]>("GET", `/delivery/orders${qs ? `?${qs}` : ""}`);
  },
  order: (id: string) => req<any>("GET", `/delivery/orders/${id}`),
  transition: (id: string, to: string, reason?: string) =>
    req<any>("POST", `/delivery/orders/${id}/transition`, { to, reason }),
  reassign: (id: string, driverId: string) => req<any>("POST", `/delivery/orders/${id}/reassign`, { driverId }),
  addNote: (id: string, text: string) => req<any>("POST", `/delivery/orders/${id}/note`, { text }),
  resendTrackingLink: (id: string) => req<{ ok: boolean; token: string; path: string }>("POST", `/delivery/orders/${id}/tracking-link`, {}),
  revokeTrackingLink: (id: string) => req<any>("POST", `/delivery/orders/${id}/tracking-link/revoke`, {}),
  map: () => req<MapMarker[]>("GET", "/delivery/map"),
  exceptions: () => req<any[]>("GET", "/delivery/exceptions"),
  exceptionQueue: () => req<ExceptionRow[]>("GET", "/delivery/exceptions/queue"),
  exceptionAction: (id: string, action: "resolve" | "dismiss" | "reschedule" | "notify") =>
    req<{ ok: boolean; action: string; orderId: string }>("POST", `/delivery/exceptions/${id}/action`, { action }),
  drivers: () => req<DriverRow[]>("GET", "/delivery/drivers"),
  driver: (id: string) => req<any>("GET", `/delivery/drivers/${id}`),
  runs: () => req<RunRow[]>("GET", "/delivery/runs"),
  unassignedOrders: () => req<any[]>("GET", "/delivery/runs/unassigned"),
  run: (id: string) => req<any>("GET", `/delivery/runs/${id}`),
  reorderRun: (id: string, stopIds: string[]) => req<any>("POST", `/delivery/runs/${id}/reorder`, { stopIds }),
  createRun: (storeId: string, driverId?: string) => req<any>("POST", "/delivery/runs", { storeId, driverId }),
  addStop: (runId: string, orderId: string) => req<any>("POST", `/delivery/runs/${runId}/stops`, { orderId }),
  startRun: (runId: string) => req<any>("POST", `/delivery/runs/${runId}/start`, {}),
  optimizeRun: (runId: string) => req<any>("POST", `/delivery/runs/${runId}/optimize`, {}),
  report: (days = 7) => req<ReportSummary>("GET", `/delivery/reports/summary?days=${days}`),
  audit: () => req<any[]>("GET", "/delivery/audit"),
  config: () => req<any>("GET", "/delivery/config"),
  saveConfig: (patch: Record<string, unknown>) => req<any>("PUT", "/delivery/config", patch),
};
