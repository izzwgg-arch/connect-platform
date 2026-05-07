import { randomUUID } from "node:crypto";
import { db } from "@connect/db";
import {
  getPbxVoicemailGreeting,
  getPbxVoicemailGreetingDiag,
  getPbxVoicemailGreetingRecordCallStatus,
  requestPbxVoicemailGreetingRecordCall,
  resolvePbxRouteHelperConfig,
  type PbxVoicemailGreetingType,
} from "./pbxInboundRouteHelperClient";
import {
  buildVmRecordWakePushInput,
  classifyHelperOriginateFailure,
  decideVmRecordWake,
  greetingFileChanged,
  isDirectPjsipChannelSource,
  mapVmRecordErrorToUserMessage,
  parseReachablePjsipContacts,
  shouldAllowOriginate,
  type VmRecordClientState,
  type VmRecordErrorCode,
} from "./vmRecordCallHelpers";

type VmRecordWakeMeta = {
  devicesNotified: number;
  waitedMs: number;
  sent: boolean;
  registered?: boolean;
  registrationState?: string | null;
  error?: string;
  /** Phase A diagnostics: present whether or not we attempted the push. */
  attempted?: boolean;
  /** Number of MobileDevice rows for the user/tenant (any `active` value). */
  deviceRowCount?: number;
  /** Subset that have `active=true`. */
  activeDeviceCount?: number;
  /** True when a pre-wake `pjsip show contacts` saw an Avail AOR contact for the extension. */
  endpointAlreadyAvail?: boolean;
  /** When `attempted=false`, why we skipped (e.g. "skipped_no_devices"). */
  skipReason?: string;
  /**
   * The pbxCallId used for the INCOMING_CALL_WAKE push, stored so the
   * calling_extension step can reference it in the vm-record INCOMING_CALL push.
   */
  pbxCallId?: string;
};

export type VmRecordJobError = {
  code: VmRecordErrorCode | string;
  message: string;
  userMessage: string;
  detail?: unknown;
};

type InternalVmRecordJob = {
  jobId: string;
  state: VmRecordClientState;
  ownerUserId: string;
  connectTenantId: string;
  connectExtensionId: string;
  extNumber: string;
  pbxTenantId: string;
  greetingType: PbxVoicemailGreetingType;
  pjsipEndpointHint: string | null;
  pbxInstanceId: string | null;
  createdAtIso: string;
  updatedAtIso: string;
  wake: VmRecordWakeMeta;
  pjsipContactOk: boolean | null;
  matchedEndpoints: string[];
  diagAvailable: boolean;
  diagBypassWithoutDiag: boolean;
  dialplanShowSnippet?: string;
  dialplanRecordExitCode?: number | null;
  helperJobId?: string | null;
  helper?: Record<string, unknown> | null;
  verification?: {
    saved: boolean;
    greetingType: PbxVoicemailGreetingType;
    pbxFileExists: boolean;
    sizeBytes: number | null;
    updatedAt: string | null;
    sha256: string | null;
  } | null;
  error?: VmRecordJobError;
  /** Caller-supplied endpoint from client request (before validation). */
  callerSipEndpointRequested?: string | null;
  /** Endpoint accepted after validation (null when absent or invalid). */
  callerSipEndpointAccepted?: string | null;
  /** Snapshot before originate — not returned to client */
  beforeActive: boolean;
  beforeSha: string | null;
  beforeUpdatedAt: string | null;
};

const jobs = new Map<string, InternalVmRecordJob>();
const JOB_TTL_MS = 45 * 60 * 1000;
const WAKE_WAIT_MAX_MS = 12_000;
const WAKE_POLL_MS = 500;
const VERIFY_POLL_MS = 3000;
const VERIFY_MAX_MS = 8 * 60 * 1000;

function pruneJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - Date.parse(j.createdAtIso) > JOB_TTL_MS) jobs.delete(id);
  }
}

function touch(job: InternalVmRecordJob) {
  job.updatedAtIso = new Date().toISOString();
}

function setError(job: InternalVmRecordJob, code: VmRecordErrorCode, message: string, detail?: unknown) {
  job.state = "failed";
  job.error = {
    code,
    message,
    userMessage: mapVmRecordErrorToUserMessage(code),
    detail,
  };
  touch(job);
}

