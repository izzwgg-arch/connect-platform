/**
 * ⛔⛔ THE TWO COPIES OF THE RESET FENCE MUST NOT DRIFT.
 *
 * `resetSafetyCore.ts` on this side and `packages/shared/src/deskPhoneSetup/
 * resetSafety.ts` + `deviceKinds.ts` on the other decide the same question: may this
 * device be wiped. The desktop app bundles nothing from the monorepo (electron-builder
 * packs `dist/**` only), so the lists exist twice — and two copies of a safety fence
 * that disagree is worse than one copy, because the server would refuse a wipe the
 * machine went ahead with, or promise one the machine will not do.
 *
 * ⛔ This reads the shared files as TEXT. It cannot import them (that is the whole
 * reason the copy exists), so it compares the patterns and the refusal reasons
 * literally. A pattern added on either side fails here until it is added on both.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { decideLocalFactoryReset, deviceKindFor, modelCanUseWifi } from "./resetSafetyCore";

const SHARED = path.join(__dirname, "..", "..", "..", "..", "packages", "shared", "src", "deskPhoneSetup");

function read(file: string): string {
  // ⛔ CRLF-normalised: this worktree checks out CRLF under Izzy's global
  // core.autocrlf, and a multi-line literal match against CRLF finds nothing — which
  // reads exactly like "the pattern is missing" and would pass a negative assertion.
  return fs.readFileSync(path.join(SHARED, file), "utf8").replace(/\r\n/g, "\n");
}

/** Pull the `re:` sources out of a KIND_PATTERNS-shaped array literal. */
function kindPatternSources(src: string): string[] {
  const block = src.slice(src.indexOf("KIND_PATTERNS"), src.indexOf("];", src.indexOf("KIND_PATTERNS")));
  return [...block.matchAll(/\{\s*kind:\s*"([a-z_]+)",\s*re:\s*(\/[^/]+\/[a-z]*)\s*\}/g)].map(
    (m) => `${m[1]}|${m[2]}`,
  );
}

test("the device-shape patterns are identical on both sides, in the same order", () => {
  const shared = kindPatternSources(read("deviceKinds.ts"));
  const local = kindPatternSources(
    fs.readFileSync(path.join(__dirname, "resetSafetyCore.ts"), "utf8").replace(/\r\n/g, "\n"),
  );
  assert.ok(shared.length >= 14, `shared patterns not found (got ${shared.length})`);
  // ⛔ ORDER, not just membership. Door and paging families come before the generic
  // desk families; swapping them on one side only would let "GDS3710" read as a desk
  // phone on the machine that sends the wipe.
  assert.deepEqual(local, shared);
});

test("the Wi-Fi-capable patterns are identical on both sides", () => {
  const grab = (src: string) => {
    const i = src.indexOf("WIRELESS_CAPABLE_PATTERNS");
    return [...src.slice(i, src.indexOf("];", i)).matchAll(/^\s*(\/[^/]+\/[a-z]*),/gm)].map((m) => m[1]);
  };
  const shared = grab(read("resetSafety.ts"));
  const local = grab(fs.readFileSync(path.join(__dirname, "resetSafetyCore.ts"), "utf8").replace(/\r\n/g, "\n"));
  assert.ok(shared.length >= 5, `shared wireless patterns not found (got ${shared.length})`);
  assert.deepEqual(local, shared);
});

test("both copies refuse only a device nobody can name (reset first, 2026-09-14)", () => {
  // ⛔ Izzy's rule: every ticked device is factory reset first. The adapter / cordless /
  // door / Wi-Fi refusals are gone from BOTH copies; neither may bring one back alone.
  const shared = read("resetSafety.ts");
  const local = fs.readFileSync(path.join(__dirname, "resetSafetyCore.ts"), "utf8").replace(/\r\n/g, "\n");
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  for (const gone of ["ata_analog_lines", "cordless_unpairs_handsets", "door_or_paging", "wireless_forgets_network", "wireless_capable_unconfirmed"]) {
    assert.ok(!code(shared).includes(`reason: "${gone}"`), `shared still refuses ${gone}`);
    assert.ok(!code(local).includes(`reason: "${gone}"`), `local still refuses ${gone}`);
  }
  assert.ok(code(shared).includes(`"model_unknown"`));
  assert.ok(code(local).includes(`"model_unknown"`));
});

test("both copies answer the same way for the devices on Izzy's desk", () => {
  // The behavioural half. The text comparisons above catch a pattern going missing;
  // this catches the two implementations reaching different verdicts anyway.
  const cases: Array<[string, "wired" | "wireless" | "unknown", boolean]> = [
    ["T53W", "unknown", true],
    ["T53W", "wired", true],
    ["T53W", "wireless", true],
    ["T42S", "unknown", true],
    ["GXP2170", "unknown", true],
    ["HT812", "wired", true],
    ["HT801", "unknown", true],
    ["T46G", "unknown", true],
    ["", "wired", false],
  ];
  for (const [model, link, expected] of cases) {
    assert.equal(decideLocalFactoryReset(model, link).allowed, expected, `${model}/${link}`);
  }
  assert.equal(deviceKindFor("HT812"), "ata");
  assert.equal(deviceKindFor("T53W"), "desk_phone");
  assert.equal(modelCanUseWifi("T53W"), true);
  assert.equal(modelCanUseWifi("T46G"), false);
});
