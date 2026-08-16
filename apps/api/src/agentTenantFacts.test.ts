import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * The promise being tested: a company that exists gets a knowledge document
 * WITHOUT anyone doing anything — including a brand-new one, and including one
 * whose details changed since yesterday.
 */
const state: any = { tenants: [], docs: [], deleted: [] };

const table = (rows: () => any[]) => ({
  findMany: async ({ where }: any = {}) =>
    rows().filter((r: any) => {
      if (where?.tenantId && r.tenantId !== where.tenantId) return false;
      if (where?.connectTenantId && r.tenantId !== where.connectTenantId) return false;
      if (where?.active !== undefined && r.active !== undefined && r.active !== where.active) return false;
      return true;
    }),
  findFirst: async ({ where }: any = {}) => rows().find((r: any) => !where?.tenantId || r.tenantId === where.tenantId) ?? null,
});

mock.module("@connect/db", {
  namedExports: {
    db: {
      tenant: {
        findMany: async ({ where }: any) => state.tenants.filter((t: any) => (where?.pbxRemovedAt === null ? !t.pbxRemovedAt : true)),
        findUnique: async ({ where }: any) => state.tenants.find((t: any) => t.id === where.id) ?? null,
      },
      pbxTenantInboundDid: table(() => state.dids ?? []),
      extension: table(() => state.extensions ?? []),
      tenantSmsNumber: table(() => state.sms ?? []),
      user: table(() => state.users ?? []),
      ivrRouteProfile: table(() => state.profiles ?? []),
      tenantPbxLink: table(() => state.links ?? []),
      tenantBillingSettings: table(() => state.billing ?? []),
      agentAction: table(() => state.actions ?? []),
      agentEscalation: table(() => state.escalations ?? []),
      agentKnowledgeDoc: {
        findUnique: async ({ where }: any) => state.docs.find((d: any) => d.slug === where.slug) ?? null,
        findMany: async ({ where }: any) =>
          state.docs.filter((d: any) => (!where?.source || d.source === where.source) && (!where?.slug?.startsWith || d.slug.startsWith(where.slug.startsWith))),
        upsert: async ({ where, create, update }: any) => {
          const i = state.docs.findIndex((d: any) => d.slug === where.slug);
          if (i >= 0) state.docs[i] = { ...state.docs[i], ...update };
          else state.docs.push({ id: `d${state.docs.length + 1}`, ...create });
        },
        delete: async ({ where }: any) => {
          const i = state.docs.findIndex((d: any) => d.id === where.id);
          if (i >= 0) state.deleted.push(state.docs.splice(i, 1)[0].slug);
        },
      },
    },
  },
});

let mod: typeof import("./agentTenantFacts");

beforeEach(async () => {
  if (!mod) mod = await import("./agentTenantFacts");
  state.tenants = [{ id: "t_new", name: "Brand New Co", createdAt: new Date(), pbxRemovedAt: null }];
  state.dids = [{ tenantId: "t_new", e164: "+18455550123", active: true }];
  state.extensions = [{ tenantId: "t_new", extNumber: "101", displayName: "Front Desk", status: "ACTIVE", vmEmailEnabled: true }];
  state.sms = [];
  state.users = [{ tenantId: "t_new", email: "boss@new.test", firstName: "Sara", lastName: "Klein", displayName: null, role: "TENANT_ADMIN", uiLanguage: "en" }];
  state.profiles = [];
  state.links = [{ tenantId: "t_new", status: "LINKED", pbxTenantId: "42" }];
  state.billing = [];
  state.actions = [];
  state.escalations = [];
  state.docs = [];
  state.deleted = [];
});

test("a brand-new company gets a document with nobody doing anything", async () => {
  const s = await mod.syncAllTenantFactsDocs();
  assert.equal(s.tenants, 1);
  assert.equal(s.written, 1);
  const doc = state.docs.find((d: any) => d.slug === "facts:t_new");
  assert.ok(doc, "the sweep must create it");
  assert.equal(doc.source, "auto");
  assert.equal(doc.tenantId, "t_new");
  assert.match(doc.body, /\(845\) 555-0123/);
  assert.match(doc.body, /101.*Front Desk/);
  assert.match(doc.body, /Sara Klein — the account admin/);
});

test("the IVR menu is described key by key, in the customer's words", async () => {
  state.profiles = [{
    tenantId: "t_new", name: "Main menu", type: "business_hours", directDialEnabled: true,
    options: [
      { optionDigit: "1", destinationType: "ring_group", label: "Sales" },
      { optionDigit: "2", destinationType: "external_number", label: null },
      { optionDigit: "9", destinationType: "voicemail", label: null },
    ],
  }];
  await mod.syncAllTenantFactsDocs();
  const body = state.docs[0].body;
  assert.match(body, /\*\*Main menu\*\* \(open hours\)/);
  assert.match(body, /callers may dial an extension directly/);
  assert.match(body, /press 1 → Sales \(a team of phones\)/);
  assert.match(body, /press 2 → an outside phone number/);
  assert.match(body, /press 9 → voicemail/);
});

test("having nothing is stated, not omitted — otherwise the model guesses", async () => {
  state.dids = [];
  state.extensions = [];
  state.profiles = [];
  state.users = [];
  await mod.syncAllTenantFactsDocs();
  const body = state.docs[0].body;
  assert.match(body, /No number is routed to them yet/);
  assert.match(body, /No extensions set up yet/);
  assert.match(body, /Texting is not set up/);
  assert.match(body, /no phone menu/);
  assert.match(body, /Nobody has a login yet/);
});

