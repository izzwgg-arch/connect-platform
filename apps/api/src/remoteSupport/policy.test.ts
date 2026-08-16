import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideConsent,
  decideControl,
  decideEnd,
  decideParticipation,
  decideRequest,
  explainReason,
  counterpartRole,
  isTerminal,
  resolveControlGrant,
  sessionLapseReason,
  HEARTBEAT_STALE_MS,
  MAX_SESSION_MS,
  type ActorFacts,
  type SessionFacts,
  type SessionStatus,
} from "./policy";

/**
 * The security core of remote support.
 *
 * Every test here corresponds to a way this feature could be abused or could
 * silently keep watching a screen after it should have stopped. If one of these
 * goes red, do not "fix" it by relaxing the assertion.
 */

const NOW = new Date("2026-08-16T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function session(over: Partial<SessionFacts> = {}): SessionFacts {
  return {
    id: "sess_1",
    tenantId: "tenant_a",
    targetUserId: "customer_1",
    requestedByUserId: "staff_1",
    status: "ACTIVE",
    controlRequested: true,
    controlGranted: true,
    expiresAt: new Date(NOW.getTime() + 60_000),
    startedAt: ago(60_000),
    lastSeenAdminAt: ago(1_000),
    lastSeenClientAt: ago(1_000),
    ...over,
  };
}

function staff(over: Partial<ActorFacts> = {}): ActorFacts {
  return {
    userId: "staff_1",
    tenantId: "tenant_a",
    isSuperAdmin: false,
    canRemoteSupport: true,
    canControl: true,
    ...over,
  };
}

const customer: ActorFacts = {
  userId: "customer_1",
  tenantId: "tenant_a",
  isSuperAdmin: false,
  canRemoteSupport: false,
  canControl: false,
};

// ── Requesting ──────────────────────────────────────────────────────────────

test("a staff member with the key may request a view-only session", () => {
  const d = decideRequest({
    actor: staff({ canControl: false }),
    targetUserId: "customer_1",
    targetTenantId: "tenant_a",
    requestControl: false,
    reason: "Phone will not register",
  });
  assert.equal(d.ok, true);
});

test("⛔ no permission means no session, however good the reason", () => {
  const d = decideRequest({
    actor: staff({ canRemoteSupport: false }),
    targetUserId: "customer_1",
    targetTenantId: "tenant_a",
    requestControl: false,
    reason: "Phone will not register",
  });
  assert.deepEqual(d, { ok: false, reason: "missing_permission" });
});

test("⛔ a viewer cannot even ASK for control", () => {
  // If this passed, the customer would be shown a dialog offering control to
  // someone who was never allowed to have it.
  const d = decideRequest({
    actor: staff({ canControl: false }),
    targetUserId: "customer_1",
    targetTenantId: "tenant_a",
    requestControl: true,
    reason: "Need to fix the settings",
  });
  assert.deepEqual(d, { ok: false, reason: "missing_control_permission" });
});

test("⛔ a tenant-scoped grantee cannot reach another company", () => {
  const d = decideRequest({
    actor: staff({ tenantId: "tenant_a" }),
    targetUserId: "customer_2",
    targetTenantId: "tenant_b",
    requestControl: false,
    reason: "Support",
  });
  assert.deepEqual(d, { ok: false, reason: "cross_tenant_not_allowed" });
});

test("a super admin may cross tenants — that is the platform-support case", () => {
  const d = decideRequest({
    actor: staff({ isSuperAdmin: true, tenantId: "connect" }),
    targetUserId: "customer_2",
    targetTenantId: "tenant_b",
    requestControl: true,
    reason: "Provisioning their desk phones",
  });
  assert.equal(d.ok, true);
});

test("a reason is required, and it must say something", () => {
  for (const reason of ["", "   ", "hi"]) {
    const d = decideRequest({
      actor: staff(),
      targetUserId: "customer_1",
      targetTenantId: "tenant_a",
      requestControl: false,
      reason,
    });
    assert.deepEqual(d, { ok: false, reason: "reason_required" }, `"${reason}" should be refused`);
  }
});

test("you cannot open a session against yourself", () => {
  const d = decideRequest({
    actor: staff({ userId: "customer_1" }),
    targetUserId: "customer_1",
    targetTenantId: "tenant_a",
    requestControl: false,
    reason: "Testing my own machine",
  });
  assert.deepEqual(d, { ok: false, reason: "cannot_target_self" });
});

// ── Consent ─────────────────────────────────────────────────────────────────

