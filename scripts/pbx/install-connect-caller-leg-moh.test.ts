// String-shape regression tests for the Connect CALLER-LEG MOH installer.
//
// Production proof (2026-07-01): inbound hold music renders from the caller/Local
// leg that runs VitalPBX [sub-local-dialing]. Connect's called-leg hooks
// (before-connecting / before-bridging on the PJSIP endpoint) cover OUTBOUND but
// NEVER the inbound held caller/Local leg — so inbound hold played `default`.
// PJSIP moh_suggest (Candidate B) did NOT drive the held peer. The proven fix is
// to set CHANNEL(musicclass) on the leg executing [sub-local-dialing] before
// Dial(). T2 inbound hold was validated live with `moh2` (2026-07-01).
//
// LONG-TERM HARDENING (2026-07-02): the installer now installs ONE generic
// runtime context, [connect-localdial-moh], instead of one per PUBLISHED tenant.
// The context resolves the tenant at CALL TIME from ${TENANT_PREFIX} + AstDB, so
// every current AND future tenant is covered the moment its reverse-map + MOH
// keys exist — with NO PBX regeneration. These tests lock in that contract and
// the migration from the legacy per-tenant dispatch.
//
// We do NOT run the installer in CI (it needs root + asterisk + a VitalPBX host).
// Instead we assert on the generated shell so the guarantees can't silently drift.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(join(__dirname, "install-connect-caller-leg-moh.sh"), "utf8");

// Body of the single generic hook generator.
function hookGen(): string {
  const m = SCRIPT.match(/emit_generic_localdial_moh_hook\s*\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, "could not locate emit_generic_localdial_moh_hook() function");
  return m![1];
}

