// IVR migration translation — pure, no DB, no PBX.
//
// The fixture is A Plus Center (VitalPBX tenant 2) as read live from the PBX
// on 2026-08-03, because a synthetic fixture would only prove the code agrees
// with itself. Every id, number, recording and schedule string below was
// copied from the real rows; the expectations were checked against the
// generated dialplan (extensions__50-2-dialplan.conf).
import test from "node:test";
import assert from "node:assert/strict";
import {
  mapPbxDestination,
  translateTimeGroup,
  connectPromptRef,
  normalizeOptionDigit,
  buildImportPlan,
  type PbxTenantFlowMap,
  type MappingContext,
} from "./ivrMigration";

// ── fixture: A Plus Center, tenant 2 ────────────────────────────────────────

const DIRECTORY: PbxTenantFlowMap["directory"] = {
  // extension_id 3 → dials 108 ("Home"); verified in the live dialplan as
  // Goto(T2_cos-all,108,1) for key 1 of IVR-1.
  extensions: [
    { id: 1, number: "103", name: "Jacob Weinstock" },
    { id: 3, number: "108", name: "Home" },
    { id: 121, number: "110", name: "TEMP" },
  ],
  queues: [{ id: 40, number: "900", name: "Sales" }],
  ringGroups: [{ id: 5, number: "601", name: "Kj Play Center" }],
  customApplications: [{ id: 9, number: "7000", name: "Directory" }],
};

const CTX: MappingContext = { pbxTenantId: 2, directory: DIRECTORY };

const MAP: PbxTenantFlowMap = {
  tenantId: 2,
  tenantSlug: "a_plus_center",
  tenantName: "A plus center",
  enabled: true,
  directory: DIRECTORY,
  recordings: [
    { id: 2, name: "Home main", originalFilename: "x.wav", durationSec: 7, staticPath: "/var/lib/vitalpbx/static/f3df739ac62197cd/recordings/c81e728d9d4c2f636f067f89cc14862c" },
    { id: 3, name: "A plus main", originalFilename: "y.wav", durationSec: 28, staticPath: "/p/3" },
    { id: 11, name: "After hours", originalFilename: "z.wav", durationSec: 12, staticPath: "/p/11" },
  ],
  ivrs: [
    {
      id: 1, description: "Home Main", directDialEnabled: false,
      welcome: { id: 2, name: "Home main", staticPath: "/p/2", durationSec: 7, known: true },
      instructions: null,
      timeoutSec: 10, timeoutTries: 3, timeoutPrompt: null, timeoutRetryPrompt: null, timeoutTarget: null,
      invalidTries: 3, invalidPrompt: null, invalidRetryPrompt: null, invalidTarget: null,
      options: [
        { entryId: 1, digit: "1", enabled: true, sort: 0, target: { destinationId: 7, type: "extension", targetId: "3", label: "108 Home" } },
        { entryId: 2, digit: "2", enabled: true, sort: 1, target: { destinationId: 8, type: "time_condition", targetId: "1", label: "Main" } },
        { entryId: 3, digit: "6", enabled: true, sort: 2, target: { destinationId: 681, type: "extension", targetId: "121", label: "110 TEMP" } },
      ],
    },
    {
      id: 5, description: "A plus main", directDialEnabled: true,
      welcome: { id: 3, name: "A plus main", staticPath: "/p/3", durationSec: 28, known: true },
      instructions: null,
      timeoutSec: 7, timeoutTries: 2, timeoutPrompt: null, timeoutRetryPrompt: null,
      timeoutTarget: { destinationId: 90, type: "terminate_call", targetId: "1", label: null },
      invalidTries: 2, invalidPrompt: null, invalidRetryPrompt: null, invalidTarget: null,
      options: [
        { entryId: 10, digit: "1", enabled: true, sort: 0, target: { destinationId: 20, type: "queue", targetId: "40", label: "900 Sales" } },
        { entryId: 11, digit: "9", enabled: false, sort: 1, target: { destinationId: 21, type: "extension", targetId: "1", label: "103 Jacob" } },
      ],
    },
    {
      id: 4, description: "After hours main", directDialEnabled: false,
      welcome: { id: 11, name: "After hours", staticPath: "/p/11", durationSec: 12, known: true },
      instructions: null,
      timeoutSec: 7, timeoutTries: 1, timeoutPrompt: null, timeoutRetryPrompt: null, timeoutTarget: null,
      invalidTries: 1, invalidPrompt: null, invalidRetryPrompt: null, invalidTarget: null,
      options: [
        { entryId: 20, digit: "1", enabled: true, sort: 0, target: { destinationId: 30, type: "ring_group", targetId: "5", label: "601 Kj" } },
      ],
    },
  ],
  timeGroups: [
    { id: 1, description: "Main hours", schedules: ["09:30-17:00,mon-thu,*,*", "11:00-17:00,sun,*,*"] },
  ],
  timeConditions: [
    {
      id: 1, code: "#888", description: "Main", timezone: "America/New_York", status: "default",
      timeGroup: { id: 1, description: "Main hours", schedules: ["09:30-17:00,mon-thu,*,*", "11:00-17:00,sun,*,*"] },
      matchTarget: { destinationId: 40, type: "ivr", targetId: "5", label: "A plus main" },
      mismatchTarget: { destinationId: 41, type: "ivr", targetId: "4", label: "After hours main" },
    },
  ],
  routes: [
    { routeId: 2, did: "8457826775", description: "A plus center", target: { destinationId: 4, type: "time_condition", targetId: "1", label: "Main" } },
    { routeId: 3, did: "8457823064", description: "Home", target: { destinationId: 33, type: "ivr", targetId: "1", label: "Home Main" } },
    { routeId: 8, did: "8458279585", description: "Kj Play Center", target: { destinationId: 76, type: "ring_group", targetId: "5", label: "601 Kj" } },
  ],
};

