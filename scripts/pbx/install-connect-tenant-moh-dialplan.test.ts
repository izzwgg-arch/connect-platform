// String-shape regression tests for the Connect tenant MOH dialplan installer.
//
// We do NOT run the installer in CI (it would require root, asterisk, and a
// VitalPBX host). Instead we assert the installer file embeds the contracts
// the design depends on:
//
//   * Both required Asterisk contexts are defined.
//   * The hook calls our resolver with the agnostic IF()-Set wrapper.
//   * The resolver normalizes "T3" → "3", reads the reverse map, and falls
//     back to active_moh_class.
//   * The resolver Sets CHANNEL(musicclass) and the inheritable __CONNECT_MOH.
//   * No tenant or MOH class is hardcoded.
//   * The installer prints rollback instructions and never edits VitalPBX-
//     generated files.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = join(__dirname, "install-connect-tenant-moh-dialplan.sh");
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");

test("installer defines both required Asterisk contexts", () => {
  assert.match(SCRIPT, /\[sub-connect-tenant-moh\]/, "missing [sub-connect-tenant-moh] context header");
  assert.match(SCRIPT, /\[global-before-bridging-call-hook\]/, "missing [global-before-bridging-call-hook] context header");
});

test("global-before-bridging-call-hook uses argument-mode-agnostic IF() wrapper", () => {
  // Approved exact wrapper shape: ARG1/ARG2/ARG3 falling back to TENANT/CALLER/CALLEE channel vars.
  assert.match(SCRIPT, /Set\(T=\$\{IF\(\$\["\$\{ARG1\}" != ""\]\?\$\{ARG1\}:\$\{TENANT\}\)\}\)/);
  assert.match(SCRIPT, /Set\(FROM=\$\{IF\(\$\["\$\{ARG2\}" != ""\]\?\$\{ARG2\}:\$\{CALLER\}\)\}\)/);
  assert.match(SCRIPT, /Set\(TO=\$\{IF\(\$\["\$\{ARG3\}" != ""\]\?\$\{ARG3\}:\$\{CALLEE\}\)\}\)/);
  assert.match(SCRIPT, /Gosub\(sub-connect-tenant-moh,s,1\(\$\{T\},\$\{FROM\},\$\{TO\}\)\)/);
});

test("resolver normalizes T<N> tenant prefix to numeric id", () => {
  assert.match(
    SCRIPT,
    /Set\(TENANT_ID=\$\{IF\(\$\["\$\{TENANT_RAW:0:1\}" = "T"\]\?\$\{TENANT_RAW:1\}:\$\{TENANT_RAW\}\)\}\)/,
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
  // Three guards: empty TENANT_RAW, empty resolved slug, empty resolved class.
  assert.match(SCRIPT, /GotoIf\(\$\["\$\{TENANT_RAW\}" = ""\]\?done\)/);
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

test("installer never edits VitalPBX-generated extensions__*.conf files", () => {
  // We only ever write extensions__65_connect_tenant_moh.conf. We must not
  // mutate baseplan or any other generated file.
  assert.match(SCRIPT, /\/etc\/asterisk\/extensions__65_connect_tenant_moh\.conf/);
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
  assert.match(SCRIPT, /rm -f \/etc\/asterisk\/extensions__65_connect_tenant_moh\.conf/);
  assert.match(SCRIPT, /asterisk -rx "dialplan reload"/);
});

test("installer is idempotent: backs up existing include before overwriting", () => {
  assert.match(SCRIPT, /BACKUP_FILE=/);
  assert.match(SCRIPT, /cp -a "\$DIALPLAN_FILE" "\$BACKUP_FILE"/);
});

test("installer verifies BOTH contexts loaded after dialplan reload, otherwise restores backup", () => {
  assert.match(SCRIPT, /dialplan show sub-connect-tenant-moh/);
  assert.match(SCRIPT, /dialplan show global-before-bridging-call-hook/);
  // Restore-backup-on-failure block must exist.
  assert.match(SCRIPT, /Restoring backup/);
  assert.match(SCRIPT, /cp -a "\$BACKUP_FILE" "\$DIALPLAN_FILE"/);
});
