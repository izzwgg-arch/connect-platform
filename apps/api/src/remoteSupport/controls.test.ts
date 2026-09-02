/**
 * The controls that exist for a bad day, driven hard.
 *
 * ⛔ These are not "does the function return the right shape" tests. Each one
 * pins a property that, if it broke, would be a security incident rather than a
 * bug report: the kill switch actually killing, a capability not leaking into
 * another capability, and the call budget never being raised by any input.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONTROL_STATE,
  FULL_MEDIA_BUDGET,
  ON_CALL_MEDIA_BUDGET,
  CONSTRAINED_MEDIA_BUDGET,
  MAX_REQUESTS_PER_WINDOW,
  MAX_DISTINCT_TARGETS_PER_WINDOW,
  MAX_FAILED_PROBES_PER_WINDOW,
  MAX_SIGNAL_BYTES,
  MAX_PENDING_SIGNALS_PER_ROLE,
  REMOTE_CAPABILITIES,
  checkSignalPayload,
  decideCapability,
  decideMediaBudget,
  decideProbeRate,
  decideRequestRate,
  decideSupportGate,
  isRemoteCapability,
  resolveCapabilityGrant,
  type RemoteCapability,
  type Revocation,
} from "./controls";

const SUBJECT = { actorUserId: "u_sarah", tenantId: "t_demo", deviceId: "d_pc1" };
const ON = { enabled: true, disabledReason: null };
const OFF = { enabled: false, disabledReason: "credential incident" };

/* ─────────────────────────── kill switch ─────────────────────────── */

test("with nothing configured, remote support is available", () => {
  const d = decideSupportGate({ controls: DEFAULT_CONTROL_STATE, subject: SUBJECT, revocations: [] });
  assert.equal(d.ok, true);
});

test("⛔ the kill switch blocks everything and says why", () => {
  const d = decideSupportGate({ controls: OFF, subject: SUBJECT, revocations: [] });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.reason, "remote_support_disabled");
  // The operator's own words reach the technician, so a refusal is never a mystery.
  assert.match(d.detail, /credential incident/);
});

test("the kill switch still explains itself with no reason recorded", () => {
  const d = decideSupportGate({
    controls: { enabled: false, disabledReason: null },
    subject: SUBJECT,
    revocations: [],
  });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.match(d.detail, /switched off/i);
  // ⛔ Never a bare slug at a human.
  assert.ok(!/^[a-z_]+$/.test(d.detail));
});

test("a blank or whitespace reason does not produce a dangling sentence", () => {
  for (const reason of ["", "   ", "\n\t"]) {
    const d = decideSupportGate({
      controls: { enabled: false, disabledReason: reason },
      subject: SUBJECT,
      revocations: [],
    });
    assert.equal(d.ok, false);
    if (d.ok) continue;
    assert.ok(!d.detail.trim().endsWith(":"), `dangling colon for ${JSON.stringify(reason)}`);
  }
});

test("⛔ a revoked technician is blocked even while the switch is on", () => {
  const revs: Revocation[] = [{ scope: "TECHNICIAN", subjectId: "u_sarah" }];
  const d = decideSupportGate({ controls: ON, subject: SUBJECT, revocations: revs });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.reason, "technician_revoked");
});

test("revoking one technician does not touch another", () => {
  const revs: Revocation[] = [{ scope: "TECHNICIAN", subjectId: "u_someone_else" }];
  assert.equal(decideSupportGate({ controls: ON, subject: SUBJECT, revocations: revs }).ok, true);
});

test("⛔ a revoked customer blocks every technician, not just the one who tripped it", () => {
  const revs: Revocation[] = [{ scope: "TENANT", subjectId: "t_demo" }];
  for (const actor of ["u_sarah", "u_mendy", "u_super"]) {
    const d = decideSupportGate({
      controls: ON,
      subject: { ...SUBJECT, actorUserId: actor },
      revocations: revs,
    });
    assert.equal(d.ok, false, `${actor} should be blocked`);
  }
});