// Body of a named shell function.
function fnBody(name: string): string {
  const re = new RegExp(`${name}\\s*\\(\\)\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = SCRIPT.match(re);
  assert.ok(m, `could not locate ${name}() function`);
  return m![1];
}

// -- Baseplan patch: one GENERIC guarded GosubIf, at the right seam -----------

test("exactly ONE guarded GosubIf(DIALPLAN_EXISTS(...)) line is inserted before Dial()", () => {
  // The inserted line targets the FIXED generic context — no ${TENANT_PREFIX}
  // in the dispatch, so the same line covers every tenant.
  assert.match(
    SCRIPT,
    /GOSUB_LINE=' same => n,GosubIf\(\$\[\$\{DIALPLAN_EXISTS\(connect-localdial-moh,s,1\)\}=1\]\?connect-localdial-moh,s,1\)'/,
  );
  // Inserted via awk immediately AFTER the anchor line — never a sed rewrite of
  // an existing Dial/Answer priority.
  assert.match(SCRIPT, /awk -v n="\$LN" -v ins="\$GOSUB_LINE" 'NR==n\{print; print ins; next\}\{print\}'/);
});

test("dispatch targets a fixed generic context (no per-tenant ${TENANT_PREFIX} in the baseplan line)", () => {
  const m = SCRIPT.match(/GOSUB_LINE='([^']*)'/);
  assert.ok(m, "GOSUB_LINE not found");
  const line = m![1];
  assert.ok(line.includes("connect-localdial-moh"), "generic context must be the dispatch target");
  assert.equal(/\$\{TENANT_PREFIX\}before-local-dial-moh-hook/.test(line), false, "baseplan line must NOT dispatch to a per-tenant context");
});

test("anchor is the unique U(sub-before-bridging-call seam (after MOH/hotdesk, before Dial)", () => {
  assert.match(SCRIPT, /ANCHOR_SUBSTR='U\(sub-before-bridging-call'/);
});

test("installer REFUSES when the anchor is missing or duplicated (count != 1)", () => {
  assert.match(SCRIPT, /CNT="\$\(anchor_count\)"/);
  assert.match(SCRIPT, /if \[\[ "\$CNT" != "1" \]\]; then/);
  assert.match(SCRIPT, /Refusing to patch/);
});

test("patch is idempotent + re-apply-safe (generic marker guard, no double insert)", () => {
  assert.match(SCRIPT, /if is_patched; then/);
  assert.match(SCRIPT, /already patched — leaving baseplan unchanged/);
  assert.match(SCRIPT, /MARKER="connect-localdial-moh"/);
  assert.match(SCRIPT, /is_patched\(\)\s*\{ grep -qF "\$MARKER" "\$BASEPLAN"/);
  // The generic marker is disjoint from the legacy marker so grep never confuses them.
  assert.match(SCRIPT, /OLD_MARKER="before-local-dial-moh-hook"/);
});

test("baseplan edit is backed up before insertion", () => {
  assert.match(SCRIPT, /BACKUP_BP="\$\{BASEPLAN\}\.bak\.connect-localdial-moh\./);
  assert.match(SCRIPT, /cp -a "\$BASEPLAN" "\$BACKUP_BP"/);
});

// -- Legacy → generic migration ----------------------------------------------

test("installer detects a legacy per-tenant dispatch via has_old_dispatch()", () => {
  assert.match(SCRIPT, /has_old_dispatch\(\)\{ grep -qF "\$OLD_MARKER" "\$BASEPLAN"/);
});

test("install MIGRATES: removes the legacy per-tenant line before inserting the generic one", () => {
  // Fresh (not yet patched) path removes any legacy line first, then converges.
  assert.match(SCRIPT, /if has_old_dispatch; then\s*\n\s*grep -vF "\$OLD_MARKER" "\$BASEPLAN" > "\$\{BASEPLAN\}\.tmp\.\$\$"/);
  assert.match(SCRIPT, /migrating to generic hook/);
});

test("install cleans a stale legacy line even when already generic-patched", () => {
  // is_patched (generic present) AND has_old_dispatch → strip the stale legacy line.
  assert.match(SCRIPT, /removed stale legacy per-tenant dispatch line/);
});

// -- Generic runtime hook contract -------------------------------------------

test("hook is a SINGLE generic context [connect-localdial-moh] — not per-tenant", () => {
  const gen = hookGen();
  assert.match(gen, /\[connect-localdial-moh\]/);
  // No per-tenant context header is emitted anywhere in the installer.
  assert.equal(/\[T%s_before-local-dial-moh-hook\]/.test(SCRIPT), false, "must not emit per-tenant hook headers");
  assert.equal(/printf '\[T%s_/.test(SCRIPT), false, "must not printf per-tenant context names");
});

test("hook derives the tenant id from ${TENANT_PREFIX} (T<id>_ → <id>) with a TRANSFER_CONTEXT fallback", () => {
  const gen = hookGen();
  assert.match(gen, /Set\(CONNECT_MOH_TID=\$\{FILTER\(0-9,\$\{TENANT_PREFIX\}\)\}\)/);
  assert.match(gen, /Set\(CONNECT_MOH_TID=\$\{FILTER\(0-9,\$\{CUT\(TRANSFER_CONTEXT,_,1\)\}\)\}\)/);
});

test("hook is a safe no-op when the tenant id cannot be derived", () => {
  const gen = hookGen();
  assert.match(gen, /GotoIf\(\$\["\$\{CONNECT_MOH_TID\}" = ""\]\?done\)/);
  const guard = gen.indexOf('${CONNECT_MOH_TID}" = ""]?done');
  const slugRead = gen.indexOf("pbx_tenant_map");
  assert.ok(guard > -1 && slugRead > -1 && guard < slugRead, "tid guard must precede the slug read");
});

test("hook reads connect/pbx_tenant_map/<tid>/slug DYNAMICALLY (runtime var, not shell-baked)", () => {
  const gen = hookGen();
  // Uses the dialplan runtime var ${CONNECT_MOH_TID}, proving no per-tenant value
  // is baked in at install time → future tenants resolve with no regeneration.
  assert.match(gen, /Set\(CONNECT_MOH_SLUG=\$\{FILTER\(A-Za-z0-9_-,\$\{DB\(connect\/pbx_tenant_map\/\$\{CONNECT_MOH_TID\}\/slug\)\}\)\}\)/);
});

test("hook is a safe no-op when the slug is absent (unmapped / not-yet-published tenant)", () => {
  const gen = hookGen();
  assert.match(gen, /GotoIf\(\$\["\$\{CONNECT_MOH_SLUG\}" = ""\]\?done\)/);
  const guard = gen.indexOf('${CONNECT_MOH_SLUG}" = ""]?done');
  const classRead = gen.indexOf("admin_moh_class");
  assert.ok(guard > -1 && classRead > -1 && guard < classRead, "slug guard must precede the class reads");
});

test("hook slug is filtered to a safe AstDB path token before building the DB path", () => {
  const gen = hookGen();
  assert.match(gen, /FILTER\(A-Za-z0-9_-,\$\{DB\(connect\/pbx_tenant_map\/\$\{CONNECT_MOH_TID\}\/slug\)\}\)/);
});

test("hook resolves admin_moh_class → moh_class → active_moh_class (in that order)", () => {
  const gen = hookGen();
  assert.match(gen, /Set\(CONNECT_MOH_CLASS=\$\{DB\(connect\/t_\$\{CONNECT_MOH_SLUG\}\/admin_moh_class\)\}\)/);
  assert.match(gen, /Set\(CONNECT_MOH_CLASS=\$\{DB\(connect\/t_\$\{CONNECT_MOH_SLUG\}\/moh_class\)\}\)/);
  assert.match(gen, /Set\(CONNECT_MOH_CLASS=\$\{DB\(connect\/t_\$\{CONNECT_MOH_SLUG\}\/active_moh_class\)\}\)/);
  const idxAdmin = gen.indexOf("/admin_moh_class)}");
  const idxTenant = gen.indexOf("/moh_class)}");
  const idxActive = gen.indexOf("/active_moh_class)}");
  assert.ok(idxAdmin > -1 && idxTenant > -1 && idxActive > -1, "all three class reads present");
  assert.ok(idxAdmin < idxTenant && idxTenant < idxActive, "priority order admin → moh_class → active_moh_class");
});

test("hook is fail-safe: missing class returns WITHOUT touching musicclass", () => {
  const gen = hookGen();
  assert.match(gen, /GotoIf\(\$\["\$\{CONNECT_MOH_CLASS\}" = ""\]\?done\)/);
  const guardIdx = gen.lastIndexOf('${CONNECT_MOH_CLASS}" = ""]?done');
  const setIdx = gen.indexOf("Set(CHANNEL(musicclass)");
  assert.ok(guardIdx > -1 && setIdx > -1 && guardIdx < setIdx, "class guard must precede musicclass set");
  assert.match(gen, /same => n\(done\),Return\(\)/);
});

test("hook sets ONLY CHANNEL(musicclass) and __CONNECT_MOH (plus local scratch vars)", () => {
  const gen = hookGen();
  assert.match(gen, /Set\(CHANNEL\(musicclass\)=\$\{CONNECT_MOH_CLASS\}\)/);
  assert.match(gen, /Set\(__CONNECT_MOH=\$\{CONNECT_MOH_CLASS\}\)/);
  const sets = [...gen.matchAll(/Set\(([^)=]+)/g)].map((m) => m[1].trim());
  const allowed = new Set(["CHANNEL(musicclass", "__CONNECT_MOH", "CONNECT_MOH_CLASS", "CONNECT_MOH_TID", "CONNECT_MOH_SLUG"]);
  for (const s of sets) {
    assert.ok(allowed.has(s), `unexpected Set(${s}) in caller-leg hook`);
  }
});

test("hook is metadata-only — no Answer/Dial/Local/Originate/Playback/Background", () => {
  const gen = hookGen();
  for (const forbidden of [/\bAnswer\s*\(/i, /\bDial\s*\(/i, /\bLocal\//i, /\bOriginate\b/i, /\bPlayback\s*\(/i, /\bBackground\s*\(/i]) {
    assert.equal(forbidden.test(gen), false, `caller-leg hook must not contain ${forbidden}`);
  }
});

test("the hook file is written from the generic generator (no published-only tenant loop)", () => {
  assert.match(SCRIPT, /emit_generic_localdial_moh_hook\s*\n\s*\} > "\$HOOK_FILE"/);
  // The old published-only filter must be gone.
  assert.equal(/only tenants with PUBLISHED MOH/i.test(SCRIPT), false, "published-only gating must be removed");
  assert.equal(/if \[\[ -z "\$slug" \|\| -z "\$class" \]\]; then/.test(SCRIPT), false, "no per-tenant slug/class skip loop");
});

// -- Health check (--check) hardening ----------------------------------------

test("--check verifies anchor==1, generic patch, no legacy line, hook file, #tryinclude", () => {
  const body = fnBody("do_health_check");
  assert.match(body, /anchor unique in baseplan/);
  assert.match(body, /if is_patched; then/);
  assert.match(body, /if has_old_dispatch; then/);
  assert.match(body, /still calls the legacy per-tenant hook/);
  assert.match(body, /official hook file present/);
  assert.match(body, /#tryinclude present in/);
});

test("--check fails on a duplicate on-disk definition of [connect-localdial-moh]", () => {
  const body = fnBody("do_health_check");
  assert.match(body, /grep -lF '\[connect-localdial-moh\]' \/etc\/asterisk\/extensions\*\.conf/);
  assert.match(body, /def_count="\$\(printf '%s' "\$def_files" \| grep -c \./);
  assert.match(body, /if \[\[ "\$def_count" = "1" \]\] && printf '%s\\n' "\$def_files" \| grep -qxF "\$HOOK_FILE"/);
});

test("--check fails when a stale legacy per-tenant context is still defined on disk", () => {
  const body = fnBody("do_health_check");
  assert.match(body, /grep -lE '\\\[T\[0-9\]\+_before-local-dial-moh-hook\\\]' \/etc\/asterisk\/extensions\*\.conf/);
});

test("--check fails when a manual __66 caller-leg patch is present (official __67 must own it)", () => {
  const body = fnBody("do_health_check");
  assert.match(body, /grep -lE 'before-local-dial-moh-hook\|connect-localdial-moh' \/etc\/asterisk\/extensions__66\*\.conf/);
  assert.match(body, /official __67 owns the hook/);
});

test("--check verifies the LIVE dialplan (GosubIf token + loaded generic context sentinel), format-tolerant", () => {
  const body = fnBody("do_health_check");
  // Single-token grep survives Asterisk `dialplan show` re-wrapping/spacing.
  assert.match(body, /dialplan show sub-local-dialing" 2>&1 \| grep -qF "\$GENERIC_CTX"/);
  assert.match(body, /dialplan show \$GENERIC_CTX" 2>&1 \| grep -qF "\$HOOK_SENTINEL"/);
  assert.match(SCRIPT, /HOOK_SENTINEL="Connect generic caller-leg MOH hook"/);
});

test("--check is read-only (no writes / no reload / no database put)", () => {
  const body = fnBody("do_health_check");
  for (const forbidden of [/\bcp -a\b/, /\bmv\b/, /\bsed -i\b/, /\brm -f\b/, /\btee\b/, /dialplan reload/, /database put/, />>\s*"/, />\s*"\$/]) {
    assert.equal(forbidden.test(body), false, `--check must be read-only (found ${forbidden})`);
  }
});

// -- Tenant coverage: dynamic, not published-only ----------------------------

test("installer does NOT hard-code any tenant id (no T2/T3/T21 baked into the hook)", () => {
  const gen = hookGen();
  assert.equal(/\bT2_|\bT3_|\bT21_/.test(gen), false, "generic hook must not hard-code tenant ids");
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

test("rollback surgically removes ONLY the Connect-owned line(s) + hook file + #tryinclude", () => {
  const body = fnBody("do_rollback");
  // Baseplan line(s) removed by exact marker match (generic + legacy), never a
  // broad Dial/context wipe.
  assert.match(body, /grep -vF -e "\$MARKER" -e "\$OLD_MARKER" "\$BASEPLAN"/);
  assert.match(body, /rm -f "\$HOOK_FILE"/);
  assert.match(body, /sed -i '\/\^#tryinclude extensions__67_connect_localdial_moh\\\.conf\$\/d'/);
  // Rollback must NOT touch AstDB or native MOH config.
  assert.equal(/database (put|del|deltree)/.test(body), false, "rollback must not mutate AstDB");
  assert.equal(/musiconhold/.test(body), false, "rollback must not touch native MOH config");
});
