// String-shape regression tests for the Connect CALLER-LEG MOH installer.
//
// Production proof (2026-07-01): inbound hold music renders from the caller/Local
// leg that runs VitalPBX [sub-local-dialing]. Connect's called-leg hooks
// (before-connecting / before-bridging on the PJSIP endpoint) cover OUTBOUND but
// NEVER the inbound held caller/Local leg — so inbound hold played `default`.
// PJSIP moh_suggest (Candidate B) did NOT drive the held peer. The proven fix is
// to set CHANNEL(musicclass) on the leg executing [sub-local-dialing] before
// Dial(). These tests lock in the exact runtime contract of that fix.
//
// We do NOT run the installer in CI (it needs root + asterisk + a VitalPBX host).
// Instead we assert on the generated shell so the guarantees can't silently drift:
//   * ONE guarded GosubIf(DIALPLAN_EXISTS(...)) is inserted, after the unique
//     U(sub-before-bridging-call anchor, before Dial().
//   * Installer refuses unless the anchor count is exactly 1 (missing/duplicate).
//   * The patch is idempotent + re-apply-safe (marker guard).
//   * Per-tenant hooks are emitted ONLY for tenants with a PUBLISHED class
//     (slug AND moh_class present in connect/pbx_tenant_map).
//   * Each hook sets ONLY CHANNEL(musicclass) + __CONNECT_MOH, is fail-safe
//     (missing class ⇒ bare Return), and contains no Answer/Dial/Local/Playback.
//   * Non-enabled tenants no-op via DIALPLAN_EXISTS (no hook context generated).
//   * The installer only mutates the baseplan by INSERTING the guarded line
//     (never sed-rewrites Dial/Answer), and touches no pjsip/musiconhold/route files.
//   * --check / --rollback / --help modes exist; rollback is surgical.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(__dirname, "install-connect-caller-leg-moh.sh"), "utf8");

// Body of the per-tenant hook generator.
function hookGen(): string {
  const m = SCRIPT.match(/emit_localdial_moh_hook\s*\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, "could not locate emit_localdial_moh_hook() function");
  return m![1];
}

// -- Baseplan patch: one guarded GosubIf, at the right seam --------------------

test("exactly ONE guarded GosubIf(DIALPLAN_EXISTS(...)) line is inserted before Dial()", () => {
  // The inserted line is the single GOSUB_LINE constant.
  assert.match(
    SCRIPT,
    /GOSUB_LINE=' same => n,GosubIf\(\$\[\$\{DIALPLAN_EXISTS\(\$\{TENANT_PREFIX\}before-local-dial-moh-hook,s,1\)\}=1\]\?\$\{TENANT_PREFIX\}before-local-dial-moh-hook,s,1\)'/,
  );
  // It is inserted via awk immediately AFTER the anchor line — never a sed
  // rewrite of an existing Dial/Answer priority.
  assert.match(SCRIPT, /awk -v n="\$LN" -v ins="\$GOSUB_LINE" 'NR==n\{print; print ins; next\}\{print\}'/);
});

test("anchor is the unique U(sub-before-bridging-call seam (after MOH/hotdesk, before Dial)", () => {
  assert.match(SCRIPT, /ANCHOR_SUBSTR='U\(sub-before-bridging-call'/);
});

test("installer REFUSES when the anchor is missing or duplicated (count != 1)", () => {
  assert.match(SCRIPT, /CNT="\$\(anchor_count\)"/);
  assert.match(SCRIPT, /if \[\[ "\$CNT" != "1" \]\]; then/);
  assert.match(SCRIPT, /Refusing to patch/);
});

