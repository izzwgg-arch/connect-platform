import test from "node:test";
import assert from "node:assert/strict";

import {
  LOOPCOM_PHONE_STANDARDS, templateColumnStandards, templateStandardsDrift,
  yealinkStandardConfigKeys, applyYealinkStandards, STANDARDS_BANNER,
} from "./standards";
import {
  buildButtonLayout, serializeButtonLayout, parseButtonLayout,
  yealinkKeyCount, modelSupportsButtons, UNKNOWN_MODEL_KEY_COUNT, DSS_TYPE,
} from "./buttonLayout";
import {
  PHONE_STATES, customerStateFor, canTransition, decideReset, isTerminal,
  summarizeRun, MAX_ATTEMPTS, type PhoneRecord, type PhoneState,
} from "./states";
import {
  normalizeMac, formatMac, guessVendorFromMac, matchDevice, findByIdentity, compareToPbxRecords,
} from "./deviceIdentity";
import { shouldFingerprint } from "./discoveryFilter";
import {
  nextEscalation, customerFacingFailure, sanitizeDeviceText, SETUP_ACTIONS,
  type PhoneCondition,
} from "./escalation";

/* ── standards ───────────────────────────────────────────────────────────── */

test("the house standard is exactly what the healthy production templates carry", () => {
  const c = templateColumnStandards();
  // Read off the live PBX 2026-08-21 from the Yealink templates that work.
  assert.equal(c.timezone, "-5|United States-Eastern Time");
  assert.equal(c.time_format, "0", "0 is Yealink's 12-hour clock");
  assert.equal(c.summer_time, "2", "2 is Yealink's AUTOMATIC daylight saving");
  assert.equal(LOOPCOM_PHONE_STANDARDS.voicemailNumber, "*97");
});

test("drift catches the phone that is set to the Marshall Islands", () => {
  // provisioning.templates id 21, "BV 106" - a real row on production.
  const drift = templateStandardsDrift({
    timezone: "-12|Eniwetok,Kwajalein", time_format: "0", date_format: "0", summer_time: "2",
  });
  assert.equal(drift.length, 1);
  assert.equal(drift[0].column, "timezone");
  assert.equal(drift[0].expected, "-5|United States-Eastern Time");
});

test("drift catches manual daylight saving, which is wrong twice a year", () => {
  // provisioning.templates id 3, "T42s A plus" - summer_time 1, not 2.
  const drift = templateStandardsDrift({
    timezone: "-5|United States-Eastern Time", time_format: "0", date_format: "0", summer_time: "1",
  });
  assert.deepEqual(drift.map((d) => d.column), ["summer_time"]);
});

test("a blank or missing timezone is drift, not 'unset'", () => {
  // A blank leaves the handset on the vendor default, which is China.
  for (const value of [null, undefined, ""]) {
    const drift = templateStandardsDrift({ timezone: value as any, time_format: "0", date_format: "0", summer_time: "2" });
    assert.ok(drift.some((d) => d.column === "timezone"), `blank ${String(value)} must be drift`);
  }
});

test("a healthy row reports no drift at all", () => {
  assert.deepEqual(templateStandardsDrift(templateColumnStandards()), []);
});

test("the reset-over-SIP switch and its trust guard always ship together", () => {
  const keys = yealinkStandardConfigKeys();
  const names = keys.map((k) => k.key);
  assert.ok(names.includes("sip.notify_reset.enable"), "without this every reset needs the office network");
  assert.ok(
    names.some((n) => /^account\.\d+\.sip_trust_ctrl$/.test(n)),
    "notify_reset without sip_trust_ctrl leaves the reset door open to anyone",
  );
  assert.equal(keys.find((k) => k.key === "phone_setting.backlight_time")!.value, "0", "0 is always-on");
  assert.ok(names.includes("voice_mail.number.1"));
  assert.equal(keys.find((k) => k.key === "voice_mail.number.1")!.value, "*97");
});

test("standards are edited in place, never appended as a duplicate key", () => {
  const body = [
    "phone_setting.contrast =",
    "phone_setting.backlight_time = 30",
    "voice_mail.number.1 =",
  ].join("\n");
  const out = applyYealinkStandards(body, LOOPCOM_PHONE_STANDARDS, { accounts: 1 });
  assert.match(out.body, /phone_setting\.backlight_time = 0/);
  // exactly one occurrence - two copies of a key is how a fleet drifts
  assert.equal((out.body.match(/phone_setting\.backlight_time/g) || []).length, 1);
  assert.equal((out.body.match(/voice_mail\.number\.1/g) || []).length, 1);
  assert.ok(out.replaced.includes("phone_setting.backlight_time"));
});

