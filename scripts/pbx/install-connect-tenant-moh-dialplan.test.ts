// String-shape regression tests for the Connect tenant MOH dialplan installer.
//
// We do NOT run the installer in CI (it would require root, asterisk, and a
// VitalPBX host). Instead we assert the installer file embeds the contracts
// the design depends on:
//
//   * All four required Asterisk contexts are defined or generated:
//       - [sub-connect-tenant-moh]                (resolver, static)
//       - [global-before-bridging-call-hook]      (called-leg wrapper, static)
//       - [connect-tenant-moh-connect-shim]       (caller-leg shim, static)
//       - [T<id>_before-connecting-call-hook]     (caller-leg per-tenant
//                                                  dispatch, dynamic — one
//                                                  per tenant id discovered
//                                                  in connect/pbx_tenant_map).
//   * The hook calls our resolver with the agnostic IF()-Set wrapper.
//   * The resolver derives the numeric tenant id from VitalPBX's per-tenant
//     channel context vars FIRST (TRANSFER_CONTEXT, HINTS_CONTEXT,
//     FOLLOWME_CONTEXT, QUEUE_AGENTS_CONTEXT — all "T<id>_..." on tenant
//     calls) and only falls back to ARG1 when no channel-context prefix
//     parses. This is the only way outbound legs work because VitalPBX's
//     [sub-before-bridging-call] in some builds passes the opaque tenant
//     **hash** as ARG1, not a numeric id.
//   * The resolver only accepts ARG1 when it is purely numeric, so a hash
//     never becomes a bogus reverse-map lookup.
//   * The resolver reads the reverse map and falls back to active_moh_class.
//   * The resolver Sets CHANNEL(musicclass) and the inheritable __CONNECT_MOH.
//   * No tenant or MOH class is hardcoded in the static heredoc body.
//   * Per-tenant stanzas are generated dynamically from the connect/pbx_tenant_map
//     AstDB family with a numeric-id-only allowlist.
//   * The installer prints rollback instructions and the operational note
//     that adding a new tenant requires a re-run.
//   * If `extensions__65_*.conf` is not wildcard-included by this PBX, the
//     installer may add one sentinel include to the Connect-owned
//     `extensions__60_custom.conf`; it must still never edit VitalPBX-generated
//     baseplan / tenant / trunk files.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = join(__dirname, "install-connect-tenant-moh-dialplan.sh");
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");

