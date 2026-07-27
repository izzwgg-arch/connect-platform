// Stress tests for the VoIP.ms number stage (voipMsProvisioning.ts): the
// company subaccount, new-number ordering vs routing an already-owned DID,
// port-in submission + temporary number selection, SMS, the safety gate
// (VOIPMS_AUTO_PROVISION), idempotency, and failure recording.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

// ── DB mock ───────────────────────────────────────────────────────────────────

const state = {
  submissions: new Map<string, any>(),
  events: [] as Array<{ submissionId: string; message: string }>,
  voipmsConfig: null as any,
};

mock.module("@connect/db", {
  namedExports: {
    db: {
      globalVoipMsConfig: {
        findUnique: async () => state.voipmsConfig,
      },
      onboardingSubmission: {
        findUnique: async ({ where }: any) => state.submissions.get(where.id) || null,
        update: async ({ where, data }: any) => {
          const row = state.submissions.get(where.id);
          Object.assign(row, data);
          return row;
        },
      },
      onboardingEvent: {
        create: async ({ data }: any) => {
          state.events.push({ submissionId: data.submissionId, message: data.message });
          return data;
        },
      },
    },
  },
});

mock.module("@connect/security", {
  namedExports: {
    encryptJson: (v: unknown) => "enc:" + JSON.stringify(v),
    decryptJson: (s: string) => JSON.parse(String(s).replace(/^enc:/, "")),
  },
});

let mod: typeof import("./voipMsProvisioning");
test.before(async () => {
  mod = await import("./voipMsProvisioning");
});

// ── VoIP.ms REST fake ─────────────────────────────────────────────────────────

type VmsCall = { method: string; params: Record<string, string> };
let vmsCalls: VmsCall[] = [];
let vmsHandlers: Record<string, (params: Record<string, string>) => any> = {};
let fetchForbidden = false;

const realFetch = globalThis.fetch;
function installVmsFetch() {
  (globalThis as any).fetch = async (url: string) => {
    if (fetchForbidden) throw new Error("fetch must not be called in dry-run mode");
    const u = new URL(url);
    const params: Record<string, string> = {};
    u.searchParams.forEach((v, k) => (params[k] = v));
    const method = params.method;
    vmsCalls.push({ method, params });
    const handler = vmsHandlers[method];
    const body = handler ? handler(params) : { status: "success" };
    return { json: async () => body } as any;
  };
}

function reset(opts: { live?: boolean } = {}) {
  state.submissions.clear();
  state.events = [];
  state.voipmsConfig = {
    id: "default",
    credentialsEncrypted: "enc:" + JSON.stringify({ username: "344022", password: "masterpw" }),
    apiBaseUrl: null,
  };
  vmsCalls = [];
  vmsHandlers = {
    getServersInfo: () => ({
      status: "success",
      servers: [
        { server_name: "Chicago 1", server_pop: "21" },
        { server_name: "New York 1", server_pop: "23" },
      ],
    }),
    getSubAccounts: () => ({ status: "success", accounts: [] }),
    createSubAccount: (p) => ({ status: "success", account: `344022_${p.username}` }),
    getDIDsInfo: () => ({ status: "success", dids: [] }),
    orderDID: () => ({ status: "success" }),
    setDIDRouting: () => ({ status: "success" }),
    setSMS: () => ({ status: "success" }),
    addLNPPort: () => ({ status: "success", portid: "P123" }),
    searchDIDsUSA: () => ({ status: "success", dids: [{ did: "9295551234" }] }),
  };
  fetchForbidden = !opts.live && false;
  if (opts.live) process.env.VOIPMS_AUTO_PROVISION = "on";
  else delete process.env.VOIPMS_AUTO_PROVISION;
  installVmsFetch();
}

test.afterEach(() => {
  (globalThis as any).fetch = realFetch;
  delete process.env.VOIPMS_AUTO_PROVISION;
});

