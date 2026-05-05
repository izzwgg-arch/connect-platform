export type PbxRouteHelperConfig = {
  baseUrl: string;
  secret: string;
  connectDestinationId?: string | null;
};

export type PbxRouteHelperRoute = {
  inbound_route_id: number;
  tenant_id: number | string;
  did: string | null;
  destination_id: number | string | null;
  description: string | null;
  routing_method?: string | null;
  [key: string]: unknown;
};

export type PbxRouteHelperSnapshot = {
  route_id: number;
  tenant_id: string;
  did_digits: string;
  did_e164: string;
  captured_at: string;
  original_row_json: string;
  original_destination_id: string;
  current_connect_destination_id?: string | null;
  [key: string]: unknown;
};

export type PbxRouteHelperInspectResponse = {
  ok: true;
  version: string;
  did: string;
  didDigits: string;
  tenantId: string;
  mode: "pbx" | "connect";
  route: PbxRouteHelperRoute;
  snapshot: PbxRouteHelperSnapshot | null;
};

export type PbxRouteHelperSwitchResponse = {
  ok: true;
  noop?: boolean;
  did: string;
  tenantId: string;
  routeId?: number;
  route?: PbxRouteHelperRoute;
  before?: PbxRouteHelperRoute;
  after?: PbxRouteHelperRoute;
  connectDestinationId?: string;
  restoredDestinationId?: string;
  apply?: {
    ran: boolean;
    reason?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  };
};

type HelperMapEntry = {
  baseUrl?: string;
  url?: string;
  secret?: string;
  connectDestinationId?: string | number;
};

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolvePbxRouteHelperConfig(pbxInstanceId?: string | null): PbxRouteHelperConfig | null {
  const byInstanceRaw = String(process.env.PBX_ROUTE_HELPER_BY_INSTANCE_JSON || "").trim();
  if (byInstanceRaw && pbxInstanceId) {
    try {
      const parsed = JSON.parse(byInstanceRaw) as Record<string, HelperMapEntry>;
      const entry = parsed[pbxInstanceId];
      const baseUrl = String(entry?.baseUrl || entry?.url || "").trim();
      const secret = String(entry?.secret || "").trim();
      if (baseUrl && secret) {
        return {
          baseUrl: trimSlash(baseUrl),
          secret,
          connectDestinationId: entry?.connectDestinationId == null ? null : String(entry.connectDestinationId),
        };
      }
    } catch {
      // Fall through to global env; callers surface helper-not-configured when
      // neither source is usable.
    }
  }

  const baseUrl = String(process.env.PBX_ROUTE_HELPER_BASE_URL || "").trim();
  const secret = String(process.env.PBX_ROUTE_HELPER_SECRET || "").trim();
  if (!baseUrl || !secret) return null;
  return {
    baseUrl: trimSlash(baseUrl),
    secret,
    connectDestinationId: String(process.env.PBX_ROUTE_HELPER_CONNECT_DESTINATION_ID || "").trim() || null,
  };
}

