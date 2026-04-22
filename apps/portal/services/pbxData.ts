import { apiDelete, apiGet, apiPatch, apiPost } from "./apiClient";

export type PbxResourceName =
  | "extensions"
  | "ring-groups"
  | "queues"
  | "ivr"
  | "trunks"
  | "routes"
  | "route-selections"
  | "devices"
  | "voicemail"
  | "parking-lots";

export type PbxResourceResponse = {
  resource: string;
  rows: Array<Record<string, unknown>>;
};

export async function loadPbxResource(resource: PbxResourceName, tenantId?: string): Promise<PbxResourceResponse> {
  // Extensions are always fetched as the full global set for SUPER_ADMINs; client-side filtering
  // handles per-tenant scoping using the tenantName field already present in every row.
  // This avoids broken backend filtering caused by mismatched TenantPbxLink identifiers.
  if (resource === "extensions") {
    return apiGet<PbxResourceResponse>(`/voice/pbx/resources/extensions?global=1`);
  }
  // For other PBX resources, pass tenantId as an explicit query param.
  const qs = tenantId && tenantId !== "local" ? `?tenantId=${encodeURIComponent(tenantId)}` : "";
  return apiGet<PbxResourceResponse>(`/voice/pbx/resources/${resource}${qs}`);
}

export async function createPbxResource(resource: PbxResourceName, payload: Record<string, unknown>): Promise<unknown> {
  return apiPost(`/voice/pbx/resources/${resource}`, { payload });
}

export async function updatePbxResource(resource: PbxResourceName, id: string, payload: Record<string, unknown>): Promise<unknown> {
  return apiPatch(`/voice/pbx/resources/${resource}/${id}`, { payload });
}

export async function deletePbxResource(resource: PbxResourceName, id: string): Promise<unknown> {
  return apiDelete(`/voice/pbx/resources/${resource}/${id}`);
}

export async function loadCallRecordings(filters: { extension?: string; dateFrom?: string; dateTo?: string; q?: string }): Promise<{ rows: any[] }> {
  const query = new URLSearchParams();
  if (filters.extension) query.set("extension", filters.extension);
  if (filters.dateFrom) query.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) query.set("dateTo", filters.dateTo);
  if (filters.q) query.set("q", filters.q);
  const qs = query.toString();
  return apiGet<{ rows: any[] }>(`/voice/pbx/call-recordings${qs ? `?${qs}` : ""}`);
}

export async function loadCallReports(filters: { dateFrom?: string; dateTo?: string }): Promise<{ report: any }> {
  const query = new URLSearchParams();
  if (filters.dateFrom) query.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) query.set("dateTo", filters.dateTo);
  const qs = query.toString();
  return apiGet<{ report: any }>(`/voice/pbx/call-reports${qs ? `?${qs}` : ""}`);
}
