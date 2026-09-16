/**
 * Telnyx onboarding — search, provisioning, port filing, the landing sweep and
 * every wiring point (2026-09-16, "switch the onboarding wizard to Telnyx …
 * make sure that it works end to end").
 *
 * Run:
 *   node --experimental-test-module-mocks --import tsx --test src/onboarding/telnyxOnboarding.test.ts
 *
 * The money/carrier invariants each have their own test, because each is a
 * way to hurt a real customer: a second number order, a second port order on
 * their number, a re-submitted port, a purchase before its order resolves, a
 * refusal that fails a PAID build, a caller ID Telnyx will refuse.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(__dirname, p), "utf8").replace(/\r\n/g, "\n");

type Row = Record<string, any>;
const state: { submission: Row | null; events: string[]; smsUpserts: any[]; emails: any[] } = { submission: null, events: [], smsUpserts: [], emails: [] };
mock.module("@connect/db", {
  namedExports: {
    db: {
      onboardingSubmission: {
        findUnique: async () => state.submission,
        findFirst: async () => state.submission,
        findMany: async () => (state.submission ? [state.submission] : []),
        update: async ({ data }: any) => {
          state.submission = { ...(state.submission || {}), ...data };
          return state.submission;
        },
      },
      onboardingEvent: { create: async ({ data }: any) => { state.events.push(String(data.message)); return data; } },
      tenantSmsNumber: { upsert: async (args: any) => { state.smsUpserts.push(args); return {}; } },
      emailJob: { create: async (args: any) => { state.emails.push(args); return {}; } },
      user: { findFirst: async () => null },
      agentSecret: { findUnique: async () => null },
      globalVoipMsConfig: { findUnique: async () => null },
    },
  },
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildTelnyxSearch, searchTelnyxOnboardingNumbers } = require("./telnyxNumbers");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyTelnyxOnboardingNumber, telnyxAutoProvisionEnabled, resolveTelnyxPbxConnectionId } = require("./telnyxProvisioning");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fileTelnyxPortForSubmission, buildTelnyxPortPatch } = require("./telnyxPortFiling");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sweepTelnyxSignups } = require("./telnyxPortWatchdog");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TelnyxError } = require("../telnyx/telnyxClient");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { cnamFor } = require("../telnyx/telnyxOnboardingClient");

const CREDS = { apiKey: "KEYtest_000000000000000000000000" };
const CTX = { connectionId: "conn-183", messagingProfileId: "mp-1", customerReference: "loopcom:weiss_plumbing_abc123" };

function freshSubmission(extra: Row = {}): Row {
  return {
    id: "sub1",
    companyName: "Weiss Plumbing LLC",
    mainEmail: "sender@weissplumbing.com",
    phoneNumberChoice: "new",
    paidAt: new Date(),
    numberStatus: "provisioning",
    smsEnabled: true,
    uploadedFiles: [],
    answers: {
      phone: { choice: "new", selectedNumber: "(845) 219-5667", provider: "telnyx" },
      contact: { name: "Sender Weiss", address: "30 Robert Pitt Dr", addressCity: "Monsey", addressState: "NY", addressZip: "10952" },
    },
    ...extra,
  };
}

function reset(row: Row) {
  state.submission = row;
  state.events = [];
  state.smsUpserts = [];
  state.emails = [];
}

/** A fake Telnyx account: owned numbers, orders, a call log. */
function fakeTelnyx(opts: { owned?: Record<string, any>; orderStatuses?: string[]; emergencyStatus?: string } = {}) {
  const owned: Record<string, any> = { ...(opts.owned || {}) };
  const calls: string[] = [];
  const statuses = [...(opts.orderStatuses || ["pending", "success"])];
  let orderSeq = 0;
  const deps = {
    resolveCreds: async () => CREDS,
    listConnections: async () => [{ id: "conn-other", name: "Something else" }, { id: "conn-183", name: "Loopcom-Primary-SIP" }],
    listMessagingProfiles: async () => [{ id: "mp-1", name: "Loopcom Sign-ups", webhookUrl: null }],
    createMessagingProfile: async () => { calls.push("create-mp"); return "mp-new"; },
    findOwnedNumber: async (_c: any, e164: string) => owned[e164] || null,
    placeNumberOrder: async (_c: any, input: any) => {
      orderSeq++;
      calls.push(`order:${input.e164}:${input.connectionId}:${input.messagingProfileId}`);
      return { id: `ord-${orderSeq}`, status: "pending", numberStatus: "pending" };
    },
    getNumberOrder: async (_c: any, id: string) => {
      const s = statuses.length > 1 ? statuses.shift()! : statuses[0];
      if (s === "success") {
        const e164 = Object.keys(pendingByOrder).find((k) => pendingByOrder[k] === id);
        if (e164) owned[e164] = { id: `num-${e164.slice(-4)}`, phoneNumber: e164, emergencyStatus: "disabled" };
      }
      return { id, status: s, numberStatus: s };
    },
    configureOwnedNumber: async (_c: any, id: string, patch: any) => { calls.push(`configure:${id}:${patch.connectionId}:${patch.messagingProfileId}`); },
    setNumberCnam: async (_c: any, id: string, name: string) => { calls.push(`cnam:${id}:${cnamFor(name)}`); },
    searchAvailable: async (_c: any, p: any) => { calls.push(`search:${p.areaCode}`); return [{ phoneNumber: "+13475550999", state: "NY", locality: "BROOKLYN", features: ["voice", "sms"], numberType: "local" }]; },
    createAddress: async (_c: any, input: any) => { calls.push(`address:${input.streetAddress}|${input.locality}`); return { id: "addr-1", locality: "SPRING VALLEY" }; },
    enableEmergency: async (_c: any, numberId: string, addressId: string) => {
      calls.push(`e911:${numberId}:${addressId}`);
      for (const k of Object.keys(owned)) if (owned[k].id === numberId) owned[k].emergencyStatus = opts.emergencyStatus ?? "active";
      return { status: opts.emergencyStatus ?? "active" };
    },
    fileTelnyxPort: async (_row: any, did: string) => { calls.push(`file-port:${did}`); },
    sleep: async () => {},
  };
  // Track which order bought which number, so a success lands THAT number.
  const pendingByOrder: Record<string, string> = {};
  const origOrder = deps.placeNumberOrder;
  deps.placeNumberOrder = async (c: any, input: any) => {
    const o = await origOrder(c, input);
    pendingByOrder[input.e164] = o.id;
    return o;
  };
  return { deps, calls, owned, pendingByOrder };
}

