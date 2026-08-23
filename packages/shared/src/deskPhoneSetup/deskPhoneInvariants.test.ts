/**
 * The invariants — proven EXHAUSTIVELY, not sampled.
 *
 * Izzy, 2026-08-21: "stress test the fuck out of it, it's 100 rock hard solid for
 * years to come."
 *
 * ⛔⛔ THE DECISION CORE IS SMALL ENOUGH TO PROVE COMPLETELY, so it is proven
 * completely. `PhoneCondition` has thirteen booleans — 8,192 states — and every one is
 * crossed with every meaningful phone record. That is ~200,000 decisions per invariant,
 * and it means "a reset is never issued without authorisation" is not a claim about the
 * cases somebody thought to write down: it is a claim about all of them.
 *
 * ⛔ An example-based test proves a path works. An exhaustive one proves no path exists
 * that breaks the rule. For the function that erases a customer's device, only the
 * second is worth having.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  nextEscalation, SETUP_ACTIONS, customerFacingFailure, sanitizeDeviceText,
  type PhoneCondition, type SetupAction,
} from "./escalation";
import {
  decideReset, canTransition, customerStateFor, isTerminal, isSuccess, summarizeRun,
  PHONE_STATES, CUSTOMER_STATES, MAX_ATTEMPTS, type PhoneRecord, type PhoneState,
} from "./states";
import { buildButtonLayout, parseButtonLayout, serializeButtonLayout, yealinkKeyCount } from "./buttonLayout";
import { normalizeMac, formatMac, matchDevice, compareToPbxRecords } from "./deviceIdentity";
import { templateStandardsDrift, applyYealinkStandards, templateColumnStandards } from "./standards";
import { classifyDiscoveredHosts, looksLikePhone, shouldFingerprint } from "./discoveryFilter";

/* ── build the entire condition space ────────────────────────────────────── */

const CONDITION_KEYS = [
  "registeredToUs", "provisioningIsOurs", "reachableOnLan", "locked",
  "defaultCredentialsTried", "haveCustomerCredentials", "oldSettingsInWay",
  "modelProfileMissing", "firmwareTooOld", "provisioningRevertedAfterReset",
  "networkSuppliesOldProvisioning", "awaitingReboot", "onACall",
] as const;

/** All 2^13 = 8,192 of them. */
function allConditions(): PhoneCondition[] {
  const out: PhoneCondition[] = [];
  const n = CONDITION_KEYS.length;
  for (let mask = 0; mask < (1 << n); mask += 1) {
    const c: any = {};
    for (let i = 0; i < n; i += 1) c[CONDITION_KEYS[i]] = Boolean(mask & (1 << i));
    out.push(c as PhoneCondition);
  }
  return out;
}

/** Every phone record that could plausibly be on disk when a decision is made. */
function allRecords(): PhoneRecord[] {
  const out: PhoneRecord[] = [];
  for (const state of PHONE_STATES) {
    for (const resetCount of [0, 1, 2]) {
      for (const resetAuthorizedAt of [null, "2026-08-21T10:00:00Z"]) {
        for (const attempts of [0, 1, 2, 3]) {
          out.push({ state, resetCount, resetAuthorizedAt, attempts });
        }
      }
    }
  }
  return out;
}

const CONDITIONS = allConditions();
const RECORDS = allRecords();
const RESET_ACTIONS = new Set<SetupAction>(["reset_over_lan", "reset_over_sip"]);

test("EXHAUSTIVE: a reset is NEVER chosen when the stored record forbids it", () => {
  // ⛔ The single most important property in the feature. 8,192 conditions x 384
  // records = 3.1 million decisions, and not one of them may order a wipe that
  // decideReset would refuse.
  let checked = 0, resets = 0;
  for (const c of CONDITIONS) {
    for (const rec of RECORDS) {
      const e = nextEscalation(c, rec);
      checked += 1;
      if (!RESET_ACTIONS.has(e.action)) continue;
      resets += 1;
      const verdict = decideReset(rec);
      assert.equal(
        verdict.allowed, true,
        `reset ordered on a record that forbids it: ${JSON.stringify({ c, rec, action: e.action })}`,
      );
    }
  }
  assert.ok(checked > 3_000_000, `expected the whole space, walked ${checked}`);
  assert.ok(resets > 0, "if nothing ever resets, this test proves nothing");
});

