/**
 * Remote support — every decision about who may watch, who may type, and when a
 * session dies. Pure functions on purpose: this is the most invasive capability
 * on the platform, and the rules that keep it safe should be readable and
 * testable without a database, a socket or a browser.
 *
 * ⛔ THE FOUR RULES. Everything below is one of these:
 *
 *  1. Only the person whose screen it is may consent. Not their manager, not a
 *     tenant admin, not Connect. There is no standing consent and no "always
 *     allow" — a support session is agreed to one at a time, every time.
 *
 *  2. Control is consented SEPARATELY from viewing, and a view-only session can
 *     never become a control session. Upgrading requires a new session, which
 *     means a new dialog the customer has to read.
 *
 *  3. Permission is re-checked at every step, not just at request time. If the
 *     staff member's access is revoked mid-session, the next thing they do
 *     fails. (Same shape as the agent capabilities re-authorising at execution
 *     time rather than trusting the approval that started them.)
 *
 *  4. Silence ends the session. Both sides heartbeat; if either goes quiet the
 *     session is over. A session that outlives the window showing the "your
 *     screen is being shared" banner is a screen being watched with nobody's
 *     banner up, and that must be impossible rather than unlikely.
 */

/** A request nobody answers must die quickly rather than sit armed. */
export const REQUEST_TTL_MS = 2 * 60 * 1000;

/**
 * How long either side may go quiet before the session is considered dead.
 * Deliberately short. Both sides heartbeat every ~10s, so this tolerates two
 * missed beats and no more.
 */
export const HEARTBEAT_STALE_MS = 35 * 1000;

/**
 * Hard ceiling regardless of heartbeats. A support call that has been running
 * for four hours is a forgotten window, not a support call.
 */
export const MAX_SESSION_MS = 4 * 60 * 60 * 1000;

/** Signals older than this are junk from an abandoned negotiation. */
export const SIGNAL_TTL_MS = 5 * 60 * 1000;

export type RemoteSupportRole = "ADMIN" | "CLIENT";

export type SessionStatus =
  | "REQUESTED"
  | "CONSENTED"
  | "ACTIVE"
  | "ENDED"
  | "DECLINED"
  | "EXPIRED";

/** The subset of a session row every decision here needs. */
export type SessionFacts = {
  id: string;
  tenantId: string;
  targetUserId: string;
  requestedByUserId: string;
  status: SessionStatus;
  controlRequested: boolean;
  controlGranted: boolean;
  expiresAt: Date;
  startedAt: Date | null;
  lastSeenAdminAt: Date | null;
  lastSeenClientAt: Date | null;
};

export type ActorFacts = {
  userId: string;
  tenantId: string;
  isSuperAdmin: boolean;
  /** Effective right now — never the value cached when the session started. */
  canRemoteSupport: boolean;
  canControl: boolean;
};

/** Statuses from which no further progress is possible. */
const TERMINAL: ReadonlySet<SessionStatus> = new Set(["ENDED", "DECLINED", "EXPIRED"]);

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * Has this session run out of road? Covers all three ways: an unanswered
 * request timing out, either side going silent, and the hard ceiling.
 *
 * ⛔ Returns a REASON, not a boolean, because "the customer closed their laptop"
 * and "you were disconnected" are different things to put on screen, and an
 * honest reason is what stops a support person retrying against a session that
 * is never coming back.
 */
export function sessionLapseReason(session: SessionFacts, now: Date): string | null {
  if (isTerminal(session.status)) return null;

  if (session.status === "REQUESTED") {
    return now.getTime() > session.expiresAt.getTime() ? "no_answer" : null;
  }

  // CONSENTED or ACTIVE.
  if (session.startedAt && now.getTime() - session.startedAt.getTime() > MAX_SESSION_MS) {
    return "max_duration";
  }

  // Heartbeats only bind once the session is live. Between consent and the
  // first beat there is a legitimate gap while the peer connection is built.
  if (session.status === "ACTIVE") {
    const adminSilent =
      !session.lastSeenAdminAt || now.getTime() - session.lastSeenAdminAt.getTime() > HEARTBEAT_STALE_MS;
    const clientSilent =
      !session.lastSeenClientAt || now.getTime() - session.lastSeenClientAt.getTime() > HEARTBEAT_STALE_MS;
    if (clientSilent) return "customer_disconnected";
    if (adminSilent) return "support_disconnected";
  }

  return null;
}