// ── search ──────────────────────────────────────────────────────────────────

test("search: modes map to ONE Telnyx pattern filter; area code; letters T9; local needs voice+sms", () => {
  const a = buildTelnyxSearch({ query: "845", mode: "areacode", type: "local" });
  assert.equal(a.params.areaCode, "845");
  assert.deepEqual(a.params.features, ["voice", "sms"]);
  for (const [mode, key] of [["starts", "startsWith"], ["contains", "contains"], ["ends", "endsWith"]] as const) {
    const out = buildTelnyxSearch({ query: "LOOP", mode, type: "local" });
    const p = out.params as Record<string, unknown>;
    assert.equal(p[key], "5667");
    assert.deepEqual(["startsWith", "contains", "endsWith"].filter((k) => p[k] !== undefined), [key]);
  }
  assert.deepEqual(buildTelnyxSearch({ query: "12", mode: "ends", type: "local" }), { refuse: "pattern_too_short" });
  const geo = buildTelnyxSearch({ query: "", type: "local", region: "ny", city: "Monsey" });
  assert.equal(geo.params.state, "NY");
  assert.equal(geo.params.locality, "MONSEY");
  const tf = buildTelnyxSearch({ query: "", type: "tollfree", region: "NY" });
  assert.equal(tf.params.numberType, "toll_free");
  assert.equal(tf.params.state, undefined, "no state filter on toll-free");
});

