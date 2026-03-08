import type { TelephonyDiscoveryResult, TenantTelephonyState } from "../types/telephony";
import { apiGet } from "./apiClient";

type ApiClient = {
  get: <T>(path: string) => Promise<T>;
  post: <T>(path: string, body?: unknown) => Promise<T>;
};

const defaultApiClient: ApiClient = {
  async get<T>(path: string): Promise<T> {
    return apiGet<T>(path);
  },
  async post<T>(_path: string, _body?: unknown): Promise<T> {
    return null as T;
  }
};

const DISCOVERY_ENDPOINTS: Array<{ kind: TelephonyDiscoveryResult["kind"]; path: string }> = [
  { kind: "tenantContext", path: "/voice/settings" },
  { kind: "extensions", path: "/voice/pbx/resources/extensions" },
  { kind: "trunks", path: "/voice/pbx/resources/trunks" },
  { kind: "queues", path: "/voice/pbx/resources/queues" },
  { kind: "ringGroups", path: "/voice/pbx/resources/ring-groups" },
  { kind: "ivr", path: "/voice/pbx/resources/ivr" },
  { kind: "recordings", path: "/voice/pbx/call-recordings" },
  { kind: "voicemail", path: "/voice/provisioning/voicemail" }
];

function toCount(payload: unknown): number | undefined {
  if (Array.isArray(payload)) return payload.length;
  if (payload && typeof payload === "object" && "items" in payload) {
    const items = (payload as { items?: unknown }).items;
    if (Array.isArray(items)) return items.length;
  }
  return undefined;
}

async function discoverOne(api: ApiClient, kind: TelephonyDiscoveryResult["kind"], path: string): Promise<TelephonyDiscoveryResult> {
  try {
    const payload = await api.get<unknown>(path);
    const count = toCount(payload);
    const exists =
      count !== undefined
        ? count > 0
        : payload !== null && payload !== undefined && !(typeof payload === "object" && Object.keys(payload as Record<string, unknown>).length === 0);
    return { kind, exists, count, source: "api" };
  } catch {
    return { kind, exists: false, source: "api" };
  }
}

export async function getTenantTelephonyState(tenantId: string, api: ApiClient = defaultApiClient): Promise<TenantTelephonyState> {
  const discovered = await Promise.all(DISCOVERY_ENDPOINTS.map((entry) => discoverOne(api, entry.kind, entry.path)));
  return {
    tenantId,
    exists: discovered.some((entry) => entry.exists),
    discovered
  };
}

export async function assertCreateAllowed(
  tenantId: string,
  kind: TelephonyDiscoveryResult["kind"],
  api: ApiClient = defaultApiClient
): Promise<{ allowed: boolean; reason?: string }> {
  const state = await getTenantTelephonyState(tenantId, api);
  const target = state.discovered.find((entry) => entry.kind === kind);
  if (target?.exists) {
    return {
      allowed: false,
      reason: `${kind} already exists; load existing configuration instead of creating a duplicate`
    };
  }
  return { allowed: true };
}

export async function getExtensions(tenantId: string, api: ApiClient = defaultApiClient) {
  await getTenantTelephonyState(tenantId, api);
  return api.get<unknown>("/voice/pbx/resources/extensions");
}

export async function getRegistrationStatus(tenantId: string, api: ApiClient = defaultApiClient) {
  await getTenantTelephonyState(tenantId, api);
  return api.get<unknown>("/voice/settings");
}

export async function getActiveCalls(tenantId: string, api: ApiClient = defaultApiClient) {
  await getTenantTelephonyState(tenantId, api);
  return api.get<unknown>("/voice/calls");
}

export async function getCallHistory(tenantId: string, api: ApiClient = defaultApiClient) {
  await getTenantTelephonyState(tenantId, api);
  return api.get<unknown>("/voice/pbx/call-reports");
}

export async function getVoicemail(tenantId: string, api: ApiClient = defaultApiClient) {
  await getTenantTelephonyState(tenantId, api);
  return api.get<unknown>("/voice/provisioning/voicemail");
}

export async function getRecordings(tenantId: string, api: ApiClient = defaultApiClient) {
  await getTenantTelephonyState(tenantId, api);
  return api.get<unknown>("/voice/pbx/call-recordings");
}

export async function getTrunks(tenantId: string, api: ApiClient = defaultApiClient) {
  await getTenantTelephonyState(tenantId, api);
  return api.get<unknown>("/voice/pbx/resources/trunks");
}

export async function getQueues(tenantId: string, api: ApiClient = defaultApiClient) {
  await getTenantTelephonyState(tenantId, api);
  return api.get<unknown>("/voice/pbx/resources/queues");
}

export async function getIVRs(tenantId: string, api: ApiClient = defaultApiClient) {
  await getTenantTelephonyState(tenantId, api);
  return api.get<unknown>("/voice/pbx/resources/ivr");
}
