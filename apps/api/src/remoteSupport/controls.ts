/**
 * Remote support — the controls that exist for a bad day, and the limits that
 * stop the API being ground down on an ordinary one.
 *
 * Everything here is a PURE function, for the same reason `policy.ts` is: these
 * are the decisions you most need to be able to read, test exhaustively, and
 * reason about at 3am during an incident. No database, no clock of its own, no
 * network.
 *
 * ⛔⛔ THE FOUR RULES OF THIS FILE
 *
 *  1. THE KILL SWITCH NEVER BLOCKS STOPPING. It gates starting and continuing a
 *     session and nothing else. A switch that could also refuse `end` would, in
 *     the exact emergency it exists for, leave a live session running with no way
 *     to close it. `decideEnd` in policy.ts already takes no permission; this
 *     file must not sneak one in behind it.
 *
 *  2. OFF MEANS EXISTING SESSIONS DIE, not merely that new ones are refused. A
 *     kill switch that only closes the door leaves whoever is already inside
 *     still watching. The gate is therefore consulted on heartbeat and signal
 *     too, so a live session cannot survive the switch being thrown.
 *
 *  3. REVOCATION IS A LIST, NOT A FLAG ON A ROW. A technician, a machine or a
 *     whole customer can be revoked independently, and a revocation outlives the
 *     session it was aimed at — otherwise revoking someone mid-incident only
 *     stops the session you happened to know about.
 *
 *  4. STATE LIVES IN THE DATABASE, NEVER IN A MODULE VARIABLE. This codebase has
 *     already paid for that lesson twice (the alert cooldown in a Map that
 *     re-armed on every deploy; the TURN watcher whose streak was never
 *     persisted). A deploy in the middle of an incident must not quietly switch
 *     remote support back on.
 */

/* ─────────────────────────── kill switch ─────────────────────────── */

export type RemoteSupportControlState = {
  /** False = no new sessions, and every live session ends at its next beat. */
  enabled: boolean;
  /** Shown to the technician so a refusal is never a mystery. */
  disabledReason: string | null;
};

/** Fails closed on a missing row? No — see below. */
export const DEFAULT_CONTROL_STATE: RemoteSupportControlState = {
  enabled: true,
  disabledReason: null,
};

/**
 * ⛔ THE DEFAULT IS ENABLED, DELIBERATELY, AND THIS IS THE ONE PLACE IN THIS
 * SUBSYSTEM THAT FAILS **OPEN**.
 *
 * Everywhere else here fails closed. This does not, because the thing being
 * defaulted is not an authorisation — a missing control row means "nobody has
 * ever touched the switch", not "somebody turned it off". Defaulting to disabled
 * would mean a fresh database, or one failed read, silently takes remote support
 * away with no audit trail explaining why, and the person trying to help a
 * customer would have no idea what to fix.
 *
 * The authorisation questions — may this person do this, to this machine, in
 * this tenant — are all in policy.ts and all fail closed. This flag only ever
 * SUBTRACTS from what those already allowed.
 */

export type RevocationScope = "TECHNICIAN" | "DEVICE" | "TENANT";

export type Revocation = {
  scope: RevocationScope;
  /** userId for TECHNICIAN, deviceId for DEVICE, tenantId for TENANT. */
  subjectId: string;
  reason?: string | null;
};

export type GateSubject = {
  /** The staff member asking. */
  actorUserId: string;
  /** The tenant the session belongs to (the TARGET's tenant, not the actor's). */
  tenantId: string;
  /** The machine, when we know which one. */
  deviceId?: string | null;
};

export type GateDecision = { ok: true } | { ok: false; reason: string; detail: string };

const blocked = (reason: string, detail: string): GateDecision => ({ ok: false, reason, detail });

/**
 * May remote support run at all, for this person, on this machine, right now?
 *
 * Consulted on request, consent, heartbeat, signal and input. ⛔ NEVER on end.
 *
 * Order matters only for the quality of the message: the global switch is
 * checked first because "the whole feature is off" is a more useful thing to be
 * told than "you personally are revoked", when both are true.
 */