test("search: a city with no match RETRIES without the city (same state); failure ≠ empty; unconfigured is its own outcome", async () => {
  const seen: any[] = [];
  const out = await searchTelnyxOnboardingNumbers({}, { query: "", type: "local", region: "NY", city: "Monsey" }, {
    resolveCreds: async () => CREDS,
    search: async (_c: any, p: any) => { seen.push(p); return p.locality ? [] : [{ phoneNumber: "+18455520019", state: "NY", locality: "MILTON", features: ["voice", "sms", "mms"], numberType: "local" }]; },
  });
  assert.equal(out.ok, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].locality, undefined);
  assert.equal(seen[1].state, "NY");
  assert.deepEqual(out.numbers[0], { number: "(845) 552-0019", e164: "+18455520019", location: "Milton, NY", sms: true, voice: true, mms: true, fax: false, inStock: false, kind: "local" });

  const failed = await searchTelnyxOnboardingNumbers({}, { query: "845", type: "local" }, { resolveCreds: async () => CREDS, search: async () => { throw new Error("boom"); } });
  assert.deepEqual(failed, { ok: false, reason: "search_failed" });
  const unconf = await searchTelnyxOnboardingNumbers({}, { query: "845", type: "local" }, { resolveCreds: async () => null });
  assert.deepEqual(unconf, { ok: false, reason: "unconfigured" });
});

test("client: Telnyx 10031 'no numbers found' is an EMPTY result, not an outage", async () => {
  const { setTelnyxFetch } = await import("../telnyx/telnyxClient");
  const { searchAvailable } = await import("../telnyx/telnyxOnboardingClient");
  setTelnyxFetch(async () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => JSON.stringify({ errors: [{ code: "10031", title: "Invalid request filter" }] }) }));
  try {
    assert.deepEqual(await searchAvailable(CREDS, { numberType: "local", locality: "NOWHERE" }), []);
    setTelnyxFetch(async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "{}" }));
    await assert.rejects(() => searchAvailable(CREDS, { numberType: "local" }));
  } finally {
    setTelnyxFetch(null);
  }
});

// ── provisioning ────────────────────────────────────────────────────────────

test("dry-run (gate off): narrates, lands ready_dryrun, touches Telnyx NOT AT ALL", async () => {
  delete process.env.TELNYX_AUTO_PROVISION;
  assert.equal(telnyxAutoProvisionEnabled(), false);
  reset(freshSubmission());
  const tx = fakeTelnyx();
  const res = await applyTelnyxOnboardingNumber("sub1", tx.deps);
  assert.equal(res.ok, true);
  assert.equal(state.submission!.numberStatus, "ready_dryrun");
  assert.equal(state.submission!.provisionedDid, "8452195667");
  assert.deepEqual(tx.calls, []);
});

test("live new number: ONE order pre-assigned to the PBX connection + messaging profile → configure → CNAM → 911 active → ready", async () => {
  process.env.TELNYX_AUTO_PROVISION = "on";
  try {
    reset(freshSubmission());
    const tx = fakeTelnyx();
    const res = await applyTelnyxOnboardingNumber("sub1", tx.deps);
    assert.equal(res.ok, true, state.events.join(" | "));
    assert.equal(state.submission!.numberStatus, "ready");
    assert.equal(state.submission!.provisionedDid, "8452195667");
    assert.deepEqual(tx.calls, [
      "order:+18452195667:conn-183:mp-1",
      "configure:num-5667:conn-183:mp-1",
      "cnam:num-5667:WEISS PLUMBING",
      "address:30 Robert Pitt Dr|Monsey",
      "e911:num-5667:addr-1",
    ]);
    const prov = (state.submission!.answers as any).provisioning;
    assert.equal(prov.e911.status, "provisioned");
    assert.equal(prov.e911.address.city, "SPRING VALLEY", "the registered (corrected) town is what the customer is told");
    assert.equal(prov.telnyx.connectionId, "conn-183");
    assert.equal(prov.telnyxOrders["+18452195667"], "ord-1");
  } finally {
    delete process.env.TELNYX_AUTO_PROVISION;
  }
});

test("⛔ a RETRY after a crash resumes the STORED order — it never places a second one", async () => {
  process.env.TELNYX_AUTO_PROVISION = "on";
  try {
    const row = freshSubmission();
    row.answers.provisioning = { tenantSlug: "weiss_plumbing_abc123", pbxLabel: "Weiss Plumbing abc123", voipmsSubName: "WeissPlabc123", suffix: "abc123", telnyxOrders: { "+18452195667": "ord-earlier" } };
    reset(row);
    const tx = fakeTelnyx({ orderStatuses: ["success"] });
    tx.pendingByOrder["+18452195667"] = "ord-earlier";
    const res = await applyTelnyxOnboardingNumber("sub1", tx.deps);
    assert.equal(res.ok, true, state.events.join(" | "));
    assert.equal(tx.calls.filter((c) => c.startsWith("order:")).length, 0, "no second purchase");
    assert.ok(state.events.some((e) => e.includes("Resuming the earlier order")));
  } finally {
    delete process.env.TELNYX_AUTO_PROVISION;
  }
});

