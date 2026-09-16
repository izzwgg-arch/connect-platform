/**
 * licenceRefusal.test.ts — the guard for the 2026-09-16 defect.
 *
 * ⛔ THE DEFECT, so the test is never "simplified" back into it: the gate that
 * decided "is the licence refusing, should we take the mirror instead" was ONE
 * substring, `"maximum number of al"`. It matches `extensions.max_reached` and
 * nothing else. A live customer's app device was refused with
 * `extensions.vitxi_clients.max_reached`, the gate did not fire, no fallback
 * ran, and the route answered a raw 422 carrying a truncated JSON blob.
 *
 * ⛔ Several of these read the SOURCE of the routes, not their behaviour,
 * because the defect was *which predicate the route called* — a unit test of
 * either predicate passes straight through that bug. Same shape as
 * permissionToggleCoverage.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  LICENCE_REFUSAL_RULES,
  MIRROR_EXTENSION_GRANTS_FILE,
  halfBuiltExtensionMessage,
  isExtensionWriteLicenceRefusal,
  isLicenceRefusal,
  isLicenceSilentDowngrade,
  isMirrorGrantMissing,
  licenceRefusalKind,
  mirrorGrantMissingMessage,
} from "./licenceRefusal";

const ROOT = process.env.PORTAL_GUARD_ROOT || path.resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/* The exact sentences, copied from the running PBX's own en_US catalogue
   (/usr/share/vitalpbx/i18n/en_US/*.txt, read 2026-09-16). ⛔ These are the
   spec — if VitalPBX rewords one, this test is where it must be updated. */
const PANEL_SENTENCES: Array<[string, string]> = [
  ["extensions.vitxi_clients.max_reached", "You've reached the maximum number of Mobile/WebRTC clients allowed for your current license."],
  ["extensions.max_reached", "You have reached the maximum number of allowed extensions."],
  ["extensions.global_max_reached", "The current server license has surpassed the allowable limit for extensions."],
  ["extensions.push.max_devices_with_qr", 'You\'ve reached the maximum number of devices with the "QR" option enabled that your current license allows.'],
  ["mobile_devices.validation.license_limit", "You've reached the maximum number of allowed VitalPBX Connect devices."],
  ["mobile_devices.validation.tenant_limit", "You are not allowed to add more than 3 mobile devices. Please, get in contact with your PBX provider."],
  ["provisioning.licensing.max_reached", "You've reached the maximum number of allowed phone devices that can be provisioned"],
  ["app.license.max_items", "You have reached the maximum number of free items allowed on this module"],
  ["conferences.max_reached", "You have reached the maximum number of conferences allowed"],
  ["ivr.max_reached", "You have reached the maximum number of IVRs allowed"],
  ["queues.max_reached", "You have reached the maximum number of queues allowed"],
  ["parking.max_reached", "You have reached the maximum number of parking lots allowed"],
];

test("every licence sentence the PBX can answer with is recognised", () => {
  for (const [key, sentence] of PANEL_SENTENCES) {
    assert.ok(isLicenceRefusal(new Error(`[device-new] ${sentence}`)), `${key} must be recognised`);
  }
});

test("⛔ THE REGRESSION: the app-client cap is an extension-write refusal (the old gate missed it)", () => {
  const vitxi = "You've reached the maximum number of Mobile/WebRTC clients allowed for your current license.";
  // the predicate that decides whether to take the mirror
  assert.ok(isExtensionWriteLicenceRefusal(new Error(`[device-new] ${vitxi}`)));
  assert.equal(licenceRefusalKind(vitxi), "app_client");
  // and the substring the old gate used must NOT be what matches it
  assert.ok(!vitxi.toLowerCase().includes("maximum number of al"), "if this ever overlaps, the ordering in LICENCE_REFUSAL_RULES is load-bearing");
});