function seedSubmission(over: Partial<any> = {}): string {
  const id = over.id || "sub1";
  state.submissions.set(id, {
    id,
    companyName: "Bobs Plumbing",
    phoneNumberChoice: "new",
    smsEnabled: false,
    numberStatus: null,
    provisionedDid: null,
    didIsTemporary: false,
    voipmsSubaccountEncrypted: null,
    answers: { phone: { choice: "new", selectedNumber: "(845) 557-7726", details: {} } },
    uploadedFiles: [],
    updatedAt: new Date(),
    ...over,
  });
  return id;
}

const calls = (method: string) => vmsCalls.filter((c) => c.method === method);

// ── Dry-run (gate off — the default) ─────────────────────────────────────────

test("dry-run new number: ready state + credentials generated, ZERO VoIP.ms calls", async () => {
  reset();
  fetchForbidden = true; // any fetch throws
  const id = seedSubmission();
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  assert.equal(res.live, false);

  const row = state.submissions.get(id);
  assert.equal(row.numberStatus, "ready_dryrun"); // distinct so a LIVE run can redo it
  assert.equal(row.provisionedDid, "8455577726");
  assert.equal(row.didIsTemporary, false);
  const sub = JSON.parse(row.voipmsSubaccountEncrypted.replace(/^enc:/, ""));
  assert.equal(sub.username, "344022_BobsPlumbing1");
  assert.equal(sub.server, "newyork1.voip.ms");
  assert.ok(sub.password.length >= 12);
  assert.ok(state.events.some((e) => e.message.includes("[dry-run]")));
});

test("dry-run port: temporary number flagged, port logged, nothing charged", async () => {
  reset();
  fetchForbidden = true;
  const id = seedSubmission({
    phoneNumberChoice: "port",
    answers: { phone: { choice: "port", details: { numbers: "(212) 555-0000", carrier: "AT&T", accountNumber: "A1" } } },
  });
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  const row = state.submissions.get(id);
  assert.equal(row.numberStatus, "ready_dryrun");
  assert.equal(row.didIsTemporary, true);
  assert.ok(state.events.some((e) => /submit port-in for 2125550000/i.test(e.message)));
});

// ── Live mode ─────────────────────────────────────────────────────────────────

test("live new number (not owned): subaccount + orderDID with NY pop, routed to subaccount", async () => {
  reset({ live: true });
  const id = seedSubmission();
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  assert.equal(res.live, true);

  const create = calls("createSubAccount");
  assert.equal(create.length, 1);
  assert.equal(create[0].params.username, "BobsPlumbing1");
  assert.equal(create[0].params.device_type, "1"); // Asterisk / IP-PBX (2 would be ATA/IP phone)
  assert.equal(create[0].params.protocol, "1");
  assert.equal(create[0].params.callerid_number, undefined); // own-device CallerID: not set

  const order = calls("orderDID");
  assert.equal(order.length, 1);
  assert.equal(order[0].params.did, "8455577726");
  assert.equal(order[0].params.routing, "account:344022_BobsPlumbing1");
  assert.equal(order[0].params.pop, "23"); // New York 1
  assert.equal(calls("setDIDRouting").length, 0);
  assert.equal(calls("setSMS").length, 0); // sms off

  const row = state.submissions.get(id);
  assert.equal(row.numberStatus, "ready");
  assert.equal(row.provisionedDid, "8455577726");
});

test("live new number ALREADY in our account: routed, not re-purchased", async () => {
  reset({ live: true });
  vmsHandlers.getDIDsInfo = (p) =>
    p.did === "8455577726"
      ? { status: "success", dids: [{ did: "8455577726", routing: "account:344022" }] }
      : { status: "success", dids: [] };
  const id = seedSubmission();
  await mod.applyOnboardingNumber(id);
  assert.equal(calls("orderDID").length, 0);
  const route = calls("setDIDRouting");
  assert.equal(route.length, 1);
  assert.equal(route[0].params.routing, "account:344022_BobsPlumbing1");
});

