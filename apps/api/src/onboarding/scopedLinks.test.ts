import { mock } from "node:test";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";

/**
 * Scoped onboarding links — "just submit a port" / "just add extensions"
 * (Izzy, 2026-08-30).
 *
 * The property that matters most is the NEGATIVE: a scoped link must never
 * reach checkout, the full submit, or apply-number — those create tenants,
 * invoices and carrier purchases, and a scoped link is for an EXISTING
 * customer. The stubs below THROW if those modules are ever invoked, so the
 * refusal tests double as proof the gate fires before any side effect.
 */

function never(name: string) {
  return () => {
    throw new Error(`side-effect module reached on a scoped link: ${name}`);
  };
}

// ── Fake db ──────────────────────────────────────────────────────────────────
type Row = { id: string; publicToken: string; status: string; currentStep?: string | null; answers: any; submittedAt?: Date | null };
const rows: Row[] = [];
const events: any[] = [];
const requestedExtensions: any[] = [];

const dbMock: any = {
  onboardingSubmission: {
    findFirst: async ({ where }: any) => rows.find((r) => r.publicToken === where.publicToken) || null,
    update: async ({ where, data }: any) => {
      const r = rows.find((x) => x.id === where.id);
      if (!r) throw new Error("row not found");
      Object.assign(r, data);
      return { ...r };
    },
    create: async ({ data }: any) => {
      const r = { id: `sub_${rows.length + 1}`, ...data };
      rows.push(r);
      return { ...r };
    },
  },
  onboardingEvent: { create: async ({ data }: any) => { events.push(data); return data; } },
  onboardingRequestedExtension: {
    deleteMany: async ({ where }: any) => {
      for (let i = requestedExtensions.length - 1; i >= 0; i--) {
        if (requestedExtensions[i].submissionId === where.submissionId) requestedExtensions.splice(i, 1);
      }
      return { count: 0 };
    },
    createMany: async ({ data }: any) => { requestedExtensions.push(...data); return { count: data.length }; },
  },
  globalVoipMsConfig: { findUnique: async () => null },
  $transaction: async (fn: any) => fn(dbMock),
};

mock.module("@connect/db", { namedExports: { db: dbMock } });
mock.module("@connect/security", { namedExports: { decryptJson: () => null } });
mock.module("@connect/integrations", {
  namedExports: { VoipMsNumberProvider: class {}, },
});
// ⛔ These are the modules a scoped link must structurally never reach.
mock.module("./onboardingPayment", {
  namedExports: { prepareOnboardingCheckout: never("prepareOnboardingCheckout"), quoteForSubmission: never("quoteForSubmission") },
});
mock.module("./voipMsProvisioning", {
  namedExports: { applyOnboardingNumber: never("applyOnboardingNumber"), syncOnboardingSms: never("syncOnboardingSms"), listSpareDids: never("listSpareDids") },
});
mock.module("./setupOrchestrator", {
  namedExports: { runOnboardingSetup: never("runOnboardingSetup"), resumeSetupIfSubmitted: async () => {} },
});
mock.module("../signalwire/signalWireTenDlc", {
  namedExports: { fileBrandForRegistration: never("fileBrandForRegistration"), LEGAL_ENTITY_TYPES: ["llc"] },
});
mock.module("./journeyTracking", {
  namedExports: { recordLinkOpened: async () => {}, recordJourneyBeacon: async () => {} },
});

// CJS transform: no top-level await — load the routes lazily, once.
let routesMod: any = null;
async function makeApp() {
  if (!routesMod) routesMod = await import("./publicRoutes");
  const app = Fastify();
  await routesMod.registerOnboardingPublicRoutes(app as any);
  await app.ready();
  return app;
}

function seed(token: string, answers: any, status = "IN_PROGRESS"): Row {
  const r: Row = { id: `sub_${rows.length + 1}`, publicToken: token, status, answers };
  rows.push(r);
  return r;
}

