// String-shape regression tests for the Connect cos-wake KEY-DRIVEN overlay
// installer. We do NOT run the installer in CI (it needs root, asterisk, and a
// VitalPBX host). Instead we assert the generated per-tenant stanza embeds the
// exact runtime contract the design depends on:
//
//   * The gate is a PATTERN (not a hardcoded extension) so future mobile
//     extensions are enabled by AstDB key alone — no dialplan regen/reload.
//   * The SINGLE runtime control key connect/wake_canary/T<tid>_<ext> is read.
//   * key != 1  → immediate Goto(T<tid>_cos-all-init,${EXTEN},1)  (old behavior)
//   * key == 1  → Gosub(connect-wake-core,...) then the SAME handback.
//   * __CONNECT_WAKE_DONE, intercom/paging/skip, and engine-missing all hand back.
//   * The stanza NEVER contains Answer()/Dial()/Local/ — metadata + Gosub only.
//   * Per-tenant isolation: the tid is substituted into BOTH the key and the
//     handback context.
//   * Only the Connect-owned __66 file is written; no VitalPBX-generated file.
//   * The installer writes NO connect/wake_canary/* keys (reconciler owns those).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(__dirname, "install-connect-cos-wake-overlay.sh"), "utf8");

// Extract the body of the emit_cos_wake_stanza() generator function.
function stanzaGen(): string {
  const m = SCRIPT.match(/emit_cos_wake_stanza\s*\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, "could not locate emit_cos_wake_stanza() function");
  return m![1];
}

test("gate uses numeric extension-length PATTERNS, not a hardcoded extension", () => {
  assert.match(SCRIPT, /PATTERNS="_XXX _XXXX"/);
  const gen = stanzaGen();
  // The exten line is generated from the %s pattern token, not a literal number.
  assert.match(gen, /printf 'exten => %s,1,NoOp\(Connect cos-wake gate tid=%s/);
  // No hardcoded canary extension like `exten => 110` in the generator.
  assert.equal(/exten => 110\b/.test(gen), false, "must not hardcode ext 110");
});

test("gate reads the single runtime control key connect/wake_canary/T<tid>_${EXTEN}", () => {
  const gen = stanzaGen();
  assert.match(gen, /Set\(WAKE_CANARY=\$\{DB\(connect\/wake_canary\/T%s_\$\{EXTEN\}\)\}\)/);
});

test("key != 1 hands back immediately to the native init context (old behavior)", () => {
  const gen = stanzaGen();
  assert.match(gen, /GotoIf\(\$\["\$\{WAKE_CANARY\}" != "1"\]\?handback\)/);
  assert.match(gen, /same => n\(handback\),Goto\(T%s_cos-all-init,\$\{EXTEN\},1\)/);
});

test("key == 1 routes through connect-wake-core then hands back", () => {
  const gen = stanzaGen();
  assert.match(gen, /Gosub\(connect-wake-core,s,1\(%s,\$\{EXTEN\},1\)\)/);
  // The Gosub must precede the handback label in the generated body.
  const gosubIdx = gen.indexOf("Gosub(connect-wake-core");
  const handbackIdx = gen.indexOf("(handback),Goto(T%s_cos-all-init");
  assert.ok(gosubIdx > -1 && handbackIdx > -1 && gosubIdx < handbackIdx);
});

test("__CONNECT_WAKE_DONE re-entry guard hands back (no double-wake / no Local loop)", () => {
  const gen = stanzaGen();
  assert.match(gen, /GotoIf\(\$\["\$\{__CONNECT_WAKE_DONE\}" = "1"\]\?handback\)/);
  // And it sets the one-shot flag before invoking the engine.
  assert.match(gen, /Set\(__CONNECT_WAKE_DONE=1\)/);
});

test("intercom / paging / SKIP_CONTACT_SERVICES hand back", () => {
  const gen = stanzaGen();
  assert.match(gen, /FORCE_INTERCOM\}" = "yes"/);
  assert.match(gen, /SRC_APP\}" = "PAGING"/);
  assert.match(gen, /SKIP_CONTACT_SERVICES\}" = "TRUE"/);
});

test("engine-missing guard hands back", () => {
  const gen = stanzaGen();
  assert.match(gen, /GotoIf\(\$\[\$\{DIALPLAN_EXISTS\(connect-wake-core,s,1\)\} != 1\]\?handback\)/);
});

test("stanza is metadata + Gosub only — no Answer/Dial/Local/Originate/Playback", () => {
  const gen = stanzaGen();
  for (const forbidden of [/\bAnswer\s*\(/i, /\bDial\s*\(/i, /\bLocal\//i, /\bOriginate\b/i, /\bPlayback\s*\(/i, /\bBackground\s*\(/i]) {
    assert.equal(forbidden.test(gen), false, `gate stanza must not contain ${forbidden}`);
  }
});

test("per-tenant isolation: tid is substituted into both the key and the handback context", () => {
  const gen = stanzaGen();
  // Key read and handback both use the same %s tid arg.
  assert.match(gen, /connect\/wake_canary\/T%s_/);
  assert.match(gen, /Goto\(T%s_cos-all-init/);
  // Gosub passes the numeric tid as ARG1.
  assert.match(gen, /Gosub\(connect-wake-core,s,1\(%s,/);
});

test("installer only writes the Connect-owned __66 overlay, never VitalPBX-generated files", () => {
  assert.match(SCRIPT, /OVERLAY_FILE="\/etc\/asterisk\/extensions__66_connect_cos_wake\.conf"/);
  for (const banned of ["extensions__50-", "extensions__20-baseplan.conf", "pjsip__50_", "musiconhold__"]) {
    const re = new RegExp(`(?:>|>>|\\bmv\\b|\\bcp\\b|\\bsed\\b|\\btee\\b|\\bchown\\b|\\bchmod\\b|\\brm\\b)[^\\n]*${banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    assert.equal(re.test(SCRIPT), false, `installer must not write/mutate ${banned}`);
  }
});

test("installer writes NO connect/wake_canary/* keys (reconciler owns key state)", () => {
  // The generalized installer must not `database put` any wake_canary key.
  const nonComment = SCRIPT.split("\n").filter((l) => !/^\s*#/.test(l) && !/^\s*;/.test(l)).join("\n");
  assert.equal(
    /database put\s+connect\/wake_canary/.test(nonComment),
    false,
    "installer must not write wake_canary keys — that is the reconciler's job",
  );
});

test("installer enumerates Connect-known tenant ids from connect/pbx_tenant_map", () => {
  assert.match(SCRIPT, /database show connect\/pbx_tenant_map/);
  assert.match(SCRIPT, /grep -E '\^\[0-9\]\+\$'/);
});

test("installer verifies the native hand-back context exists before gating a tenant", () => {
  assert.match(SCRIPT, /dialplan show T\$\{tid\}_cos-all-init/);
});

test("installer provides --check, --rollback, --help modes", () => {
  assert.match(SCRIPT, /--check\|-n\|--dry-run\|check\)/);
  assert.match(SCRIPT, /--rollback\|--uninstall\|rollback\|uninstall\)/);
  assert.match(SCRIPT, /-h\|--help\|help\)/);
});

test("rollback removes ONLY the Connect-owned file + its #tryinclude line", () => {
  const m = SCRIPT.match(/do_rollback\s*\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, "do_rollback() not found");
  const body = m![1];
  assert.match(body, /rm -f "\$OVERLAY_FILE"/);
  assert.match(body, /sed -i '\/\^#tryinclude extensions__66_connect_cos_wake\\\.conf\$\/d'/);
});
