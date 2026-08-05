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
    return {
      // A handler returning a STRING simulates a Cloudflare outage page —
      // HTML instead of JSON, so .json() rejects exactly like the real thing.
      json: async () => {
        if (typeof body === "string") throw new SyntaxError("Unexpected token '<'");
        return body;
      },
    } as any;
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
    orderTollFree: () => ({ status: "success" }),
    orderVanity: () => ({ status: "success" }),
    searchTollFreeUSA: () => ({ status: "success", dids: [{ did: "8442220000" }] }),
  };
  fetchForbidden = !opts.live && false;
  if (opts.live) process.env.VOIPMS_AUTO_PROVISION = "on";
  else delete process.env.VOIPMS_AUTO_PROVISION;
  process.env.VOIPMS_RETRY_BASE_MS = "1"; // keep the outage-retry backoff instant in tests
  installVmsFetch();
}

test.afterEach(() => {
  (globalThis as any).fetch = realFetch;
  delete process.env.VOIPMS_AUTO_PROVISION;
  delete process.env.VOIPMS_RETRY_BASE_MS;
  delete process.env.ONBOARDING_STORAGE_DIR;
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
  assert.equal(sub.username, "344022_BobsPlumsub1");
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
  assert.equal(create[0].params.username, "BobsPlumsub1");
  assert.equal(create[0].params.device_type, "1"); // Asterisk / IP-PBX (2 would be ATA/IP phone)
  assert.equal(create[0].params.protocol, "1");
  assert.equal(create[0].params.callerid_number, undefined); // own-device CallerID: not set

  const order = calls("orderDID");
  assert.equal(order.length, 1);
  assert.equal(order[0].params.did, "8455577726");
  assert.equal(order[0].params.routing, "account:344022_BobsPlumsub1");
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
  assert.equal(route[0].params.routing, "account:344022_BobsPlumsub1");
});

test("listSpareDids: only unassigned account DIDs count as spare (stock to use up first)", async () => {
  reset({ live: true });
  vmsHandlers.getDIDsInfo = () => ({
    status: "success",
    dids: [
      { did: "8455550001", routing: "account:344022", ratecenter: "MONROE", state: "NY", sms: 1 },
      { did: "8455550002", routing: "account:344022_Bobs1", sms: 1 }, // assigned to a subaccount
      { did: "8455550003", routing: "vm:101" }, // not account-routed
      { did: "18455550004", routing: "account:344022", sms: 0 }, // 11-digit form still counts
    ],
  });
  const spares = await mod.listSpareDids({ username: "344022", password: "pw" });
  assert.deepEqual(spares.map((s) => s.did), ["8455550001", "8455550004"]);
  assert.equal(spares[0].location, "MONROE, NY");
  assert.equal(spares[0].sms, true);
  assert.equal(spares[1].sms, false);
});

test("GUARD: spare grabbed by ANOTHER customer meanwhile → never steals it, auto-assigns a replacement", async () => {
  // The customer has already PAID by the time this runs — a hard failure here
  // used to dead-end the whole build. Now: keep the number safe AND continue
  // with the next best DID.
  reset({ live: true });
  vmsHandlers.getDIDsInfo = () => ({
    status: "success",
    dids: [{ did: "8455577726", routing: "account:344022_SomeoneElse1" }],
  });
  const id = seedSubmission();
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  assert.equal(calls("setDIDRouting").length, 0); // the taken number is never touched
  const order = calls("orderDID");
  assert.equal(order.length, 1); // no spare in the account → a new number is bought
  assert.notEqual(order[0].params.did, "8455577726");
  const row = state.submissions.get(id);
  assert.equal(row.numberStatus, "ready");
  assert.equal(row.provisionedDid, order[0].params.did);
  assert.ok(state.events.some((e) => /taken by another customer/i.test(e.message)));
});

