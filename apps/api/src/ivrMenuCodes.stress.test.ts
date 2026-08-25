// Hidden menu codes — stress suite.
//
// The unit tests prove the cases somebody thought of; this drives the ones
// nobody did: hostile code strings, randomized option sets, whole simulated
// publish LIFETIMES (add → publish → delete → failed publish → republish …)
// with the AstDB modelled so the one invariant that matters is checked after
// every step — a code answers callers if and only if a live, enabled option
// row says it should. Every randomized run is seeded and the seed is in the
// failure message, so a red run is reproducible.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isIvrMenuCode, ivrMenuCodeKey, buildMenuCodeKeys, diffStaleIvrCodeTombstones,
  type AstDbKeyValue,
} from "./ivrMenuCodes";
import { buildImportPlan, normalizeOptionDigit, type PbxTenantFlowMap } from "./ivrMigration";

// ── deterministic PRNG (mulberry32) ─────────────────────────────────────────
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];

// ── 1. hostile code strings ─────────────────────────────────────────────────

test("stress: isIvrMenuCode refuses every hostile shape", () => {
  const hostile = [
    "٠٤٧٨",            // Arabic-Indic digits — JS \d is ASCII-only and must stay so
    "０４７８",          // fullwidth digits
    "0478\n", "\n0478", "04\n78", " 0478", "0478 ", "04 78",
    "0478" + String.fromCharCode(0), String.fromCharCode(0), "047\t8",
    "1e78", "0x78", "-478", "+478", "4.78",
    "123456789", "99999999999999999999", "12", "1",
    "star", "hash", "*67", "#12", "0478*", "912#",
    "'; DROP TABLE--", "${EXTEN}", "code_0478", "../0478",
  ];
  for (const s of hostile) assert.equal(isIvrMenuCode(s), false, JSON.stringify(s));
  // And the boundary is exact: 3 and 8 in, 2 and 9 out.
  assert.equal(isIvrMenuCode("100"), true);
  assert.equal(isIvrMenuCode("10"), false);
  assert.equal(isIvrMenuCode("12345678"), true);
  assert.equal(isIvrMenuCode("123456789"), false);
});

// ── 2. randomized slates ────────────────────────────────────────────────────

interface Row { optionDigit: string; enabled: boolean; destinationType: string; destinationRef: string }
const KEY_SHAPE = /^(has_codes|code_\d{3,8}\/(dest|type))$/;

function randomRows(r: () => number): Row[] {
  const n = Math.floor(r() * 12);
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const digit = pick(r, [
      "1", "9", "0", "star", "hash",
      "303", "0478", "1818", "13132", "55648752", "00000000",
      "garbage", "0478 ", "٠٤٧٨", "123456789",
    ]);
    rows.push({
      optionDigit: digit,
      enabled: r() < 0.7,
      destinationType: pick(r, ["voicemail", "custom", "extension", "queue"]),
      destinationRef: pick(r, ["sub-extensions-vm,VM-101,1", "T9_app-disa,DISA-1,1", "T9_cos-all,101,1"]),
    });
  }
  return rows;
}