test("⛔ a number already on the account is ADOPTED, never re-bought", async () => {
  process.env.TELNYX_AUTO_PROVISION = "on";
  try {
    reset(freshSubmission());
    const tx = fakeTelnyx({ owned: { "+18452195667": { id: "num-owned", phoneNumber: "+18452195667" } } });
    const res = await applyTelnyxOnboardingNumber("sub1", tx.deps);
    assert.equal(res.ok, true);
    assert.equal(tx.calls.filter((c) => c.startsWith("order:")).length, 0);
    assert.ok(tx.calls.includes("configure:num-owned:conn-183:mp-1"));
  } finally {
    delete process.env.TELNYX_AUTO_PROVISION;
  }
});

test("⛔ an order TIMEOUT re-reads the account before failing; it is never re-sent", async () => {
  process.env.TELNYX_AUTO_PROVISION = "on";
  try {
    reset(freshSubmission());
    const tx = fakeTelnyx();
    let orders = 0;
    let lookups = 0;
    tx.deps.placeNumberOrder = async () => { orders++; throw new TelnyxError(0, "timeout", "timed out"); };
    const baseFind = tx.deps.findOwnedNumber;
    tx.deps.findOwnedNumber = async (c: any, e164: string) => {
      lookups++;
      // First lookup (before ordering): not owned. After the timeout: it landed.
      if (lookups === 2) tx.owned[e164] = { id: "num-late", phoneNumber: e164, emergencyStatus: "disabled" };
      return baseFind(c, e164);
    };
    const res = await applyTelnyxOnboardingNumber("sub1", tx.deps);
    assert.equal(res.ok, true, state.events.join(" | "));
    assert.equal(orders, 1);
    assert.ok(state.events.some((e) => e.includes("timed out but the number LANDED")));
  } finally {
    delete process.env.TELNYX_AUTO_PROVISION;
  }
});

test("a FAILED order fails the stage loudly and clears the stored order so a retry can pick again", async () => {
  process.env.TELNYX_AUTO_PROVISION = "on";
  try {
    reset(freshSubmission());
    const tx = fakeTelnyx({ orderStatuses: ["failure"] });
    const res = await applyTelnyxOnboardingNumber("sub1", tx.deps);
    assert.equal(res.ok, false);
    assert.equal(state.submission!.numberStatus, "failed");
    assert.match(String(state.submission!.setupError), /telnyx_number_order_failed/);
    assert.equal((state.submission!.answers as any).provisioning.telnyxOrders["+18452195667"], undefined);
  } finally {
    delete process.env.TELNYX_AUTO_PROVISION;
  }
});

test("⛔ 911 not yet active is recorded pending_activation — NEVER 'provisioned' on hope", async () => {
  process.env.TELNYX_AUTO_PROVISION = "on";
  try {
    reset(freshSubmission());
    const tx = fakeTelnyx({ emergencyStatus: "provisioning" });
    const res = await applyTelnyxOnboardingNumber("sub1", tx.deps);
    assert.equal(res.ok, true);
    assert.equal((state.submission!.answers as any).provisioning.e911.status, "pending_activation");
  } finally {
    delete process.env.TELNYX_AUTO_PROVISION;
  }
});

test("the PBX connection is matched by NAME (or env pin) and REFUSED when absent — never guessed", async () => {
  assert.equal(await resolveTelnyxPbxConnectionId(CREDS, { listConnections: async () => [{ id: "x", name: "Loopcom-Primary-SIP" }] } as any), "x");
  await assert.rejects(() => resolveTelnyxPbxConnectionId(CREDS, { listConnections: async () => [{ id: "y", name: "Other" }] } as any), /telnyx_pbx_connection_not_found/);
  process.env.TELNYX_PBX_CONNECTION_ID = "pinned";
  try {
    assert.equal(await resolveTelnyxPbxConnectionId(CREDS, { listConnections: async () => { throw new Error("must not list"); } } as any), "pinned");
  } finally {
    delete process.env.TELNYX_PBX_CONNECTION_ID;
  }
});

