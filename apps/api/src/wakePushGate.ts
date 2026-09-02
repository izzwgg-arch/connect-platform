/**
 * One invisible WAKE push per (call, user) — the high-priority-quota gate.
 *
 * WHY: Android budgets each app's HIGH-priority FCM pushes per day by standby
 * bucket (~10/day for a rarely-opened app); overflow is silently demoted to
 * normal priority and Doze-deferred — measured as 7.5–29 s late ring pushes on
 * Relax Tires (census: docs/ai-context/AGENT_HANDOFF_HIGH_PRIORITY_PUSH_CENSUS_2026-09-01.md).
 * One inbound call used to fan out up to FOUR invisible INCOMING_CALL_WAKE
 * pushes at the same user from three senders that all converge on apps/api:
 *   S2 telephony maybePreWake  → POST /internal/mobile-prewake  (IVR entry)
 *   S3 ConnectWakeConsumer     → POST /internal/mobile-prewake  (dial time)
 *   S1 mobile-ring-notify WAKE (right before INCOMING_CALL)
 *   S5 /internal/pbx/wake-extension (legacy dialplan door)
 * The FIRST wake does the whole job — the app's consumer is idempotent
 * (SipContext re-registers only when not connected+registered), and a push
 * stuck Google-side because the device is dark is not helped by a second copy.
 *
 * ⛔ SCOPE: this gates ONLY the caller-less INCOMING_CALL_WAKE duplicates.
 * INCOMING_CALL (the ring UI), INVITE_CANCELED, INVITE_CLAIMED and every
 * visible notification are untouchable and must never consult this gate.
 * The worker's registration-watchdog wakes use synthetic per-send pbxCallIds
 * and are handled separately (NORMAL priority — see fcmDirect.ts).
 *
 * ⛔ check() and record() are deliberately SPLIT: a send site may consult other
 * gates (the prewake per-user cooldown) between them, and recording a send that
 * another gate then refuses would suppress a later legitimate wake for the
 * same call. Record only immediately before the actual send.
 *
 * Blue/green caveat (accepted in the census): two api processes = two maps,
 * so a rollout can let one duplicate wake through. State is per-process and
 * per-call — a restart merely forgets in-flight calls, never over-suppresses.
 */

export const WAKE_PUSH_GATE_TTL_MS =
  Number.parseInt(process.env.WAKE_PUSH_GATE_TTL_MS ?? "45000", 10) || 45_000;

/** Kill switch: WAKE_PUSH_GATE_DISABLED=1 restores the pre-gate fan-out. */
function gateDisabled(): boolean {
  return process.env.WAKE_PUSH_GATE_DISABLED === "1";
}

const sentAt = new Map<string, number>();

function keyFor(pbxCallId: string, userId: string): string {
  return `${pbxCallId}:${userId}`;
}

/**
 * True when a WAKE for this (call, user) should be sent — i.e. none was
 * recorded within the TTL. Pure read; never mutates state.
 * A missing/blank pbxCallId always allows: without a call identity we cannot
 * safely dedupe, and losing a wake is worse than a duplicate.
 */
export function wakePushGateCheck(
  pbxCallId: string | null | undefined,
  userId: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (gateDisabled()) return true;
  if (!pbxCallId || !userId) return true;
  const last = sentAt.get(keyFor(pbxCallId, userId)) ?? 0;
  return now - last >= WAKE_PUSH_GATE_TTL_MS;
}

/** Record that a WAKE was actually sent for this (call, user). */
export function wakePushGateRecord(
  pbxCallId: string | null | undefined,
  userId: string | null | undefined,
  now: number = Date.now(),
): void {
  if (!pbxCallId || !userId) return;
  sentAt.set(keyFor(pbxCallId, userId), now);
  // Opportunistic GC so the map cannot grow unbounded on a busy PBX.
  if (sentAt.size > 5000) {
    for (const [k, ts] of sentAt) {
      if (now - ts > WAKE_PUSH_GATE_TTL_MS * 4) sentAt.delete(k);
    }
  }
}

/** Test hook — clears all recorded sends. Never call from production code. */
export function resetWakePushGateForTests(): void {
  sentAt.clear();
}