test("the panel's truncated JSON body — how it really arrives — is still recognised", () => {
  /* The refusal reaches us inside assertSaved's "unexpected response" wrapper,
     cut at 200 characters mid-sentence. Recognition must survive that. */
  const real =
    '[device-new] unexpected response: {\n    "state": "message",\n    "action": null,\n    "html": null,\n    "notification": {\n        "type": "warning",\n        "title": "Extensions",\n        "text": "You\'ve reached the maximum number of Mo';
  assert.ok(!isExtensionWriteLicenceRefusal(new Error(real)), "a cut this early cannot be matched — which is exactly why the route must not depend on it alone");
  const lessCut = real + "bile/WebRTC clients allowed for your current license.";
  assert.ok(isExtensionWriteLicenceRefusal(new Error(lessCut)), "the full sentence must match");
});

test("a TENANT-create refusal is NOT an extension-write refusal", () => {
  // preserved from the original narrow gate's one correct distinction
  const e = new Error("maximum number of free tenants");
  assert.ok(isLicenceRefusal(e), "it IS the licence talking");
  assert.ok(!isExtensionWriteLicenceRefusal(e), "but handing it to an extension fallback is nonsense");
  assert.equal(licenceRefusalKind(e), "tenants");
});

test("an ordinary failure is not a licence refusal", () => {
  assert.ok(!isLicenceRefusal(new Error("the phone system rejected the change")));
  assert.ok(!isLicenceRefusal(new Error("")));
  assert.ok(!isLicenceRefusal(null));
  assert.ok(!isExtensionWriteLicenceRefusal(new Error("Undefined array key \"user\"")));
});

test("⛔ the SILENT DOWNGRADE — an import that 'succeeds' with the app flag cleared", () => {
  const note = 'The WebRTC Client flag was set to "no" for the device "102_1" due to your current license limitations.';
  assert.ok(isLicenceSilentDowngrade(note));
  assert.ok(isLicenceSilentDowngrade('The Mobile Client flag was set to "no" for the device "x" due to your current license limitations.'));
  assert.ok(!isLicenceSilentDowngrade("Import Completed Successfully"));
});

test("the mirror's missing-grant error is recognised and answered with the fix", () => {
  const e = new Error(`(1142, "INSERT command denied to user 'connect_route_helper'@'localhost' for table \`ombutel\`.\`ombu_extensions\`")`);
  assert.ok(isMirrorGrantMissing(e));
  const msg = mirrorGrantMissingMessage(e.message);
  assert.ok(msg.includes(MIRROR_EXTENSION_GRANTS_FILE), "the message must name the grants file");
  assert.ok(!isMirrorGrantMissing(new Error("connection refused")));
});

test("the half-built message says the rows exist and Asterisk does not have them", () => {
  const m = halfBuiltExtensionMessage("103", "the app device was refused");
  assert.match(m, /NOT live in Asterisk/);
  assert.match(m, /pjsip show endpoints/);
});

test("rules are ordered most-specific first", () => {
  /* `maximum number of al` is the loose historical fragment; every sentence it
     could swallow must be listed ahead of it or the kind comes out wrong. */
  const looseAt = LICENCE_REFUSAL_RULES.findIndex((r) => r.fragment === "maximum number of al");
  assert.ok(looseAt > 0, "the loose fragment must not be first");
  const specific = LICENCE_REFUSAL_RULES.slice(0, looseAt).map((r) => r.fragment);
  assert.ok(specific.includes("maximum number of mobile/webrtc clients"));
  assert.ok(specific.includes("maximum number of allowed extensions"));
});

/* ── source guards: the ROUTES must use the wide gate, and the mirror must lead ── */