test("port sign-up: temp number in the PORTED area code FIRST, then the port filing LAST; a filing throw never fails the paid stage", async () => {
  process.env.TELNYX_AUTO_PROVISION = "on";
  try {
    reset(freshSubmission({ phoneNumberChoice: "port", answers: { phone: { choice: "port", provider: "telnyx", details: { numbers: "(347) 555-0182" } }, contact: freshSubmission().answers.contact } }));
    const tx = fakeTelnyx();
    tx.deps.fileTelnyxPort = async (_r: any, did: string) => { tx.calls.push(`file-port:${did}`); throw new Error("telnyx exploded"); };
    const res = await applyTelnyxOnboardingNumber("sub1", tx.deps);
    assert.equal(res.ok, true, state.events.join(" | "));
    assert.equal(state.submission!.didIsTemporary, true);
    assert.equal(state.submission!.provisionedDid, "3475550999");
    assert.equal(tx.calls[0], "search:347");
    assert.equal(tx.calls[tx.calls.length - 1], "file-port:3475550182", "the irreversible filing is the LAST call");
    assert.ok(state.events.some((e) => e.includes("could not be filed")));
  } finally {
    delete process.env.TELNYX_AUTO_PROVISION;
  }
});

// ── port filing ─────────────────────────────────────────────────────────────

function portRow(extraProv: Row = {}): Row {
  return freshSubmission({
    phoneNumberChoice: "port",
    uploadedFiles: [{ id: "f1", kind: "PORTING_BILL", filename: "bill.pdf", storageKey: "k1" }],
    answers: {
      phone: {
        choice: "port",
        provider: "telnyx",
        details: { numbers: "3475550182", carrier: "Verizon", accountNumber: "ACC-9", nameOnAccount: "Weiss Plumbing LLC", serviceAddress: "30 Robert Pitt Dr", serviceCity: "Monsey", serviceState: "ny", serviceZip: "10952", isMobile: true, portPin: "123456", loaSignature: "Sender Weiss" },
      },
      provisioning: { ...extraProv },
    },
  });
}

function fakePorting(opts: { confirmThrows?: boolean; existingStatus?: string } = {}) {
  const calls: string[] = [];
  const deps = {
    resolveCreds: async () => CREDS,
    createPortingOrders: async (_c: any, nums: string[]) => { calls.push(`create:${nums.join(",")}`); return [{ id: "po-1", status: "draft", statusDetails: [], phoneNumbers: nums, focDate: null, supportKey: null }]; },
    getPortingOrder: async (_c: any, id: string) => ({ id, status: opts.existingStatus || "draft", statusDetails: [], phoneNumbers: [], focDate: null, supportKey: null }),
    updatePortingOrder: async (_c: any, id: string, body: any) => { calls.push(`patch:${id}:${body.documents?.loa}:${body.documents?.invoice}`); return { id, status: "draft" }; },
    confirmPortingOrder: async (_c: any, id: string) => {
      calls.push(`confirm:${id}`);
      if (opts.confirmThrows) throw new TelnyxError(422, "invalid_request", "refused", { errors: [{ code: "10015", title: "Missing documents", detail: "invoice is required" }] });
      return { id, status: "in-process" };
    },
    uploadDocument: async (_c: any, filename: string) => { calls.push(`upload:${filename}`); return `doc-${filename}`; },
    buildLoa: async () => Buffer.from("%PDF-loa"),
    readUpload: () => Buffer.from("%PDF-bill"),
  };
  return { deps, calls };
}

test("filing: draft → LOA + bill uploaded → PATCH with both documents → CONFIRM → submitted", async () => {
  reset(portRow());
  const p = fakePorting();
  const filing = await fileTelnyxPortForSubmission(state.submission, "3475550182", CTX, p.deps);
  assert.equal(filing.status, "submitted", state.events.join(" | "));
  assert.deepEqual(p.calls, ["create:+13475550182", "upload:LOA-3475550182.pdf", "upload:bill.pdf", "patch:po-1:doc-LOA-3475550182.pdf:doc-bill.pdf", "confirm:po-1"]);
  const stored = (state.submission!.answers as any).provisioning.portFiling;
  assert.equal(stored.provider, "telnyx");
  assert.deepEqual(stored.orderIds, ["po-1"]);
  assert.equal(stored.portReference, "po-1");
});