export type VmRecordCallDeps = {
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void };
  sendPush: (input: {
    tenantId: string;
    userId: string;
    /**
     * Phase A.5 opt-in: vm-record passes `true` so the push helper
     * fans out to inactive `MobileDevice` rows. Every other caller
     * leaves it unset; default behavior is the old active-only filter.
     */
    includeInactiveDevices?: boolean;
    payload: Record<string, unknown>;
  }) => Promise<unknown>;
};

export type CreateVmRecordJobInput = {
  ownerUserId: string;
  connectTenantId: string;
  connectExtensionId: string;
  extNumber: string;
  pbxTenantId: string;
  greetingType: PbxVoicemailGreetingType;
  pjsipEndpointHint: string | null;
  pbxInstanceId: string | null;
  callerSipEndpointRequested?: string | null;
  callerSipEndpointAccepted?: string | null;
};

export function createVmRecordJob(input: CreateVmRecordJobInput): string {
  pruneJobs();
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const job: InternalVmRecordJob = {
    jobId,
    state: "preparing_call",
    ownerUserId: input.ownerUserId,
    connectTenantId: input.connectTenantId,
    connectExtensionId: input.connectExtensionId,
    extNumber: input.extNumber,
    pbxTenantId: input.pbxTenantId,
    greetingType: input.greetingType,
    pjsipEndpointHint: input.pjsipEndpointHint,
    pbxInstanceId: input.pbxInstanceId,
    createdAtIso: now,
    updatedAtIso: now,
    wake: { devicesNotified: 0, waitedMs: 0, sent: false },
    pjsipContactOk: null,
    matchedEndpoints: [],
    diagAvailable: false,
    diagBypassWithoutDiag: false,
    callerSipEndpointRequested: input.callerSipEndpointRequested ?? null,
    callerSipEndpointAccepted: input.callerSipEndpointAccepted ?? null,
    beforeActive: false,
    beforeSha: null,
    beforeUpdatedAt: null,
  };
  jobs.set(jobId, job);
  return jobId;
}

export function getVmRecordJobForUser(
  jobId: string,
  userId: string,
  tenantId: string | null | undefined,
  extensionId: string,
): InternalVmRecordJob | null {
  const j = jobs.get(jobId);
  if (!j) return null;
  if (j.ownerUserId !== userId) return null;
  if (tenantId != null && String(tenantId) !== "" && j.connectTenantId !== tenantId) return null;
  if (j.connectExtensionId !== extensionId) return null;
  return j;
}

export function buildVmRecordJobPublicView(job: InternalVmRecordJob): Record<string, unknown> {
  return {
    ok: true,
    async: true,
    jobId: job.jobId,
    state: job.state,
    extension: job.extNumber,
    pbxTenantId: job.pbxTenantId,
    greetingType: job.greetingType,
    pjsipEndpointHint: job.pjsipEndpointHint,
    callerSipEndpointRequested: job.callerSipEndpointRequested ?? null,
    callerSipEndpointAccepted: job.callerSipEndpointAccepted ?? null,
    wake: job.wake,
    pjsipContactOk: job.pjsipContactOk,
    matchedEndpoints: job.matchedEndpoints,
    diagAvailable: job.diagAvailable,
    diagBypassWithoutDiag: job.diagBypassWithoutDiag,
    dialplanRecordExitCode: job.dialplanRecordExitCode ?? null,
    dialplanShowSnippet: job.dialplanShowSnippet ? String(job.dialplanShowSnippet).slice(0, 2000) : null,
    helperJobId: job.helperJobId ?? null,
    helper: job.helper ?? null,
    verification: job.verification ?? null,
    error: job.error ?? null,
    createdAt: job.createdAtIso,
    updatedAt: job.updatedAtIso,
  };
}

export async function refreshVmRecordJobHelperFields(job: InternalVmRecordJob): Promise<void> {
  const helperCfg = resolvePbxRouteHelperConfig(job.pbxInstanceId);
  if (!helperCfg || !job.helperJobId) return;
  try {
    const h = await getPbxVoicemailGreetingRecordCallStatus(helperCfg, job.helperJobId);
    job.helper = h as unknown as Record<string, unknown>;
    touch(job);
  } catch {
    /* ignore transient helper errors on poll */
  }
}

