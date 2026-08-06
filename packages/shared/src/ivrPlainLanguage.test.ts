// The Studio and the AI agent both speak through this module, so these tests
// guard two things at once: the dialplan references are the ones verified on
// the live PBX (2026-08-03), and the English is what a non-technical person
// would actually say.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDestination, readDestination, describeDestination, explainKeyPress,
  explainCallFlow, narrateCallFlow, summariseHours, digitGlyph, digitSpoken,
  formatPhone, pbxHandBack, findPbxHandBacks, OFFERABLE_KINDS, type TenantDirectory,
} from "./ivrPlainLanguage";

// A plus center (VitalPBX tenant 2), real rows.
const DIR: TenantDirectory = {
  pbxTenantId: 2,
  people: [
    { extension: "101", name: "Leah Fulop" },
    { extension: "102", name: "Mrs Weinstock" },
    { extension: "108", name: "Home" },
  ],
  teams: [
    { number: "800", name: "Main", kind: "ring_group" },
    { number: "1010", name: "Sales", kind: "ring_group" },
    { number: "600", name: "Main q", kind: "queue" },
  ],
  menus: [
    { id: "prof_home", name: "Home Main" },
    { id: "prof_after", name: "After hours" },
  ],
};

// ── references match the live dialplan ───────────────────────────────────────

test("a person writes the extension context the dialplan actually uses", () => {
  const d = buildDestination("person", "108", DIR);
  assert.equal(d?.destinationType, "extension");
  // Live: Goto(T2_cos-all,108,1)
  assert.equal(d?.destinationRef, "T2_cos-all,108,1");
  assert.equal(d?.label, "Home");
});

test("a team writes ring-group or queue context depending on what it really is", () => {
  // Live: [T2_ext-ringgroups] exten => 800,1,NoOp(Ring Group: main)
  assert.equal(buildDestination("team", "800", DIR)?.destinationRef, "T2_ext-ringgroups,800,1");
  assert.equal(buildDestination("team", "800", DIR)?.destinationType, "ring_group");
  // Live: [T2_ext-queues] exten => 600,1,NoOp(Queue: main q)
  assert.equal(buildDestination("team", "600", DIR)?.destinationRef, "T2_ext-queues,600,1");
  assert.equal(buildDestination("team", "600", DIR)?.destinationType, "queue");
});

test("voicemail uses sub-extensions-vm — the ext-local form is dead on this PBX", () => {
  const d = buildDestination("voicemail", "101", DIR);
  assert.equal(d?.destinationRef, "sub-extensions-vm,VM-101,1");
  assert.equal(d?.destinationType, "voicemail");
  assert.match(String(d?.label), /Leah Fulop/);
});

test("another menu points into Connect's own IVR context", () => {
  assert.equal(buildDestination("menu", "prof_after", DIR)?.destinationRef, "connect-tenant-ivr,prof_after,1");
});

test("hang up is fixed and needs no target", () => {
  const d = buildDestination("hangup", "", DIR);
  assert.equal(d?.destinationRef, "connect-default-fallback,s,1");
});