test("⛔ the console's extension EDIT fallback uses the wide gate, not the old substring", () => {
  const routes = read("apps/api/src/pbxConsole/pbxConsoleRoutes.ts");
  assert.ok(
    routes.includes("if (!isExtensionWriteLicenceRefusal(e)) throw e"),
    "saveExtensionOrMirror must gate on the shared detector",
  );
  assert.ok(
    !/isExtensionCapRefusal\s*\(/.test(routes),
    "the old narrow predicate must be gone from the routes — it is the defect",
  );
});

test("⛔ no file may re-implement a licence substring outside licenceRefusal.ts", () => {
  /* Two copies of this knowledge is how it drifted the first time. */
  for (const rel of [
    "apps/api/src/pbxConsole/pbxConsoleWrites.ts",
    "apps/api/src/onboarding/pbxTenantBuild.ts",
  ]) {
    const src = read(rel);
    assert.ok(
      !src.includes('includes("maximum number of al")'),
      `${rel} must not carry its own copy of a licence substring`,
    );
  }
});

test("⛔ THE MIRROR LEADS: the console create tries the mirror before the panel", () => {
  const routes = read("apps/api/src/pbxConsole/pbxConsoleRoutes.ts");
  const createAt = routes.indexOf('app.post("/admin/pbx-console/extensions"');
  assert.ok(createAt > 0, "the create route must exist");
  const patchAt = routes.indexOf('app.patch("/admin/pbx-console/extensions/:id"');
  const body = routes.slice(createAt, patchAt > createAt ? patchAt : undefined);

  const mirrorAt = body.indexOf("mirrorAddPbxExtension");
  const panelAt = body.indexOf("createExtension(s,");
  assert.ok(mirrorAt > 0 && panelAt > 0, "both roads must be present");
  assert.ok(mirrorAt < panelAt, "⛔ the mirror must be attempted BEFORE the panel — the subscription is cancelled");

  assert.ok(body.includes("PBX_EXTENSION_CREATE_MODE"), "the order must stay forceable back to the panel");
  assert.ok(body.includes("mirrorFallbackReason"), "a mirror failure must be remembered so the final refusal can name both roads");
});

test("⛔ a mirror create whose APPLY failed must never fall back to the panel", () => {
  /* Rows landed; a panel retry would answer "already exists" and the real
     failure would be buried. */
  const routes = read("apps/api/src/pbxConsole/pbxConsoleRoutes.ts");
  assert.ok(routes.includes("mirror-add-apply"), "the apply failure needs its own step");
  assert.ok(
    routes.includes("do NOT create it again"),
    "and it must tell the person not to retry the create",
  );
});

test("⛔ a mirror 200 is not proof — the create reads the extension back", () => {
  const routes = read("apps/api/src/pbxConsole/pbxConsoleRoutes.ts");
  assert.ok(routes.includes("mirror-add-unverified"), "an unverified mirror create must have its own step");
  assert.ok(
    routes.includes("deviceCount < 2"),
    "both devices must be read back before success is reported",
  );
});

test("⛔ onboarding names the mirror when the licence refuses the app device", () => {
  const build = read("apps/api/src/onboarding/pbxTenantBuild.ts");
  assert.ok(build.includes("device-webrtc-licence"), "the app-device refusal needs its own step");
  assert.ok(build.includes("MIRROR_EXTENSION_GRANTS_FILE"), "and it must name the fix");
  assert.ok(
    build.includes("extension-import-downgraded"),
    "onboarding's CSV import must also catch the silent downgrade",
  );
});

test("the grants file the messages point at actually exists", () => {
  const sql = read(MIRROR_EXTENSION_GRANTS_FILE);
  for (const table of [
    "ombu_extensions",
    "ombu_devices",
    "ombu_pjsip_devices",
    "ombu_extensions_vm",
    "ombu_extensions_contact_info",
    "ombu_followme",
    "ombu_extension_diversions",
  ]) {
    assert.ok(sql.includes(table), `the grants must cover ${table}`);
  }
  /* ⛔ Check the STATEMENTS, not the file: the header comment legitimately uses
     the words DELETE and UPDATE to say it grants neither. */
  const statements = sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  assert.ok(!/\bDELETE\b/i.test(statements), "the grants must stay additive — no DELETE");
  assert.ok(!/\bUPDATE\b/i.test(statements), "the grants must stay additive — no widened UPDATE");
  assert.ok(/\bGRANT\s+INSERT\b/i.test(statements), "and they must actually grant INSERT");
});