test("⛔ filing retry: stored order ids + documents are REUSED — no second order, no re-upload", async () => {
  reset(portRow({ portFiling: { provider: "telnyx", status: "needs_attention", portedDid: "3475550182", requestedAt: "x", orderIds: ["po-1"], loaDocumentId: "doc-a", invoiceDocumentId: "doc-b" } }));
  const p = fakePorting();
  const filing = await fileTelnyxPortForSubmission(state.submission, "3475550182", CTX, p.deps);
  assert.equal(filing.status, "submitted");
  assert.deepEqual(p.calls, ["patch:po-1:doc-a:doc-b", "confirm:po-1"]);
});

test("⛔ an order Telnyx already has in process is NEVER confirmed again; a submitted filing is a no-op", async () => {
  reset(portRow({ portFiling: { provider: "telnyx", status: "filing", portedDid: "3475550182", requestedAt: "x", orderIds: ["po-1"], loaDocumentId: "doc-a", invoiceDocumentId: "doc-b" } }));
  const p = fakePorting({ existingStatus: "in-process" });
  const filing = await fileTelnyxPortForSubmission(state.submission, "3475550182", CTX, p.deps);
  assert.equal(filing.status, "submitted");
  assert.equal(p.calls.filter((c) => c.startsWith("confirm")).length, 0);

  const p2 = fakePorting();
  await fileTelnyxPortForSubmission(state.submission, "3475550182", CTX, p2.deps);
  assert.deepEqual(p2.calls, [], "a submitted filing makes no Telnyx call at all");
});

test("a Telnyx REFUSAL lands needs_attention with Telnyx's own words — it does not throw", async () => {
  reset(portRow());
  const p = fakePorting({ confirmThrows: true });
  const filing = await fileTelnyxPortForSubmission(state.submission, "3475550182", CTX, p.deps);
  assert.equal(filing.status, "needs_attention");
  assert.match(String(filing.error), /invoice is required/);
  assert.ok(state.events.some((e) => e.includes("Port queue")));
});

test("the PATCH body carries the account, PIN, service address, BTN and the activation routing", () => {
  const body: any = buildTelnyxPortPatch(portRow(), "3475550182", CTX, { loa: "L", invoice: "I" });
  assert.deepEqual(body.end_user.admin, { entity_name: "Weiss Plumbing LLC", auth_person_name: "Sender Weiss", billing_phone_number: "+13475550182", account_number: "ACC-9", pin_passcode: "123456" });
  assert.deepEqual(body.end_user.location, { street_address: "30 Robert Pitt Dr", locality: "Monsey", administrative_area: "NY", postal_code: "10952", country_code: "US" });
  assert.deepEqual(body.phone_number_configuration, { connection_id: "conn-183", messaging_profile_id: "mp-1" });
  assert.deepEqual(body.documents, { loa: "L", invoice: "I" });
  assert.deepEqual(body.misc, { type: "full" });
});

// ── the sweep ───────────────────────────────────────────────────────────────

function sweepDeps(over: Row = {}) {
  const calls: string[] = [];
  const deps: any = {
    db: (require("@connect/db") as any).db,
    resolveCreds: async () => CREDS,
    getPortingOrder: async (_c: any, id: string) => ({ id, status: "ported", statusDetails: [], phoneNumbers: [], focDate: "2026-09-30", supportKey: null }),
    findOwnedNumber: async (_c: any, e164: string) => ({ id: `num-${e164.slice(-4)}`, phoneNumber: e164, emergencyStatus: "active" }),
    configureOwnedNumber: async (_c: any, id: string) => { calls.push(`configure:${id}`); },
    setNumberCnam: async (_c: any, id: string) => { calls.push(`cnam:${id}`); },
    enableEmergency: async (_c: any, id: string, addr: string) => { calls.push(`e911:${id}:${addr}`); return { status: "active" }; },
    refile: async () => { calls.push("refile"); },
    copyPbxDestination: async () => { calls.push("copy-dest"); return { copied: true, detail: "extension 101 copied" }; },
    switchOutboundCallerId: async (_r: any, did: string) => { calls.push(`cid:${did}`); return { switched: true, detail: "ok" }; },
    publishTenant: async () => { calls.push("publish"); },
    ...over,
  };
  return { deps, calls };
}

