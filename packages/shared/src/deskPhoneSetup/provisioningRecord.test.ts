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
import {
  planProvisioningRecord,
  pnpArmList,
  chooseTemplate,
  type PbxPhoneRecord,
  type PbxTemplate,
  type RecordTarget,
} from "./provisioningRecord";

const LANDAU = 21;
const DESK = 130;
const SOFTPHONE = 191;
const LIVE = [DESK, SOFTPHONE];

/** Model ids as `provisioning.phone_models` really numbers them. */
const M_T53W = 154;
const M_GXP2170 = 64;
const M_HT812 = 303;
const M_HT801 = 305;

/**
 * Settings profiles, in the shape the console reads them. ⛔ The ids match the
 * `template_id` on the real device rows used as fixtures below — 24 on the HT801, 16
 * and 15 on the GXP2170s, 1 on the HT812 — so "keep the profile this row already has"
 * is tested against the values the PBX actually holds.
 */
const TEMPLATES: PbxTemplate[] = [
  { id: 24, modelId: M_HT801, tenant: LANDAU, shared: false },
  { id: 1, modelId: M_HT812, tenant: 2, shared: false },
  { id: 16, modelId: M_GXP2170, tenant: 7, shared: false },
  { id: 15, modelId: M_GXP2170, tenant: LANDAU, shared: false },
  { id: 90, modelId: M_T53W, tenant: null, shared: true },
];