test("changed details are rewritten; unchanged ones are not", async () => {
  await mod.syncAllTenantFactsDocs();
  const second = await mod.syncAllTenantFactsDocs();
  assert.equal(second.written, 0);
  assert.equal(second.unchanged, 1);

  state.extensions.push({ tenantId: "t_new", extNumber: "102", displayName: "Warehouse", status: "ACTIVE", vmEmailEnabled: true });
  const third = await mod.syncAllTenantFactsDocs();
  assert.equal(third.written, 1, "a new extension must reach the assistant");
  assert.match(state.docs[0].body, /102.*Warehouse/);
});

test("⛔ staff-only detail is kept out of the customer-safe half", async () => {
  await mod.syncAllTenantFactsDocs();
  const doc = state.docs[0];
  assert.doesNotMatch(doc.body, /t_new/, "the internal tenant id must not be in the customer half");
  assert.doesNotMatch(doc.body, /billing/i);
  assert.match(doc.internalBody, /t_new/);
  assert.match(doc.internalBody, /never been set up for billing/);
  assert.match(doc.internalBody, /Admin login: boss@new.test/);
});

test("a company that left the platform stops being described", async () => {
  // Two companies: one leaves, one stays. ⛔ Written this way on purpose — with
  // a single tenant, its departure empties the list, and an empty list is the
  // one case where this sweep must delete NOTHING (see the test below).
  state.tenants.push({ id: "t_stay", name: "Still Here Co", createdAt: new Date(), pbxRemovedAt: null });
  await mod.syncAllTenantFactsDocs();
  assert.equal(state.docs.length, 2);

  state.tenants[0].pbxRemovedAt = new Date();
  const s = await mod.syncAllTenantFactsDocs();
  assert.equal(s.removed, 1);
  assert.deepEqual(state.deleted, ["facts:t_new"]);
  assert.ok(state.docs.some((d: any) => d.slug === "facts:t_stay"), "the remaining company keeps its document");
});

test("⛔ an empty tenant list deletes nothing", async () => {
  await mod.syncAllTenantFactsDocs();
  state.tenants = [];
  const s = await mod.syncAllTenantFactsDocs();
  assert.equal(s.removed, 0);
  assert.equal(state.docs.length, 1, "a short read must never be taken as 'everything is gone'");
});

test("one company can be refreshed immediately after provisioning", async () => {
  const ok = await mod.refreshTenantFactsDoc("t_new");
  assert.equal(ok, true);
  assert.equal(state.docs.length, 1);
  assert.equal(state.docs[0].slug, "facts:t_new");
});

test("one company's failure never stops the rest of the sweep", async () => {
  state.tenants.push({ id: "t_two", name: "Second Co", createdAt: new Date(), pbxRemovedAt: null });
  const tenantTable = ((await import("@connect/db")).db as any).tenant;
  const realFindUnique = tenantTable.findUnique;
  tenantTable.findUnique = async ({ where }: any) => {
    if (where.id === "t_new") throw new Error("database blip");
    return state.tenants.find((t: any) => t.id === where.id) ?? null;
  };
  const s = await mod.syncAllTenantFactsDocs();
  tenantTable.findUnique = realFindUnique;
  assert.equal(s.errors, 1);
  assert.equal(s.written, 1, "the healthy company must still be written");
});

test("⛔ what the assistant DID lands in the company's document", async () => {
  state.actions = [
    { tenantId: "t_new", summary: "Add extension 104 for Sarah Klein.", status: "EXECUTED", executedAt: new Date("2026-08-16"), updatedAt: new Date("2026-08-16"), capabilityId: "action.add_extension" },
  ];
  await mod.syncAllTenantFactsDocs();
  const doc = state.docs[0];
  assert.match(doc.body, /What we have done for them recently/);
  assert.match(doc.body, /2026-08-16 — Add extension 104 for Sarah Klein\./);
});

test("a change that did NOT go through is recorded honestly, and flagged for staff", async () => {
  state.actions = [
    { tenantId: "t_new", summary: "Turn on texting.", status: "FAILED", executedAt: null, updatedAt: new Date("2026-08-15"), capabilityId: "action.enable_sms" },
  ];
  await mod.syncAllTenantFactsDocs();
  const doc = state.docs[0];
  assert.match(doc.body, /Turn on texting\. \(this did not go through\)/);
  assert.match(doc.internalBody, /action.enable_sms ended FAILED/);
});

test("what they ASKED for is recorded with its state, without our internal handling", async () => {
  state.escalations = [
    { tenantId: "t_new", requestSummary: "Their voicemail emails stopped arriving.", createdAt: new Date("2026-08-14"), fixStatus: "applied", fixResult: "Added the address to mailbox 101.", userName: "Sara" },
  ];
  await mod.syncAllTenantFactsDocs();
  const doc = state.docs[0];
  assert.match(doc.body, /they asked: Their voicemail emails stopped arriving\. \(sorted\)/);
  assert.doesNotMatch(doc.body, /Added the address to mailbox/, "our handling notes are staff-only");
  assert.match(doc.internalBody, /Added the address to mailbox 101/);
});

test("a company nothing has happened to gets no history section at all", async () => {
  await mod.syncAllTenantFactsDocs();
  assert.doesNotMatch(state.docs[0].body, /What we have done for them recently/);
});

test("a new action changes the document, so the next conversation knows", async () => {
  await mod.syncAllTenantFactsDocs();
  const before = state.docs[0].checksum;
  state.actions = [
    { tenantId: "t_new", summary: "Bought (845) 555-9999.", status: "EXECUTED", executedAt: new Date("2026-08-16"), updatedAt: new Date("2026-08-16"), capabilityId: "action.add_phone_number" },
  ];
  const s = await mod.syncAllTenantFactsDocs();
  assert.equal(s.written, 1);
  assert.notEqual(state.docs[0].checksum, before);
  assert.match(state.docs[0].body, /Bought \(845\) 555-9999/);
});