test("stress: 500 randomized slates — the code slate is always coherent", () => {
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed);
    const rows = randomRows(r);
    const keys = buildMenuCodeKeys("fam/menu/x", rows, (o) => o.destinationRef);
    const msg = `seed=${seed} rows=${JSON.stringify(rows)}`;

    // Shape: every key is has_codes or a code slot; families all correct.
    for (const k of keys) {
      assert.equal(k.family, "fam/menu/x", msg);
      assert.match(k.key, KEY_SHAPE, `${msg} key=${k.key}`);
    }
    // has_codes is present exactly once and is the truth about enabled codes.
    const hc = keys.filter((k) => k.key === "has_codes");
    assert.equal(hc.length, 1, msg);
    // The oracle must look at the DEDUPED view (last row per code wins) —
    // exactly what a caller typing the code would experience.
    const lastByCode = new Map<string, Row>();
    for (const o of rows) if (isIvrMenuCode(o.optionDigit)) lastByCode.set(o.optionDigit, o);
    const anyEnabled = [...lastByCode.values()].some((o) => o.enabled);
    assert.equal(hc[0].value, anyEnabled ? "1" : "0", msg);
    // No duplicate keys ever — a contradictory slate is order-dependent.
    assert.equal(new Set(keys.map((k) => k.key)).size, keys.length, msg);
    // Every distinct code-shaped digit has exactly its dest+type pair; the
    // LAST row for a duplicated code wins (the digit slate's Map rule).
    const codes = Array.from(new Set(rows.filter((o) => isIvrMenuCode(o.optionDigit)).map((o) => o.optionDigit)));
    assert.equal(keys.length, 1 + codes.length * 2, msg);
    for (const c of codes) {
      const last = [...rows].reverse().find((o) => o.optionDigit === c)!;
      const dest = keys.find((k) => k.key === `${ivrMenuCodeKey(c)}/dest`)!;
      const type = keys.find((k) => k.key === `${ivrMenuCodeKey(c)}/type`)!;
      assert.equal(dest.value, last.enabled ? last.destinationRef : "", msg);
      assert.equal(type.value, last.enabled ? last.destinationType : "", msg);
    }
    // Deterministic.
    assert.deepEqual(keys, buildMenuCodeKeys("fam/menu/x", rows, (o) => o.destinationRef), msg);
  }
});

// ── 3. whole publish lifetimes against a modelled AstDB ─────────────────────
//
// The real pipeline: buildMenuCodeKeys → tombstones diffed against the last
// SUCCESSFUL IvrPublishRecord → every key DBPut in order. A failed publish can
// write any prefix of its keys and never becomes the diff baseline — modelled
// here exactly, because that is the path where a stale code could survive.

test("stress: 300 seeded lifetimes — a code answers iff a live enabled row says so", () => {
  const FAM = "connect/t_x/menu/m1";
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const astdb = new Map<string, string>();
    const live = new Map<string, { enabled: boolean; ref: string }>();
    // Records are stored the way production stores them: created (with the
    // FULL intended key list) BEFORE the AstDB write, whatever happens next.
    // The baseline for tombstones is every record since the last success —
    // exactly what collectStaleIvrCodeTombstones fetches.
    const records: Array<{ keys: AstDbKeyValue[]; success: boolean }> = [];
    const codePool = ["303", "0478", "1818", "7879", "13132", "746292", "5564875", "55648752"];

    const publish = (fail: boolean) => {
      const rows: Row[] = Array.from(live.entries()).map(([code, s]) => ({
        optionDigit: code, enabled: s.enabled, destinationType: "custom", destinationRef: s.ref,
      }));
      const keys = buildMenuCodeKeys(FAM, rows, (o) => o.destinationRef);
      const lastSuccessIdx = records.map((x) => x.success).lastIndexOf(true);
      const baseline = records
        .slice(lastSuccessIdx >= 0 ? lastSuccessIdx : 0)
        .flatMap((x) => x.keys);
      const tombs = diffStaleIvrCodeTombstones(baseline, keys);
      const all = [...keys, ...tombs];
      records.push({ keys: all, success: !fail });
      // A failed publish dies after writing any prefix — including zero keys.
      const upTo = fail ? Math.floor(r() * (all.length + 1)) : all.length;
      for (let i = 0; i < upTo; i++) astdb.set(`${all[i].family}|${all[i].key}`, all[i].value);
      return tombs;
    };

    let steps = 0;
    for (let step = 0; step < 25; step++) {
      const op = pick(r, ["add", "delete", "disable", "enable", "publish", "publish", "failedPublish"]);
      if (op === "add") live.set(pick(r, codePool), { enabled: true, ref: `T9_app-disa,DISA-${Math.floor(r() * 9)},1` });
      else if (op === "delete") { const ks = [...live.keys()]; if (ks.length) live.delete(pick(r, ks)); }
      else if (op === "disable" || op === "enable") {
        const ks = [...live.keys()];
        if (ks.length) live.get(pick(r, ks))!.enabled = op === "enable";
      } else {
        publish(op === "failedPublish");
        if (op === "publish") {
          steps++;
          const msg = `seed=${seed} step=${step}`;
          // THE invariant: after any successful publish, a code routes calls
          // iff a live enabled row says it should — whatever failures came
          // before.
          for (const [code, s] of live) {
            const dest = astdb.get(`${FAM}|${ivrMenuCodeKey(code)}/dest`) ?? "";
            if (s.enabled) assert.equal(dest, s.ref, `${msg} live code ${code} must answer`);
            else assert.equal(dest, "", `${msg} disabled code ${code} must be dead`);
          }
          for (const k of astdb.keys()) {
            const m = k.match(/\|code_(\d+)\/dest$/);
            if (!m) continue;
            const s = live.get(m[1]);
            if (!s || !s.enabled) assert.equal(astdb.get(k), "", `${msg} deleted code ${m[1]} must be dead`);
          }
          const hc = astdb.get(`${FAM}|has_codes`);
          const anyEnabled = [...live.values()].some((s) => s.enabled);
          assert.equal(hc, anyEnabled ? "1" : "0", msg);
        }
      }
    }
    // Convergence: with nothing changing, the very next publish emits ZERO
    // tombstones — a tombstone that re-propagates forever would bloat every
    // publish record for the tenant's lifetime.
    publish(false);
    const again = publish(false);
    assert.equal(again.length, 0, `seed=${seed} tombstones must not re-propagate`);
    assert.ok(steps >= 0);
  }
});