test("GUARD is EXACT: Acme1 must not match a number routed to Acme10 (substring trap)", async () => {
  reset({ live: true });
  // Names follow the per-submission identity scheme (id "sub1" → subaccount
  // "BobsPlumsub1"); the other customer's account is ours + "0" so an exact
  // comparison is the ONLY thing telling them apart.
  vmsHandlers.getDIDsInfo = (p) =>
    p.did === "8455577726"
      ? { status: "success", dids: [{ did: "8455577726", routing: "account:344022_BobsPlumsub10" }] }
      : {
          status: "success",
          dids: [
            { did: "8455577726", routing: "account:344022_BobsPlumsub10" },
            { did: "8455550009", routing: "account:344022", ratecenter: "MONROE", state: "NY" }, // spare, same area code
          ],
        };
  const id = seedSubmission(); // subaccount 344022_BobsPlumsub1
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  // A substring comparison ("BobsPlumsub1" inside "BobsPlumsub10") would rout
  // the taken number away from its owner. It must fall back instead.
  const route = calls("setDIDRouting");
  assert.equal(route.length, 1);
  assert.equal(route[0].params.did, "8455550009"); // same-area-code spare, not the stolen number
  assert.equal(route[0].params.routing, "account:344022_BobsPlumsub1");
  assert.equal(state.submissions.get(id).provisionedDid, "8455550009");
});

test("collision with NO spares: buys a replacement seeded with the SAME area code", async () => {
  reset({ live: true });
  vmsHandlers.getDIDsInfo = () => ({
    status: "success",
    dids: [{ did: "8455577726", routing: "account:344022_SomeoneElse1" }],
  });
  vmsHandlers.searchDIDsUSA = (p) =>
    p.query === "845"
      ? { status: "success", dids: [{ did: "8455551111" }] }
      : { status: "success", dids: [{ did: "9295551234" }] };
  const id = seedSubmission();
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  const search = calls("searchDIDsUSA");
  assert.equal(search[0].params.query, "845"); // seeded with the selected number's area code
  const order = calls("orderDID");
  assert.equal(order.length, 1);
  assert.equal(order[0].params.did, "8455551111");
});

test("resume: number already routed to OUR OWN subaccount is re-routed without error", async () => {
  reset({ live: true });
  vmsHandlers.getDIDsInfo = () => ({
    status: "success",
    dids: [{ did: "8455577726", routing: "account:344022_BobsPlumsub1" }],
  });
  const id = seedSubmission();
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  assert.equal(calls("orderDID").length, 0);
  assert.equal(calls("setDIDRouting").length, 1);
});

// ── Toll-free & vanity purchases ─────────────────────────────────────────────

test("dry-run toll-free pick: ready state, kind named in the timeline, ZERO VoIP.ms calls", async () => {
  reset();
  fetchForbidden = true;
  const id = seedSubmission({
    answers: { phone: { choice: "new", selectedNumber: "(833) 555-0100", numberKind: "tollfree" } },
  });
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  assert.equal(res.live, false);
  const row = state.submissions.get(id);
  assert.equal(row.numberStatus, "ready_dryrun");
  assert.equal(row.provisionedDid, "8335550100");
  assert.ok(state.events.some((e) => /\[dry-run\].*toll-free number 8335550100/i.test(e.message)));
});

test("live toll-free pick: bought with orderTollFree (never orderDID), routed to the subaccount", async () => {
  reset({ live: true });
  const id = seedSubmission({
    answers: { phone: { choice: "new", selectedNumber: "(833) 555-0100", numberKind: "tollfree" } },
  });
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);

  const order = calls("orderTollFree");
  assert.equal(order.length, 1);
  assert.equal(order[0].params.did, "8335550100");
  assert.equal(order[0].params.routing, "account:344022_BobsPlumsub1");
  assert.equal(order[0].params.pop, "23"); // New York 1
  assert.equal(calls("orderDID").length, 0);
  assert.equal(calls("orderVanity").length, 0);

  const row = state.submissions.get(id);
  assert.equal(row.numberStatus, "ready");
  assert.equal(row.provisionedDid, "8335550100");
  assert.equal(row.didIsTemporary, false);
});