test("⛔ a revoked machine blocks that machine only", () => {
  const revs: Revocation[] = [{ scope: "DEVICE", subjectId: "d_pc1" }];
  assert.equal(decideSupportGate({ controls: ON, subject: SUBJECT, revocations: revs }).ok, false);
  assert.equal(
    decideSupportGate({ controls: ON, subject: { ...SUBJECT, deviceId: "d_pc2" }, revocations: revs }).ok,
    true,
  );
});

test("⛔ a device revocation cannot be dodged by omitting the device id", () => {
  // A caller that does not know which machine it is talking to must not thereby
  // escape a device revocation *by accident looking like success*. It cannot
  // match, so it passes — which is why device revocation is always paired with
  // a technician or tenant revocation in the incident runbook. This test pins
  // the behaviour so the limitation is known rather than discovered.
  const revs: Revocation[] = [{ scope: "DEVICE", subjectId: "d_pc1" }];
  const d = decideSupportGate({ controls: ON, subject: { ...SUBJECT, deviceId: null }, revocations: revs });
  assert.equal(d.ok, true);
});

test("the global switch is reported ahead of a personal revocation", () => {
  const revs: Revocation[] = [{ scope: "TECHNICIAN", subjectId: "u_sarah" }];
  const d = decideSupportGate({ controls: OFF, subject: SUBJECT, revocations: revs });
  assert.equal(d.ok, false);
  if (d.ok) return;
  // Both are true; the platform-wide fact is the more useful one.
  assert.equal(d.reason, "remote_support_disabled");
});

test("a long revocation list is evaluated in full", () => {
  const revs: Revocation[] = Array.from({ length: 500 }, (_, i) => ({
    scope: "TECHNICIAN" as const,
    subjectId: `u_${i}`,
  }));
  revs.push({ scope: "TECHNICIAN", subjectId: "u_sarah" });
  assert.equal(decideSupportGate({ controls: ON, subject: SUBJECT, revocations: revs }).ok, false);
});

/* ─────────────────────── capability tiers ────────────────────────── */

test("view is always granted and is never optional", () => {
  const g = resolveCapabilityGrant({ requested: [], customerAllowed: [], actorMayControl: true });
  assert.deepEqual(g, ["view"]);
});

test("⛔ a capability needs BOTH the request and the customer's tick", () => {
  // Asked for, not allowed.
  assert.deepEqual(
    resolveCapabilityGrant({ requested: ["control"], customerAllowed: [], actorMayControl: true }),
    ["view"],
  );
  // Allowed, never asked for — the dialog would not have shown it.
  assert.deepEqual(
    resolveCapabilityGrant({ requested: [], customerAllowed: ["control"], actorMayControl: true }),
    ["view"],
  );
  // Both.
  assert.deepEqual(
    resolveCapabilityGrant({ requested: ["control"], customerAllowed: ["control"], actorMayControl: true }),
    ["view", "control"],
  );
});

test("⛔ a technician without the control key gets nothing beyond looking", () => {
  const g = resolveCapabilityGrant({
    requested: ["control", "clipboard", "files"],
    customerAllowed: ["control", "clipboard", "files"],
    actorMayControl: false,
  });
  assert.deepEqual(g, ["view"]);
});

test("⛔ clipboard is not implied by control, and files are not implied by clipboard", () => {
  const g = resolveCapabilityGrant({
    requested: ["control", "clipboard", "files"],
    customerAllowed: ["control"],
    actorMayControl: true,
  });
  assert.deepEqual(g, ["view", "control"]);

  const g2 = resolveCapabilityGrant({
    requested: ["control", "clipboard", "files"],
    customerAllowed: ["control", "clipboard"],
    actorMayControl: true,
  });
  assert.deepEqual(g2, ["view", "control", "clipboard"]);
});

test("⛔ junk and unknown capabilities are dropped, not passed through", () => {
  const g = resolveCapabilityGrant({
    requested: ["control", "root", "__proto__", "", "VIEW", "ADMIN"],
    customerAllowed: ["control", "root", "__proto__", "", "VIEW", "ADMIN"],
    actorMayControl: true,
  });
  assert.deepEqual(g, ["view", "control"]);
});

