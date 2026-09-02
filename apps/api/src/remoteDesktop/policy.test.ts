/**
 * Remote Desktop policy — every decision, driven without a database.
 *
 * The properties that matter most here are the NEGATIVE ones: a wrong Connect ID
 * and a wrong password must be indistinguishable, the machine is identified by
 * its key and never its user, and nothing opens for a computer whose owner has
 * not switched it on and set a login.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DESKTOP_CAPABILITIES,
  LOGIN_MAX_FAILURES,
  MACHINE_ONLINE_MS,
  SHARE_MAX_FAILURES,
  decideConnectById,
  decideDesktopControl,
  decideDesktopParticipation,
  decideMachineRegister,
  decideManageMachine,
  decideOwnConnect,
  decideShareCreate,
  desktopLapseReason,
  explainDesktopReason,
  formatConnectId,
  hashMachineKey,
  hashSharePassword,
  isConnectId,
  isDesktopCapability,
  isPlausibleDeviceId,
  isPlausibleMachineKey,
  mintConnectId,
  mintSharePassword,
  nextShareFailure,
  normalizeConnectId,
  normalizeSharePassword,
  resolveDesktopGrant,
  shareAllows,
  shareExpiryFor,
  shareIsLive,
  shareLockedOut,
  type ActorFacts,
  type DesktopSessionFacts,
  type MachineFacts,
  type ShareFacts,
} from "./policy";

const NOW = new Date("2026-09-02T12:00:00Z");
const key = "a".repeat(64);

const actor = (o: Partial<ActorFacts> = {}): ActorFacts => ({
  userId: "izzy", tenantId: "T_A", isSuperAdmin: false, canUseRemoteDesktop: true, canConnectById: true, canShareOwnComputer: true, fromDesktopApp: true, ...o,
});
const machine = (o: Partial<MachineFacts> = {}): MachineFacts => ({
  id: "m1", tenantId: "T_A", ownerUserId: "izzy", deviceId: "win-abcdefabcdefabcdefabcdef", machineKeyHash: hashMachineKey("win-abcdefabcdefabcdefabcdef", key),
  unattendedEnabled: true, hasAccessLogin: true, locked: false, lastSeenAt: new Date(NOW.getTime() - 5_000), revokedAt: null, shareFailCount: 0, shareLockedUntil: null, ...o,
});
const share = (o: Partial<ShareFacts> = {}): ShareFacts => ({
  id: "sh1", machineId: "m1", tenantId: "T_A", passwordHash: hashSharePassword("sh1", "k7Rm-4wQx"), scope: "company", oneTime: false, expiresAt: null, usedCount: 0, revokedAt: null,
  allowControl: true, allowSound: true, allowMic: false, allowClipboard: false, ...o,
});
const session = (o: Partial<DesktopSessionFacts> = {}): DesktopSessionFacts => ({
  id: "s1", tenantId: "T_A", kind: "desktop", status: "ACTIVE", machineId: "m1", requestedByUserId: "izzy", targetUserId: "izzy", clientAuthenticated: false,
  capabilitiesGranted: ["control", "sound"], expiresAt: new Date(NOW.getTime() + 45_000), startedAt: new Date(NOW.getTime() - 60_000), lastSeenAdminAt: new Date(NOW.getTime() - 5_000), lastSeenClientAt: new Date(NOW.getTime() - 5_000), ...o,
});

test("Connect IDs: nine digits, never starting with 0, unique-shaped, formatted in threes", () => {
  for (let i = 0; i < 200; i++) {
    const id = mintConnectId();
    assert.ok(isConnectId(id), id);
    assert.notEqual(id[0], "0", "a leading zero would read as eight digits when spoken");
  }
  assert.equal(formatConnectId("482913057"), "482 913 057");
  assert.equal(normalizeConnectId(" 482 913-057 "), "482913057");
  assert.equal(normalizeConnectId("48291305"), null);
});

test("machine identity: the key decides, never the name; a reinstall enrolls afresh", () => {
  assert.equal(isPlausibleMachineKey(key), true);
  assert.equal(isPlausibleMachineKey("short"), false);
  assert.equal(isPlausibleMachineKey(key.toUpperCase()), false, "hex only — a shape check keeps garbage out of the hash");
  assert.equal(isPlausibleDeviceId("win-abcdefabcdefabcdefabcdef"), true);
  assert.equal(isPlausibleDeviceId("../etc"), false);
  const presented = hashMachineKey("win-abcdefabcdefabcdefabcdef", key);
  assert.deepEqual(decideMachineRegister({ existing: null, presentedKeyHash: presented }), { ok: true });
  assert.deepEqual(decideMachineRegister({ existing: { machineKeyHash: presented, revokedAt: null }, presentedKeyHash: presented }), { ok: true });
  assert.deepEqual(decideMachineRegister({ existing: { machineKeyHash: hashMachineKey("win-abcdefabcdefabcdefabcdef", "b".repeat(64)), revokedAt: null }, presentedKeyHash: presented }), { ok: false, reason: "machine_key_mismatch" });
  assert.deepEqual(decideMachineRegister({ existing: { machineKeyHash: presented, revokedAt: NOW }, presentedKeyHash: presented }), { ok: false, reason: "machine_removed" });
  // The hash is bound to the deviceId: the same key on another install is a different hash.
  assert.notEqual(hashMachineKey("win-other", key), presented);
});

test("own computer: owner only, switched on, login set, online", () => {
  assert.deepEqual(decideOwnConnect({ actor: actor(), machine: machine(), now: NOW }), { ok: true });
  assert.equal(decideOwnConnect({ actor: actor({ canUseRemoteDesktop: false }), machine: machine(), now: NOW }).ok, false);
  assert.deepEqual(decideOwnConnect({ actor: actor({ userId: "colleague" }), machine: machine(), now: NOW }), { ok: false, reason: "not_your_computer" });
  assert.deepEqual(decideOwnConnect({ actor: actor({ isSuperAdmin: true, userId: "root" }), machine: machine(), now: NOW }), { ok: false, reason: "not_your_computer" }, "not even a super admin — they need an issued password");
  assert.deepEqual(decideOwnConnect({ actor: actor(), machine: machine({ unattendedEnabled: false }), now: NOW }), { ok: false, reason: "unattended_off" });
  assert.deepEqual(decideOwnConnect({ actor: actor(), machine: machine({ hasAccessLogin: false }), now: NOW }), { ok: false, reason: "no_access_login" }, "a door with no lock is refused");
  assert.deepEqual(decideOwnConnect({ actor: actor(), machine: machine({ lastSeenAt: new Date(NOW.getTime() - MACHINE_ONLINE_MS - 1) }), now: NOW }), { ok: false, reason: "machine_offline" });
  assert.deepEqual(decideOwnConnect({ actor: actor(), machine: machine({ revokedAt: NOW }), now: NOW }), { ok: false, reason: "machine_removed" });
  // ⛔ A LOCKED Windows session is still reachable — it is reported, not refused.
  assert.deepEqual(decideOwnConnect({ actor: actor(), machine: machine({ locked: true }), now: NOW }), { ok: true });
});

test("managing and sharing a computer is the owner's alone", () => {
  assert.deepEqual(decideManageMachine({ actor: actor(), machine: machine() }), { ok: true });
  assert.equal(decideManageMachine({ actor: actor({ userId: "colleague" }), machine: machine() }).ok, false);
  assert.deepEqual(decideShareCreate({ actor: actor(), machine: machine() }), { ok: true });
  assert.deepEqual(decideShareCreate({ actor: actor({ canShareOwnComputer: false }), machine: machine() }), { ok: false, reason: "missing_share_permission" });
  assert.equal(decideShareCreate({ actor: actor({ userId: "colleague", canShareOwnComputer: true }), machine: machine() }).ok, false);
});

test("connect by ID: every mismatch is the SAME answer — no oracle for which ids are real", () => {
  const base = { actor: actor(), now: NOW };
  const good = decideConnectById({ ...base, machine: machine(), matchedShare: share() });
  assert.deepEqual(good, { ok: true });
  const wrongs = [
    decideConnectById({ ...base, machine: null, matchedShare: null }),                                   // no such id
    decideConnectById({ ...base, machine: machine({ revokedAt: NOW }), matchedShare: share() }),          // removed machine
    decideConnectById({ ...base, machine: machine(), matchedShare: null }),                              // wrong password
    decideConnectById({ ...base, machine: machine(), matchedShare: share({ revokedAt: NOW }) }),          // revoked
    decideConnectById({ ...base, machine: machine(), matchedShare: share({ expiresAt: new Date(NOW.getTime() - 1) }) }), // expired
    decideConnectById({ ...base, machine: machine(), matchedShare: share({ oneTime: true, usedCount: 1 }) }),           // already used
    decideConnectById({ ...base, machine: machine({ tenantId: "T_B" }), matchedShare: share({ tenantId: "T_B", scope: "company" }) }), // other company, company-only
  ];
  for (const w of wrongs) assert.deepEqual(w, { ok: false, reason: "invalid_id_or_password" });
  // Cross-company works ONLY when the owner chose "anyone".
  assert.deepEqual(decideConnectById({ ...base, machine: machine({ tenantId: "T_B" }), matchedShare: share({ tenantId: "T_B", scope: "anyone" }) }), { ok: true });
  // Facts about the CALLER are specific — they already know them.
  assert.deepEqual(decideConnectById({ ...base, actor: actor({ canConnectById: false }), machine: machine(), matchedShare: share() }), { ok: false, reason: "missing_connect_permission" });
  assert.deepEqual(decideConnectById({ ...base, actor: actor({ fromDesktopApp: false }), machine: machine(), matchedShare: share() }), { ok: false, reason: "desktop_app_required" });
  assert.deepEqual(decideConnectById({ ...base, machine: machine({ shareLockedUntil: new Date(NOW.getTime() + 60_000) }), matchedShare: share() }), { ok: false, reason: "locked_out" }, "even the RIGHT password is refused during a lockout");
  assert.deepEqual(decideConnectById({ ...base, machine: machine({ unattendedEnabled: false }), matchedShare: share() }), { ok: false, reason: "machine_not_accepting" });
  assert.deepEqual(decideConnectById({ ...base, machine: machine({ lastSeenAt: null }), matchedShare: share() }), { ok: false, reason: "machine_offline" });
});

test("guessing: five wrong passwords lock the machine's ID for 15 minutes, then the count resets", () => {
  let m = machine();
  for (let i = 1; i < SHARE_MAX_FAILURES; i++) {
    const next = nextShareFailure(m, NOW);
    assert.equal(next.shareFailCount, i);
    assert.equal(next.shareLockedUntil, null);
    m = machine(next);
  }
  const locked = nextShareFailure(m, NOW);
  assert.equal(locked.shareFailCount, 0);
  assert.ok(locked.shareLockedUntil && locked.shareLockedUntil.getTime() === NOW.getTime() + 15 * 60_000);
  assert.equal(shareLockedOut({ shareLockedUntil: locked.shareLockedUntil }, NOW), true);
  assert.equal(shareLockedOut({ shareLockedUntil: locked.shareLockedUntil }, new Date(NOW.getTime() + 16 * 60_000)), false);
});

test("share passwords: 8 characters, no confusable letters, compared case- and dash-insensitively, hashed with the share id", () => {
  for (let i = 0; i < 200; i++) {
    const p = mintSharePassword();
    assert.match(p, /^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/i, p);
  }
  assert.equal(normalizeSharePassword(" K7RM 4wqx "), normalizeSharePassword("k7rm-4wqx"));
  assert.equal(hashSharePassword("sh1", "k7Rm-4wQx"), hashSharePassword("sh1", "K7RM4WQX"));
  assert.notEqual(hashSharePassword("sh1", "k7Rm-4wQx"), hashSharePassword("sh2", "k7Rm-4wQx"), "the same password on another share is another hash");
});

test("share expiry: once dies after one use, 24h expires, standing never does", () => {
  const once = shareExpiryFor("once", NOW);
  assert.equal(once.oneTime, true);
  assert.ok(once.expiresAt, "a one-time password that is never used still expires");
  const day = shareExpiryFor("24h", NOW);
  assert.equal(day.oneTime, false);
  assert.equal(day.expiresAt!.getTime(), NOW.getTime() + 24 * 3_600_000);
  const standing = shareExpiryFor("standing", NOW);
  assert.equal(standing.expiresAt, null);
  assert.equal(shareIsLive(share({ oneTime: true, usedCount: 1 }), NOW), false);
  assert.equal(shareIsLive(share({ oneTime: true, usedCount: 0 }), NOW), true);
  assert.equal(shareIsLive(share({ expiresAt: new Date(NOW.getTime() + 1) }), NOW), true);
  assert.equal(shareIsLive(share({ expiresAt: NOW }), NOW), true, "expires AFTER the instant, not at it");
  assert.equal(shareIsLive(share({ expiresAt: new Date(NOW.getTime() - 1) }), NOW), false);
});

test("grants: an own-computer session gets what it asked for; a share session only what the owner allowed", () => {
  assert.deepEqual(DESKTOP_CAPABILITIES, ["control", "sound", "mic", "clipboard"]);
  assert.equal(isDesktopCapability("admin"), false, "administrator windows are not a capability in this version");
  assert.equal(isDesktopCapability("files"), false, "file transfer is not in this version");
  const own = resolveDesktopGrant({ requested: ["control", "sound", "mic", "clipboard", "files", "admin", "__proto__"], allowed: { control: true, sound: true, mic: true, clipboard: true } });
  assert.deepEqual(own, ["view", "control", "sound", "mic", "clipboard"], "view is always present; files/admin are not capabilities here");
  const shared = resolveDesktopGrant({ requested: ["control", "sound", "mic", "clipboard"], allowed: shareAllows(share({ allowControl: false, allowMic: false })) });
  assert.deepEqual(shared, ["view", "sound"], "the owner said look-only, no mic, no clipboard");
  assert.deepEqual(resolveDesktopGrant({ requested: [], allowed: { control: true, sound: true, mic: true, clipboard: true } }), ["view"], "asking for nothing grants look-only");
});

test("participation: the machine is its KEY, the viewer is the requester, anyone else is nobody", () => {
  const m = machine();
  const presented = hashMachineKey(m.deviceId, key);
  // Own computer: SAME user on both ends. Only the key tells them apart.
  assert.deepEqual(decideDesktopParticipation({ session: session(), machine: m, actorUserId: "izzy", presentedKeyHash: presented, now: NOW }), { ok: true, role: "MACHINE" });
  assert.deepEqual(decideDesktopParticipation({ session: session(), machine: m, actorUserId: "izzy", presentedKeyHash: null, now: NOW }), { ok: true, role: "VIEWER" });
  // A wrong key is not "the viewer with a typo" — it is nobody.
  assert.deepEqual(decideDesktopParticipation({ session: session(), machine: m, actorUserId: "izzy", presentedKeyHash: hashMachineKey(m.deviceId, "b".repeat(64)), now: NOW }), { ok: false, reason: "not_a_participant" });
  // A key for ANOTHER machine, even in the same tenant, is nobody.
  assert.deepEqual(decideDesktopParticipation({ session: session(), machine: machine({ id: "m2" }), actorUserId: "izzy", presentedKeyHash: presented, now: NOW }), { ok: false, reason: "not_a_participant" });
  // A colleague signed in as someone else is nobody.
  assert.deepEqual(decideDesktopParticipation({ session: session(), machine: m, actorUserId: "colleague", presentedKeyHash: null, now: NOW }), { ok: false, reason: "not_a_participant" });
  // A support session is not a desktop session.
  assert.deepEqual(decideDesktopParticipation({ session: session({ kind: "support" }), machine: m, actorUserId: "izzy", presentedKeyHash: null, now: NOW }), { ok: false, reason: "not_a_desktop_session" });
  assert.deepEqual(decideDesktopParticipation({ session: session({ status: "ENDED" }), machine: m, actorUserId: "izzy", presentedKeyHash: null, now: NOW }), { ok: false, reason: "session_over" });
});

test("lapse: a request the machine never answers expires; absent heartbeats get the same grace as silent ones", () => {
  assert.equal(desktopLapseReason(session({ status: "REQUESTED", expiresAt: new Date(NOW.getTime() - 1) }), NOW), "machine_did_not_answer");
  assert.equal(desktopLapseReason(session({ status: "REQUESTED" }), NOW), null);
  // Just started, other side has not beaten yet: NOT a lapse (the half-of-all-sessions bug).
  assert.equal(desktopLapseReason(session({ startedAt: new Date(NOW.getTime() - 2_000), lastSeenAdminAt: null, lastSeenClientAt: new Date(NOW) }), NOW), null);
  assert.equal(desktopLapseReason(session({ startedAt: new Date(NOW.getTime() - 60_000), lastSeenAdminAt: null }), NOW), "viewer_disconnected");
  assert.equal(desktopLapseReason(session({ lastSeenClientAt: new Date(NOW.getTime() - 60_000) }), NOW), "machine_disconnected");
  assert.equal(desktopLapseReason(session({ startedAt: new Date(NOW.getTime() - 5 * 3_600_000), lastSeenAdminAt: NOW, lastSeenClientAt: NOW }), NOW), "max_duration");
  assert.equal(desktopLapseReason(session({ status: "ENDED" }), NOW), null);
});

test("control needs the grant AND the login; only the viewer may drive", () => {
  assert.deepEqual(decideDesktopControl({ session: session({ clientAuthenticated: true }), role: "VIEWER" }), { ok: true });
  assert.deepEqual(decideDesktopControl({ session: session({ clientAuthenticated: false }), role: "VIEWER" }), { ok: false, reason: "not_signed_in_to_computer" });
  assert.deepEqual(decideDesktopControl({ session: session({ clientAuthenticated: true, capabilitiesGranted: ["sound"] }), role: "VIEWER" }), { ok: false, reason: "control_not_granted" });
  assert.deepEqual(decideDesktopControl({ session: session({ clientAuthenticated: true }), role: "MACHINE" }), { ok: false, reason: "only_viewer_may_control" });
  assert.deepEqual(decideDesktopControl({ session: session({ clientAuthenticated: true, status: "REQUESTED" }), role: "VIEWER" }), { ok: false, reason: "session_not_active" });
  assert.equal(LOGIN_MAX_FAILURES, 5);
});

test("every refusal has a sentence, and none of them names another company or a machine's existence", () => {
  const reasons = ["missing_permission", "not_your_computer", "unattended_off", "no_access_login", "machine_offline", "machine_removed", "missing_connect_permission", "desktop_app_required", "invalid_id_or_password", "locked_out", "machine_not_accepting", "missing_share_permission", "machine_key_mismatch", "not_a_participant", "session_over"];
  for (const r of reasons) {
    const text = explainDesktopReason(r);
    assert.ok(text.length > 10, `${r} has no sentence`);
    assert.doesNotMatch(text, /tenant|T_|undefined|null/i, `${r}: ${text}`);
  }
  assert.equal(explainDesktopReason("invalid_id_or_password"), explainDesktopReason("invalid_id_or_password"));
  assert.doesNotMatch(explainDesktopReason("invalid_id_or_password"), /exist|no such|not found/i, "the sentence must not say whether the id is real");
});