test("live vanity pick: bought with orderVanity (never orderDID/orderTollFree)", async () => {
  reset({ live: true });
  const id = seedSubmission({
    answers: { phone: { choice: "new", selectedNumber: "(844) 557-4992", numberKind: "vanity" } },
  });
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  const order = calls("orderVanity");
  assert.equal(order.length, 1);
  assert.equal(order[0].params.did, "8445574992");
  assert.equal(order[0].params.routing, "account:344022_BobsPlumsub1");
  assert.equal(calls("orderDID").length, 0);
  assert.equal(calls("orderTollFree").length, 0);
  assert.equal(state.submissions.get(id).provisionedDid, "8445574992");
});

test("toll-free with SMS add-on: setSMS enable=1 on the toll-free DID", async () => {
  reset({ live: true });
  const id = seedSubmission({
    smsEnabled: true,
    answers: { phone: { choice: "new", selectedNumber: "8335550100", numberKind: "tollfree" } },
  });
  await mod.applyOnboardingNumber(id);
  const sms = calls("setSMS");
  assert.equal(sms.length, 1);
  assert.equal(sms[0].params.did, "8335550100");
});

test("toll-free SPARE already in our account: routed, not re-purchased", async () => {
  reset({ live: true });
  vmsHandlers.getDIDsInfo = (p) =>
    p.did === "8335550100"
      ? { status: "success", dids: [{ did: "8335550100", routing: "account:344022" }] }
      : { status: "success", dids: [] };
  const id = seedSubmission({
    answers: { phone: { choice: "new", selectedNumber: "8335550100", numberKind: "tollfree" } },
  });
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  assert.equal(calls("orderTollFree").length, 0);
  assert.equal(calls("orderVanity").length, 0);
  const route = calls("setDIDRouting");
  assert.equal(route.length, 1);
  assert.equal(route[0].params.did, "8335550100");
});

test("toll-free taken by ANOTHER customer meanwhile: replacement is TOLL-FREE, never a local number", async () => {
  reset({ live: true });
  vmsHandlers.getDIDsInfo = () => ({
    status: "success",
    dids: [{ did: "8335550100", routing: "account:344022_SomeoneElse1" }],
  });
  const id = seedSubmission({
    answers: { phone: { choice: "new", selectedNumber: "8335550100", numberKind: "tollfree" } },
  });
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  assert.equal(calls("setDIDRouting").length, 0); // the taken number is never touched
  assert.equal(calls("searchDIDsUSA").length, 0); // no local fallback for a toll-free customer
  const order = calls("orderTollFree");
  assert.equal(order.length, 1);
  assert.equal(order[0].params.did, "8442220000"); // from searchTollFreeUSA
  assert.equal(state.submissions.get(id).provisionedDid, "8442220000");
  assert.ok(state.events.some((e) => /toll-free number 8335550100 was taken/i.test(e.message)));
});

