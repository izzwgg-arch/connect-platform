/**
 * 10DLC registration chain — unit + wiring guards (2026-08-30).
 *
 * Run:
 *   node --experimental-test-module-mocks --import tsx --test src/signalwire/signalWireTenDlc.test.ts
 *
 * The EIN-never-stored promise is enforced here three ways: the schema has no
 * column for it, the wizard endpoint never merges it into answers, and the
 * filing path hands it to createBrand and nothing else.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");

// ── client mock (before the late require) ──────────────────────────────────
const clientCalls: Array<{ fn: string; args: any[] }> = [];
const clientState: {
  brandState: string;
  campaignState: string;
  createBrandResult?: any;
  throwOn?: string;
} = { brandState: "pending", campaignState: "pending" };

class FakeSwError extends Error {
  constructor(public status: number, public code: string, public userMessage: string, public detail?: unknown) {
    super(userMessage);
  }
}

mock.module("./signalWireClient", {
  namedExports: {
    SignalWireError: FakeSwError,
    createBrand: async (_c: any, input: any) => {
      clientCalls.push({ fn: "createBrand", args: [input] });
      if (clientState.throwOn === "createBrand") throw new FakeSwError(422, "invalid_request", "refused", { ein: "invalid" });
      return clientState.createBrandResult ?? { id: "brand-1", state: "pending", raw: {} };
    },
    getBrand: async (_c: any, id: string) => {
      clientCalls.push({ fn: "getBrand", args: [id] });
      if (clientState.throwOn === "getBrand") throw new FakeSwError(0, "timeout", "timed out");
      return { id, state: clientState.brandState, raw: {} };
    },
    createCampaign: async (_c: any, brandId: string, input: any) => {
      clientCalls.push({ fn: "createCampaign", args: [brandId, input] });
      return { id: "camp-1", state: "pending", raw: {} };
    },
    getCampaign: async (_c: any, id: string) => {
      clientCalls.push({ fn: "getCampaign", args: [id] });
      return { id, state: clientState.campaignState, raw: {} };
    },
    createCampaignNumberOrder: async (_c: any, campaignId: string, numbers: string[]) => {
      clientCalls.push({ fn: "createCampaignNumberOrder", args: [campaignId, numbers] });
      return { id: "order-1", state: "pending", raw: {} };
    },
  },
});
mock.module("./signalWireCredentials", {
  namedExports: {
    resolveSignalWireCredentials: async () => ({ spaceUrl: "x", projectId: "p", apiToken: "t" }),
  },
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tenDlc = require("./signalWireTenDlc");
const {
  buildCampaignInput,
  classifyRegistryState,
  DAILY_CAP_BY_CLASSIFICATION,
  fileBrandForRegistration,
  advanceSmsRegistration,
  SMS_REGISTRATION_ACTIVE_EMAIL_TYPE,
} = tenDlc;

// ── fake db (passed as an argument — the module takes db explicitly) ───────
function makeDb() {
  const state: any = {
    reg: null,
    submission: null,
    tenantUpdates: [] as any[],
    emailJobs: [] as any[],
    events: [] as string[],
    smsNumberUpserts: [] as any[],
  };
  const db = {
    tenantSmsNumber: {
      // Activation wires the number into chat (provider: "SIGNALWIRE") before
      // marking the row active — a fake missing this accessor exercises a
      // shape production never produces (the turn-health class): the upsert
      // throws into the retry catch and the row never activates.
      upsert: async (args: any) => {
        state.smsNumberUpserts.push(args);
        return args.create;
      },
    },
    tenantSmsRegistration: {
      findUnique: async () => state.reg,
      findMany: async () => (state.reg ? [state.reg] : []),
      update: async ({ data }: any) => {
        state.reg = { ...state.reg, ...data };
        return state.reg;
      },
      upsert: async ({ create }: any) => {
        state.reg = { id: "reg-1", ...create };
        return state.reg;
      },
    },
    onboardingSubmission: {
      findUnique: async () => state.submission,
    },
    onboardingEvent: {
      create: async ({ data }: any) => {
        state.events.push(String(data.message));
        return data;
      },
    },
    tenant: {
      update: async (args: any) => {
        state.tenantUpdates.push(args);
        return {};
      },
    },
    emailJob: {
      create: async ({ data }: any) => {
        state.emailJobs.push(data);
        return data;
      },
    },
  };
  return { db, state };
}

// ── campaign content ───────────────────────────────────────────────────────

test("conversational campaigns are LOW_VOLUME_MIXED with registry-valid lengths", () => {
  const c = buildCampaignInput({ classification: "conversational", legalName: "Weiss Plumbing LLC" });
  assert.equal(c.smsUseCase, "LOW_VOLUME_MIXED");
  assert.ok(c.subUseCases?.includes("CUSTOMER_CARE"));
  assert.ok(c.description.length >= 40, "registry requires ≥40 chars");
  assert.ok(c.sample1.length >= 20 && c.sample2.length >= 20, "registry requires ≥20 chars");
  assert.match(c.optOutMessage, /unsubscribed/i);
});

test("marketing/OWN-system campaigns carry the CUSTOMER'S words; loopcom-hosted are templated", () => {
  const own = buildCampaignInput({
    classification: "marketing",
    senderSystem: "own",
    legalName: "Weiss Plumbing LLC",
    messageFlow: "Customers text JOIN at checkout to get our weekly specials list.",
    sample1: "Weiss Plumbing: 20% off drain cleaning this week only!",
    sample2: "Weiss Plumbing: your annual inspection is due — reply to book.",
  });
  assert.equal(own.smsUseCase, "MARKETING");
  assert.match(own.sample1, /20% off/);
  assert.match(own.messageFlow, /JOIN at checkout/);
  const hosted = buildCampaignInput({ classification: "marketing", senderSystem: "loopcom", legalName: "Weiss Plumbing LLC" });
  assert.doesNotMatch(hosted.sample1, /20% off/);
  assert.ok(hosted.description.length >= 40);
});

test("registry state classification: approved / failed / pending", () => {
  assert.equal(classifyRegistryState("APPROVED"), "approved");
  assert.equal(classifyRegistryState("Verified"), "approved");
  assert.equal(classifyRegistryState("rejected"), "failed");
  assert.equal(classifyRegistryState("in_review"), "pending");
  assert.equal(classifyRegistryState(""), "pending");
});

test("the enforced daily caps mirror the carrier classes", () => {
  assert.equal(DAILY_CAP_BY_CLASSIFICATION.conversational, 2000);
  assert.equal(DAILY_CAP_BY_CLASSIFICATION.sole_prop, 1000);
});

// ── filing ─────────────────────────────────────────────────────────────────

test("fileBrand: live filing passes the EIN through to createBrand and stores ONLY the registry ids", async () => {
  process.env.SIGNALWIRE_AUTO_PROVISION = "on";
  try {
    const { db, state } = makeDb();
    state.reg = {
      id: "reg-1",
      submissionId: "sub-1",
      classification: "conversational",
      legalName: "Weiss Plumbing LLC",
      entityType: "PRIVATE_PROFIT",
      website: "weissplumbingny.com",
      brandId: null,
    };
    clientCalls.length = 0;
    const out = await fileBrandForRegistration(db, {
      registrationId: "reg-1",
      ein: "82-1234541",
      contactEmail: "sender@weissplumbing.com",
      contactPhone: "8455550182",
      companyAddress: "30 Robert Pitt Dr, Monsey, NY 10952",
    });
    assert.deepEqual(out, { filed: true, brandId: "brand-1", state: "pending" });
    assert.equal(clientCalls[0].fn, "createBrand");
    assert.equal(clientCalls[0].args[0].ein, "82-1234541", "the EIN reaches the registry");
    // …and is stored NOWHERE:
    assert.equal(JSON.stringify(state.reg).includes("1234541"), false, "no row may carry the EIN");
    assert.equal(state.events.join("|").includes("1234541"), false, "no event may carry the EIN");
    assert.equal(state.reg.status, "brand_filed");
    assert.equal(state.reg.brandId, "brand-1");
  } finally {
    delete process.env.SIGNALWIRE_AUTO_PROVISION;
  }
});

test("fileBrand: sole-prop and already-filed refuse; live gate off refuses as not_live", async () => {
  const { db, state } = makeDb();
  state.reg = { id: "reg-1", classification: "sole_prop", brandId: null };
  assert.deepEqual(await fileBrandForRegistration(db, { registrationId: "reg-1", ein: "821234541", contactEmail: "x@y.com", contactPhone: "1", companyAddress: "a" }), {
    filed: false,
    reason: "manual_class",
  });
  state.reg = { id: "reg-1", classification: "conversational", brandId: "brand-9" };
  assert.equal((await fileBrandForRegistration(db, { registrationId: "reg-1", ein: "821234541", contactEmail: "x@y.com", contactPhone: "1", companyAddress: "a" }) as any).reason, "already_filed");
  state.reg = { id: "reg-1", classification: "conversational", brandId: null };
  delete process.env.SIGNALWIRE_AUTO_PROVISION;
  assert.equal((await fileBrandForRegistration(db, { registrationId: "reg-1", ein: "821234541", contactEmail: "x@y.com", contactPhone: "1", companyAddress: "a" }) as any).reason, "not_live");
});

test("fileBrand: a registry refusal records the error WITHOUT the EIN and reports provider_refused", async () => {
  process.env.SIGNALWIRE_AUTO_PROVISION = "on";
  clientState.throwOn = "createBrand";
  try {
    const { db, state } = makeDb();
    state.reg = { id: "reg-1", submissionId: "sub-1", classification: "conversational", legalName: "X Co", brandId: null };
    const out = await fileBrandForRegistration(db, { registrationId: "reg-1", ein: "82-9876543", contactEmail: "x@y.com", contactPhone: "1", companyAddress: "a" });
    assert.equal((out as any).reason, "provider_refused");
    assert.equal(JSON.stringify(state.reg).includes("9876543"), false);
    assert.equal(state.events.join("|").includes("9876543"), false);
  } finally {
    clientState.throwOn = undefined;
    delete process.env.SIGNALWIRE_AUTO_PROVISION;
  }
});

// ── the state machine ──────────────────────────────────────────────────────

test("advance: brand approved → campaign filed; campaign approved → number order → ACTIVE with cap + email", async () => {
  process.env.SIGNALWIRE_AUTO_PROVISION = "on";
  try {
    const { db, state } = makeDb();
    state.reg = {
      id: "reg-1",
      submissionId: "sub-1",
      tenantId: "ten-1",
      classification: "conversational",
      legalName: "Weiss Plumbing LLC",
      brandId: "brand-1",
      campaignId: null,
      status: "brand_filed",
      phoneE164: null,
    };
    state.submission = { id: "sub-1", provisionedDid: "8452195667", mainEmail: "sender@weissplumbing.com", companyName: "Weiss Plumbing LLC" };

    clientState.brandState = "approved";
    clientCalls.length = 0;
    await advanceSmsRegistration(db, "reg-1");
    assert.equal(state.reg.status, "campaign_filed");
    assert.equal(state.reg.campaignId, "camp-1");

    clientState.campaignState = "approved";
    await advanceSmsRegistration(db, "reg-1");
    assert.equal(state.reg.status, "active", state.events.join("|"));
    assert.equal(state.reg.phoneE164, "+18452195667", "the number came from the submission's provisioned DID");
    const order = clientCalls.find((c) => c.fn === "createCampaignNumberOrder");
    assert.deepEqual(order?.args[1], ["+18452195667"]);
    // The class cap is ENFORCED on the tenant, and the customer is told —
    // on the registration's own email type, never ADMIN_ALERT (muted).
    assert.equal(state.tenantUpdates[0]?.data?.dailySmsCap, 2000);
    assert.equal(state.emailJobs[0]?.type, SMS_REGISTRATION_ACTIVE_EMAIL_TYPE);
    assert.notEqual(state.emailJobs[0]?.type, "ADMIN_ALERT");
    // Activation wires the number into the CHAT system: the TenantSmsNumber
    // row is what routes inbound webhooks and flips outbound to SignalWire.
    const up = state.smsNumberUpserts[0];
    assert.equal(up?.where?.phoneE164, "+18452195667");
    assert.equal(up?.create?.provider, "SIGNALWIRE");
    assert.equal(up?.create?.tenantId, "ten-1");
    assert.equal(up?.create?.mmsCapable, true);
    // An existing row must keep its assignment + default flag.
    assert.ok(!("isTenantDefault" in (up?.update ?? {})), "update never stomps isTenantDefault");
  } finally {
    clientState.brandState = "pending";
    clientState.campaignState = "pending";
    delete process.env.SIGNALWIRE_AUTO_PROVISION;
  }
});

test("advance: a registry REJECTION fails the row loudly; a transient error records and retries", async () => {
  process.env.SIGNALWIRE_AUTO_PROVISION = "on";
  try {
    const { db, state } = makeDb();
    state.reg = { id: "reg-1", submissionId: "sub-1", classification: "conversational", brandId: "brand-1", campaignId: null, status: "brand_filed" };
    clientState.brandState = "rejected";
    await advanceSmsRegistration(db, "reg-1");
    assert.equal(state.reg.status, "failed");
    assert.match(String(state.reg.error), /brand_rejected/);

    const { db: db2, state: s2 } = makeDb();
    s2.reg = { id: "reg-1", submissionId: "sub-1", classification: "conversational", brandId: "brand-1", campaignId: null, status: "brand_filed" };
    clientState.brandState = "pending";
    clientState.throwOn = "getBrand";
    await advanceSmsRegistration(db2, "reg-1");
    assert.equal(s2.reg.status, "brand_filed", "a timeout must not fail the row — the sweep retries");
    assert.equal(s2.reg.error, "timeout");
  } finally {
    clientState.throwOn = undefined;
    clientState.brandState = "pending";
    delete process.env.SIGNALWIRE_AUTO_PROVISION;
  }
});

test("advance: campaign approved but number NOT purchased yet → waits (the sweep retries after payment)", async () => {
  process.env.SIGNALWIRE_AUTO_PROVISION = "on";
  try {
    const { db, state } = makeDb();
    state.reg = { id: "reg-1", submissionId: "sub-1", classification: "conversational", brandId: "brand-1", campaignId: "camp-1", status: "campaign_filed", phoneE164: null };
    state.submission = { id: "sub-1", provisionedDid: null };
    clientState.campaignState = "approved";
    clientCalls.length = 0;
    await advanceSmsRegistration(db, "reg-1");
    assert.equal(state.reg.status, "campaign_approved");
    assert.equal(clientCalls.some((c) => c.fn === "createCampaignNumberOrder"), false);
  } finally {
    clientState.campaignState = "pending";
    delete process.env.SIGNALWIRE_AUTO_PROVISION;
  }
});

// ── wiring + promise guards (source-read; comments stay in — the strings
//    asserted here are executable-code shapes, not prose) ───────────────────

test("⛔ the schema has NO EIN column on TenantSmsRegistration — and must never grow one", () => {
  const schema = fs
    .readFileSync(path.join(__dirname, "../../../../packages/db/prisma/schema.prisma"), "utf8")
    .replace(/\r\n/g, "\n");
  const start = schema.indexOf("model TenantSmsRegistration {");
  assert.ok(start > 0, "model exists");
  const block = schema.slice(start, schema.indexOf("}", start));
  assert.doesNotMatch(block, /^\s*ein\b/im, "no ein field");
  assert.doesNotMatch(block, /^\s*ssn/im, "no ssn field");
});

test("the wizard endpoint never merges the EIN into answers, and the answers.texting block carries no ein key", () => {
  const src = read("../onboarding/publicRoutes.ts");
  const start = src.indexOf("answers.texting = {");
  assert.ok(start > 0, "answers.texting block exists");
  const block = src.slice(start, src.indexOf("};", start));
  assert.doesNotMatch(block, /\bein\b/, "the autosaved answers must never carry the EIN");
  assert.match(src, /fileBrandForRegistration\(db, \{\s*registrationId: reg\.id,\s*ein: body\.ein!/);
});

test("the registry webhook is on the JWT bypass list (401 = you never reached the handler)", () => {
  const src = read("../jwtPublicRouteBypass.ts");
  assert.match(src, /"\/webhooks\/signalwire\/registry"/);
  assert.match(src, /path\.endsWith\("\/webhooks\/signalwire\/registry"\)/);
});

test("server.ts arms the sweep and the orchestrator links + kicks the registration", () => {
  const server = read("../server.ts");
  assert.match(server, /startSmsRegistrationSweep\(db as any, app\.log\)/);
  const orch = read("../onboarding/setupOrchestrator.ts");
  assert.match(orch, /tenantSmsRegistration\.findUnique\(\{ where: \{ submissionId \} \}\)/);
  assert.match(orch, /advanceSmsRegistration\(db as any, reg\.id\)/);
});