function landedRow(filingPatch: Row = {}, extra: Row = {}): Row {
  const r = portRow({
    telnyx: CTX,
    telnyxE911AddressId: "addr-1",
    temporaryDid: "3475550999",
    pbxOutboundRouteId: "444",
    portFiling: { provider: "telnyx", status: "submitted", portedDid: "3475550182", requestedAt: "x", orderIds: ["po-1"], telnyxStatus: { "po-1": "in-process" }, ...filingPatch },
  });
  return { ...r, createdTenantId: "tenant-1", numberStatus: "ready", pbxSetupStatus: "done", ...extra };
}

test("sweep LANDS a ported number: configure → 911 → PBX destination → publish → caller ID → texting → email → completed", async () => {
  reset(landedRow());
  const { deps, calls } = sweepDeps();
  const s = await sweepTelnyxSignups(deps);
  assert.equal(s.landed, 1, state.events.join(" | "));
  assert.deepEqual(calls, ["configure:num-0182", "cnam:num-0182", "e911:num-0182:addr-1", "copy-dest", "publish", "cid:3475550182"]);
  const prov = (state.submission!.answers as any).provisioning;
  assert.equal(prov.portFiling.status, "ported");
  assert.ok(prov.portLanding.completedAt);
  assert.equal(state.smsUpserts[0].create.provider, "TELNYX");
  assert.equal(state.emails.length, 1);
  assert.doesNotMatch(String(state.emails[0].data.textBody), /switched off/, "the temp number stays ON (911 callback) — never tell them it is off");

  // A second sweep does nothing to a completed landing.
  const again = sweepDeps();
  const s2 = await sweepTelnyxSignups(again.deps);
  assert.equal(s2.landed, 0);
  assert.deepEqual(again.calls, []);
});

test("⛔ a caller-ID switch that fails STOPS the landing (retried next sweep) — no email claiming it is done", async () => {
  reset(landedRow());
  const { deps } = sweepDeps({ switchOutboundCallerId: async () => ({ switched: false, detail: "panel down" }) });
  const s = await sweepTelnyxSignups(deps);
  assert.equal(s.landed, 0);
  assert.equal(state.emails.length, 0);
  assert.equal((state.submission!.answers as any).provisioning.portLanding.completedAt, undefined);
  // The steps already done are recorded, so the retry resumes after them.
  assert.ok((state.submission!.answers as any).provisioning.portLanding.e911At);
});

test("an order still in process is recorded, not landed", async () => {
  reset(landedRow());
  const { deps, calls } = sweepDeps({ getPortingOrder: async (_c: any, id: string) => ({ id, status: "foc-date-confirmed", statusDetails: [], phoneNumbers: [], focDate: "2026-09-30", supportKey: null }) });
  const s = await sweepTelnyxSignups(deps);
  assert.equal(s.landed, 0);
  assert.deepEqual(calls, []);
  const f = (state.submission!.answers as any).provisioning.portFiling;
  assert.equal(f.telnyxStatus["po-1"], "foc-date-confirmed");
  assert.equal(f.focDate, "2026-09-30");
});

test("⛔ needs_attention is re-filed ONLY after the number stage finished (no concurrent second port order)", async () => {
  reset(landedRow({ status: "needs_attention" }, { numberStatus: "provisioning" }));
  const a = sweepDeps();
  await sweepTelnyxSignups(a.deps);
  assert.deepEqual(a.calls, [], "mid-stage: no refile");
  reset(landedRow({ status: "needs_attention" }, { numberStatus: "ready" }));
  const b = sweepDeps();
  await sweepTelnyxSignups(b.deps);
  assert.deepEqual(b.calls, ["refile"]);
});

test("sweep confirms a pending 911 activation and only THEN may the customer be told", async () => {
  const row = freshSubmission({ numberStatus: "ready", pbxSetupStatus: "done" });
  row.answers.provisioning = { e911: { provider: "telnyx", status: "pending_activation", did: "8452195667", address: { city: "SPRING VALLEY" } } };
  reset(row);
  const told: string[] = [];
  const { deps } = sweepDeps({ queueE911Email: async (id: string) => { told.push(id); } });
  const s = await sweepTelnyxSignups(deps);
  assert.equal(s.e911Confirmed, 1);
  assert.equal((state.submission!.answers as any).provisioning.e911.status, "provisioned");
  assert.deepEqual(told, ["sub1"]);
});