test("every reference satisfies the server's validator", () => {
  const CEP = /^[a-zA-Z0-9_\-]{1,64},[a-zA-Z0-9_\-+*#]{1,80},\d{1,4}$/;
  for (const [kind, id] of [["person", "101"], ["team", "800"], ["team", "600"], ["voicemail", "101"], ["menu", "prof_home"], ["hangup", ""]] as const) {
    const d = buildDestination(kind, id, DIR);
    assert.ok(d, `${kind} should build`);
    assert.match(d!.destinationRef, CEP, `${kind} ref must be valid`);
  }
});

// ── refusing to guess ────────────────────────────────────────────────────────

test("an unknown target refuses to build rather than saving something approximate", () => {
  assert.equal(buildDestination("person", "999", DIR), null);
  assert.equal(buildDestination("team", "777", DIR), null);
  assert.equal(buildDestination("menu", "nope", DIR), null);
});

test("without a tenant number, phone-system targets refuse to build", () => {
  const noTenant: TenantDirectory = { ...DIR, pbxTenantId: null };
  assert.equal(buildDestination("person", "101", noTenant), null);
  assert.equal(buildDestination("team", "800", noTenant), null);
  // Voicemail and menus don't need the tenant prefix, so they still work.
  assert.ok(buildDestination("voicemail", "101", noTenant));
  assert.ok(buildDestination("menu", "prof_home", noTenant));
});

// ── reading back ─────────────────────────────────────────────────────────────

test("reading a stored destination recovers the four-kind vocabulary", () => {
  assert.equal(readDestination({ destinationType: "extension", destinationRef: "T2_cos-all,101,1" }, DIR).kind, "person");
  assert.equal(readDestination({ destinationType: "ring_group", destinationRef: "T2_ext-ringgroups,800,1" }, DIR).kind, "team");
  assert.equal(readDestination({ destinationType: "queue", destinationRef: "T2_ext-queues,600,1" }, DIR).kind, "team");
  assert.equal(readDestination({ destinationType: "voicemail", destinationRef: "sub-extensions-vm,VM-101,1" }, DIR).kind, "voicemail");
  assert.equal(readDestination({ destinationType: "ivr", destinationRef: "connect-tenant-ivr,prof_after,1" }, DIR).kind, "menu");
  assert.equal(readDestination({ destinationType: "terminate", destinationRef: "connect-default-fallback,s,1" }, DIR).kind, "hangup");
});

test("legacy dead voicemail rows still name the right mailbox", () => {
  const r = readDestination({ destinationType: "voicemail", destinationRef: "ext-local,vmu101,1" }, DIR);
  assert.equal(r.kind, "voicemail");
  assert.equal(r.targetId, "101");
  assert.equal(r.known, true);
});

test("a deleted target is flagged, never named confidently", () => {
  const r = readDestination({ destinationType: "extension", destinationRef: "T2_cos-all,999,1" }, DIR);
  assert.equal(r.known, false);
  assert.match(describeDestination({ destinationType: "extension", destinationRef: "T2_cos-all,999,1" }, DIR), /no longer exists/);
});

test("a destination from the PBX we don't offer still describes itself", () => {
  const r = readDestination({ destinationType: "announcement", destinationRef: "T2_app-announcement,announcement-3,1", label: "Opening hours notice" }, DIR);
  assert.equal(r.kind, "other");
  assert.equal(describeDestination({ destinationType: "announcement", destinationRef: "T2_app-announcement,announcement-3,1", label: "Opening hours notice" }, DIR), "Opening hours notice");
  assert.equal(OFFERABLE_KINDS.includes("other" as never), false);
});

// ── hand-backs to the old phone system ───────────────────────────────────────
// Izzy's rule: a number on Connect must be fully in Connect. Real case found on
// A plus center 2026-08-06 — key 2 went to T2_app-time-condition,TC-1,1, which
// then chose between two VitalPBX IVRs.

test("a PBX menu or hours-rule is a hand-back", () => {
  assert.equal(pbxHandBack({ destinationType: "custom", destinationRef: "T2_app-time-condition,TC-1,1" }),
    "an opening-hours rule on the old phone system");
  assert.equal(pbxHandBack({ destinationType: "ivr", destinationRef: "T2_app-ivr,IVR-4,1" }),
    "a menu on the old phone system");
});

test("leaf destinations are NOT hand-backs — the call ends there", () => {
  // Who ANSWERS doesn't matter; who DECIDES does. These end the journey.
  for (const ref of ["T2_cos-all,101,1", "sub-extensions-vm,VM-101,1", "T2_ext-ringgroups,800,1",
                     "T2_ext-queues,600,1", "connect-tenant-ivr,prof_home,1", "connect-default-fallback,s,1"]) {
    assert.equal(pbxHandBack({ destinationType: "x", destinationRef: ref }), null, ref);
  }
});

test("Connect's own forwarding context is never a hand-back", () => {
  // It is PBX-SHAPED but Connect creates and owns it — flagging it would tell
  // the customer their own forward is a migration problem.
  const fwd = buildDestination("forward", "2000", { ...DIR, forwards: [{ extension: "2000", phoneNumber: "5622096644" }] })!;
  assert.equal(pbxHandBack(fwd), null);
});

test("a menu reports every place it still hands back, in plain words", () => {
  const found = findPbxHandBacks({
    id: "m", name: "Main",
    options: [
      { optionDigit: "1", destinationType: "extension", destinationRef: "T2_cos-all,108,1" },
      { optionDigit: "2", destinationType: "custom", destinationRef: "T2_app-time-condition,TC-1,1" },
    ],
    timeoutDestination: { destinationType: "voicemail", destinationRef: "sub-extensions-vm,VM-108,1" },
    invalidDestination: { destinationType: "ivr", destinationRef: "T2_app-ivr,IVR-4,1" },
  });
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], { where: "Key 2", what: "an opening-hours rule on the old phone system" });
  assert.deepEqual(found[1], { where: "When the caller presses a wrong key", what: "a menu on the old phone system" });
});

