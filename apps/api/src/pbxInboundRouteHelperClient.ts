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
  /** From the PBX route ROW. Says nothing about what callers get — see below. */
  mode: "pbx" | "connect";
  route: PbxRouteHelperRoute;
  snapshot: PbxRouteHelperSnapshot | null;
  /** ⛔ The Goto actually rendered in the generated dialplan — WHAT CALLERS
   *  FOLLOW, and the only trustworthy answer to "where does this number go".
   *  Absent on helpers older than 2026.08.06.3. Proven 2026-08-06: `mode` read
   *  "connect" while every caller reached the old PBX IVR, because a panel
   *  edit had repurposed the shared doorway destination row. */
  rendered?: {
    file: string | null;
    gotos: string[];
    pointsAtDoorway: boolean;
    mode: "connect" | "pbx" | "unknown";
    error: string | null;
  };
  /** false = the row and the render disagree; callers follow the render. */
  renderedMatchesMode?: boolean;
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
  /** X5 (2026-07-26): per-table row counts for EVERY MOH-bearing ombu_* table
   *  (ring groups, conferences, parking lots, trunks, follow-me, dial profiles, …). */
  tables?: Record<string, { total: number; updated: number }>;
  /** X5: patch evidence for the hard-coded `sub-set-moh,s,1(<class>,…)` lines in the
   *  generated tenant dialplan — the layer that beats queues.conf and AstDB at runtime. */
  dialplanPatch?: {
    attempted: boolean;
    patched: number;
    targetClass?: string | null;
    file?: string | null;
    backup?: string | null;
    oldClasses?: string[];
    error?: string | null;
  };
  /** X5: per-queue / per-extension AstDB `moh` key convergence evidence. */
  astdbSync?: {
    attempted: boolean;
    tenantPath?: string | null;
    targetClass?: string | null;
    queueKeys: number;
    extensionKeys: number;
    failed: number;
    error?: string | null;
  };
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
    | "/doorway-status"
    | "/doorway-repair"
    | "/route-rebake"
    | "/recording-export"
    | "/retarget"
    | "/restore"
    | "/route-set-destination"
    | "/route-set-destination-v2"
    | "/route-restore-destination"
    | "/tenant-catalog"
    | "/flow-map"
    | "/ivr-action"
    | "/queue-action"
    | "/get-diversion"
    | "/set-diversion"
    | "/set-moh"
    | "/sync-tenant-moh"
    | "/voicemail/greeting/upload"
    | "/voicemail/greeting/get"
    | "/voicemail/greeting/reset"
    | "/voicemail/greeting/record-call",
  body: Record<string, unknown>,
  // 45s, not 15s: when the helper is busy (or catching up after a restart) a
  // healthy /inspect can exceed 15s, and that abort is what failed every
  // switch-to-connect on 2026-08-12 while the helper was overloaded. The
  // helper now answers 503 fast when saturated, so a longer deadline no
  // longer risks minutes-long hangs. Retarget/restore stay at 90s below.
  timeoutMs = 45_000,
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
  timeoutMs = 45_000,
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

export type PbxDoorwayStatusResponse = {
  ok: true;
  healthy: boolean;
  contextLive: boolean;
  dialplanFilePresent: boolean;
  dialplanFileCurrent: boolean;
  rows: Array<{ customContextId: number; destinationId: number }>;
  /** Doorway destination rows the VitalPBX panel repurposed. Reported for
   *  diagnosis only — inert once repair mints a fresh pair, so it must never
   *  gate health (an unclearable alert is an ignored alert). */
  hijackedRows?: Array<{ customContextId: number; destinationId: number; nowLooksLike: string | null; nowIndex: string | null }>;
  /** Connect-owned routes whose RENDER no longer enters the doorway. */
  renderDriftedRoutes?: Array<{ routeId: number; tenantId: string; did: string; rendered: string[] }>;
  wouldUse: string | null;
  version: string;
};

/** Re-apply the baked Goto for one DID from recorded intent. Connect-owned
 *  routes bake the doorway CONSTANT (never a decoded destination row). Touches
 *  only the generated dialplan — no route/snapshot/Connect state — so it is
 *  safe on a timer and idempotent (changed:0 when already correct). */
