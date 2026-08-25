// Hidden menu dial codes — the rule module, and source guards on its CALLERS.
//
// Every defect of this feature's shape in this repo has been a missed caller:
// the rule can be perfectly right while buildIvrKeys never publishes a code,
// or while one of the two near-duplicate publish paths skips the stale-code
// tombstones. So beside the unit tests, these read the callers' own source.
// ⛔ Reads are CRLF-normalised (Windows checkouts) and comment lines are
// dropped with a whole-line filter — never a block-comment stripper, which
// over server.ts once swallowed 90k chars at a regex literal and made every
// assertion pass vacuously.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isIvrMenuCode, ivrMenuCodeKey, IVR_MENU_CODE_REGEX } from "./ivrMenuCodes";

test("codes are 3-8 digit strings and nothing else", () => {
  for (const good of ["303", "0478", "1818", "13132", "55648752"]) {
    assert.equal(isIvrMenuCode(good), true, good);
  }
  // Single keypad keys and the star/hash aliases must NEVER read as codes —
  // the fixed digit slate and the code set may not overlap.
  for (const bad of ["0", "9", "star", "hash", "", "12", "123456789", "04a8", "0478 ", "*67", null, undefined]) {
    assert.equal(isIvrMenuCode(bad as any), false, String(bad));
  }
});

test("the AstDB key shape matches what the dialplan looks up", () => {
  // [connect-menu] reads ${MENU_FAMILY}/code_${EXTEN}/dest — the prefix here
  // and the dialplan literal must agree or every code is silently dead.
  assert.equal(ivrMenuCodeKey("0478"), "code_0478");
});

const read = (rel: string) =>
  readFileSync(join(__dirname, rel), "utf8")
    .split(String.fromCharCode(13) + String.fromCharCode(10))
    .join(String.fromCharCode(10));

const stripComments = (src: string) =>
  src
    .split(String.fromCharCode(10))
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith(";") && !t.startsWith("#");
    })
    .join(String.fromCharCode(10));

test("buildIvrKeys publishes the code slate through the shared pure builder", () => {
  const src = stripComments(read("server.ts"));
  // The slate itself lives in ivrMenuCodes.ts (pure, stress-tested); server.ts
  // must CALL it per menu — a local re-implementation would drift.
  assert.match(src, /keys\.push\(\.\.\.buildMenuCodeKeys\(menuFam, menuOptionsByProfile\[p\.id\] \?\? \[\]/);
  // And the ref pipeline every other published ref uses must be the one codes
  // get too — inMenuFamily like the digit slate beside it.
  assert.match(src, /buildMenuCodeKeys\(menuFam[\s\S]{0,220}inMenuFamily: true/);
});

test("BOTH publish paths append stale-code tombstones", () => {
  // The two publish paths are near-duplicates; anything added to one belongs
  // in both. One wrapper definition plus two call sites = 3 mentions minimum.
  const src = stripComments(read("server.ts"));
  const calls = src.split("collectStaleIvrCodeTombstones(").length - 1;
  assert.ok(calls >= 3, `expected the wrapper + 2 call sites, found ${calls} mentions`);
  // The wrapper's baseline is every record SINCE the last success — a FAILED
  // or PENDING publish can have partially written its keys before dying, so
  // consulting only successes lets a deleted code survive (found by the
  // lifetime stress simulator; do not "simplify" this back).
  assert.match(src, /status: "success" \}/);
  assert.match(src, /publishedAt: \{ gte: lastSuccess\.publishedAt \}/);
  assert.match(src, /diffStaleIvrCodeTombstones\(prev, keys\)/);
});

test("the Studio option route accepts a code as an optionDigit", () => {
  const src = stripComments(read("server.ts"));
  assert.match(src, /z\.union\(\[IVR_OPTION_DIGIT_SCHEMA, z\.string\(\)\.regex\(IVR_MENU_CODE_REGEX\)\]\)/);
});

test("the migration planner carries codes through the shared rule", () => {
  const src = stripComments(read("ivrMigration.ts"));
  assert.match(src, /isIvrMenuCode\(code\)/);
  assert.match(src, /carriedCodes/);
});

test("the dialplan patch script matches the rule module's length range", () => {
  const src = read(join("..", "..", "..", "scripts", "pbx", "patch-connect-menu-codes.sh"));
  // 3-8 digits: the modified _XXX/_XXXX heads plus code-only patterns to 8.
  assert.match(src, /_XXXXXXXX/);
  assert.match(src, /code_\$\{EXTEN\}\/dest/);
  assert.match(src, /M_HAS_CODES/);
  // ⛔ A parse error in extensions__60_custom.conf silently keeps the OLD
  // dialplan, so the script must verify the loaded dialplan and restore on
  // failure — never trust the write.
  assert.match(src, /dialplan show connect-menu/);
  assert.match(src, /restoring backup/);
  // The regex here and the patterns there describe the same range.
  assert.equal(String(IVR_MENU_CODE_REGEX), "/^\\d{3,8}$/");
});