export function decideSupportGate(input: {
  controls: RemoteSupportControlState;
  subject: GateSubject;
  revocations: readonly Revocation[];
}): GateDecision {
  const { controls, subject, revocations } = input;

  if (!controls.enabled) {
    return blocked(
      "remote_support_disabled",
      controls.disabledReason?.trim()
        ? `Remote support is switched off platform-wide: ${controls.disabledReason.trim()}`
        : "Remote support is switched off platform-wide.",
    );
  }

  for (const r of revocations) {
    if (r.scope === "TECHNICIAN" && r.subjectId === subject.actorUserId) {
      return blocked("technician_revoked", "Your remote support access has been withdrawn.");
    }
    if (r.scope === "TENANT" && r.subjectId === subject.tenantId) {
      return blocked("tenant_revoked", "Remote support is switched off for this customer.");
    }
    if (r.scope === "DEVICE" && subject.deviceId && r.subjectId === subject.deviceId) {
      return blocked("device_revoked", "Remote support is switched off for this computer.");
    }
  }

  return { ok: true };
}

/* ───────────────────── capability tiers (Phases 11, 12) ───────────── */

/**
 * The things a session can be granted, beyond looking at the screen.
 *
 * ⛔ EACH ONE IS ASKED FOR SEPARATELY AND GRANTED SEPARATELY. Control does not
 * imply clipboard; clipboard does not imply files; nothing implies elevation.
 * A customer who agreed to someone moving their mouse has not agreed to that
 * person reading what they copied.
 */
export const REMOTE_CAPABILITIES = ["view", "control", "clipboard", "files"] as const;
export type RemoteCapability = (typeof REMOTE_CAPABILITIES)[number];

export function isRemoteCapability(v: unknown): v is RemoteCapability {
  return typeof v === "string" && (REMOTE_CAPABILITIES as readonly string[]).includes(v);
}

/**
 * ⛔⛔ `admin` IS NOT IN THE LIST ABOVE, AND ITS ABSENCE IS THE FEATURE.
 *
 * Elevated control needs a Windows service running as SYSTEM, which this version
 * deliberately does not ship (see the handoff §6). The consent dialog draws the
 * row as unavailable so the customer is told the truth rather than offered
 * something that silently would not work. If that service is ever built, adding
 * "admin" here is NOT sufficient on its own — it needs its own local elevation
 * prompt, its own audit event, and its own technician role.
 */

export type CapabilityState = {
  /** What the technician asked for. */
  requested: readonly RemoteCapability[];
  /** What the customer agreed to. */
  granted: readonly RemoteCapability[];
};

/**
 * What `granted` becomes when the customer answers.
 *
 * ⛔ A capability is granted only when BOTH sides said yes: the technician asked
 * and the customer ticked. A customer offering something never requested is
 * ignored — the dialog would not have shown it, so a "yes" for it can only have
 * come from a forged request body.
 *
 * ⛔ `view` is implicit in any allowed session and is always present; there is no
 * session that grants control but not sight.
 */
export function resolveCapabilityGrant(input: {
  requested: readonly string[];
  customerAllowed: readonly string[];
  /** False when the technician does not hold `can_control_remote_support`. */
  actorMayControl: boolean;
}): RemoteCapability[] {
  const requested = new Set(input.requested.filter(isRemoteCapability));
  const allowed = new Set(input.customerAllowed.filter(isRemoteCapability));

  const out: RemoteCapability[] = ["view"];
  for (const cap of REMOTE_CAPABILITIES) {
    if (cap === "view") continue;
    if (!requested.has(cap)) continue;
    if (!allowed.has(cap)) continue;
    // ⛔ Control, clipboard and files all ride the control permission: each of
    // them lets the technician act on the machine rather than merely look at it.
    if (!input.actorMayControl) continue;
    out.push(cap);
  }
  return out;
}

/**
 * May this session use this capability right now?
 *
 * ⛔ Re-read live on every use, exactly like `decideControl`. A capability that
 * was granted ten minutes ago is not a capability that is granted now.
 */
export function decideCapability(input: {
  capability: RemoteCapability;
  granted: readonly RemoteCapability[];
  actorMayControl: boolean;
}): GateDecision {
  if (input.capability === "view") return { ok: true };

  if (!input.granted.includes(input.capability)) {
    return blocked("capability_not_granted", CAPABILITY_REFUSALS[input.capability]);
  }
  if (!input.actorMayControl) {
    return blocked("control_permission_revoked", "Your permission to act on this computer was removed.");
  }
  return { ok: true };
}

const CAPABILITY_REFUSALS: Record<RemoteCapability, string> = {
  view: "This session cannot see the screen.",
  control: "The customer allowed you to watch, but not to control.",
  clipboard: "The customer has not shared their clipboard.",
  files: "The customer has not allowed file transfer.",
};

/* ─────────────── call priority (Phase 37 — non-negotiable #15) ────── */

