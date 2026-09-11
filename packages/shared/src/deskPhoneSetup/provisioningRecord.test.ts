/**
 * ⛔ EVERY FIXTURE HERE IS REAL. The four phones, their hardware addresses, the
 * tenants they are wrongly recorded under, the dead device id and the model ids are
 * all read off the live PBX on 2026-09-11 — not invented. An invented fixture agrees
 * with whatever the code already does; these four disagreed with it, which is the
 * whole reason this module exists.
 *
 *   HT812   C0:74:AD:E5:79:37  provisioning.devices id 1   tenant 2  (a_plus_center)
 *   GXP2170 c0:74:ad:8c:65:4e  id 24                       tenant 7  (create_a_box)
 *   GXP2170 c0:74:ad:8c:60:5f  id 23                       tenant 7  (create_a_box)
 *   HT801   EC:74:D7:20:1F:EA  id 52                       tenant 21 — bound to
 *                                                          ombu device 149, which
 *                                                          does not exist
 *   Yealink 80:5e:c0:b3:b2:d0  no row on any tenant
 *
 * Landau Home is PBX tenant 21 and has exactly two devices: 130 (`101`, the desk
 * endpoint) and 191 (`101_1`, the softphone).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { planProvisioningRecord, pnpArmList, type PbxPhoneRecord, type RecordTarget } from "./provisioningRecord";

const LANDAU = 21;
const DESK = 130;
const SOFTPHONE = 191;
const LIVE = [DESK, SOFTPHONE];

function target(over: Partial<RecordTarget> = {}): RecordTarget {
  return {
    mac: "80:5e:c0:b3:b2:d0",
    vendor: "yealink",
    model: "T53W",
    pbxTenantNumber: LANDAU,
    extNumber: "101",
    deskDeviceId: DESK,
    liveDeviceIds: LIVE,
    ...over,
  };
}

/* ── the Yealink: the phone that could never be finished ─────────────────── */

test("a phone with no record anywhere is created — this is the chicken and egg", () => {
  const plan = planProvisioningRecord(target(), null);
  assert.equal(plan.kind, "write");
  if (plan.kind !== "write") return;
  assert.equal(plan.phoneId, null, "no existing row, so INSERT");
  assert.equal(plan.mac, "805ec0b3b2d0", "normalised, no separators");
  assert.equal(plan.pbxModelId, 154, "T53W is phone_models.id 154 on the live PBX");
  assert.equal(plan.pbxTenantNumber, LANDAU);
  assert.deepEqual(plan.accounts, [DESK]);
  assert.equal(plan.rehomedFromTenant, null);
});

test("the model may come from the person rather than the phone", () => {
  // ⛔ Izzy's dropdowns. The Yealink never told us its model — the wizard read a
  // blank model off it — so without the person's pick there is nothing to write.
  const blind = planProvisioningRecord(target({ model: null }), null);
  assert.equal(blind.kind, "refuse");
  if (blind.kind === "refuse") assert.equal(blind.reason, "model_unknown");

  const picked = planProvisioningRecord(target({ model: "T53W" }), null);
  assert.equal(picked.kind, "write");
});

test("a model the catalogue does not know is refused, never guessed", () => {
  const plan = planProvisioningRecord(target({ model: "T53WX-NOT-REAL" }), null);
  assert.equal(plan.kind, "refuse");
  if (plan.kind !== "refuse") return;
  assert.equal(plan.reason, "model_not_in_catalogue");
  // ⛔ The customer is told what to do, and never sees a table name or a code.
  assert.ok(!/catalogue|phone_models|provisioning/i.test(plan.customerMessage));
});

test("the one model with a catalogue row and no template on disk is refused", () => {
  // Gigaset P820 IP PRO — 426 of 427 have a template; this one does not.
  const plan = planProvisioningRecord(
    target({ vendor: "gigaset", model: "P820 IP PRO" }),
    null,
  );
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.equal(plan.reason, "no_template_on_disk");
});

/* ── the three phones recorded under other customers ─────────────────────── */

test("a phone recorded under another customer is moved, and the previous tenant is reported", () => {
  const existing: PbxPhoneRecord = {
    phoneId: 24, mac: "c074ad8c654e", pbxTenantNumber: 7, modelId: 64,
    templateId: 16, boundDeviceIds: [29, null, null, null, null, null],
  };
  const plan = planProvisioningRecord(
    target({ mac: "c0:74:ad:8c:65:4e", vendor: "grandstream", model: "GXP2170" }),
    existing,
  );
  assert.equal(plan.kind, "write");
  if (plan.kind !== "write") return;
  assert.equal(plan.phoneId, 24, "UPDATE the existing row — a MAC may exist exactly once");
  assert.equal(plan.pbxTenantNumber, LANDAU);
  // ⛔ The caller has to be able to audit this and put it back.
  assert.equal(plan.rehomedFromTenant, 7);
  assert.deepEqual(plan.accounts, [DESK]);
});

test("the HT812 recorded under A plus center moves too", () => {
  const existing: PbxPhoneRecord = {
    phoneId: 1, mac: "c074ade57937", pbxTenantNumber: 2, modelId: 303,
    templateId: 1, boundDeviceIds: [3],
  };
  const plan = planProvisioningRecord(
    target({ mac: "C0:74:AD:E5:79:37", vendor: "grandstream", model: "HT812" }),
    existing,
  );
  assert.equal(plan.kind, "write");
  if (plan.kind === "write") assert.equal(plan.rehomedFromTenant, 2);
});

/* ── the phone whose record looked correct ───────────────────────────────── */