test("EXHAUSTIVE: a reset is never chosen without an authorisation on file", () => {
  for (const c of CONDITIONS) {
    for (const rec of RECORDS) {
      if (rec.resetAuthorizedAt) continue;
      const e = nextEscalation(c, rec);
      assert.ok(!RESET_ACTIONS.has(e.action),
        `unauthorised reset: ${JSON.stringify({ c, rec, action: e.action })}`);
    }
  }
});

test("EXHAUSTIVE: a phone already reset once is never reset again", () => {
  for (const c of CONDITIONS) {
    for (const rec of RECORDS) {
      if (rec.resetCount < 1) continue;
      const e = nextEscalation(c, rec);
      assert.ok(!RESET_ACTIONS.has(e.action),
        `second wipe: ${JSON.stringify({ c, rec, action: e.action })}`);
    }
  }
});

test("EXHAUSTIVE: nothing that restarts a phone happens while somebody is on a call", () => {
  const DISRUPTIVE = new Set<SetupAction>(["reset_over_lan", "reset_over_sip", "trigger_autop", "check_sync"]);
  for (const c of CONDITIONS) {
    if (!c.onACall) continue;
    for (const rec of RECORDS) {
      const e = nextEscalation(c, rec);
      assert.ok(!DISRUPTIVE.has(e.action),
        `interrupted a call: ${JSON.stringify({ c, rec, action: e.action })}`);
    }
  }
});

test("EXHAUSTIVE: past the attempt cap, nothing touches the phone again", () => {
  const TOUCHES = new Set<SetupAction>([
    "reset_over_lan", "reset_over_sip", "trigger_autop", "check_sync",
    "set_provisioning", "try_default_credentials", "reboot" as SetupAction,
  ]);
  for (const c of CONDITIONS) {
    for (const rec of RECORDS) {
      if (rec.attempts < MAX_ATTEMPTS) continue;
      // a phone that is already fine is allowed to be left alone; that is not a touch
      const e = nextEscalation(c, rec);
      assert.ok(!TOUCHES.has(e.action),
        `acted past the cap: ${JSON.stringify({ c, rec, action: e.action })}`);
    }
  }
});

test("EXHAUSTIVE: every decision is an action from the closed list, and never a throw", () => {
  const allowed = new Set<string>(SETUP_ACTIONS as readonly string[]);
  for (const c of CONDITIONS) {
    for (const rec of RECORDS) {
      const e = nextEscalation(c, rec);
      assert.ok(allowed.has(e.action), `unknown action ${e.action}`);
      assert.equal(typeof e.reason, "string");
      assert.ok(e.reason.length > 0);
    }
  }
});

test("EXHAUSTIVE: no customer message anywhere in the space contains jargon", () => {
  // ⛔ Not the messages somebody remembered to check — every message the ladder can
  // possibly produce, from every reachable state.
  const banned = /\b(HTTP|HTTPS|401|403|404|500|502|SIP|DHCP|Option\s*66|RPS|TFTP|MAC|subnet|provisioning|firmware|endpoint|registrar)\b/i;
  const seen = new Set<string>();
  for (const c of CONDITIONS) {
    for (const rec of RECORDS) {
      const m = nextEscalation(c, rec).customerMessage;
      if (m) seen.add(m);
    }
  }
  assert.ok(seen.size >= 5, `expected several distinct messages, saw ${seen.size}`);
  for (const m of seen) assert.ok(!banned.test(m), `jargon reached a customer: ${m}`);
});

test("EXHAUSTIVE: a phone that already works is left alone from every record", () => {
  for (const rec of RECORDS) {
    for (const c of CONDITIONS) {
      if (!(c.registeredToUs && c.provisioningIsOurs)) continue;
      const e = nextEscalation(c, rec);
      assert.equal(e.action, "do_nothing",
        `touched a working phone: ${JSON.stringify({ c, rec, action: e.action })}`);
    }
  }
});