// Extract the real [sub-connect-tenant-moh] resolver context body (from the
// header line immediately followed by `exten => s,1,` up to the next context
// header). CRLF-tolerant. Shared by the metadata-only / classification tests.
function resolverBody(): string {
  const m = SCRIPT.match(/\n\[sub-connect-tenant-moh\]\r?\nexten => s,1,([\s\S]*?)\r?\n\[/);
  assert.ok(m, "could not locate [sub-connect-tenant-moh] context body");
  return m![1];
}

test("installer defines all three required static Asterisk contexts", () => {
  assert.match(SCRIPT, /\[sub-connect-tenant-moh\]/, "missing [sub-connect-tenant-moh] context header");
  assert.match(SCRIPT, /\[global-before-bridging-call-hook\]/, "missing [global-before-bridging-call-hook] context header");
  assert.match(SCRIPT, /\[connect-tenant-moh-connect-shim\]/, "missing [connect-tenant-moh-connect-shim] context header");
});

test("connect-leg shim gosubs into the resolver using channel vars", () => {
  // The shim runs on the caller leg and uses TENANT/CALLER/CALLEE channel
  // vars set by [sub-before-connecting-call] priorities 2..4 — it does NOT
  // depend on positional args from the per-tenant dispatch context.
  assert.match(
    SCRIPT,
    /\[connect-tenant-moh-connect-shim\][\s\S]*?Gosub\(sub-connect-tenant-moh,s,1\(\$\{TENANT\},\$\{CALLER\},\$\{CALLEE\}\)\)/,
  );
});

test("installer enumerates per-tenant ids from connect/pbx_tenant_map AstDB", () => {
  // Must read the AstDB family Connect's API populates on every MOH
  // publish/rollback, parse only the numeric id segment, and dedupe.
  assert.match(SCRIPT, /asterisk -rx 'database show connect\/pbx_tenant_map'/);
  // Field 4 of "/connect/pbx_tenant_map/<id>/<key>" is the id.
  assert.match(SCRIPT, /awk -F'\/'[^\n]*'\/\^\\\/connect\\\/pbx_tenant_map\\\/\/\{print \$4\}'/);
  // Numeric-only allowlist.
  assert.match(SCRIPT, /grep -E '\^\[0-9\]\+\$'/);
  // Sort + unique.
  assert.match(SCRIPT, /sort -un/);
});

test("installer generates one [T<id>_before-connecting-call-hook] include-shim stanza per tenant id", () => {
  // The dynamic loop must use the shell variable name $tid (sourced from
  // $TENANT_IDS) and write exactly the include-shim form. We do not test
  // the final file content (which depends on AstDB at install time), only
  // the generator code shape.
  assert.match(
    SCRIPT,
    /for\s+tid\s+in\s+\$TENANT_IDS;\s*do[\s\S]*?T\$\{tid\}_before-connecting-call-hook[\s\S]*?include\s*=>\s*connect-tenant-moh-connect-shim[\s\S]*?done/,
  );
});

test("installer warns when AstDB has no Connect-known tenants", () => {
  // Empty TENANT_IDS path must NOT silently skip — operator needs to know
  // outbound caller-leg MOH won't change for any tenant this run.
  assert.match(SCRIPT, /No tenants found in connect\/pbx_tenant_map AstDB family/);
  assert.match(SCRIPT, /re-run this installer/i);
});

test("global-before-bridging-call-hook uses argument-mode-agnostic IF() wrapper", () => {
  // Approved exact wrapper shape: ARG1/ARG2/ARG3 falling back to TENANT/CALLER/CALLEE channel vars.
  assert.match(SCRIPT, /Set\(T=\$\{IF\(\$\["\$\{ARG1\}" != ""\]\?\$\{ARG1\}:\$\{TENANT\}\)\}\)/);
  assert.match(SCRIPT, /Set\(FROM=\$\{IF\(\$\["\$\{ARG2\}" != ""\]\?\$\{ARG2\}:\$\{CALLER\}\)\}\)/);
  assert.match(SCRIPT, /Set\(TO=\$\{IF\(\$\["\$\{ARG3\}" != ""\]\?\$\{ARG3\}:\$\{CALLEE\}\)\}\)/);
  assert.match(SCRIPT, /Gosub\(sub-connect-tenant-moh,s,1\(\$\{T\},\$\{FROM\},\$\{TO\}\)\)/);
});

test("resolver derives numeric tenant id from existing T<N>_ channel context vars (preferred path)", () => {
  // VitalPBX's per-tenant generated dialplan populates these *_CONTEXT vars
  // on every channel routed through a tenant context. Ordering matters:
  // TRANSFER_CONTEXT is the most stable on outbound trunk dial paths.
  assert.match(SCRIPT, /Set\(TENANT_CTX_RAW=\$\{TRANSFER_CONTEXT\}\)/);
  assert.match(
    SCRIPT,
    /ExecIf\(\$\["\$\{TENANT_CTX_RAW\}" = ""\]\?Set\(TENANT_CTX_RAW=\$\{HINTS_CONTEXT\}\)\)/,
  );
  assert.match(
    SCRIPT,
    /ExecIf\(\$\["\$\{TENANT_CTX_RAW\}" = ""\]\?Set\(TENANT_CTX_RAW=\$\{FOLLOWME_CONTEXT\}\)\)/,
  );
  assert.match(
    SCRIPT,
    /ExecIf\(\$\["\$\{TENANT_CTX_RAW\}" = ""\]\?Set\(TENANT_CTX_RAW=\$\{QUEUE_AGENTS_CONTEXT\}\)\)/,
  );
  // First underscore-delimited segment, accept only "T<digits>".
  assert.match(SCRIPT, /Set\(TENANT_CTX_PREFIX=\$\{CUT\(TENANT_CTX_RAW,_,1\)\}\)/);
  assert.match(SCRIPT, /Set\(TENANT_FROM_CTX=\)/);
  assert.match(
    SCRIPT,
    /ExecIf\(\$\["\$\{TENANT_CTX_PREFIX:0:1\}" = "T"\]\?Set\(TENANT_FROM_CTX=\$\{FILTER\(0-9,\$\{TENANT_CTX_PREFIX:1\}\)\}\)\)/,
  );
});

test("resolver normalizes ARG1 'T<N>' fallback and rejects opaque hashes", () => {
  // ARG1 still strips the "T" prefix when present.
  assert.match(
    SCRIPT,
    /Set\(TENANT_FROM_ARG=\$\{IF\(\$\["\$\{TENANT_RAW:0:1\}" = "T"\]\?\$\{TENANT_RAW:1\}:\$\{TENANT_RAW\}\)\}\)/,
  );
  // ARG1-derived id must be purely numeric — a non-digit anywhere clears it.
  // This is the guard that prevents VitalPBX tenant hashes (e.g.
  // 56a4d7cbd1c39e31) being treated as tenant ids on outbound legs.
  assert.match(
    SCRIPT,
    /ExecIf\(\$\["\$\{TENANT_FROM_ARG\}" != "\$\{FILTER\(0-9,\$\{TENANT_FROM_ARG\}\)\}"\]\?Set\(TENANT_FROM_ARG=\)\)/,
  );
});

test("resolver final TENANT_ID prefers context-derived id over ARG1", () => {
  assert.match(
    SCRIPT,
    /Set\(TENANT_ID=\$\{IF\(\$\["\$\{TENANT_FROM_CTX\}" != ""\]\?\$\{TENANT_FROM_CTX\}:\$\{TENANT_FROM_ARG\}\)\}\)/,
  );
});

test("resolver reads reverse-tenant-map slug and primary+fallback MOH classes", () => {
  assert.match(SCRIPT, /\$\{DB\(connect\/pbx_tenant_map\/\$\{TENANT_ID\}\/slug\)\}/);
  assert.match(SCRIPT, /\$\{DB\(connect\/t_\$\{TENANT_SLUG_LOCAL\}\/moh_class\)\}/);
  assert.match(
    SCRIPT,
    /ExecIf\(\$\["\$\{MOH_CLASS_LOCAL\}" = ""\]\?Set\(MOH_CLASS_LOCAL=\$\{DB\(connect\/t_\$\{TENANT_SLUG_LOCAL\}\/active_moh_class\)\}\)\)/,
  );
});

test("resolver Sets CHANNEL(musicclass) and inheritable __CONNECT_MOH", () => {
  assert.match(SCRIPT, /Set\(CHANNEL\(musicclass\)=\$\{MOH_CLASS_LOCAL\}\)/);
  assert.match(SCRIPT, /Set\(__CONNECT_MOH=\$\{MOH_CLASS_LOCAL\}\)/);
});

test("resolver fail-safes return without changing the channel on missing data", () => {
  // Three guards: empty resolved TENANT_ID (covers the case where neither the
  // channel context vars nor ARG1 yielded a numeric tenant id), empty resolved
  // slug, empty resolved class.
  assert.match(SCRIPT, /GotoIf\(\$\["\$\{TENANT_ID\}" = ""\]\?done\)/);
  assert.match(SCRIPT, /GotoIf\(\$\["\$\{TENANT_SLUG_LOCAL\}" = ""\]\?done\)/);
  assert.match(SCRIPT, /GotoIf\(\$\["\$\{MOH_CLASS_LOCAL\}" = ""\]\?done\)/);
  // The "done" label must be a bare Return().
  assert.match(SCRIPT, /\(done\),NoOp\(Connect tenant MOH skipped[^\n]*\)\n\s+same\s*=>\s*n,Return\(\)/);
});

test("installer never hardcodes a tenant or a specific moh class in the dialplan body", () => {
  // Extract just the embedded dialplan body (between the CONNECT_TENANT_MOH_EOF
  // heredoc markers). Documentation comments elsewhere in the installer may
  // reference example values (e.g. "<tenant-slug>", "T<N>_<ext>") for operator
  // guidance — those must not appear inside the actual dialplan that lands on
  // the PBX.
  const m = SCRIPT.match(/cat > "\$TMP_NEW" <<'CONNECT_TENANT_MOH_EOF'\r?\n([\s\S]*?)\r?\nCONNECT_TENANT_MOH_EOF/);
  assert.ok(m, "could not locate embedded dialplan heredoc");
  const dialplan = m[1].toLowerCase();
  for (const banned of [
    "secro",
    "landau",
    "fleetease",
    "t3_",
    "t21_",
    " moh3",
    " moh8",
    "tenant_id=3",
    "tenant_id=21",
  ]) {
    assert.equal(
      dialplan.indexOf(banned),
      -1,
      `embedded dialplan must not hardcode ${JSON.stringify(banned)}`,
    );
  }
});

test("resolver is metadata-only: no Dial/Local/Answer/Playback/Originate (no-loop / no-duplicate-leg regression)", () => {
  // Requirement 3 + 10: MOH assignment must be control/metadata only. The
  // resolver context may ONLY read AstDB/channel vars and Set the musicclass.
  // If it ever gains a Dial(), Local/ channel, Answer(), Playback(), Background()
  // or Originate() it could fork a call leg, answer for MOH, or loop — so we
  // hard-fail here. Extract the [sub-connect-tenant-moh] context body up to the
  // next context header. CRLF-tolerant.
  // Anchor to the REAL context definition (header line immediately followed by
  // `exten => s,1,`), not the documentation comment that merely names it.
  const body = resolverBody();
  for (const forbidden of [
    /\bDial\s*\(/i,
    /\bLocal\//i,
    /\bAnswer\s*\(/i,
    /\bPlayback\s*\(/i,
    /\bBackground\s*\(/i,
    /\bOriginate\b/i,
    /\bBridge\s*\(/i,
  ]) {
    assert.equal(forbidden.test(body), false, `resolver must not contain ${forbidden} — MOH assignment is metadata-only`);
  }
  // Positive contract: the only channel mutation is CHANNEL(musicclass)/__CONNECT_MOH.
  assert.match(body, /Set\(CHANNEL\(musicclass\)=/);
});

test("resolver per-source lookup is additive and preserves the tenant-default sentinel keys", () => {
  // The new MOH_SRC per-source reads must NOT replace the tenant-default read.
  // Both the per-source families and the legacy tenant/extension default keys
  // must be present, and an empty MOH_SRC must skip the per-source reads.
  assert.match(SCRIPT, /Set\(MOH_SRC=\)/);                                   // starts empty
  assert.match(SCRIPT, /moh\/src\/\$\{MOH_SRC\}/);                            // per-source read
  assert.match(SCRIPT, /connect\/system\/moh_default_class/);                // global default
  assert.match(SCRIPT, /connect\/t_\$\{TENANT_SLUG_LOCAL\}\/moh_class/);      // tenant default preserved
  // Per-source reads are guarded on a non-empty MOH_SRC (fail-safe to default).
  assert.match(SCRIPT, /ExecIf\(\$\["\$\{MOH_SRC\}" != ""\]\?Set\(MOH_CLASS_LOCAL=\$\{DB\(connect\/t_\$\{TENANT_SLUG_LOCAL\}\/moh\/src\/\$\{MOH_SRC\}\)\}\)\)/);
});

test("resolver reads the admin (multi-tenant) overlay FIRST — beats ext + tenant keys", () => {
  // Option C priority (2026-07-01): an active admin multi-tenant schedule is a
  // global takeover that must beat even a pinned extension. The resolver reads
  // the dedicated admin_src / admin_moh_class families before the per-extension
  // and tenant keys, applies + Return()s when present, and the admin reads must
  // appear BEFORE the (1) extension per-source read.
  const body = resolverBody();
  assert.match(body, /Set\(ADMIN_OVR=\)/);
  assert.match(body, /DB\(connect\/t_\$\{TENANT_SLUG_LOCAL\}\/extensions\/\$\{CH_EXT_SAFE\}\/moh\/admin_src\/\$\{MOH_SRC\}\)/);
  assert.match(body, /DB\(connect\/t_\$\{TENANT_SLUG_LOCAL\}\/extensions\/\$\{CH_EXT_SAFE\}\/admin_moh_class\)/);
  assert.match(body, /DB\(connect\/t_\$\{TENANT_SLUG_LOCAL\}\/moh\/admin_src\/\$\{MOH_SRC\}\)/);
  assert.match(body, /DB\(connect\/t_\$\{TENANT_SLUG_LOCAL\}\/admin_moh_class\)/);
  // Admin overlay must be read before the extension per-source override.
  const idxAdmin = body.indexOf("Set(ADMIN_OVR=");
  const idxExtSrc = body.indexOf("/moh/src/${MOH_SRC})}))");
  assert.ok(idxAdmin > -1 && idxExtSrc > -1 && idxAdmin < idxExtSrc, "admin overlay must be read before extension per-source");
  // Applying the admin overlay Returns() so nothing below can lower the priority.
  assert.match(body, /admin-schedule override applied[\s\S]*?Return\(\)/);
});

test("resolver derives internal/outbound/inbound_direct from VitalPBX inherited __CALL_TYPE", () => {
  // Phase 2: the three base call sources are classified ONLY from VitalPBX's
  // own inherited __CALL_TYPE (read as ${CALL_TYPE}) set by [sub-setup-call-type]
  // (1=LOCAL, 2=IN, 3=OUT, 4=TRANSIT). Each read must be guarded on an empty
  // MOH_SRC so the higher-confidence signals (transfer/queue/ring-group/ivr)
  // always win, and so an unknown/TRANSIT call falls through untouched.
  const body = resolverBody();
  assert.match(body, /ExecIf\(\$\[\$\["\$\{MOH_SRC\}" = ""\] & \$\["\$\{CALL_TYPE\}" = "1"\]\]\?Set\(MOH_SRC=internal\)\)/);
  assert.match(body, /ExecIf\(\$\[\$\["\$\{MOH_SRC\}" = ""\] & \$\["\$\{CALL_TYPE\}" = "3"\]\]\?Set\(MOH_SRC=outbound\)\)/);
  assert.match(body, /ExecIf\(\$\[\$\["\$\{MOH_SRC\}" = ""\] & \$\["\$\{CALL_TYPE\}" = "2"\]\]\?Set\(MOH_SRC=inbound_direct\)\)/);
  // CALL_TYPE=4 (TRANSIT, trunk↔trunk) must NOT be mapped — no extension leg.
  assert.equal(/CALL_TYPE\}" = "4"/.test(body), false, "TRANSIT calls must be left unclassified (no extension MOH target)");
});

test("resolver honors an explicit inherited __CONNECT_MOH_SRC override first, but never sets it", () => {
  // Requirement 2: reuse an inherited marker; the explicit override is the
  // documented future extension hook. It must be read (as ${CONNECT_MOH_SRC})
  // BEFORE any classifier, and the installer must NEVER write __CONNECT_MOH_SRC
  // (that is the caller's job in a future Connect-owned context).
  const body = resolverBody();
  assert.match(body, /ExecIf\(\$\["\$\{CONNECT_MOH_SRC\}" != ""\]\?Set\(MOH_SRC=\$\{CONNECT_MOH_SRC\}\)\)/);
  assert.equal(/Set\(__CONNECT_MOH_SRC=/.test(SCRIPT), false, "installer must not SET __CONNECT_MOH_SRC — it is read-only here");
});

test("resolver classifies transfer ONLY from Asterisk-native BLINDTRANSFER/ATTENDEDTRANSFER, never __TRANSFERED_CALL", () => {
  // Regression guard for the June-2026 hardening finding: VitalPBX baseplan sets
  // __TRANSFERED_CALL=TRUE unconditionally on EVERY local extension dial
  // (extensions__20-baseplan.conf L217), so it is NOT a transfer signal — using
  // it starves inbound_direct/internal/ring-group/IVR (they would all bucket as
  // "transfer"). Transfer must be detected from the native transfer vars, which
  // are empty on normal calls.
  const body = resolverBody();
  assert.match(body, /Set\(MOH_SRC=transfer\)/);
  assert.match(body, /\$\["\$\{BLINDTRANSFER\}" != ""\]/);
  assert.match(body, /\$\["\$\{ATTENDEDTRANSFER\}" != ""\]/);
  // The hazard is READING the variable; the explanatory comment names it in prose.
  assert.equal(/\$\{__TRANSFERED_CALL\}/.test(body), false, "resolver must not READ ${__TRANSFERED_CALL} — it is TRUE on every local dial");
});

test("resolver source priority: transfer/ring-group/queue/ivr are classified before the __CALL_TYPE base classes", () => {
  // Ordering guarantee: an inbound call that fanned out through a ring group or
  // queue must resolve to inbound_ringgroup/inbound_queue, NOT inbound_direct,
  // even though __CALL_TYPE=2 for all of them. Assert the specific signals'
  // Set(MOH_SRC=...) lines all appear before the first CALL_TYPE-based line.
  const body = resolverBody();
  const idxTransfer = body.indexOf("Set(MOH_SRC=transfer)");
  const idxRg = body.indexOf("Set(MOH_SRC=inbound_ringgroup)");
  const idxQueue = body.indexOf("Set(MOH_SRC=inbound_queue)");
  const idxIvr = body.indexOf("Set(MOH_SRC=inbound_ivr)");
  const idxCallType = body.indexOf('$["${CALL_TYPE}" = "1"]');
  for (const [name, idx] of [["transfer", idxTransfer], ["ringgroup", idxRg], ["queue", idxQueue], ["ivr", idxIvr]] as const) {
    assert.ok(idx > -1, `expected ${name} classification present`);
    assert.ok(idx < idxCallType, `${name} must be classified before the __CALL_TYPE base classes`);
  }
});

test("installer only writes Connect-owned dialplan files, never VitalPBX-generated files", () => {
  // We write the new Connect-owned `__65` file and may add a sentinel #include
  // to Connect's already-loaded `__60_custom` file when this PBX does not
  // wildcard-load arbitrary `extensions__*.conf` files. We must not mutate
  // baseplan, tenant, trunk, musiconhold, queue, or parking generated files.
  assert.match(SCRIPT, /\/etc\/asterisk\/extensions__65_connect_tenant_moh\.conf/);
  assert.match(SCRIPT, /\/etc\/asterisk\/extensions__60_custom\.conf/);
  assert.match(SCRIPT, /#include extensions__65_connect_tenant_moh\.conf/);
  for (const banned of [
    "extensions__20-baseplan.conf",
    "extensions__40_",
    "extensions__50_",
    "musiconhold__",
  ]) {
    // Reading the path inside a comment is fine; mutating is not. Heuristic:
    // forbid the path appearing inside a `>`, `>>`, `mv`, `cp`, `sed`, `tee`,
    // `chown`, or `chmod` shell verb on the same line.
    const re = new RegExp(`(?:>|>>|\\bmv\\b|\\bcp\\b|\\bsed\\b|\\btee\\b|\\bchown\\b|\\bchmod\\b)[^\\n]*${banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    assert.equal(re.test(SCRIPT), false, `installer must not write/mutate ${banned}`);
  }
});

test("installer prints rollback instructions", () => {
  // Rollback block must appear in TWO forms in the operator-facing summary:
  // the preferred subcommand (`sudo $0 --rollback`) and the manual sed/rm
  // equivalent for break-glass scenarios. Both must reference the exact
  // include paths and reload BOTH dialplan and PJSIP. The PJSIP reload
  // command must be `module reload res_pjsip.so` (the canonical form),
  // NOT `pjsip reload` — the latter alias is missing on some VitalPBX /
  // Asterisk builds (verified 2026-05-10) and silently no-ops, leaving
  // PJSIP at its previous config.
  assert.match(SCRIPT, /Rollback \(preferred/);
  assert.match(SCRIPT, /sudo \$0 --rollback/);
  assert.match(SCRIPT, /Rollback \(manual equivalent, instant\):/);
  assert.match(SCRIPT, /sed -i '\/\^#include extensions__65_connect_tenant_moh\\\.conf\$\/d'/);
  assert.match(SCRIPT, /rm -f \/etc\/asterisk\/extensions__65_connect_tenant_moh\.conf/);
  assert.match(SCRIPT, /rm -f \/etc\/asterisk\/pjsip__65_connect_tenant_moh\.conf/);
  assert.match(SCRIPT, /asterisk -rx "dialplan reload"/);
  assert.match(SCRIPT, /asterisk -rx "module reload res_pjsip\.so"/);
});

test("installer is idempotent: backs up existing include before overwriting", () => {
  assert.match(SCRIPT, /BACKUP_FILE=/);
  assert.match(SCRIPT, /cp -a "\$DIALPLAN_FILE" "\$BACKUP_FILE"/);
});

test("installer verifies ALL static contexts loaded after dialplan reload, bridges through __60_custom if needed", () => {
  assert.match(SCRIPT, /dialplan show sub-connect-tenant-moh/);
  assert.match(SCRIPT, /dialplan show global-before-bridging-call-hook/);
  assert.match(SCRIPT, /dialplan show connect-tenant-moh-connect-shim/);
  // Verify result must require ALL THREE static contexts, not just two.
  assert.match(
    SCRIPT,
    /\[\[\s*\$resolver_ok\s*-eq\s*1\s*&&\s*\$hook_ok\s*-eq\s*1\s*&&\s*\$shim_ok\s*-eq\s*1\s*\]\]/,
  );
  assert.match(SCRIPT, /This VitalPBX install likely does not wildcard-include extensions__\*\.conf/);
  assert.match(SCRIPT, /sentinel include already present/);
  assert.match(SCRIPT, /added sentinel include to \$CUSTOM_FILE/);
  // Restore-backup-on-failure block must exist for both files.
  assert.match(SCRIPT, /Restoring include backup/);
  assert.match(SCRIPT, /Restoring custom dialplan backup/);
  assert.match(SCRIPT, /cp -a "\$BACKUP_FILE" "\$DIALPLAN_FILE"/);
});

test("installer verifies a sample per-tenant connect-leg context loaded when at least one was generated", () => {
  // After the static-context check, if PER_TENANT_COUNT > 0 the verifier
  // also samples the first generated T<id>_before-connecting-call-hook
  // and asserts it shows the expected include line.
  assert.match(SCRIPT, /PER_TENANT_COUNT:?-?0?\}\s*-gt\s*0/);
  assert.match(SCRIPT, /dialplan show T\$\{SAMPLE_TID\}_before-connecting-call-hook/);
  assert.match(SCRIPT, /Include =>\.\*connect-tenant-moh-connect-shim/);
});

// ============================================================================
// PJSIP caller-leg musicclass append tests
// ============================================================================
//
// The dialplan layer above only covers the called/trunk leg on this VitalPBX
// build (because [sub-before-connecting-call] is not invoked from the per-
// trunk caller dial path on outbound calls — verified 2026-05-10). The
// installer also writes a Connect-owned PJSIP include that uses Asterisk's
// `[name](+)` append syntax to add `set_var = CHANNEL(musicclass)=<class>`
// to each Connect-known tenant's T<id>_* extension endpoint, so the caller
// leg has the right musicclass at channel-creation time. Trunk endpoints
// are NEVER touched. Verification samples one endpoint after `pjsip reload`,
// rolling back the PJSIP include only (not the dialplan layer) on failure.

test("installer targets the Connect-owned PJSIP include path", () => {
  assert.match(SCRIPT, /PJSIP_FILE="\/etc\/asterisk\/pjsip__65_connect_tenant_moh\.conf"/);
  assert.match(SCRIPT, /PJSIP_BACKUP_FILE=/);
  assert.match(SCRIPT, /PJSIP_TMP_NEW=/);
});

test("installer enumerates only T<id>_* extension endpoints, never trunk endpoints", () => {
  // The endpoint list must come from `pjsip show endpoints` filtered to
  // names starting with "T<id>_". Trunk-style names (e.g. 344022_secro2)
  // must not match the post-grep anchor. The awk filter uses
  // `^[[:space:]]*Endpoint:[[:space:]]` because Asterisk's table output
  // indents every Endpoint: row with leading whitespace, and strips the
  // "/<auth>" suffix some builds emit before the grep filter runs.
  assert.match(SCRIPT, /asterisk -rx 'pjsip show endpoints'/);
  assert.match(
    SCRIPT,
    /awk '\/\^\[\[:space:\]\]\*Endpoint:\[\[:space:\]\]\/ \{n=\$2; sub\("\/\.\*", "", n\); print n\}'/,
  );
  assert.match(
    SCRIPT,
    /grep -E "\^T\$\{tid\}_\[A-Za-z0-9\._-\]\+\$"/,
  );
});

test("installer reads moh_class for each tenant from connect/pbx_tenant_map AstDB before generating set_var", () => {
  // The published moh_class is the source of truth for what to set on the
  // caller leg. Reading from AstDB (rather than re-deriving from slug)
  // keeps the PJSIP layer in lock-step with the dialplan resolver and the
  // Connect API publish.
  assert.match(SCRIPT, /database get connect\/pbx_tenant_map\/\$\{tid\} moh_class/);
  assert.match(SCRIPT, /database get connect\/pbx_tenant_map\/\$\{tid\} slug/);
  // Class must be a printable identifier (alnum, underscore, or dash) — anything
  // else gets skipped to keep arbitrary AstDB content from landing in pjsip.conf.
  assert.match(
    SCRIPT,
    /\$\{CLASS\/\/\[\^A-Za-z0-9_-\]\/\}/,
  );
});

test("installer emits [endpoint](+) append blocks with set_var = CHANNEL(musicclass)=$CLASS", () => {
  // Asterisk's `(+)` append syntax is what makes this safe — it adds a line
  // to the existing endpoint section without re-declaring it, so the
  // VitalPBX-generated endpoint config is preserved. The set_var line must
  // bind CHANNEL(musicclass) to the exact published class, NOT to a static
  // string and NOT to a slug.
  assert.match(SCRIPT, /\[\$\{ep\}\]\(\+\)/);
  assert.match(SCRIPT, /set_var = CHANNEL\(musicclass\)=\$\{CLASS\}/);
});

test("installer reloads PJSIP via pjsip_reload() helper, not the missing 'pjsip reload' alias", () => {
  // `pjsip reload` is missing on some VitalPBX / Asterisk builds
  // (verified 2026-05-10: the CLI returns "No such command 'pjsip
  // reload'" and silently leaves PJSIP at its previous config). The
  // installer must call pjsip_reload() — a tiny helper that prefers
  // `module reload res_pjsip.so` (the canonical form available since
  // Asterisk 12) and falls back to `core reload` only if that
  // alternative is also unknown.
  assert.match(SCRIPT, /PJSIP_RELOAD_OUT="\$\(pjsip_reload\)"/);
  // Verification reads the sample endpoint back and looks for either the
  // explicit set_var line or the resolved musicclass attribute (Asterisk
  // builds differ in how `pjsip show endpoint` renders set_var).
  assert.match(SCRIPT, /asterisk -rx "pjsip show endpoint \$\{PJSIP_SAMPLE_ENDPOINT\}"/);
  assert.match(
    SCRIPT,
    /set_var\[\[:space:\]\]\*\[:=\]\.\*CHANNEL\\\(musicclass\\\)=\$\{PJSIP_SAMPLE_CLASS\}/,
  );
});

test("pjsip_reload helper prefers module reload res_pjsip.so over the missing 'pjsip reload' alias", () => {
  // The helper exists, has a body, and uses the right form. We assert on
  // the function declaration plus the two key commands. Detection of
  // "command not found" is required so the helper falls back gracefully
  // instead of believing the reload happened.
  assert.match(SCRIPT, /\npjsip_reload\s*\(\)\s*\{/);
  const body = extractBashFunctionBody(SCRIPT, "pjsip_reload");
  assert.match(body, /asterisk -rx 'module reload res_pjsip\.so'/);
  assert.match(body, /no such command\|command not found/i);
  // Must NOT use the broken alias anywhere in the helper body.
  assert.equal(
    /asterisk -rx ['"]pjsip reload['"]/.test(body),
    false,
    "pjsip_reload must not call the missing 'pjsip reload' alias",
  );
});

test("installer never invokes the missing 'pjsip reload' CLI alias as an active reload command", () => {
  // The literal string `asterisk -rx "pjsip reload"` (or with single
  // quotes) must not appear as an executable line anywhere in the
  // script. It MAY still appear inside comments documenting the prior
  // form for readers who land here from old runbooks; we look only at
  // non-comment lines.
  const nonCommentLines = SCRIPT.split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.equal(
    /asterisk\s+-rx\s+["']pjsip reload["']/.test(nonCommentLines),
    false,
    "non-comment lines must not run `asterisk -rx \"pjsip reload\"`",
  );
});

test("installer rolls back the PJSIP include if sample endpoint verification fails", () => {
  // Rollback is PJSIP-only: the dialplan layer above is independently
  // verified loaded and continues to cover the trunk/called leg even if
  // the PJSIP append fails. Keep that scope tight in the rollback fn name
  // so future edits don't accidentally tear down the dialplan layer.
  assert.match(SCRIPT, /rollback_pjsip_and_warn\s*\(\)\s*\{/);
  assert.match(
    SCRIPT,
    /rollback_pjsip_and_warn\s+"PJSIP caller-leg musicclass verification failed for \$\{PJSIP_SAMPLE_ENDPOINT\}\."/,
  );
  // Rollback must restore the prior PJSIP include if there was one and
  // remove the new one if there wasn't, then reload PJSIP through the
  // pjsip_reload() helper (module-reload form) so Asterisk drops the
  // failed config even on builds where `pjsip reload` is missing.
  const rollbackBody = extractBashFunctionBody(SCRIPT, "rollback_pjsip_and_warn");
  assert.match(rollbackBody, /cp -a "\$PJSIP_BACKUP_FILE" "\$PJSIP_FILE"/);
  assert.match(rollbackBody, /rm -f "\$PJSIP_FILE"/);
  assert.match(rollbackBody, /pjsip_reload\s+>\/dev\/null 2>&1 \|\| true/);
  assert.equal(
    /asterisk -rx "pjsip reload"/.test(rollbackBody),
    false,
    "rollback_pjsip_and_warn must not call the missing 'pjsip reload' alias",
  );
});

test("installer skips PJSIP install entirely when AstDB has no Connect-known tenants", () => {
  // Same fail-safe shape as the dialplan per-tenant loop: don't write an
  // empty `pjsip__65_*.conf`, and warn loudly so the operator knows the
  // caller-leg layer is missing for this run.
  assert.match(
    SCRIPT,
    /No tenants in connect\/pbx_tenant_map AstDB family — skipping PJSIP caller-leg append/,
  );
  // Also fail-safe when tenants exist but no T<id>_* endpoints matched
  // (e.g. the build does not use that endpoint naming scheme).
  assert.match(
    SCRIPT,
    /No PJSIP T<id>_\* extension endpoints matched any Connect-known tenant — skipping PJSIP install/,
  );
});

test("installer never hardcodes a tenant id, slug, or moh class in the PJSIP heredoc body", () => {
  // The PJSIP append is generated entirely from AstDB at install time. The
  // static heredoc header that documents the file must not bake in any
  // tenant-specific value — same hard rule as the dialplan body.
  const m = SCRIPT.match(
    /\{[\r\n][^}]*?Connect tenant MOH — PJSIP caller-leg musicclass append[\s\S]*?\}\s*>\s*"\$PJSIP_TMP_NEW"/,
  );
  assert.ok(m, "could not locate PJSIP heredoc header generator block");
  const header = m[0].toLowerCase();
  for (const banned of [
    "secro",
    "landau",
    "fleetease",
    " moh3",
    " moh8",
    "t3_",
    "t21_",
    "344022_",
  ]) {
    assert.equal(
      header.indexOf(banned),
      -1,
      `PJSIP heredoc header must not hardcode ${JSON.stringify(banned)}`,
    );
  }
});

test("installer never writes to or mutates VitalPBX-generated PJSIP files", () => {
  // Same hard rule as the dialplan side: only Connect-owned `pjsip__65_*` is
  // written. We must not touch transports, AORs, registrations, templates,
  // or any other generated `pjsip__*.conf`.
  for (const banned of [
    "pjsip__40_",
    "pjsip__50_",
    "pjsip__60_",
    "pjsip__70_",
    "pjsip__90_",
    "pjsip_aors.conf",
    "pjsip_registrations.conf",
    "pjsip_endpoints.conf",
    "pjsip_transports.conf",
  ]) {
    const re = new RegExp(
      `(?:>|>>|\\bmv\\b|\\bcp\\b|\\bsed\\b|\\btee\\b|\\bchown\\b|\\bchmod\\b)[^\\n]*${banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "i",
    );
    assert.equal(
      re.test(SCRIPT),
      false,
      `installer must not write/mutate ${banned}`,
    );
  }
});

test("installer step numbering is consistent (8 numbered steps end-to-end)", () => {
  // Sanity check: the renumbered step labels run [1/8] through [8/8]. This
  // catches accidental drift if a future edit forgets to renumber a label.
  for (const n of ["1/8", "2/8", "3/8", "4/8", "5/8", "6/8", "7/8", "8/8"]) {
    assert.match(SCRIPT, new RegExp(`step "\\[${n.replace("/", "\\/")}\\]`));
  }
});

// ============================================================================
// Hardening: CLI mode dispatch (install / --check / --rollback / --help)
// ============================================================================
//
// The installer is the single operator entry point for the tenant MOH
// enforcement layer. Production hardening (2026-05) added three subcommands:
//
//   * default / install — original behavior, unchanged
//   * --check          — read-only health probe with PASS/FAIL per check
//   * --rollback       — Connect-owned-files-only uninstall + reload
//   * --help           — usage text + mode summary
//
// These tests assert the dispatch logic, the per-mode exit-behavior contract,
// and that --check is genuinely read-only (no file writes, no asterisk
// reloads, no AMI mutating commands). The shape of these subcommands is what
// on-call docs (DEBUGGING.md / DEPLOYMENT.md) point operators at, so any
// drift here is a doc-and-tooling bug.

// Helper: extract the body of a named bash function (between `name() {` and
// the matching closing `}` at column 0). Used to scope assertions to one
// function instead of the whole script — important for "--check is
// read-only" because the installer body absolutely does write files and
// reload asterisk; we just need to prove the health-check path doesn't.
function extractBashFunctionBody(script: string, name: string): string {
  const openRe = new RegExp(`(^|\\n)${name}\\s*\\(\\)\\s*\\{`);
  const openMatch = script.match(openRe);
  assert.ok(openMatch, `function ${name}() not found`);
  const start = openMatch.index! + openMatch[0].length;
  // Find the next line beginning with "}" — the closing brace of the function.
  const after = script.slice(start);
  const closeRe = /\n\}\s*(\n|$)/;
  const closeMatch = after.match(closeRe);
  assert.ok(closeMatch, `closing brace for ${name}() not found`);
  return after.slice(0, closeMatch.index!);
}

test("installer parses --help / --check / --rollback / unknown modes before any preflight", () => {
  // Mode dispatch must happen BEFORE the [[ $EUID -eq 0 ]] preflight or any
  // file path init so --help works as a non-root user and unknown modes
  // exit with EX_USAGE (64) rather than crashing inside an asterisk call.
  const modeBlockMatch = SCRIPT.match(/MODE="install"\s*\ncase "\$\{1:-\}"[\s\S]*?esac/);
  assert.ok(modeBlockMatch, "MODE dispatch case-block not found near top of script");
  const modeBlock = modeBlockMatch[0];
  // All four canonical mode aliases must be present.
  assert.match(modeBlock, /""\|install\)/);
  assert.match(modeBlock, /-h\|--help\|help\)/);
  assert.match(modeBlock, /--check\|-n\|--dry-run\|check\)/);
  assert.match(modeBlock, /--rollback\|--uninstall\|rollback\|uninstall\)/);
  // Unknown mode must exit 64 (EX_USAGE).
  assert.match(modeBlock, /exit 64/);
});

test("--help prints usage covering all four modes and exits 0 before preflight", () => {
  // Help text must list every mode by name so on-call operators have a
  // single self-documenting source of truth.
  const helpMatch = SCRIPT.match(/if \[\[\s*"\$MODE"\s*=\s*"help"\s*\]\];\s*then[\s\S]*?exit 0\s*\nfi/);
  assert.ok(helpMatch, "help block not found");
  const helpBody = helpMatch[0];
  assert.match(helpBody, /\binstall\b/i);
  assert.match(helpBody, /--check/);
  assert.match(helpBody, /--rollback/);
  assert.match(helpBody, /--help/);
  // Help must mention all five hardening checks so on-call has the shape of
  // what --check covers without reading the source.
  assert.match(helpBody, /dialplan include/i);
  assert.match(helpBody, /resolver \+ global hook \+ shim/i);
  assert.match(helpBody, /PJSIP include/i);
  assert.match(helpBody, /sample[\s\S]*?endpoint[\s\S]*?CHANNEL\(musicclass\)/i);
  assert.match(helpBody, /reverse-map.*tenant/i);
});

test("mode dispatch routes check -> do_health_check, rollback -> do_rollback, install falls through", () => {
  // The dispatch case at the bottom of the helper-functions block decides
  // which subcommand body to enter. install MUST be the only mode that
  // falls through to the existing step-by-step body below it.
  const dispatchMatch = SCRIPT.match(/case "\$MODE" in\s*\n\s*check\)[\s\S]*?install\)[\s\S]*?esac/);
  assert.ok(dispatchMatch, "mode dispatch block not found");
  const dispatch = dispatchMatch[0];
  assert.match(dispatch, /check\)\s*\n\s*do_health_check\s*\n\s*exit \$\?/);
  assert.match(dispatch, /rollback\)\s*\n\s*do_rollback\s*\n\s*exit \$\?/);
  assert.match(dispatch, /install\)\s*\n\s*:\s*#\s*fall through/);
});

// ============================================================================
// --check (health-check) — read-only contract + 5-check coverage
// ============================================================================

test("do_health_check is defined", () => {
  assert.match(SCRIPT, /\ndo_health_check\s*\(\)\s*\{/);
});

// Strip bash-style comment lines before scanning a function body for write
// operations. Comments may legitimately use characters like `>` or `rm` in
// English prose (e.g. "remove file") which we don't want to false-positive.
function stripBashComments(body: string): string {
  return body
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? "" : line))
    .join("\n");
}

test("do_health_check is genuinely read-only — no file writes, no asterisk reloads", () => {
  const body = stripBashComments(extractBashFunctionBody(SCRIPT, "do_health_check"));
  // No file mutation. We forbid common write verbs anywhere in the function.
  // This catches accidental "while I'm here" additions like writing a
  // status file or mutating extensions__60_custom.conf during the probe.
  const forbidden: { pattern: RegExp; description: string }[] = [
    { pattern: /\brm\s+-/, description: "rm" },
    { pattern: /\bmv\s+/, description: "mv" },
    { pattern: /\bcp\s+/, description: "cp" },
    { pattern: /\bsed\s+-i\b/, description: "sed -i (in-place edit)" },
    { pattern: /\btee\s+/, description: "tee" },
    { pattern: /\bchown\s+/, description: "chown" },
    { pattern: /\bchmod\s+/, description: "chmod" },
    // Output redirection that writes to a file (not /dev/null, not stderr).
    { pattern: /(?<![&\d])>(?!\s*[&|]|\s*\/dev\/null|\s*\/dev\/stderr|\s*&[12])/, description: "redirect to file" },
    { pattern: />>\s+/, description: "append redirect" },
    // Asterisk mutating verbs. Allowed: "show", "get". Disallowed: anything
    // that changes runtime state.
    { pattern: /asterisk\s+-rx[^\n]*\b(reload|restart|stop|database\s+(put|del|deltree))\b/i, description: "asterisk mutating CLI verb" },
    // AMI DBPut should never appear in --check.
    { pattern: /\bDBPut\b/, description: "AMI DBPut" },
  ];
  for (const f of forbidden) {
    assert.equal(
      f.pattern.test(body),
      false,
      `do_health_check must not contain ${f.description} (matched: ${(body.match(f.pattern) || [""])[0]})`,
    );
  }
});

test("do_health_check probes all five hardening conditions", () => {
  const body = extractBashFunctionBody(SCRIPT, "do_health_check");
  // 1. dialplan include file present
  assert.match(body, /\[\[\s+-f\s+"\$DIALPLAN_FILE"\s+\]\]/);
  // 2. resolver + global hook + shim contexts loaded — uses the same three
  //    sentinel strings as the install verifier.
  assert.match(body, /sub-connect-tenant-moh\|Connect tenant MOH resolver/);
  assert.match(body, /global-before-bridging-call-hook\|Connect global before-bridging hook/);
  assert.match(body, /connect-tenant-moh-connect-shim\|Connect tenant MOH connect-leg shim/);
  // 3. PJSIP include file present
  assert.match(body, /\[\[\s+-f\s+"\$PJSIP_FILE"\s+\]\]/);
  // 4. AstDB reverse-map has at least one tenant — same parser as install.
  assert.match(body, /database show connect\/pbx_tenant_map/);
  assert.match(body, /awk -F'\/'[^\n]*'\/\^\\\/connect\\\/pbx_tenant_map\\\/\/\{print \$4\}'/);
  // 5. sample endpoint carries CHANNEL(musicclass)
  assert.match(body, /pjsip show endpoint /);
  assert.match(body, /CHANNEL\\\(musicclass\\\)=\$\{sample_class\}/);
});

test("do_health_check prints PASS/FAIL per check and a structured RESULT line", () => {
  const body = extractBashFunctionBody(SCRIPT, "do_health_check");
  // Per-check status uses `[PASS]` / `[FAIL]` prefixes so output is grep-able.
  assert.match(body, /\[PASS\]/);
  assert.match(body, /\[FAIL\]/);
  // Final summary uses a single `RESULT:` line so monitoring can grep it.
  assert.match(body, /RESULT: PASS \(%s\/%s checks healthy\)/);
  assert.match(body, /RESULT: FAIL \(%s\/%s checks failed\)/);
  // PASS path returns 0, FAIL path returns non-zero.
  assert.match(body, /return 0/);
  assert.match(body, /return 1/);
});

// ============================================================================
// --rollback — Connect-owned-files-only uninstall
// ============================================================================

test("do_rollback is defined", () => {
  assert.match(SCRIPT, /\ndo_rollback\s*\(\)\s*\{/);
});

test("do_rollback removes ONLY Connect-owned files + sentinel include line", () => {
  const body = extractBashFunctionBody(SCRIPT, "do_rollback");
  // The three (and only three) Connect-authored files / line that may be removed.
  assert.match(body, /rm -f "\$DIALPLAN_FILE"/);
  assert.match(body, /rm -f "\$PJSIP_FILE"/);
  assert.match(
    body,
    /sed -i '\/\^#include extensions__65_connect_tenant_moh\\\.conf\$\/d' "\$CUSTOM_FILE"/,
  );
  // Must back up the custom file before mutating its sentinel line.
  // Backup path is built into a local var first, so two-line shape:
  //   custom_rollback_backup="${CUSTOM_FILE}.bak.connect-rollback.<ts>"
  //   cp -a "$CUSTOM_FILE" "$custom_rollback_backup"
  assert.match(body, /custom_rollback_backup="\$\{CUSTOM_FILE\}\.bak\.connect-rollback\./);
  assert.match(body, /cp -a "\$CUSTOM_FILE" "\$custom_rollback_backup"/);
  // Hard rule: no other VitalPBX-generated file may be touched here. We
  // forbid the same path families the install-side hard rule forbids.
  for (const banned of [
    "extensions__20-baseplan.conf",
    "extensions__40_",
    "extensions__50_",
    "musiconhold__",
    "pjsip__40_",
    "pjsip__50_",
    "pjsip__60_",
    "pjsip__70_",
    "pjsip__90_",
    "pjsip_endpoints.conf",
    "pjsip_aors.conf",
  ]) {
    const re = new RegExp(
      `(?:>|>>|\\bmv\\b|\\bcp\\b|\\bsed\\b|\\btee\\b|\\bchown\\b|\\bchmod\\b|\\brm\\b)[^\\n]*${banned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "i",
    );
    assert.equal(re.test(body), false, `rollback must not touch ${banned}`);
  }
});

test("do_rollback reloads BOTH dialplan and pjsip via pjsip_reload helper", () => {
  const body = extractBashFunctionBody(SCRIPT, "do_rollback");
  assert.match(body, /asterisk -rx "dialplan reload"/);
  // PJSIP reload goes through the helper (which uses
  // `module reload res_pjsip.so`), NOT the broken `pjsip reload` alias.
  assert.match(body, /pjsip_reload\s+>\/dev\/null/);
  // Negative: rollback must not call the broken alias directly.
  assert.equal(
    /asterisk -rx "pjsip reload"/.test(body),
    false,
    "do_rollback must not call the missing 'pjsip reload' alias",
  );
});

test("do_rollback verifies the resolver is no longer loaded after reload", () => {
  const body = extractBashFunctionBody(SCRIPT, "do_rollback");
  // The post-reload check uses the same sentinel string the install-time
  // verifier looks for (`Connect tenant MOH resolver`). If still present
  // after dialplan reload, the script must WARN (not fail) so operators
  // can investigate without the rollback appearing to error out.
  assert.match(body, /dialplan show sub-connect-tenant-moh/);
  assert.match(body, /Connect tenant MOH resolver/);
  assert.match(body, /\[WARN\]/);
});

test("do_rollback prints a structured RESULT line and is idempotent on already-uninstalled hosts", () => {
  const body = extractBashFunctionBody(SCRIPT, "do_rollback");
  assert.match(body, /RESULT: rollback complete/);
  // Idempotency: the script tracks `[REMOVE]` vs `[SKIP]` per file so a
  // double-run prints all three as `[SKIP]` and still succeeds.
  assert.match(body, /\[REMOVE\]/);
  assert.match(body, /\[SKIP\]/);
});

// ============================================================================
// Install summary — skipped-tenant rollup
// ============================================================================

test("install loop appends to SKIPPED_TENANTS when a tenant cannot be covered", () => {
  // Two reasons the PJSIP loop currently skips a tenant. Both must produce
  // an entry in SKIPPED_TENANTS so the end-of-run rollup tells the operator
  // exactly what to fix (rather than silently shipping partial coverage).
  assert.match(
    SCRIPT,
    /SKIPPED_TENANTS\+=\("T\$\{tid\}: missing or non-printable moh_class[^"]*"\)/,
  );
  assert.match(
    SCRIPT,
    /SKIPPED_TENANTS\+=\("T\$\{tid\}: no PJSIP endpoints matched \^T\$\{tid\}_[^"]*"\)/,
  );
});

test("install summary block prints the skipped-tenants rollup before INSTALL COMPLETE", () => {
  // The rollup sits between the AstDB smoke output and the heredoc summary
  // so it appears in operator scrollback right next to the `INSTALL
  // COMPLETE` banner.
  assert.match(SCRIPT, /Skipped tenants this run \(%s\):/);
  assert.match(
    SCRIPT,
    /for s in "\$\{SKIPPED_TENANTS\[@\]\}"; do\s*\n\s+printf\s+'\s*-\s+%s\\n'\s+"\$s"/,
  );
  // The DONE heredoc must reference the skipped count so the final block
  // is self-contained for log-capture / paste-into-incident-ticket.
  assert.match(SCRIPT, /Tenants skipped \(and why\): \$\{SKIPPED_COUNT\}/);
});

test("install summary points operators at --check and --rollback as the supported modes", () => {
  // The DONE heredoc must surface the supported subcommands so the operator
  // running the install in production sees them in the same scrollback.
  assert.match(SCRIPT, /Health check \(read-only/);
  assert.match(SCRIPT, /sudo \$0 --check/);
  assert.match(SCRIPT, /Rollback \(preferred/);
  assert.match(SCRIPT, /sudo \$0 --rollback/);
});