test("patch is idempotent + re-apply-safe (marker guard, no double insert)", () => {
  assert.match(SCRIPT, /if is_patched; then\s*\n\s*echo "  ↳ already patched/);
  assert.match(SCRIPT, /MARKER="before-local-dial-moh-hook"/);
  assert.match(SCRIPT, /is_patched\(\)\s*\{ grep -qF "\$MARKER" "\$BASEPLAN"/);
});

test("baseplan edit is backed up before insertion", () => {
  assert.match(SCRIPT, /BACKUP_BP="\$\{BASEPLAN\}\.bak\.connect-localdial-moh\./);
  assert.match(SCRIPT, /cp -a "\$BASEPLAN" "\$BACKUP_BP"/);
});

// -- Per-tenant hook contract --------------------------------------------------

test("hook sets ONLY CHANNEL(musicclass) and __CONNECT_MOH", () => {
  const gen = hookGen();
  assert.match(gen, /Set\(CHANNEL\(musicclass\)=\$\{CONNECT_MOH_CLASS\}\)/);
  assert.match(gen, /Set\(__CONNECT_MOH=\$\{CONNECT_MOH_CLASS\}\)/);
  // The only other Set() is the local scratch var CONNECT_MOH_CLASS — assert no
  // other channel/global side effects leak in.
  const sets = [...gen.matchAll(/Set\(([^)=]+)/g)].map((m) => m[1].trim());
  const allowed = new Set(["CHANNEL(musicclass", "__CONNECT_MOH", "CONNECT_MOH_CLASS"]);
  for (const s of sets) {
    assert.ok(allowed.has(s), `unexpected Set(${s}) in caller-leg hook`);
  }
});

test("hook reads the tenant's SLUG-PINNED AstDB class with active_moh_class fallback", () => {
  const gen = hookGen();
  assert.match(gen, /Set\(CONNECT_MOH_CLASS=\$\{DB\(connect\/t_%s\/moh_class\)\}\)/);
  assert.match(gen, /Set\(CONNECT_MOH_CLASS=\$\{DB\(connect\/t_%s\/active_moh_class\)\}\)/);
});

test("hook is fail-safe: missing class returns WITHOUT touching musicclass", () => {
  const gen = hookGen();
  assert.match(gen, /GotoIf\(\$\["\$\{CONNECT_MOH_CLASS\}" = ""\]\?done\)/);
  // The GotoIf(done) must precede the CHANNEL(musicclass) Set in the body.
  const guardIdx = gen.indexOf("?done)");
  const setIdx = gen.indexOf("Set(CHANNEL(musicclass)");
  assert.ok(guardIdx > -1 && setIdx > -1 && guardIdx < setIdx, "class guard must precede musicclass set");
  assert.match(gen, /same => n\(done\),Return\(\)/);
});

test("hook is metadata-only — no Answer/Dial/Local/Originate/Playback/Background", () => {
  const gen = hookGen();
  for (const forbidden of [/\bAnswer\s*\(/i, /\bDial\s*\(/i, /\bLocal\//i, /\bOriginate\b/i, /\bPlayback\s*\(/i, /\bBackground\s*\(/i]) {
    assert.equal(forbidden.test(gen), false, `caller-leg hook must not contain ${forbidden}`);
  }
});

test("hook context name is per-tenant isolated (T<tid>_before-local-dial-moh-hook)", () => {
  const gen = hookGen();
  assert.match(gen, /printf '\[T%s_before-local-dial-moh-hook\]\\n' "\$tid"/);
});

// -- Tenant enumeration: published MOH only ------------------------------------

test("installer enumerates tenants from connect/pbx_tenant_map", () => {
  assert.match(SCRIPT, /database show connect\/pbx_tenant_map/);
  assert.match(SCRIPT, /grep -E '\^\[0-9\]\+\$'/);
});

test("hook is emitted ONLY for tenants with BOTH slug and moh_class (published MOH)", () => {
  assert.match(SCRIPT, /if \[\[ -z "\$slug" \|\| -z "\$class" \]\]; then/);
  // The skip path must `continue` before emitting a hook.
  const m = SCRIPT.match(/if \[\[ -z "\$slug" \|\| -z "\$class" \]\]; then([\s\S]*?)fi/);
  assert.ok(m && /continue/.test(m[1]), "empty slug/class must continue (skip emit)");
});

test("installer validates slug is a safe AstDB path token before use", () => {
  assert.match(SCRIPT, /"\$slug" != "\$\{slug\/\/\[\^A-Za-z0-9_-\]\/\}"/);
});

// -- Blast-radius guards -------------------------------------------------------

test("installer touches NO pjsip/musiconhold/route/50-* generated files", () => {
  for (const banned of ["extensions__50-", "pjsip__", "musiconhold__", "queues__", "extensions_additional"]) {
    const re = new RegExp(`(?:>|>>|\\bmv\\b|\\bcp -a\\b|\\bsed -i\\b|\\btee\\b|\\brm -f\\b)[^\\n]*${banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    assert.equal(re.test(SCRIPT), false, `installer must not write/mutate ${banned}`);
  }
});

test("installer writes NO AstDB keys (reads only)", () => {
  const nonComment = SCRIPT.split("\n").filter((l) => !/^\s*#/.test(l) && !/^\s*;/.test(l)).join("\n");
  assert.equal(/database put/.test(nonComment), false, "installer must not write AstDB keys");
});

test("Connect-owned overlay is the __67 file; hub #tryinclude's it", () => {
  assert.match(SCRIPT, /HOOK_FILE="\/etc\/asterisk\/extensions__67_connect_localdial_moh\.conf"/);
  assert.match(SCRIPT, /INCLUDE_LINE="#tryinclude extensions__67_connect_localdial_moh\.conf"/);
});

// -- Modes ---------------------------------------------------------------------

test("installer provides install / --check / --rollback / --help modes", () => {
  assert.match(SCRIPT, /--check\|-n\|--dry-run\|check\)/);
  assert.match(SCRIPT, /--rollback\|--uninstall\|rollback\|uninstall\)/);
  assert.match(SCRIPT, /-h\|--help\|help\)/);
});

test("--check is read-only (no writes / no reload / no database put)", () => {
  const m = SCRIPT.match(/do_health_check\s*\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, "do_health_check() not found");
  const body = m![1];
  // Read-only means: no mutating commands, no reload, and no output redirection
  // to a real file (only `>/dev/null` / `2>/dev/null` discards are allowed).
  for (const forbidden of [/\bcp -a\b/, /\bmv\b/, /\bsed -i\b/, /\brm -f\b/, /\btee\b/, /dialplan reload/, /database put/, />>\s*"/, />\s*"\$/]) {
    assert.equal(forbidden.test(body), false, `--check must be read-only (found ${forbidden})`);
  }
});

test("rollback surgically removes ONLY the Connect-owned line + hook file + #tryinclude", () => {
  const m = SCRIPT.match(/do_rollback\s*\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, "do_rollback() not found");
  const body = m![1];
  // Baseplan line removed by exact MARKER match (never a broad Dial/context wipe).
  assert.match(body, /grep -vF "\$MARKER" "\$BASEPLAN"/);
  assert.match(body, /rm -f "\$HOOK_FILE"/);
  assert.match(body, /sed -i '\/\^#tryinclude extensions__67_connect_localdial_moh\\\.conf\$\/d'/);
});