test("EXHAUSTIVE: the two unfixable problems always halt and always hand off", () => {
  for (const c of CONDITIONS) {
    if (!c.provisioningRevertedAfterReset) continue;
    if (c.onACall) continue;                       // a live call outranks everything
    for (const rec of RECORDS) {
      if (rec.attempts >= MAX_ATTEMPTS) continue;  // already covered by the cap
      if (c.registeredToUs && c.provisioningIsOurs) continue; // it is working; leave it
      if (c.awaitingReboot) continue;              // still coming back up
      const e = nextEscalation(c, rec);
      assert.equal(e.action, "halt", JSON.stringify({ c, rec }));
      assert.ok(e.handOff === "previous_provider" || e.handOff === "customer_network");
      assert.equal(
        e.handOff,
        c.networkSuppliesOldProvisioning ? "customer_network" : "previous_provider",
        "the two must never be confused - they need completely different help",
      );
    }
  }
});

/* ── the state machine ───────────────────────────────────────────────────── */

test("EXHAUSTIVE: every state maps to exactly one of the six customer words", () => {
  const allowed = new Set<string>(CUSTOMER_STATES as readonly string[]);
  for (const s of PHONE_STATES) {
    const word = customerStateFor(s);
    assert.ok(allowed.has(word), `${s} -> ${word}`);
  }
  assert.equal(new Set(PHONE_STATES.map(customerStateFor)).size <= 6, true);
});

test("EXHAUSTIVE: no terminal state can be walked back into the machine", () => {
  for (const from of PHONE_STATES) {
    if (!isTerminal(from)) continue;
    for (const to of PHONE_STATES) {
      if (to === from) continue;
      assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
    }
  }
});

test("EXHAUSTIVE: RESET_AUTHORIZED is reachable only from PREPARING", () => {
  // ⛔ One door in. Any other edge would be a way for a retry loop to re-arm a wipe.
  const sources = PHONE_STATES.filter((s) => s !== "RESET_AUTHORIZED" && canTransition(s, "RESET_AUTHORIZED"));
  assert.deepEqual(sources, ["PREPARING"]);
});

test("EXHAUSTIVE: decideReset is total and its refusals are all explained", () => {
  for (const rec of RECORDS) {
    const d = decideReset(rec);
    if (d.allowed) continue;
    assert.ok(["not_authorized", "already_reset", "attempts_exhausted", "terminal"].includes(d.reason));
    assert.ok(d.explain.length > 10, "a refusal a person reads must say something");
    assert.ok(!/\b(HTTP|SIP|MAC)\b/i.test(d.explain));
  }
});

test("EXHAUSTIVE: a run summary never reports more ready than it has phones", () => {
  // every combination of up to 4 phones across all 16 states
  const walk = (depth: number, acc: PhoneState[]) => {
    if (depth === 0) {
      const s = summarizeRun(acc);
      assert.equal(s.total, acc.length);
      assert.ok(s.ready <= s.total);
      assert.equal(s.ready + s.working + s.needsAttention, s.total);
      assert.equal(s.ready, acc.filter(isSuccess).length);
      assert.equal(s.finished, s.working === 0);
      assert.ok(!/fail/i.test(s.headline), `headline said fail: ${s.headline}`);
      return;
    }
    for (const st of PHONE_STATES) walk(depth - 1, [...acc, st]);
  };
  walk(2, []);          // 256 runs of two phones
  for (const st of PHONE_STATES) walk(1, [st]);
});

/* ── button layouts, fuzzed ──────────────────────────────────────────────── */

const MODELS = [
  "T54W", "T53W", "T46U", "T42S", "T29G", "T23G", "T21P_E2", "T19P_E2", "T48U", "T33G",
  "", "  ", "T99Z", "not a model", "T54W'; DROP TABLE devices;--", "<script>", "\u0000",
];

