/**
 * The pure rules the Remote Desktop screens lean on — Connect IDs, the two
 * control-channel frame parsers, the machine-card wording and the link readout.
 *
 * ⛔ The frame parsers are the boundary between the two computers: a viewer frame
 * comes from whoever is connected, so it is untrusted input to the machine, and
 * a machine frame is untrusted input to the viewer. Both must refuse anything
 * that is not exactly the shape they expect.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  describeEnd,
  describeMachineAccess,
  formatConnectId,
  isMachineOnline,
  linkGrade,
  linkLabel,
  MAX_CLIP_CHARS,
  parseConnectId,
  parseMachineFrame,
  parseViewerFrame,
  shareExpiryLabel,
  typedConnectId,
} from "./remoteDesktop";

test("a Connect ID is nine digits, shown in three groups, accepted in any spacing", () => {
  assert.equal(formatConnectId("482913057"), "482 913 057");
  assert.equal(parseConnectId("482 913 057"), "482913057");
  assert.equal(parseConnectId("482-913-057"), "482913057");
  assert.equal(parseConnectId("48291305"), null);
  assert.equal(parseConnectId("4829130571"), null);
  assert.equal(parseConnectId("abc"), null);
  assert.equal(typedConnectId("4829"), "482 9");
  assert.equal(typedConnectId("482913057999"), "482 913 057");
});

test("online is a recent heartbeat, nothing else", () => {
  const now = Date.parse("2026-09-02T12:00:00Z");
  assert.equal(isMachineOnline(new Date(now - 10_000).toISOString(), now), true);
  assert.equal(isMachineOnline(new Date(now - 120_000).toISOString(), now), false);
  assert.equal(isMachineOnline(null, now), false);
});

test("the machine card never offers a Connect button that will fail", () => {
  const now = Date.parse("2026-09-02T12:00:00Z");
  const base = { id: "m1", name: "Warehouse laptop", connectId: "482913057", osLabel: "Windows 11", monitors: 1, activeShares: 0, standingShares: 0, thisComputer: false, locked: false };
  const offline = describeMachineAccess({ ...base, unattendedEnabled: true, hasAccessLogin: true, lastSeenAt: new Date(now - 3_600_000).toISOString() }, now);
  assert.equal(offline.canConnect, false);
  assert.equal(offline.pill, "offline");
  const notAllowed = describeMachineAccess({ ...base, unattendedEnabled: false, hasAccessLogin: false, lastSeenAt: new Date(now - 1000).toISOString() }, now);
  assert.equal(notAllowed.canConnect, false);
  assert.equal(notAllowed.pill, "warn");
  assert.match(notAllowed.access, /Someone must be there/);
  const noLogin = describeMachineAccess({ ...base, unattendedEnabled: true, hasAccessLogin: false, lastSeenAt: new Date(now - 1000).toISOString() }, now);
  assert.equal(noLogin.canConnect, false, "unattended without a username is a door with no lock — the server refuses it too");
  const ready = describeMachineAccess({ ...base, unattendedEnabled: true, hasAccessLogin: true, lastSeenAt: new Date(now - 1000).toISOString() }, now);
  assert.equal(ready.canConnect, true);
  const locked = describeMachineAccess({ ...base, unattendedEnabled: true, hasAccessLogin: true, locked: true, lastSeenAt: new Date(now - 1000).toISOString() }, now);
  assert.equal(locked.canConnect, true, "a locked Windows session is still reachable — the picture is black until someone unlocks it there");
  assert.match(locked.status, /locked/i);
  const here = describeMachineAccess({ ...base, thisComputer: true, unattendedEnabled: true, hasAccessLogin: true, lastSeenAt: new Date(now).toISOString() }, now);
  assert.equal(here.canConnect, false);
  assert.equal(here.pill, "you");
});

test("share passwords say how long they work", () => {
  assert.equal(shareExpiryLabel({ oneTime: true, expiresAt: null }), "Once");
  assert.match(shareExpiryLabel({ oneTime: false, expiresAt: null }), /Until you remove it/);
  assert.match(shareExpiryLabel({ oneTime: false, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), /left/);
});

test("viewer frames: only the four shapes, bounded, and nothing else", () => {
  assert.deepEqual(parseViewerFrame(JSON.stringify({ t: "login", username: "izzy-home", password: "hunter22" })), { t: "login", username: "izzy-home", password: "hunter22" });
  assert.equal(parseViewerFrame(JSON.stringify({ t: "login", username: "x" })), null, "a login without a password is not a login");
  assert.equal(parseViewerFrame(JSON.stringify({ t: "login", username: "x".repeat(300), password: "y" })), null, "an absurd username is refused");
  assert.deepEqual(parseViewerFrame({ t: "audio", sound: true, mic: false }), { t: "audio", sound: true, mic: false });
  assert.equal(parseViewerFrame({ t: "audio", sound: "yes", mic: false }), null);
  assert.deepEqual(parseViewerFrame({ t: "monitor", sourceId: "screen:1:0" }), { t: "monitor", sourceId: "screen:1:0" });
  assert.equal(parseViewerFrame({ t: "monitor", sourceId: "file:///etc/passwd" }), null, "a monitor id is an Electron source id, nothing else");
  assert.equal(parseViewerFrame({ t: "clip", text: "x".repeat(MAX_CLIP_CHARS + 1) }), null, "clipboard text is bounded");
  assert.equal(parseViewerFrame({ t: "input", kind: "move" }), null, "input rides its own channel, never this one");
  assert.equal(parseViewerFrame("not json"), null);
  assert.equal(parseViewerFrame(null), null);
  assert.equal(parseViewerFrame({ t: "__proto__" }), null);
});

test("machine frames: the verdict never echoes what was typed, and counts are clamped", () => {
  const ok = parseMachineFrame({ t: "login_result", ok: true });
  assert.deepEqual(ok, { t: "login_result", ok: true });
  const bad = parseMachineFrame({ t: "login_result", ok: false, attemptsLeft: 999, lockedForMs: 999_999_999, username: "leak" }) as any;
  assert.equal(bad.ok, false);
  assert.equal(bad.attemptsLeft, 10, "clamped");
  assert.equal(bad.lockedForMs, 3_600_000, "clamped");
  assert.equal("username" in bad, false, "a machine frame carries no typed credential back");
  assert.deepEqual(parseMachineFrame({ t: "screens", screens: [{ id: "screen:1:0", name: "Screen 1" }] }), { t: "screens", screens: [{ id: "screen:1:0", name: "Screen 1" }] });
  assert.equal(parseMachineFrame({ t: "screens", screens: [{ id: 1 }] }), null);
  assert.equal(parseMachineFrame({ t: "screens", screens: new Array(17).fill({ id: "screen:1", name: "x" }) }), null, "bounded");
  assert.deepEqual(parseMachineFrame({ t: "locked", locked: true }), { t: "locked", locked: true });
  assert.deepEqual(parseMachineFrame({ t: "phone", onCall: true }), { t: "phone", onCall: true });
  assert.equal(parseMachineFrame({ t: "ready", extra: 1 }) ?.t, "ready");
  assert.equal(parseMachineFrame({ t: "login" }), null, "a login frame is a VIEWER frame; the machine never sends one");
});

test("the link readout has three states, and Measuring… is never drawn as good", () => {
  assert.equal(linkGrade(null), "unknown");
  assert.equal(linkGrade({ packetLoss: null, roundTripMs: null }), "unknown");
  assert.equal(linkGrade({ packetLoss: 0, roundTripMs: 38 }), "good");
  assert.equal(linkGrade({ packetLoss: 0.015, roundTripMs: 40 }), "fair");
  assert.equal(linkGrade({ packetLoss: 0.05, roundTripMs: 40 }), "poor");
  assert.equal(linkGrade({ packetLoss: 0, roundTripMs: 400 }), "poor");
  assert.match(linkLabel(null, null), /Measuring/);
  assert.equal(linkLabel({ packetLoss: 0, roundTripMs: 38 }, "direct"), "Good · direct · 38 ms");
});

test("the end-of-session sentence is plain English for every reason", () => {
  assert.match(describeEnd("login_locked", null), /15 minutes/);
  assert.match(describeEnd("remote_support_disabled", "control"), /switched off/);
  assert.match(describeEnd(null, "machine"), /Stopped from the remote computer/);
  assert.match(describeEnd(null, "viewer"), /You disconnected/);
  assert.match(describeEnd("something_new", null), /ended/);
});