export function rebakePbxRoute(
  cfg: PbxRouteHelperConfig,
  body: { did: string; tenantId: string },
): Promise<{ ok: true; did: string; changed?: number; connectOwned?: boolean; before?: { gotos: string[] }; after?: { gotos: string[] } }> {
  return callHelper(cfg, "/route-rebake", body, 60_000);
}

/** Full doorway repair: valid destination pair, every Connect-owned route
 *  repointed at it, every render re-baked into it. Idempotent. */
export function repairPbxDoorway(
  cfg: PbxRouteHelperConfig,
): Promise<{ ok: true; doorwayDestinationId: string; goto: string; routes: Array<{ routeId: number; did: string; destRepointed: boolean; rebaked: number; rendered?: string[]; error: string | null }> }> {
  return callHelper(cfg, "/doorway-repair", {}, 120_000);
}

/** Read-only doorway health — consumed by the DID route reconciler. */
export function doorwayStatusFromHelper(
  cfg: PbxRouteHelperConfig,
): Promise<PbxDoorwayStatusResponse> {
  return callHelper<PbxDoorwayStatusResponse>(cfg, "/doorway-status", {});
}

export type PbxRecordingExportResponse = {
  ok: true;
  tenantId: string;
  soundsDir: string;
  copiedCount: number;
  results: Array<{
    recordingId: number | null;
    targetBase: string;
    copied: boolean;
    error: string | null;
    file?: string;
    bytes?: number;
  }>;
};

/** Copy native VitalPBX recordings into the Connect sounds dir — the audio
 *  half of an IVR menu migration. 30s: copies are local disk I/O but a
 *  go-live may move a dozen files. */
export function exportPbxRecordings(
  cfg: PbxRouteHelperConfig,
  body: { tenantId: string; recordings: Array<{ recordingId: number; targetBase: string }> },
): Promise<PbxRecordingExportResponse> {
  return callHelper<PbxRecordingExportResponse>(cfg, "/recording-export", body, 30_000);
}

export function retargetPbxInboundRoute(
  cfg: PbxRouteHelperConfig,
  body: { did: string; tenantId: string; requestId?: string; actor?: string; force?: boolean },
): Promise<PbxRouteHelperSwitchResponse> {
  // 90s: since helper v2026.08.05.3 a switch runs a full VitalPBX per-tenant
  // regen (~35-40s measured live) before returning; 15s aborted mid-regen and
  // filed phantom failures that only the next scheduler retry healed.
  return callHelper<PbxRouteHelperSwitchResponse>(
    cfg,
    "/retarget",
    {
      ...body,
      ...(cfg.connectDestinationId ? { connectDestinationId: cfg.connectDestinationId } : {}),
    },
    90_000,
  );
}

export function restorePbxInboundRoute(
  cfg: PbxRouteHelperConfig,
  body: { did: string; tenantId: string; requestId?: string; actor?: string; force?: boolean },
): Promise<PbxRouteHelperSwitchResponse> {
  // 90s: same full-regen duration as /retarget — see above.
  return callHelper<PbxRouteHelperSwitchResponse>(cfg, "/restore", body, 90_000);
}

/** M3 (agent route change) — isolated native-route destination set (never touches connect-mode). */
export function agentSetPbxRouteDestination(
  cfg: PbxRouteHelperConfig,
  body: { did: string; tenantId: string; destinationId: string | number; requestId?: string; actor?: string; force?: boolean },
): Promise<PbxRouteHelperSwitchResponse> {
  return callHelper<PbxRouteHelperSwitchResponse>(cfg, "/route-set-destination", body);
}

/** Decoded destination as reported by the helper's catalog/decode logic. */
export type PbxDecodedTarget = {
  destinationId: number;
  type: string;
  targetId: string | null;
  label: string | null;
};

/** Full read-only tenant inventory from the PBX helper (M3/M4/M10 grounding). */
export type PbxTenantCatalog = {
  ok: true;
  tenantId: string;
  extensions: Array<{ id: number; extension: string; name: string }>;
  queues: Array<{
    id: number;
    extension: string;
    description: string;
    strategy: string;
    musicGroupId: number | null;
    announcementId: number | null;
    periodicAnnouncementId: number | null;
    joinAnnouncementId: number | null;
    members: Array<{ memberId: number; extensionId: number; extension: string; name: string; penalty: number; type: string }>;
  }>;
  ringGroups: Array<{ id: number; extension: string; description: string }>;
  ivrs: Array<{
    id: number;
    description: string;
    welcomeRecordingId: number | null;
    welcomeRecordingName: string | null;
    timeoutSec: number | null;
    entries: Array<{ entryId: number; option: string; destinationId: number | null; enabled: string; target: PbxDecodedTarget | null }>;
  }>;
  recordings: Array<{ id: number; name: string; durationSec: number }>;
  timeConditions: Array<{ id: number; description: string; code: string }>;
  customApplications: Array<{ id: number; extension: string; description: string }>;
  routes: Array<{ routeId: number; did: string; description: string; destinationId: number | null; target: PbxDecodedTarget | null }>;
};