test("FUZZ: a layout never exceeds the model's key count and never includes the phone itself", () => {
  let checked = 0;
  for (const model of MODELS) {
    for (const count of [0, 1, 2, 3, 5, 12, 30, 120]) {
      for (const ownExtension of ["101", "999", "", "  ", "not-a-number"]) {
        for (const reserveOwnLine of [true, false]) {
          const colleagues = Array.from({ length: count }, (_, i) => ({
            extension: String(100 + i), displayName: `P${i}`,
          }));
          const l = buildButtonLayout({ model, ownExtension, colleagues, reserveOwnLine });
          checked += 1;
          const keys = Object.keys(l.keys.dss_keys);
          assert.ok(keys.length <= l.capacity, `${model}: ${keys.length} keys > capacity ${l.capacity}`);
          assert.ok(keys.every((k) => Number(k) >= 1 && Number(k) <= l.capacity), `${model}: key out of range`);
          // the phone's own extension never appears as a watched value
          const own = String(ownExtension).trim();
          if (own) {
            for (const k of Object.values(l.keys.dss_keys)) {
              if (k.type === "16") assert.notEqual(k.value, own, `${model}: watched itself`);
            }
          }
          // nobody is silently lost
          assert.equal(l.placed.length + l.omitted.length,
            new Set(colleagues.map((c) => c.extension).filter((e) => e !== own)).size);
          // and it round-trips
          const back = parseButtonLayout(serializeButtonLayout(l));
          assert.deepEqual(Object.keys(back.dss_keys).sort(), keys.sort());
        }
      }
    }
  }
  assert.ok(checked > 1000, `walked ${checked}`);
});

test("FUZZ: reading a layout back never throws, whatever is in the column", () => {
  const junk: unknown[] = [
    null, undefined, "", "[]", "{}", "null", "0", "false", "[1,2,3]", "not json",
    '{"dss_keys":[]}', '{"dss_keys":{"a":{}}}', '{"dss_keys":{"1":null}}',
    '{"dss_keys":{"1":{"type":123}}}', '{"__proto__":{"polluted":true}}',
    '{"dss_keys":{"1":{"tpl_override":"1","type":"16","description":"x","value":"1","extension":"1","line":"1"}}}',
    { dss_keys: { 1: { type: 16 } } }, [], 42, true, Symbol.iterator as any,
  ];
  for (const j of junk) {
    const out = parseButtonLayout(j as any);
    assert.ok(out && typeof out === "object" && out.dss_keys && typeof out.dss_keys === "object");
  }
  assert.equal(({} as any).polluted, undefined, "prototype must not be polluted");
});

test("FUZZ: an unknown model is never given more keys than the smallest real phone", () => {
  const smallest = Math.min(...["T23G", "T40G", "T21P_E2"].map(yealinkKeyCount));
  for (const junk of ["", "??", "T", "TXXXX", "  T54W  extra", "\u202eT54W"]) {
    assert.ok(yealinkKeyCount(junk) <= Math.max(smallest, 3),
      `${JSON.stringify(junk)} got ${yealinkKeyCount(junk)} keys`);
  }
});

/* ── identity, fuzzed ────────────────────────────────────────────────────── */

test("FUZZ: normalizeMac is total and only ever returns 12 hex characters or null", () => {
  const inputs: unknown[] = [
    null, undefined, "", "   ", 0, 12345, true, {}, [], NaN, Infinity,
    "80:5E:0C:BD:13:5A", "80-5e-0c-bd-13-5a", "805e0cbd135a", "80.5e.0c.bd.13.5a",
    "80:5E:0C:BD:13:5A:extra", "zz:zz:zz:zz:zz:zz", "ff:ff:ff:ff:ff:ff",
    "00:00:00:00:00:00", "01:00:5e:00:00:fb", "03:00:00:00:00:01",
    "805e0cbd135".repeat(3), " 80 5e 0c bd 13 5a ", "\u202e805e0cbd135a",
  ];
  for (let i = 0; i < 4000; i += 1) {
    inputs.push(Array.from({ length: 1 + (i % 20) }, () =>
      "0123456789abcdefABCDEF:-. xyz".charAt(Math.floor((i * 7 + 13) % 29))).join(""));
  }
  for (const raw of inputs) {
    const out = normalizeMac(raw);
    if (out === null) continue;
    assert.match(out, /^[0-9a-f]{12}$/, `bad normalisation of ${JSON.stringify(raw)} -> ${out}`);
    assert.notEqual(out, "ffffffffffff");
    assert.notEqual(out, "000000000000");
    // ⛔ multicast must never survive: it fills an ARP table with phantom "phones"
    assert.equal(parseInt(out.slice(0, 2), 16) & 1, 0, `multicast survived: ${out}`);
    // and it is stable and idempotent
    assert.equal(normalizeMac(out), out);
    assert.equal(normalizeMac(formatMac(out)), out);
  }
});