test("cnamFor: ≤15 chars, A-Z 0-9 space only", () => {
  assert.equal(cnamFor("Weiss Plumbing LLC"), "WEISS PLUMBING");
  assert.equal(cnamFor("A&B / Co."), "A B CO");
  assert.equal(cnamFor(""), "");
});

// ── SOURCE guards — every defect of this shape has been a CALLER ────────────

test("applyOnboardingNumber DISPATCHES telnyx (dynamic import, no cycle)", () => {
  const src = read("voipMsProvisioning.ts");
  assert.match(src, /if \(numberProvider === "telnyx"\) \{\n\s+const \{ applyTelnyxOnboardingNumber \} = await import\("\.\/telnyxProvisioning"\);\n\s+return applyTelnyxOnboardingNumber\(submissionId\);/);
});

test("⛔ syncOnboardingSms is VoIP.ms-only (setSMS about a Telnyx number is a call about a number VoIP.ms does not own)", () => {
  const src = read("voipMsProvisioning.ts");
  const body = src.slice(src.indexOf("export async function syncOnboardingSms"));
  assert.match(body.slice(0, 900), /if \(provider !== "voipms"\) return;/);
});

test("the public routes: Telnyx search branch keeps the error contract; portability asks Telnyx; registry follows the carrier", () => {
  const src = read("publicRoutes.ts");
  assert.match(src, /if \(searchProvider === "telnyx"\) \{\n\s+const out = await searchTelnyxOnboardingNumbers\(db,/);
  assert.match(src, /return \{ numbers: \[\], provider: "telnyx", error: "number_search_failed" \};/);
  assert.match(src, /const rows = await checkPortability\(txCreds, \[`\+1\$\{number\}`\]\);/);
  assert.match(src, /create: \{ submissionId: row\.id, provider: registryProvider, \.\.\.regData \}/);
});

test("the PBX build: Telnyx uses the SHARED trunk by name, refuses when missing, and presents the TEMP number on a port", () => {
  const src = read("pbxTenantBuild.ts");
  assert.match(src, /TELNYX_SHARED_TRUNK_NAME = "Telnyx Loopcom-Primary"/);
  assert.match(src, /shared Telnyx trunk "\$\{TELNYX_SHARED_TRUNK_NAME\}" not found on the PBX/);
  assert.match(src, /const outboundCid = numberProvider === "telnyx" \? job\.did : portedDid \|\| job\.did;/);
});

test("the orchestrator: Telnyx is a shared-trunk carrier and the build's route id is kept for the landing", () => {
  const src = read("setupOrchestrator.ts");
  assert.match(src, /const isTelnyx = providerStamp === "telnyx";/);
  assert.match(src, /pbxOutboundRouteId: String\(result\.routeId \|\| ""\)/);
});

test("server.ts arms the Telnyx sign-up sweep", () => {
  const src = read("../server.ts");
  assert.match(src, /import \{ startTelnyxSignupSweep \} from "\.\/onboarding\/telnyxPortWatchdog";/);
  assert.match(src, /const telnyxSignupSweep = startTelnyxSignupSweep\(app\.log as any,/);
});

test("the 10DLC chain picks its registry by the row's provider; the TenantSmsNumber provider follows it", () => {
  const src = read("../signalwire/signalWireTenDlc.ts");
  assert.match(src, /export function registryFor\(/);
  assert.match(src, /const registry = registryFor\(reg\);\n\s+if \(!registry\.live\(\)\) return;/);
  assert.match(src, /provider: registry\.smsProvider,/);
  assert.doesNotMatch(src, /^\s+provider: "SIGNALWIRE",\n\s+phoneE164/m, "no hard-coded carrier left in the activation upsert");
  assert.doesNotMatch(src, /update: \{ tenantId: fin\.tenantId, provider: "SIGNALWIRE"/);
});

test("the wizard draws the modern search surface for Telnyx (and never shows a carrier name)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../../portal/app/onboarding/[token]/page.tsx"), "utf8");
  assert.match(src, /setNumbersProvider\(r\.provider === "signalwire" \|\| r\.provider === "telnyx" \? "signalwire" : "voipms"\)/);
});

test("the switch offers Telnyx as selectable", () => {
  const src = read("providerSwitchRoutes.ts");
  assert.match(src, /\{ value: "telnyx", label: "Telnyx", selectable: true \}/);
});
