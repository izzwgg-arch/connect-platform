/**
 * Reading and writing the remote-support controls.
 *
 * The DECISIONS live in `controls.ts` and are pure. This file is only the thin
 * layer that fetches the facts those decisions need and records the operator's
 * intent. Keep it that way: an `if` about who may do what belongs next door.
 *
 * ⛔ WHY THERE IS A CACHE, AND WHY IT IS SO SHORT
 *
 * The gate is consulted on request, consent, heartbeat, signal and input — so on
 * a busy session it runs several times a second per participant. Two rows read
 * from Postgres at that rate is pointless load. But the whole value of a kill
 * switch is that it takes effect NOW, so the cache is measured in seconds, not
 * minutes, and it is invalidated in-process the moment this process is the one
 * that threw the switch.
 *
 * ⛔ The cache is per-process and blue/green runs two. That is why the TTL is the
 * real bound and the invalidation is only an optimisation — never the other way
 * round. Same reasoning as the portal permission cache.
 */
import { db } from "@connect/db";
import {
  DEFAULT_CONTROL_STATE,
  type RemoteSupportControlState,
  type Revocation,
  type RevocationScope,
} from "./controls";

export const CONTROL_ID = "global";

/**
 * How stale the kill switch may be. Five seconds: short enough that "I turned it
 * off" is true within one heartbeat, long enough that a live session is not
 * hammering the row.
 */
const CACHE_TTL_MS = 5_000;

type Cached = { at: number; controls: RemoteSupportControlState; revocations: Revocation[] };
let cache: Cached | null = null;

/** Drop the cache in this process. Called after any write. */
export function invalidateRemoteSupportControls(): void {
  cache = null;
}

/**
 * ⛔ ON A READ FAILURE THIS RETURNS THE *SAFE* ANSWER, WHICH IS NOT THE SAME AS
 * THE PERMISSIVE ONE.
 *
 * A database error means we cannot know whether the switch is off or whether
 * someone is revoked. Answering "enabled, nobody revoked" would let a revoked
 * technician through during exactly the outage an attacker would engineer. So a
 * failed read yields DISABLED with an honest reason — the feature becomes
 * unavailable rather than unguarded.
 *
 * ⛔ This is the opposite default from a MISSING ROW, and the difference is the
 * point: no row means nobody ever touched the switch; a throw means we do not
 * know. Absence of a setting is a fact. Absence of an answer is not.
 */
export async function loadRemoteSupportControls(): Promise<{
  controls: RemoteSupportControlState;
  revocations: Revocation[];
}> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return { controls: cache.controls, revocations: cache.revocations };
  }

  try {
    const [row, revs] = await Promise.all([
      db.remoteSupportControl.findUnique({ where: { id: CONTROL_ID } }),
      db.remoteSupportRevocation.findMany({
        where: { liftedAt: null },
        select: { scope: true, subjectId: true, reason: true },
        // A sane ceiling. If anyone ever revokes more than this, the gate would
        // silently stop matching the tail — so the cap is far above any real
        // incident and the count is worth alarming on separately.
        take: 5_000,
      }),
    ]);

    const controls: RemoteSupportControlState = row
      ? { enabled: row.enabled, disabledReason: row.disabledReason ?? null }
      : DEFAULT_CONTROL_STATE;

    const revocations: Revocation[] = revs.map((r) => ({
      scope: r.scope as RevocationScope,
      subjectId: r.subjectId,
      reason: r.reason ?? null,
    }));

    cache = { at: now, controls, revocations };
    return { controls, revocations };
  } catch (err) {
    // ⛔ Loud. A gate that cannot read its own state is an incident, and a
    // swallowed catch here is how it becomes an invisible one.
    console.error("[REMOTE_SUPPORT] control state unreadable — failing closed", err);
    return {
      controls: {
        enabled: false,
        disabledReason: "Loopcom could not confirm that remote support is switched on.",
      },
      revocations: [],
    };
  }
}

/** Throw or lift the global switch. */
export async function setRemoteSupportEnabled(input: {
  enabled: boolean;
  reason?: string | null;
  byUserId: string;
}): Promise<RemoteSupportControlState> {
  const now = new Date();
  const reason = input.enabled ? null : (input.reason || "").trim().slice(0, 300) || null;

  const row = await db.remoteSupportControl.upsert({
    where: { id: CONTROL_ID },
    create: {
      id: CONTROL_ID,
      enabled: input.enabled,
      disabledReason: reason,
      disabledByUserId: input.enabled ? null : input.byUserId,
      disabledAt: input.enabled ? null : now,
    },
    update: {
      enabled: input.enabled,
      disabledReason: reason,
      disabledByUserId: input.enabled ? null : input.byUserId,
      disabledAt: input.enabled ? null : now,
    },
  });

  invalidateRemoteSupportControls();
  return { enabled: row.enabled, disabledReason: row.disabledReason ?? null };
}

export async function addRemoteSupportRevocation(input: {
  scope: RevocationScope;
  subjectId: string;
  reason?: string | null;
  byUserId: string;
}) {
  const row = await db.remoteSupportRevocation.create({
    data: {
      scope: input.scope,
      subjectId: input.subjectId,
      reason: (input.reason || "").trim().slice(0, 300) || null,
      createdByUserId: input.byUserId,
    },
  });
  invalidateRemoteSupportControls();
  return row;
}

export async function liftRemoteSupportRevocation(input: { id: string; byUserId: string }) {
  // Guarded on still being live, so two operators lifting at once cannot
  // overwrite each other's record of who did it.
  const res = await db.remoteSupportRevocation.updateMany({
    where: { id: input.id, liftedAt: null },
    data: { liftedAt: new Date(), liftedByUserId: input.byUserId },
  });
  invalidateRemoteSupportControls();
  return res.count > 0;
}

/**
 * End live sessions in bulk, for the kill switch and the revoke actions.
 *
 * ⛔ THIS IS THE HALF THAT MAKES A KILL SWITCH REAL. Refusing new sessions while
 * leaving the running one connected is not switching the feature off — it is
 * closing the door behind the person already inside.
 *
 * Returns how many it actually closed, so the operator is told a number rather
 * than "done".
 */
export async function endRemoteSupportSessions(input: {
  reason: string;
  endedBy: string;
  /** Omit to end everything live. */
  where?: { tenantId?: string; requestedByUserId?: string; deviceId?: string; id?: string };
}): Promise<number> {
  const now = new Date();
  const res = await db.remoteSupportSession.updateMany({
    where: {
      status: { in: ["REQUESTED", "CONSENTED", "ACTIVE"] },
      ...(input.where?.tenantId ? { tenantId: input.where.tenantId } : {}),
      ...(input.where?.requestedByUserId ? { requestedByUserId: input.where.requestedByUserId } : {}),
      ...(input.where?.deviceId ? { deviceId: input.where.deviceId } : {}),
      ...(input.where?.id ? { id: input.where.id } : {}),
    },
    data: {
      status: "ENDED",
      endedAt: now,
      endedReason: input.reason.slice(0, 200),
      endedBy: input.endedBy.slice(0, 60),
    },
  });
  return res.count;
}