export type Decision = { ok: true } | { ok: false; reason: string };

const deny = (reason: string): Decision => ({ ok: false, reason });
const allow: Decision = { ok: true };

/**
 * May this actor open a session against this target?
 *
 * Tenant scoping is the quiet half: a custom-role grantee inside a tenant may
 * only reach their own colleagues. Only a super admin crosses tenants, and
 * that is exactly the platform-support case this feature exists for.
 */
export function decideRequest(input: {
  actor: ActorFacts;
  targetUserId: string;
  targetTenantId: string;
  requestControl: boolean;
  reason: string;
}): Decision {
  const { actor } = input;

  if (!actor.canRemoteSupport) return deny("missing_permission");

  // ⛔ Asking for control requires the control key at REQUEST time as well as
  // at use time. Without this a viewer could raise a control request the
  // customer would then be invited to approve — the dialog would offer
  // something the requester was never allowed to have.
  if (input.requestControl && !actor.canControl) return deny("missing_control_permission");

  if (!actor.isSuperAdmin && actor.tenantId !== input.targetTenantId) {
    return deny("cross_tenant_not_allowed");
  }

  // Watching your own screen is pointless and makes the audit trail lie.
  if (actor.userId === input.targetUserId) return deny("cannot_target_self");

  const reason = String(input.reason || "").trim();
  if (reason.length < 3) return deny("reason_required");
  if (reason.length > 300) return deny("reason_too_long");

  return allow;
}

/**
 * May this actor answer the consent prompt?
 *
 * ⛔ The single most important check in the file. Consent belongs to the person
 * whose screen it is and to nobody else — a tenant admin approving on their
 * employee's behalf is precisely the abuse this design refuses.
 */
export function decideConsent(input: {
  actor: { userId: string };
  session: SessionFacts;
  now: Date;
}): Decision {
  const { session } = input;

  if (input.actor.userId !== session.targetUserId) return deny("not_your_session");
  if (isTerminal(session.status)) return deny("session_over");
  if (session.status !== "REQUESTED") return deny("already_answered");
  if (input.now.getTime() > session.expiresAt.getTime()) return deny("expired");

  return allow;
}

/**
 * What `controlGranted` becomes when the customer answers.
 *
 * Control requires BOTH sides to have said yes: the admin asked for it and the
 * customer ticked it. Anything else is view-only, including a customer who
 * offers control that was never requested.
 */
export function resolveControlGrant(input: {
  controlRequested: boolean;
  customerAllowedControl: boolean;
}): boolean {
  return input.controlRequested === true && input.customerAllowedControl === true;
}

/**
 * May this actor act on a live session, and in which role?
 *
 * This is the gate that runs on every signal, every heartbeat and every input
 * event, which is why it re-reads permissions rather than trusting the session.
 */