test("stress: hostile publish history can never blank a real key or throw", () => {
  const current = [{ family: "f", key: "has_codes", value: "0" }];
  const hostile: unknown = [
    null, 42, "code_0478/dest", [], {},
    { family: "f" }, { key: "code_0478/dest" },
    { family: "f", key: "opt_1/dest", value: "T9_cos-all,101,1" },        // NOT a code key
    { family: "f", key: "dest_business", value: "x" },
    { family: "f", key: "code_0478/dest", value: "" },                     // old tombstone
    { family: "f", key: "code_0478/dest", value: "   " },                  // whitespace value
    { family: "f", key: "code_0478/announce", value: "x" },                // not a code SLOT
    { family: "f", key: "code_abc/dest", value: "x" },                     // non-digit code
    { family: "f", key: "code_0478/dest/extra", value: "x" },              // over-deep
    { family: 7, key: "code_0478/dest", value: "x" },                      // wrong types
    { family: "f", key: "code_1818/dest", value: { toString: "x" } },      // non-string value
    { family: "f", key: "code_9999/dest", value: "T9_app-disa,DISA-1,1" }, // the ONE real stale
    { family: "f", key: "code_9999/dest", value: "T9_app-disa,DISA-1,1" }, // duplicated row
  ];
  const out = diffStaleIvrCodeTombstones(hostile, current);
  // Exactly the one genuinely-stale code key, once, as a "" tombstone —
  // nothing else survives the gauntlet.
  assert.deepEqual(out, [{ family: "f", key: "code_9999/dest", value: "" }]);
  // And non-array garbage is a no-op, never a throw.
  for (const junk of [null, undefined, "x", 42, {}, { length: 1e9 }]) {
    assert.deepEqual(diffStaleIvrCodeTombstones(junk, current), []);
  }
});

// ── 4. planner fuzz — every enabled option is accounted for, exactly once ───

const DIR = {
  extensions: [
    { id: 1, number: "103", name: "A" },
    { id: 3, number: "108", name: "B" },
  ],
  queues: [{ id: 40, number: "900", name: "Q" }],
  ringGroups: [{ id: 5, number: "601", name: "G" }],
  customApplications: [{ id: 9, number: "7000", name: "C" }],
};

