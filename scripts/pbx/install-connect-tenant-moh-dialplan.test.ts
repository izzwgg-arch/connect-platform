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
  // Rollback block must appear and must use the exact include path + reload.
  assert.match(SCRIPT, /Rollback \(instant\):/);
  assert.match(SCRIPT, /sed -i '\/\^#include extensions__65_connect_tenant_moh\\\.conf\$\/d'/);
  assert.match(SCRIPT, /rm -f \/etc\/asterisk\/extensions__65_connect_tenant_moh\.conf/);
  assert.match(SCRIPT, /asterisk -rx "dialplan reload"/);
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