test("a fully migrated menu reports nothing", () => {
  assert.deepEqual(findPbxHandBacks({
    id: "m", name: "Main",
    options: [{ optionDigit: "1", destinationType: "extension", destinationRef: "T2_cos-all,108,1" }],
    timeoutDestination: { destinationType: "voicemail", destinationRef: "sub-extensions-vm,VM-108,1" },
  }), []);
});

// ── forwarding to an outside phone number ────────────────────────────────────
// Recorded live from Izzy's panel session 2026-08-06 and verified in the
// generated dialplan: 2000 → T2_app-custom-application → custom-dest-6 →
// Goto(T2_cos-all,5622096644,1).

const FWD_DIR: TenantDirectory = {
  ...DIR,
  forwards: [{ extension: "2000", phoneNumber: "5622096644" }],
};

test("a forward points at the custom application, NOT cos-all", () => {
  const d = buildDestination("forward", "2000", FWD_DIR);
  // cos-all would be typed "extension" and drag the call through the
  // wake-and-wait dialer looking for a mobile app that doesn't exist.
  assert.equal(d?.destinationRef, "T2_app-custom-application,2000,1");
  assert.equal(d?.destinationType, "custom");
  assert.equal(d?.label, "(562) 209-6644");
});

test("the stored type is one the option router jumps to plainly", () => {
  // [connect-option-router] special-cases "extension" and "external_number";
  // everything else falls through to a bare Goto, which is what we want.
  const d = buildDestination("forward", "2000", FWD_DIR);
  assert.notEqual(d?.destinationType, "extension");
  assert.notEqual(d?.destinationType, "external_number");
});

test("a forward refuses to build for an unknown or un-numbered tenant", () => {
  assert.equal(buildDestination("forward", "2099", FWD_DIR), null);
  assert.equal(buildDestination("forward", "2000", DIR), null); // no forwards list
  assert.equal(buildDestination("forward", "2000", { ...FWD_DIR, pbxTenantId: null }), null);
});

test("a forward reads back as a forward, and other custom refs do not", () => {
  const stored = buildDestination("forward", "2000", FWD_DIR)!;
  const r = readDestination(stored, FWD_DIR);
  assert.equal(r.kind, "forward");
  assert.equal(r.targetId, "2000");
  assert.equal(r.known, true);
  // Something hand-built outside the Studio must stay "other" — never claimed
  // as a forward we could describe or re-point.
  assert.equal(readDestination({ destinationType: "custom", destinationRef: "some-context,s,1" }, FWD_DIR).kind, "other");
});

test("a forward is explained as an outside phone, and promises the right caller ID", () => {
  const stored = buildDestination("forward", "2000", FWD_DIR)!;
  const s = explainKeyPress("5", stored, FWD_DIR);
  assert.match(s, /\(562\) 209-6644/);
  assert.match(s, /outside the office/);
  // Caller ID is the business's, by design — customers can't set their own.
  assert.match(s, /your business's number, not the caller's/);
});

test("a deleted forward is flagged rather than named confidently", () => {
  const stored = { destinationType: "custom", destinationRef: "T2_app-custom-application,2050,1" };
  const r = readDestination(stored, FWD_DIR);
  assert.equal(r.kind, "forward");
  assert.equal(r.known, false);
  assert.match(describeDestination(stored, FWD_DIR), /no longer exists/);
});

test("an unreadable PBX does not make a good forward look deleted", () => {
  // DIR has no `forwards` key at all — we couldn't find out, which is NOT the
  // same as "it's gone". Claiming deletion here would make every key look
  // broken during a brief PBX hiccup.
  const stored = { destinationType: "custom", destinationRef: "T2_app-custom-application,2000,1" };
  const r = readDestination(stored, DIR);
  assert.equal(r.kind, "forward");
  assert.equal(r.known, true);
  assert.doesNotMatch(describeDestination(stored, DIR), /no longer exists/);
  assert.match(describeDestination(stored, DIR), /outside the office/);
});

test("phone numbers are formatted for people, and odd ones left alone", () => {
  assert.equal(formatPhone("5622096644"), "(562) 209-6644");
  assert.equal(formatPhone("15622096644"), "(562) 209-6644");
  assert.equal(formatPhone("+1 (562) 209-6644"), "(562) 209-6644");
  assert.equal(formatPhone("101"), "101");
  assert.equal(formatPhone(""), "");
});