function target(over: Partial<RecordTarget> = {}): RecordTarget {
  return {
    mac: "80:5e:c0:b3:b2:d0",
    vendor: "yealink",
    model: "T53W",
    pbxTenantNumber: LANDAU,
    extNumber: "101",
    deskDeviceId: DESK,
    liveDeviceIds: LIVE,
    templates: TEMPLATES,
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

/* ── the settings profile ────────────────────────────────────────────────── */

test("a new row gets a settings profile, or the config it renders is unusable", () => {
  // ⛔⛔ save_phone ACCEPTS a null template_id: the INSERT lands, the generator runs,
  // and the phone fetches a file with nothing in it — no error anywhere. All 55
  // devices on this PBX carry one, so a null is a shape nothing has ever been proven
  // against. Deciding it is part of deciding the row.
  const plan = planProvisioningRecord(target(), null);
  assert.equal(plan.kind, "write");
  if (plan.kind !== "write") return;
  assert.equal(plan.templateId, 90, "the shared T53W profile");
  assert.equal(plan.needsTemplate, false);
});

test("a model with no profile anywhere says so instead of writing a blank one", () => {
  const plan = planProvisioningRecord(target({ templates: [] }), null);
  assert.equal(plan.kind, "write");
  if (plan.kind !== "write") return;
  assert.equal(plan.templateId, null);
  // ⛔ Named so a caller cannot skim past it. The hole is the caller's to close.
  assert.equal(plan.needsTemplate, true);
});

test("the customer's OWN profile beats a shared one", () => {
  // Their own carries whatever they already had set up; re-picking discards it.
  assert.equal(chooseTemplate(M_GXP2170, LANDAU, TEMPLATES), 15);
  assert.equal(chooseTemplate(M_GXP2170, 7, TEMPLATES), 16);
  assert.equal(chooseTemplate(M_T53W, LANDAU, TEMPLATES), 90, "nobody owns one, so the shared one");
});

test("a CLEAN generic profile beats an arbitrary shared one — a moved phone never inherits another customer's server", () => {
  // The wall of 2026-09-15: the only shared GXP2170 profiles were Create A Box's, hand-hardcoded
  // to their VPN server, so a Landau phone that fell to the shared fallback got 10.8.0.1. A seeded
  // generic profile (placeholder server) now wins the fallback.
  const withGeneric: PbxTemplate[] = [
    { id: 16, modelId: M_GXP2170, tenant: 7, shared: true },                 // a customer's, still shared
    { id: 60, modelId: M_GXP2170, tenant: 1, shared: true, generic: true },  // the clean seed
  ];
  assert.equal(chooseTemplate(M_GXP2170, 999, withGeneric), 60, "the clean generic profile, not the customer's");
  // ⛔ The tenant's OWN profile still wins over generic — it carries their real setup.
  const ownWins: PbxTemplate[] = [...withGeneric, { id: 77, modelId: M_GXP2170, tenant: 999, shared: false }];
  assert.equal(chooseTemplate(M_GXP2170, 999, ownWins), 77, "own beats even the clean generic");
});

test("a profile built for a DIFFERENT model is never substituted", () => {
  // ⛔ It would write settings this handset does not have — worse than none, because
  // it looks like it worked.
  assert.equal(chooseTemplate(M_HT801, 7, TEMPLATES), null, "no HT801 profile for tenant 7 and none shared");
  assert.equal(chooseTemplate(999999, LANDAU, TEMPLATES), null);
  assert.equal(chooseTemplate(M_T53W, LANDAU, []), null);
});

test("re-homing a phone keeps the profile its row already had", () => {
  // ⛔ The GXP2170 moving off create_a_box keeps template 16 — the model has not
  // changed, so re-picking would throw away settings somebody configured.
  const existing: PbxPhoneRecord = {
    phoneId: 24, mac: "c074ad8c654e", pbxTenantNumber: 7, modelId: M_GXP2170,
    templateId: 16, boundDeviceIds: [29],
  };
  const plan = planProvisioningRecord(
    target({ mac: "c0:74:ad:8c:65:4e", vendor: "grandstream", model: "GXP2170" }),
    existing,
  );
  assert.equal(plan.kind, "write");
  if (plan.kind === "write") assert.equal(plan.templateId, 16);
});

test("correcting a wrong model also corrects the profile", () => {
  // ⛔ The row said HT812 and the phone is a GXP2170. Keeping the HT812 profile would
  // render an analog adapter's settings onto a desk phone.
  const existing: PbxPhoneRecord = {
    phoneId: 23, mac: "c074ad8c605f", pbxTenantNumber: LANDAU, modelId: M_HT812,
    templateId: 1, boundDeviceIds: [DESK],
  };
  const plan = planProvisioningRecord(
    target({ mac: "c0:74:ad:8c:60:5f", vendor: "grandstream", model: "GXP2170" }),
    existing,
  );
  assert.equal(plan.kind, "write");
  if (plan.kind !== "write") return;
  assert.equal(plan.pbxModelId, M_GXP2170);
  assert.equal(plan.templateId, 15, "Landau's own GXP2170 profile, not the HT812 one");
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

/* ── moving a record off another customer ────────────────────────────────── */

import {
  contactAddresses,
  decideRehome,
  REHOME_LIVE_WINDOW_MS,
  type RehomeRegistration,
} from "./provisioningRecord";

/**
 * ⛔ REAL contact strings, read off the live PBX 2026-09-14. Izzy's GXP2170 at
 * 192.168.6.171 is registered AS Create A Box ext 106 from his own public address;
 * Create A Box's real ext 102 is their office phone, arriving through their tunnel.
 */
const RIG_PUBLIC = "50.48.58.53";
const NOW = new Date("2026-09-14T05:00:00Z");
const T7_106_THIS_RIG: RehomeRegistration = {
  endpoint: "T7_106", status: "REGISTERED", lastRegisteredAt: "2026-09-14T04:34:19Z",
  contactUri: "sip:T7_106@50.48.58.53:36493;x-ast-orig-host=192.168.6.171:5060",
};
const T7_102_THEIR_OFFICE: RehomeRegistration = {
  endpoint: "T7_102", status: "REGISTERED", lastRegisteredAt: "2026-09-14T04:35:43Z",
  contactUri: "sip:T7_102@45.14.194.179:5060;x-ast-orig-host=192.168.8.160:5060",
};

test("contact addresses are read the way Asterisk writes them", () => {
  assert.deepEqual(contactAddresses(T7_106_THIS_RIG.contactUri), { publicHost: "50.48.58.53", lanHost: "192.168.6.171" });
  assert.deepEqual(contactAddresses("sip:T21_101_1@[2001:db8::1]:5060"), { publicHost: "2001:db8::1", lanHost: null });
  assert.deepEqual(contactAddresses(null), { publicHost: null, lanHost: null });
});

test("a record bound to no extension that still exists may be moved", () => {
  const d = decideRehome({ boundEndpoints: [], registrations: null, discoveredIp: null, requesterIp: null, now: NOW });
  assert.equal(d.allow, true);
});

test("a record nothing has used inside the window is stale and may be moved", () => {
  const d = decideRehome({ boundEndpoints: ["T7_106"], registrations: [], discoveredIp: null, requesterIp: null, now: NOW });
  assert.equal(d.allow, true, d.why);
});

test("unreadable registration state refuses — never move what cannot be proven stale", () => {
  const d = decideRehome({
    boundEndpoints: ["T7_106"], registrations: null, discoveredIp: "192.168.6.171", requesterIp: RIG_PUBLIC, now: NOW,
  });
  assert.equal(d.allow, false);
});

test("another company's extension live on a DIFFERENT device releases — the wizard on the phone's own network wins (Izzy, 2026-09-15)", () => {
  // Releasing a MAC's record never touches the other device's registration; the halt this
  // used to cause stranded a customer on "Support needs to finish" over a stale record.
  const d = decideRehome({
    boundEndpoints: ["T7_102"], registrations: [T7_102_THEIR_OFFICE],
    discoveredIp: "192.168.6.172", requesterIp: RIG_PUBLIC, now: NOW,
  });
  assert.equal(d.allow, true, d.why);
  assert.deepEqual(d.releasedOverLive, ["T7_102"]);
  assert.match(d.why, /untouched/);
});

test("the only live registration being THIS handset on THIS network lets it move", () => {
  const d = decideRehome({
    boundEndpoints: ["T7_106"], registrations: [T7_106_THIS_RIG],
    discoveredIp: "192.168.6.171", requesterIp: RIG_PUBLIC, now: NOW,
  });
  assert.equal(d.allow, true, d.why);
});

test("the same LAN address claimed from a different network is refused — that is a forger", () => {
  // ⛔ LAN addresses repeat in every office on earth; only the pair proves presence.
  const d = decideRehome({
    boundEndpoints: ["T7_106"], registrations: [T7_106_THIS_RIG],
    discoveredIp: "192.168.6.171", requesterIp: "203.0.113.9", now: NOW,
  });
  assert.equal(d.allow, false);
});

test("an unknown customer address can never prove presence", () => {
  const d = decideRehome({
    boundEndpoints: ["T7_106"], registrations: [T7_106_THIS_RIG],
    discoveredIp: "192.168.6.171", requesterIp: null, now: NOW,
  });
  assert.equal(d.allow, false);
});

test("this handset here plus another device live elsewhere releases — only the other device's endpoint is noted", () => {
  const d = decideRehome({
    boundEndpoints: ["T7_106", "T7_102"], registrations: [T7_106_THIS_RIG, T7_102_THEIR_OFFICE],
    discoveredIp: "192.168.6.171", requesterIp: RIG_PUBLIC, now: NOW,
  });
  assert.equal(d.allow, true, d.why);
  assert.deepEqual(d.releasedOverLive, ["T7_102"]);
});

test("a markerless registration from the customer's own public address no longer blocks — it cannot be an imposter claim", () => {
  // No LAN marker means it cannot match the forger shape (this handset's address from another
  // network); presence is proven by the office machine, so the wizard takes the record.
  const d = decideRehome({
    boundEndpoints: ["T7_106"],
    registrations: [{ ...T7_106_THIS_RIG, contactUri: "sip:T7_106@50.48.58.53:36493" }],
    discoveredIp: "192.168.6.171", requesterIp: RIG_PUBLIC, now: NOW,
  });
  assert.equal(d.allow, true, d.why);
});

test("a registration older than the window stops counting; one inside it still counts", () => {
  const day = 86_400_000;
  const old = { ...T7_102_THEIR_OFFICE, status: "UNREGISTERED", lastRegisteredAt: new Date(NOW.getTime() - REHOME_LIVE_WINDOW_MS - day) };
  const recent = { ...T7_102_THEIR_OFFICE, status: "UNREGISTERED", lastRegisteredAt: new Date(NOW.getTime() - 3 * day) };
  const base = { boundEndpoints: ["T7_102"], discoveredIp: "192.168.6.172", requesterIp: RIG_PUBLIC, now: NOW };
  const stale = decideRehome({ ...base, registrations: [old] });
  assert.equal(stale.allow, true);
  assert.equal(stale.releasedOverLive, undefined, "an expired registration is simply stale, not released-over");
  const liveOne = decideRehome({ ...base, registrations: [recent] });
  assert.equal(liveOne.allow, true, liveOne.why);
  assert.deepEqual(liveOne.releasedOverLive, ["T7_102"], "a registration inside the window is still LIVE and is recorded as released-over");
});

test("a registration on an endpoint the record is NOT bound to is ignored", () => {
  const d = decideRehome({
    boundEndpoints: ["T7_106"], registrations: [T7_102_THEIR_OFFICE],
    discoveredIp: "192.168.6.171", requesterIp: RIG_PUBLIC, now: NOW,
  });
  assert.equal(d.allow, true, d.why);
});