test("a Blade placeholder is VitalPBX's to fill and is left alone", () => {
  // If we replaced this with a literal, the template's own columns would lie
  // about what the phone actually has.
  const body = "local_time.summer_time = {{ $summerTime ?? 2 }}\nphone_setting.backlight_time =";
  const out = applyYealinkStandards(body);
  assert.match(out.body, /\{\{ \$summerTime \?\? 2 \}\}/);
});

test("a key the template never mentions is appended under a labelled banner", () => {
  const out = applyYealinkStandards("phone_setting.contrast =", LOOPCOM_PHONE_STANDARDS, { accounts: 1 });
  assert.ok(out.appended.includes("sip.notify_reset.enable"));
  assert.ok(out.body.includes(STANDARDS_BANNER));
  assert.match(out.body, /sip\.notify_reset\.enable = 1/);
});

test("applying standards twice changes nothing the second time", () => {
  const once = applyYealinkStandards("phone_setting.contrast =").body;
  const twice = applyYealinkStandards(once).body;
  assert.equal(twice, once, "re-running must be a no-op or every render grows the file");
});

/* ── button layout ───────────────────────────────────────────────────────── */

const COLLEAGUES = [
  { extension: "103", displayName: "Sarah Mandel" },
  { extension: "101", displayName: "Reception" },
  { extension: "110", displayName: "Conference room" },
  { extension: "102", displayName: "David Klein" },
  { extension: "120", displayName: "Warehouse" },
  { extension: "104", displayName: "Accounts" },
];

test("a phone never gets a button for its own extension", () => {
  const l = buildButtonLayout({ model: "T54W", ownExtension: "102", colleagues: COLLEAGUES });
  assert.equal(l.placed.length, 5, "six colleagues minus itself");
  assert.ok(!l.placed.some((c) => c.extension === "102"));
  const values = Object.values(l.keys.dss_keys).map((k) => k.value);
  assert.ok(!values.includes("102"), "nobody needs a key to call themselves");
});

test("key 1 is the phone's own line, colleagues start at key 2", () => {
  const l = buildButtonLayout({ model: "T54W", ownExtension: "102", colleagues: COLLEAGUES });
  assert.equal(l.keys.dss_keys["1"].type, DSS_TYPE.LINE);
  assert.equal(l.keys.dss_keys["2"].type, DSS_TYPE.BLF);
  assert.equal(l.keys.dss_keys["2"].value, "101", "lowest extension first");
});

test("colleagues are ordered by extension every time", () => {
  const a = buildButtonLayout({ model: "T54W", ownExtension: "102", colleagues: COLLEAGUES });
  const shuffled = [...COLLEAGUES].reverse();
  const b = buildButtonLayout({ model: "T54W", ownExtension: "102", colleagues: shuffled });
  assert.deepEqual(serializeButtonLayout(a), serializeButtonLayout(b),
    "a layout that reshuffles moves a customer's buttons under their fingers");
});

test("a big office on a small phone reports who did NOT fit", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ extension: String(200 + i), displayName: `P${i}` }));
  const l = buildButtonLayout({ model: "T23G", ownExtension: "199", colleagues: many });
  assert.equal(l.capacity, 3);
  assert.equal(l.placed.length, 2, "one key went to the line");
  assert.equal(l.omitted.length, 28);
  assert.equal(Object.keys(l.keys.dss_keys).length, 3, "never write past the model's key range");
});

test("speed dials take the keys the colleagues did not need", () => {
  const l = buildButtonLayout({
    model: "T42S", ownExtension: "102", colleagues: COLLEAGUES,
    speedDials: [{ label: "Main office", number: "8455550120" }],
  });
  assert.equal(l.speedDialsPlaced.length, 1);
  const sd = Object.values(l.keys.dss_keys).find((k) => k.type === DSS_TYPE.SPEED_DIAL)!;
  assert.equal(sd.value, "8455550120");
  assert.equal(sd.description, "Main office");
  assert.ok(l.free > 0);
});

test("speed dials cannot push a colleague off the phone", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ extension: String(300 + i), displayName: `P${i}` }));
  const l = buildButtonLayout({
    model: "T23G", ownExtension: "299", colleagues: many,
    speedDials: [{ label: "Nope", number: "5551234" }],
  });
  assert.equal(l.speedDialsPlaced.length, 0, "colleagues are placed first");
  assert.equal(l.speedDialsOmitted.length, 1);
});

