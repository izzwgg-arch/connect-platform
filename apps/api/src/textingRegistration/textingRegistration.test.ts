/**
 * 10DLC texting registration — tests (2026-09-16).
 *
 * Layers, in the order a failure would bite:
 *   1. the carrier wording + checks (a wrong word here is a carrier rejection)
 *   2. the EIN token and customer link tokens (a leak here is a real harm)
 *   3. registry state mapping (a wrong mapping turns texting on too early)
 *   4. the Telnyx client against a FAKE fetch (request shapes, three error
 *      shapes, and a timeout is never re-sent)
 *   5. the whole engine against an in-memory database and a simulated
 *      registry — happy path, double presses, races, timeouts, refusals,
 *      the fix loop, sole proprietor PIN — plus a stress run
 *   6. source guards on the wiring, the money path and the customer surfaces
 *
 * ⛔ Nothing here calls Telnyx or a database. Every mutating Telnyx call costs money.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.CREDENTIALS_MASTER_KEY = "a".repeat(64);

import {
  buildCampaignContent,
  buildPrivacyPolicy,
  buildSmsTerms,
  checksBlockFiling,
  formatUsPhone,
  namesBusiness,
  normalizeEin,
  runFilingChecks,
  slugify,
  validateCustomerAnswers,
  type BusinessFacts,
} from "./content";
import {
  detokenizeEin,
  einTokenExpired,
  hashLinkToken,
  isWellFormedLinkToken,
  linkState,
  maskedEin,
  newLinkToken,
  tokenizeEin,
  EinVaultUnavailableError,
} from "./tokens";
import { assignmentPhase, brandPhase, campaignPhase, carrierReviews, pickConversationalUsecase } from "./phases";
import * as registry from "./registryClient";
import { TelnyxError, setTelnyxFetch } from "../telnyx/telnyxClient";
import {
  RECONCILE_GIVE_UP_MS,
  advanceRegistration,
  createLink,
  createRegistration,
  deactivate,
  fileWithTelnyx,
  publicView,
  resetRegistryCaches,
  resolvePublicLink,
  revealEin,
  saveDraft,
  sendBackToCustomer,
  submitCustomerForm,
  sweepRegistrations,
  updateContent,
  verifyOwnerPin,
  RegistrationError,
  type EngineDeps,
} from "./engine";
import { buildInviteEmail, buildReadyEmail, INVITE_EMAIL_TYPE, READY_EMAIL_TYPE } from "./emails";
import { createLimiter, extractRegistryIds } from "./routes";
import { createFakeDb } from "./fakeDb.testutil";

const CARRIER_NAMES = /telnyx|signalwire|signal\s*wire|voip\.?ms|bandwidth|twilio/i;
const DEFERRED = /\$1\.50|\$10\/mo|monthly fee|marketing program|\bpromotions?\b|\bspecials?\b/i;

const FACTS: BusinessFacts = {
  displayName: "Hudson Valley Tire Co.",
  legalName: "Hudson Valley Tire Company LLC",
  businessPhone: "8455550142",
  businessEmail: "office@hvtire.com",
  privacyUrl: "https://app.example.com/texting-policy/hudson-valley-tire-co",
  termsUrl: "https://app.example.com/texting-policy/hudson-valley-tire-co#terms",
};

const GOOD_ANSWERS = {
  legalName: "Hudson Valley Tire Company LLC",
  entityType: "PRIVATE_PROFIT",
  ein: "12-3456789",
  street: "1180 Route 9W",
  city: "Newburgh",
  state: "NY",
  postalCode: "12550",
  website: "https://hvtire.com",
};

// ── 1. Wording + checks ─────────────────────────────────────────────────────

test("generated wording passes every filing check for an ordinary business", () => {
  const content = buildCampaignContent(FACTS);
  const checks = runFilingChecks({ facts: FACTS, answers: GOOD_ANSWERS, content, einPresent: true, numbersOnTelnyx: 2 });
  const failing = checks.filter((c) => c.level !== "pass");
  assert.deepEqual(failing, []);
  assert.equal(checksBlockFiling(checks), false);
});

test("generated wording works for awkward names (punctuation, very long, apostrophes)", () => {
  for (const displayName of ["A&B's Plumbing, Inc.", "Ö Café", "X".repeat(140), "The Co"]) {
    const facts = { ...FACTS, displayName };
    const content = buildCampaignContent(facts);
    const checks = runFilingChecks({ facts, answers: GOOD_ANSWERS, content, einPresent: true, numbersOnTelnyx: 1 });
    assert.equal(checksBlockFiling(checks), false, `${displayName}: ${JSON.stringify(checks.filter((c) => c.level === "fail"))}`);
  }
});

test("wording, policy, terms and emails never name a carrier, a price, or marketing", () => {
  const content = buildCampaignContent(FACTS);
  const all = [
    ...Object.values(content),
    ...buildPrivacyPolicy(FACTS).paragraphs,
    buildPrivacyPolicy(FACTS).title,
    ...buildSmsTerms(FACTS).paragraphs,
  ].join("\n");
  assert.doesNotMatch(all, CARRIER_NAMES);
  assert.doesNotMatch(all, DEFERRED);
  const invite = buildInviteEmail({ displayName: "Hudson Valley Tire Co.", firstName: "Dana", formUrl: "https://app.example.com/texting-registration/abc" });
  const ready = buildReadyEmail({ displayName: "Hudson Valley Tire Co.", firstName: "Dana" });
  for (const m of [invite, ready]) {
    assert.doesNotMatch(m.subject + m.text + m.html.replace(/<[^>]+>/g, " "), CARRIER_NAMES);
    assert.doesNotMatch(m.subject + m.text, DEFERRED);
  }
});

test("the invite email is exactly Izzy's copy: regulation, continue using SMS, fill out the 10DLC form, the link", () => {
  const url = "https://app.example.com/texting-registration/tok123";
  const m = buildInviteEmail({ displayName: "Hudson Valley Tire Co.", firstName: "Dana", formUrl: url });
  assert.match(m.text, /carriers now require/i);
  assert.match(m.text, /To continue using SMS/);
  assert.match(m.text, /10DLC form/);
  assert.ok(m.text.includes(url));
  assert.ok(m.html.includes(url));
  assert.match(m.html, /Fill out the 10DLC form/);
  assert.notEqual(INVITE_EMAIL_TYPE, "ADMIN_ALERT");
  assert.notEqual(READY_EMAIL_TYPE, "ADMIN_ALERT");
  // Built on the one Loopcom shell (logo on the card + footer naming the customer).
  assert.match(m.html, /sent on behalf of Hudson Valley Tire Co\./);
  assert.match(m.html, /loopcom-wordmark-email-336\.png/);
});

test("the privacy policy is in the business's LEGAL name and carries the no-sharing wording", () => {
  const p = buildPrivacyPolicy(FACTS);
  assert.match(p.title, /^Hudson Valley Tire Company LLC/);
  const text = p.paragraphs.join(" ");
  assert.match(text, /will not be sold or shared with any third parties/);
  assert.match(text, /No mobile information will be shared with third parties or affiliates/);
  assert.doesNotMatch(text, /loopcom/i);
});

test("checks catch the real rejection causes", () => {
  const content = buildCampaignContent(FACTS);
  const run = (patch: Record<string, string>) =>
    runFilingChecks({ facts: FACTS, answers: GOOD_ANSWERS, content: { ...content, ...patch }, einPresent: true, numbersOnTelnyx: 1 }).filter((c) => c.level === "fail").map((c) => c.id);
  assert.ok(run({ sample1: "Your order is ready. Reply STOP to opt out." }).includes("sample1Names"));
  assert.ok(run({ sample2: "Hudson Valley Tire Co.: your order is ready." }).includes("sample2Optout"));
  assert.ok(run({ sample1: "Hudson Valley Tire Co.: see https://x.co/a. Reply STOP to opt out." }).includes("sample1NoLink"));
  assert.ok(run({ sample1: "Hudson Valley Tire Co.: call 845-555-0142. Reply STOP to opt out." }).includes("sample1NoPhone"));
  assert.ok(run({ sample2: "Hudson Valley Tire Co.: big SALE this week! Reply STOP to opt out." }).includes("sample2NoMarketing"));
  assert.ok(run({ description: "too short" }).includes("description"));
  assert.ok(run({ helpMessage: "Hudson Valley Tire Co.: reply to this. STOP to opt out." }).includes("helpContact"));
  assert.ok(run({ optoutKeywords: "STOP, END" }).includes("optoutKw"));
  assert.ok(run({ messageFlow: content.messageFlow.replace(/optional/g, "") .replace(/not a condition/g, "") }).includes("optinOptional"));
  const noEin = runFilingChecks({ facts: FACTS, answers: GOOD_ANSWERS, content, einPresent: false, numbersOnTelnyx: 1 });
  assert.equal(noEin.find((c) => c.id === "ein")?.level, "fail");
  const noNumbers = runFilingChecks({ facts: FACTS, answers: GOOD_ANSWERS, content, einPresent: true, numbersOnTelnyx: 0 });
  assert.equal(noNumbers.find((c) => c.id === "numbers")?.level, "warn");
  assert.equal(checksBlockFiling(noNumbers), false);
});

test("customer answers: every field the registry would refuse is caught with a plain message", () => {
  assert.deepEqual(validateCustomerAnswers(GOOD_ANSWERS, { einRequired: true }), {});
  const e = validateCustomerAnswers({ ...GOOD_ANSWERS, ein: "12-34", street: "PO Box 12", state: "ZZ", postalCode: "1255", website: "hvtire", entityType: "LLC" }, { einRequired: true });
  assert.deepEqual(Object.keys(e).sort(), ["entityType", "ein", "postalCode", "state", "street", "website"].sort());
  const e2 = validateCustomerAnswers({ ...GOOD_ANSWERS, ein: "12-34" }, { einRequired: true });
  assert.ok(e2.ein);
  const sole = validateCustomerAnswers({ ...GOOD_ANSWERS, entityType: "SOLE_PROPRIETOR", legalName: "Maria Rivera LLC", ein: null }, { einRequired: true });
  assert.ok(sole.legalName, "a sole proprietor name with LLC is refused");
  assert.equal(sole.ein, undefined, "a sole proprietor needs no EIN");
  assert.ok(validateCustomerAnswers({ ...GOOD_ANSWERS, street: "P.O. Box 9" }, { einRequired: true }).street);
});

test("small helpers", () => {
  assert.equal(formatUsPhone("+18455550142"), "(845) 555-0142");
  assert.equal(normalizeEin("12-3456789"), "123456789");
  assert.equal(normalizeEin("1234"), null);
  assert.equal(slugify("A&B's Plumbing, Inc."), "a-and-b-s-plumbing-inc");
  assert.equal(slugify("!!!"), "business");
  assert.ok(namesBusiness("hudson valley: hi", "Hudson Valley Tire Co."));
});

// ── 2. Tokens ───────────────────────────────────────────────────────────────

test("EIN token: opens only for its own registration, never holds plaintext, masks to last 4", () => {
  const t = tokenizeEin("12-3456789", "reg_A");
  assert.equal(t.last4, "6789");
  assert.ok(!t.token.includes("3456789"));
  assert.ok(!Buffer.from(t.token, "base64").toString("utf8").includes("3456789"));
  assert.equal(detokenizeEin(t.token, "reg_A"), "123456789");
  assert.equal(detokenizeEin(t.token, "reg_B"), null, "a token copied onto another registration must not open");
  assert.equal(detokenizeEin("garbage", "reg_A"), null);
  assert.equal(maskedEin(t.last4), "••-•••6789");
  assert.throws(() => tokenizeEin("123", "reg_A"), /ein_invalid/);
  assert.throws(() => tokenizeEin("12-3456789", "reg_A", { hasKey: () => false }), EinVaultUnavailableError);
});

test("EIN token expiry and link tokens", () => {
  const created = new Date("2026-09-01T00:00:00Z");
  assert.equal(einTokenExpired(created, new Date("2026-09-14T00:00:00Z")), false);
  assert.equal(einTokenExpired(created, new Date("2026-09-15T00:00:01Z")), true);
  const a = newLinkToken();
  const b = newLinkToken();
  assert.notEqual(a.token, b.token);
  assert.equal(a.hash, hashLinkToken(a.token));
  assert.ok(isWellFormedLinkToken(a.token));
  assert.equal(isWellFormedLinkToken("short"), false);
  assert.equal(isWellFormedLinkToken("../../etc/passwd" + "a".repeat(40)), false);
  const now = new Date("2026-09-16T12:00:00Z");
  assert.equal(linkState({ expiresAt: new Date("2026-10-01"), revokedAt: null, usedAt: null }, now), "ok");
  assert.equal(linkState({ expiresAt: new Date("2026-09-01"), revokedAt: null, usedAt: null }, now), "expired");
  assert.equal(linkState({ expiresAt: new Date("2026-10-01"), revokedAt: now, usedAt: null }, now), "revoked");
  assert.equal(linkState({ expiresAt: new Date("2026-10-01"), revokedAt: null, usedAt: now }, now), "used");
});

// ── 3. Registry state mapping ───────────────────────────────────────────────

test("brand phase: only a verified identity with a settled status counts as verified", () => {
  assert.equal(brandPhase({ identityStatus: "VERIFIED", status: "OK" }), "verified");
  assert.equal(brandPhase({ identityStatus: "VETTED_VERIFIED", status: "OK" }), "verified");
  assert.equal(brandPhase({ identityStatus: "VERIFIED", status: "REGISTRATION_PENDING" }), "pending");
  assert.equal(brandPhase({ identityStatus: "SELF_DECLARED", status: "OK" }), "pending");
  assert.equal(brandPhase({ identityStatus: "UNVERIFIED", status: "OK" }), "failed");
  assert.equal(brandPhase({ identityStatus: null, status: "REGISTRATION_FAILED" }), "failed");
  assert.equal(brandPhase({ identityStatus: "SOMETHING_NEW", status: "WHATEVER" }), "pending");
});

test("campaign phase: approval only after carriers accept; every rejection status caught; unknown stays reviewing", () => {
  for (const s of ["TCR_PENDING", "TCR_ACCEPTED", "TELNYX_ACCEPTED", "MNO_PENDING", "NEW_UNKNOWN"]) assert.equal(campaignPhase({ campaignStatus: s, status: "ACTIVE" }), "reviewing", s);
  for (const s of ["MNO_ACCEPTED", "MNO_PROVISIONED"]) assert.equal(campaignPhase({ campaignStatus: s, status: "ACTIVE" }), "approved", s);
  for (const s of ["TCR_FAILED", "TELNYX_FAILED", "MNO_REJECTED", "MNO_PROVISIONING_FAILED"]) assert.equal(campaignPhase({ campaignStatus: s, status: "ACTIVE" }), "rejected", s);
  for (const s of ["TCR_SUSPENDED", "TCR_EXPIRED"]) assert.equal(campaignPhase({ campaignStatus: s, status: "ACTIVE" }), "suspended", s);
  assert.equal(campaignPhase({ campaignStatus: "MNO_PROVISIONED", status: "EXPIRED" }), "suspended");
});

test("carrier reviews, assignment phase, usecase pick", () => {
  const r = carrierReviews({ "10017": "APPROVED", "10035": "REVIEW", "10999": "REJECTED" }, { "10017": "AT&T", "10035": "T-Mobile" });
  assert.deepEqual(r.map((x) => [x.carrier, x.state]), [["AT&T", "approved"], ["Carrier 10999", "rejected"], ["T-Mobile", "reviewing"]]);
  assert.equal(assignmentPhase(null, "C1"), "none");
  assert.equal(assignmentPhase({ assignmentStatus: "ASSIGNED", campaignId: "C1" }, "C1"), "assigned");
  assert.equal(assignmentPhase({ assignmentStatus: "ASSIGNED", campaignId: "C2" }, "C1"), "failed");
  assert.equal(assignmentPhase({ assignmentStatus: "PENDING_ASSIGNMENT", campaignId: "C1" }, "C1"), "pending");
  assert.equal(pickConversationalUsecase(["MARKETING", "LOW_VOLUME_MIXED"]), "LOW_VOLUME_MIXED");
  assert.equal(pickConversationalUsecase(["low_volume", "LOW_VOLUME_MIXED"]), "LOW_VOLUME");
  assert.equal(pickConversationalUsecase(["MARKETING"]), null);
});

// ── 4. Client against a fake fetch ──────────────────────────────────────────

type Req = { url: string; method: string; body: any };
function fakeFetch(handler: (r: Req) => { status: number; body?: any } | "timeout") {
  const calls: Req[] = [];
  setTelnyxFetch(async (url: string, init: any) => {
    const r: Req = { url, method: init.method, body: init.body ? JSON.parse(init.body) : null };
    calls.push(r);
    const out = handler(r);
    if (out === "timeout") {
      const e: any = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return { ok: out.status >= 200 && out.status < 300, status: out.status, text: async () => (out.body === undefined ? "" : JSON.stringify(out.body)), headers: { get: () => null } };
  });
  return calls;
}
const CREDS = { apiKey: "KEYtest", publicKey: null } as any;

test("client: brand create sends digits-only EIN, US country, webhook; omits EIN for sole proprietor", async () => {
  const calls = fakeFetch(() => ({ status: 200, body: { brandId: "B1", identityStatus: "SELF_DECLARED", status: "REGISTRATION_PENDING" } }));
  const input: registry.BrandInput = { entityType: "PRIVATE_PROFIT", displayName: "HV Tire", companyName: "HV Tire LLC", ein: "12-3456789", phone: "+18455550142", email: "a@b.co", street: "1 Main", city: "X", state: "ny", postalCode: "12550-1234", website: "https://x.co", vertical: "RETAIL", webhookURL: "https://api/webhooks/telnyx/10dlc" };
  const b = await registry.createBrand(CREDS, input);
  assert.equal(b.brandId, "B1");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v2\/10dlc\/brand$/);
  assert.equal(calls[0].body.ein, "123456789");
  assert.equal(calls[0].body.country, "US");
  assert.equal(calls[0].body.state, "NY");
  assert.equal(calls[0].body.postalCode, "12550");
  assert.equal(calls[0].body.webhookURL, "https://api/webhooks/telnyx/10dlc");
  await registry.createBrand(CREDS, { ...input, entityType: "SOLE_PROPRIETOR", ein: null, mobilePhone: "+19145550187" });
  assert.equal(calls[1].body.ein, undefined);
  assert.equal(calls[1].body.mobilePhone, "+19145550187");
  setTelnyxFetch(null);
});

test("client: a timed-out create is NOT re-sent (one request), and the error says it may have happened", async () => {
  const calls = fakeFetch(() => "timeout");
  await assert.rejects(() => registry.createCampaign(CREDS, { brandId: "B1", usecase: "LOW_VOLUME", subUsecases: [], referenceId: "ref-1", description: "d", messageFlow: "m", sample1: "a", sample2: "b", helpMessage: "h", optoutMessage: "o", optinMessage: "i", helpKeywords: "HELP", optoutKeywords: "STOP", optinKeywords: "START", privacyPolicyLink: "p", termsAndConditionsLink: "t" }), (e: any) => e instanceof TelnyxError && e.code === "timeout");
  assert.equal(calls.length, 1);
  assert.equal(registry.isDefiniteRefusal(new TelnyxError(0, "timeout", "x")), false);
  setTelnyxFetch(null);
});

test("client: campaign create carries referenceId, subscriber flags, policy links, no embedded links/phones", async () => {
  const calls = fakeFetch(() => ({ status: 200, body: { campaignId: "C1", campaignStatus: "TCR_PENDING", referenceId: "ref-1" } }));
  const c = await registry.createCampaign(CREDS, { brandId: "B1", usecase: "LOW_VOLUME", subUsecases: ["CUSTOMER_CARE"], referenceId: "ref-1", description: "d", messageFlow: "m", sample1: "a", sample2: "b", helpMessage: "h", optoutMessage: "o", optinMessage: "i", helpKeywords: "HELP", optoutKeywords: "STOP", optinKeywords: "START", privacyPolicyLink: "https://p", termsAndConditionsLink: "https://t" });
  assert.equal(c.campaignId, "C1");
  const b = calls[0].body;
  assert.match(calls[0].url, /\/v2\/10dlc\/campaignBuilder$/);
  assert.equal(b.referenceId, "ref-1");
  assert.equal(b.subscriberOptin && b.subscriberOptout && b.subscriberHelp, true);
  assert.equal(b.embeddedLink, false);
  assert.equal(b.embeddedPhone, false);
  assert.equal(b.privacyPolicyLink, "https://p");
  setTelnyxFetch(null);
});

test("client: reads all three registry error shapes into a plain reason", async () => {
  for (const [status, body, expect] of [
    [422, { errors: [{ code: "10015", title: "Bad Request", detail: "ein is invalid" }] }, /ein is invalid/],
    [422, { detail: [{ loc: ["body", "sample1"], msg: "field required" }] }, /body\.sample1: field required/],
    [400, { code: "10012", title: "Duplicate", detail: "brand exists" }, /10012 Duplicate brand exists/],
  ] as const) {
    fakeFetch(() => ({ status, body }));
    const err = await registry.getBrand(CREDS, "B1").catch((e) => e);
    assert.match(registry.registryReason(err), expect);
    assert.equal(registry.isDefiniteRefusal(err), true);
  }
  fakeFetch(() => ({ status: 404, body: { errors: [{ code: "10005" }] } }));
  assert.equal(await registry.getNumberAssignment(CREDS, "+18455550142"), null);
  setTelnyxFetch(null);
});

test("extractRegistryIds reads both documented webhook shapes and nothing else", () => {
  assert.deepEqual(extractRegistryIds({ data: { event_type: "10dlc.campaign.update", payload: { campaignId: "C1", brandId: "B1" } } }), { brandId: "B1", campaignId: "C1" });
  assert.deepEqual(extractRegistryIds({ brandId: "B2", campaignId: "C2", status: "ACCEPTED" }), { brandId: "B2", campaignId: "C2" });
  assert.deepEqual(extractRegistryIds({ nothing: true }), { brandId: null, campaignId: null });
  assert.deepEqual(extractRegistryIds({ brandId: "x".repeat(200) }), { brandId: null, campaignId: null });
});

test("limiter allows up to max per window, then refuses, then recovers", () => {
  let t = 0;
  const allow = createLimiter(3, 1000, () => t);
  assert.deepEqual([allow("ip"), allow("ip"), allow("ip"), allow("ip")], [true, true, true, false]);
  assert.equal(allow("other"), true);
  t = 1001;
  assert.equal(allow("ip"), true);
});

// ── 5. The engine, end to end ───────────────────────────────────────────────

interface SimOptions {
  verifyAfterReads?: number;
  brandFails?: boolean;
  campaignApproveAfterReads?: number;
  campaignRejects?: boolean;
  brandCreateTimesOutButHappens?: boolean;
  brandCreateRefused?: boolean;
  campaignCreateTimesOutButHappens?: boolean;
  delayMs?: number;
}

function simulatedRegistry(o: SimOptions = {}) {
  const counts = { brandCreate: 0, brandUpdate: 0, campaignCreate: 0, assign: 0, pinSend: 0, pinVerify: 0, revet: 0 };
  const brands = new Map<string, any>();
  const campaigns = new Map<string, any>();
  const assignments = new Map<string, any>();
  let seq = 0;
  const wait = () => (o.delayMs ? new Promise((r) => setTimeout(r, Math.random() * o.delayMs!)) : Promise.resolve());
  const timeout = () => new TelnyxError(0, "timeout", "timeout");
  const sim: typeof registry = {
    ...registry,
    async createBrand(_c, input) {
      await wait();
      counts.brandCreate++;
      if (o.brandCreateRefused) throw new TelnyxError(422, "invalid_request", "refused", { errors: [{ code: "10015", detail: "website is invalid" }] });
      const id = `B${++seq}`;
      brands.set(id, { brandId: id, displayName: input.displayName, reads: 0, sole: input.entityType === "SOLE_PROPRIETOR", pinOk: false, einSeen: input.ein });
      if (o.brandCreateTimesOutButHappens) throw timeout();
      return { brandId: id, tcrBrandId: `T${id}`, identityStatus: "SELF_DECLARED", status: "REGISTRATION_PENDING", failureReasons: [], displayName: input.displayName };
    },
    async updateBrand(_c, id, input) {
      counts.brandUpdate++;
      const b = brands.get(id);
      b.reads = 0;
      b.einSeen = input.ein;
      o.brandFails = false;
      return { brandId: id, tcrBrandId: `T${id}`, identityStatus: "UNVERIFIED", status: "REGISTRATION_PENDING", failureReasons: [], displayName: input.displayName };
    },
    async revetBrand(_c, id) {
      counts.revet++;
      return { brandId: id, tcrBrandId: null, identityStatus: null, status: "REGISTRATION_PENDING", failureReasons: [], displayName: null };
    },
    async getBrand(_c, id) {
      await wait();
      const b = brands.get(id);
      b.reads++;
      if (o.brandFails) return { brandId: id, tcrBrandId: `T${id}`, identityStatus: "UNVERIFIED", status: "OK", failureReasons: ["TAX_ID"], displayName: b.displayName };
      const verified = b.sole ? b.pinOk : b.reads >= (o.verifyAfterReads ?? 1);
      return { brandId: id, tcrBrandId: `T${id}`, identityStatus: verified ? "VERIFIED" : "SELF_DECLARED", status: verified ? "OK" : "REGISTRATION_PENDING", failureReasons: [], displayName: b.displayName };
    },
    async findBrandsByDisplayName(_c, name) {
      return [...brands.values()].filter((b) => b.displayName === name).map((b) => ({ brandId: b.brandId, tcrBrandId: null, identityStatus: "SELF_DECLARED", status: "REGISTRATION_PENDING", failureReasons: [], displayName: b.displayName }));
    },
    async getBrandFeedback() {
      return [{ id: "TAX_ID", displayName: "Tax ID", description: "The legal name does not match the EIN", fields: ["companyName"] }];
    },
    async listUsecases() {
      return ["MARKETING", "LOW_VOLUME_MIXED", "CUSTOMER_CARE"];
    },
    async qualifyUsecase() {
      return { minSubUsecases: 2, maxSubUsecases: 5, monthlyFee: 1.5 };
    },
    async listMnoNames() {
      return { "10017": "AT&T", "10035": "T-Mobile" };
    },
    async createCampaign(_c, input) {
      await wait();
      counts.campaignCreate++;
      const id = `C${++seq}`;
      campaigns.set(id, { campaignId: id, referenceId: input.referenceId, brandId: input.brandId, reads: 0, input });
      if (o.campaignCreateTimesOutButHappens) throw timeout();
      return { campaignId: id, tcrCampaignId: null, campaignStatus: "TCR_PENDING", submissionStatus: "PENDING", status: "ACTIVE", failureReasons: [], referenceId: input.referenceId, nextRenewalOrExpirationDate: null };
    },
    async listCampaignsForBrand(_c, brandId) {
      return [...campaigns.values()].filter((c) => c.brandId === brandId).map((c) => ({ campaignId: c.campaignId, tcrCampaignId: null, campaignStatus: "TCR_PENDING", submissionStatus: null, status: "ACTIVE", failureReasons: [], referenceId: c.referenceId, nextRenewalOrExpirationDate: null }));
    },
    async getCampaign(_c, id) {
      await wait();
      const c = campaigns.get(id);
      c.reads++;
      const done = c.reads >= (o.campaignApproveAfterReads ?? 1);
      const status = o.campaignRejects ? "MNO_REJECTED" : done ? "MNO_PROVISIONED" : "MNO_PENDING";
      return { campaignId: id, tcrCampaignId: `TC${id}`, campaignStatus: status, submissionStatus: "CREATED", status: "ACTIVE", failureReasons: o.campaignRejects ? ["Sample messages do not reference the brand name"] : [], referenceId: c.referenceId, nextRenewalOrExpirationDate: "2026-12-16T00:00:00Z" };
    },
    async getOperationStatus(_c, id) {
      const c = campaigns.get(id);
      return c.reads >= (o.campaignApproveAfterReads ?? 1) ? { "10017": "APPROVED", "10035": "APPROVED" } : { "10017": "APPROVED", "10035": "REVIEW" };
    },
    async updateCampaignWording(_c, id, patch) {
      Object.assign(campaigns.get(id).input, patch);
      return { campaignId: id, tcrCampaignId: null, campaignStatus: "MNO_PENDING", submissionStatus: null, status: "ACTIVE", failureReasons: [], referenceId: null, nextRenewalOrExpirationDate: null };
    },
    async appealCampaign() {
      o.campaignRejects = false;
    },
    async deactivateCampaign(_c, id) {
      campaigns.get(id).deactivated = true;
    },
    async getNumberAssignment(_c, n) {
      const a = assignments.get(n);
      if (!a) return null;
      a.status = "ASSIGNED";
      return { phoneNumber: n, campaignId: a.campaignId, assignmentStatus: a.status, failureReasons: [] };
    },
    async assignNumber(_c, n, campaignId) {
      counts.assign++;
      assignments.set(n, { campaignId, status: "PENDING_ASSIGNMENT" });
      return { phoneNumber: n, campaignId, assignmentStatus: "PENDING_ASSIGNMENT", failureReasons: [] };
    },
    async sendBrandPin(_c, id, pinSms) {
      assert.ok(pinSms.includes("@OTP_PIN@"));
      assert.doesNotMatch(pinSms, CARRIER_NAMES);
      counts.pinSend++;
      brands.get(id).pin = "482913";
      return { referenceId: "R1" };
    },
    async verifyBrandPin(_c, id, pin) {
      counts.pinVerify++;
      const b = brands.get(id);
      if (pin !== b.pin) throw new TelnyxError(400, "invalid_request", "wrong pin", { errors: [{ code: "10020", detail: "invalid pin" }] });
      b.pinOk = true;
    },
  };
  return { sim, counts, brands, campaigns, assignments };
}

function makeWorld(o: SimOptions = {}, extra: Partial<EngineDeps> = {}) {
  resetRegistryCaches();
  let clock = new Date("2026-09-16T14:00:00Z").getTime();
  const now = () => new Date(clock);
  const { db, tables } = createFakeDb({ now });
  const reg = simulatedRegistry(o);
  const charges: string[] = [];
  const emails: any[] = [];
  const deps: EngineDeps = {
    db,
    resolveCreds: async () => CREDS,
    registry: reg.sim,
    now,
    portalOrigin: () => "https://app.example.com",
    publicApiBase: () => "https://app.example.com/api",
    addRegistrationCharge: async (tenantId) => {
      charges.push(tenantId);
      return `CC-202609-${String(charges.length).padStart(5, "0")}`;
    },
    queueEmail: async (m) => {
      emails.push(m);
    },
    ...extra,
  };
  const addTenant = (id: string, name: string, numbers: Array<{ e164: string; provider: string }> = [{ e164: "+18455550142", provider: "TELNYX" }]) => {
    tables.tenant.push({ id, name });
    tables.tenantBillingSettings.push({ tenantId: id, invoiceCompanyName: name, invoiceSupportPhone: "845-555-0142", billingEmail: `office@${id}.com` });
    tables.user.push({ id: `${id}-owner`, tenantId: id, status: "ACTIVE", role: "TENANT_ADMIN", email: `owner@${id}.com`, firstName: "Dana", lastName: "Okafor", createdAt: new Date(0) });
    for (const n of numbers) tables.tenantSmsNumber.push({ id: `${id}-${n.e164}`, tenantId: id, phoneE164: n.e164, provider: n.provider, active: true, createdAt: new Date(0) });
  };
  return { deps, db, tables, reg, charges, emails, addTenant, tick: (ms: number) => { clock += ms; } };
}

function tokenOf(url: string): string {
  return url.split("/texting-registration/")[1];
}

async function toSubmitted(w: ReturnType<typeof makeWorld>, tenantId = "t1", name = "Hudson Valley Tire Co.", answers: any = GOOD_ANSWERS) {
  if (!w.tables.tenant.some((t: any) => t.id === tenantId)) w.addTenant(tenantId, name);
  const reg = await createRegistration(w.deps, tenantId, "staff1");
  const link = await createLink(w.deps, reg.id, "staff1");
  const token = tokenOf(link.url);
  const r = await submitCustomerForm(w.deps, token, { ...answers, signatureName: "Dana Okafor", consent: true }, { ip: "1.2.3.4" });
  assert.deepEqual(r, { ok: true });
  return { reg, token };
}

test("engine: the whole happy path — link, customer form, file, verify, campaign, attach, live — each creating write exactly once", async () => {
  const w = makeWorld();
  w.addTenant("t1", "Hudson Valley Tire Co.");
  const reg = await createRegistration(w.deps, "t1", "staff1");
  assert.equal(reg.displayName, "Hudson Valley Tire Co.");
  assert.equal(reg.businessPhone, "8455550142");
  assert.deepEqual(reg.numbers, ["+18455550142"]);
  assert.equal((await createRegistration(w.deps, "t1", "staff1")).id, reg.id, "one open registration per customer");

  const link = await createLink(w.deps, reg.id, "staff1");
  const token = tokenOf(link.url);
  const opened = await resolvePublicLink(w.deps, token);
  assert.equal(opened.state, "ok");
  const view = publicView(w.deps, (opened as any).reg, { einOnFile: false });
  assert.equal(view.phase, "form");
  assert.doesNotMatch(JSON.stringify(view), CARRIER_NAMES);
  assert.equal((view as any).ein, undefined);

  await saveDraft(w.deps, token, { legalName: "Hudson Valley Tire Company LLC", ein: "12-3456789", state: "ny" });
  const afterDraft = w.tables.textingRegistration[0];
  assert.equal(afterDraft.legalName, "Hudson Valley Tire Company LLC");
  assert.equal(afterDraft.state, "NY");
  assert.equal(w.tables.textingRegistrationEin.length, 0, "a draft never stores the EIN");

  const bad = await submitCustomerForm(w.deps, token, { ...GOOD_ANSWERS, ein: "12", consent: false }, { ip: null });
  assert.equal(bad.ok, false);
  assert.ok((bad as any).errors.ein && (bad as any).errors.consent && (bad as any).errors.signatureName);

  const ok = await submitCustomerForm(w.deps, token, { ...GOOD_ANSWERS, signatureName: "Dana Okafor", consent: true }, { ip: "1.2.3.4" });
  assert.deepEqual(ok, { ok: true });
  assert.equal(w.tables.textingRegistration[0].status, "submitted");
  assert.equal(w.tables.textingRegistrationEin.length, 1);
  assert.ok(!JSON.stringify(w.tables.textingRegistration[0]).includes("3456789"), "no EIN digits on the registration row");
  assert.equal((await resolvePublicLink(w.deps, token)).state, "used");
  await assert.rejects(() => submitCustomerForm(w.deps, token, { ...GOOD_ANSWERS, signatureName: "X Y", consent: true }, { ip: null }));

  assert.equal(await revealEin(w.deps, reg.id, "staff1"), "12-3456789");

  const filed = await fileWithTelnyx(w.deps, reg.id, "staff1");
  assert.equal(w.reg.counts.brandCreate, 1);
  assert.equal(w.reg.brands.get("B1").einSeen, "123456789", "the brand call received the real EIN");
  assert.equal(w.charges.length, 1, "registration charge added once");
  // verifyAfterReads=1 → verified in the same run → campaign filed → approved → numbers attached
  assert.equal(w.reg.counts.campaignCreate, 1);
  assert.equal(w.tables.textingRegistrationEin.length, 0, "EIN token destroyed once verified");
  const campaign = [...w.reg.campaigns.values()][0];
  assert.equal(campaign.input.usecase, "LOW_VOLUME_MIXED", "usecase spelling taken from the live enum");
  assert.equal(campaign.input.privacyPolicyLink, "https://app.example.com/texting-policy/hudson-valley-tire-co");
  assert.equal(campaign.input.referenceId, w.tables.textingRegistration[0].referenceKey);
  assert.equal(filed.status, "campaign_review");

  await advanceRegistration(w.deps, reg.id);
  assert.equal(w.tables.textingRegistration[0].status, "assigning");
  assert.equal(w.reg.counts.assign, 1);
  await advanceRegistration(w.deps, reg.id);
  const final = w.tables.textingRegistration[0];
  assert.equal(final.status, "live");
  assert.equal(w.reg.counts.assign, 1);
  assert.equal(w.emails.filter((e) => e.type === READY_EMAIL_TYPE).length, 1);
  w.tick(3600_000);
  await advanceRegistration(w.deps, reg.id);
  await sweepRegistrations(w.deps);
  assert.equal(w.emails.filter((e) => e.type === READY_EMAIL_TYPE).length, 1, "ready email never repeats");
  assert.equal(w.reg.counts.assign, 1);
  assert.equal(w.reg.counts.brandCreate, 1);
  assert.equal(w.reg.counts.campaignCreate, 1);
  assert.equal(w.charges.length, 1);
  const kinds = w.tables.textingRegistrationEvent.map((e: any) => e.kind);
  for (const k of ["created", "link_created", "link_opened", "customer_submitted", "ein_revealed", "filing", "brand_created", "charge_added", "brand_verified", "ein_destroyed", "campaign_created", "campaign_approved", "number_assigned", "live"]) {
    assert.ok(kinds.includes(k), `history has ${k}`);
  }
});

test("engine: ten simultaneous presses of File produce ONE brand, ONE campaign, ONE charge", async () => {
  const w = makeWorld({ verifyAfterReads: 1, delayMs: 5 });
  const { reg } = await toSubmitted(w);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => fileWithTelnyx(w.deps, reg.id, "staff1")));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results) if (r.status === "rejected") assert.ok(["not_ready", "already_filing"].includes((r.reason as RegistrationError).code), String((r.reason as any)?.code));
  await Promise.all(Array.from({ length: 5 }, () => advanceRegistration(w.deps, reg.id)));
  assert.equal(w.reg.counts.brandCreate, 1);
  assert.equal(w.reg.counts.campaignCreate, 1);
  assert.equal(w.charges.length, 1);
});

test("engine: two tabs pressing Send at once make one submission", async () => {
  const w = makeWorld();
  w.addTenant("t1", "Hudson Valley Tire Co.");
  const reg = await createRegistration(w.deps, "t1", "s");
  const token = tokenOf((await createLink(w.deps, reg.id, "s")).url);
  const body = { ...GOOD_ANSWERS, signatureName: "Dana Okafor", consent: true };
  const results = await Promise.allSettled([submitCustomerForm(w.deps, token, body, { ip: null }), submitCustomerForm(w.deps, token, body, { ip: null })]);
  assert.equal(results.filter((r) => r.status === "fulfilled" && (r.value as any).ok).length, 1);
  assert.equal(w.tables.textingRegistrationEvent.filter((e: any) => e.kind === "customer_submitted").length, 1);
});

test("engine: a new link turns the old one off; expired and garbage tokens are refused", async () => {
  const w = makeWorld();
  w.addTenant("t1", "Hudson Valley Tire Co.");
  const reg = await createRegistration(w.deps, "t1", "s");
  const first = tokenOf((await createLink(w.deps, reg.id, "s")).url);
  const second = tokenOf((await createLink(w.deps, reg.id, "s")).url);
  assert.equal((await resolvePublicLink(w.deps, first)).state, "revoked");
  assert.equal((await resolvePublicLink(w.deps, second)).state, "ok");
  assert.equal((await resolvePublicLink(w.deps, "not-a-token")).state, "not_found");
  assert.equal((await resolvePublicLink(w.deps, "A".repeat(43))).state, "not_found");
  w.tick(31 * 86_400_000);
  assert.equal((await resolvePublicLink(w.deps, second)).state, "expired");
});

test("engine: brand create times out but happened → never resent; reconciled by name; charged once", async () => {
  const w = makeWorld({ brandCreateTimesOutButHappens: true, verifyAfterReads: 99 });
  const { reg } = await toSubmitted(w);
  const after = await fileWithTelnyx(w.deps, reg.id, "s");
  assert.equal(after.status, "filing");
  assert.match(after.lastError, /did not confirm/);
  assert.equal(w.charges.length, 0, "no charge until the brand is known to exist");
  await sweepRegistrations(w.deps);
  await sweepRegistrations(w.deps);
  assert.equal(w.reg.counts.brandCreate, 1, "never resent");
  const row = w.tables.textingRegistration[0];
  assert.equal(row.telnyxBrandId, "B1");
  assert.equal(row.status, "brand_review");
  assert.equal(w.charges.length, 1);
});

test("engine: an unconfirmed brand create that never appears goes to a person — it does not refile", async () => {
  const w = makeWorld({ verifyAfterReads: 99 });
  const { reg } = await toSubmitted(w);
  w.reg.sim.createBrand = async () => {
    w.reg.counts.brandCreate++;
    throw new TelnyxError(0, "network", "down");
  };
  await fileWithTelnyx(w.deps, reg.id, "s");
  await sweepRegistrations(w.deps);
  assert.equal(w.tables.textingRegistration[0].status, "filing");
  w.tick(RECONCILE_GIVE_UP_MS + 1000);
  await sweepRegistrations(w.deps);
  assert.equal(w.tables.textingRegistration[0].status, "error");
  assert.match(w.tables.textingRegistration[0].lastError, /Check the Telnyx portal/);
  assert.equal(w.reg.counts.brandCreate, 1);
});

test("engine: a definite refusal returns the registration to Ready to file with the reason, nothing charged", async () => {
  const w = makeWorld({ brandCreateRefused: true });
  const { reg } = await toSubmitted(w);
  await assert.rejects(() => fileWithTelnyx(w.deps, reg.id, "s"), /website is invalid/);
  const row = w.tables.textingRegistration[0];
  assert.equal(row.status, "submitted");
  assert.equal(row.brandCreateStartedAt, null);
  assert.equal(w.charges.length, 0);
  assert.equal(w.tables.textingRegistrationEin.length, 1, "EIN kept so the staff can fix and refile");
});

test("engine: campaign create times out → reconciled by referenceId, never a second campaign", async () => {
  const w = makeWorld({ campaignCreateTimesOutButHappens: true, campaignApproveAfterReads: 99 });
  const { reg } = await toSubmitted(w);
  await fileWithTelnyx(w.deps, reg.id, "s");
  assert.equal(w.reg.counts.campaignCreate, 1);
  assert.equal(w.tables.textingRegistration[0].telnyxCampaignId ?? null, null);
  w.reg.sim.createCampaign = async () => {
    throw new Error("must never be called again");
  };
  await sweepRegistrations(w.deps);
  assert.equal(w.tables.textingRegistration[0].status, "campaign_review");
  assert.ok(w.tables.textingRegistration[0].telnyxCampaignId);
});

test("engine: brand not verified → feedback → sent back for ONLY the refused fields → customer fixes → brand UPDATED, not recreated", async () => {
  const w = makeWorld({ brandFails: true });
  const { reg } = await toSubmitted(w);
  await fileWithTelnyx(w.deps, reg.id, "s");
  let row = w.tables.textingRegistration[0];
  assert.equal(row.status, "brand_failed");
  assert.equal(row.brandFeedback.categories[0].id, "TAX_ID");
  assert.equal(w.tables.textingRegistrationEin.length, 1, "EIN kept while the business is not verified");

  await assert.rejects(() => sendBackToCustomer(w.deps, reg.id, [], "fix it", "s"), /at least one field/);
  await sendBackToCustomer(w.deps, reg.id, ["legalName"], "The IRS has your business under a slightly different name.", "s");
  row = w.tables.textingRegistration[0];
  assert.equal(row.status, "needs_fix");
  assert.deepEqual(row.fixFields, ["legalName", "ein"], "changing the legal name on an existing brand needs the EIN again");

  const token = tokenOf((await createLink(w.deps, reg.id, "s")).url);
  const view = publicView(w.deps, (await resolvePublicLink(w.deps, token) as any).reg, { einOnFile: true });
  assert.deepEqual(view.fixFields, ["legalName", "ein"]);
  assert.match(String(view.fixNote), /slightly different name/);
  // The customer tries to change a locked field too — it is ignored.
  const res = await submitCustomerForm(w.deps, token, { legalName: "Hudson Valley Tire Co LLC", ein: "12-3456789", city: "Hacked City", signatureName: "Dana Okafor", consent: true }, { ip: null });
  assert.deepEqual(res, { ok: true });
  row = w.tables.textingRegistration[0];
  assert.equal(row.legalName, "Hudson Valley Tire Co LLC");
  assert.equal(row.city, "Newburgh", "a locked field cannot be changed from the link");
  assert.equal(row.status, "submitted");

  await fileWithTelnyx(w.deps, reg.id, "s");
  assert.equal(w.reg.counts.brandCreate, 1, "never a second brand");
  assert.equal(w.reg.counts.brandUpdate, 1);
  assert.equal(w.reg.counts.revet, 1);
  assert.equal(w.charges.length, 1, "no second charge for a fix");
});

test("engine: campaign rejected → staff edit samples (sent to Telnyx) → appeal → approved → live", async () => {
  const w = makeWorld({ campaignRejects: true });
  const { reg } = await toSubmitted(w);
  await fileWithTelnyx(w.deps, reg.id, "s");
  await advanceRegistration(w.deps, reg.id);
  assert.equal(w.tables.textingRegistration[0].status, "campaign_rejected");
  await assert.rejects(() => updateContent(w.deps, reg.id, { description: "new description that is long enough for the registry" }, "s"), /can't be changed after the campaign is filed/);
  await updateContent(w.deps, reg.id, { sample1: "Hudson Valley Tire Co.: your order is ready for pickup. Reply STOP to opt out." }, "s");
  const c = [...w.reg.campaigns.values()][0];
  assert.match(c.input.sample1, /ready for pickup/);
  await assert.rejects(() => appeal(w.deps, reg.id, "short", "s"));
  await appealAndAdvance(w, reg.id);
  assert.equal(w.tables.textingRegistration[0].status, "live");
});

async function appealAndAdvance(w: ReturnType<typeof makeWorld>, id: string) {
  const { appeal: doAppeal } = await import("./engine");
  await doAppeal(w.deps, id, "Both samples now open with the business name.", "s");
  await advanceRegistration(w.deps, id);
  await advanceRegistration(w.deps, id);
}
const appeal = (deps: EngineDeps, id: string, reason: string, actor: string) => import("./engine").then((m) => m.appeal(deps, id, reason, actor));

test("engine: sole proprietor — no EIN, PIN texted, wrong PINs capped, right PIN verifies and the campaign files", async () => {
  const w = makeWorld();
  w.addTenant("t1", "Rivera Landscaping");
  const reg = await createRegistration(w.deps, "t1", "s");
  const token = tokenOf((await createLink(w.deps, reg.id, "s")).url);
  const noMobile = await submitCustomerForm(w.deps, token, { ...GOOD_ANSWERS, legalName: "Maria Rivera", entityType: "SOLE_PROPRIETOR", ein: "", signatureName: "Maria Rivera", consent: true }, { ip: null });
  assert.equal(noMobile.ok, false);
  assert.ok((noMobile as any).errors.mobilePhone);
  const ok = await submitCustomerForm(w.deps, token, { ...GOOD_ANSWERS, legalName: "Maria Rivera", entityType: "SOLE_PROPRIETOR", ein: "", mobilePhone: "(914) 555-0187", signatureName: "Maria Rivera", consent: true }, { ip: null });
  assert.deepEqual(ok, { ok: true });
  assert.equal(w.tables.textingRegistrationEin.length, 0);
  await fileWithTelnyx(w.deps, reg.id, "s");
  assert.equal(w.tables.textingRegistration[0].status, "awaiting_pin");
  assert.equal(w.reg.counts.pinSend, 1);
  assert.equal(w.reg.counts.campaignCreate, 0, "no campaign before the PIN");
  w.tick(1000);
  // The customer's used link still works for the PIN step.
  assert.equal((await resolvePublicLink(w.deps, token)).state, "ok");
  for (let i = 0; i < 5; i++) assert.equal((await verifyOwnerPin(w.deps, token, "111111")).ok, false);
  assert.match((await verifyOwnerPin(w.deps, token, "482913")).message, /Too many wrong codes/, "capped before the right code is even tried");
  // New code resets the cap.
  w.tick(61_000);
  const { resendOwnerPin } = await import("./engine");
  await resendOwnerPin(w.deps, token);
  const right = await verifyOwnerPin(w.deps, token, "482913");
  assert.equal(right.ok, true);
  assert.equal(w.reg.counts.campaignCreate, 1);
});

test("engine: a tenant already registered by the sign-up wizard is refused (one brand per EIN)", async () => {
  const w = makeWorld();
  w.addTenant("t1", "Hudson Valley Tire Co.");
  w.tables.tenantSmsRegistration.push({ id: "wiz", tenantId: "t1", provider: "telnyx", brandId: "BW" });
  await assert.rejects(() => createRegistration(w.deps, "t1", "s"), /already registered/);
});

test("engine: numbers not on Telnyx never get attached; the registration waits and says so", async () => {
  const w = makeWorld();
  w.addTenant("t1", "Hudson Valley Tire Co.", [{ e164: "+18455550177", provider: "VOIPMS" }]);
  const { reg } = await toSubmitted(w, "t1");
  await fileWithTelnyx(w.deps, reg.id, "s");
  await advanceRegistration(w.deps, reg.id);
  await advanceRegistration(w.deps, reg.id);
  const row = w.tables.textingRegistration[0];
  assert.equal(row.status, "assigning");
  assert.equal(w.reg.counts.assign, 0);
  // The number moves to Telnyx later → the next check attaches it and goes live.
  w.tables.tenantSmsNumber[0].provider = "TELNYX";
  await advanceRegistration(w.deps, reg.id);
  await advanceRegistration(w.deps, reg.id);
  assert.equal(w.tables.textingRegistration[0].status, "live");
});

test("engine: unfiled EIN tokens are destroyed after 14 days; filing then refuses without an EIN", async () => {
  const w = makeWorld();
  const { reg } = await toSubmitted(w);
  w.tick(15 * 86_400_000);
  const r = await sweepRegistrations(w.deps);
  assert.equal(r.einExpired, 1);
  assert.equal(w.tables.textingRegistrationEin.length, 0);
  await assert.rejects(() => fileWithTelnyx(w.deps, reg.id, "s"), /EIN/);
});

test("engine: deactivate requires the exact business name, destroys the EIN and turns links off", async () => {
  const w = makeWorld({ verifyAfterReads: 99 });
  const { reg } = await toSubmitted(w);
  await assert.rejects(() => deactivate(w.deps, reg.id, "Hudson", "s"), /exactly/);
  await deactivate(w.deps, reg.id, "hudson valley tire co.", "s");
  assert.equal(w.tables.textingRegistration[0].status, "deactivated");
  assert.equal(w.tables.textingRegistrationEin.length, 0);
});

test("STRESS: 300 customers through the whole flow with random registry latency — every one live, zero duplicate creates, zero EINs left", async () => {
  const w = makeWorld({ verifyAfterReads: 2, campaignApproveAfterReads: 3, delayMs: 3 });
  const N = 300;
  const ids: string[] = [];
  for (let i = 0; i < N; i++) {
    const t = `t${i}`;
    w.addTenant(t, `Customer Number ${i} LLC`, [{ e164: `+1845${String(1000000 + i).slice(-7)}`, provider: "TELNYX" }]);
    const { reg } = await toSubmitted(w, t, `Customer Number ${i} LLC`, { ...GOOD_ANSWERS, legalName: `Customer Number ${i} LLC` });
    ids.push(reg.id);
  }
  // Every registration filed, with duplicate presses and racing sweeps mixed in.
  await Promise.allSettled(ids.flatMap((id) => [fileWithTelnyx(w.deps, id, "s"), fileWithTelnyx(w.deps, id, "s")]));
  for (let round = 0; round < 8; round++) {
    await Promise.all([sweepRegistrations(w.deps, { batch: N }), sweepRegistrations(w.deps, { batch: N }), ...ids.slice(0, 50).map((id) => advanceRegistration(w.deps, id))]);
    w.tick(3600_000);
  }
  const rows = w.tables.textingRegistration;
  const notLive = rows.filter((r: any) => r.status !== "live");
  assert.equal(notLive.length, 0, `not live: ${JSON.stringify(notLive.slice(0, 3).map((r: any) => [r.status, r.lastError]))}`);
  assert.equal(w.reg.counts.brandCreate, N);
  assert.equal(w.reg.counts.campaignCreate, N);
  assert.equal(w.reg.counts.assign, N);
  assert.equal(w.charges.length, N);
  assert.equal(w.tables.textingRegistrationEin.length, 0);
  assert.equal(w.emails.filter((e) => e.type === READY_EMAIL_TYPE).length, N);
  const refs = new Set(rows.map((r: any) => r.referenceKey));
  assert.equal(refs.size, N);
});

// ── 6. Source guards ────────────────────────────────────────────────────────

const ROOT = process.env.API_GUARD_ROOT || path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

test("guard: the registration charge is a separate uncharged invoice with default dates and no 'monthly service' text", () => {
  const wire = read("apps/api/src/textingRegistration/wire.ts");
  const call = wire.slice(wire.indexOf("createOneTimeChargeInvoice({"), wire.indexOf("});", wire.indexOf("createOneTimeChargeInvoice({")));
  assert.doesNotMatch(call, /periodStart|periodEnd|serviceStart|serviceEnd|chargeMode|card_on_file/);
  const engine = read("apps/api/src/textingRegistration/engine.ts");
  const desc = /REGISTRATION_CHARGE_DESCRIPTION = "([^"]+)"/.exec(engine)?.[1] || "";
  assert.ok(desc);
  assert.doesNotMatch(desc, /monthly\s+service|service\s+balance/i);
  assert.match(engine, /REGISTRATION_CHARGE_CENTS = 2400/);
});

test("guard: wired into server.ts with a permission prefix; public paths anchored in the JWT bypass", () => {
  const server = read("apps/api/src/server.ts");
  assert.match(server, /wireTextingRegistration\(\{ app, db, requireSuperAdmin, userHasActionPermission \}\)/);
  assert.match(server, /\{ prefix: "\/admin\/texting-registration", permission: "can_view_admin_texting_registration" \}/);
  const bypass = read("apps/api/src/jwtPublicRouteBypass.ts");
  assert.match(bypass, /pathWithoutApiPrefix\.startsWith\("\/texting-registration\/"\)/);
  assert.match(bypass, /"\/webhooks\/telnyx\/10dlc"/);
  assert.match(read("apps/api/package.json"), /src\/textingRegistration\/\*\.test\.ts/);
});

test("guard: every admin route goes through the staff+key gate; the webhook fails closed", () => {
  const routes = read("apps/api/src/textingRegistration/routes.ts");
  const adminRoutes = [...routes.matchAll(/app\.(get|post|patch)\("\/admin\/texting-registration[^"]*", async \(req: any, reply: any\) => \{\n\s+const user = await gate\(req, reply, KEYS\.\w+\);/g)];
  const allAdmin = [...routes.matchAll(/app\.(get|post|patch)\("\/admin\/texting-registration/g)];
  assert.ok(allAdmin.length >= 14);
  assert.equal(adminRoutes.length, allAdmin.length, "an admin route skipped the gate");
  assert.match(routes, /if \(!publicKey \|\| !deps\.verifySignature\) return reply\.code\(401\)/);
  assert.match(routes, /const user = await deps\.requireStaff\(req, reply\);/);
});

test("guard: the EIN token never leaves the vault in a response", () => {
  const routes = read("apps/api/src/textingRegistration/routes.ts");
  assert.doesNotMatch(routes, /token:\s*true/);
  assert.match(routes, /ein: \{ select: \{ last4: true, createdAt: true \} \}/);
  const engine = read("apps/api/src/textingRegistration/engine.ts");
  assert.doesNotMatch(engine, /log\??\.\w+\(\{[^}]*ein[^}]*\}/i);
});

test("guard: permissions — page key in the sidebar catalog, six action keys, SUPER_ADMIN force line, Locked in the role editor", () => {
  const shared = read("packages/shared/src/portalPermissions.ts");
  assert.match(shared, /id: "admin\.texting_registration", section: "admin", label: "10DLC Registration", href: "\/admin\/texting-registration", permission: "can_view_admin_texting_registration"/);
  for (const k of ["can_send_texting_registration_link", "can_view_texting_registration_ein", "can_file_texting_registration", "can_fix_texting_registration", "can_deactivate_texting_registration"]) {
    assert.ok(shared.includes(`"${k}",`), k);
  }
  const nav = read("apps/portal/navigation/navConfig.ts");
  assert.match(nav, /id: "admin\.texting_registration", href: "\/admin\/texting-registration"/);
  assert.match(nav, /if \(item\.id === "admin\.texting_registration" && backendJwtRole !== "SUPER_ADMIN"\) return false;/);
  const locked = nav.slice(nav.indexOf("OWNER_ONLY_FIXED_NAV_ITEMS"), nav.indexOf("]", nav.indexOf("OWNER_ONLY_FIXED_NAV_ITEMS")));
  assert.ok(locked.includes('"admin.texting_registration"'));
});

test("guard: the customer's pages never name a carrier or a price", () => {
  for (const rel of [
    "apps/portal/app/texting-registration/[token]/page.tsx",
    "apps/portal/app/texting-policy/[slug]/page.tsx",
    "apps/api/src/textingRegistration/emails.ts",
  ]) {
    const src = read(rel);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, CARRIER_NAMES, rel);
    assert.doesNotMatch(code, /\$\d/, rel);
  }
});
