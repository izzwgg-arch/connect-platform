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

export type ChatThreadProbe = {
  id: string;
  type?: string | null;
  participantName?: string | null;
  lastMessage?: string | null;
  lastAt?: string | null;
  isNew?: boolean;
  externalSmsE164?: string | null;
};

export type MessageToast = { key: string; title: string; body: string; route: string };

/** Toast storm bound per poll — the pill carries the rest of the count. */
export const MAX_MESSAGE_TOASTS_PER_POLL = 3;

/**
 * Decide which Windows toasts one poll of /chat/threads should produce.
 *
 * ⛔ Detection is per MESSAGE — keyed on (threadId, lastAt) — never a diff of
 * thread IDS. The old thread-id diff fired only when a brand-new phone number
 * texted for the first time, so a message in an EXISTING conversation never
 * produced a Windows notification at all (FixUp Group, 2026-08-30: "the
 * Windows app isn't getting incoming messages" — the phones buzzed, Windows
 * stayed silent). It also read /sms/messages, which collapses every
 * inbound thread into one entry keyed by the tenant's OWN number.
 *
 * `isNew` is the server's tenant-shared unread verdict, so the caller's own
 * outbound reply moves `lastAt` without toasting (isNew stays false), and a
 * thread someone already read never re-fires.
 *
 * The first poll (previous === null) is a BASELINE: messages that arrived
 * while the app was closed show in the pill/bell, not as a login toast storm.
 */
export function decideMessageToasts(
  previous: Map<string, string> | null,
  threads: ChatThreadProbe[],
): { next: Map<string, string>; toasts: MessageToast[] } {
  const next = new Map<string, string>();
  for (const t of threads) {
    if (t && t.id) next.set(t.id, String(t.lastAt || ""));
  }
  const toasts: MessageToast[] = [];
  if (previous) {
    for (const t of threads) {
      if (toasts.length >= MAX_MESSAGE_TOASTS_PER_POLL) break;
      if (!t || !t.id || !t.isNew) continue;
      const lastAt = String(t.lastAt || "");
      if (!lastAt) continue;
      if (previous.get(t.id) === lastAt) continue;
      toasts.push({
        key: `msg:${t.id}:${lastAt}`,
        title: (t.participantName || "").trim() || "New message",
        body: (t.lastMessage || "").trim() || "New message",
        route: t.type === "SMS" && t.externalSmsE164 ? `/sms?phone=${encodeURIComponent(t.externalSmsE164)}` : "/chat",
      });
    }
  }
  return { next, toasts };
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