test("an unknown model gets the smallest safe key count, never a guess upward", () => {
  assert.equal(yealinkKeyCount("T99Z-NEW"), UNKNOWN_MODEL_KEY_COUNT);
  assert.equal(yealinkKeyCount(null), UNKNOWN_MODEL_KEY_COUNT);
  // over-filling silently loses buttons on the desk; under-filling is invisible
  assert.ok(UNKNOWN_MODEL_KEY_COUNT <= yealinkKeyCount("T23G"));
});

test("model names match regardless of punctuation or case", () => {
  assert.equal(yealinkKeyCount("t54w"), 27);
  assert.equal(yealinkKeyCount("T21P_E2"), 2);
  assert.equal(yealinkKeyCount("T21P-E2"), 2);
});

test("the T19 has no programmable keys and gets no layout", () => {
  assert.equal(modelSupportsButtons("T19P_E2"), false);
  const l = buildButtonLayout({ model: "T19P_E2", ownExtension: "101", colleagues: COLLEAGUES });
  assert.equal(l.capacity, 0);
  assert.deepEqual(l.keys.dss_keys, {});
  assert.equal(l.omitted.length, 5, "everyone is reported as omitted, nobody is silently dropped");
});

test("the serialized shape is byte-for-byte what a live customer phone carries", () => {
  const l = buildButtonLayout({
    model: "T42S", ownExtension: "999",
    colleagues: [{ extension: "101", displayName: "Leah Fulop" }],
    reserveOwnLine: false,
  });
  const parsed = JSON.parse(serializeButtonLayout(l));
  assert.deepEqual(parsed.dss_keys["1"], {
    tpl_override: "1", type: "16", description: "Leah Fulop",
    value: "101", extension: "101", line: "1",
  });
});

test("reading a layout back survives every shape that is on live rows", () => {
  // "[]" is a real stored value on production and is NOT a key map.
  assert.deepEqual(parseButtonLayout("[]"), { dss_keys: {} });
  assert.deepEqual(parseButtonLayout(null), { dss_keys: {} });
  assert.deepEqual(parseButtonLayout(""), { dss_keys: {} });
  assert.deepEqual(parseButtonLayout("not json at all"), { dss_keys: {} });
  assert.deepEqual(parseButtonLayout({ dss_keys: null }), { dss_keys: {} });
  const live = '{"dss_keys":{"1":{"tpl_override":"1","type":"16","description":"Leah Fulop","value":"101","extension":"101","line":"1"}}}';
  assert.equal(parseButtonLayout(live).dss_keys["1"].description, "Leah Fulop");
});

test("duplicate colleagues collapse to one button", () => {
  const l = buildButtonLayout({
    model: "T54W", ownExtension: "102",
    colleagues: [{ extension: "101", displayName: "Reception" }, { extension: "101", displayName: "Reception desk" }],
  });
  assert.equal(l.placed.length, 1);
});

/* ── states ──────────────────────────────────────────────────────────────── */

test("every internal state maps to one of the six customer words", () => {
  const allowed = new Set(["Finding", "Preparing", "Restarting", "Connecting", "Ready", "Needs attention"]);
  for (const s of PHONE_STATES) assert.ok(allowed.has(customerStateFor(s)), `${s} leaked`);
});

test("a customer is never shown the word failed", () => {
  assert.equal(customerStateFor("FAILED"), "Needs attention");
  assert.equal(customerStateFor("NEEDS_ATTENTION"), "Needs attention");
});

test("nothing downstream can walk back into a reset authorization", () => {
  const downstream: PhoneState[] = [
    "RESET_REQUESTED", "WAITING_FOR_REBOOT", "REDISCOVERING", "REDISCOVERED",
    "PROVISIONING_CONFIGURED", "PROVISIONING", "WAITING_FOR_REGISTRATION", "REGISTERED",
  ];
  for (const from of downstream) {
    assert.equal(canTransition(from, "RESET_AUTHORIZED"), false,
      `${from} -> RESET_AUTHORIZED would let a retry loop wipe a phone again`);
  }
});

test("a finished phone cannot be dragged back into the machine", () => {
  for (const from of ["REGISTERED", "NEEDS_ATTENTION", "FAILED"] as PhoneState[]) {
    assert.ok(isTerminal(from));
    assert.equal(canTransition(from, "PREPARING"), false);
    assert.equal(canTransition(from, "NEEDS_ATTENTION"), from === "NEEDS_ATTENTION");
  }
});