test("⛔ ONLY the person whose screen it is may consent", () => {
  const s = session({ status: "REQUESTED" });

  assert.equal(decideConsent({ actor: { userId: "customer_1" }, session: s, now: NOW }).ok, true);

  // The requester approving their own request would defeat the entire design.
  assert.deepEqual(
    decideConsent({ actor: { userId: "staff_1" }, session: s, now: NOW }),
    { ok: false, reason: "not_your_session" },
  );
  // A colleague, a manager, a tenant admin — all the same answer.
  assert.deepEqual(
    decideConsent({ actor: { userId: "their_boss" }, session: s, now: NOW }),
    { ok: false, reason: "not_your_session" },
  );
});

test("a request that timed out cannot be consented to afterwards", () => {
  const s = session({ status: "REQUESTED", expiresAt: ago(1) });
  assert.deepEqual(
    decideConsent({ actor: { userId: "customer_1" }, session: s, now: NOW }),
    { ok: false, reason: "expired" },
  );
});

test("a declined session is terminal — it can never be consented to later", () => {
  const s = session({ status: "DECLINED" });
  assert.deepEqual(
    decideConsent({ actor: { userId: "customer_1" }, session: s, now: NOW }),
    { ok: false, reason: "session_over" },
  );
});

test("consent cannot be given twice", () => {
  const s = session({ status: "CONSENTED" });
  assert.deepEqual(
    decideConsent({ actor: { userId: "customer_1" }, session: s, now: NOW }),
    { ok: false, reason: "already_answered" },
  );
});

// ── Control grant ───────────────────────────────────────────────────────────

test("⛔ control requires BOTH sides to say yes", () => {
  assert.equal(resolveControlGrant({ controlRequested: true, customerAllowedControl: true }), true);
  // Customer allowed viewing only.
  assert.equal(resolveControlGrant({ controlRequested: true, customerAllowedControl: false }), false);
  // ⛔ The customer cannot hand over control that was never asked for — this is
  // what stops a view-only session quietly becoming a control session.
  assert.equal(resolveControlGrant({ controlRequested: false, customerAllowedControl: true }), false);
  assert.equal(resolveControlGrant({ controlRequested: false, customerAllowedControl: false }), false);
});

// ── Participation and live permission re-checks ─────────────────────────────

test("the customer is always a participant in a session about their own machine", () => {
  const d = decideParticipation({ actor: customer, session: session(), now: NOW });
  assert.deepEqual(d, { ok: true, role: "CLIENT" });
});

test("⛔ revoking the staff member's permission ends it at their next action", () => {
  // The session was legitimately started. The key was then taken away.
  const d = decideParticipation({
    actor: staff({ canRemoteSupport: false }),
    session: session(),
    now: NOW,
  });
  assert.deepEqual(d, { ok: false, reason: "permission_revoked" });
});

test("⛔ a third party cannot join someone else's support session", () => {
  const d = decideParticipation({
    actor: staff({ userId: "another_admin", isSuperAdmin: true }),
    session: session(),
    now: NOW,
  });
  // Even a super admin. The customer consented to one named person.
  assert.deepEqual(d, { ok: false, reason: "not_a_participant" });
});

// ── Lapsing: the ways a session must die on its own ──────────────────────────

test("an unanswered request lapses at its expiry", () => {
  assert.equal(sessionLapseReason(session({ status: "REQUESTED", expiresAt: ago(1) }), NOW), "no_answer");
  assert.equal(sessionLapseReason(session({ status: "REQUESTED" }), NOW), null);
});

test("⛔ the customer going quiet ends the session", () => {
  // This is the one that matters: if the customer's app dies, the banner they
  // were shown is gone, so the watching must stop too.
  const s = session({ lastSeenClientAt: ago(HEARTBEAT_STALE_MS + 1_000) });
  assert.equal(sessionLapseReason(s, NOW), "customer_disconnected");
});

test("the support side going quiet also ends it", () => {
  const s = session({ lastSeenAdminAt: ago(HEARTBEAT_STALE_MS + 1_000) });
  assert.equal(sessionLapseReason(s, NOW), "support_disconnected");
});

test("the customer's disconnect is reported ahead of the admin's", () => {
  // Both silent — the customer's machine is the more useful thing to say.
  const s = session({
    lastSeenClientAt: ago(HEARTBEAT_STALE_MS + 5_000),
    lastSeenAdminAt: ago(HEARTBEAT_STALE_MS + 5_000),
  });
  assert.equal(sessionLapseReason(s, NOW), "customer_disconnected");
});

test("a healthy live session does not lapse", () => {
  assert.equal(sessionLapseReason(session(), NOW), null);
});

test("heartbeats do not bind before the session is live", () => {
  // Between consent and the first beat there is a real gap while the peer
  // connection is negotiated; treating that as death would make connecting
  // impossible.
  const s = session({ status: "CONSENTED", lastSeenAdminAt: null, lastSeenClientAt: null });
  assert.equal(sessionLapseReason(s, NOW), null);
});