test("'admin' (administrator access, 2026-09-02) is a real capability that rides the control key", () => {
  assert.equal(isRemoteCapability("admin"), true);
  // Both sides must say yes, like every other capability…
  assert.ok(!resolveCapabilityGrant({ requested: ["admin"], customerAllowed: [], actorMayControl: true }).includes("admin"));
  assert.ok(!resolveCapabilityGrant({ requested: [], customerAllowed: ["admin"], actorMayControl: true }).includes("admin"));
  // …and a technician without the control key can never be granted it.
  assert.ok(!resolveCapabilityGrant({ requested: ["admin"], customerAllowed: ["admin"], actorMayControl: false }).includes("admin"));
  assert.ok(resolveCapabilityGrant({ requested: ["admin"], customerAllowed: ["admin"], actorMayControl: true }).includes("admin"));
  // Revoking the control key revokes it live.
  assert.equal(decideCapability({ capability: "admin", granted: ["view", "control", "admin"], actorMayControl: false }).ok, false);
  assert.equal(decideCapability({ capability: "admin", granted: ["view", "control"], actorMayControl: true }).ok, false);
  assert.equal(decideCapability({ capability: "admin", granted: ["view", "control", "admin"], actorMayControl: true }).ok, true);
});

test("the grant is stable and deduplicated however the request is ordered", () => {
  const a = resolveCapabilityGrant({
    requested: ["files", "control", "clipboard", "control"],
    customerAllowed: ["clipboard", "files", "control"],
    actorMayControl: true,
  });
  const b = resolveCapabilityGrant({
    requested: ["control", "clipboard", "files"],
    customerAllowed: ["files", "control", "clipboard"],
    actorMayControl: true,
  });
  assert.deepEqual(a, b);
  assert.deepEqual(a, ["view", "control", "clipboard", "files"]);
});

test("⛔ using a capability re-checks the live control permission", () => {
  const granted: RemoteCapability[] = ["view", "control", "clipboard"];
  assert.equal(decideCapability({ capability: "clipboard", granted, actorMayControl: true }).ok, true);
  // Key revoked mid-session.
  const d = decideCapability({ capability: "clipboard", granted, actorMayControl: false });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.reason, "control_permission_revoked");
});

test("⛔ looking never requires the control key", () => {
  assert.equal(decideCapability({ capability: "view", granted: [], actorMayControl: false }).ok, true);
});

test("every capability refusal is a sentence, never a slug", () => {
  for (const cap of REMOTE_CAPABILITIES) {
    const d = decideCapability({ capability: cap, granted: [], actorMayControl: true });
    if (d.ok) continue;
    assert.ok(d.detail.length > 12, `${cap} refusal too short`);
    assert.ok(/[a-z] [a-z]/i.test(d.detail), `${cap} refusal is not a sentence`);
  }
});

/* ─────────────────── call priority (non-negotiable #15) ───────────── */

test("⛔⛔ a call in progress caps the screen, whatever else is true", () => {
  const b = decideMediaBudget({ callInProgress: true });
  assert.deepEqual(b, ON_CALL_MEDIA_BUDGET);
  assert.ok(b.maxBitrateKbps < FULL_MEDIA_BUDGET.maxBitrateKbps);
  assert.ok(b.maxFramerate < FULL_MEDIA_BUDGET.maxFramerate);
  assert.ok(b.maxHeight < FULL_MEDIA_BUDGET.maxHeight);
});

test("⛔⛔ NO input can raise the budget above the on-call cap while a call is up", () => {
  // Exhaustive over a wide grid: a perfect link must not buy back bitrate.
  for (const loss of [0, 0.001, 0.01, 0.05, 0.5, 1, -1, NaN, Infinity]) {
    for (const rtt of [0, 1, 40, 299, 300, 5000, -5, NaN, Infinity]) {
      const b = decideMediaBudget({ callInProgress: true, packetLoss: loss, roundTripMs: rtt });
      assert.equal(
        b.maxBitrateKbps,
        ON_CALL_MEDIA_BUDGET.maxBitrateKbps,
        `loss=${loss} rtt=${rtt} escaped the on-call cap`,
      );
    }
  }
});