const rec = (over: Partial<PhoneRecord> = {}): PhoneRecord => ({
  state: "PREPARING", resetCount: 0, resetAuthorizedAt: null, attempts: 0, ...over,
});

test("no authorization means no reset", () => {
  const d = decideReset(rec());
  assert.equal(d.allowed, false);
  assert.equal((d as any).reason, "not_authorized");
});

test("an authorized reset is allowed exactly once", () => {
  assert.equal(decideReset(rec({ resetAuthorizedAt: "2026-08-21T10:05:00Z" })).allowed, true);
  const second = decideReset(rec({ resetAuthorizedAt: "2026-08-21T10:05:00Z", resetCount: 1 }));
  assert.equal(second.allowed, false);
  assert.equal((second as any).reason, "already_reset");
});

test("losing our place can never wipe a phone twice", () => {
  // The record is the memory. Even with a fresh authorization, a phone that has
  // been reset once in this run is refused.
  const d = decideReset(rec({ resetAuthorizedAt: "2026-08-21T11:00:00Z", resetCount: 1, attempts: 1 }));
  assert.equal(d.allowed, false);
});

test("the attempt cap refuses before anything else is considered", () => {
  const d = decideReset(rec({ resetAuthorizedAt: "x", attempts: MAX_ATTEMPTS }));
  assert.equal(d.allowed, false);
  assert.equal((d as any).reason, "attempts_exhausted");
});

test("a finished phone is never reset", () => {
  const d = decideReset(rec({ state: "REGISTERED", resetAuthorizedAt: "x" }));
  assert.equal(d.allowed, false);
  assert.equal((d as any).reason, "terminal");
});

test("the summary counts the wins first", () => {
  const s = summarizeRun(["REGISTERED", "REGISTERED", "REGISTERED", "REGISTERED",
    "REGISTERED", "REGISTERED", "REGISTERED", "NEEDS_ATTENTION"]);
  assert.equal(s.headline, "7 of your 8 phones are ready");
  assert.ok(!/fail/i.test(s.headline));
  assert.equal(s.ready, 7);
  assert.equal(s.needsAttention, 1);
  assert.equal(s.finished, true);
});

test("an all-green run says so plainly", () => {
  assert.equal(summarizeRun(["REGISTERED", "REGISTERED"]).headline, "Your phones are ready");
  assert.equal(summarizeRun(["REGISTERED"]).headline, "Your phone is ready");
});

test("a run still moving reports progress, not a verdict", () => {
  const s = summarizeRun(["REGISTERED", "PROVISIONING", "WAITING_FOR_REBOOT"]);
  assert.equal(s.finished, false);
  assert.equal(s.headline, "1 of 3 phones ready");
});

/* ── device identity ─────────────────────────────────────────────────────── */

test("hardware ids normalise to one comparable form", () => {
  assert.equal(normalizeMac("80:5E:0C:4D:79:6D"), "805e0c4d796d");
  assert.equal(normalizeMac("80-5e-0c-4d-79-6d"), "805e0c4d796d");
  assert.equal(formatMac("805e0c4d796d"), "80:5E:0C:4D:79:6D");
});

test("broadcast, zero and multicast are not devices", () => {
  assert.equal(normalizeMac("ff:ff:ff:ff:ff:ff"), null);
  assert.equal(normalizeMac("00:00:00:00:00:00"), null);
  // 01:00:5e:* fills an ARP table and would put phantom phones in an inventory
  assert.equal(normalizeMac("01:00:5e:00:00:fb"), null);
  assert.equal(normalizeMac("short"), null);
});

test("a Yealink prefix is a hint about what to try first, never proof", () => {
  assert.equal(guessVendorFromMac("80:5e:0c:4d:79:6d").vendor, "yealink");
  assert.equal(guessVendorFromMac("80:5e:0c:4d:79:6d").confidence, "prefix");
  assert.equal(guessVendorFromMac("aa:bb:cc:dd:ee:f0").vendor, "unknown");
});

test("a phone that comes back at a new address is the same phone", () => {
  const before = "192.168.1.41", after = "192.168.1.87";
  const found = [{ mac: "80:5E:0C:BD:13:5A", ip: after }];
  const hit = findByIdentity("805e0cbd135a", before, found)!;
  assert.ok(hit);
  assert.equal(hit.device.ip, after);
  assert.equal(hit.movedFrom, before, "the move is recorded, not inferred later");
  assert.equal(matchDevice("805e0cbd135a", found[0]).kind, "same");
});