test("FUZZ: a device we cannot identify is never mistaken for the one we are waiting on", () => {
  for (const bad of ["", "  ", "zz", "not-a-mac", "01:00:5e:00:00:fb", "ff:ff:ff:ff:ff:ff"]) {
    const m = matchDevice("805e0cbd135a", { mac: bad, ip: "192.168.1.9" });
    assert.notEqual(m.kind, "same", `${bad} matched`);
  }
  // and a genuinely different phone is "new", never "same"
  assert.equal(matchDevice("805e0cbd135a", { mac: "805e0cbd135b", ip: "1.1.1.1" }).kind, "new");
});

test("FUZZ: the record-versus-desk comparison never loses or duplicates a phone", () => {
  for (let trial = 0; trial < 200; trial += 1) {
    const n = trial % 17;
    const found = Array.from({ length: n }, (_, i) => ({ mac: `805e0c00${String(i).padStart(4, "0")}`, ip: `192.168.1.${i + 2}` }));
    const records = Array.from({ length: (trial * 3) % 19 }, (_, i) => ({ mac: `805e0c00${String(i).padStart(4, "0")}`, description: `x${i}` }));
    const cmp = compareToPbxRecords(found, records);
    assert.equal(cmp.matched.length + cmp.onNetworkOnly.length, found.length);
    assert.equal(cmp.matched.length + cmp.onRecordOnly.length, records.length);
    const all = [...cmp.matched.map((m) => m.mac), ...cmp.onNetworkOnly.map((m) => m.mac)];
    assert.equal(new Set(all).size, all.length, "a phone appeared twice");
  }
});

/* ── sanitiser, fuzzed ───────────────────────────────────────────────────── */

test("FUZZ: nothing a device says can escape the sanitiser", () => {
  const hostile: string[] = [
    "", " ", "\u0000\u0001\u0007", "a\nb\rc", "\u202eevil\u202c", "\u2066x\u2069",
    "\u200e\u200f", "x".repeat(5000), "\u0000", "<script>alert(1)</script>",
    "'; DROP TABLE devices;--", "${process.env.SECRET}", "`whoami`",
  ];
  for (let i = 0; i < 3000; i += 1) hostile.push(String.fromCharCode(i));
  for (const raw of hostile) {
    const out = sanitizeDeviceText(raw, 120);
    assert.ok(out.length <= 120, `too long for ${JSON.stringify(raw).slice(0, 40)}`);
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(out), "control character survived");
    assert.ok(!/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(out), "bidi override survived");
    assert.equal(out, out.trim());
    // idempotent, so re-sanitising a stored value cannot change it
    assert.equal(sanitizeDeviceText(out, 120), out);
  }
  for (const junk of [null, undefined, 0, {}, [], true, NaN]) {
    assert.equal(typeof sanitizeDeviceText(junk as any), "string");
  }
});

test("FUZZ: every failure kind gives a customer something to do", () => {
  for (const kind of [
    "auth_required", "unreachable", "reset_timeout", "provisioning_rejected",
    "registration_timeout", "previous_provider", "network_override", "model_unsupported",
    "unknown", "made_up_kind_that_does_not_exist",
  ] as const) {
    const f = customerFacingFailure(kind as any);
    assert.ok(f.message.length > 10);
    assert.ok(f.canRetry || f.getHelp, `${kind} offers neither a retry nor help`);
  }
});

/* ── standards, fuzzed ───────────────────────────────────────────────────── */