// ── destination translation ─────────────────────────────────────────────────

test("extension maps to the number you dial, not the row id", () => {
  const r = mapPbxDestination({ destinationId: 7, type: "extension", targetId: "3", label: "108 Home" }, CTX);
  assert.equal(r.ok, true);
  // The live dialplan does Goto(T2_cos-all,108,1) — row id 3, dialled number 108.
  assert.equal(r.ok && r.destination.destinationRef, "T2_cos-all,108,1");
  assert.equal(r.ok && r.destination.destinationType, "extension");
  assert.equal(r.ok && r.destination.handsBackToPbx, false);
});

test("queue and ring group use their own VitalPBX contexts", () => {
  const q = mapPbxDestination({ destinationId: 1, type: "queue", targetId: "40", label: null }, CTX);
  assert.equal(q.ok && q.destination.destinationRef, "T2_ext-queues,900,1");
  const g = mapPbxDestination({ destinationId: 2, type: "ring_group", targetId: "5", label: null }, CTX);
  assert.equal(g.ok && g.destination.destinationRef, "T2_ext-ringgroups,601,1");
});

test("a menu Connect has NOT taken over hands the caller back to the PBX", () => {
  const r = mapPbxDestination({ destinationId: 9, type: "ivr", targetId: "4", label: "After hours main" }, CTX);
  assert.equal(r.ok && r.destination.destinationRef, "T2_app-ivr,IVR-4,1");
  assert.equal(r.ok && r.destination.handsBackToPbx, true);
});

test("a menu Connect HAS taken over stays inside Connect", () => {
  const r = mapPbxDestination(
    { destinationId: 9, type: "ivr", targetId: "4", label: "After hours main" },
    { ...CTX, connectProfileByPbxIvrId: { 4: "prof_abc" } },
  );
  assert.equal(r.ok && r.destination.destinationRef, "connect-tenant-ivr,prof_abc,1");
  assert.equal(r.ok && r.destination.handsBackToPbx, false);
});

test("time condition hands back to the PBX hours rule", () => {
  const r = mapPbxDestination({ destinationId: 8, type: "time_condition", targetId: "1", label: "Main" }, CTX);
  assert.equal(r.ok && r.destination.destinationRef, "T2_app-time-condition,TC-1,1");
});