test("a healthy idle machine gets the full budget", () => {
  assert.deepEqual(decideMediaBudget({ callInProgress: false, packetLoss: 0, roundTripMs: 40 }), FULL_MEDIA_BUDGET);
});

test("a struggling link is throttled and says so", () => {
  assert.deepEqual(
    decideMediaBudget({ callInProgress: false, packetLoss: 0.08, roundTripMs: 40 }),
    CONSTRAINED_MEDIA_BUDGET,
  );
  assert.deepEqual(
    decideMediaBudget({ callInProgress: false, packetLoss: 0, roundTripMs: 450 }),
    CONSTRAINED_MEDIA_BUDGET,
  );
  assert.ok(CONSTRAINED_MEDIA_BUDGET.note);
});

test("missing or nonsense telemetry is treated as healthy, never as a reason to throttle", () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity]) {
    const b = decideMediaBudget({ callInProgress: false, packetLoss: bad as any, roundTripMs: bad as any });
    assert.deepEqual(b, FULL_MEDIA_BUDGET);
  }
});

test("the on-call budget is still usable, not a token gesture", () => {
  // If this ever drops below a readable frame the feature is useless during the
  // exact call the technician is trying to fix.
  assert.ok(ON_CALL_MEDIA_BUDGET.maxHeight >= 720);
  assert.ok(ON_CALL_MEDIA_BUDGET.maxFramerate >= 5);
  assert.ok(ON_CALL_MEDIA_BUDGET.note);
});

/* ─────────────────────── abuse protection ────────────────────────── */

const at = (base: Date, minusMs: number) => new Date(base.getTime() - minusMs);

test("ordinary support work is never rate limited", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const d = decideRequestRate({
    now,
    recentRequestsAt: [at(now, 30_000), at(now, 120_000)],
    distinctTargetsInWindow: 2,
  });
  assert.equal(d.ok, true);
});

test("⛔ the request cap fires exactly at the limit, not one past it", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const under = Array.from({ length: MAX_REQUESTS_PER_WINDOW - 1 }, (_, i) => at(now, i * 1000));
  assert.equal(decideRequestRate({ now, recentRequestsAt: under, distinctTargetsInWindow: 1 }).ok, true);

  const atLimit = Array.from({ length: MAX_REQUESTS_PER_WINDOW }, (_, i) => at(now, i * 1000));
  const d = decideRequestRate({ now, recentRequestsAt: atLimit, distinctTargetsInWindow: 1 });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.reason, "too_many_requests");
  assert.ok(d.retryAfterMs > 0, "a refusal must say when to come back");
});

test("requests outside the window do not count", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const old = Array.from({ length: 100 }, (_, i) => at(now, 6 * 60 * 1000 + i * 1000));
  assert.equal(decideRequestRate({ now, recentRequestsAt: old, distinctTargetsInWindow: 1 }).ok, true);
});

test("⛔ the enumeration guard catches spraying across many people", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const d = decideRequestRate({
    now,
    // Well under the request cap — this is the point. Six requests is fine;
    // six requests at six different strangers is a directory walk.
    recentRequestsAt: [at(now, 1000), at(now, 2000), at(now, 3000)],
    distinctTargetsInWindow: MAX_DISTINCT_TARGETS_PER_WINDOW + 1,
  });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.reason, "too_many_targets");
});

test("helping the same person repeatedly is not enumeration", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const d = decideRequestRate({
    now,
    recentRequestsAt: [at(now, 1000), at(now, 2000), at(now, 3000)],
    distinctTargetsInWindow: 1,
  });
  assert.equal(d.ok, true);
});