function fuzzMap(r: () => number): PbxTenantFlowMap {
  const digits = new Set<string>();
  const options: PbxTenantFlowMap["ivrs"][0]["options"] = [];
  const digitPool = [
    "1", "2", "9", "0", "*", "#",
    "103", "108", "110", "0478", "1818", "55648752", "13132",
    "999999999", "12", "٠٤٧٨", "04 78", "0478\n", "x1y2",
  ];
  const targetPool = [
    { destinationId: 61, type: "disa", targetId: "2", label: "Staff" },
    { destinationId: 62, type: "vm_direct", targetId: "1", label: "VM" },
    { destinationId: 63, type: "extension", targetId: "3", label: "108" },
    { destinationId: 64, type: "extension", targetId: "555", label: "gone" },
    { destinationId: 65, type: "queue", targetId: "40", label: "Q" },
    { destinationId: 66, type: "weird_module", targetId: "9", label: "?" },
    null,
  ];
  const n = 1 + Math.floor(r() * 10);
  for (let i = 0; i < n; i++) {
    const digit = pick(r, digitPool);
    if (digits.has(digit)) continue; // unique per menu, like the DB constraint
    digits.add(digit);
    options.push({ entryId: 100 + i, digit, enabled: r() < 0.8, sort: i, target: pick(r, targetPool) });
  }
  return {
    tenantId: 2, tenantSlug: "fuzz", tenantName: "Fuzz", enabled: true,
    directory: DIR, recordings: [],
    ivrs: [{
      id: 1, description: "Fuzz Main", directDialEnabled: r() < 0.5,
      welcome: null, instructions: null,
      timeoutSec: 10, timeoutTries: 3, timeoutPrompt: null, timeoutRetryPrompt: null, timeoutTarget: null,
      invalidTries: 3, invalidPrompt: null, invalidRetryPrompt: null, invalidTarget: null,
      options,
    }],
    timeGroups: [], timeConditions: [], routes: [],
  };
}

test("stress: 400 fuzzed flow maps — no throw, and every enabled option lands in exactly one bucket", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const map = fuzzMap(r);
    const plan = buildImportPlan(map, 1);
    const msg = `seed=${seed} options=${JSON.stringify(map.ivrs[0].options.map((o) => [o.digit, o.enabled, o.target?.type]))}`;
    const profile = plan.profiles[0];
    const enabled = map.ivrs[0].options.filter((o) => o.enabled);

    // Partition: options written + shortcuts kept + shortcuts restorable +
    // per-option problems == the enabled options, with nothing dropped
    // silently and nothing double-counted.
    const optionProblems = plan.problems.filter((p) => /· (key|code)/.test(p.where));
    const accounted = profile.options.length + plan.keptByDirectDial.length
      + profile.directDialWouldRestore.length + optionProblems.length;
    assert.equal(accounted, enabled.length, msg);

    // Whatever went in, what comes out is publishable: every option digit is a
    // keypad key or a valid code, never raw garbage.
    for (const o of profile.options) {
      // optionDigit comes out ALREADY normalized ("*" → "star"), so accept the
      // stored forms directly, plus valid codes — never raw garbage.
      const isKeypad = /^\d$/.test(o.optionDigit) || o.optionDigit === "star" || o.optionDigit === "hash";
      assert.ok(isKeypad || isIvrMenuCode(o.optionDigit), `${msg} digit=${JSON.stringify(o.optionDigit)}`);
      assert.ok(o.destinationRef.length > 0, msg);
    }
    // carriedCodes mirrors the options exactly — the screen and the copy can
    // never disagree.
    const codesInOptions = profile.options.filter((o) => isIvrMenuCode(o.optionDigit)).map((o) => o.optionDigit).sort();
    const codesInRollup = (plan.carriedCodes[0]?.codes ?? []).map((c) => c.code).sort();
    assert.deepEqual(codesInRollup, codesInOptions, msg);
    // A hostile digit ("٠٤٧٨", "0478\n", "04 78", 9+ digits…) must be a
    // problem, never silently vanish or sneak into the slate.
    for (const o of enabled) {
      const isHostile = normalizeOptionDigit(o.digit) === null && !isIvrMenuCode(String(o.digit).trim());
      if (isHostile && !DIR.extensions.some((e) => e.number === String(o.digit).trim())) {
        assert.ok(
          plan.problems.some((p) => p.where.includes(`code "${String(o.digit).trim()}"`)) ||
          profile.options.every((x) => x.optionDigit !== o.digit),
          msg,
        );
      }
    }
  }
});