test("hang-up maps to Connect's terminate", () => {
  const r = mapPbxDestination({ destinationId: 90, type: "terminate_call", targetId: "1", label: null }, CTX);
  assert.equal(r.ok && r.destination.destinationType, "terminate");
  assert.equal(r.ok && r.destination.destinationRef, "connect-default-fallback,s,1");
});

test("a deleted target is reported, never guessed", () => {
  const r = mapPbxDestination({ destinationId: 7, type: "extension", targetId: "999", label: "gone" }, CTX);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem.reason : "", /no longer exists/);
});

// Voicemail is the SECOND most common destination on the estate (85 uses
// across 26 tenants, censused 2026-08-03) — getting it wrong would break most
// menus. Ground truth: tenant 10 IVR-28 key 1 → vm_direct index 72 →
// extension_id 72 = ext 101, and the live dialplan does
// Goto(sub-extensions-vm,VM-101,1).
test("voicemail resolves the row id to the extension and uses the real context", () => {
  const r = mapPbxDestination({ destinationId: 50, type: "vm_direct", targetId: "3", label: null }, CTX);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.destination.destinationType, "voicemail");
  assert.equal(r.ok && r.destination.destinationRef, "sub-extensions-vm,VM-108,1");
});

test("busy and unavailable voicemail pick the right greeting prefix", () => {
  const b = mapPbxDestination({ destinationId: 51, type: "vm_busy", targetId: "3", label: null }, CTX);
  assert.equal(b.ok && b.destination.destinationRef, "sub-extensions-vm,VMB-108,1");
  const u = mapPbxDestination({ destinationId: 52, type: "vm_unavailable", targetId: "3", label: null }, CTX);
  assert.equal(u.ok && u.destination.destinationRef, "sub-extensions-vm,VMU-108,1");
});

test("voicemail for a deleted extension is reported, not sent to a wrong mailbox", () => {
  const r = mapPbxDestination({ destinationId: 53, type: "vm_direct", targetId: "999", label: null }, CTX);
  assert.equal(r.ok, false);
});

// A Plus Center's own "A plus main" uses announcements on keys 4 and 5, so
// this is on the path of the very first takeover.
// Live: Goto(T2_app-announcement,announcement-3,1).
test("announcements map to the tenant's announcement context", () => {
  const r = mapPbxDestination({ destinationId: 60, type: "preannoun", targetId: "3", label: "Hours" }, CTX);
  assert.equal(r.ok && r.destination.destinationType, "announcement");
  assert.equal(r.ok && r.destination.destinationRef, "T2_app-announcement,announcement-3,1");
});

// Live: Goto(T14_app-disa,DISA-2,1).
test("dial-through (DISA) maps to the tenant's disa context", () => {
  const r = mapPbxDestination({ destinationId: 61, type: "disa", targetId: "2", label: "Staff" }, CTX);
  assert.equal(r.ok && r.destination.destinationRef, "T2_app-disa,DISA-2,1");
});

test("an unknown module type is reported, not silently dropped", () => {
  const r = mapPbxDestination({ destinationId: 60, type: "conferences", targetId: "2", label: "Board" }, CTX);
  assert.equal(r.ok, false);
});

