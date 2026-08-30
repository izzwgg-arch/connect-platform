/**
 * SignalWire onboarding — search, provisioning dispatch, and PBX-build wiring
 * (2026-08-30, the "everything is changing to SignalWire" build).
 *
 * Run:
 *   node --experimental-test-module-mocks --import tsx --test src/onboarding/signalWireOnboarding.test.ts
 *
 * Contains SOURCE guards beside the unit tests because every recorded defect
 * of this shape here has been a CALLER: a provider stamp not written, a
 * dispatch not wired, a branch added to one of two paths.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(__dirname, p), "utf8").replace(/\r\n/g, "\n");

// ── db mock (must precede importing the modules under test) ────────────────
type Row = Record<string, any>;
const state: { submission: Row | null; events: string[] } = { submission: null, events: [] };
mock.module("@connect/db", {
  namedExports: {
    db: {
      onboardingSubmission: {
        findUnique: async () => state.submission,
        findFirst: async () => state.submission,
        update: async ({ data }: any) => {
          state.submission = { ...(state.submission || {}), ...data };
          return state.submission;
        },
      },
      onboardingEvent: {
        create: async ({ data }: any) => {
          state.events.push(String(data.message));
          return data;
        },
      },
      globalVoipMsConfig: { findUnique: async () => null },
      agentSecret: { findUnique: async () => null },
    },
  },
});

// ⛔ LATE require, AFTER mock.module — a static import is hoisted above the
// mock registration and the modules capture the REAL @connect/db client
// (top-level await is unavailable: tsx transpiles this tree as CJS).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildSignalWireSearch, onboardingNumberProvider, searchSignalWireOnboardingNumbers, t9ToDigits } = require("./signalWireNumbers");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applySignalWireOnboardingNumber, resolvePbxSipEndpointId, signalWireAutoProvisionEnabled } = require("./signalWireProvisioning");

// ── t9 + search building ───────────────────────────────────────────────────

test("t9ToDigits maps letters like a keypad and passes digits through", () => {
  assert.equal(t9ToDigits("LOOP"), "5667");
  assert.equal(t9ToDigits("845"), "845");
  assert.equal(t9ToDigits("Loop-845!"), "5667845");
});

test("area-code mode (and bare short queries) become `areacode`", () => {
  const a = buildSignalWireSearch({ query: "845", mode: "areacode", type: "local" });
  assert.ok("params" in a && a.params.areaCode === "845");
  const b = buildSignalWireSearch({ query: "84", type: "local" }); // no mode, short → areacode
  assert.ok("params" in b && b.params.areaCode === "84");
});

test("starts/contains/ends map to exactly ONE pattern param (the API refuses combinations)", () => {
  for (const [mode, key] of [
    ["starts", "startsWith"],
    ["contains", "contains"],
    ["ends", "endsWith"],
  ] as const) {
    const out = buildSignalWireSearch({ query: "LOOP", mode, type: "local" });
    assert.ok("params" in out);
    const p = out.params as Record<string, unknown>;
    assert.equal(p[key], "5667", `${mode} should carry the T9 digits`);
    const patternKeys = ["startsWith", "contains", "endsWith"].filter((k) => p[k] !== undefined);
    assert.deepEqual(patternKeys, [key], "exactly one pattern param");
    assert.equal(p.areaCode, undefined);
  }
});

test("a pattern under 3 digits is refused in plain terms, never sent to the provider", () => {
  const out = buildSignalWireSearch({ query: "ab", mode: "ends", type: "local" });
  assert.deepEqual(out, { refuse: "pattern_too_short" });
});

test("region/city ride only on LOCAL searches, city clamped, state upper-cased", () => {
  const local = buildSignalWireSearch({ query: "", type: "local", region: "ny", city: "Monroe" });
  assert.ok("params" in local && local.params.region === "NY" && local.params.city === "Monroe");
  const tf = buildSignalWireSearch({ query: "", type: "tollfree", region: "ny", city: "Monroe" });
  assert.ok("params" in tf && tf.params.region === undefined && tf.params.city === undefined);
  assert.ok("params" in tf && tf.params.numberType === "toll-free");
});

test("onboardingNumberProvider defaults to voipms and flips only on the exact value", () => {
  const prev = process.env.ONBOARDING_NUMBER_PROVIDER;
  try {
    delete process.env.ONBOARDING_NUMBER_PROVIDER;
    assert.equal(onboardingNumberProvider(), "voipms");
    process.env.ONBOARDING_NUMBER_PROVIDER = "signalwire";
    assert.equal(onboardingNumberProvider(), "signalwire");
    process.env.ONBOARDING_NUMBER_PROVIDER = "garbage";
    assert.equal(onboardingNumberProvider(), "voipms");
  } finally {
    if (prev === undefined) delete process.env.ONBOARDING_NUMBER_PROVIDER;
    else process.env.ONBOARDING_NUMBER_PROVIDER = prev;
  }
});

test("search maps results to the wizard shape and never invents stock", async () => {
  const out = await searchSignalWireOnboardingNumbers(
    {},
    { query: "845", mode: "areacode", type: "local" },
    {
      resolveCreds: (async () => ({ spaceUrl: "x", projectId: "p", apiToken: "t" })) as any,
      search: (async () => [
        { number: "+18452195667", region: "NY", city: "Monroe", rateCenter: "", capabilities: { voice: true, sms: true, mms: true, fax: false } },
      ]) as any,
    },
  );
  assert.ok(out.ok);
  const n = out.numbers[0];
  assert.equal(n.number, "(845) 219-5667");
  assert.equal(n.location, "Monroe, NY");
  assert.equal(n.inStock, false, "SignalWire has no spare pool — nothing is 'Ready now'");
  assert.equal(n.sms, true);
  assert.equal(n.mms, true);
});

test("search failures and missing credentials are DISTINCT outcomes (never a silent empty list)", async () => {
  const noCreds = await searchSignalWireOnboardingNumbers({}, { query: "845", type: "local" }, { resolveCreds: (async () => null) as any });
  assert.deepEqual(noCreds, { ok: false, reason: "unconfigured" });
  const failed = await searchSignalWireOnboardingNumbers(
    {},
    { query: "845", type: "local" },
    { resolveCreds: (async () => ({} as any)) as any, search: (async () => { throw new Error("boom"); }) as any },
  );
  assert.deepEqual(failed, { ok: false, reason: "search_failed" });
});

// ── endpoint discovery ─────────────────────────────────────────────────────

test("resolvePbxSipEndpointId: env pin wins; else copied off an already-routed number; else REFUSES", async () => {
  const prev = process.env.SIGNALWIRE_PBX_SIP_ENDPOINT_ID;
  try {
    process.env.SIGNALWIRE_PBX_SIP_ENDPOINT_ID = "pinned-id";
    assert.equal(await resolvePbxSipEndpointId({} as any, { listNumbers: (async () => []) as any }), "pinned-id");
    delete process.env.SIGNALWIRE_PBX_SIP_ENDPOINT_ID;
    const anchored = await resolvePbxSipEndpointId({} as any, {
      listNumbers: (async () => [
        { id: "n1", number: "+12053513327", raw: { call_handler: "relay_sip_endpoint", call_sip_endpoint_id: "ep-123" } },
      ]) as any,
    });
    assert.equal(anchored, "ep-123");
    const none = await resolvePbxSipEndpointId({} as any, { listNumbers: (async () => [{ id: "n1", number: "+1", raw: {} }]) as any });
    assert.equal(none, null, "no guessing — a wrongly-routed number is a customer whose calls go elsewhere");
  } finally {
    if (prev === undefined) delete process.env.SIGNALWIRE_PBX_SIP_ENDPOINT_ID;
    else process.env.SIGNALWIRE_PBX_SIP_ENDPOINT_ID = prev;
  }
});

// ── provisioning body ──────────────────────────────────────────────────────

function freshSubmission(extra: Row = {}): Row {
  return {
    id: "sub1",
    companyName: "Weiss Plumbing LLC",
    mainEmail: "sender@weissplumbing.com", // E911 requires a contact email
    phoneNumberChoice: "new",
    paidAt: new Date(),
    numberStatus: "provisioning",
    answers: {
      phone: { choice: "new", selectedNumber: "(845) 219-5667", provider: "signalwire" },
      contact: { name: "Sender Weiss", address: "30 Robert Pitt Dr", addressCity: "Monsey", addressState: "NY", addressZip: "10952" },
    },
    ...extra,
  };
}

const CREDS = { spaceUrl: "loopcom.signalwire.com", projectId: "p", apiToken: "t" } as any;

test("dry-run (gate off) narrates and lands ready_dryrun — no provider calls at all", async () => {
  const prev = process.env.SIGNALWIRE_AUTO_PROVISION;
  delete process.env.SIGNALWIRE_AUTO_PROVISION;
  try {
    assert.equal(signalWireAutoProvisionEnabled(), false);
    state.submission = freshSubmission();
    state.events = [];
    let calls = 0;
    const res = await applySignalWireOnboardingNumber("sub1", {
      resolveCreds: (async () => CREDS) as any,
      listNumbers: (async () => { calls++; return []; }) as any,
      purchaseNumber: (async () => { calls++; throw new Error("must not purchase in dry-run"); }) as any,
    });
    assert.equal(res.ok, true);
    assert.equal(res.live, false);
    assert.equal(state.submission!.numberStatus, "ready_dryrun");
    assert.equal(state.submission!.provisionedDid, "8452195667");
    assert.equal(calls, 0, "a dry run must not touch the provider");
  } finally {
    if (prev !== undefined) process.env.SIGNALWIRE_AUTO_PROVISION = prev;
  }
});

test("live new number: adopt-if-owned, else purchase; route + E911; ready", async () => {
  process.env.SIGNALWIRE_AUTO_PROVISION = "on";
  try {
    state.submission = freshSubmission();
    state.events = [];
    const actions: string[] = [];
    const res = await applySignalWireOnboardingNumber("sub1", {
      resolveCreds: (async () => CREDS) as any,
      listNumbers: (async () => [
        { id: "anchor", number: "+12053513327", raw: { call_handler: "relay_sip_endpoint", call_sip_endpoint_id: "ep-1" } },
      ]) as any,
      purchaseNumber: (async (_c: any, e164: string) => {
        actions.push(`buy:${e164}`);
        return { id: "num-1", number: e164, raw: {} };
      }) as any,
      updateNumberHandlers: (async (_c: any, id: string, patch: any) => {
        actions.push(`route:${id}:${patch.callHandler}:${patch.callSipEndpointId}:${patch.messageHandler}`);
        return { id, number: "+18452195667", raw: {} };
      }) as any,
      createE911Address: (async (_c: any, input: any) => {
        actions.push(`e911addr:${input.city}`);
        return { id: "addr-1", label: null, line: "", emergencyEnabled: true, raw: { street_number: "30", street_name: "Robert Pitt Dr", city: "SPRING VALLEY", state: "NY", postal_code: "10952" } };
      }) as any,
      assignE911Address: (async (_c: any, numberId: string, addressId: string) => {
        actions.push(`e911assign:${numberId}:${addressId}`);
        return { id: numberId, raw: {} };
      }) as any,
    });
    assert.equal(res.ok, true, JSON.stringify(state.events));
    assert.equal(state.submission!.numberStatus, "ready");
    assert.equal(state.submission!.provisionedDid, "8452195667");
    assert.deepEqual(actions, [
      "buy:+18452195667",
      "route:num-1:relay_sip_endpoint:ep-1:laml_webhooks",
      "e911addr:Monsey",
      "e911assign:num-1:addr-1",
    ]);
    // The registered address records the CORRECTED town — that is what a
    // dispatcher is handed and what the customer's email will state.
    const e911 = (state.submission!.answers as any).provisioning.e911;
    assert.equal(e911.status, "provisioned");
    assert.equal(e911.address.city, "SPRING VALLEY");
    assert.deepEqual(e911.corrected, { city: "SPRING VALLEY" });
  } finally {
    delete process.env.SIGNALWIRE_AUTO_PROVISION;
  }
});

test("a purchase TIMEOUT reconciles by re-listing before failing (a timeout is 'I stopped listening')", async () => {
  process.env.SIGNALWIRE_AUTO_PROVISION = "on";
  try {
    state.submission = freshSubmission();
    state.events = [];
    const { SignalWireError } = await import("../signalwire/signalWireClient");
    let listCalls = 0;
    const res = await applySignalWireOnboardingNumber("sub1", {
      resolveCreds: (async () => CREDS) as any,
      listNumbers: (async () => {
        listCalls++;
        // first list: not owned; post-timeout list: it LANDED
        return listCalls === 1
          ? [{ id: "anchor", number: "+12053513327", raw: { call_handler: "relay_sip_endpoint", call_sip_endpoint_id: "ep-1" } }]
          : [
              { id: "anchor", number: "+12053513327", raw: { call_handler: "relay_sip_endpoint", call_sip_endpoint_id: "ep-1" } },
              { id: "num-9", number: "+18452195667", raw: {} },
            ];
      }) as any,
      purchaseNumber: (async () => {
        throw new SignalWireError(0, "timeout", "timed out");
      }) as any,
      updateNumberHandlers: (async (_c: any, id: string) => ({ id, number: "+18452195667", raw: {} })) as any,
      createE911Address: (async () => ({ id: "addr-1", label: null, line: "", emergencyEnabled: true, raw: {} })) as any,
      assignE911Address: (async () => ({ id: "num-9", raw: {} })) as any,
    });
    assert.equal(res.ok, true);
    assert.equal(state.submission!.numberStatus, "ready");
    assert.ok(state.events.some((e) => e.includes("timed out but LANDED")), state.events.join("|"));
  } finally {
    delete process.env.SIGNALWIRE_AUTO_PROVISION;
  }
});

test("no routable endpoint REFUSES the build loudly (a bought number routed nowhere is worse than a failed build)", async () => {
  process.env.SIGNALWIRE_AUTO_PROVISION = "on";
  try {
    state.submission = freshSubmission();
    const res = await applySignalWireOnboardingNumber("sub1", {
      resolveCreds: (async () => CREDS) as any,
      listNumbers: (async () => []) as any,
      purchaseNumber: (async (_c: any, e164: string) => ({ id: "num-1", number: e164, raw: {} })) as any,
    });
    assert.equal(res.ok, false);
    assert.equal(state.submission!.numberStatus, "failed");
    assert.match(String(state.submission!.setupError), /signalwire_pbx_endpoint_not_found/);
  } finally {
    delete process.env.SIGNALWIRE_AUTO_PROVISION;
  }
});

test("port sign-up: temp number bought + port recorded for MANUAL filing — no carrier port call exists to make", async () => {
  process.env.SIGNALWIRE_AUTO_PROVISION = "on";
  try {
    state.submission = freshSubmission({
      phoneNumberChoice: "port",
      answers: {
        phone: { choice: "port", provider: "signalwire", details: { numbers: "(347) 555-0182" } },
        contact: { name: "Sender Weiss", address: "30 Robert Pitt Dr", addressCity: "Monsey", addressState: "NY", addressZip: "10952" },
      },
    });
    state.events = [];
    const searched: any[] = [];
    const res = await applySignalWireOnboardingNumber("sub1", {
      resolveCreds: (async () => CREDS) as any,
      listNumbers: (async () => [
        { id: "anchor", number: "+12053513327", raw: { call_handler: "relay_sip_endpoint", call_sip_endpoint_id: "ep-1" } },
      ]) as any,
      searchNumbers: (async (_c: any, params: any) => {
        searched.push(params);
        return [{ number: "+13475550999", region: "NY", city: "", rateCenter: "", capabilities: { voice: true, sms: true, mms: true, fax: false } }];
      }) as any,
      purchaseNumber: (async (_c: any, e164: string) => ({ id: "tmp-1", number: e164, raw: {} })) as any,
      updateNumberHandlers: (async (_c: any, id: string) => ({ id, number: "+13475550999", raw: {} })) as any,
      createE911Address: (async () => ({ id: "addr-1", label: null, line: "", emergencyEnabled: true, raw: {} })) as any,
      assignE911Address: (async () => ({ id: "tmp-1", raw: {} })) as any,
    });
    assert.equal(res.ok, true);
    assert.equal(res.detail, "port_awaiting_manual_filing_temp_assigned");
    assert.equal(state.submission!.didIsTemporary, true);
    assert.equal(state.submission!.provisionedDid, "3475550999");
    assert.equal(searched[0]?.areaCode, "347", "temp number searched in the ported number's own area code");
    const filing = (state.submission!.answers as any).provisioning.portFiling;
    assert.equal(filing.status, "awaiting_manual_filing");
    assert.equal(filing.portedDid, "3475550182");
  } finally {
    delete process.env.SIGNALWIRE_AUTO_PROVISION;
  }
});

// ── SOURCE guards: the callers are where this class of defect lives ────────

test("applyOnboardingNumber DISPATCHES on the submission's provider stamp (dynamic import, no cycle)", () => {
  const src = read("voipMsProvisioning.ts");
  assert.match(src, /answers as any\)\?\.phone\?\.provider \|\| "voipms"/);
  assert.match(src, /await import\("\.\/signalWireProvisioning"\)/);
  assert.match(src, /return applySignalWireOnboardingNumber\(submissionId\)/);
});

test("apply-number STAMPS the provider at selection time (an earlier stamp survives)", () => {
  const src = read("publicRoutes.ts");
  assert.match(src, /provider: answers\.phone\?\.provider \|\| onboardingNumberProvider\(\)/);
});

test("the numbers route has a SignalWire branch that keeps the error contract", () => {
  const src = read("publicRoutes.ts");
  assert.match(src, /onboardingNumberProvider\(\) === "signalwire"/);
  assert.match(src, /searchSignalWireOnboardingNumbers\(/);
  // A provider failure must NEVER collapse into a silent empty list.
  assert.match(src, /out\.reason === "unconfigured"/);
  assert.match(src, /number_search_failed/);
});

test("buildPbxTenant: a SignalWire build uses the SHARED trunk and never creates a per-tenant one", () => {
  const src = read("pbxTenantBuild.ts");
  assert.match(src, /SIGNALWIRE_SHARED_TRUNK_NAME = "SignalWire loopcom-pbx"/);
  assert.match(src, /numberProvider === "signalwire"/);
  // The signalwire branch must throw when the shared trunk is missing —
  // never silently fall through to createTrunk with no voipms credentials.
  assert.match(src, /shared SignalWire trunk "\$\{SIGNALWIRE_SHARED_TRUNK_NAME\}" not found/);
});

test("the orchestrator passes the provider into the PBX job and skips the subaccount requirement for SignalWire", () => {
  const src = read("setupOrchestrator.ts");
  assert.match(src, /numberProvider: isSignalWire \? "signalwire" : "voipms"/);
  assert.match(src, /if \(!isSignalWire && !sub\) throw new Error\("number_stage_missing_subaccount_or_did"\)/);
});