test("a device we cannot identify is reported, never treated as new", () => {
  const m = matchDevice("805e0cbd135a", { mac: "not-a-mac", ip: "192.168.1.9" });
  assert.equal(m.kind, "unusable", "a phone we cannot identify is the one we must not touch");
});

test("the record versus the desk splits cleanly into three buckets", () => {
  const found = [
    { mac: "80:5E:0C:BD:13:5A", ip: "192.168.1.10" },
    { mac: "80:5E:C0:20:F2:47", ip: "192.168.1.11" },
  ];
  const records = [
    { mac: "80:5e:0c:bd:13:5a", description: "101" },
    { mac: "00:15:65:D4:99:C0", description: "112" },
  ];
  const cmp = compareToPbxRecords(found, records);
  assert.equal(cmp.matched.length, 1);
  assert.equal(cmp.matched[0].pbxDescription, "101");
  assert.equal(cmp.onNetworkOnly.length, 1, "a phone nobody is provisioning");
  assert.equal(cmp.onRecordOnly.length, 1, "a record no handset will ever download");
});

/* ── escalation ──────────────────────────────────────────────────────────── */

const cond = (over: Partial<PhoneCondition> = {}): PhoneCondition => ({
  registeredToUs: false, provisioningIsOurs: false, reachableOnLan: true, locked: false,
  defaultCredentialsTried: false, haveCustomerCredentials: false, oldSettingsInWay: false,
  modelProfileMissing: false, firmwareTooOld: false, provisioningRevertedAfterReset: false,
  networkSuppliesOldProvisioning: false, awaitingReboot: false, onACall: false,
  passwordUnavailable: false, resetDeclined: false, ...over,
});

test("a phone that already works is never touched", () => {
  const e = nextEscalation(cond({ registeredToUs: true, provisioningIsOurs: true }), rec());
  assert.equal(e.action, "do_nothing");
  assert.equal(e.rung, 0);
});

test("a phone with somebody on a call is never restarted", () => {
  const e = nextEscalation(cond({ onACall: true, oldSettingsInWay: true, registeredToUs: true }), rec({ resetAuthorizedAt: "x" }));
  assert.equal(e.action, "do_nothing");
  assert.ok(!/reset/.test(e.action));
});

test("registered but stale gets the cheapest possible fix", () => {
  const e = nextEscalation(cond({ registeredToUs: true, provisioningIsOurs: false }), rec());
  assert.equal(e.action, "check_sync", "no restart, no office access, nobody notices");
});

test("a reset needs a person, and asks rather than doing", () => {
  const e = nextEscalation(cond({ oldSettingsInWay: true }), rec());
  assert.equal(e.action, "request_reset_authorization");
  // the customer is told WHY, in their words, before being asked to approve anything
  assert.ok(e.customerMessage, "asking for approval without saying why is not consent");
  assert.match(e.customerMessage!, /previous phone system/i);
});

test("an approved reset prefers the PBX over the office network", () => {
  const e = nextEscalation(
    cond({ oldSettingsInWay: true, registeredToUs: true, provisioningIsOurs: false, reachableOnLan: true }),
    rec({ resetAuthorizedAt: "2026-08-21T10:05:00Z" }),
  );
  // ⛔ check_sync is cheaper, so a registered phone is redirected before it is wiped
  assert.equal(e.action, "check_sync");
});

test("an approved reset on a phone that never reached us goes over the office network", () => {
  const e = nextEscalation(
    cond({ oldSettingsInWay: true, registeredToUs: false, reachableOnLan: true, locked: false }),
    rec({ resetAuthorizedAt: "2026-08-21T10:05:00Z" }),
  );
  assert.equal(e.action, "reset_over_lan");
});

test("the default password is tried once and then a person is asked", () => {
  const first = nextEscalation(cond({ locked: true }), rec());
  assert.equal(first.action, "try_default_credentials");
  const second = nextEscalation(cond({ locked: true, defaultCredentialsTried: true }), rec());
  assert.equal(second.action, "ask_for_password", "never a second guess");
});

test("a manufacturer redirect and a router override are told apart", () => {
  const rps = nextEscalation(cond({ provisioningRevertedAfterReset: true }), rec());
  assert.equal(rps.handOff, "previous_provider");
  assert.equal(rps.halted, true);

  const dhcp = nextEscalation(
    cond({ provisioningRevertedAfterReset: true, networkSuppliesOldProvisioning: true }), rec());
  assert.equal(dhcp.handOff, "customer_network");
  assert.match(dhcp.customerMessage!, /will not change your router/i);
});

