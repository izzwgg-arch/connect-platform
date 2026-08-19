// Phase B + C regression coverage for the PBX helper installer.
//
// The helper installer ships the dispatch + record dialplan body in TWO
// places that MUST stay in sync: the in-Python `CONNECT_VM_DIALPLAN_BODY`
// constant (used at helper boot to materialize the dialplan if the file
// is missing) and the bash heredoc that writes `${DIALPLAN_TARGET}` at
// install time. If either drifts, the installed dialplan and the helper's
// self-heal will diverge. We therefore assert the Phase B/C invariants
// twice (once per copy) on the same script file.
//
// We deliberately do NOT spin up Asterisk, MySQL, or systemd here — this
// is a string-shape test on the installer file, not an integration test.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = join(__dirname, "install-vitalpbx-inbound-route-helper.sh");
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

// ── Phase B: helper Python no longer overrides channel to direct PJSIP ────

test("helper installer no longer assigns direct_pjsip channel_source", () => {
  // The override block was on a single line `channel_source = "direct_pjsip:" + hint_raw`.
  // Phase B removed that assignment. Allow the string `direct_pjsip:` to appear in
  // comments / log lines but assert the assignment form is gone.
  assert.equal(
    countOccurrences(SCRIPT, "channel_source = \"direct_pjsip:"),
    0,
    "the direct_pjsip override assignment must not exist after Phase B",
  );
  assert.equal(
    countOccurrences(SCRIPT, "channel = \"PJSIP/\" + hint_raw"),
    0,
    "the direct PJSIP channel override line must not exist after Phase B",
  );
});

// ── Phase B: dispatch context dials with U(...) Gosub on answered party ───

test("helper installer dispatch dialplan calls Gosub via Dial U() with CONNECT_VM_CONTEXT — TWICE (Python const + bash heredoc)", () => {
  // Phase C: ARG1 is now the resolved voicemail context (CONNECT_VM_CONTEXT),
  // not the raw numeric tenant id (CONNECT_VM_TENANT). This ensures the
  // recording is written to the correct spool path (e.g. test-voicemail/101/).
  const dialU = "Dial(${CONNECT_VM_DIAL},30,U(connect-vm-greeting-record-sub^s^1^${CONNECT_VM_CONTEXT}^${CONNECT_VM_EXT}^${CONNECT_VM_FILE}))";
  assert.equal(
    countOccurrences(SCRIPT, dialU),
    2,
    "Dial(...,U(connect-vm-greeting-record-sub^s^1^${CONNECT_VM_CONTEXT}^...)) must appear exactly twice (Python const + bash heredoc)",
  );
});

test("helper installer dispatch dialplan no longer passes raw CONNECT_VM_TENANT as Gosub ARG1", () => {
  // The old Phase B form passed ${CONNECT_VM_TENANT} as ARG1.
  // Phase C replaces it with ${CONNECT_VM_CONTEXT} (the resolved context name).
  const oldDialU = "Dial(${CONNECT_VM_DIAL},30,U(connect-vm-greeting-record-sub^s^1^${CONNECT_VM_TENANT}^${CONNECT_VM_EXT}^${CONNECT_VM_FILE}))";
  assert.equal(
    countOccurrences(SCRIPT, oldDialU),
    0,
    "old Phase B Dial() form passing CONNECT_VM_TENANT as ARG1 must not exist after Phase C",
  );
});

test("helper installer defines the post-answer subroutine context — TWICE", () => {
  assert.equal(
    countOccurrences(SCRIPT, "[connect-vm-greeting-record-sub]"),
    2,
    "[connect-vm-greeting-record-sub] context must appear exactly twice (Python const + bash heredoc)",
  );
});

test("helper installer keeps the legacy [connect-vm-greeting-record] context for back-compat — TWICE", () => {
  assert.equal(
    countOccurrences(SCRIPT, "[connect-vm-greeting-record]"),
    2,
    "[connect-vm-greeting-record] legacy context must still be present (Python const + bash heredoc)",
  );
});

// ── Phase B: improved CallerID identity for vm-record originates ──────────

test("helper installer sets CALLERID(name)=Voicemail Greeting Recording in dispatch — TWICE", () => {
  assert.equal(
    countOccurrences(SCRIPT, "Set(CALLERID(name)=Voicemail Greeting Recording)"),
    2,
    "CALLERID(name)=Voicemail Greeting Recording must appear exactly twice (Python const + bash heredoc)",
  );
});