test("a binding that points at a device which no longer exists is repaired", () => {
  // ⛔ The HT801. Right tenant, right model, and bound to ombu device 149 — which
  // Landau Home does not have. Its config renders with no account, so the one phone
  // whose record looked correct could never have registered either.
  const existing: PbxPhoneRecord = {
    phoneId: 52, mac: "ec74d7201fea", pbxTenantNumber: LANDAU, modelId: 305,
    templateId: 24, boundDeviceIds: [149],
  };
  const plan = planProvisioningRecord(
    target({ mac: "EC:74:D7:20:1F:EA", vendor: "grandstream", model: "HT801" }),
    existing,
  );
  assert.equal(plan.kind, "write");
  if (plan.kind !== "write") return;
  assert.equal(plan.phoneId, 52);
  assert.equal(plan.rehomedFromTenant, null, "same customer — this is not a move");
  assert.equal(plan.rebound, true);
  assert.deepEqual(plan.accounts, [DESK]);
  assert.match(plan.explain, /no longer exists/);
});

test("a phone bound to the softphone device is rebound to the desk endpoint", () => {
  // ⛔ Binding a handset to `T21_101_1` would render the softphone's credentials
  // into the desk phone's config, so the two fight over one registration.
  const existing: PbxPhoneRecord = {
    phoneId: 52, mac: "ec74d7201fea", pbxTenantNumber: LANDAU, modelId: 305,
    templateId: 24, boundDeviceIds: [SOFTPHONE],
  };
  const plan = planProvisioningRecord(
    target({ mac: "EC:74:D7:20:1F:EA", vendor: "grandstream", model: "HT801" }),
    existing,
  );
  assert.equal(plan.kind, "write");
  if (plan.kind === "write") assert.deepEqual(plan.accounts, [DESK]);
});

test("a record that is already exactly right is left alone", () => {
  // ⛔ This branch must come before every write: re-rendering a working phone's
  // config for no reason is how a wizard breaks a handset that was fine.
  const existing: PbxPhoneRecord = {
    phoneId: 52, mac: "ec74d7201fea", pbxTenantNumber: LANDAU, modelId: 305,
    templateId: 24, boundDeviceIds: [DESK],
  };
  const plan = planProvisioningRecord(
    target({ mac: "EC:74:D7:20:1F:EA", vendor: "grandstream", model: "HT801" }),
    existing,
  );
  assert.equal(plan.kind, "adopt");
  if (plan.kind === "adopt") assert.equal(plan.phoneId, 52);
});

test("a wrong model on our own row is corrected", () => {
  const existing: PbxPhoneRecord = {
    phoneId: 23, mac: "c074ad8c605f", pbxTenantNumber: LANDAU, modelId: 303 /* HT812 */,
    templateId: 15, boundDeviceIds: [DESK],
  };
  const plan = planProvisioningRecord(
    target({ mac: "c0:74:ad:8c:60:5f", vendor: "grandstream", model: "GXP2170" }),
    existing,
  );
  assert.equal(plan.kind, "write");
  if (plan.kind !== "write") return;
  assert.equal(plan.pbxModelId, 64);
  assert.equal(plan.rehomedFromTenant, null);
});

/* ── refusals that are ordinary states, not faults ───────────────────────── */

test("a phone nobody has assigned yet is refused kindly and written nowhere", () => {
  const plan = planProvisioningRecord(target({ extNumber: "" }), null);
  assert.equal(plan.kind, "refuse");
  if (plan.kind !== "refuse") return;
  assert.equal(plan.reason, "not_assigned");
  assert.match(plan.customerMessage, /Choose who uses/i);
});

test("an extension with no desk endpoint is named as such, not failed", () => {
  const plan = planProvisioningRecord(target({ deskDeviceId: null }), null);
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.equal(plan.reason, "no_desk_device");
});

test("an unreadable hardware address is refused first of all", () => {
  for (const bad of ["", "not-a-mac", "ff:ff:ff:ff:ff:ff", "00:00:00:00:00:00", "01:00:5e:00:00:01"]) {
    const plan = planProvisioningRecord(target({ mac: bad }), null);
    assert.equal(plan.kind, "refuse", `${bad} must refuse`);
    if (plan.kind === "refuse") assert.equal(plan.reason, "bad_mac", `${bad}`);
  }
});

/* ── arming the listener ─────────────────────────────────────────────────── */

test("the listener is armed with exactly the phones that are in the setup", () => {
  const armed = pnpArmList([
    { macAddress: "80:5e:c0:b3:b2:d0", skippedAt: null, extNumber: "101" },
    // ⛔ Unticked by the person: never answered, or we would point a handset they
    // deliberately left alone at us.
    { macAddress: "c0:74:ad:8c:65:4e", skippedAt: new Date(), extNumber: "101" },
    // Not assigned to anybody yet — there is nothing to point it at.
    { macAddress: "c0:74:ad:8c:60:5f", skippedAt: null, extNumber: null },
    // Same phone twice, written two ways.
    { macAddress: "EC:74:D7:20:1F:EA", skippedAt: null, extNumber: "101" },
    { macAddress: "ec74d7201fea", skippedAt: null, extNumber: "101" },
    { macAddress: "rubbish", skippedAt: null, extNumber: "101" },
  ]);
  assert.deepEqual(armed, ["805ec0b3b2d0", "ec74d7201fea"]);
});

test("arming is normalised so the desktop never has to care how a MAC was written", () => {
  const armed = pnpArmList([{ macAddress: "C0-74-AD-8C-65-4E", skippedAt: null, extNumber: "106" }]);
  assert.deepEqual(armed, ["c074ad8c654e"]);
});