// ── recording keys ───────────────────────────────────────────────────────────

const REC_DIR: TenantDirectory = {
  ...DIR,
  recordings: [
    { promptRef: "custom/a_plus_center_hours", name: "Opening hours" },
    { promptRef: "custom/a_plus_center_directions", name: "Directions" },
  ],
};

test("a recording key stores the play-prompt context with what plays and replay-by-default", () => {
  const d = buildDestination("recording", "custom/a_plus_center_hours", REC_DIR);
  assert.equal(d?.destinationType, "announcement");
  assert.equal(d?.destinationRef, "connect-play-prompt,s,1");
  assert.equal(d?.announcePromptRef, "custom/a_plus_center_hours");
  // No after-destination = the menu plays again.
  assert.equal(d?.afterDestinationType ?? null, null);
  assert.equal(d?.afterDestinationRef ?? null, null);
  assert.equal(d?.label, "Opening hours");
});

test("a recording key can send the caller to a voicemail or hang up afterwards", () => {
  const vm = buildDestination("recording", "custom/a_plus_center_hours", REC_DIR, { kind: "voicemail", extension: "101" });
  assert.equal(vm?.afterDestinationType, "voicemail");
  assert.equal(vm?.afterDestinationRef, "sub-extensions-vm,VM-101,1");
  const bye = buildDestination("recording", "custom/a_plus_center_hours", REC_DIR, { kind: "hangup" });
  assert.equal(bye?.afterDestinationType, "terminate");
  assert.equal(bye?.afterDestinationRef, "connect-default-fallback,s,1");
});

test("a recording key refuses to build when the recording or after-voicemail is unknown", () => {
  assert.equal(buildDestination("recording", "custom/never_uploaded", REC_DIR), null);
  assert.equal(buildDestination("recording", "custom/a_plus_center_hours", REC_DIR, { kind: "voicemail", extension: "999" }), null);
  // A tenant with no recordings simply can't build one.
  assert.equal(buildDestination("recording", "custom/a_plus_center_hours", DIR), null);
});

test("reading a recording key back distinguishes it from PBX announcement objects", () => {
  const stored = buildDestination("recording", "custom/a_plus_center_directions", REC_DIR)!;
  const r = readDestination(stored, REC_DIR);
  assert.equal(r.kind, "recording");
  assert.equal(r.targetId, "custom/a_plus_center_directions");
  assert.equal(r.name, "Directions");
  assert.equal(r.known, true);
  // The VitalPBX announcement shape must keep reading as "other".
  assert.equal(readDestination({ destinationType: "announcement", destinationRef: "T2_app-announcement,announcement-3,1" }, REC_DIR).kind, "other");
});

