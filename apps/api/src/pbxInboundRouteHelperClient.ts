import type { PbxRouteHelperConfig } from "@connect/integrations";
export type { PbxRouteHelperConfig } from "@connect/integrations";
export {
  resolvePbxRouteHelperConfig,
  listVoicemailSpoolFromHelper,
  fetchAllVoicemailSpoolMessages,
  fetchVoicemailSpoolAudioFromHelper,
} from "@connect/integrations";

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

export type PbxRouteHelperMohResponse = {
  ok: true;
  noop?: boolean;
  did: string;
  tenantId: string;
  routeId?: number;
  musicGroupId: string;
  before?: PbxRouteHelperRoute;
  after?: PbxRouteHelperRoute;
  route?: PbxRouteHelperRoute;
  apply?: {
    ran: boolean;
    reason?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  };
};

export type PbxTenantMohSyncResponse = {
  ok: true;
  tenantId: string;
  musicGroupId: string;
  inboundTotal: number;
  inboundUpdated: number;
  extensionsTotal: number;
  extensionsUpdated: number;
  /** Per-queue MOH in VitalPBX (Asterisk Queue() ignores inbound CHANNEL musicclass). */
  queuesTotal?: number;
  queuesUpdated?: number;
  queueTable?: string;
  queueSample?: Array<Record<string, unknown>>;
  inboundSample?: Array<Record<string, unknown>>;
  extensionSample?: Array<Record<string, unknown>>;
  apply?: {
    ran: boolean;
    reason?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  };
};

async function callHelper<T>(
  cfg: PbxRouteHelperConfig,
  path:
    | "/inspect"
    | "/retarget"
    | "/restore"
    | "/set-moh"
    | "/sync-tenant-moh"
    | "/voicemail/greeting/upload"
    | "/voicemail/greeting/get"
    | "/voicemail/greeting/reset"
    | "/voicemail/greeting/record-call",
  body: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  const resp = await fetch(`${cfg.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-connect-pbx-helper-secret": cfg.secret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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
  timeoutMs = 15_000,
): Promise<T> {
  const resp = await fetch(`${cfg.baseUrl}${path}`, {
    method: "GET",
    headers: {
      "x-connect-pbx-helper-secret": cfg.secret,
    },
    signal: AbortSignal.timeout(timeoutMs),
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

export function setPbxInboundRouteMoh(
  cfg: PbxRouteHelperConfig,
  body: { did: string; tenantId: string; musicGroupId: string | number; requestId?: string; actor?: string },
): Promise<PbxRouteHelperMohResponse> {
  return callHelper<PbxRouteHelperMohResponse>(cfg, "/set-moh", body);
}

export function syncPbxTenantMoh(
  cfg: PbxRouteHelperConfig,
  body: { tenantId: string; musicGroupId: string | number; requestId?: string; actor?: string },
): Promise<PbxTenantMohSyncResponse> {
  return callHelper<PbxTenantMohSyncResponse>(cfg, "/sync-tenant-moh", body);
}

/** One live MOH class as parsed from Asterisk `moh show classes`. */
export type PbxMohShowClass = {
  /** Asterisk class name, e.g. "moh2", "default". */
  name: string;
  /** files | mp3 | quietmp3 | custom | ... (Asterisk "Mode"). */
  mode?: string | null;
  /** Backing directory (files mode) — used to disambiguate silence vs audio. */
  directory?: string | null;
  /** Count of playable files Asterisk knows about, when the helper reports it. */
  fileCount?: number | null;
};

export type PbxMohClassesResponse = {
  ok: true;
  /** Every class Asterisk currently has loaded (source of truth for playability). */
  classes: PbxMohShowClass[];
};

/**
 * READ-ONLY probe of live Asterisk MOH classes via the PBX route helper.
 *
 * Calls a GET `/moh-classes` endpoint that the helper implements by running
 * `asterisk -rx "moh show classes"` (read-only; no reload, no write). If the
 * helper does not implement it yet (404 / not-found), callers MUST treat that
 * as "unknown" and leave `loadedInAsterisk = null` rather than blocking any
 * class. This keeps Connect forward-compatible without requiring the PBX-side
 * helper to ship first.
 */
export function getPbxMohClasses(
  cfg: PbxRouteHelperConfig,
  timeoutMs = 10_000,
): Promise<PbxMohClassesResponse> {
  return getHelper<PbxMohClassesResponse>(cfg, "/moh-classes", timeoutMs);
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
  channel?: string;
  channelSource?: string;
  /** Present when helper ran `asterisk -rx channel originate …` */
  asteriskCommand?: string;
  asteriskExitCode?: number;
  asteriskOutput?: string;
  error?: string;
  targetPath?: string;
  pollRegistered?: boolean;
  pollElapsedSecs?: number;
  dispatchDialString?: string;
  dispatchEndpoints?: string[];
};

/** Read-only PBX diagnostics from helper (GET /voicemail/greeting/diag). Never pass reload=1 from Connect. */
export type PbxVoicemailGreetingDiagResponse = {
  ok: boolean;
  version?: string;
  dialplanFilePath?: string;
  dialplanFilePresent?: boolean;
  dialplanShowExitCode?: number;
  dialplanShowOutput?: string;
  dispatchShowExitCode?: number;
  dispatchShowOutput?: string;
  pjsipContactsExitCode?: number;
  pjsipContactsOutput?: string;
  error?: string;
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
  body: { tenantId: string; extension: string; greetingType: PbxVoicemailGreetingType; pjsipEndpoint?: string; endpointTenantId?: string },
): Promise<PbxVoicemailGreetingRecordCallResponse> {
  // 35s timeout: the helper polls for mobile SIP registration (up to ~20s) before originating.
  return callHelper<PbxVoicemailGreetingRecordCallResponse>(cfg, "/voicemail/greeting/record-call", body, 35_000);
}

export function getPbxVoicemailGreetingRecordCallStatus(
  cfg: PbxRouteHelperConfig,
  jobId: string,
): Promise<PbxVoicemailGreetingRecordCallResponse> {
  return getHelper<PbxVoicemailGreetingRecordCallResponse>(cfg, `/voicemail/greeting/record-call/${encodeURIComponent(jobId)}`, 15_000);
}

export function getPbxVoicemailGreetingDiag(cfg: PbxRouteHelperConfig): Promise<PbxVoicemailGreetingDiagResponse> {
  return getHelper<PbxVoicemailGreetingDiagResponse>(cfg, "/voicemail/greeting/diag", 22_000);
}