test("live new number with SMS add-on: setSMS enable=1 on the DID", async () => {
  reset({ live: true });
  const id = seedSubmission({ smsEnabled: true });
  await mod.applyOnboardingNumber(id);
  const sms = calls("setSMS");
  assert.equal(sms.length, 1);
  assert.equal(sms[0].params.did, "8455577726");
  assert.equal(sms[0].params.enable, "1");
});

test("live port with a spare DID in the account: port filed + spare used as temporary", async () => {
  reset({ live: true });
  vmsHandlers.getDIDsInfo = () => ({
    status: "success",
    dids: [
      { did: "7185550001", routing: "account:344022_SomeCustomer1" }, // taken (subaccount)
      { did: "9145550002", routing: "account:344022" }, // spare (main account)
    ],
  });
  const id = seedSubmission({
    phoneNumberChoice: "port",
    answers: { phone: { choice: "port", details: { numbers: "2125550000", carrier: "Verizon", accountNumber: "V9", portPin: "1234", nameOnAccount: "Bob", serviceAddress: "1 Main St" } } },
  });
  await mod.applyOnboardingNumber(id);

  const port = calls("addLNPPort");
  assert.equal(port.length, 1);
  assert.equal(port[0].params.did, "2125550000");
  assert.equal(port[0].params.carrier, "Verizon");
  assert.equal(port[0].params.pin, "1234");

  assert.equal(calls("orderDID").length, 0); // spare found — nothing bought
  const route = calls("setDIDRouting");
  assert.equal(route[0].params.did, "9145550002");
  assert.equal(route[0].params.routing, "account:344022_BobsPlumbing1");

  const row = state.submissions.get(id);
  assert.equal(row.provisionedDid, "9145550002");
  assert.equal(row.didIsTemporary, true);
});

test("live port with NO spare DID: buys a temporary number", async () => {
  reset({ live: true });
  vmsHandlers.getDIDsInfo = () => ({
    status: "success",
    dids: [{ did: "7185550001", routing: "account:344022_SomeCustomer1" }],
  });
  const id = seedSubmission({
    phoneNumberChoice: "port",
    answers: { phone: { choice: "port", details: { numbers: "2125550000", carrier: "Verizon", accountNumber: "V9" } } },
  });
  await mod.applyOnboardingNumber(id);
  const order = calls("orderDID");
  assert.equal(order.length, 1);
  assert.equal(order[0].params.did, "9295551234"); // first search result
  const row = state.submissions.get(id);
  assert.equal(row.provisionedDid, "9295551234");
  assert.equal(row.didIsTemporary, true);
});

test("live: existing subaccount is reused with a rotated password (idempotent re-run)", async () => {
  reset({ live: true });
  vmsHandlers.getSubAccounts = () => ({
    status: "success",
    accounts: [{ id: "77", account: "344022_BobsPlumbing1" }],
  });
  const id = seedSubmission();
  await mod.applyOnboardingNumber(id);
  assert.equal(calls("createSubAccount").length, 0);
  const rotate = calls("setSubAccount");
  assert.equal(rotate.length, 1);
  assert.equal(rotate[0].params.id, "77");
  assert.ok(rotate[0].params.password.length >= 12);
});

test("live: existing-subaccount match works when the master username is a login EMAIL", async () => {
  // VoIP.ms prefixes subaccounts with the ACCOUNT NUMBER, never the API
  // username — when the API username is an email ("izzy@x.com"), the old
  // exact-match ("izzy@x.com_BobsPlumbing1") never hit and re-runs crashed
  // on duplicate creation. Suffix matching must find "123456_BobsPlumbing1".
  reset({ live: true });
  state.voipmsConfig = { credentialsEncrypted: "enc:" + JSON.stringify({ username: "izzy@x.com", password: "pw" }) };
  vmsHandlers.getSubAccounts = () => ({
    status: "success",
    accounts: [{ id: "88", account: "123456_BobsPlumbing1" }],
  });
  vmsHandlers.getDIDsInfo = () => ({ status: "success", dids: [] });
  const id = seedSubmission();
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  assert.equal(calls("createSubAccount").length, 0); // reused, not duplicated
  assert.equal(calls("setSubAccount")[0].params.id, "88");
  const sub = JSON.parse(state.submissions.get(id).voipmsSubaccountEncrypted.replace(/^enc:/, ""));
  assert.equal(sub.username, "123456_BobsPlumbing1"); // provider's name, not email-derived
});