const PORT_BODY = {
  numbers: "(845) 555-0123",
  carrier: "Verizon",
  accountNumber: "A-778812",
  nameOnAccount: "Acme Corp",
  serviceAddress: "12 Main St",
  serviceCity: "Monsey",
  serviceState: "NY",
  serviceZip: "10952",
  isMobile: false,
  portPin: "",
  loaSignature: "Jane Smith",
};

test("a PORT-scoped link is refused at checkout, full submit AND apply-number — wrong_link_kind, no side effects", async () => {
  const app = await makeApp();
  seed("tok-port-1", { linkKind: "port" });
  // Schema-VALID bodies on purpose — the refusal must be the link-kind gate,
  // never a validation 400 that a well-formed request would sail past.
  const bodies: Record<string, any> = {
    checkout: {},
    submit: { companyName: "Acme", contactFirstName: "Jane", contactLastName: "Smith", mainEmail: "jane@acme.com" },
    "apply-number": { choice: "new", selectedNumber: "8455550000" },
  };
  for (const leaf of ["checkout", "submit", "apply-number"]) {
    const res = await app.inject({ method: "POST", url: `/onboarding/tok-port-1/${leaf}`, payload: bodies[leaf] });
    assert.equal(res.statusCode, 409, `${leaf} must refuse (got ${res.statusCode}: ${res.body})`);
    assert.equal(res.json().error, "wrong_link_kind", `${leaf} must name the refusal`);
  }
  await app.close();
});

test("an EXTENSION-scoped link cannot submit a port, and a FULL link cannot use the scoped submits", async () => {
  const app = await makeApp();
  seed("tok-ext-1", { linkKind: "extension" });
  seed("tok-full-1", {});
  const r1 = await app.inject({ method: "POST", url: "/onboarding/tok-ext-1/submit-port", payload: PORT_BODY });
  assert.equal(r1.statusCode, 409);
  assert.equal(r1.json().error, "wrong_link_kind");
  for (const path of ["/onboarding/tok-full-1/submit-port", "/onboarding/tok-full-1/submit-extensions"]) {
    const res = await app.inject({ method: "POST", url: path, payload: path.endsWith("submit-port") ? PORT_BODY : { extensions: [{ displayName: "A", extNumber: "101" }] } });
    assert.equal(res.statusCode, 409, `${path} must refuse on a full link`);
    assert.equal(res.json().error, "wrong_link_kind");
  }
  await app.close();
});

test("submit-port writes the SAME portFiling block the full wizard writes — so it lands in the admin Port queue", async () => {
  const app = await makeApp();
  const row = seed("tok-port-2", { linkKind: "port" });
  const res = await app.inject({ method: "POST", url: "/onboarding/tok-port-2/submit-port", payload: PORT_BODY });
  assert.equal(res.statusCode, 200, res.body);
  const pf = row.answers?.provisioning?.portFiling;
  assert.ok(pf, "portFiling block must exist");
  assert.equal(pf.status, "awaiting_manual_filing");
  assert.equal(pf.portedDid, "8455550123");
  assert.equal(pf.scopedLink, true);
  assert.equal(row.answers.phone?.choice, "port");
  assert.equal(row.answers.phone?.details?.carrier, "Verizon");
  // linkKind survives — the answers spread must never drop it.
  assert.equal(row.answers.linkKind, "port");
  assert.equal(row.status, "SUBMITTED");
  assert.ok(row.submittedAt instanceof Date);
  // A second submit is refused by the write-block, not silently doubled.
  const again = await app.inject({ method: "POST", url: "/onboarding/tok-port-2/submit-port", payload: PORT_BODY });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, "write_blocked");
  await app.close();
});