test("a recording key reads back in plain words, including what happens after", () => {
  const replay = buildDestination("recording", "custom/a_plus_center_hours", REC_DIR)!;
  assert.equal(
    explainKeyPress("4", replay, REC_DIR),
    "If they press 4, we play the “Opening hours” recording, then the menu plays again.",
  );
  const vm = buildDestination("recording", "custom/a_plus_center_hours", REC_DIR, { kind: "voicemail", extension: "101" })!;
  assert.match(explainKeyPress("4", vm, REC_DIR), /then they go to Leah Fulop's voicemail/);
  const bye = buildDestination("recording", "custom/a_plus_center_hours", REC_DIR, { kind: "hangup" })!;
  assert.match(explainKeyPress("4", bye, REC_DIR), /then the call ends politely/);
});

test("a deleted recording is flagged, never named confidently", () => {
  const stored = { destinationType: "announcement", destinationRef: "connect-play-prompt,s,1", announcePromptRef: "custom/deleted_one", label: "Old notice" };
  const r = readDestination(stored, REC_DIR);
  assert.equal(r.kind, "recording");
  assert.equal(r.known, false);
  assert.match(describeDestination(stored, REC_DIR), /no longer exists/);
});

// ── the English ──────────────────────────────────────────────────────────────

test("a key press is explained the way a person would say it", () => {
  const s = explainKeyPress("3", { destinationType: "extension", destinationRef: "T2_cos-all,101,1" }, DIR);
  assert.equal(s, "If they press 3, we ring Leah Fulop on extension 101. If nobody answers, the caller goes to that person's voicemail.");
});

test("star and hash are spoken, not shown as codes", () => {
  assert.equal(digitGlyph("star"), "*");
  assert.equal(digitSpoken("star"), "the star key");
  assert.match(explainKeyPress("hash", { destinationType: "terminate", destinationRef: "connect-default-fallback,s,1" }, DIR), /the pound key/);
});

test("a team explains that several phones ring at once", () => {
  assert.match(explainKeyPress("1", { destinationType: "ring_group", destinationRef: "T2_ext-ringgroups,1010,1" }, DIR), /every phone in the Sales team at once/);
});

test("voicemail explains that nothing rings first", () => {
  assert.match(explainKeyPress("2", { destinationType: "voicemail", destinationRef: "sub-extensions-vm,VM-101,1" }, DIR), /straight to Leah Fulop's voicemail without any phone ringing/);
});

// ── whole call, A to Z ───────────────────────────────────────────────────────

const MENU = {
  id: "prof_home",
  name: "Home Main",
  greetingName: "A plus main",
  timeoutSeconds: 7,
  options: [
    { optionDigit: "3", destinationType: "extension", destinationRef: "T2_cos-all,101,1" },
    { optionDigit: "1", destinationType: "ivr", destinationRef: "connect-tenant-ivr,prof_after,1" },
    { optionDigit: "star", destinationType: "terminate", destinationRef: "connect-default-fallback,s,1" },
  ],
  timeoutDestination: { destinationType: "voicemail", destinationRef: "sub-extensions-vm,VM-101,1" },
  invalidDestination: null,
};

test("the whole call is explained in order, start to finish", () => {
  const steps = explainCallFlow(MENU, { dir: DIR, phoneNumbers: ["845-782-3064"] });
  assert.deepEqual(steps.map((s) => s.kind), ["arrive", "greeting", "key", "key", "key", "silence", "wrongkey"]);
  // Keys come out in keypad order (1, 3, then star) regardless of stored order.
  assert.deepEqual(steps.filter((s) => s.kind === "key").map((s) => s.digit), ["1", "3", "star"]);
  assert.match(steps[0].detail, /845-782-3064/);
  assert.match(steps[1].detail, /A plus main/);
  assert.match(steps.find((s) => s.kind === "silence")!.detail, /7 seconds/);
});

test("a key leading to another menu is marked so the branch can be drawn", () => {
  const steps = explainCallFlow(MENU, { dir: DIR });
  const branch = steps.find((s) => s.digit === "1")!;
  assert.equal(branch.leadsToMenuId, "prof_after");
  assert.equal(steps.find((s) => s.digit === "3")!.leadsToMenuId, null);
});

test("an empty menu says so instead of going silent", () => {
  const steps = explainCallFlow({ ...MENU, options: [] }, { dir: DIR });
  assert.match(steps.find((s) => s.kind === "key")!.detail, /no key does anything/);
});

test("a menu with no greeting warns rather than implying one plays", () => {
  const steps = explainCallFlow({ ...MENU, greetingName: null }, { dir: DIR });
  assert.match(steps.find((s) => s.kind === "greeting")!.detail, /No recording is set yet/);
});

test("hours are woven in when this is the open-hours menu", () => {
  const steps = explainCallFlow(MENU, { dir: DIR, hoursSummary: "You're open Mon–Thu 9:30am–5pm." });
  assert.match(steps[1].detail, /Mon–Thu/);
  assert.match(steps[1].detail, /after-hours menu/);
});

test("the narration is speakable prose the agent can send as a message", () => {
  const text = narrateCallFlow(explainCallFlow(MENU, { dir: DIR, phoneNumbers: ["845-782-3064"] }));
  assert.match(text, /^A caller dials 845-782-3064/);
  assert.ok(!text.includes("\n"), "should be prose, not a bullet dump");
  assert.ok(text.length > 200);
});

// ── hours in words ───────────────────────────────────────────────────────────

test("A plus center's real hours read naturally", () => {
  // Sun 11:00-17:00, Mon-Thu 09:30-17:00 — as read off the PBX.
  const s = summariseHours([
    { day: 0, open: "11:00", close: "17:00" },
    { day: 1, open: "09:30", close: "17:00" },
    { day: 2, open: "09:30", close: "17:00" },
    { day: 3, open: "09:30", close: "17:00" },
    { day: 4, open: "09:30", close: "17:00" },
  ], "America/New_York");
  assert.equal(s, "You're open Sunday 11am–5pm and Mon–Thu 9:30am–5pm (New York time).");
});

test("no hours set is stated plainly, not left blank", () => {
  assert.match(summariseHours([], "America/New_York"), /No opening hours are set/);
});