export function decideParticipation(input: {
  actor: ActorFacts;
  session: SessionFacts;
  now: Date;
}): { ok: true; role: RemoteSupportRole } | { ok: false; reason: string } {
  const { actor, session, now } = input;

  if (isTerminal(session.status)) return { ok: false, reason: "session_over" };

  const lapse = sessionLapseReason(session, now);
  if (lapse) return { ok: false, reason: lapse };

  if (actor.userId === session.targetUserId) {
    // The customer never needs a permission to participate in a session about
    // their own machine — they are the one being helped.
    return { ok: true, role: "CLIENT" };
  }

  if (actor.userId === session.requestedByUserId) {
    // ⛔ Re-checked live. Revoking someone's access mid-session ends it at
    // their next action rather than whenever they happen to close the window.
    if (!actor.canRemoteSupport) return { ok: false, reason: "permission_revoked" };
    if (!actor.isSuperAdmin && actor.tenantId !== session.tenantId) {
      return { ok: false, reason: "cross_tenant_not_allowed" };
    }
    return { ok: true, role: "ADMIN" };
  }

  // Deliberately no "any super admin may join". A session is between two named
  // people, and a third party appearing in someone's support call is not
  // something the customer consented to.
  return { ok: false, reason: "not_a_participant" };
}

/**
 * May this actor actually inject mouse and keyboard right now?
 *
 * Every condition is required, and they are checked in the order that produces
 * the most useful refusal.
 */
export function decideControl(input: {
  actor: ActorFacts;
  session: SessionFacts;
  now: Date;
}): Decision {
  const participation = decideParticipation(input);
  if (!participation.ok) return deny(participation.reason);
  if (participation.role !== "ADMIN") return deny("only_support_may_control");

  if (!input.session.controlGranted) return deny("control_not_granted");
  // The live key, again — revoking control alone must stop the typing without
  // ending the view.
  if (!input.actor.canControl) return deny("control_permission_revoked");
  if (input.session.status !== "ACTIVE") return deny("session_not_active");

  return allow;
}

/**
 * Either participant may hang up, always, without a permission check.
 *
 * ⛔ The customer's ability to end the session must never depend on anything
 * that can fail. A stop button that consults a permission is a stop button that
 * can refuse.
 */
export function decideEnd(input: {
  actor: { userId: string; isSuperAdmin: boolean };
  session: SessionFacts;
}): Decision {
  if (isTerminal(input.session.status)) return deny("already_ended");
  const isParticipant =
    input.actor.userId === input.session.targetUserId ||
    input.actor.userId === input.session.requestedByUserId;
  // A super admin may end anyone's session — stopping is always safe to allow.
  if (!isParticipant && !input.actor.isSuperAdmin) return deny("not_a_participant");
  return allow;
}

/** Which side's signals should this participant be reading? */
export function counterpartRole(role: RemoteSupportRole): RemoteSupportRole {
  return role === "ADMIN" ? "CLIENT" : "ADMIN";
}

/**
 * A short, human sentence for a refusal, so screens never print a slug at a
 * customer. Same lesson as the IVR publish errors: the server knows why, and
 * dropping that on the floor is what turns a clear failure into a mystery.
 */
export function explainReason(reason: string): string {
  const map: Record<string, string> = {
    missing_permission: "You do not have permission to start a remote support session.",
    missing_control_permission: "You can view screens, but you are not allowed to request control.",
    cross_tenant_not_allowed: "That person is not in your company.",
    cannot_target_self: "You cannot start a remote support session with yourself.",
    reason_required: "Tell the customer why you need to connect — they see this before they decide.",
    reason_too_long: "That reason is too long. Keep it to a sentence or two.",
    not_your_session: "Only the person whose screen it is can answer this.",
    session_over: "This session has already finished.",
    already_answered: "This request has already been answered.",
    already_ended: "This session has already finished.",
    expired: "This request timed out before it was answered.",
    no_answer: "Nobody answered the request.",
    max_duration: "The session reached its four-hour limit and was closed.",
    customer_disconnected: "The customer's computer disconnected.",
    support_disconnected: "The support connection dropped.",
    permission_revoked: "Your remote support access was removed.",
    control_not_granted: "The customer allowed you to watch, but not to control.",
    control_permission_revoked: "Your permission to control was removed.",
    session_not_active: "The connection is not live yet.",
    only_support_may_control: "Only the support side can control.",
    not_a_participant: "You are not part of this session.",
  };
  return map[reason] || "That is not allowed right now.";
}