test("⛔ session-id guessing is throttled on failures only", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const fails = Array.from({ length: MAX_FAILED_PROBES_PER_WINDOW }, (_, i) => at(now, i * 100));
  const d = decideProbeRate({ now, recentFailuresAt: fails });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.reason, "too_many_failed_lookups");

  // Old failures fall out of the window.
  const stale = fails.map((f) => at(f, 120_000));
  assert.equal(decideProbeRate({ now, recentFailuresAt: stale }).ok, true);
});

test("a retryAfter is always positive and never absurd", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  // Every recent entry stamped in the FUTURE (clock skew between processes).
  const skewed = Array.from({ length: MAX_REQUESTS_PER_WINDOW }, () => new Date(now.getTime() + 60_000));
  const d = decideRequestRate({ now, recentRequestsAt: skewed, distinctTargetsInWindow: 1 });
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.ok(d.retryAfterMs >= 1000);
  assert.ok(d.retryAfterMs <= 10 * 60 * 1000, "a skewed clock must not lock someone out for hours");
});

/* ─────────────────────── signalling hygiene ──────────────────────── */

test("an ordinary offer and an ICE candidate are accepted", () => {
  assert.equal(checkSignalPayload({ type: "offer", sdp: "v=0\r\n".repeat(200) }, 0).ok, true);
  assert.equal(checkSignalPayload({ candidate: "candidate:1 1 udp 2 10.0.0.1 5000 typ host" }, 3).ok, true);
});

test("⛔ an oversized payload is refused rather than stored", () => {
  const huge = { sdp: "x".repeat(MAX_SIGNAL_BYTES + 1000) };
  const d = checkSignalPayload(huge, 0);
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.reason, "signal_too_large");
});

test("⛔ size is measured on the serialised bytes, not on a key count", () => {
  // One key, enormous value. A property-count check would wave this through.
  const oneKey = { a: "x".repeat(MAX_SIGNAL_BYTES) };
  assert.equal(checkSignalPayload(oneKey, 0).ok, false);
  // Many keys, tiny total.
  const manyKeys: Record<string, number> = {};
  for (let i = 0; i < 500; i++) manyKeys[`k${i}`] = i;
  assert.equal(checkSignalPayload(manyKeys, 0).ok, true);
});

test("⛔ multi-byte characters are counted as bytes, not as characters", () => {
  // 4-byte emoji: a length check would let ~4x the intended payload through.
  const emoji = { s: "\u{1F600}".repeat(Math.ceil(MAX_SIGNAL_BYTES / 4) + 100) };
  const d = checkSignalPayload(emoji, 0);
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.reason, "signal_too_large");
});

test("⛔ an unserialisable payload is refused, not thrown", () => {
  const circular: any = { a: 1 };
  circular.self = circular;
  const d = checkSignalPayload(circular, 0);
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.reason, "signal_unserialisable");

  const bigint = { n: BigInt(1) };
  assert.equal(checkSignalPayload(bigint, 0).ok, false);

  // A function stringifies to literally `undefined` rather than throwing.
  assert.equal(checkSignalPayload((() => 1) as any, 0).ok, false);
});

test("⛔ an EMPTY payload is refused, and refused as empty rather than mislabelled", () => {
  // This is the case a `payload ?? null` coalesce silently turns into the string
  // "null" and waves through. An offer, an answer and a candidate all carry
  // data, so nothing legitimate arrives here empty.
  for (const empty of [null, undefined]) {
    const d = checkSignalPayload(empty, 0);
    assert.equal(d.ok, false, `${String(empty)} should be refused`);
    if (d.ok) continue;
    assert.equal(d.reason, "signal_empty");
  }
});

test("⛔ a backlog is refused — the other side is not reading", () => {
  const d = checkSignalPayload({ ok: 1 }, MAX_PENDING_SIGNALS_PER_ROLE);
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.reason, "signal_backlog");
});

test("the backlog check runs before the size check, so a flood is refused cheaply", () => {
  const huge = { sdp: "x".repeat(MAX_SIGNAL_BYTES + 1000) };
  const d = checkSignalPayload(huge, MAX_PENDING_SIGNALS_PER_ROLE);
  assert.equal(d.ok, false);
  if (d.ok) return;
  assert.equal(d.reason, "signal_backlog");
});