/** Native config writes run VitalPBX's own per-tenant apply_changes regen — allow for it. */
const NATIVE_WRITE_TIMEOUT_MS = 200_000;

/**
 * READ-ONLY full call-flow map used by the IVR migration screen: inbound
 * routes → time conditions → menus → per-digit destinations, plus recordings
 * and weekly schedules. Omit tenantId to map every enabled tenant.
 *
 * Mapping all tenants walks every menu on the PBX and decodes each
 * destination individually, so it is far heavier than a single-tenant read —
 * hence the longer ceiling. It stays a pure read: no writes, no reloads.
 */
export function getPbxFlowMap(
  cfg: PbxRouteHelperConfig,
  body: { tenantId?: string | number } = {},
): Promise<{ ok: true; version: string; capturedAt: string; tenants: unknown[] }> {
  return callHelper(cfg, "/flow-map", body as Record<string, unknown>, body.tenantId ? 45_000 : 180_000);
}

export function getPbxTenantCatalog(
  cfg: PbxRouteHelperConfig,
  body: { tenantId: string },
): Promise<PbxTenantCatalog> {
  return callHelper<PbxTenantCatalog>(cfg, "/tenant-catalog", body, 30_000);
}

/** M3 v2 — route a DID to ANY tenant-owned target by type + id (real regen). */
export function agentSetPbxRouteDestinationV2(
  cfg: PbxRouteHelperConfig,
  body: { did: string; tenantId: string; targetType: string; targetId: string | number; requestId?: string; actor?: string; force?: boolean },
): Promise<PbxRouteHelperSwitchResponse & { target?: { type: string; id: string; label: string } }> {
  return callHelper(cfg, "/route-set-destination-v2", body, NATIVE_WRITE_TIMEOUT_MS);
}

/** M4 native — VitalPBX IVR ops: set_entry / clear_entry / set_welcome / upload_recording / list. */
export function pbxNativeIvrAction(
  cfg: PbxRouteHelperConfig,
  body: Record<string, unknown> & { tenantId: string; action: string },
): Promise<any> {
  return callHelper(cfg, "/ivr-action", body, NATIVE_WRITE_TIMEOUT_MS);
}

/** M10 native — VitalPBX queue ops: add_member / remove_member / set_moh / set_announcement / list. */
export function pbxNativeQueueAction(
  cfg: PbxRouteHelperConfig,
  body: Record<string, unknown> & { tenantId: string; action: string },
): Promise<any> {
  return callHelper(cfg, "/queue-action", body, NATIVE_WRITE_TIMEOUT_MS);
}

/** M3 — restore the agent-captured original destination for a DID. */
export function agentRestorePbxRouteDestination(
  cfg: PbxRouteHelperConfig,
  body: { did: string; tenantId: string; requestId?: string; actor?: string },
): Promise<PbxRouteHelperSwitchResponse> {
  return callHelper<PbxRouteHelperSwitchResponse>(cfg, "/route-restore-destination", body);
}

/** M11 — read an extension's live DND/CF diversion state (for snapshot). */
export function getPbxDiversion(
  cfg: PbxRouteHelperConfig,
  body: { tenantId: string; extension: string; feature: string },
): Promise<{ ok: true; tenantId: string; extension: string; feature: string; enable: string; destination: string }> {
  return callHelper(cfg, "/get-diversion", body);
}

/** M11 — set an extension's DND/CF diversion (live AstDB put; no regen). */
export function setPbxDiversion(
  cfg: PbxRouteHelperConfig,
  body: { tenantId: string; extension: string; feature: string; enable: string; destination?: string },
): Promise<{ ok: true; tenantId: string; extension: string; feature: string; before: any; after: any }> {
  return callHelper(cfg, "/set-diversion", body);
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
