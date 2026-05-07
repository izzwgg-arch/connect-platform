/**
 * Pure helpers for voicemail "Call to Record" — endpoint detection and failure mapping.
 * No I/O; safe for unit tests.
 */

export type PbxVoicemailGreetingType = "unavailable" | "busy" | "temporary" | "name";

/** Public states returned to the portal (aligned with UI phases). */
export type VmRecordClientState =
  | "preparing_call"
  | "waking_device"
  | "checking_registration"
  | "checking_endpoint"
  | "calling_extension"
  | "answer_and_follow_prompts"
  | "waiting_for_saved_greeting"
  | "saved"
  | "failed"
  | "timeout"
  | "cancelled";

export type VmRecordErrorCode =
  | "no_registered_endpoint"
  | "wake_sent_but_not_registered"
  | "pbx_helper_diag_unavailable"
  | "pbx_helper_not_configured"
  | "pbx_helper_record_call_failed"
  | "pbx_helper_voicemail_routes_missing"
  | "dialplan_context_missing"
  | "prompt_files_missing"
  | "voicemail_mailbox_path_issue"
  | "recording_verify_timeout"
  | "recording_not_saved"
  | "internal_error";

/**
 * Validate a caller-supplied PJSIP endpoint hint.
 *
 * Rules:
 *   1. Strip optional "PJSIP/" prefix (case-insensitive).
 *   2. Must match /^T\d+_\d+(?:_\d+)?$/ (no slashes, no shell chars, no spaces).
 *   3. Tenant segment must equal pbxTenantId digits.
 *   4. Extension segment must equal extensionNumber digits.
 *   5. Optional device-index suffix (_\d+) is allowed.
 *
 * Returns the cleaned endpoint string (e.g. "T21_101_2") or null when invalid.
 */
