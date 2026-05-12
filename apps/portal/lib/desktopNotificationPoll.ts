/**
 * Connect Desktop notification poller helpers — keep API probes valid and
 * avoid hammering 4xx/5xx endpoints (see DesktopNotificationsBridge).
 */

const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 30 * 60 * 1000;
const COOLDOWN_EXP_CAP = 6;

export type DesktopNotificationProbe = "sms" | "voicemail";

export class NotificationProbeBackoff {
  private failures: Record<DesktopNotificationProbe, number> = { sms: 0, voicemail: 0 };
  private cooldownUntil: Record<DesktopNotificationProbe, number> = { sms: 0, voicemail: 0 };

  shouldSkip(kind: DesktopNotificationProbe, now = Date.now()): boolean {
    return now < this.cooldownUntil[kind];
  }

  recordSuccess(kind: DesktopNotificationProbe): void {
    this.failures[kind] = 0;
    this.cooldownUntil[kind] = 0;
  }

  /** Apply exponential backoff after HTTP error (4xx/5xx) or transport failure (use 599). */
  recordFailure(kind: DesktopNotificationProbe, _status: number): void {
    this.failures[kind] += 1;
    const ms = nextCooldownMsForFailure(this.failures[kind]);
    this.cooldownUntil[kind] = Date.now() + ms;
  }
}

export function nextCooldownMsForFailure(failureCountAfterIncrement: number): number {
  const exp = Math.min(Math.max(failureCountAfterIncrement - 1, 0), COOLDOWN_EXP_CAP);
  return Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** exp);
}

/**
 * Build GET /voice/voicemail query for desktop inbox probe.
 * SUPER_ADMIN requires a concrete workspace tenantId (server returns 400 otherwise).
 */
export function buildDesktopVoicemailInboxProbePath(input: {
  folder: "inbox" | "old" | "urgent";
  page: number;
  tenantId: string | null | undefined;
  backendJwtRole: string | undefined;
}): string | null {
  const role = String(input.backendJwtRole || "").trim();
  const tid = String(input.tenantId || "").trim();
  const params = new URLSearchParams();
  params.set("folder", input.folder);
  params.set("page", String(Math.max(1, Math.floor(input.page))));

  if (role === "SUPER_ADMIN") {
    if (!tid || tid === "local") return null;
    params.set("tenantId", tid);
  }

  return `/voice/voicemail?${params.toString()}`;
}
