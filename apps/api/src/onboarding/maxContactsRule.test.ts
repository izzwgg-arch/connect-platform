/**
 * Izzy's rule (2026-08-30): every extension gets FIVE contacts on the desk
 * (PJSIP) device AND five on the WebRTC device.
 *
 * The trap this pins: `ombu_pjsip_devices.max_contacts` has a COLUMN DEFAULT
 * of 1, so any creation path that simply omits the field ships an extension
 * whose desk phone can hold ONE registration — which is exactly how every
 * onboarding-built desk device sat at 1 until the 2026-08-30 fleet backfill
 * (all 156 devices raised to 5; Gesheft T8_101_1 deliberately kept at 10 —
 * the rule is raise-only, never lower a deliberate higher value).
 *
 * Four creation paths exist and each is guarded here, because a fix applied
 * to one of several sites is this repo's most repeated defect shape:
 *   1. onboarding CSV import      (pbxTenantBuild.ts importExtension)
 *   2. console create CSV         (pbxConsoleWrites.ts createExtension base)
 *   3. console device add form    (pbxConsoleWrites.ts deviceOverrides)
 *   4. the mirror plan builder    (scripts/pbx/mirror/mirror_writes.py +
 *                                  the installer's embedded copy)
 * Guards 1/2/4 read SOURCE (CRLF-normalised) because the value is data inside
 * a builder a unit test cannot cheaply drive; guard 3 drives the real fn.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { deviceOverrides, type DeviceSpec } from "../pbxConsole/pbxConsoleWrites";
import { parseForm, type ParsedForm } from "../pbxConsole/panelForm";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const API_SRC = path.join(__dirname, "..");
const REPO = path.join(__dirname, "..", "..", "..", "..");

test("onboarding CSV import sets max_contacts 5 on the desk device", () => {
  const src = read(path.join(__dirname, "pbxTenantBuild.ts"));
  const fn = src.slice(src.indexOf("async function importExtension"), src.indexOf("/** Same lookup"));
  assert.ok(fn.includes('max_contacts: "5"'), "importExtension's CSV row must carry max_contacts 5 — an empty column takes the DB default of 1");
});

test("console create CSV sets max_contacts 5 unless the caller chose one", () => {
  const src = read(path.join(API_SRC, "pbxConsole", "pbxConsoleWrites.ts"));
  assert.match(src, /max_contacts: first && first\.maxContacts != null \? String\(first\.maxContacts\) : "5"/);
});

function devForm(): ParsedForm {
  const html = `<form>
    <input type="hidden" name="device_id" value="new">
    <input type="text" name="user" value="">
    <input type="text" name="secret" value="genpw">
    <select name="profile_id"><option value="1" selected>Default PJSIP Profile</option><option value="12">Default WebRTC Profile</option></select>
    <input type="text" name="max_contacts" value="">
    <select name="dtmfmode"><option value="rfc2833" selected>rfc2833</option><option value="info">info</option></select>
    <input type="checkbox" name="ring_device" value="yes" checked>
    <input type="checkbox" name="vitxi_client" value="1">
    <input type="text" name="number" value="">
  </form>`;
  return parseForm(html);
}

test("deviceOverrides: a NEW desk pjsip device and a NEW webrtc device both default to 5 contacts", () => {
  const f = devForm();
  const profiles = { pjsip: "1", webrtc: "12", iax: "1" };
  const desk = deviceOverrides({ id: null, kind: "pjsip" } as DeviceSpec, f, profiles);
  assert.equal(desk.set!.max_contacts, "5", "a new desk device must default to 5");
  const web = deviceOverrides({ id: null, kind: "webrtc" } as DeviceSpec, f, profiles);
  assert.equal(web.set!.max_contacts, "5", "a new webrtc device must default to 5");
});

test("deviceOverrides: an EXISTING device is never re-defaulted, an explicit value wins, virtual stays exempt", () => {
  const f = devForm();
  const profiles = { pjsip: "1", webrtc: "12", iax: "1" };
  // an edit of an existing device with no stated maxContacts must NOT inject 5
  // (that would silently overwrite a deliberate value like Gesheft's 10)
  const edit = deviceOverrides({ id: 71, kind: "pjsip" } as DeviceSpec, f, profiles);
  assert.equal(edit.set!.max_contacts, undefined, "an edit must not re-default max_contacts");
  const explicit = deviceOverrides({ id: null, kind: "pjsip", maxContacts: "2" } as DeviceSpec, f, profiles);
  assert.equal(explicit.set!.max_contacts, "2", "a caller-chosen value wins over the default");
  const virt = deviceOverrides({ id: null, kind: "virtual", number: "8455551212" } as DeviceSpec, f, profiles);
  assert.ok(virt.drop!.includes("max_contacts"), "virtual devices keep dropping the field");
});

test("the mirror plan builder and the installer's embedded copy both default desk devices to 5", () => {
  const py = read(path.join(REPO, "scripts", "pbx", "mirror", "mirror_writes.py"));
  const sh = read(path.join(REPO, "scripts", "pbx", "install-vitalpbx-inbound-route-helper.sh"));
  const want = "desk_max_contacts: int = 5, webrtc_max_contacts: int = 5";
  assert.ok(py.includes(want), "mirror_writes.py must default desk_max_contacts to 5");
  assert.ok(sh.includes(want), "the installer's embedded mirror_writes must match (drift = a silent downgrade at the next install)");
  assert.ok(!py.includes("desk_max_contacts: int = 1"), "the old desk default of 1 must not return");
});

test("the manual-import CSV template gives both devices 5 contacts", () => {
  const src = read(path.join(__dirname, "vitalpbxTemplate.ts"));
  const values = [...src.matchAll(/max_contacts:\s*(\d+)\s*,/g)].map((m) => m[1]);
  assert.deepEqual(values, ["5", "5"], "desk row and webrtc row must both say 5");
});