test("every produced ref satisfies the server's CEP validator", () => {
  const CEP = /^[a-zA-Z0-9_\-]{1,64},[a-zA-Z0-9_\-+*#]{1,80},\d{1,4}$/;
  const targets = [
    { destinationId: 1, type: "extension", targetId: "3", label: null },
    { destinationId: 2, type: "queue", targetId: "40", label: null },
    { destinationId: 3, type: "ring_group", targetId: "5", label: null },
    { destinationId: 4, type: "custom_application", targetId: "9", label: null },
    { destinationId: 5, type: "ivr", targetId: "4", label: null },
    { destinationId: 6, type: "time_condition", targetId: "1", label: null },
    { destinationId: 7, type: "terminate_call", targetId: "1", label: null },
    { destinationId: 8, type: "vm_direct", targetId: "3", label: null },
    { destinationId: 9, type: "vm_busy", targetId: "3", label: null },
    { destinationId: 10, type: "vm_unavailable", targetId: "3", label: null },
    { destinationId: 11, type: "preannoun", targetId: "3", label: null },
    { destinationId: 12, type: "disa", targetId: "2", label: null },
  ];
  for (const t of targets) {
    const r = mapPbxDestination(t, CTX);
    assert.equal(r.ok, true, `${t.type} should map`);
    assert.match(r.ok ? r.destination.destinationRef : "", CEP, `${t.type} ref must be valid CEP`);
  }
});

// ── schedule translation ────────────────────────────────────────────────────

test("A Plus Center's real hours translate exactly", () => {
  const t = translateTimeGroup(MAP.timeGroups[0]);
  assert.deepEqual(t.rules, [
    { day: 0, open: "11:00", close: "17:00" }, // Sunday
    { day: 1, open: "09:30", close: "17:00" },
    { day: 2, open: "09:30", close: "17:00" },
    { day: 3, open: "09:30", close: "17:00" },
    { day: 4, open: "09:30", close: "17:00" }, // Thursday
  ]);
  // Friday and Saturday have no rule → after-hours all day, which is correct.
  assert.equal(t.rules.some((r) => r.day === 5 || r.day === 6), false);
  assert.deepEqual(t.warnings, []);
});

test("day ranges wrap the way Asterisk wraps them", () => {
  const t = translateTimeGroup({ id: 9, description: "wrap", schedules: ["08:00-12:00,fri-mon,*,*"] });
  assert.deepEqual(t.rules.map((r) => r.day).sort(), [0, 1, 5, 6]);
});

test("split shifts widen to the outer span AND warn — never silently drop the second block", () => {
  const t = translateTimeGroup({ id: 2, description: "split", schedules: ["09:00-12:00,mon,*,*", "13:00-17:00,mon,*,*"] });
  assert.deepEqual(t.rules, [{ day: 1, open: "09:00", close: "17:00" }]);
  assert.equal(t.warnings.length, 1);
  assert.match(t.warnings[0], /Monday/);
  assert.match(t.warnings[0], /09:00–17:00/);
});

test("date-of-year limits are surfaced as a warning", () => {
  const t = translateTimeGroup({ id: 3, description: "seasonal", schedules: ["09:00-17:00,mon-fri,1-15,jan"] });
  assert.equal(t.rules.length, 5);
  assert.match(t.warnings.join(" "), /certain dates/);
});

test("an empty hours rule warns instead of quietly meaning 'always closed'", () => {
  const t = translateTimeGroup({ id: 4, description: "empty", schedules: [] });
  assert.deepEqual(t.rules, []);
  assert.equal(t.warnings.length, 1);
});

test("unreadable slots warn and don't poison the readable ones", () => {
  const t = translateTimeGroup({ id: 5, description: "mixed", schedules: ["banana", "09:00-17:00,tue,*,*"] });
  assert.deepEqual(t.rules, [{ day: 2, open: "09:00", close: "17:00" }]);
  assert.equal(t.warnings.length, 1);
});

// ── prompt refs + digits ────────────────────────────────────────────────────

test("prompt refs are tenant-prefixed, id-suffixed and catalog-safe", () => {
  const ref = connectPromptRef("a_plus_center", 2);
  assert.equal(ref, "custom/a_plus_center_vpbx2");
  // Must satisfy the server's IVR_PROMPT_REF_REGEX.
  assert.match(ref, /^[a-zA-Z0-9/_\-]{1,128}$/);
  // Same recording twice → same ref, so re-importing is idempotent.
  assert.equal(connectPromptRef("a_plus_center", 2), ref);
  // Two recordings that share a display name cannot collide.
  assert.notEqual(connectPromptRef("a_plus_center", 3), ref);
});

test("star and hash become AstDB-safe slot names", () => {
  assert.equal(normalizeOptionDigit("*"), "star");
  assert.equal(normalizeOptionDigit("#"), "hash");
  assert.equal(normalizeOptionDigit("7"), "7");
  assert.equal(normalizeOptionDigit("12"), null);
  assert.equal(normalizeOptionDigit(""), null);
});

// ── whole-menu plan ─────────────────────────────────────────────────────────

test("copying Home Main pulls in the hours rule and both menus behind it", () => {
  const plan = buildImportPlan(MAP, 1);
  assert.equal(plan.problems.length, 0);

  const names = plan.profiles.map((p) => p.name);
  assert.deepEqual(names, ["Home Main", "A plus main", "After hours main"]);
  assert.deepEqual(
    plan.profiles.map((p) => p.type),
    ["business_hours", "business_hours", "after_hours"],
  );

  // Hours come from the time condition Home Main's key 2 reaches.
  assert.equal(plan.schedule?.timezone, "America/New_York");
  assert.equal(plan.schedule?.pbxTimeConditionId, 1);
  assert.equal(plan.schedule?.rules.length, 5);

  // Both numbers that reach this menu are listed — one directly, one via hours.
  assert.deepEqual(
    plan.dids.map((d) => [d.did, d.viaTimeCondition]),
    [["8457826775", true], ["8457823064", false]],
  );
  // The ring-group-only DID is NOT swept in.
  assert.equal(plan.dids.some((d) => d.did === "8458279585"), false);
});

test("the copied Home menu reproduces its keys exactly", () => {
  const plan = buildImportPlan(MAP, 1);
  const home = plan.profiles.find((p) => p.pbxIvrId === 1)!;
  assert.deepEqual(
    home.options.map((o) => [o.optionDigit, o.destinationType, o.destinationRef]),
    [
      ["1", "extension", "T2_cos-all,108,1"],
      ["2", "custom", "T2_app-time-condition,TC-1,1"],
      ["6", "extension", "T2_cos-all,110,1"],
    ],
  );
  assert.equal(home.timeoutSeconds, 10);
  assert.equal(home.promptRef, "custom/a_plus_center_vpbx2");
});

test("disabled keys are not copied", () => {
  const plan = buildImportPlan(MAP, 1);
  const aplus = plan.profiles.find((p) => p.pbxIvrId === 5)!;
  assert.deepEqual(aplus.options.map((o) => o.optionDigit), ["1"]);
  assert.equal(aplus.directDialEnabled, true);
  assert.equal(aplus.timeoutDestinationType, "terminate");
});

test("every recording the copy needs is listed with its source file", () => {
  const plan = buildImportPlan(MAP, 1);
  assert.deepEqual(
    plan.requiredRecordings.map((r) => [r.recordingId, r.promptRef]),
    [[2, "custom/a_plus_center_vpbx2"], [3, "custom/a_plus_center_vpbx3"], [11, "custom/a_plus_center_vpbx11"]],
  );
  assert.equal(plan.requiredRecordings[0].staticPath, "/p/2");
});

test("already-copied menus are linked to instead of handed back", () => {
  const plan = buildImportPlan(MAP, 1, { connectProfileByPbxIvrId: { 4: "prof_after" } });
  // Key 2 still routes via the PBX hours rule (that's a time condition, not a
  // menu), but the after-hours profile is still planned under its own name.
  assert.equal(plan.profiles.some((p) => p.pbxIvrId === 4), true);
});

test("copying a menu that no longer exists fails loudly and changes nothing", () => {
  const plan = buildImportPlan(MAP, 999);
  assert.equal(plan.profiles.length, 0);
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0].reason, /isn't on the PBX/);
});