test("a port customer's TEMPORARY number is never a toll-free spare (it would bill $15)", async () => {
  reset({ live: true });
  vmsHandlers.getDIDsInfo = () => ({
    status: "success",
    dids: [
      { did: "8335550999", routing: "account:344022" }, // toll-free spare — must be skipped
      { did: "9145550002", routing: "account:344022" }, // local spare — the right pick
    ],
  });
  const id = seedSubmission({
    phoneNumberChoice: "port",
    answers: { phone: { choice: "port", details: { numbers: "2125550000", carrier: "Verizon", accountNumber: "V9" } } },
  });
  await mod.applyOnboardingNumber(id);
  const route = calls("setDIDRouting");
  assert.equal(route.length, 1);
  assert.equal(route[0].params.did, "9145550002");
  assert.equal(state.submissions.get(id).provisionedDid, "9145550002");
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
  assert.equal(route[0].params.routing, "account:344022_BobsPlumsub1");

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

test("temporary-number purchase is seeded with the ported number's area code, not a blank nationwide search", async () => {
  reset({ live: true });
  vmsHandlers.getDIDsInfo = () => ({ status: "success", dids: [] }); // no spares
  vmsHandlers.searchDIDsUSA = (p) =>
    p.query === "212"
      ? { status: "success", dids: [{ did: "2125559999" }] }
      : { status: "success", dids: [{ did: "9295551234" }] };
  const id = seedSubmission({
    phoneNumberChoice: "port",
    answers: { phone: { choice: "port", details: { numbers: "2125550000", carrier: "Verizon", accountNumber: "V9" } } },
  });
  await mod.applyOnboardingNumber(id);
  const search = calls("searchDIDsUSA");
  assert.equal(search[0].params.type, "starts");
  assert.equal(search[0].params.query, "212");
  assert.equal(calls("orderDID")[0].params.did, "2125559999"); // same area code as the ported number
  assert.equal(state.submissions.get(id).provisionedDid, "2125559999");
});

test("area code out of stock: falls back to a nationwide search instead of failing the build", async () => {
  reset({ live: true });
  vmsHandlers.getDIDsInfo = () => ({ status: "success", dids: [] });
  vmsHandlers.searchDIDsUSA = (p) =>
    p.query === "212" ? { status: "success", dids: [] } : { status: "success", dids: [{ did: "9295551234" }] };
  const id = seedSubmission({
    phoneNumberChoice: "port",
    answers: { phone: { choice: "port", details: { numbers: "2125550000", carrier: "Verizon", accountNumber: "V9" } } },
  });
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  assert.equal(calls("orderDID")[0].params.did, "9295551234");
});

test("SAFETY ORDER: temporary number comes FIRST — a temp-number failure files NO port, and the retry files exactly one", async () => {
  // The old order (port first, temp second) meant a temp-number failure left
  // a filed port behind, and the retry filed a SECOND port on the customer's
  // live number.
  reset({ live: true });
  vmsHandlers.getDIDsInfo = () => ({ status: "success", dids: [] }); // no spares
  vmsHandlers.searchDIDsUSA = () => ({ status: "fail" }); // and nothing to buy → temp step dies
  const id = seedSubmission({
    phoneNumberChoice: "port",
    answers: { phone: { choice: "port", details: { numbers: "2125550000", carrier: "Verizon", accountNumber: "V9" } } },
  });
  const first = await mod.applyOnboardingNumber(id);
  assert.equal(first.ok, false);
  assert.match(state.submissions.get(id).setupError, /no_temporary_did_available/);
  assert.equal(calls("addLNPPort").length, 0); // the port was NOT filed

  vmsHandlers.searchDIDsUSA = () => ({ status: "success", dids: [{ did: "2125559999" }] });
  const second = await mod.applyOnboardingNumber(id);
  assert.equal(second.ok, true);
  assert.equal(calls("addLNPPort").length, 1); // filed exactly once, on the run that could finish
});

test("RETRY SAFETY: a re-run after the port was filed reuses the port id and temp number — no second port, no second number", async () => {
  reset({ live: true });
  vmsHandlers.getDIDsInfo = () => ({
    status: "success",
    dids: [{ did: "9145550002", routing: "account:344022" }], // one spare
  });
  const id = seedSubmission({
    phoneNumberChoice: "port",
    answers: { phone: { choice: "port", details: { numbers: "2125550000", carrier: "Verizon", accountNumber: "V9" } } },
  });
  const first = await mod.applyOnboardingNumber(id);
  assert.equal(first.ok, true);
  assert.equal(calls("addLNPPort").length, 1);
  const prov = state.submissions.get(id).answers.provisioning;
  assert.equal(prov.portFiled, true);
  assert.equal(prov.portId, "P123");
  assert.equal(prov.tempDid, "9145550002");

  // Simulate a later stage failing → the whole number stage gets retried.
  state.submissions.get(id).numberStatus = "failed";
  const second = await mod.applyOnboardingNumber(id);
  assert.equal(second.ok, true);
  assert.equal(calls("addLNPPort").length, 1); // still ONE port on file
  assert.equal(calls("orderDID").length, 0); // and no number was bought
  assert.equal(state.submissions.get(id).provisionedDid, "9145550002"); // same temp number
  assert.ok(state.events.some((e) => /already on file/i.test(e.message)));
});

test("LOA/bill attach failure: flagged in answers.provisioning for the owner report, stage still completes", async () => {
  reset({ live: true });
  vmsHandlers.getDIDsInfo = () => ({
    status: "success",
    dids: [{ did: "9145550002", routing: "account:344022" }],
  });
  const id = seedSubmission({
    phoneNumberChoice: "port",
    answers: { phone: { choice: "port", details: { numbers: "2125550000", carrier: "Verizon", accountNumber: "V9" } } },
    // storageKey points nowhere → reading the file throws → attach fails
    uploadedFiles: [{ id: "f1", filename: "signed-loa.pdf", kind: "PORTING_LOA", storageKey: "missing/signed-loa.pdf" }],
  });
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true); // a paperwork hiccup must not kill the build
  const prov = state.submissions.get(id).answers.provisioning;
  assert.deepEqual(prov.portDocAttachFailures, ["signed-loa.pdf"]);
  assert.ok(state.events.some((e) => /could not attach signed-loa\.pdf/i.test(e.message)));
});

test("attachments that DID reach the carrier are not re-sent on retry", async () => {
  const os = await import("node:os");
  const fsMod = await import("node:fs");
  const pathMod = await import("node:path");
  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "onb-test-"));
  fsMod.writeFileSync(pathMod.join(dir, "bill.pdf"), "fake-bill");
  process.env.ONBOARDING_STORAGE_DIR = dir;

  reset({ live: true });
  process.env.ONBOARDING_STORAGE_DIR = dir;
  vmsHandlers.getDIDsInfo = () => ({
    status: "success",
    dids: [{ did: "9145550002", routing: "account:344022" }],
  });
  const id = seedSubmission({
    phoneNumberChoice: "port",
    answers: { phone: { choice: "port", details: { numbers: "2125550000", carrier: "Verizon", accountNumber: "V9" } } },
    uploadedFiles: [{ id: "f1", filename: "bill.pdf", kind: "PORTING_BILL", storageKey: "bill.pdf" }],
  });
  await mod.applyOnboardingNumber(id);
  assert.equal(calls("addLNPFile").length, 1);
  assert.deepEqual(state.submissions.get(id).answers.provisioning.attachedFileIds, ["f1"]);

  state.submissions.get(id).numberStatus = "failed";
  await mod.applyOnboardingNumber(id);
  assert.equal(calls("addLNPFile").length, 1); // not attached twice
});