test("helper installer sets CALLERID(num)=${CONNECT_VM_EXT} in dispatch — TWICE", () => {
  assert.equal(
    countOccurrences(SCRIPT, "Set(CALLERID(num)=${CONNECT_VM_EXT})"),
    2,
    "CALLERID(num)=${CONNECT_VM_EXT} must appear exactly twice (Python const + bash heredoc)",
  );
});

// ── Phase B: AstDB fan-out + dispatch-only originate ──────────────────────

test("helper installer still populates AstDB connect_vm_dial fan-out", () => {
  assert.match(SCRIPT, /database put connect_vm_dial /);
  assert.match(SCRIPT, /channel_source = "dispatch_local:"/);
});

test("helper installer keeps Local/.../connect-vm-greeting-dispatch/n as the default channel template", () => {
  assert.match(
    SCRIPT,
    /Local\/\{recordingExten\}@connect-vm-greeting-dispatch\/n/,
    "the default originate channel template must remain dispatch-based",
  );
});

// ── Phase B: VERSION bump so /health surfaces post-deploy ────────────────

test("helper installer VERSION reflects Phase B build", () => {
  const m = SCRIPT.match(/^VERSION\s*=\s*"([^"]+)"/m);
  assert.ok(m, "VERSION constant must exist in the Python helper");
  const v = m![1];
  assert.ok(
    v.startsWith("2026.05.07") || v.localeCompare("2026.05.07") >= 0,
    "VERSION must be at or after the Phase B cut (2026.05.07.x), got " + v,
  );
});

// ── Phase C: voicemail context resolution (fix wrong spool path) ──────────

test("helper installer defines resolve_voicemail_context_from_conf Python function", () => {
  assert.match(
    SCRIPT,
    /def resolve_voicemail_context_from_conf\(/,
    "resolve_voicemail_context_from_conf() must be defined in the Python helper",
  );
});

test("helper installer reads voicemail__50-<N>-main.conf to resolve context", () => {
  assert.match(
    SCRIPT,
    /voicemail__50.*main\.conf/,
    "installer must reference the VitalPBX voicemail conf filename pattern",
  );
});

test("helper installer populates AstDB connect_vm_context key in vm_record_call", () => {
  assert.match(
    SCRIPT,
    /database put connect_vm_context /,
    "vm_record_call must write the resolved voicemail context into AstDB connect_vm_context",
  );
});

test("helper installer dispatch reads CONNECT_VM_CONTEXT from AstDB — TWICE (Python const + bash heredoc)", () => {
  const lookup = "Set(CONNECT_VM_CONTEXT=${DB(connect_vm_context/T${CONNECT_VM_TENANT}_${CONNECT_VM_EXT})})";
  assert.equal(
    countOccurrences(SCRIPT, lookup),
    // dispatch context + legacy context = 4 total (2 copies × 2 contexts)
    4,
    "CONNECT_VM_CONTEXT AstDB lookup must appear in both dispatch and legacy contexts, in both Python const and bash heredoc (4 total)",
  );
});

test("helper installer record-sub uses CONNECT_VM_CONTEXT in spool path — TWICE (Python const + bash heredoc)", () => {
  const pathLine = "Set(CONNECT_VM_PATH=/var/spool/asterisk/voicemail/${CONNECT_VM_CONTEXT}/${CONNECT_VM_EXT}/${CONNECT_VM_FILE}.wav)";
  assert.equal(
    countOccurrences(SCRIPT, pathLine),
    // record-sub + legacy context = 4 total (2 copies × 2 contexts)
    4,
    "CONNECT_VM_PATH must use CONNECT_VM_CONTEXT (not CONNECT_VM_TENANT) in both subroutine and legacy context, in both copies (4 total)",
  );
});

test("helper installer record-sub no longer uses CONNECT_VM_TENANT in spool path", () => {
  const oldPathLine = "Set(CONNECT_VM_PATH=/var/spool/asterisk/voicemail/${CONNECT_VM_TENANT}/${CONNECT_VM_EXT}/${CONNECT_VM_FILE}.wav)";
  assert.equal(
    countOccurrences(SCRIPT, oldPathLine),
    0,
    "old CONNECT_VM_TENANT-based CONNECT_VM_PATH must not exist after Phase C",
  );
});

test("helper installer dispatch includes fallback: if CONNECT_VM_CONTEXT empty use CONNECT_VM_TENANT — TWICE", () => {
  const fallback = "Set(CONNECT_VM_CONTEXT=${CONNECT_VM_TENANT})";
  assert.equal(
    countOccurrences(SCRIPT, fallback),
    // dispatch + legacy = 4 total (2 copies × 2 contexts)
    4,
    "CONNECT_VM_CONTEXT fallback to CONNECT_VM_TENANT must appear in both dispatch and legacy contexts in both copies (4 total)",
  );
});

test("helper installer voicemail_mailbox_dir calls resolve_voicemail_context_from_conf", () => {
  // Both functions must exist and resolve_voicemail_context_from_conf must
  // be called somewhere inside the voicemail_mailbox_dir function body.
  // We verify by finding them in the expected order within 800 characters.
  assert.match(
    SCRIPT,
    /def voicemail_mailbox_dir[\s\S]{0,800}resolve_voicemail_context_from_conf/,
    "voicemail_mailbox_dir must call resolve_voicemail_context_from_conf to get the primary candidate directory",
  );
});

test("helper installer VERSION reflects Phase C build (2026.05.07.2 or later)", () => {
  const m = SCRIPT.match(/^VERSION\s*=\s*"([^"]+)"/m);
  assert.ok(m, "VERSION constant must exist");
  const v = m![1];
  assert.ok(
    v.localeCompare("2026.05.07.2") >= 0,
    "VERSION must be at or after Phase C cut (2026.05.07.2), got " + v,
  );
});

