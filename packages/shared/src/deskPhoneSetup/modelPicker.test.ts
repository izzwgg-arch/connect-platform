/**
 * The two dropdowns, driven against the whole catalogue rather than a fixture.
 *
 * ⛔ The sweep in "every model the pickers offer can actually be identified" is the one
 * that matters: a dropdown that offers something the record writer then refuses is worse
 * than no dropdown, because the person has done the one thing we asked of them and is
 * told no anyway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PICKER_UNSURE,
  makeOptions,
  modelOptionsFor,
  normaliseMake,
  identifyPhone,
  needsIdentifying,
} from "./modelPicker";
import {
  VENDOR_CATALOG,
  VENDOR_SLUGS,
  VENDOR_CATALOG_MODEL_COUNT,
  VENDOR_CATALOG_TEMPLATED_MODEL_COUNT,
} from "./vendorCatalog.generated";

/* ── the makes ───────────────────────────────────────────────────────────── */

test("every make the phone system can provision is offered, and nothing else", () => {
  const opts = makeOptions();
  assert.equal(opts.length, VENDOR_SLUGS.length);
  assert.deepEqual(
    [...opts.map((o) => o.value)].sort(),
    [...VENDOR_SLUGS].sort(),
    "the list is the catalogue's own, so a brand the PBX gains later appears by itself",
  );
  // ⛔ The label is the phone system's own spelling — a person reading "Alcatel-Lucent"
  // off a sticker must find that, not the slug `alcatel` they never typed.
  assert.ok(opts.some((o) => o.label === "Alcatel-Lucent"));
  assert.ok(opts.some((o) => o.label === "Yealink"));
});

test("the makes are in alphabetical order, because a person scans a list", () => {
  const labels = makeOptions().map((o) => o.label);
  assert.deepEqual(labels, [...labels].sort((a, b) => a.localeCompare(b, "en")));
});

/* ── the models ──────────────────────────────────────────────────────────── */

test("choosing a make narrows the models to that make", () => {
  const opts = modelOptionsFor("yealink");
  assert.equal(opts.length, VENDOR_CATALOG.yealink.models.length);
  assert.ok(opts.every((o) => o.make === "yealink"));
  // ⛔ No brand in the label: the person has already said Yealink, and repeating it on
  // 82 rows is noise that makes the model itself harder to find.
  assert.ok(opts.every((o) => !o.label.startsWith("Yealink ")));
});

test("not knowing the make offers EVERY model, each carrying its brand", () => {
  for (const unsure of [null, undefined, "", PICKER_UNSURE, "  "]) {
    const opts = modelOptionsFor(unsure);
    assert.equal(
      opts.length,
      VENDOR_CATALOG_MODEL_COUNT,
      "a person who can read the label but not the brand must still find their phone",
    );
    const t54 = opts.find((o) => o.value === "SIP-T54W" || o.value === "T54W");
    if (t54) assert.match(t54.label, /^Yealink /);
  }
});

test("numbered families sort the way a person expects", () => {
  const labels = modelOptionsFor("yealink").map((o) => o.label);
  const i = (s: string) => labels.findIndex((l) => l === s);
  // Only assert on pairs this catalogue actually holds.
  const pairs: Array<[string, string]> = [];
  for (const a of labels) {
    const m = /^(.*?)(\d+)(\D*)$/.exec(a);
    if (!m) continue;
    const two = `${m[1]}${Number(m[2]) * 10}${m[3]}`;
    if (labels.includes(two)) pairs.push([a, two]);
  }
  for (const [small, big] of pairs) {
    assert.ok(i(small) < i(big), `${small} should come before ${big}`);
  }
});

/* ── the sweep that matters ──────────────────────────────────────────────── */

test("every model the pickers offer can actually be identified", () => {
  const all = modelOptionsFor(null);
  for (const opt of all) {
    const got = identifyPhone({ make: opt.make, model: opt.value });
    assert.ok(got.ok, `${opt.label} is offered and cannot be identified`);
    assert.equal(got.vendor, opt.make);
    assert.equal(got.model, opt.value);
    assert.ok(got.pbxModelId > 0, `${opt.label} has no phone-system model id`);
  }
  assert.equal(all.length, VENDOR_CATALOG_MODEL_COUNT);
});

