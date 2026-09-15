/**
 * ⛔ The fake PBX below answers the four real queries with the four real row shapes,
 * read off the live database 2026-09-11. It is a fake so this needs no phone system —
 * it is NOT a simplification: the column names invert (`accounts.device_id` is the
 * PROVISIONING row and `accounts.phone_device_id` is the `ombu_devices` id), `shared`
 * is the string 'yes', and the desk endpoint is told from the softphone only by an
 * exact `user` match. Every one of those has cost a wrong answer before.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ensureProvisioningRecord, readRecordContext, type RecordQuery } from "./provisioningRecordWriter";

const LANDAU = 21;
const DESK = 130;
const SOFTPHONE = 191;

type Row = Record<string, any>;

function fakePbx(opts: {
  devices?: Row[];
  accounts?: Row[];
  templates?: Row[];
  ombuDevices?: Row[];
  /** Rows for the bound-device lookup a move performs: `{ device_id, user, tenant_id }`. */
  boundDevices?: Row[];
  failOn?: RegExp;
} = {}): { query: RecordQuery; seen: string[] } {
  const seen: string[] = [];
  const devices = opts.devices ?? [];
  const accounts = opts.accounts ?? [];
  const templates = opts.templates ?? [
    { id: 90, model_id: 154, tenant: null, shared: "yes" },
    { id: 24, model_id: 305, tenant: LANDAU, shared: "no" },
  ];
  // ⛔⛔ `ombu_devices.user` IS THE BARE EXTENSION — `101`, `101_1` — NEVER `T21_101`.
  // Census of the live PBX 2026-09-14: 158 pjsip devices, 0 with a T-prefix. The first
  // version of this fixture invented the prefixed shape, the writer was built to match
  // the fixture, and every real write would have refused "no desk device".
  const ombuDevices = opts.ombuDevices ?? [
    { device_id: DESK, user: "101" },
    { device_id: SOFTPHONE, user: "101_1" },
  ];
  const query: RecordQuery = async (sql, params = []) => {
    seen.push(sql);
    if (opts.failOn && opts.failOn.test(sql)) throw new Error("pbx read failed");
    if (/device_id IN \(/.test(sql)) return opts.boundDevices ?? [];
    if (/provisioning\.devices/.test(sql)) {
      const mac = String(params[0] ?? "");
      return devices.filter((d) => String(d.mac).toLowerCase().replace(/[:-]/g, "") === mac);
    }
    if (/provisioning\.accounts/.test(sql)) {
      return accounts.filter((a) => Number(a.device_id) === Number(params[0]));
    }
    if (/provisioning\.templates/.test(sql)) return templates;
    if (/ombu_devices/.test(sql)) return ombuDevices;
    return [];
  };
  return { query, seen };
}

function writer(over: Partial<Parameters<typeof ensureProvisioningRecord>[0]> = {}, pbx = fakePbx()) {
  const saved: any[] = [];
  const rehomes: any[] = [];
  return {
    saved,
    rehomes,
    deps: {
      query: async () => pbx.query,
      savePhone: async (a: any) => { saved.push(a); return { phoneId: a.phoneId ?? 999 }; },
      auditRehome: async (i: any) => { rehomes.push(i); },
      // Nothing registered anywhere unless a test says otherwise.
      registrations: async () => [],
      ...over,
    } as Parameters<typeof ensureProvisioningRecord>[0],
  };
}

const YEALINK = { pbxTenantNumber: LANDAU, mac: "80:5e:c0:b3:b2:d0", vendor: "yealink", model: "T53W", extNumber: "101" };

test("the phone with no record anywhere gets one — the wall comes down", async () => {
  const w = writer();
  const out = await ensureProvisioningRecord(w.deps, YEALINK);
  assert.equal(out.kind, "written");
  assert.equal(w.saved.length, 1);
  assert.deepEqual(w.saved[0], {
    phoneId: null, mac: "805ec0b3b2d0", tenantId: LANDAU, modelId: 154,
    templateId: 90, description: "101", accounts: [DESK],
  });
});

test("the desk endpoint is bound, never the softphone", async () => {
  // ⛔ Binding to `T21_101_1` renders the softphone's credentials into the handset's
  // config, so the desk phone and the app fight over one registration.
  const w = writer();
  await ensureProvisioningRecord(w.deps, YEALINK);
  assert.deepEqual(w.saved[0].accounts, [DESK]);
  assert.ok(!w.saved[0].accounts.includes(SOFTPHONE));
});

test("a phone recorded under another customer is moved, and the move is recorded FIRST", async () => {
  // ⛔ Three of the four phones on Izzy's desk are in this state. The audit runs before
  // the save because a save that lands after a failed audit loses the only record of
  // where the phone came from.
  const pbx = fakePbx({
    devices: [{ id: 24, mac: "c0:74:ad:8c:65:4e", tenant: 7, model_id: 64, template_id: 16 }],
    accounts: [{ device_id: 24, phone_device_id: 29 }],
    templates: [{ id: 16, model_id: 64, tenant: 7, shared: "no" }],
  });
  const w = writer({}, pbx);
  const out = await ensureProvisioningRecord(w.deps, {
    pbxTenantNumber: LANDAU, mac: "c0:74:ad:8c:65:4e", vendor: "grandstream", model: "GXP2170", extNumber: "101",
  });
  assert.equal(out.kind, "written");
  if (out.kind === "written") assert.equal(out.rehomedFromTenant, 7);
  assert.deepEqual(w.rehomes, [{ mac: "c074ad8c654e", fromTenant: 7, toTenant: LANDAU, extNumber: "101" }]);
  assert.equal(w.saved[0].phoneId, 24, "UPDATE the row — a MAC may exist exactly once");
});

test("a failed audit stops the move — the phone is not taken without a record of where from", async () => {
  const pbx = fakePbx({
    devices: [{ id: 24, mac: "c0:74:ad:8c:65:4e", tenant: 7, model_id: 64, template_id: 16 }],
    accounts: [{ device_id: 24, phone_device_id: 29 }],
    templates: [{ id: 16, model_id: 64, tenant: 7, shared: "no" }],
  });
  const w = writer({ auditRehome: async () => { throw new Error("audit down"); } }, pbx);
  const out = await ensureProvisioningRecord(w.deps, {
    pbxTenantNumber: LANDAU, mac: "c0:74:ad:8c:65:4e", vendor: "grandstream", model: "GXP2170", extNumber: "101",
  });
  assert.equal(out.kind, "unavailable");
  assert.equal(w.saved.length, 0, "nothing may be written without the move recorded");
});

test("a row that is already right is adopted and nothing is written", async () => {
  // ⛔ Re-rendering a working phone's config for no reason is how a wizard turns a
  // healthy handset into a support call.
  const pbx = fakePbx({
    devices: [{ id: 52, mac: "ec:74:d7:20:1f:ea", tenant: LANDAU, model_id: 305, template_id: 24 }],
    accounts: [{ device_id: 52, phone_device_id: DESK }],
  });
  const w = writer({}, pbx);
  const out = await ensureProvisioningRecord(w.deps, {
    pbxTenantNumber: LANDAU, mac: "EC:74:D7:20:1F:EA", vendor: "grandstream", model: "HT801", extNumber: "101",
  });
  assert.equal(out.kind, "adopted");
  assert.equal(w.saved.length, 0);
});

test("the HT801 bound to a device that does not exist is repaired", async () => {
  // ⛔ Landau Home has 130 and 191 and nothing else. Bound to 149 the row renders no
  // account at all, so the one phone whose record looked correct could never register.
  const pbx = fakePbx({
    devices: [{ id: 52, mac: "ec:74:d7:20:1f:ea", tenant: LANDAU, model_id: 305, template_id: 24 }],
    accounts: [{ device_id: 52, phone_device_id: 149 }],
  });
  const w = writer({}, pbx);
  const out = await ensureProvisioningRecord(w.deps, {
    pbxTenantNumber: LANDAU, mac: "EC:74:D7:20:1F:EA", vendor: "grandstream", model: "HT801", extNumber: "101",
  });
  assert.equal(out.kind, "written");
  if (out.kind === "written") assert.equal(out.rebound, true);
  assert.deepEqual(w.saved[0].accounts, [DESK]);
  assert.equal(w.saved[0].templateId, 24, "its own profile is kept");
});

test("no settings profile means REFUSED, never a row that renders nothing", async () => {
  // ⛔⛔ save_phone accepts a null template_id without complaint: the INSERT lands, the
  // generator runs, and the phone fetches a file with nothing in it. Writing that would
  // leave the customer with a dead phone and a wizard that believed it worked.
  const pbx = fakePbx({ templates: [] });
  const w = writer({}, pbx);
  const out = await ensureProvisioningRecord(w.deps, YEALINK);
  assert.equal(out.kind, "refused");
  if (out.kind !== "refused") return;
  assert.equal(out.reason, "no_settings_profile");
  assert.equal(w.saved.length, 0);
  assert.ok(!/template|provisioning\.|model id/i.test(out.customerMessage), out.customerMessage);
});

test("an unreachable phone system never fails the assignment", async () => {
  // ⛔ The person has already done their part. Telling them it failed is a job for the
  // screen; an exception here would lose the choice they just made.
  const w = writer({ query: async () => null });
  const out = await ensureProvisioningRecord(w.deps, YEALINK);
  assert.equal(out.kind, "unavailable");
});

test("a save that throws is reported, and mac_already_used says what it means", async () => {
  const generic = writer({ savePhone: async () => { throw new Error("helper timeout"); } });
  assert.equal((await ensureProvisioningRecord(generic.deps, YEALINK)).kind, "unavailable");

  const clash = writer({ savePhone: async () => { throw new Error("ValueError: mac_already_used"); } });
  const out = await ensureProvisioningRecord(clash.deps, YEALINK);
  assert.equal(out.kind, "refused");
  if (out.kind === "refused") assert.equal(out.reason, "mac_already_used");
});

/* ── the reader ──────────────────────────────────────────────────────────── */

test("the device lookup searches EVERY tenant, not just this customer's", async () => {
  // ⛔⛔ Scoping it to the customer's own tenant reports Izzy's three re-homed phones
  // as having no record, and the INSERT that follows hits `mac_already_used` — a clash
  // the wizard cannot explain because it never saw the row.
  const pbx = fakePbx({
    devices: [{ id: 1, mac: "c0:74:ad:e5:79:37", tenant: 2, model_id: 303, template_id: 1 }],
    accounts: [{ device_id: 1, phone_device_id: 3 }],
  });
  const ctx = await readRecordContext(pbx.query, { pbxTenantNumber: LANDAU, mac: "C0:74:AD:E5:79:37", extNumber: "101" });
  assert.ok(ctx.existing, "a row on tenant 2 must still be found");
  assert.equal(ctx.existing!.pbxTenantNumber, 2);
  assert.ok(!pbx.seen.some((s) => /provisioning\.devices[\s\S]*tenant\s*=/.test(s)), "the device lookup must not filter by tenant");
});

test("'shared' is read as VitalPBX writes it — the string 'yes'", async () => {
  // ⛔ Truthy-reading it makes EVERY profile look shared and hands one customer's
  // settings to another; boolean-only reading makes none of them shared and leaves
  // every new model needing a profile nobody has made.
  const pbx = fakePbx({
    templates: [
      { id: 90, model_id: 154, tenant: null, shared: "yes" },
      { id: 91, model_id: 154, tenant: 7, shared: "no" },
    ],
  });
  const ctx = await readRecordContext(pbx.query, { pbxTenantNumber: LANDAU, mac: "80:5e:c0:b3:b2:d0", extNumber: "101" });
  assert.deepEqual(ctx.templates.map((t) => [t.id, t.shared]), [[90, true], [91, false]]);
});

test("the desk endpoint is matched exactly, so the softphone can never win", async () => {
  const pbx = fakePbx({
    ombuDevices: [
      { device_id: SOFTPHONE, user: "101_1" },
      { device_id: DESK, user: "101" },
      { device_id: 500, user: "1010" },
    ],
  });
  const ctx = await readRecordContext(pbx.query, { pbxTenantNumber: LANDAU, mac: "80:5e:c0:b3:b2:d0", extNumber: "101" });
  assert.equal(ctx.deskDeviceId, DESK);
  assert.deepEqual(ctx.liveDeviceIds.sort((a, b) => a - b), [DESK, SOFTPHONE, 500]);
});

test("a failed side read costs that fact and never the whole decision", async () => {
  const pbx = fakePbx({ failOn: /provisioning\.templates/ });
  const ctx = await readRecordContext(pbx.query, { pbxTenantNumber: LANDAU, mac: "80:5e:c0:b3:b2:d0", extNumber: "101" });
  assert.deepEqual(ctx.templates, []);
  assert.equal(ctx.deskDeviceId, DESK, "the rest of the read still happened");
});

test("line keys are read in order, because the first one is the primary line", async () => {
  const pbx = fakePbx({
    devices: [{ id: 52, mac: "ec:74:d7:20:1f:ea", tenant: LANDAU, model_id: 305, template_id: 24 }],
    accounts: [{ device_id: 52, phone_device_id: DESK }, { device_id: 52, phone_device_id: null }],
  });
  const ctx = await readRecordContext(pbx.query, { pbxTenantNumber: LANDAU, mac: "EC:74:D7:20:1F:EA", extNumber: "101" });
  assert.deepEqual(ctx.existing!.boundDeviceIds, [DESK, null]);
  assert.ok(pbx.seen.some((s) => /provisioning\.accounts[\s\S]*ORDER BY id/.test(s)), "accounts must be read in order");
});

/* ── moving a record off another customer (2026-09-14) ───────────────────── */

const RIG_PUBLIC = "50.48.58.53";
/** Izzy's GXP2170: provisioning.devices id 24 on tenant 7, bound to ombu device 29 (`106`). */
const GXP_106 = {
  pbxTenantNumber: LANDAU, mac: "c0:74:ad:8c:65:4e", vendor: "grandstream", model: "GXP2170", extNumber: "101",
  discoveredIp: "192.168.6.171", requesterIp: RIG_PUBLIC,
};
function heldByCreateABox() {
  return fakePbx({
    devices: [{ id: 24, mac: "c0:74:ad:8c:65:4e", tenant: 7, model_id: 64, template_id: 16 }],
    accounts: [{ device_id: 24, phone_device_id: 29 }],
    templates: [{ id: 16, model_id: 64, tenant: 7, shared: "no" }],
    boundDevices: [{ device_id: 29, user: "106", tenant_id: 7 }],
  });
}
const reg = (contactUri: string) => ({ endpoint: "T7_106", status: "REGISTERED", lastRegisteredAt: new Date(), contactUri });

test("another company's extension live on a DIFFERENT device releases the move — the wizard on the phone's own network wins (Izzy, 2026-09-15)", async () => {
  // ⛔ SUPERSEDES the pre-7e427c28 rule that refused here. A live registration by a
  // DIFFERENT device (different LAN address, different public address) no longer blocks:
  // releasing a MAC's record never touches that device's registration, so the old halt
  // stranded a run on "Support needs to finish" over a provably stale record. The two
  // fences that still refuse are the forger shape and a missing presence pair (sibling
  // tests below). Here the handset is standing on the requesting customer's own network,
  // so the record moves and the endpoint left standing is recorded as moved-from.
  const asked: string[][] = [];
  const w = writer({
    registrations: async (eps: string[]) => {
      asked.push(eps);
      return [reg("sip:T7_106@45.14.194.179:5060;x-ast-orig-host=192.168.8.160:5060")];
    },
  }, heldByCreateABox());
  const out = await ensureProvisioningRecord(w.deps, GXP_106);
  assert.equal(out.kind, "written");
  if (out.kind !== "written") return;
  assert.equal(out.rehomedFromTenant, 7);
  assert.deepEqual(asked, [["T7_106"]], "the bare `106` must be composed into the endpoint the PBX actually names");
  assert.equal(w.saved[0].phoneId, 24, "UPDATE the row — a MAC may exist exactly once");
  assert.deepEqual(w.rehomes, [{ mac: "c074ad8c654e", fromTenant: 7, toTenant: LANDAU, extNumber: "101" }],
    "the move off the other tenant is recorded, even though its device stays registered");
});

test("the only live registration being THIS handset on THIS network lets the move happen", async () => {
  const w = writer({
    registrations: async () => [reg("sip:T7_106@50.48.58.53:36493;x-ast-orig-host=192.168.6.171:5060")],
  }, heldByCreateABox());
  const out = await ensureProvisioningRecord(w.deps, GXP_106);
  assert.equal(out.kind, "written");
  assert.equal(w.rehomes.length, 1);
  assert.equal(w.saved[0].phoneId, 24, "UPDATE the row — a MAC may exist exactly once");
});

test("the same claim from another network is refused — a LAN address alone proves nothing", async () => {
  const w = writer({
    registrations: async () => [reg("sip:T7_106@50.48.58.53:36493;x-ast-orig-host=192.168.6.171:5060")],
  }, heldByCreateABox());
  const out = await ensureProvisioningRecord(w.deps, { ...GXP_106, requesterIp: "203.0.113.9" });
  // ⛔ The REASON is asserted, not just "refused": replayed against the previous writer,
  // a bare kind check passed for the wrong reason ("no desk device").
  assert.equal(out.kind === "refused" && out.reason, "held_by_another_account");
  assert.equal(w.saved.length, 0);
});

test("registration state that cannot be read refuses the move", async () => {
  const w = writer({ registrations: async () => { throw new Error("db down"); } }, heldByCreateABox());
  const out = await ensureProvisioningRecord(w.deps, GXP_106);
  assert.equal(out.kind === "refused" && out.reason, "held_by_another_account");
  assert.equal(w.saved.length, 0);
});

test("no registration source at all refuses the move — never allowed on missing evidence", async () => {
  const w = writer({ registrations: undefined }, heldByCreateABox());
  const out = await ensureProvisioningRecord(w.deps, GXP_106);
  assert.equal(out.kind === "refused" && out.reason, "held_by_another_account");
  assert.equal(w.saved.length, 0);
});

test("a bound-device read that fails leaves everything untouched", async () => {
  const pbx = fakePbx({
    devices: [{ id: 24, mac: "c0:74:ad:8c:65:4e", tenant: 7, model_id: 64, template_id: 16 }],
    accounts: [{ device_id: 24, phone_device_id: 29 }],
    templates: [{ id: 16, model_id: 64, tenant: 7, shared: "no" }],
    failOn: /device_id IN \(/,
  });
  const w = writer({}, pbx);
  const out = await ensureProvisioningRecord(w.deps, GXP_106);
  assert.equal(out.kind, "unavailable");
  assert.equal(w.saved.length, 0);
});

test("a phone that is not being moved never asks about registrations", async () => {
  let asked = 0;
  const w = writer({ registrations: async () => { asked += 1; return []; } });
  await ensureProvisioningRecord(w.deps, YEALINK);
  assert.equal(asked, 0, "only a MOVE needs proof of presence");
});