/**
 * ⛔⛔ REMOTE SUPPORT YIELDS TO PHONE CALLS. ALWAYS. THIS IS NOT NEGOTIABLE.
 *
 * Loopcom is a phone system that has a support tool, not a support tool that
 * happens to carry calls. When the machine or the link is under pressure, the
 * screen gets worse so the call does not. There is no configuration that
 * reverses this, and none should ever be added.
 *
 * The budget is advisory to the ENCODER (the customer's machine applies it to
 * its own outbound video track) — it is not a permission, so it can never fail
 * in a direction that blocks support entirely. The worst case is a blurry
 * screen, which is the correct worst case.
 */
export type MediaBudget = {
  maxBitrateKbps: number;
  maxFramerate: number;
  /** Longest edge, so the aspect ratio is the customer's business. */
  maxHeight: number;
  /** Why it is what it is — shown to the technician so blur is never a mystery. */
  note: string | null;
};

export const FULL_MEDIA_BUDGET: MediaBudget = {
  maxBitrateKbps: 4000,
  maxFramerate: 30,
  maxHeight: 1440,
  note: null,
};

/**
 * While a call is up the screen is capped hard: enough to read a settings
 * dialog, nowhere near enough to compete with the call for uplink.
 */
export const ON_CALL_MEDIA_BUDGET: MediaBudget = {
  maxBitrateKbps: 600,
  maxFramerate: 8,
  maxHeight: 720,
  note: "Reduced while you are on a call — Loopcom protects call quality first.",
};

/** A degraded link gets the same treatment for a different reason. */
export const CONSTRAINED_MEDIA_BUDGET: MediaBudget = {
  maxBitrateKbps: 1200,
  maxFramerate: 15,
  maxHeight: 900,
  note: "Reduced because the connection is struggling.",
};

export function decideMediaBudget(input: {
  callInProgress: boolean;
  /** 0..1, as reported by the peer connection. Optional. */
  packetLoss?: number | null;
  roundTripMs?: number | null;
}): MediaBudget {
  // ⛔ The call check is FIRST and is unconditional. Nothing below can raise the
  // budget back up, because there is no path here that returns a bigger budget
  // than the one already chosen.
  if (input.callInProgress) return ON_CALL_MEDIA_BUDGET;

  const loss = typeof input.packetLoss === "number" && Number.isFinite(input.packetLoss) ? input.packetLoss : 0;
  const rtt = typeof input.roundTripMs === "number" && Number.isFinite(input.roundTripMs) ? input.roundTripMs : 0;

  if (loss >= 0.03 || rtt >= 300) return CONSTRAINED_MEDIA_BUDGET;
  return FULL_MEDIA_BUDGET;
}

/* ───────────────── abuse protection (Phase 29) ────────────────────── */

/**
 * ⛔ WHAT THIS PROTECTS AGAINST, AND WHAT IT DOES NOT.
 *
 * It protects against: someone with a valid login grinding the request endpoint
 * to enumerate user ids, spraying consent attempts at session ids, or opening
 * sessions faster than a human could possibly need.
 *
 * It does NOT protect against an unauthenticated attacker — every one of these
 * routes is behind the platform JWT, and the global rate limiter sits in front
 * of all of them. This is the second layer, keyed on the ACTOR rather than the
 * address, because an authenticated abuser behind a corporate NAT shares an IP
 * with the customers you must not break.
 */

/** A staff member may not open sessions faster than this. */
export const REQUEST_WINDOW_MS = 5 * 60 * 1000;
export const MAX_REQUESTS_PER_WINDOW = 10;

/** How many separate people one actor may aim at inside the window. */
export const MAX_DISTINCT_TARGETS_PER_WINDOW = 6;

/** Failed consent/status probes against sessions that are not yours. */
export const PROBE_WINDOW_MS = 60 * 1000;
export const MAX_FAILED_PROBES_PER_WINDOW = 12;

export type RateDecision = { ok: true } | { ok: false; reason: string; detail: string; retryAfterMs: number };

/**
 * ⛔ TAKES THE HISTORY, RETURNS A VERDICT. It does not count, store or expire
 * anything itself — that is the caller's job with a real table. Keeping the rule
 * pure is what makes "does 11 requests in five minutes get refused" a test
 * rather than a question about a timer.
 */