test("submit-port: a cell number without a transfer PIN is refused in plain English", async () => {
  const app = await makeApp();
  seed("tok-port-3", { linkKind: "port" });
  const res = await app.inject({
    method: "POST",
    url: "/onboarding/tok-port-3/submit-port",
    payload: { ...PORT_BODY, isMobile: true, portPin: "" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /transfer PIN/);
  await app.close();
});

test("submit-extensions writes OnboardingRequestedExtension rows and goes SUBMITTED", async () => {
  const app = await makeApp();
  const row = seed("tok-ext-2", { linkKind: "extension" });
  const res = await app.inject({
    method: "POST",
    url: "/onboarding/tok-ext-2/submit-extensions",
    payload: {
      extensions: [
        { displayName: "Jane Smith", extNumber: "101", email: "jane@acme.com", cellMode: "also", cellNumber: "(845) 555-0100" },
        { displayName: "Front Desk", extNumber: "102", email: "" },
      ],
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const mine = requestedExtensions.filter((e) => e.submissionId === row.id);
  assert.equal(mine.length, 2);
  assert.equal(mine[0].extNumber, "101");
  assert.equal(mine[0].email, "jane@acme.com");
  assert.equal(mine[1].email, null, "a blank email stores as null, never an empty string");
  assert.equal(row.status, "SUBMITTED");
  assert.equal(row.answers.linkKind, "extension", "linkKind survives the submit");
  await app.close();
});

test("submit-extensions refuses duplicates, bad emails and half cell numbers", async () => {
  const app = await makeApp();
  seed("tok-ext-3", { linkKind: "extension" });
  const bad = [
    { body: { extensions: [{ displayName: "A", extNumber: "101" }, { displayName: "B", extNumber: "101" }] }, re: /unique/ },
    { body: { extensions: [{ displayName: "A", extNumber: "101", email: "not-an-email" }] }, re: /email/ },
    { body: { extensions: [{ displayName: "A", extNumber: "101", cellMode: "also", cellNumber: "555" }] }, re: /cell phone number/ },
  ];
  for (const { body, re } of bad) {
    const res = await app.inject({ method: "POST", url: "/onboarding/tok-ext-3/submit-extensions", payload: body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.match(res.json().message, re);
  }
  assert.equal(requestedExtensions.filter((e) => e.submissionId === "sub_never").length, 0);
  await app.close();
});

test("the autosave carries linkKind through — a scoped link cannot be turned back into a full one by saving", async () => {
  const app = await makeApp();
  const row = seed("tok-port-4", { linkKind: "port", phone: { details: { carrier: "Old" } } });
  const res = await app.inject({
    method: "PUT",
    url: "/onboarding/tok-port-4/save",
    payload: { currentStep: "2", answers: { phone: { details: { carrier: "Verizon" } } } },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(row.answers.linkKind, "port", "the wholesale answers replace must re-stamp linkKind");
  assert.equal(row.answers.phone.details.carrier, "Verizon");
  await app.close();
});

test("validate reports `submitted` so a returning scoped visitor lands on the thank-you screen", async () => {
  const app = await makeApp();
  seed("tok-port-5", { linkKind: "port" }, "SUBMITTED");
  const res = await app.inject({ method: "GET", url: "/onboarding/tok-port-5/validate" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().submission.submitted, true);
  await app.close();
});

// ── Source guards ────────────────────────────────────────────────────────────
// The behavioral tests above prove the routes; these pin the WIRING that a
// refactor can silently drop (comments stripped — they quote the old shapes).
const src = readFileSync(resolve(__dirname, "publicRoutes.ts"), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
  .join("\n");

test("source guard: all three money-path routes call refuseWrongLinkKind", () => {
  const count = (src.match(/refuseWrongLinkKind\(reply, row, "full"\)/g) || []).length;
  assert.ok(count >= 3, `expected checkout + submit + apply-number gated, found ${count}`);
});

test("source guard: the scoped submits gate on their OWN kind", () => {
  assert.ok(src.includes('refuseWrongLinkKind(reply, row, "port")'));
  assert.ok(src.includes('refuseWrongLinkKind(reply, row, "extension")'));
});