test("the one model with no settings file on disk is offered and marked", () => {
  const all = modelOptionsFor(null);
  const unsupported = all.filter((o) => !o.setupSupported);
  assert.equal(
    all.length - unsupported.length,
    VENDOR_CATALOG_TEMPLATED_MODEL_COUNT,
    "the marked ones are exactly the catalogue's own untemplated count",
  );
  // ⛔ Offered, not hidden. Somebody holding one has to be able to find it and be told
  // the truth, rather than search a list that silently does not contain their phone.
  for (const o of unsupported) assert.ok(all.some((x) => x.value === o.value));
});

test("the brands nothing on the office network can drive are marked, not hidden", () => {
  const undrivable = modelOptionsFor(null).filter((o) => !o.drivableLocally);
  const brands = new Set(undrivable.map((o) => o.make));
  assert.deepEqual(
    [...brands].sort(),
    ["alcatel", "dinstar", "hanyang", "nurivoice"],
    "the four brands with no locally drivable mechanism",
  );
  // ⛔ Still offered: the record is worth writing for these — it is what makes the phone
  // system serve them a config at all. What changes is that nobody may be shown a
  // progress bar for one.
  assert.ok(undrivable.length > 0);
});

/* ── turning a pick into something the record writer can use ─────────────── */

test("the answer is stored as the catalogue spells it, never as it arrived", () => {
  const canonical = identifyPhone({ make: "yealink", model: VENDOR_CATALOG.yealink.models[0].model });
  assert.ok(canonical.ok);
  const want = canonical.model;
  for (const spelling of [want.toLowerCase(), want.toUpperCase(), want.replace(/-/g, " "), ` ${want} `]) {
    const got = identifyPhone({ make: "yealink", model: spelling });
    assert.ok(got.ok, `${spelling} should resolve`);
    assert.equal(got.model, want, "two phones of one kind must never be recorded as two things");
  }
});

test("the model decides the make, so getting the brand wrong is not fatal", () => {
  const m = VENDOR_CATALOG.grandstream.models[0].model;
  const got = identifyPhone({ model: m });
  assert.ok(got.ok);
  assert.equal(got.vendor, "grandstream");
});

test("a make that disagrees with the model is REFUSED, never silently corrected", () => {
  const yealink = VENDOR_CATALOG.yealink.models[0].model;
  const got = identifyPhone({ make: "grandstream", model: yealink });
  assert.equal(got.ok, false);
  if (got.ok) return;
  assert.equal(got.reason, "make_disagrees");
  // The message names both brands, so a person can see what went wrong.
  assert.match(got.message, /Yealink/);
  assert.match(got.message, /Grandstream/);
});

test("a model nobody makes is refused in plain English", () => {
  for (const junk of ["not a phone", "T99999X", "<script>", "  "]) {
    const got = identifyPhone({ make: "yealink", model: junk });
    assert.equal(got.ok, false, `${junk} must not resolve`);
    if (got.ok) continue;
    assert.ok(got.message.length > 10);
    assert.ok(!/catalogue row|pbxModelId|slug/i.test(got.message), "no jargon reaches a customer");
  }
});

test("nothing picked is its own refusal, and it asks rather than blames", () => {
  for (const nothing of [null, undefined, "", PICKER_UNSURE]) {
    const got = identifyPhone({ make: "yealink", model: nothing });
    assert.equal(got.ok, false);
    if (got.ok) continue;
    assert.equal(got.reason, "model_missing");
  }
});

/* ── the label on the back reads "SIP-T54W" ──────────────────────────────── */

test("a model written the way it is PRINTED ON THE PHONE resolves", () => {
  // ⛔ This is the spelling on a Yealink's own label and in its own web banner, and until
  // 2026-09-11 it matched NOTHING — "SIP-T46G" normalises to SIPT46G and the catalogue
  // holds T46G — so every one of the PBX's Yealink models was unfindable by the string a
  // person actually reads off the handset.
  const t54 = identifyPhone({ model: "SIP-T54W" });
  assert.ok(t54.ok, "the label spelling must resolve");
  assert.equal(t54.vendor, "yealink");
  assert.equal(t54.model, "T54W", "and it is stored as the catalogue spells it");

  for (const spelling of ["Yealink SIP-T53W", "sip-t53w", "SIP T53W", "YEALINK T53W"]) {
    const got = identifyPhone({ model: spelling });
    assert.ok(got.ok, `${spelling} must resolve`);
    assert.equal(got.model, "T53W", `${spelling} is Izzy's own handset`);
    assert.equal(got.pbxModelId, 154);
  }
});