test("helper installer registers read-only voicemail spool list endpoint", () => {
  assert.match(
    SCRIPT,
    /"\/voicemail\/spool\/list"\s*:\s*vm_spool_list_messages/,
    "POST actions must include /voicemail/spool/list → vm_spool_list_messages",
  );
  assert.match(SCRIPT, /def vm_spool_list_messages/, "vm_spool_list_messages must be defined");
  assert.match(SCRIPT, /spoolListSchema/, "spool list must expose schema + pagination metadata");
  assert.match(SCRIPT, /maxOrigtimeAll/, "spool list must report max origtime across full scan");
  assert.match(SCRIPT, /origtime_desc/, "spool list must sort newest-first by origtime");
});

test("helper installer defines Phase 2 voicemail spool audio endpoint and validation", () => {
  assert.match(
    SCRIPT,
    /path == "\/voicemail\/spool\/audio"/,
    "do_POST must branch for POST /voicemail/spool/audio (binary response)",
  );
  assert.match(SCRIPT, /def vm_spool_read_audio\(/, "vm_spool_read_audio must be defined");
  assert.match(SCRIPT, /VM_SPOOL_AUDIO_FOLDERS/, "spool audio must use folder allowlist");
  assert.match(SCRIPT, /MSG_NUM_STEM_RE/, "spool audio must validate msg stem");
  assert.match(SCRIPT, /MAX_VM_SPOOL_AUDIO_BYTES/, "spool audio must cap read size");
});

// ── X5 (2026-07-26): full MOH convergence in /sync-tenant-moh ──────────────
// Root cause (live call C-0000319b): the generated tenant dialplan hard-codes
// each object's MOH class as Gosub(sub-set-moh,s,1(<class>,YES)), which sets
// CHANNEL(musicclass) and beats queues.conf + AstDB. sync-tenant-moh must
// therefore also patch the dialplan, converge per-queue/per-extension AstDB
// keys, and update EVERY MOH-bearing DB table — not just inbound/ext/queues.

test("X5: helper patches hard-coded sub-set-moh classes in the generated tenant dialplan", () => {
  assert.match(SCRIPT, /def _patch_dialplan_moh_text\(/, "_patch_dialplan_moh_text must be defined");
  assert.match(SCRIPT, /def patch_tenant_dialplan_moh\(/, "patch_tenant_dialplan_moh must be defined");
  assert.match(
    SCRIPT,
    /extensions__50-%d-dialplan\.conf/,
    "dialplan patch must target the per-tenant generated dialplan file",
  );
  assert.match(
    SCRIPT,
    /sub-set-moh,s,1\\\(/,
    "dialplan patch must match the sub-set-moh Gosub form",
  );
});

test("X5: dialplan patch rewrites only music-class tokens (never ringback)", () => {
  assert.match(
    SCRIPT,
    /DIALPLAN_MOH_TOKEN\s*=\s*r"\(\?:default\|moh\\d\+\|connect_\[A-Za-z0-9_\]\+\)"/,
    "the token allowlist must cover default|mohN|connect_* and nothing else",
  );
});

test("X5: sync_tenant_moh updates every MOH-bearing table and excludes ombu_music_groups", () => {
  assert.match(SCRIPT, /def moh_bearing_tables\(/, "moh_bearing_tables must be defined");
  assert.match(
    SCRIPT,
    /MOH_TABLE_EXCLUDE\s*=\s*\{"ombu_music_groups"\}/,
    "the music-groups meta-table must be excluded from the bulk update",
  );
  assert.match(
    SCRIPT,
    /def sync_tenant_moh\(body\):[\s\S]{0,3000}moh_bearing_tables\(conn\)/,
    "sync_tenant_moh must iterate moh_bearing_tables",
  );
});

test("X5: sync_tenant_moh converges dialplan + AstDB and reports evidence", () => {
  assert.match(
    SCRIPT,
    /def sync_tenant_moh\(body\):[\s\S]{0,6000}patch_tenant_dialplan_moh\(tenant_id, music_group_id\)/,
    "sync_tenant_moh must call patch_tenant_dialplan_moh",
  );
  assert.match(
    SCRIPT,
    /def sync_tenant_moh\(body\):[\s\S]{0,6000}sync_tenant_moh_astdb\(tenant_id, music_group_id, queue_table\)/,
    "sync_tenant_moh must call sync_tenant_moh_astdb",
  );
  assert.match(SCRIPT, /"dialplanPatch": dialplan_patch/, "response must expose dialplanPatch evidence");
  assert.match(SCRIPT, /"astdbSync": astdb_sync/, "response must expose astdbSync evidence");
  assert.match(SCRIPT, /"tables": table_results/, "response must expose per-table update evidence");
});

test("X5: VERSION reflects the 2026-07-26 build or later", () => {
  const m = SCRIPT.match(/^VERSION\s*=\s*"([^"]+)"/m);
  assert.ok(m, "VERSION constant must exist");
  assert.ok(
    m![1].localeCompare("2026.07.26.1") >= 0,
    "VERSION must be at or after the X5 cut (2026.07.26.1), got " + m![1],
  );
});

// ── 2026-08-06: regen must hand tenant confs back to the GUI ──────────────
// apply_tenant_changes (the official per-tenant regen) rewrites
// extensions__50-<t>-dialplan.conf / queues__50-<t>-main.conf as
// asterisk:asterisk, but the VitalPBX GUI writes them as www-data — so every
// panel Save/Apply after a helper-triggered regen crashed with
// file_put_contents(...) Permission denied in OmbuSystemConf.php (verified
// live on tenants 2 and 35, 2026-08-05). The helper must chown the
// regenerated files back to www-data:www-data 0644, non-fatally.

const HELPER_PATH = join(__dirname, "vitalpbx-inbound-route-helper.py");
const HELPER = readFileSync(HELPER_PATH, "utf8");

test("ownership: GUI conf ownership constants and restore function exist", () => {
  for (const src of [SCRIPT, HELPER]) {
    assert.match(src, /GUI_CONF_OWNER_USER = "www-data"/);
    assert.match(src, /GUI_CONF_OWNER_GROUP = "www-data"/);
    assert.match(src, /GUI_CONF_MODE = 0o644/);
    assert.match(src, /def _chown_gui_conf\(path\):/);
    assert.match(src, /def restore_gui_conf_ownership\(tenant_id\):/);
  }
});

test("ownership: restore_gui_conf_ownership covers both tenant conf files", () => {
  assert.match(
    HELPER,
    /def restore_gui_conf_ownership\(tenant_id\):[\s\S]{0,1500}extensions__50-%d-dialplan\.conf[\s\S]{0,300}queues__50-%d-main\.conf/,
    "restore_gui_conf_ownership must target the tenant dialplan conf and the tenant queues conf",
  );
});

test("ownership: apply_tenant_changes restores GUI ownership after regen, before the MOH re-apply", () => {
  assert.match(
    HELPER,
    /def apply_tenant_changes\([\s\S]{0,5000}"guiOwnership"\] = restore_gui_conf_ownership\(tenant_id\)[\s\S]{0,1500}"mohReapply"\] = reapply_moh_patches_after_regen\(tenant_id\)/,
    "apply_tenant_changes must chown the regenerated confs back to www-data BEFORE re-applying MOH patches (so the patch writers inherit the fixed ownership)",
  );
});

test("ownership: every atomic tenant-conf writer normalizes ownership after os.replace", () => {
  // patch_tenant_queue_musicclass + patch_tenant_dialplan_moh + bake_route_goto
  assert.equal(
    countOccurrences(HELPER, 'evidence["ownership"] = _chown_gui_conf(conf)'),
    3,
    "all three tenant-conf writers (queue musicclass, dialplan MOH, route Goto bake) must call _chown_gui_conf after replacing the file",
  );
});

test("ownership: _chown_gui_conf never raises (errors go into evidence)", () => {
  assert.match(
    HELPER,
    /def _chown_gui_conf\(path\):[\s\S]{0,900}except \(KeyError, OSError\) as exc:[\s\S]{0,120}out\["error"\] = str\(exc\)/,
    "_chown_gui_conf must swallow lookup/chown failures into the evidence dict — a chown failure must never abort a switch",
  );
});

test("ownership: VERSION reflects the 2026-08-06 ownership fix or later", () => {
  const m = SCRIPT.match(/^VERSION\s*=\s*"([^"]+)"/m);
  assert.ok(m, "VERSION constant must exist");
  assert.ok(
    m![1].localeCompare("2026.08.06.2") >= 0,
    "VERSION must be at or after the ownership-fix cut (2026.08.06.2), got " + m![1],
  );
});

// ── drift guard: the installer's embedded helper must BE the helper ───────
// The embedded copy silently drifted from 2026.07.26.1 → 2026.08.06.x once
// (fresh installs would have shipped a helper missing apply_tenant_changes
// entirely). Enforce byte-identity so it can't happen again.

test("embedded helper heredoc is byte-identical to vitalpbx-inbound-route-helper.py", () => {
  const marker = "cat >/opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py <<'PYHELPER'\n";
  const start = SCRIPT.indexOf(marker);
  assert.ok(start !== -1, "installer must write the helper via the PYHELPER heredoc");
  const bodyStart = start + marker.length;
  const end = SCRIPT.indexOf("\nPYHELPER\n", bodyStart);
  assert.ok(end !== -1, "PYHELPER heredoc terminator must exist");
  const embedded = SCRIPT.slice(bodyStart, end + 1);
  assert.equal(
    embedded,
    HELPER,
    "the embedded helper copy has drifted from scripts/pbx/vitalpbx-inbound-route-helper.py — re-sync the heredoc",
  );
});

// ── drift guard 2 (2026-08-19): the embedded mirror_writes.py must BE the module ──
test("embedded mirror_writes heredoc is byte-identical to scripts/pbx/mirror/mirror_writes.py", () => {
  const marker = "cat >/opt/connect-pbx-helper/mirror_writes.py <<'PYMIRROR'\n";
  const start = SCRIPT.indexOf(marker);
  assert.ok(start !== -1, "installer must ship mirror_writes.py via the PYMIRROR heredoc");
  const bodyStart = start + marker.length;
  const end = SCRIPT.indexOf("\nPYMIRROR\n", bodyStart);
  assert.ok(end !== -1, "PYMIRROR heredoc terminator must exist");
  const embedded = SCRIPT.slice(bodyStart, end + 1).replace(/\r\n/g, "\n");
  const mirror = readFileSync(join(__dirname, "mirror", "mirror_writes.py"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(embedded, mirror, "the embedded mirror_writes.py has drifted from scripts/pbx/mirror/mirror_writes.py — re-sync the heredoc");
});

test("helper registers /mirror/tenant-create and defines mirror_tenant_create (installer + .py)", () => {
  for (const src of [SCRIPT, HELPER]) {
    assert.match(src, /"\/mirror\/tenant-create": mirror_tenant_create,/);
    assert.match(src, /def mirror_tenant_create\(body\):/);
    assert.match(src, /queue_base_modules=True/);
  }
});

for (const spec of [
  { file: "vitalpbx_mirror.py", marker: "cat >/opt/connect-pbx-helper/vitalpbx_mirror.py <<'PYMIRRORVM'\n", term: "\nPYMIRRORVM\n" },
  { file: "mirror_features.py", marker: "cat >/opt/connect-pbx-helper/mirror_features.py <<'PYMIRRORFEAT'\n", term: "\nPYMIRRORFEAT\n" },
]) {
  test(`embedded ${spec.file} heredoc is byte-identical to scripts/pbx/mirror/${spec.file}`, () => {
    const start = SCRIPT.indexOf(spec.marker);
    assert.ok(start !== -1, `installer must ship ${spec.file}`);
    const bodyStart = start + spec.marker.length;
    const end = SCRIPT.indexOf(spec.term, bodyStart);
    assert.ok(end !== -1, `${spec.file} heredoc terminator must exist`);
    const embedded = SCRIPT.slice(bodyStart, end + 1).replace(/\r\n/g, "\n");
    const src = readFileSync(join(__dirname, "mirror", spec.file), "utf8").replace(/\r\n/g, "\n");
    assert.equal(embedded, src, `embedded ${spec.file} drifted — re-sync the heredoc`);
  });
}

test("helper registers /mirror/tenant-render and renders the baseline at create (installer + .py)", () => {
  for (const src of [SCRIPT, HELPER]) {
    assert.match(src, /"\/mirror\/tenant-render": mirror_tenant_render,/);
    assert.match(src, /render_and_install_pbx\(_mirror_read_conn\(\), int\(row\["tenant_id"\]\)\)/);
  }
});