test("neither stopping condition is ever retried", () => {
  for (const c of [
    cond({ provisioningRevertedAfterReset: true }),
    cond({ provisioningRevertedAfterReset: true, networkSuppliesOldProvisioning: true }),
  ]) {
    const e = nextEscalation(c, rec());
    assert.equal(e.action, "halt", "a loop is not persistence");
  }
});

test("the attempt cap stops the ladder before it touches the phone again", () => {
  const e = nextEscalation(cond({ oldSettingsInWay: true }), rec({ attempts: 2, resetAuthorizedAt: "x" }));
  assert.equal(e.action, "halt");
  assert.equal(e.halted, true);
});

test("an unknown model has its settings written before the phone is touched", () => {
  const e = nextEscalation(cond({ modelProfileMissing: true, oldSettingsInWay: true }), rec());
  assert.equal(e.action, "generate_template");
});

test("firmware is never flashed automatically", () => {
  const e = nextEscalation(cond({ firmwareTooOld: true }), rec());
  assert.equal(e.action, "halt");
  assert.equal(e.handOff, "support");
});

test("a restarting phone is followed, not re-reset", () => {
  const e = nextEscalation(cond({ awaitingReboot: true, oldSettingsInWay: true }), rec({ resetAuthorizedAt: "x" }));
  assert.equal(e.action, "rediscover");
});

test("every branch returns an action from the closed list", () => {
  const allowed = new Set<string>(SETUP_ACTIONS as readonly string[]);
  const cases: PhoneCondition[] = [
    cond(), cond({ registeredToUs: true, provisioningIsOurs: true }), cond({ onACall: true }),
    cond({ locked: true }), cond({ locked: true, defaultCredentialsTried: true }),
    cond({ oldSettingsInWay: true }), cond({ modelProfileMissing: true }), cond({ firmwareTooOld: true }),
    cond({ awaitingReboot: true }), cond({ provisioningRevertedAfterReset: true }),
    cond({ provisioningIsOurs: true, reachableOnLan: false }), cond({ reachableOnLan: false }),
  ];
  for (const c of cases) {
    for (const r of [rec(), rec({ attempts: 2 }), rec({ resetAuthorizedAt: "x" })]) {
      assert.ok(allowed.has(nextEscalation(c, r).action), "the model may only choose from the list");
    }
  }
});

test("a customer is never shown a status code or a protocol word", () => {
  const banned = /\b(http|https|401|403|404|500|sip|dhcp|option\s*66|rps|tftp|mac|subnet|ip address)\b/i;
  for (const kind of [
    "auth_required", "unreachable", "reset_timeout", "provisioning_rejected",
    "registration_timeout", "previous_provider", "network_override", "model_unsupported", "unknown",
  ] as const) {
    const f = customerFacingFailure(kind);
    assert.ok(!banned.test(f.message), `${kind} leaked jargon: ${f.message}`);
    assert.ok(f.message.length > 10);
  }
});

test("the two unfixable problems offer help rather than a retry", () => {
  for (const kind of ["previous_provider", "network_override"] as const) {
    const f = customerFacingFailure(kind);
    assert.equal(f.canRetry, false);
    assert.equal(f.getHelp, true);
  }
});

test("text a device gave us is bounded and stripped before it goes anywhere", () => {
  const nasty = "ok bad\u0007wrong\u202egnorw\u202c " + "x".repeat(500);
  const clean = sanitizeDeviceText(nasty);
  assert.ok(clean.length <= 200);
  assert.ok(!/[\u0000-\u001f]/.test(clean), "control characters break log lines");
  assert.ok(!/[\u202a-\u202e\u2066-\u2069]/.test(clean), "bidi overrides reorder what a reviewer reads");
});

test("a device cannot inject a newline into a diagnostics line", () => {
  assert.equal(sanitizeDeviceText("line one\nline two"), "line one line two");
});

test("a device that answered SIP is fingerprinted whatever its hardware block says", () => {
  // ⛔ 2026-08-25: an unknown-OUI SIP box used to be filed under "other devices"
  // forever — no fingerprint call, no chance to identify itself. Answering SIP
  // is the device behaving like a SIP device right now.
  assert.equal(shouldFingerprint({ mac: "aa:bb:cc:00:11:22", respondedOnSip: true }), true);
  assert.equal(shouldFingerprint({ mac: "aa:bb:cc:00:11:22" }), false);
});