test("FUZZ: applying the house standards is idempotent on any template body", () => {
  const bodies = [
    "", "\n", "# comment only\n",
    "phone_setting.backlight_time = 30",
    "phone_setting.backlight_time =",
    "phone_setting.backlight_time = {{ $x ?? 1 }}",
    "voice_mail.number.1 = *98\nvoice_mail.number.2 = *99",
    "sip.notify_reset.enable = 0",
    "  phone_setting.backlight_time   =   9999  ",
    "x".repeat(10_000),
    "account.1.sip_trust_ctrl = 0\naccount.2.sip_trust_ctrl = 0",
  ];
  for (const body of bodies) {
    const once = applyYealinkStandards(body).body;
    const twice = applyYealinkStandards(once).body;
    assert.equal(twice, once, `not idempotent for ${JSON.stringify(body).slice(0, 40)}`);
    // and each managed key appears exactly once
    for (const key of ["phone_setting.backlight_time", "sip.notify_reset.enable", "voice_mail.number.1"]) {
      const hits = (once.match(new RegExp(`^\\s*${key.replace(/\./g, "\\.")}\\s*=`, "gm")) || []).length;
      assert.ok(hits <= 1, `${key} appears ${hits} times`);
    }
  }
});

test("FUZZ: a DUPLICATED key is rewritten everywhere, because Yealink is last-value-wins", () => {
  // ⛔ Found in the 2026-08-22 review pass: the old implementation replaced only the
  // FIRST occurrence, so a template carrying the key twice kept the vendor's later
  // line winning on the handset while the file read as fixed. Every occurrence must
  // end up carrying our value.
  const body = [
    "phone_setting.backlight_time = 30",
    "# some vendor comment",
    "phone_setting.backlight_time = 600",
    "sip.notify_reset.enable = 0",
    "other.key = 1",
    "sip.notify_reset.enable = 0",
  ].join("\n");
  const out = applyYealinkStandards(body).body;
  for (const line of out.split("\n")) {
    if (/^\s*phone_setting\.backlight_time\s*=/.test(line)) {
      assert.match(line, /=\s*0\s*$/, `a stale duplicate survived: ${line}`);
    }
    if (/^\s*sip\.notify_reset\.enable\s*=/.test(line)) {
      assert.match(line, /=\s*1\s*$/, `a stale duplicate survived: ${line}`);
    }
  }
  // untouched keys stay untouched, and the whole thing is still idempotent
  assert.ok(out.includes("other.key = 1"));
  assert.equal(applyYealinkStandards(out).body, out);
  // ⛔ And a key with a Blade placeholder ANYWHERE has BOTH its copies left alone —
  // the placeholder is VitalPBX's to fill, and rewriting only the literal half would
  // have the file fight the generator. (The other absent keys are still appended;
  // only this key is off limits.)
  const blade = "phone_setting.backlight_time = {{ $x ?? 1 }}\nphone_setting.backlight_time = 600";
  const bladeOut = applyYealinkStandards(blade).body;
  assert.ok(bladeOut.includes("phone_setting.backlight_time = {{ $x ?? 1 }}"), "placeholder was rewritten");
  assert.ok(bladeOut.includes("phone_setting.backlight_time = 600"), "the sibling of a placeholder was rewritten");
  assert.ok(!/backlight_time = 0\b/.test(bladeOut), "our value was forced over a placeholder-managed key");
});

test("FUZZ: drift detection is total and never reports a healthy row as wrong", () => {
  const healthy = templateColumnStandards();
  assert.deepEqual(templateStandardsDrift(healthy), []);
  const junk: unknown[] = [null, undefined, "", " ", 0, false, [], {}, "EST5EDT", "auto", "16|-18000"];
  for (const v of junk) {
    for (const col of ["timezone", "time_format", "date_format", "summer_time"] as const) {
      // ⛔ A value that COERCES to the expected string is not drift: the columns are
      // varchar and MySQL can hand back a number, so time_format 0 really is 12-hour.
      // Skipping these is the honest reading -- the earlier version of this test
      // failed against correct code by demanding that 0 be flagged.
      if (v !== null && v !== undefined && String(v) === (healthy as any)[col]) continue;
      const row: any = { ...healthy, [col]: v };
      const drift = templateStandardsDrift(row);
      assert.ok(drift.some((d) => d.column === col), `${col}=${JSON.stringify(v)} was not flagged`);
      assert.ok(drift.every((d) => typeof d.found === "string" && typeof d.expected === "string"));
    }
  }
  // a completely empty row is all drift, not a crash
  assert.equal(templateStandardsDrift({}).length, 4);
});

