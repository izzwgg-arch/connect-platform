import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  applyAlternatives,
  e911Params,
  ensureE911ForDid,
  ensureE911ForSubmission,
  setSubaccountDefaultE911,
  type E911Address,
} from "./voipMsE911";

const CREDS = { username: "api@connect.test", password: "secret" };
const DID = "8455551234";

const ADDRESS: E911Address = {
  fullName: "Acme Bakery",
  streetNumber: "30",
  streetName: "Robert Pitt Dr",
  addressType: "Suite",
  addressNumber: "200",
  city: "Monsey",
  state: "NY",
  zip: "10952",
  country: "US",
  email: "owner@acme.test",
  otherInfo: "",
};

const SUBMISSION = {
  id: "sub_1",
  companyName: "Acme Bakery",
  mainEmail: "owner@acme.test",
  answers: {
    contact: { address: "30 Robert Pitt Dr Suite 200", addressCity: "Monsey", addressState: "NY", addressZip: "10952" },
  },
};

/** VoIP.ms's own failure shape: our vms() throws and hangs the body off the error. */
function vmsError(status: string, body: Record<string, unknown> = {}): Error {
  const e: any = new Error(`voipms failed: ${status}`);
  e.voipmsResponse = { status, ...body };
  return e;
}

type Call = { method: string; params: Record<string, string> };

/** A fake provider driven by a per-method script. */
function fakeVms(script: Record<string, Array<any>>) {
  const calls: Call[] = [];
  const cursor: Record<string, number> = {};
  const vms = async (_c: any, method: string, params: Record<string, string> = {}) => {
    calls.push({ method, params });
    const queue = script[method];
    if (!queue) throw new Error(`unscripted call: ${method}`);
    const i = Math.min(cursor[method] ?? 0, queue.length - 1);
    cursor[method] = (cursor[method] ?? 0) + 1;
    const next = queue[i];
    if (next instanceof Error) throw next;
    return next;
  };
  return { vms, calls };
}

function deps(script: Record<string, Array<any>>) {
  const { vms, calls } = fakeVms(script);
  const logs: string[] = [];
  return { deps: { vms, log: (m: string) => { logs.push(m); } }, calls, logs };
}

/** Not registered yet — this is how VoIP.ms says so (proven live). */
const NOT_REGISTERED = vmsError("e911_disable");

// ── The parameter names ───────────────────────────────────────────────────────

test("the REST parameter names are the PROVEN ones, not the WSDL's", () => {
  const p = e911Params(DID, ADDRESS);
  // ⛔ The WSDL says `zip`; the live REST API answers missing_zip for it and
  // only accepts zip_code. And it requires `email`, which the WSDL omits.
  assert.equal(p.zip_code, "10952");
  assert.equal(p.zip, undefined);
  assert.equal(p.email, "owner@acme.test");
  // street_number must be its own field or the call is refused.
  assert.equal(p.street_number, "30");
  assert.equal(p.street_name, "Robert Pitt Dr");
  // Every field VoIP.ms requires is present.
  for (const required of ["did", "full_name", "street_number", "street_name", "city", "state", "country", "zip_code", "email", "language"]) {
    assert.ok(String(p[required] || "").length > 0, `${required} must be sent`);
  }
});

test("a unit designator outside VoIP.ms's published list is dropped, not guessed", () => {
  const p = e911Params(DID, { ...ADDRESS, addressType: "Pod" });
  assert.equal(p.address_type, "");
  assert.equal(e911Params(DID, ADDRESS).address_type, "Suite");
});

// ── The correction loop ───────────────────────────────────────────────────────

test("applyAlternatives takes VoIP.ms's own correction", () => {
  // The real answer for a Monsey address, captured live 2026-08-17.
  const { next, corrected } = applyAlternatives(ADDRESS, { street_name: ["ROBERT PITT DR"], city: ["SPRING VALLEY"] });
  assert.equal(next.city, "SPRING VALLEY");
  assert.equal(corrected.length, 1, "the street only changed in case, so only the city moved");
  assert.match(corrected[0], /city/);
});

test("applyAlternatives ignores a suggestion that only differs in case", () => {
  const { next, corrected } = applyAlternatives(ADDRESS, { street_name: ["ROBERT PITT DR"] });
  assert.equal(next.streetName, "Robert Pitt Dr");
  assert.deepEqual(corrected, []);
});

test("a near-miss address is corrected and then registered", async () => {
  // This is the path most Connect sign-ups take: the emergency database uses
  // the municipality (SPRING VALLEY), not the postal town (Monsey).
  const { deps: d, calls } = deps({
    e911Info: [NOT_REGISTERED],
    e911Validate: [vmsError("invalid_address", { alternatives: { city: ["SPRING VALLEY"] } }), { status: "success" }],
    e911Provision: [{ status: "success" }],
  });
  const r = await ensureE911ForDid(d, { creds: CREDS, did: DID, address: ADDRESS, live: true });

  assert.equal(r.status, "provisioned");
  assert.equal(r.needsAttention, false);
  assert.deepEqual(r.corrected, ["city → SPRING VALLEY"]);
  // ⛔ It must PROVISION THE CORRECTED ADDRESS, not the one that was refused.
  const provision = calls.find((c) => c.method === "e911Provision")!;
  assert.equal(provision.params.city, "SPRING VALLEY");
  assert.equal(provision.params.did, DID);
});

