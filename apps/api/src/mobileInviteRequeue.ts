/**
 * Idempotent mobile-invite AMI requeue helpers.
 * Prevents infinite requeue loops while allowing register-complete + accept paths.
 */

const REQUEUE_TTL_MS = 120_000;
const REQUEUE_MAX_ATTEMPTS = 4;

type RequeueEntry = { count: number; lastAt: number };

const recentRequeues = new Map<string, RequeueEntry>();

export function resetMobileInviteRequeueGuardForTests(): void {
  recentRequeues.clear();
}

export function canAttemptMobileInviteRequeue(linkedId: string): boolean {
  const key = String(linkedId || "").trim();
  if (!key) return false;
  const now = Date.now();
  const entry = recentRequeues.get(key);
  if (!entry) return true;
  if (now - entry.lastAt > REQUEUE_TTL_MS) {
    recentRequeues.delete(key);
    return true;
  }
  return entry.count < REQUEUE_MAX_ATTEMPTS;
}

export function markMobileInviteRequeueAttempt(linkedId: string): void {
  const key = String(linkedId || "").trim();
  if (!key) return;
  const now = Date.now();
  const prev = recentRequeues.get(key);
  if (!prev || now - prev.lastAt > REQUEUE_TTL_MS) {
    recentRequeues.set(key, { count: 1, lastAt: now });
    return;
  }
  recentRequeues.set(key, { count: prev.count + 1, lastAt: now });
}

export type PendingMobileInviteRow = {
  id: string;
  pbxCallId: string | null;
  toExtension: string;
  status: string;
};

/** Returns true when a PENDING invite exists and is eligible for AMI requeue. */
export function isPendingMobileInviteEligible(
  invite: PendingMobileInviteRow | null | undefined,
): invite is PendingMobileInviteRow {
  if (!invite) return false;
  if (invite.status !== "PENDING") return false;
  return !!String(invite.pbxCallId || "").trim();
}

export type RequeueTrigger = "accept" | "register_complete";

export function requeueTriggerLabel(trigger: RequeueTrigger): string {
  return trigger === "register_complete" ? "device_register_complete" : "invite_accept";
}

/** Resolve correlation IDs from mobile flight upload body (meta.inviteId fallback). */
export function resolveFlightUploadSessionIds(session: Record<string, unknown>): {
  inviteId: string | null;
  pbxCallId: string | null;
  linkedId: string | null;
} {
  const meta = (session.meta ?? {}) as Record<string, unknown>;
  const inviteIdRaw = session.inviteId ?? meta.inviteId;
  const pbxCallIdRaw = session.pbxCallId ?? meta.pbxCallId;
  const linkedIdRaw = session.linkedId ?? meta.linkedId ?? pbxCallIdRaw;
  const inviteId = inviteIdRaw ? String(inviteIdRaw).slice(0, 128) : null;
  const pbxCallId = pbxCallIdRaw ? String(pbxCallIdRaw).slice(0, 128) : null;
  const linkedId = linkedIdRaw ? String(linkedIdRaw).slice(0, 128) : null;
  return { inviteId, pbxCallId, linkedId };
}