export async function runVmRecordCallJob(deps: VmRecordCallDeps, jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  const helperCfg = resolvePbxRouteHelperConfig(job.pbxInstanceId);
  if (!helperCfg) {
    setError(job, "pbx_helper_not_configured", "PBX route helper is not configured for this extension.");
    return;
  }

  try {
    job.state = "waking_device";
    touch(job);

    const ownerUserId = job.ownerUserId;
    const wakeMeta: VmRecordWakeMeta = { devicesNotified: 0, waitedMs: 0, sent: false };

    // ── Pre-wake PJSIP check (diagnostic only, Phase A) ──────────────────────
    // We still record whether the AOR is currently Avail because it is useful
    // signal for downstream debugging and for the `shouldAllowOriginate` gate
    // below, but it NO LONGER blocks the wake push. Desktop WebRTC and the
    // mobile app share the same SIP authUsername (T<tenant>_<ext>_1), so a
    // registered desktop makes the AOR appear Avail even when the mobile is
    // asleep — gating on it suppressed mobile fan-out in the common case.
    let preWakeContactOk = false;
    try {
      const preDiag = await getPbxVoicemailGreetingDiag(helperCfg);
      if (preDiag?.ok) {
        const parsed = parseReachablePjsipContacts(
          String(preDiag.pjsipContactsOutput || ""),
          job.pbxTenantId,
          job.extNumber,
        );
        preWakeContactOk = parsed.ok;
        if (preWakeContactOk) {
          job.matchedEndpoints = parsed.availEndpoints;
          job.pjsipContactOk = true;
          job.diagAvailable = true;
        }
      }
    } catch {
      // Pre-check failure is non-fatal — fall through to normal wake flow.
    }

    // Phase A: query ALL MobileDevice rows for the user/tenant (no `active`
    // filter). A stale row may still hold a working push token and is a
    // legitimate wake target; the post-wake registration poll is the real
    // authoritative readiness signal.
    const devices = await db.mobileDevice.findMany({
      where: { tenantId: job.connectTenantId, userId: ownerUserId } as any,
      select: { id: true, active: true } as any,
    });
    const deviceRows = devices as unknown as { id: string; active: boolean }[];
    const deviceIds = deviceRows.map((d) => d.id);
    const activeDeviceIds = deviceRows.filter((d) => d.active).map((d) => d.id);
    const hadMobileDevices = deviceIds.length > 0;

    const wakeDecision = decideVmRecordWake({
      deviceRowCount: deviceIds.length,
      activeDeviceCount: activeDeviceIds.length,
      preWakeContactOk,
    });
    wakeMeta.attempted = wakeDecision.attempt;
    wakeMeta.deviceRowCount = wakeDecision.deviceRowCount;
    wakeMeta.activeDeviceCount = wakeDecision.activeDeviceCount;
    wakeMeta.endpointAlreadyAvail = wakeDecision.endpointAlreadyAvail;
    if (!wakeDecision.attempt) wakeMeta.skipReason = wakeDecision.reason;

    deps.log.info(
      {
        jobId,
        tenantId: job.connectTenantId,
        userId: ownerUserId,
        extNumber: job.extNumber,
        pbxTenantId: job.pbxTenantId,
        deviceRowCount: wakeDecision.deviceRowCount,
        activeDeviceCount: wakeDecision.activeDeviceCount,
        endpointAlreadyAvail: wakeDecision.endpointAlreadyAvail,
        matchedEndpoints: job.matchedEndpoints,
        decision: wakeDecision.attempt ? "send_wake" : wakeDecision.reason,
      },
      "vm-record-call: mobile wake decision",
    );

    if (wakeDecision.attempt) {
      const wakePbxCallId = "vm-greeting-record-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      try {
        const pushed = await deps.sendPush(
          buildVmRecordWakePushInput({
            tenantId: job.connectTenantId,
            userId: ownerUserId,
            payload: {
              type: "INCOMING_CALL_WAKE",
              pbxCallId: wakePbxCallId,
              fromNumber: "vm-greeting",
              fromDisplay: "Voicemail Greeting Recording",
              toExtension: job.extNumber,
              tenantId: job.connectTenantId,
              pbxVitalTenantId: job.pbxTenantId,
              timestamp: new Date().toISOString(),
              wakeRequestedAt: new Date().toISOString(),
            },
          }),
        );
        const waitStartedAt = new Date();
        wakeMeta.sent = true;
        wakeMeta.pbxCallId = wakePbxCallId;
        wakeMeta.devicesNotified = (pushed as { queued?: number } | null | undefined)?.queued ?? deviceIds.length;
        wakeMeta.registered = false;
        job.state = "checking_registration";
        touch(job);
        deps.log.info(
          {
            jobId,
            tenantId: job.connectTenantId,
            userId: ownerUserId,
            extNumber: job.extNumber,
            pbxCallId: wakePbxCallId,
            devicesNotified: wakeMeta.devicesNotified,
            deviceRowCount: wakeMeta.deviceRowCount,
          },
          "vm-record-call: mobile wake push sent",
        );

        const deadline = Date.now() + WAKE_WAIT_MAX_MS;
        while (Date.now() < deadline) {
          const sessionWhere: Record<string, unknown> = {
            tenantId: job.connectTenantId,
            userId: ownerUserId,
            lastRegState: "REGISTERED",
            lastSeenAt: { gte: waitStartedAt },
          };
          if (deviceIds.length) {
            (sessionWhere as any).deviceId = { in: deviceIds };
          }
          const session = (await db.voiceClientSession.findFirst({
            where: sessionWhere as any,
            orderBy: { lastSeenAt: "desc" },
            select: { lastRegState: true, id: true } as any,
          })) as { lastRegState: string } | null;
          if (String(session?.lastRegState || "") === "REGISTERED") {
            wakeMeta.registered = true;
            wakeMeta.registrationState = "REGISTERED";
            break;
          }
          await new Promise((r) => setTimeout(r, WAKE_POLL_MS));
        }
        wakeMeta.waitedMs = Date.now() - waitStartedAt.getTime();
        if (!wakeMeta.registered) {
          const latestSession = (await db.voiceClientSession.findFirst({
            where: { tenantId: job.connectTenantId, userId: ownerUserId, deviceId: { in: deviceIds } } as any,
            orderBy: { lastSeenAt: "desc" },
            select: { lastRegState: true } as any,
          })) as { lastRegState: string } | null;
          wakeMeta.registrationState = latestSession?.lastRegState != null ? String(latestSession.lastRegState) : null;
        }
        deps.log.info(
          {
            jobId,
            extNumber: job.extNumber,
            pbxCallId: wakePbxCallId,
            registered: wakeMeta.registered,
            registrationState: wakeMeta.registrationState ?? null,
            waitedMs: wakeMeta.waitedMs,
          },
          "vm-record-call: mobile wake registration outcome",
        );
      } catch (err: any) {
        wakeMeta.error = String(err?.message || err);
        deps.log.warn(
          { err: err?.message, tenantId: job.connectTenantId, userId: ownerUserId, extension: job.extNumber },
          "vm-record-call: wake push failed",
        );
      }
    }

    job.wake = wakeMeta;
    job.state = "checking_endpoint";
    touch(job);

    let contactOk = preWakeContactOk; // already true if pre-wake check found Avail endpoint
    let pjsipOut = "";
    let dialplanSnippet = "";
    let dialplanExit: number | null = null;
    const bypass = String(process.env.VOICEMAIL_RECORD_ALLOW_WITHOUT_DIAG || "").trim() === "1";

    // Skip the post-wake PJSIP check if pre-wake already confirmed Avail.
    // If the wake WAS sent (re-registration case), always re-check.
    if (!preWakeContactOk || wakeMeta.sent) {
      try {
        const diag = await getPbxVoicemailGreetingDiag(helperCfg);
        job.diagAvailable = !!diag?.ok;
        pjsipOut = String(diag?.pjsipContactsOutput || "");
        dialplanSnippet = String(diag?.dialplanShowOutput || "").slice(0, 4000);
        dialplanExit = typeof diag?.dialplanShowExitCode === "number" ? diag.dialplanShowExitCode : null;
        job.dialplanShowSnippet = dialplanSnippet;
        job.dialplanRecordExitCode = dialplanExit;
        const parsed = parseReachablePjsipContacts(pjsipOut, job.pbxTenantId, job.extNumber);
        job.matchedEndpoints = parsed.availEndpoints;
        contactOk = parsed.ok;
        job.pjsipContactOk = contactOk;
      } catch (err: any) {
        const st = Number(err?.httpStatus || 0);
        const notFound = st === 404 || String(err?.message || "").toLowerCase().includes("not_found");
        if (bypass && notFound) {
          job.diagBypassWithoutDiag = true;
          job.diagAvailable = false;
          job.pjsipContactOk = null;
          contactOk = true;
        } else {
          setError(job, "pbx_helper_diag_unavailable", notFound ? "Helper voicemail diag route not found (upgrade helper)." : String(err?.message || err), err?.payload);
          return;
        }
      }
    }

    const gate = shouldAllowOriginate({
      contactOk,
      wakeSent: !!wakeMeta.sent,
      wakeRegistered: !!wakeMeta.registered,
      hadMobileDevices,
    });
    if (!gate.allow) {
      const code = (gate.blockCode || "no_registered_endpoint") as VmRecordErrorCode;
      setError(job, code, mapVmRecordErrorToUserMessage(code));
      return;
    }

    const before = await getPbxVoicemailGreeting(helperCfg, {
      tenantId: job.pbxTenantId,
      extension: job.extNumber,
      greetingType: job.greetingType,
      includeBytes: false,
    });
    job.beforeActive = !!before?.active;
    job.beforeSha = before?.sha256 ? String(before.sha256) : null;
    job.beforeUpdatedAt = before?.updatedAt ? String(before.updatedAt) : null;

    job.state = "calling_extension";
    touch(job);

    // ── Mobile INCOMING_CALL push for vm-record ───────────────────────────────
    // The PBX dispatch context dials PJSIP/T<tenant>_<ext>_1 (the mobile SIP
    // contact) in parallel with the hard-phone endpoint. However, the telephony
    // pipeline sees the originating channel as
    // Local/<exten>@connect-vm-greeting-dispatch (tenant_UNRESOLVED) and does
    // NOT create a CallInvite or send an INCOMING_CALL push. Without it the
    // mobile receives the SIP INVITE silently, never shows the ringtone UI, and
    // the Dial() times out unanswered.
    //
    // We send the push here, keyed to a synthetic inviteId derived from the
    // jobId, before the PBX originates (~1–2s later). When the user taps Answer
    // in the Connect IncomingCallScreen, jssip.ts::findIncoming() uses its
    // single-session fallback (line 1306) to map the tap to the live SIP session
    // (no X-Connect-Invite-ID header is present in the vm-record INVITE, so
    // exact-header matching is skipped, but the fallback fires when exactly one
    // answerable session is present — which is always the case for vm-record).
    if (hadMobileDevices) {
      const vmInviteId = "vmr-" + jobId;
      try {
        await deps.sendPush({
          tenantId: job.connectTenantId,
          userId: ownerUserId,
          includeInactiveDevices: false,
          payload: {
            type: "INCOMING_CALL",
            inviteId: vmInviteId,
            callId: vmInviteId,
            from: "vm-greeting",
            fromNumber: "vm-greeting",
            fromDisplay: "Voicemail Greeting Recording",
            toExtension: job.extNumber,
            tenantId: job.connectTenantId,
            timestamp: new Date().toISOString(),
            pbxCallId: wakeMeta.pbxCallId ?? vmInviteId,
            sipCallTarget: "",
            pbxSipUsername: "",
          },
        });
        deps.log.info(
          { jobId, extNumber: job.extNumber, vmInviteId },
          "vm-record-call: sent mobile INCOMING_CALL push",
        );
      } catch (err: any) {
        deps.log.warn(
          { err: err?.message, jobId, extNumber: job.extNumber },
          "vm-record-call: mobile INCOMING_CALL push failed (non-fatal)",
        );
      }
    }

    let res: Awaited<ReturnType<typeof requestPbxVoicemailGreetingRecordCall>>;
    try {
      res = await requestPbxVoicemailGreetingRecordCall(helperCfg, {
        tenantId: job.pbxTenantId,
        extension: job.extNumber,
        greetingType: job.greetingType,
        pjsipEndpoint: job.pjsipEndpointHint || undefined,
      });
    } catch (err: any) {
      const status = Number(err?.httpStatus || 502);
      const helperPayloadError = String(err?.payload?.error || "").trim();
      const routesMissing = status === 404 && helperPayloadError === "not_found";
      setError(
        job,
        routesMissing ? "pbx_helper_voicemail_routes_missing" : "pbx_helper_record_call_failed",
        String(err?.message || err),
        err?.payload,
      );
      return;
    }

    job.helperJobId = res.jobId;
    job.helper = res as unknown as Record<string, unknown>;
    touch(job);

    if (isDirectPjsipChannelSource((res as { channelSource?: string | null }).channelSource)) {
      deps.log.warn(
        {
          jobId: job.jobId,
          tenantId: job.connectTenantId,
          extNumber: job.extNumber,
          channelSource: (res as { channelSource?: string }).channelSource,
          helperVersion: (res as { version?: string }).version,
        },
        "vm-record-call: helper returned direct_pjsip channelSource — fan-out is bypassed (Phase B regression)",
      );
    }

    const exitCode = typeof (res as any).asteriskExitCode === "number" ? (res as any).asteriskExitCode : 0;
    const failed = (res as any).status === "failed" || exitCode !== 0;
    if (failed) {
      const out = String((res as any).asteriskOutput || (res as any).error || "");
      const classified = classifyHelperOriginateFailure(out, dialplanSnippet);
      const code: VmRecordErrorCode = classified || "pbx_helper_record_call_failed";
      setError(job, code, out || "Originate failed", { helper: res });
      return;
    }

    job.state = "answer_and_follow_prompts";
    touch(job);
    await new Promise((r) => setTimeout(r, 400));
    job.state = "waiting_for_saved_greeting";
    touch(job);

    const verifyStarted = Date.now();
    while (Date.now() - verifyStarted < VERIFY_MAX_MS) {
      await new Promise((r) => setTimeout(r, VERIFY_POLL_MS));
      if (job.helperJobId) {
        try {
          job.helper = (await getPbxVoicemailGreetingRecordCallStatus(helperCfg, job.helperJobId)) as unknown as Record<string, unknown>;
        } catch {
          /* ignore */
        }
      }
      const after = await getPbxVoicemailGreeting(helperCfg, {
        tenantId: job.pbxTenantId,
        extension: job.extNumber,
        greetingType: job.greetingType,
        includeBytes: false,
      });
      const changed = greetingFileChanged({
        beforeActive: job.beforeActive,
        beforeSha: job.beforeSha,
        beforeUpdatedAt: job.beforeUpdatedAt,
        afterActive: !!after?.active,
        afterSha: after?.sha256 ? String(after.sha256) : null,
        afterUpdatedAt: after?.updatedAt ? String(after.updatedAt) : null,
      });
      if (changed && after?.active) {
        job.state = "saved";
        job.verification = {
          saved: true,
          greetingType: job.greetingType,
          pbxFileExists: true,
          sizeBytes: after.sizeBytes != null ? Number(after.sizeBytes) : null,
          updatedAt: after.updatedAt ? String(after.updatedAt) : null,
          sha256: after.sha256 ? String(after.sha256) : null,
        };
        job.error = undefined;
        touch(job);
        return;
      }
    }

    job.state = "timeout";
    job.error = {
      code: "recording_verify_timeout",
      message: "verify_timeout",
      userMessage: mapVmRecordErrorToUserMessage("recording_verify_timeout"),
      detail: { hint: "Run scripts/audit-vm-greeting-readonly.sh on the PBX if this persists." },
    };
    touch(job);
  } catch (err: any) {
    deps.log.warn({ err: String(err?.message || err), jobId }, "vm-record-call: unexpected failure");
    setError(job, "internal_error", String(err?.message || err), err);
  }
}