// ── Outage resilience (Cloudflare 521/522 HTML, timeouts) ────────────────────

test("OUTAGE: HTML error pages from VoIP.ms are retried and the call succeeds when the API comes back", async () => {
  reset({ live: true });
  let attempts = 0;
  vmsHandlers.createSubAccount = (p) => {
    attempts++;
    if (attempts <= 2) return "<html>521 Web server is down</html>" as any; // Cloudflare page, not JSON
    return { status: "success", account: `344022_${p.username}` };
  };
  const id = seedSubmission();
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  assert.equal(calls("createSubAccount").length, 3); // two outage pages + one real answer
});

test("OUTAGE: a dead provider fails the stage with provider_unreachable after 3 attempts — it does not hang or lie", async () => {
  reset({ live: true });
  vmsHandlers.getSubAccounts = () => "<html>522 Connection timed out</html>" as any;
  vmsHandlers.createSubAccount = () => "<html>522 Connection timed out</html>" as any;
  const id = seedSubmission();
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, false);
  assert.match(state.submissions.get(id).setupError, /provider_unreachable/);
  assert.equal(calls("createSubAccount").length, 3); // bounded — no infinite retry
});

test("a REAL VoIP.ms rejection (JSON error status) is NOT retried", async () => {
  reset({ live: true });
  vmsHandlers.createSubAccount = () => ({ status: "invalid_credentials" });
  const id = seedSubmission();
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, false);
  assert.equal(calls("createSubAccount").length, 1); // one call, one answer, no retry storm
});