export function decideRequestRate(input: {
  now: Date;
  /** Session creation times by this actor, any age; older ones are ignored. */
  recentRequestsAt: readonly Date[];
  /** Distinct target user ids inside the window, including the one being asked for now. */
  distinctTargetsInWindow: number;
}): RateDecision {
  const cutoff = input.now.getTime() - REQUEST_WINDOW_MS;
  const inWindow = input.recentRequestsAt.filter((d) => d.getTime() > cutoff);

  if (inWindow.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldest = inWindow.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
    return {
      ok: false,
      reason: "too_many_requests",
      detail: "You have opened a lot of support requests in a short time. Give it a minute.",
      retryAfterMs: Math.max(1000, oldest.getTime() + REQUEST_WINDOW_MS - input.now.getTime()),
    };
  }

  // ⛔ The enumeration guard. Ten requests at one struggling customer is
  // support; ten requests at ten different people is someone walking the
  // directory to find out who exists.
  if (input.distinctTargetsInWindow > MAX_DISTINCT_TARGETS_PER_WINDOW) {
    return {
      ok: false,
      reason: "too_many_targets",
      detail: "You have contacted a lot of different people in a short time. Give it a minute.",
      retryAfterMs: REQUEST_WINDOW_MS,
    };
  }

  return { ok: true };
}

/**
 * Guessing at session ids you are not part of.
 *
 * ⛔ Counted on REFUSALS ONLY. Counting successful polls would throttle the two
 * people legitimately in a session, who poll several times a second while a
 * connection is being negotiated.
 */
export function decideProbeRate(input: { now: Date; recentFailuresAt: readonly Date[] }): RateDecision {
  const cutoff = input.now.getTime() - PROBE_WINDOW_MS;
  const inWindow = input.recentFailuresAt.filter((d) => d.getTime() > cutoff);

  if (inWindow.length >= MAX_FAILED_PROBES_PER_WINDOW) {
    const oldest = inWindow.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
    return {
      ok: false,
      reason: "too_many_failed_lookups",
      detail: "Too many failed lookups. Try again shortly.",
      retryAfterMs: Math.max(1000, oldest.getTime() + PROBE_WINDOW_MS - input.now.getTime()),
    };
  }
  return { ok: true };
}

/* ───────────────── signalling hygiene (Phases 35, 36) ─────────────── */

/**
 * How big a signalling payload may be.
 *
 * An SDP offer for a screen share with a handful of codecs runs a few kilobytes;
 * an ICE candidate is a couple of hundred bytes. 64 KB is generous by an order of
 * magnitude and still far too small to use this table as free storage.
 *
 * ⛔ The limit exists because the signalling row is the ONE piece of a session
 * that is written to our database. Everything else rides the peer connection.
 */
export const MAX_SIGNAL_BYTES = 64 * 1024;

/** Nobody needs more than this many un-drained messages; it is a leak if they do. */
export const MAX_PENDING_SIGNALS_PER_ROLE = 60;

export type SignalCheck = { ok: true } | { ok: false; reason: string; detail: string };

/**
 * ⛔ SIZE IS MEASURED ON THE SERIALISED FORM, not on a property count. A payload
 * of `{a: "…100KB…"}` has one key. `JSON.stringify` is also what would actually
 * be stored, so it is the honest measure of the harm.
 */
export function checkSignalPayload(payload: unknown, pendingForRole: number): SignalCheck {
  if (pendingForRole >= MAX_PENDING_SIGNALS_PER_ROLE) {
    return {
      ok: false,
      reason: "signal_backlog",
      detail: "The other side is not reading. The connection was not established.",
    };
  }

  // ⛔ An EMPTY payload is refused rather than stored. An offer, an answer and an
  // ICE candidate all carry data by definition, so a signal with nothing in it
  // cannot advance a negotiation — it can only be noise, or an attempt to fill
  // the one table this feature writes to. Note this is a deliberate second
  // reason and not "unserialisable": `undefined` serialises perfectly well once
  // coalesced, so labelling it that way would have been a lie that hid the case.
  if (payload === null || payload === undefined) {
    return { ok: false, reason: "signal_empty", detail: "That message was empty." };
  }

  let serialised: string | undefined;
  try {
    serialised = JSON.stringify(payload);
  } catch {
    // Circular, or a BigInt, or something else that cannot be stored. Refuse it
    // rather than letting the write throw further down.
    return { ok: false, reason: "signal_unserialisable", detail: "That message could not be read." };
  }
  // A function or a symbol stringifies to literally `undefined`. It cannot
  // arrive over JSON, but this module is called by more than one route.
  if (serialised === undefined) {
    return { ok: false, reason: "signal_unserialisable", detail: "That message could not be read." };
  }
  if (Buffer.byteLength(serialised, "utf8") > MAX_SIGNAL_BYTES) {
    return { ok: false, reason: "signal_too_large", detail: "That message was too large to relay." };
  }
  return { ok: true };
}