test("stripping a leading maker word can never change WHICH phone a string means", () => {
  // The sweep, across the whole catalogue rather than a handful of examples.
  const wrong: string[] = [];
  for (const slug of VENDOR_SLUGS) {
    const brand = VENDOR_CATALOG[slug].displayName;
    for (const m of VENDOR_CATALOG[slug].models) {
      for (const spelling of [m.model, `${brand} ${m.model}`, `SIP-${m.model}`, `${brand} SIP-${m.model}`]) {
        const got = identifyPhone({ model: spelling });
        if (!got.ok || got.pbxModelId !== m.pbxModelId) {
          wrong.push(`${brand} ${m.model} as "${spelling}" -> ${got.ok ? got.model : got.reason}`);
        }
      }
    }
  }
  assert.deepEqual(wrong, [], "model strings that resolved to the wrong phone or to nothing");
});

test("the catalogue still satisfies what the strip depends on", () => {
  // ⛔ Both of these were MEASURED before the strip was written, and both must stay true
  // when the catalogue is regenerated — a model named after its own maker, or one key
  // shared by two brands, would make a stripped string ambiguous.
  const noise = new Set<string>(["SIP"]);
  for (const s of VENDOR_SLUGS) {
    noise.add(s.toUpperCase());
    noise.add(VENDOR_CATALOG[s].displayName.replace(/[^a-zA-Z0-9]/g, "").toUpperCase());
  }
  const seen = new Map<string, string>();
  const startsWithNoise: string[] = [];
  const collisions: string[] = [];
  for (const s of VENDOR_SLUGS) {
    for (const m of VENDOR_CATALOG[s].models) {
      for (const n of noise) {
        if (m.key.startsWith(n) && m.key.length > n.length) startsWithNoise.push(`${s}/${m.model} opens with ${n}`);
      }
      const prior = seen.get(m.key);
      if (prior) collisions.push(`${m.key}: ${prior} and ${s}/${m.model}`);
      else seen.set(m.key, `${s}/${m.model}`);
    }
  }
  assert.deepEqual(startsWithNoise, []);
  assert.deepEqual(collisions, []);
});

/* ── whether to ask at all ───────────────────────────────────────────────── */

test("a phone that already told us what it is is never asked", () => {
  // Izzy's own handset, as its banner reports it.
  assert.equal(needsIdentifying({ model: "T53W" }), false);
  assert.equal(needsIdentifying({ model: "SIP-T54W" }), false);
  assert.equal(needsIdentifying({ model: VENDOR_CATALOG.grandstream.models[0].model }), false);
});

test("a phone we cannot name IS asked — that is the whole point", () => {
  assert.equal(needsIdentifying({ model: null }), true);
  assert.equal(needsIdentifying({ model: "" }), true);
  assert.equal(needsIdentifying({}), true);
  // A banner we could read but cannot match is still unnamed as far as the phone
  // system is concerned, so it still needs a person.
  assert.equal(needsIdentifying({ model: "VOIP PHONE" }), true);
});

/* ── the make sentinel ───────────────────────────────────────────────────── */

test("'I am not sure' is not a brand and never resolves to one", () => {
  assert.equal(normaliseMake(PICKER_UNSURE), null);
  assert.equal(normaliseMake(""), null);
  assert.equal(normaliseMake(null), null);
  assert.equal(normaliseMake("Yealink"), "yealink");
  assert.equal(normaliseMake("yealink"), "yealink");
  // A banner-shaped make still resolves — the same rule the fingerprint path uses.
  assert.equal(normaliseMake("Grandstream Networks"), "grandstream");
  assert.equal(normaliseMake("Poly"), "polycom");
});