test("live: existing subaccount is reused with a rotated password (idempotent re-run)", async () => {
  reset({ live: true });
  vmsHandlers.getSubAccounts = () => ({
    status: "success",
    accounts: [{ id: "77", account: "344022_BobsPlumsub1" }],
  });
  const id = seedSubmission();
  await mod.applyOnboardingNumber(id);
  assert.equal(calls("createSubAccount").length, 0);
  const rotate = calls("setSubAccount");
  assert.equal(rotate.length, 1);
  assert.equal(rotate[0].params.id, "77");
  assert.ok(rotate[0].params.password.length >= 12);
  // setSubAccount is a FULL update on VoIP.ms — the rotation must resend the
  // account's settings or the call fails (and the run dies on used_username).
  assert.equal(rotate[0].params.protocol, "1");
  assert.equal(rotate[0].params.device_type, "1");
});

test("REGRESSION: createSubAccount used_username self-heals by reusing (live 2026-07-27 Ezra Store 1)", async () => {
  // An earlier interrupted run created the subaccount while VoIP.ms was flaky.
  // On the next run the pre-lookup ALSO failed transiently, create returned
  // used_username, and the old code gave up — three times in a row.
  reset({ live: true });
  let subLookups = 0;
  vmsHandlers.getSubAccounts = () => {
    subLookups++;
    if (subLookups === 1) return { status: "fail" }; // transient pre-lookup failure
    return { status: "success", accounts: [{ id: "99", account: "344022_BobsPlumsub1", device_type: "1" }] };
  };
  vmsHandlers.createSubAccount = () => ({ status: "used_username" });
  const id = seedSubmission();
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  assert.equal(calls("setSubAccount")[0].params.id, "99"); // reused after self-heal
  const sub = JSON.parse(state.submissions.get(id).voipmsSubaccountEncrypted.replace(/^enc:/, ""));
  assert.equal(sub.username, "344022_BobsPlumsub1");
});

test("rotation failure on reuse surfaces the REAL error instead of a misleading used_username", async () => {
  reset({ live: true });
  vmsHandlers.getSubAccounts = () => ({
    status: "success",
    accounts: [{ id: "77", account: "344022_BobsPlumsub1" }],
  });
  vmsHandlers.setSubAccount = () => ({ status: "missing_device_type" });
  const id = seedSubmission();
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, false);
  assert.equal(calls("createSubAccount").length, 0); // never falls through to create
  assert.match(String(state.submissions.get(id).setupError || res.detail), /missing_device_type/);
});

