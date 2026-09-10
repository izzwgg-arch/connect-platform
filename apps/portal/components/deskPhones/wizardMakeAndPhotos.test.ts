/**
 * The make dropdown, and a picture that tells the truth about what the thing IS.
 *
 * ⛔⛔ WHY THE PHOTO HALF EXISTS. 94 of the PBX's 427 models ship no product image, and
 * they are not a random 94: EVERY Grandstream HT and EVERY Dinstar DAG is missing — the
 * entire ATA family — plus all 39 newer Polycom and 33 Flying Voice models. Measured on
 * the live PBX 2026-09-10. Five of the seven Grandstream devices provisioned on this
 * platform today are HTs, so for Grandstream the missing photo is the COMMON case. The
 * old fallback drew one telephone glyph for all of them, which points a customer at a
 * phone that is not on their shelf.
 *
 * ⛔⛔ WHY THE MAKE HALF EXISTS. Izzy, 2026-09-10: "there should be a dropdown first with
 * all manufacturers from our database." The dangerous way to honour that is to filter the
 * found list by it — see `makeHint.ts`.
 *
 * Two kinds of test here, deliberately. The ordering is DRIVEN, because "the list never
 * gets shorter" is a promise that deserves exercising. The rest reads SOURCE, because the
 * defects are in JSX — a component that renders the wrong glyph, or a list typed by hand
 * instead of read from the catalogue — and nothing that calls a function can see those.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { VENDOR_SLUGS, VENDOR_CATALOG } from "@connect/shared";
import { MAKE_UNSURE, makeLabel, orderPhonesByMake, toldUsPhrase } from "./makeHint";

function readSource(relative: string): string {
  // PORTAL_GUARD_ROOT replays the guards against an export of HEAD, so they are PROVEN
  // to fail on the pre-change code rather than assumed to.
  const root = process.env.PORTAL_GUARD_ROOT || join(__dirname);
  return readFileSync(join(root, relative), "utf8").replace(/\r\n/g, "\n");
}

/** Comment-stripped: this file's own prose quotes the shapes it forbids. */
function executable(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

// ── the make NEVER hides a phone ───────────────────────────────────────────────

const FOUND = [
  { id: "a", vendor: "yealink" },
  { id: "b", vendor: "grandstream" },
  { id: "c", vendor: null },
  { id: "d", vendor: "yealink" },
];

test("choosing a make brings it to the top and keeps EVERY phone", () => {
  const out = orderPhonesByMake(FOUND, "grandstream");
  assert.equal(out.length, FOUND.length, "no phone may be dropped");
  assert.equal(out[0].id, "b", "the chosen make leads");
  assert.deepEqual(new Set(out.map((p) => p.id)), new Set(["a", "b", "c", "d"]));
});

test("⛔ the mistake that matters: a make that matches NOTHING still shows everything", () => {
  // Somebody reads "Grandstream" off the wrong label and their phones are all Yealink.
  // Filtering would hand them an empty screen while the scan had found all four.
  const out = orderPhonesByMake(FOUND, "polycom");
  assert.equal(out.length, 4, "an empty found screen is the bug this test exists for");
  assert.deepEqual(out.map((p) => p.id), ["a", "b", "c", "d"], "and the order is untouched");
});

test("the order within a group is stable, so the list does not reshuffle", () => {
  const out = orderPhonesByMake(FOUND, "yealink");
  assert.deepEqual(out.map((p) => p.id), ["a", "d", "b", "c"]);
});

test("no make, or 'not sure', leaves the list exactly as discovery found it", () => {
  for (const brand of ["", null, undefined, MAKE_UNSURE]) {
    assert.deepEqual(orderPhonesByMake(FOUND, brand).map((p) => p.id), ["a", "b", "c", "d"]);
  }
});

test("a phone with no make of its own is never lost", () => {
  const out = orderPhonesByMake([{ id: "c", vendor: null }], "yealink");
  assert.equal(out.length, 1);
});

test("ordering does not mutate what it was given", () => {
  const input = [...FOUND];
  orderPhonesByMake(input, "grandstream");
  assert.deepEqual(input.map((p) => p.id), ["a", "b", "c", "d"]);
});

// ── what we echo back is what a person would recognise ─────────────────────────

test("the make is echoed as the brand NAME, never the slug we store", () => {
  assert.equal(makeLabel("flyingvoice"), "Flying Voice");
  assert.equal(toldUsPhrase("yealink", " T54W "), "Yealink T54W");
});

test("saying nothing, or 'not sure', echoes nothing", () => {
  assert.equal(toldUsPhrase("", ""), "");
  assert.equal(toldUsPhrase(MAKE_UNSURE, ""), "");
  assert.equal(makeLabel(MAKE_UNSURE), "");
});

test("a make with no model still reads as a sentence", () => {
  assert.equal(toldUsPhrase("grandstream", ""), "Grandstream");
});

test("a slug that is not a real brand is dropped, never shown raw", () => {
  assert.equal(makeLabel("not-a-brand"), "");
});

// ── the dropdown is the catalogue, not a list somebody typed ───────────────────

test("the makes come from the PBX catalogue, so a new brand appears by itself", () => {
  const src = executable(readSource("DeskPhoneWizard.tsx"));
  assert.match(src, /VENDOR_SLUGS[\s\S]{0,200}VENDOR_CATALOG\[slug\]\.displayName/,
    "the option list must be built from the catalogue");
  // A hand-typed list is the failure: it goes stale and can offer a make we cannot set up.
  assert.doesNotMatch(src, /label:\s*"Yealink"/, "no brand name may be typed into this file");
});

test("every brand the PBX can provision is offered", () => {
  // 20 today. The assertion is the RELATIONSHIP, not the number, so the catalogue moving
  // does not make this test lie.
  assert.ok(VENDOR_SLUGS.length >= 20);
  for (const slug of VENDOR_SLUGS) {
    assert.ok(VENDOR_CATALOG[slug].displayName.trim().length > 0, `${slug} needs a name to show`);
  }
});

test("it is a ConnectSelect, never a native dropdown", () => {
  const src = executable(readSource("DeskPhoneWizard.tsx"));
  assert.match(src, /<ConnectSelect[\s\S]{0,400}options=\{BRAND_OPTIONS\}/);
  assert.doesNotMatch(src, /<select[\s>]/, "the portal has one dropdown and this is not it");
});

test("someone who cannot find their make still has a way forward", () => {
  const src = executable(readSource("DeskPhoneWizard.tsx"));
  assert.match(src, /MAKE_UNSURE, label:/, "the 'not sure' option must always be offered");
});

// ── the picture agrees with the words ──────────────────────────────────────────

test("a model with no photo falls back to its KIND, not to a telephone", () => {
  const src = executable(readSource("DeskPhoneWizard.tsx"));
  assert.match(src, /if \(!src \|\| failed\) return <KindGlyph kind=\{deviceKindFor\(model\)\} \/>;/,
    "an HT812 must not be drawn as a desk phone");
});

test("every kind of thing the wizard can find has its own drawing", () => {
  const src = executable(readSource("DeskPhoneWizard.tsx"));
  const glyph = src.slice(src.indexOf("function KindGlyph"));
  for (const kind of ["desk_phone", "ata", "cordless_base", "pager", "doorbell"]) {
    assert.match(glyph, new RegExp(`kind === "${kind}"`), `${kind} needs its own drawing`);
  }
});

test("something we could not identify is drawn as a plain box, not as a claim", () => {
  const src = executable(readSource("DeskPhoneWizard.tsx"));
  const at = src.indexOf("function KindGlyph");
  // ⛔ Assert the function EXISTS before slicing on it. Without this the slice is "" on a
  // tree that has no KindGlyph, every doesNotMatch trivially passes, and the guard is
  // decoration — which is exactly what the HEAD replay caught it being.
  assert.ok(at > 0, "KindGlyph must exist for this guard to mean anything");
  const glyph = src.slice(at);
  // The unknown branch is the fall-through: it must NOT hand back the phone drawing.
  const tail = glyph.slice(glyph.lastIndexOf('kind === "doorbell"'));
  assert.ok(tail.length > 0, "the doorbell branch must exist above the fall-through");
  assert.doesNotMatch(tail, /return <PhoneGlyph \/>/, "we do not know what it is, so we do not draw a phone");
});
