/**
 * The mirror EXTENSION EDIT fallback — the last build before the VitalPBX
 * licence can be cancelled (AGENT_HANDOFF_PBX_CONSOLE_WHOLE_PANEL_FORM §8.6).
 *
 * Over the free tier's 12-extension cap the panel refuses an extension
 * edit-SAVE outright (clone-proven 2026-08-21). The console now falls back to
 * the PBX helper's /mirror/extension-edit for exactly that refusal. These
 * tests cover the pure translation (panel-named save → mirror whitelist), the
 * refusal shapes, and — as source guards — the wiring, because every defect of
 * this family in this repo has been a CALLER: a fallback that exists and is
 * never reached, or one that fires when the panel would have worked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mapExtensionSaveToMirrorEdit, isExtensionCapRefusal,
  type MirrorEditDeviceContext, type ExtensionSaveInput,
} from "./pbxConsoleWrites";

const norm = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripTs = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const stripPy = (src: string) => src.replace(/^\s*#.*$/gm, "");

const DEVICES: MirrorEditDeviceContext[] = [
  { deviceId: 71, user: "101", technology: "pjsip", ringDevice: true, description: "Device 101", number: null, dtmf: "rfc4733", maxContacts: 1 },
  { deviceId: 72, user: "101_1", technology: "pjsip", ringDevice: true, description: "Joel", number: null, dtmf: "rfc2833", maxContacts: 5 },
  { deviceId: 73, user: "101_2", technology: "virtual", ringDevice: true, description: "cell", number: "8455551234", dtmf: null, maxContacts: null },
];

test("the ordinary Extensions-screen save maps cleanly: name/email + the three checks + unchanged devices", () => {
  const input: ExtensionSaveInput = {
    set: { name: "Joel Landau", email: "joel@example.com" },
    checks: { vm_enabled: true, outgoing_rec: true, incoming_rec: false },
    devices: [
      { id: 71, kind: "pjsip", dtmf: "rfc4733", ringDevice: true },
      { id: 72, kind: "webrtc", dtmf: "rfc2833", ringDevice: true },
      { id: 73, kind: "virtual", number: "8455551234", ringDevice: true },
    ],
  };
  const out = mapExtensionSaveToMirrorEdit(input, DEVICES);
  assert.deepEqual(out.set, { name: "Joel Landau", email: "joel@example.com", outgoing_rec: "yes", incoming_rec: "no" });
  assert.deepEqual(out.vm, { enabled: "yes" });
  assert.deepEqual(out.devices, [], "devices carrying only their CURRENT values are no-ops, not refusals");
});

test("a changed device secret / dtmf / max_contacts travels; an unchanged one is dropped", () => {
  const out = mapExtensionSaveToMirrorEdit({
    set: { name: "x" },
    devices: [
      { id: 71, kind: "pjsip", secret: "N3wSecret123", dtmf: "auto", maxContacts: 2, ringDevice: true },
      { id: 72, kind: "webrtc", dtmf: "rfc2833", ringDevice: true },
    ],
  }, DEVICES);
  assert.deepEqual(out.devices, [{ device_id: 71, secret: "N3wSecret123", dtmf: "auto", max_contacts: 2 }]);
});

test("vm password maps to the voicemail row under either panel name", () => {
  for (const key of ["vm_password", "voicemail_password"]) {
    const out = mapExtensionSaveToMirrorEdit({ set: { [key]: "4321" } }, DEVICES);
    assert.deepEqual(out.vm, { password: "4321" });
  }
});

test("⛔ a field the mirror cannot honour is refused BY NAME, never dropped", () => {
  assert.throws(() => mapExtensionSaveToMirrorEdit({ set: { class_of_service_id: "9" } }, DEVICES),
    /class_of_service_id/);
  assert.throws(() => mapExtensionSaveToMirrorEdit({ set: { name: "x" }, checks: { hot_desking: true } }, DEVICES),
    /hot_desking/);
});

test("⛔ device ADD, device REMOVE, ring-switch flips and queue membership are refused — the mirror edits, it never fakes", () => {
  assert.throws(() => mapExtensionSaveToMirrorEdit({ devices: [{ kind: "pjsip", user: "101_3" }] }, DEVICES), /adding a device/);
  assert.throws(() => mapExtensionSaveToMirrorEdit({ set: { name: "x" }, removeDeviceIds: [71] }, DEVICES), /removing a device/);
  assert.throws(() => mapExtensionSaveToMirrorEdit({ devices: [{ id: 71, kind: "pjsip", ringDevice: false }] }, DEVICES), /rings this device/);
  assert.throws(() => mapExtensionSaveToMirrorEdit({ set: { name: "x" }, multi: { "dynamic_queues[]": ["1"] } }, DEVICES), /waiting-line/);
  assert.throws(() => mapExtensionSaveToMirrorEdit({ devices: [{ id: 73, kind: "virtual", number: "8455559999" }] }, DEVICES), /outside number/);
});

test("a save that changes nothing is an honest no-op refusal, not a helper call", () => {
  assert.throws(() => mapExtensionSaveToMirrorEdit({
    devices: [{ id: 71, kind: "pjsip", dtmf: "rfc4733", ringDevice: true }],
  }, DEVICES), /Nothing in this save differs/);
});

test("isExtensionCapRefusal matches ONLY the panel's own cap sentence", () => {
  assert.ok(isExtensionCapRefusal(new Error("device-new: You've reached the maximum number of allowed extensions")));
  assert.ok(!isExtensionCapRefusal(new Error("the phone system rejected the change")));
  assert.ok(!isExtensionCapRefusal(new Error("maximum number of free tenants")));
});

/* ── source guards: the wiring, replayed-failing against pre-fix HEAD ────── */