test("live: existing-subaccount match works when the master username is a login EMAIL", async () => {
  // VoIP.ms prefixes subaccounts with the ACCOUNT NUMBER, never the API
  // username — when the API username is an email ("izzy@x.com"), the old
  // exact-match ("izzy@x.com_BobsPlumbing1") never hit and re-runs crashed
  // on duplicate creation. Suffix matching must find "123456_BobsPlumsub1".
  reset({ live: true });
  state.voipmsConfig = { credentialsEncrypted: "enc:" + JSON.stringify({ username: "izzy@x.com", password: "pw" }) };
  vmsHandlers.getSubAccounts = () => ({
    status: "success",
    accounts: [{ id: "88", account: "123456_BobsPlumsub1" }],
  });
  vmsHandlers.getDIDsInfo = () => ({ status: "success", dids: [] });
  const id = seedSubmission();
  const res = await mod.applyOnboardingNumber(id);
  assert.equal(res.ok, true);
  assert.equal(calls("createSubAccount").length, 0); // reused, not duplicated
  assert.equal(calls("setSubAccount")[0].params.id, "88");
  const sub = JSON.parse(state.submissions.get(id).voipmsSubaccountEncrypted.replace(/^enc:/, ""));
  assert.equal(sub.username, "123456_BobsPlumsub1"); // provider's name, not email-derived
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

test("subaccount naming: strips punctuation, carries the submission tag, total ≤12 chars", () => {
  assert.equal(mod.subAccountName("Bob's Plumbing & Heating", "abc123"), "BobsPlabc123");
  assert.equal(mod.subAccountName("", "abc123"), "acctabc123");
  assert.equal(mod.subAccountName("J&J", "abc123"), "JJabc123");
  // VoIP.ms silently truncates usernames past 12 chars (live 2026-07-28), and
  // the tag is what makes the name collision-proof — it must never be the
  // part that gets cut off.
  for (const c of ["Thequickbrownfoxjumped", "Bobs Plumbing", "X", ""]) {
    const name = mod.subAccountName(c, "abc123");
    assert.ok(name.length <= 12, `${name} exceeds VoIP.ms's silent 12-char cap`);
    assert.ok(name.endsWith("abc123"), `${name} lost its submission tag`);
  }
});

// ── Per-submission identity: the same-company-name collision class ───────────

test("CATASTROPHE GUARD: two submissions with the SAME company name get different subaccounts — neither rotates the other's password", async () => {
  reset({ live: true });
  // getSubAccounts reflects what create has made so far, like the real API —
  // so submission B's pre-lookup CAN see submission A's subaccount.
  const created: any[] = [];
  let nextId = 50;
  vmsHandlers.getSubAccounts = () => ({ status: "success", accounts: [...created] });
  vmsHandlers.createSubAccount = (p) => {
    const account = `344022_${p.username}`;
    created.push({ id: String(nextId++), account });
    return { status: "success", account };
  };
  const a = seedSubmission({ id: "suba", answers: { phone: { choice: "new", selectedNumber: "8455551001" } } });
  const b = seedSubmission({ id: "subb", answers: { phone: { choice: "new", selectedNumber: "8455551002" } } });

  assert.equal((await mod.applyOnboardingNumber(a)).ok, true);
  assert.equal((await mod.applyOnboardingNumber(b)).ok, true);

  const names = calls("createSubAccount").map((c) => c.params.username);
  assert.equal(names.length, 2, "each submission must create its OWN subaccount");
  assert.notEqual(names[0], names[1]);
  // The old failure mode: B "found" A's company-named subaccount and rotated
  // its password, killing A's live trunk. Must never happen again.
  assert.equal(calls("setSubAccount").length, 0, "a submission rotated another submission's password");
  const subA = JSON.parse(state.submissions.get(a).voipmsSubaccountEncrypted.replace(/^enc:/, "")).username;
  const subB = JSON.parse(state.submissions.get(b).voipmsSubaccountEncrypted.replace(/^enc:/, "")).username;
  assert.notEqual(subA, subB);
});

test("first run STORES the chosen names on the submission (answers.provisioning)", async () => {
  reset();
  const id = seedSubmission();
  await mod.applyOnboardingNumber(id);
  const p = state.submissions.get(id).answers?.provisioning;
  assert.ok(p, "identity was not stored on the submission");
  assert.equal(p.voipmsSubName, "BobsPlumsub1");
  assert.equal(p.tenantSlug, "bobs_plumbing_sub1");
  assert.equal(p.pbxLabel, "Bobs Plumbing sub1");
});

test("stored identity wins: a retry uses the SAME name even after the company was renamed mid-wizard", async () => {
  reset({ live: true });
  const id = seedSubmission({
    answers: {
      phone: { choice: "new", selectedNumber: "8455577726" },
      provisioning: { suffix: "zz", voipmsSubName: "OrigNamezz", tenantSlug: "orig_zz", pbxLabel: "Orig zz" },
    },
  });
  state.submissions.get(id).companyName = "Totally Different Co";
  await mod.applyOnboardingNumber(id);
  assert.equal(calls("createSubAccount")[0].params.username, "OrigNamezz");
});

test("LEGACY: a submission whose PBX tenant already exists keeps the old company-derived name", async () => {
  reset({ live: true });
  const id = seedSubmission({ pbxTenantPath: "feedfacefeedface" }); // built pre-suffix
  await mod.applyOnboardingNumber(id);
  assert.equal(calls("createSubAccount")[0].params.username, "BobsPlumbing1"); // old scheme
  assert.equal(state.submissions.get(id).answers.provisioning.tenantSlug, "bobs_plumbing");
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