// ── Guards, idempotency, failure ─────────────────────────────────────────────

test("already ready: skips without touching anything", async () => {
  reset({ live: true });
  const id = seedSubmission({ numberStatus: "ready" });
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.detail, "already_ready");
  assert.equal(vmsCalls.length, 0);
});

test("already provisioning (in flight): refuses to double-run", async () => {
  reset({ live: true });
  const id = seedSubmission({ numberStatus: "provisioning" });
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, false);
  assert.equal(res.detail, "already_running");
  assert.equal(vmsCalls.length, 0);
});

test("STALE provisioning (API died mid-run): resumes instead of blocking forever", async () => {
  reset({ live: true });
  const id = seedSubmission({
    numberStatus: "provisioning",
    updatedAt: new Date(Date.now() - 11 * 60_000), // beyond the 10-min stale window
  });
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  assert.equal(state.submissions.get(id).numberStatus, "ready");
});

test("VoIP.ms rejection marks the stage failed with the provider's error", async () => {
  reset({ live: true });
  vmsHandlers.createSubAccount = () => ({ status: "invalid_credentials" });
  const id = seedSubmission();
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, false);
  const row = state.submissions.get(id);
  assert.equal(row.numberStatus, "failed");
  assert.match(row.setupError, /createSubAccount failed: invalid_credentials/);
});

test("master account unconfigured: failed with provider_unconfigured", async () => {
  reset({ live: true });
  state.voipmsConfig = null;
  const id = seedSubmission();
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.detail, "provider_unconfigured");
  assert.equal(state.submissions.get(id).numberStatus, "failed");
});

test("new number without a selection: failed, recorded on the submission", async () => {
  reset({ live: true });
  const id = seedSubmission({ answers: { phone: { choice: "new", selectedNumber: "" } } });
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, false);
  assert.match(state.submissions.get(id).setupError, /no_number_selected/);
});

test("failed stage can be retried and succeed", async () => {
  reset({ live: true });
  vmsHandlers.createSubAccount = () => ({ status: "boom" });
  const id = seedSubmission();
  await mod.applyOnboardingNumber(id);
  assert.equal(state.submissions.get(id).numberStatus, "failed");

  vmsHandlers.createSubAccount = (p) => ({ status: "success", account: `344022_${p.username}` });
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  assert.equal(state.submissions.get(id).numberStatus, "ready");
});

test("subaccount naming strips punctuation and caps length", () => {
  assert.equal(mod.subAccountName("Bob's Plumbing & Heating"), "BobsPlumbingHeatin1");
  assert.equal(mod.subAccountName(""), "account1");
  assert.equal(mod.subAccountName("J&J"), "JJ1");
});

test("stress: 20 parallel dry-run submissions all land ready with distinct subaccounts", async () => {
  reset();
  const ids = Array.from({ length: 20 }, (_, i) =>
    seedSubmission({
      id: `s${i}`,
      companyName: `Company ${i}`,
      answers: { phone: { choice: "new", selectedNumber: `845555${String(1000 + i)}` } },
    }),
  );
  const results = await Promise.all(ids.map((id) => mod.applyOnboardingNumber(id)));
  assert.ok(results.every((r) => r.ok));
  const subs = ids.map((id) => JSON.parse(state.submissions.get(id).voipmsSubaccountEncrypted.replace(/^enc:/, "")).username);
  assert.equal(new Set(subs).size, 20);
});