export function validateCallerSipEndpoint(
  raw: string | null | undefined,
  pbxTenantId: string,
  extensionNumber: string,
): string | null {
  if (!raw) return null;
  const cleaned = String(raw).trim().replace(/^PJSIP\//i, "");
  if (!/^T\d+_\d+(?:_\d+)?$/.test(cleaned)) return null;
  const tenantNum = String(pbxTenantId).replace(/\D/g, "");
  const extNum = String(extensionNumber).replace(/\D/g, "");
  const expected = `T${tenantNum}_${extNum}`;
  if (cleaned !== expected && !cleaned.startsWith(`${expected}_`)) return null;
  return cleaned;
}

/**
 * Parse `pjsip show contacts` (or helper-captured equivalent) for Avail contacts
 * whose endpoint name matches T{tenant}_{ext} or T{tenant}_{ext}_suffix.
 */
export function parseReachablePjsipContacts(
  pjsipOutput: string,
  pbxTenantId: string,
  extensionNumber: string,
): { ok: boolean; availEndpoints: string[] } {
  const extNum = String(extensionNumber).replace(/\D/g, "");
  const tenantNum = String(pbxTenantId).replace(/\D/g, "");
  const prefix = `T${tenantNum}_${extNum}`;
  const availEndpoints: string[] = [];
  const seen = new Set<string>();
  for (const line of pjsipOutput.split(/\r?\n/)) {
    const m = /\bContact:\s*([A-Za-z0-9_.-]+)\//i.exec(line);
    if (!m) continue;
    const ep = m[1];
    if (ep !== prefix && !ep.startsWith(`${prefix}_`)) continue;
    if (!/\b(Avail|Available)\b/i.test(line)) continue;
    if (!seen.has(ep)) {
      seen.add(ep);
      availEndpoints.push(ep);
    }
  }
  return { ok: availEndpoints.length > 0, availEndpoints };
}

export function shouldAllowOriginate(args: {
  contactOk: boolean;
  wakeSent: boolean;
  wakeRegistered: boolean;
  hadMobileDevices: boolean;
}): { allow: boolean; blockCode?: VmRecordErrorCode } {
  if (args.contactOk) return { allow: true };
  if (args.wakeRegistered) return { allow: true };
  if (args.hadMobileDevices && args.wakeSent && !args.wakeRegistered) {
    return { allow: false, blockCode: "wake_sent_but_not_registered" };
  }
  return { allow: false, blockCode: "no_registered_endpoint" };
}

/**
 * Phase B (2026-05-07): the PBX helper now ALWAYS originates through
 * `Local/<recording_exten>@connect-vm-greeting-dispatch/n` so the
 * AstDB-driven Dial fan-out rings every registered endpoint at once.
 * If `helper.channelSource` ever comes back starting with `direct_pjsip:`,
 * the helper is running an older build (pre-Phase-B) that bypassed
 * extension fan-out. We use this predicate to surface that as a
 * structured warn-log without changing control flow.
 *
 * Pure function — no I/O, safe for unit tests.
 */
export function isDirectPjsipChannelSource(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return value.startsWith("direct_pjsip:");
}

/**
 * Build the Prisma `where` shape that `sendPushToUserDevices` uses to fan
 * out a mobile push.
 *
 * Default behavior (Phase A.5 PRESERVED): when `includeInactiveDevices` is
 * `false`/undefined, the where clause includes `active: true` exactly as
 * before. Normal incoming calls, missed-call, INVITE_CANCELED/CLAIMED,
 * voicemail, sms_message, dm_message — all continue to filter to active
 * rows only. This protects logout / device-unregister semantics.
 *
 * Opt-in (Phase A.5): when `includeInactiveDevices` is `true`, the
 * `active` filter is omitted so the caller can wake devices whose rows
 * were marked inactive (e.g. by the heartbeat-expiry pass) but still
 * hold a valid Expo push token. ONLY vm-record's Call-to-Record path
 * sets this flag, via `buildVmRecordWakePushInput` below.
 *
 * Tenant + user scoping is preserved unconditionally.
 *
 * Pure function — no I/O, safe for unit tests.
 */
export function buildMobileDevicePushWhere(args: {
  tenantId: string;
  userId: string;
  includeInactiveDevices?: boolean;
}): { tenantId: string; userId: string; active?: true } {
  const where: { tenantId: string; userId: string; active?: true } = {
    tenantId: args.tenantId,
    userId: args.userId,
  };
  if (!args.includeInactiveDevices) where.active = true;
  return where;
}

/**
 * Build the input passed by `runVmRecordCallJob` to `deps.sendPush`.
 *
 * The literal `includeInactiveDevices: true` is a regression guard:
 * the unit test for this helper asserts the flag is always `true`, so
 * any future change that drops the flag will fail tests immediately.
 *
 * Pure function — no I/O, safe for unit tests.
 */
export function buildVmRecordWakePushInput(args: {
  tenantId: string;
  userId: string;
  payload: Record<string, unknown>;
}): {
  tenantId: string;
  userId: string;
  includeInactiveDevices: true;
  payload: Record<string, unknown>;
} {
  return {
    tenantId: args.tenantId,
    userId: args.userId,
    includeInactiveDevices: true,
    payload: args.payload,
  };
}

/**
 * Decide whether to send the mobile wake push for Call-to-Record.
 *
 * Phase A behavior: send the wake push whenever the user has at least one
 * MobileDevice row, REGARDLESS of:
 *   - whether the row is `active=true`
 *   - whether the PJSIP AOR for this extension is currently Avail
 *
 * Both of those signals are recorded as diagnostic context so the job's
 * public view can surface them; they no longer block the push.
 *
 * Reasoning: desktop WebRTC and the mobile app share the same SIP
 * authUsername (`T<tenant>_<ext>_1` in VitalPBX), so a registered desktop
 * makes the AOR appear Avail even when the mobile is asleep. The previous
 * gate suppressed the wake in exactly that common case, preventing
 * fan-out. The `active=true` filter additionally excludes devices that
 * haven't checked in recently — but a stale row may still hold a valid
 * Expo/FCM token and is a legitimate wake target.
 *
 * Pure function — no I/O, safe for unit tests.
 */
export function decideVmRecordWake(args: {
  deviceRowCount: number;
  activeDeviceCount: number;
  preWakeContactOk: boolean;
}): {
  attempt: boolean;
  reason: "send" | "skipped_no_devices";
  deviceRowCount: number;
  activeDeviceCount: number;
  endpointAlreadyAvail: boolean;
} {
  const attempt = args.deviceRowCount > 0;
  return {
    attempt,
    reason: attempt ? "send" : "skipped_no_devices",
    deviceRowCount: args.deviceRowCount,
    activeDeviceCount: args.activeDeviceCount,
    endpointAlreadyAvail: args.preWakeContactOk,
  };
}

export function mapVmRecordErrorToUserMessage(code: VmRecordErrorCode): string {
  switch (code) {
    case "no_registered_endpoint":
      return "Extension is not registered on the PBX (no reachable PJSIP contact). Open the mobile app or register a desk phone, then try again.";
    case "wake_sent_but_not_registered":
      return "We woke your mobile app, but SIP did not finish registering in time. Unlock the app, wait until the softphone shows registered, then try again.";
    case "pbx_helper_diag_unavailable":
      return "PBX helper does not expose voicemail diagnostics (upgrade helper), or the helper returned an error. Run scripts/audit-vm-greeting-readonly.sh on the PBX for evidence.";
    case "pbx_helper_not_configured":
      return "PBX helper is not configured for this tenant.";
    case "pbx_helper_record_call_failed":
      return "PBX helper could not start the recording call. Check helper logs and Asterisk output.";
    case "pbx_helper_voicemail_routes_missing":
      return "PBX helper is outdated or voicemail routes are missing on the helper.";
    case "dialplan_context_missing":
      return "Dialplan context for greeting recording is missing or not loaded on the PBX.";
    case "prompt_files_missing":
      return "Custom prompt sound files for greeting recording are missing on the PBX.";
    case "voicemail_mailbox_path_issue":
      return "Voicemail mailbox path was not found or could not be written on the PBX.";
    case "recording_verify_timeout":
      return "Timed out waiting for the new greeting file on the PBX. You may have hung up before saving (press 1 to save).";
    case "recording_not_saved":
      return "Recording did not produce a new saved greeting file on the PBX.";
    case "internal_error":
      return "An unexpected error occurred. Try again or contact support.";
    default:
      return "Call to record failed.";
  }
}

export function classifyHelperOriginateFailure(asteriskOutput: string, dialplanShowSnippet: string): VmRecordErrorCode | null {
  const blob = `${asteriskOutput || ""}\n${dialplanShowSnippet || ""}`.toLowerCase();
  if (!blob.trim()) return null;
  if (/unable to find extension|extension.*not found|no such context|cannot locate/i.test(blob)) {
    return "dialplan_context_missing";
  }
  if (/sound not found|no such file|unable to open.*\.wav|file does not exist.*\.wav/i.test(blob)) {
    return "prompt_files_missing";
  }
  if (/voicemail|spool|permission denied|cannot create|read-only/i.test(blob) && /fail|error|denied/i.test(blob)) {
    return "voicemail_mailbox_path_issue";
  }
  return null;
}

export function greetingFileChanged(args: {
  beforeActive: boolean;
  beforeSha: string | null;
  beforeUpdatedAt: string | null;
  afterActive: boolean;
  afterSha: string | null;
  afterUpdatedAt: string | null;
}): boolean {
  if (!args.afterActive) return false;
  if (!args.beforeActive && args.afterActive) return true;
  if (args.afterSha && args.beforeSha && args.afterSha !== args.beforeSha) return true;
  if (args.afterUpdatedAt && args.beforeUpdatedAt && args.afterUpdatedAt !== args.beforeUpdatedAt) return true;
  return false;
}