test("an address that cannot be validated is NEVER provisioned", async () => {
  // Registering an unvalidated address sends an ambulance to the wrong house.
  const { deps: d, calls } = deps({
    e911Info: [NOT_REGISTERED],
    e911Validate: [vmsError("invalid_address")],
  });
  const r = await ensureE911ForDid(d, { creds: CREDS, did: DID, address: ADDRESS, live: true });

  assert.equal(r.status, "address_invalid");
  assert.equal(r.needsAttention, true, "a human has to fix this");
  assert.equal(calls.filter((c) => c.method === "e911Provision").length, 0);
});

test("it gives up after ONE correction round rather than looping", async () => {
  const { deps: d, calls } = deps({
    e911Info: [NOT_REGISTERED],
    e911Validate: [
      vmsError("invalid_address", { alternatives: { city: ["SPRING VALLEY"] } }),
      vmsError("invalid_address", { alternatives: { city: ["MONSEY"] } }),
    ],
  });
  const r = await ensureE911ForDid(d, { creds: CREDS, did: DID, address: ADDRESS, live: true });

  assert.equal(r.status, "address_invalid");
  assert.equal(r.needsAttention, true);
  assert.equal(calls.filter((c) => c.method === "e911Validate").length, 2);
  assert.equal(calls.filter((c) => c.method === "e911Provision").length, 0);
});

// ── Doing it once ─────────────────────────────────────────────────────────────

test("a DID that already has 911 is left completely alone", async () => {
  const { deps: d, calls } = deps({ e911Info: [{ status: "success", e911: { address: "somewhere" } }] });
  const r = await ensureE911ForDid(d, { creds: CREDS, did: DID, address: ADDRESS, live: true });

  assert.equal(r.status, "already_registered");
  assert.equal(r.needsAttention, false);
  assert.deepEqual(calls.map((c) => c.method), ["e911Info"], "no validate, no provision, no second charge");
});

test("an OUTAGE is not read as 'not registered' — that would re-register and re-charge", async () => {
  // The trap: our vms() throws for every non-success status, so a provider
  // outage and "this DID has no 911" arrive as the same kind of exception.
  const { deps: d, calls } = deps({ e911Info: [new Error("voipms e911Info failed: provider_unreachable (timeout)")] });
  const r = await ensureE911ForDid(d, { creds: CREDS, did: DID, address: ADDRESS, live: true });

  assert.equal(r.status, "failed");
  assert.equal(r.needsAttention, true);
  assert.equal(calls.filter((c) => c.method === "e911Provision").length, 0);
});

test("the purchase gate keeps a dry run dry", async () => {
  const { deps: d, calls, logs } = deps({});
  const r = await ensureE911ForDid(d, { creds: CREDS, did: DID, address: ADDRESS, live: false });

  assert.equal(r.status, "dry_run");
  assert.deepEqual(calls, [], "nothing may be registered or billed with the gate off");
  assert.match(logs[0], /\[dry-run\]/);
});

// ── From a submission ─────────────────────────────────────────────────────────

test("a sign-up registers 911 from the address the customer typed", async () => {
  const { deps: d, calls } = deps({
    e911Info: [NOT_REGISTERED],
    e911Validate: [{ status: "success" }],
    e911Provision: [{ status: "success" }],
  });
  const r = await ensureE911ForSubmission(d, { creds: CREDS, did: DID, row: SUBMISSION, live: true });

  assert.equal(r.status, "provisioned");
  const provision = calls.find((c) => c.method === "e911Provision")!;
  assert.equal(provision.params.street_number, "30");
  assert.equal(provision.params.street_name, "Robert Pitt Dr");
  assert.equal(provision.params.address_type, "Suite");
  assert.equal(provision.params.city, "Monsey");
  assert.equal(provision.params.zip_code, "10952");
  assert.equal(provision.params.full_name, "Acme Bakery");
});

test("a sign-up with no usable address says so loudly and calls nothing", async () => {
  const { deps: d, calls, logs } = deps({});
  const r = await ensureE911ForSubmission(d, {
    creds: CREDS, did: DID, live: true,
    row: { id: "s", companyName: "Acme", mainEmail: "a@b.test", answers: { contact: {} } },
  });

  assert.equal(r.status, "address_incomplete");
  assert.equal(r.needsAttention, true);
  assert.deepEqual(calls, []);
  assert.match(logs.join(" "), /by hand/i, "the timeline must tell someone to finish it");
});

test("nothing thrown by the provider escapes — a paid sign-up must still come up", async () => {
  const { deps: d } = deps({
    e911Info: [NOT_REGISTERED],
    e911Validate: [{ status: "success" }],
    e911Provision: [new Error("voipms e911Provision failed: provider_unreachable (timeout)")],
  });
  const r = await ensureE911ForDid(d, { creds: CREDS, did: DID, address: ADDRESS, live: true });
  assert.equal(r.status, "failed");
  assert.equal(r.needsAttention, true);
});