test("the four-hour ceiling closes a forgotten window", () => {
  const s = session({ startedAt: ago(MAX_SESSION_MS + 1_000) });
  assert.equal(sessionLapseReason(s, NOW), "max_duration");
});

test("terminal sessions report no lapse reason — they are already over", () => {
  for (const status of ["ENDED", "DECLINED", "EXPIRED"] as SessionStatus[]) {
    assert.equal(sessionLapseReason(session({ status }), NOW), null);
    assert.equal(isTerminal(status), true);
  }
  for (const status of ["REQUESTED", "CONSENTED", "ACTIVE"] as SessionStatus[]) {
    assert.equal(isTerminal(status), false);
  }
});

// ── Control at the moment of typing ─────────────────────────────────────────

test("control is allowed only with every condition satisfied", () => {
  assert.equal(decideControl({ actor: staff(), session: session(), now: NOW }).ok, true);
});

test("⛔ a view-only session can never be typed into", () => {
  const s = session({ controlRequested: false, controlGranted: false });
  assert.deepEqual(
    decideControl({ actor: staff(), session: s, now: NOW }),
    { ok: false, reason: "control_not_granted" },
  );
});

test("⛔ revoking control mid-session stops the typing", () => {
  const d = decideControl({ actor: staff({ canControl: false }), session: session(), now: NOW });
  assert.deepEqual(d, { ok: false, reason: "control_permission_revoked" });
});

test("revoking control does NOT end the viewing", () => {
  // The two keys are separable, and this is where that has to be true in
  // practice rather than just in the permission list.
  const actor = staff({ canControl: false });
  assert.equal(decideParticipation({ actor, session: session(), now: NOW }).ok, true);
  assert.equal(decideControl({ actor, session: session(), now: NOW }).ok, false);
});

test("⛔ the customer cannot control the session — they are not the support side", () => {
  const d = decideControl({ actor: customer, session: session(), now: NOW });
  assert.deepEqual(d, { ok: false, reason: "only_support_may_control" });
});

test("control refuses on a lapsed session even if everything else is right", () => {
  const s = session({ lastSeenClientAt: ago(HEARTBEAT_STALE_MS + 1_000) });
  assert.deepEqual(
    decideControl({ actor: staff(), session: s, now: NOW }),
    { ok: false, reason: "customer_disconnected" },
  );
});

// ── Ending ──────────────────────────────────────────────────────────────────

test("⛔ the customer can ALWAYS end the session, with no permission of any kind", () => {
  // The stop button must never be able to refuse.
  const d = decideEnd({ actor: { userId: "customer_1", isSuperAdmin: false }, session: session() });
  assert.equal(d.ok, true);
});

test("the support side can end their own session", () => {
  const d = decideEnd({ actor: { userId: "staff_1", isSuperAdmin: false }, session: session() });
  assert.equal(d.ok, true);
});

test("a super admin can end anyone's session — stopping is always safe", () => {
  const d = decideEnd({ actor: { userId: "someone_else", isSuperAdmin: true }, session: session() });
  assert.equal(d.ok, true);
});

test("an unrelated person cannot end a session", () => {
  const d = decideEnd({ actor: { userId: "nosy", isSuperAdmin: false }, session: session() });
  assert.deepEqual(d, { ok: false, reason: "not_a_participant" });
});

// ── Plumbing ────────────────────────────────────────────────────────────────

test("each side reads the other side's signals", () => {
  assert.equal(counterpartRole("ADMIN"), "CLIENT");
  assert.equal(counterpartRole("CLIENT"), "ADMIN");
});

test("⛔ every refusal reason has a real sentence — screens never print a slug", () => {
  const reasons = [
    "missing_permission", "missing_control_permission", "cross_tenant_not_allowed",
    "cannot_target_self", "reason_required", "reason_too_long", "not_your_session",
    "session_over", "already_answered", "already_ended", "expired", "no_answer",
    "max_duration", "customer_disconnected", "support_disconnected",
    "permission_revoked", "control_not_granted", "control_permission_revoked",
    "session_not_active", "only_support_may_control", "not_a_participant",
  ];
  const fallback = explainReason("__definitely_not_a_real_reason__");
  for (const r of reasons) {
    const text = explainReason(r);
    assert.notEqual(text, fallback, `${r} falls through to the generic message`);
    assert.ok(text.length > 10 && /[.!]$/.test(text), `${r} needs a real sentence`);
    assert.ok(!text.includes("_"), `${r} leaked a slug into the message`);
  }
});