test("a menu with no number pointing at it warns before go-live", () => {
  const orphan: PbxTenantFlowMap = { ...MAP, routes: [] };
  const plan = buildImportPlan(orphan, 1);
  assert.match(plan.warnings.join(" "), /No phone number points at this menu/);
});

test("a hand-forced hours override on the PBX is surfaced, not inherited", () => {
  const forced: PbxTenantFlowMap = {
    ...MAP,
    timeConditions: [{ ...MAP.timeConditions[0], status: "permanently_unmatched" }],
  };
  const plan = buildImportPlan(forced, 1);
  assert.match(plan.warnings.join(" "), /forced to after-hours by hand/);
});

// Real data: tenants 9, 14 and 18 have ombu_ivr_entries whose "option" is a
// multi-digit code (0478, 7879, 1708) — VitalPBX dial-through shortcuts, not
// keypad keys. They must be reported as lost capability, in words that say
// what they actually are.
// Real estate data: VitalPBX lists each extension as its own menu entry
// (A Plus Center alone has 101–108 on two menus). Connect covers those with
// dial-by-extension, so they are NOT lost — reporting them as problems buried
// the 4 genuine issues under 92 false alarms and blocked every copy.
test("extension shortcuts are kept by dial-by-extension, not reported as problems", () => {
  const withExtCodes: PbxTenantFlowMap = {
    ...MAP,
    ivrs: MAP.ivrs.map((i) =>
      i.id !== 1 ? i : {
        ...i,
        directDialEnabled: true,
        options: [
          ...i.options,
          { entryId: 90, digit: "103", enabled: true, sort: 7, target: { destinationId: 70, type: "extension", targetId: "1", label: "103" } },
          { entryId: 91, digit: "108", enabled: true, sort: 8, target: { destinationId: 71, type: "extension", targetId: "3", label: "108" } },
        ],
      },
    ),
  };
  const plan = buildImportPlan(withExtCodes, 1);
  assert.equal(plan.problems.length, 0);
  assert.deepEqual(plan.keptByDirectDial, ["103", "108"]);
});