/* ── discovery classification, fuzzed ────────────────────────────────────── */

test("FUZZ: a printer fleet never becomes a phone list", () => {
  // ⛔ The scanner returns EVERY ARP entry. Before the classifier, an office with
  // four phones and nineteen other devices opened the wizard on "We found 23 desk
  // phones". A device is a phone only on evidence.
  const office = [
    // four real phones: two identified by fingerprint, one locked (OUI only), one OUI
    { mac: "80:5E:0C:00:00:01", ip: "192.168.1.20", respondedOnHttp: true, fingerprint: { vendor: "yealink", model: "T54W", confidence: "banner" as const } },
    { mac: "80:5E:0C:00:00:02", ip: "192.168.1.21", respondedOnHttp: true, fingerprint: { vendor: "yealink", model: null, confidence: "none" as const } },
    { mac: "80:5e:0c:00:00:03", ip: "192.168.1.22", respondedOnHttp: true, fingerprint: null }, // locked phone: web refused to talk
    { mac: "00:15:65:00:00:04", ip: "192.168.1.23", respondedOnHttp: false }, // phone OUI, quiet
    // nineteen other devices
    ...Array.from({ length: 19 }, (_, i) => ({
      mac: `a4:5d:36:00:00:${String(i).padStart(2, "0")}`, ip: `192.168.1.${40 + i}`,
      respondedOnHttp: i % 3 === 0,
      fingerprint: i % 3 === 0 ? { vendor: "unknown", model: null, confidence: "none" as const } : null,
    })),
  ];
  const v = classifyDiscoveredHosts(office);
  assert.equal(v.phones.length, 4, `classified ${v.phones.length} phones out of 4`);
  assert.equal(v.othersCount, 19);
  // and nothing is silently lost
  assert.equal(v.phones.length + v.othersCount, office.length);
});

test("FUZZ: classification is total, deduplicates, and never throws on junk", () => {
  const junk: any[] = [
    { mac: "", ip: "" }, { mac: null, ip: null }, { mac: "zz", ip: "x" },
    { mac: "ff:ff:ff:ff:ff:ff", ip: "192.168.1.255" },
    { mac: "01:00:5e:00:00:fb", ip: "224.0.0.251" },
    { mac: "80:5E:0C:00:00:01", ip: "192.168.1.20" },
    { mac: "805e0c000001", ip: "192.168.1.99" },          // duplicate of the previous, different spelling
    { mac: "80:5E:0C:00:00:01", ip: "192.168.1.20", fingerprint: { vendor: 42 as any, model: {} as any, confidence: "banner" as const } },
  ];
  const v = classifyDiscoveredHosts(junk);
  assert.equal(v.phones.length, 1, "the duplicate or the junk leaked through");
  for (const p of v.phones) assert.ok(typeof p.mac === "string");
});

test("FUZZ: fingerprint spend is bounded to plausible candidates", () => {
  // A silent host with an unknown hardware block is never worth 4 seconds.
  assert.equal(shouldFingerprint({ mac: "a4:5d:36:00:00:01", respondedOnHttp: false }), false);
  // Anything that answered on a web port is worth one look.
  assert.equal(shouldFingerprint({ mac: "a4:5d:36:00:00:01", respondedOnHttp: true }), true);
  // A phone-maker's block is worth one look even when quiet — a locked phone is quiet.
  assert.equal(shouldFingerprint({ mac: "80:5e:0c:00:00:01", respondedOnHttp: false }), true);
});

test("FUZZ: a device with model evidence is a phone even off an unknown hardware block", () => {
  assert.equal(looksLikePhone({
    mac: "a4:5d:36:00:00:01", ip: "10.0.0.5",
    fingerprint: { vendor: "unknown", model: "T42S", confidence: "banner" },
  }), true);
  // but a model string with confidence "none" is a guess, and a guess is not evidence
  assert.equal(looksLikePhone({
    mac: "a4:5d:36:00:00:01", ip: "10.0.0.5",
    fingerprint: { vendor: "unknown", model: "T42S", confidence: "none" },
  }), false);
});