const routesSrc = stripTs(norm(join(__dirname, "pbxConsoleRoutes.ts")));

test("guard: BOTH extension-save call sites go through saveExtensionOrMirror", () => {
  // the definition calls saveExtension( once; no OTHER bare call site may remain
  const defs = routesSrc.split("saveExtensionOrMirror");
  assert.ok(defs.length >= 4, "definition + two call sites must reference saveExtensionOrMirror");
  const bareCalls = (routesSrc.match(/await saveExtension\(/g) || []).length;
  assert.equal(bareCalls, 1, "exactly ONE bare saveExtension( call — inside saveExtensionOrMirror itself");
});

test("guard: the panel is tried FIRST and the mirror only on the cap refusal", () => {
  const body = routesSrc.slice(routesSrc.indexOf("const saveExtensionOrMirror"));
  const panelAt = body.indexOf("saveExtension(");
  const gateAt = body.indexOf("isExtensionCapRefusal");
  const mirrorAt = body.indexOf("mirrorEditPbxExtension(");
  assert.ok(panelAt > 0 && gateAt > panelAt && mirrorAt > gateAt,
    "order must be: panel save → cap-refusal gate → mirror edit");
  assert.ok(body.includes("if (!isExtensionCapRefusal(e)) throw e"), "every other failure must rethrow untouched");
});

test("guard: a failed live-apply after a row edit is LOUD, never reported as saved", () => {
  assert.ok(routesSrc.includes("mirror-edit-apply"), "the applied.error branch must throw");
});

const helperSrc = stripPy(norm(join(__dirname, "..", "..", "..", "..", "scripts", "pbx", "vitalpbx-inbound-route-helper.py")));

test("guard: the helper registers /mirror/extension-edit and its version is 2026.08.22.1 or later", () => {
  assert.ok(helperSrc.includes('"/mirror/extension-edit": mirror_extension_edit'), "route must be registered");
  const v = norm(join(__dirname, "..", "..", "..", "..", "scripts", "pbx", "vitalpbx-inbound-route-helper.py")).match(/VERSION = "([\d.]+)"/);
  assert.ok(v && v[1] >= "2026.08.22.1", `helper VERSION must be bumped (got ${v?.[1]})`);
});

const mirrorSrc = norm(join(__dirname, "..", "..", "..", "..", "scripts", "pbx", "mirror", "mirror_writes.py"));

test("guard: mirror_writes has the edit writer and the surgical apply", () => {
  assert.ok(mirrorSrc.includes("def edit_extension("), "edit_extension must exist");
  assert.ok(mirrorSrc.includes("def apply_extension_edit_pbx("), "apply_extension_edit_pbx must exist");
});

test("⛔ guard: the edit's AstDB set must NEVER include the dial key — wake-and-wait enrollment rewrites it", () => {
  const block = stripPy(mirrorSrc.slice(mirrorSrc.indexOf("ASTDB_EDIT_KEYS"), mirrorSrc.indexOf("def extension_edit_astdb")));
  assert.ok(!/"dial"/.test(block), "writing extensions/N/dial from rows would silently un-enroll a wake-dial phone");
  assert.ok(!/"context"/.test(block), "context follows the class of service, which the mirror does not edit");
});

test("guard: the surgical writers use tmp + os.replace, never open(path, 'w') on the panel-owned file", () => {
  const fn = mirrorSrc.slice(mirrorSrc.indexOf("def _atomic_write_conf"), mirrorSrc.indexOf("def _replace_pjsip_device_triple"));
  assert.ok(fn.includes("os.replace("), "atomic replace is the only write shape the asterisk-user helper can use");
  assert.ok(fn.includes("mkstemp"), "the temp file must be created in the same directory");
});

test("guard: the installer grants UPDATE for the edit-writer's four tables (column-scoped)", () => {
  const inst = norm(join(__dirname, "..", "..", "..", "..", "scripts", "pbx", "install-vitalpbx-inbound-route-helper.sh"));
  assert.ok(/GRANT UPDATE \(name, email, language,[^)]*\) ON ombutel\.ombu_extensions/.test(inst));
  assert.ok(/GRANT UPDATE \(password, enabled,[^)]*\) ON ombutel\.ombu_extensions_vm/.test(inst));
  assert.ok(/GRANT UPDATE \(secret, description\) ON ombutel\.ombu_devices/.test(inst));
  assert.ok(/GRANT UPDATE \(dtmfmode, max_contacts\) ON ombutel\.ombu_pjsip_devices/.test(inst));
});