test("a shortcut that ISN'T an extension is still reported as lost", () => {
  const withCode: PbxTenantFlowMap = {
    ...MAP,
    ivrs: MAP.ivrs.map((i) =>
      i.id !== 1 ? i : {
        ...i,
        directDialEnabled: true,
        // 1818 / 0478 / 55648752 were all verified as non-extensions on the
        // live PBX — these are the ones that genuinely don't survive.
        options: [...i.options, { entryId: 98, digit: "1818", enabled: true, sort: 9, target: { destinationId: 61, type: "disa", targetId: "2", label: "Staff" } }],
      },
    ),
  };
  const plan = buildImportPlan(withCode, 1);
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0].reason, /isn't one of this tenant's extensions/);
  assert.deepEqual(plan.keptByDirectDial, []);
  const home = plan.profiles.find((p) => p.pbxIvrId === 1)!;
  assert.deepEqual(home.options.map((o) => o.optionDigit), ["1", "2", "6"]);
});

// Real case: tenant 8's "Main" lists 19 extensions one by one with VitalPBX's
// own dial-by-extension switched OFF. Connect CAN reproduce that, so the
// report must name the fix and its trade-off rather than claim it's
// impossible.
test("with dial-by-extension OFF, the report names the fix and its trade-off", () => {
  const noDirect: PbxTenantFlowMap = {
    ...MAP,
    ivrs: MAP.ivrs.map((i) =>
      i.id !== 1 ? i : {
        ...i,
        directDialEnabled: false,
        options: [...i.options, { entryId: 92, digit: "103", enabled: true, sort: 7, target: { destinationId: 70, type: "extension", targetId: "1", label: "103" } }],
      },
    ),
  };
  const plan = buildImportPlan(noDirect, 1);
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0].reason, /switch dial-by-extension on/);
  assert.match(plan.problems[0].reason, /any extension, not just the ones listed/);
});

test("dial-by-extension off AND not an extension is a plain loss", () => {
  const noDirect: PbxTenantFlowMap = {
    ...MAP,
    ivrs: MAP.ivrs.map((i) =>
      i.id !== 1 ? i : {
        ...i,
        directDialEnabled: false,
        options: [...i.options, { entryId: 93, digit: "0478", enabled: true, sort: 7, target: { destinationId: 61, type: "disa", targetId: "2", label: "Staff" } }],
      },
    ),
  };
  const plan = buildImportPlan(noDirect, 1);
  assert.match(plan.problems[0].reason, /no way to reproduce it/);
});

test("a broken key is reported but the rest of the menu still copies", () => {
  const broken: PbxTenantFlowMap = {
    ...MAP,
    ivrs: MAP.ivrs.map((i) =>
      i.id !== 1 ? i : {
        ...i,
        options: [
          ...i.options,
          { entryId: 99, digit: "4", enabled: true, sort: 3, target: { destinationId: 77, type: "extension", targetId: "555", label: "deleted" } },
        ],
      },
    ),
  };
  const plan = buildImportPlan(broken, 1);
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0].where, /key 4/);
  const home = plan.profiles.find((p) => p.pbxIvrId === 1)!;
  assert.deepEqual(home.options.map((o) => o.optionDigit), ["1", "2", "6"]);
});