async function callHelper<T>(
  cfg: PbxRouteHelperConfig,
  path:
    | "/inspect"
    | "/retarget"
    | "/restore"
    | "/voicemail/greeting/upload"
    | "/voicemail/greeting/get"
    | "/voicemail/greeting/reset"
    | "/voicemail/greeting/record-call",
  body: Record<string, unknown>,
): Promise<T> {
  const resp = await fetch(`${cfg.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-connect-pbx-helper-secret": cfg.secret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await resp.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!resp.ok) {
    const detail = parsed?.error || parsed?.message || text || `HTTP ${resp.status}`;
    const err: any = new Error(String(detail));
    err.httpStatus = resp.status;
    err.payload = parsed;
    throw err;
  }
  return parsed as T;
}

async function getHelper<T>(
  cfg: PbxRouteHelperConfig,
  path: string,
): Promise<T> {
  const resp = await fetch(`${cfg.baseUrl}${path}`, {
    method: "GET",
    headers: {
      "x-connect-pbx-helper-secret": cfg.secret,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await resp.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!resp.ok) {
    const detail = parsed?.error || parsed?.message || text || `HTTP ${resp.status}`;
    const err: any = new Error(String(detail));
    err.httpStatus = resp.status;
    err.payload = parsed;
    throw err;
  }
  return parsed as T;
}

export function inspectPbxInboundRoute(
  cfg: PbxRouteHelperConfig,
  body: { did: string; tenantId: string },
): Promise<PbxRouteHelperInspectResponse> {
  return callHelper<PbxRouteHelperInspectResponse>(cfg, "/inspect", body);
}

export function retargetPbxInboundRoute(
  cfg: PbxRouteHelperConfig,
  body: { did: string; tenantId: string; requestId?: string; actor?: string; force?: boolean },
): Promise<PbxRouteHelperSwitchResponse> {
  return callHelper<PbxRouteHelperSwitchResponse>(cfg, "/retarget", {
    ...body,
    ...(cfg.connectDestinationId ? { connectDestinationId: cfg.connectDestinationId } : {}),
  });
}

export function restorePbxInboundRoute(
  cfg: PbxRouteHelperConfig,
  body: { did: string; tenantId: string; requestId?: string; actor?: string; force?: boolean },
): Promise<PbxRouteHelperSwitchResponse> {
  return callHelper<PbxRouteHelperSwitchResponse>(cfg, "/restore", body);
}

export type PbxVoicemailGreetingType = "unavailable" | "busy" | "temporary" | "name";

export type PbxVoicemailGreetingResponse = {
  ok: true;
  extension: string;
  tenantId: string;
  greetingType: PbxVoicemailGreetingType;
  pbxPath?: string | null;
  active?: boolean;
  sizeBytes?: number | null;
  sha256?: string | null;
  bytesB64?: string;
  updatedAt?: string | null;
};

export type PbxVoicemailGreetingRecordCallResponse = {
  ok: true;
  jobId: string;
  callId?: string | null;
  status: "ringing" | "recording" | "completed" | "failed" | "canceled";
};

export function uploadPbxVoicemailGreeting(
  cfg: PbxRouteHelperConfig,
  body: {
    tenantId: string;
    extension: string;
    greetingType: PbxVoicemailGreetingType;
    fileBaseName: string;
    sha256: string;
    bytesB64: string;
  },
): Promise<PbxVoicemailGreetingResponse> {
  return callHelper<PbxVoicemailGreetingResponse>(cfg, "/voicemail/greeting/upload", body);
}

export function getPbxVoicemailGreeting(
  cfg: PbxRouteHelperConfig,
  body: { tenantId: string; extension: string; greetingType: PbxVoicemailGreetingType; includeBytes?: boolean },
): Promise<PbxVoicemailGreetingResponse> {
  return callHelper<PbxVoicemailGreetingResponse>(cfg, "/voicemail/greeting/get", body);
}

export function resetPbxVoicemailGreeting(
  cfg: PbxRouteHelperConfig,
  body: { tenantId: string; extension: string; greetingType: PbxVoicemailGreetingType },
): Promise<PbxVoicemailGreetingResponse> {
  return callHelper<PbxVoicemailGreetingResponse>(cfg, "/voicemail/greeting/reset", body);
}

export function requestPbxVoicemailGreetingRecordCall(
  cfg: PbxRouteHelperConfig,
  body: { tenantId: string; extension: string; greetingType: PbxVoicemailGreetingType },
): Promise<PbxVoicemailGreetingRecordCallResponse> {
  return callHelper<PbxVoicemailGreetingRecordCallResponse>(cfg, "/voicemail/greeting/record-call", body);
}

export function getPbxVoicemailGreetingRecordCallStatus(
  cfg: PbxRouteHelperConfig,
  jobId: string,
): Promise<PbxVoicemailGreetingRecordCallResponse> {
  return getHelper<PbxVoicemailGreetingRecordCallResponse>(cfg, `/voicemail/greeting/record-call/${encodeURIComponent(jobId)}`);
}