// ── The trunk's fallback ──────────────────────────────────────────────────────

const SUBACCOUNT = {
  id: "77", account: "344022_Acme", password: "trunkpass", auth_type: "1", protocol: "1",
  device_type: "1", lock_international: "1", international_route: "1", music_on_hold: "default",
  allowed_codecs: "ulaw;g729", dtmf_mode: "auto", nat: "yes", default_e911: "",
};

test("setting the trunk default resends the account's OWN password", async () => {
  // ⛔ setSubAccount is a FULL update — a missing password would blank it and
  // take the customer's dial tone with it.
  const { deps: d, calls } = deps({
    getSubAccounts: [{ accounts: [SUBACCOUNT] }, { accounts: [{ ...SUBACCOUNT, default_e911: DID }] }],
    setSubAccount: [{ status: "success" }],
  });
  const r = await setSubaccountDefaultE911(d, { creds: CREDS, subUsername: "344022_Acme", did: DID });

  assert.equal(r.ok, true);
  const write = calls.find((c) => c.method === "setSubAccount")!;
  assert.equal(write.params.password, "trunkpass");
  assert.equal(write.params.default_e911, DID);
  assert.equal(write.params.nat, "yes", "existing settings must be resent, not defaulted away");
});

test("without a readable password the trunk is left untouched", async () => {
  const { deps: d, calls } = deps({ getSubAccounts: [{ accounts: [{ ...SUBACCOUNT, password: "" }] }] });
  const r = await setSubaccountDefaultE911(d, { creds: CREDS, subUsername: "344022_Acme", did: DID });

  assert.equal(r.ok, false);
  assert.equal(r.detail, "password_unreadable");
  assert.equal(calls.filter((c) => c.method === "setSubAccount").length, 0);
});

test("a silently-ignored default_e911 is reported, not believed", async () => {
  // The field is not in VoIP.ms's public REST docs — a success status that
  // changed nothing must not read as done.
  const { deps: d } = deps({
    getSubAccounts: [{ accounts: [SUBACCOUNT] }, { accounts: [SUBACCOUNT] }],
    setSubAccount: [{ status: "success" }],
  });
  const r = await setSubaccountDefaultE911(d, { creds: CREDS, subUsername: "344022_Acme", did: DID });
  assert.equal(r.ok, false);
  assert.equal(r.detail, "not_applied");
});

test("an already-correct trunk is not rewritten", async () => {
  const { deps: d, calls } = deps({ getSubAccounts: [{ accounts: [{ ...SUBACCOUNT, default_e911: DID }] }] });
  const r = await setSubaccountDefaultE911(d, { creds: CREDS, subUsername: "344022_Acme", did: DID });
  assert.equal(r.ok, true);
  assert.equal(r.detail, "already_set");
  assert.equal(calls.filter((c) => c.method === "setSubAccount").length, 0);
});

// ── The call sites ────────────────────────────────────────────────────────────

test("BOTH provisioning paths register 911 — a new number and a ported one", () => {
  // ⛔ This reads the CALLERS' SOURCE on purpose. Every defect of this shape in
  // this repo has been a missed call site (the two IVR publish paths, the two
  // SMS ingest paths, the two invite paths), and a unit test of the helper
  // passes straight through that.
  const dir = __dirname;
  const provisioning = fs.readFileSync(path.join(dir, "voipMsProvisioning.ts"), "utf8");
  const landing = fs.readFileSync(path.join(dir, "portLanding.ts"), "utf8");

  assert.match(
    provisioning,
    /if \(did\) await applyE911ForDid\(/,
    "the number stage must register 911 on the DID the customer starts on",
  );
  assert.match(
    landing,
    /deps\.applyE911\(/,
    "the port landing must register 911 on the real number when it arrives",
  );
  assert.match(
    landing,
    /applyE911: realApplyE911ForDid/,
    "the landing's default deps must point at the real helper, not a stub",
  );
});

test("vms() hands the failure body to callers — the corrections live there", () => {
  // applyAlternatives is fed from `err.voipmsResponse.alternatives`, and that
  // only exists because vms() attaches the whole answer to the thrown error.
  const provisioning = fs.readFileSync(path.join(__dirname, "voipMsProvisioning.ts"), "utf8");
  assert.match(provisioning, /err\.voipmsResponse = json/);
});

test("a provider outage on the ported number is retried, a refused address is not", () => {
  // The landing marks the 911 step done only for SETTLED outcomes. A "failed"
  // verdict (provider unreachable / could not tell if it was registered) must
  // stay open so the next sweep retries — otherwise the number the customer
  // KEEPS ends up with no 911 address and nothing left to notice it.
  const landing = fs.readFileSync(path.join(__dirname, "portLanding.ts"), "utf8");
  assert.match(landing, /if \(e911\.status !== "failed"\) \{\s*\n\s*await mergeLanding\(db, row, \{ e911At/);
});
