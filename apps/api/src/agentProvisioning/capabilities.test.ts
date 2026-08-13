/**
 * The two billable capabilities, driven through the real confirmation core.
 *
 * These are the money paths, so what is proven here is: the right routes get
 * replayed, a refusal leaves nothing half-built, and the things the platform
 * has already been burned by (a non-billable extension number, a tenant's
 * texts landing in someone else's inbox) cannot happen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applyConfirmedAction, buildCapabilityRegistry, type ConfirmDeps, type ConfirmActor } from "../agentConfirmations";
import { addExtensionCapability } from "./addExtensionCapability";
import { enableSmsCapability, findTextableNumber } from "./enableSmsCapability";
import { addPhoneNumberCapability, prettyDid, isNumberBillingTrustworthy } from "./addPhoneNumberCapability";
import {
  ADD_EXTENSION_CAPABILITY_ID,
  ENABLE_SMS_CAPABILITY_ID,
  addExtensionHashInput,
  enableSmsHashInput,
} from "@connect/shared";

const TENANT = "t1";
const OTHER = "t2";
const PASSWORD = "pw";
const PWHASH = "pw-hash";
const ADMIN: ConfirmActor = { sub: "admin-1", tenantId: TENANT, role: "TENANT_ADMIN", email: "boss@acme.com" };

const registry = buildCapabilityRegistry([addExtensionCapability, enableSmsCapability]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const isTenantAdminOrAbove = (r: string) => r === "TENANT_ADMIN" || r === "SUPER_ADMIN";
const resolveTenantId = (role: string, actorTenant: string, actionTenant: string) =>
  role === "SUPER_ADMIN" ? actionTenant : actorTenant;

function makeDb(seed: Partial<Record<string, any[]>> = {}) {
  const state: any = {
    users: seed.users ?? [{ id: "admin-1", tenantId: TENANT, status: "ACTIVE", passwordHash: PWHASH, email: "boss@acme.com" }],
    extensions: seed.extensions ?? [],
    actions: seed.actions ?? [],
    smsNumbers: seed.smsNumbers ?? [],
    smsNumberUsers: [] as any[],
    inboundDids: seed.inboundDids ?? [],
    billingSettings: seed.billingSettings ?? [{ tenantId: TENANT, smsBillingEnabled: false, metadata: {} }],
    tenants: [{ id: TENANT, smsSendMode: "TEST" }],
    pbxLinks: seed.pbxLinks ?? [{ id: "link-1", tenantId: TENANT }],
  };
  const find = (arr: any[], where: any) =>
    arr.find((row) => Object.entries(where).every(([k, v]) => {
      if (v && typeof v === "object" && "in" in (v as any)) return (v as any).in.includes(row[k]);
      if (v && typeof v === "object" && "not" in (v as any)) return row[k] !== (v as any).not;
      return row[k] === v;
    })) ?? null;
  const db: any = {
    _state: state,
    user: {
      findUnique: async ({ where }: any) =>
        state.users.find((u: any) => (where.id ? u.id === where.id : u.email === where.email)) ?? null,
      findMany: async ({ where }: any) =>
        state.users.filter((u: any) => (where.id?.in ? where.id.in.includes(u.id) : true) && (where.tenantId ? u.tenantId === where.tenantId : true)),
    },
    extension: {
      findFirst: async ({ where }: any) => find(state.extensions, where),
      update: async ({ where, data }: any) => {
        const row = state.extensions.find((e: any) => e.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    tenantPbxLink: { findFirst: async ({ where }: any) => find(state.pbxLinks, where) },
    agentAction: {
      findUnique: async ({ where }: any) => state.actions.find((a: any) => a.id === where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        const row = state.actions.find(
          (a: any) => a.id === where.id && a.status === where.status && a.approvalConsumedAt == null,
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      update: async ({ where, data }: any) => {
        const row = state.actions.find((a: any) => a.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    tenantSmsNumber: {
      findFirst: async ({ where }: any) =>
        state.smsNumbers.find((n: any) => {
          if (where.tenantId === null && n.tenantId !== null) return false;
          if (typeof where.tenantId === "string" && n.tenantId !== where.tenantId) return false;
          if (where.active !== undefined && n.active !== where.active) return false;
          if (where.phoneE164?.in && !where.phoneE164.in.includes(n.phoneE164)) return false;
          return true;
        }) ?? null,
      update: async ({ where, data }: any) => {
        const row = state.smsNumbers.find((n: any) => n.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      updateMany: async () => ({ count: 0 }),
    },
    tenantSmsNumberUser: {
      deleteMany: async ({ where }: any) => {
        state.smsNumberUsers = state.smsNumberUsers.filter((r: any) => r.tenantSmsNumberId !== where.tenantSmsNumberId);
        return { count: 0 };
      },
      createMany: async ({ data }: any) => {
        state.smsNumberUsers.push(...data);
        return { count: data.length };
      },
    },
    pbxTenantInboundDid: {
      findMany: async ({ where }: any) =>
        state.inboundDids.filter((d: any) => d.connectTenantId === where.connectTenantId && d.active === where.active),
    },
    tenantBillingSettings: {
      findUnique: async ({ where }: any) => find(state.billingSettings, { tenantId: where.tenantId }),
      update: async ({ where, data }: any) => {
        const row = find(state.billingSettings, { tenantId: where.tenantId });
        if (row) Object.assign(row, data);
        return row;
      },
    },
    tenant: {
      update: async ({ where, data }: any) => {
        const row = state.tenants.find((t: any) => t.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    $transaction: async (fn: any) => fn(db),
  };
  return db;
}

function deps(db: any, over: Partial<ConfirmDeps> = {}) {
  const injected: Array<{ url: string; payload: any }> = [];
  const d: any = {
    db,
    comparePassword: async (p: string, h: string) => p === PASSWORD && h === PWHASH,
    grantablePermissions: async () => new Set(),
    rateLimit: () => true,
    audit: async () => {},
    injectAsService: async (_m: string, url: string, _a: string, payload: any) => {
      injected.push({ url, payload });
      if (url === "/pbx/extensions") {
        db._state.extensions.push({ id: "ext-new", tenantId: TENANT, extNumber: payload.extensionNumber, ownerUserId: "admin-1" });
        return { statusCode: 200, body: { extension: { id: "ext-new" } } };
      }
      return { statusCode: 200, body: { ok: true } };
    },
    enableSmsOnDid: async () => ({ ok: true, detail: "ok" }),
    // Billing is injected, so these tests never stand up the invoice engine.
    // The numbers are the real shape: $25 a line, $10 texting, $35 today.
    billing: {
      snapshot: async () => ({ monthlyTotalCents: 3500, unitPrices: { extensionCents: 2500, smsCents: 1000 } }),
      priceOf: (_s: any, kind: string) => ({
        unitCents: kind === "extension" ? 2500 : 1000,
        charged: true,
        note: "",
      }),
      reconcile: async () => ({ monthlyTotalCents: 4500, deltaCents: 1000, repairedManualOverride: false, warning: null }),
      format: (c: number) => `$${(c / 100).toFixed(2)}`,
    },
    ...over,
  };
  d.injected = injected;
  return d as ConfirmDeps & { injected: typeof injected };
}

function extDraft(over: any = {}) {
  const params = { extensionNumber: "105", firstName: "Yehuda", lastName: "Klein", email: "yehuda@acme.com", ...over.params };
  return {
    id: "act-1",
    tenantId: over.tenantId ?? TENANT,
    capabilityId: ADD_EXTENSION_CAPABILITY_ID,
    params,
    status: "DRAFT",
    summary: "stored prose that must never be trusted",
    requestedBy: "admin-1",
    paramsHash: sha(addExtensionHashInput(over.tenantId ?? TENANT, params)),
    approvalConsumedAt: null,
    createdAt: new Date(),
    ...over.row,
  };
}

const apply = (d: ConfirmDeps, actionId = "act-1", password = PASSWORD, actor = ADMIN) =>
  applyConfirmedAction(d, registry, { actor, actionId, password, isTenantAdminOrAbove, resolveTenantId, hash: sha });

// ─── Adding an extension ─────────────────────────────────────────────────────

test("adding an extension replays the real routes, in order", async () => {
  const db = makeDb({ actions: [extDraft()] });
  const d = deps(db);
  const r: any = await apply(d);

  assert.equal(r.ok, true, r.message);
  assert.deepEqual(d.injected.map((i) => i.url), ["/pbx/extensions", "/admin/users"]);
  // The person is attached with an invite, which is what sends the welcome email.
  assert.equal(d.injected[1].payload.sendInvite, true);
  assert.equal(d.injected[1].payload.email, "yehuda@acme.com");
  assert.equal(d.injected[1].payload.extensionId, "ext-new");
  assert.match(r.message, /welcome email/i);
});

test("⛔ the extension is handed back before the person is attached", async () => {
  // POST /pbx/extensions stamps ownerUserId with whoever created it, and
  // POST /admin/users refuses an already-owned extension (409). Leaving it set
  // would also make PBX sync skip the extension forever.
  const db = makeDb({ actions: [extDraft()] });
  await apply(deps(db));
  const ext = db._state.extensions.find((e: any) => e.id === "ext-new");
  assert.equal(ext.ownerUserId, null, "must be cleared before /admin/users is called");
});

test("⛔ an extension number that would never be billed is refused outright", async () => {
  for (const bad of ["1", "12", "1001", "abc"]) {
    const db = makeDb({ actions: [extDraft({ params: { extensionNumber: bad } })] });
    const r: any = await apply(deps(db));
    assert.equal(r.ok, false, `${bad} must not be created`);
    assert.equal(db._state.extensions.length, 0);
  }
});

test("an extension number taken since the draft was written is refused, not duplicated", async () => {
  const db = makeDb({
    actions: [extDraft()],
    extensions: [{ id: "ext-old", tenantId: TENANT, extNumber: "105" }],
  });
  const d = deps(db);
  const r: any = await apply(d);
  assert.equal(r.ok, false);
  assert.equal(r.error, "extension_taken");
  assert.equal(d.injected.length, 0, "nothing may be created");
  assert.equal(db._state.actions[0].status, "DRAFT", "and the approval is not spent");
});

test("an email that already has an account is refused before anything is built", async () => {
  const db = makeDb({ actions: [extDraft()] });
  db._state.users.push({ id: "u-existing", tenantId: OTHER, email: "yehuda@acme.com", status: "ACTIVE" });
  const d = deps(db);
  const r: any = await apply(d);
  assert.equal(r.error, "email_taken");
  assert.equal(d.injected.length, 0);
});

test("⛔ if attaching the person fails, the customer is told plainly — not 'done'", async () => {
  const db = makeDb({ actions: [extDraft()] });
  const d = deps(db, {
    injectAsService: async (_m: any, url: string, _a: any, payload: any) => {
      if (url === "/pbx/extensions") {
        db._state.extensions.push({ id: "ext-new", tenantId: TENANT, extNumber: payload.extensionNumber, ownerUserId: "admin-1" });
        return { statusCode: 200, body: { extension: { id: "ext-new" } } };
      }
      return { statusCode: 409, body: { error: "email_already_exists" } };
    },
  } as any);
  const r: any = await apply(d);
  assert.equal(r.ok, false);
  assert.match(r.message, /was created/, "must admit the line exists");
  assert.match(r.message, /Users/, "and say where to finish the job");
});

test("⛔ a draft whose params were edited is refused by the hash", async () => {
  const row = extDraft();
  row.params = { ...row.params, extensionNumber: "106" }; // hash still says 105
  const db = makeDb({ actions: [row] });
  const d = deps(db);
  const r: any = await apply(d);
  assert.equal(r.error, "params_tampered");
  assert.equal(d.injected.length, 0);
});

test("⛔ a wrong password builds nothing", async () => {
  const db = makeDb({ actions: [extDraft()] });
  const d = deps(db);
  const r: any = await apply(d, "act-1", "wrong");
  assert.equal(r.status, 401);
  assert.equal(d.injected.length, 0);
  assert.equal(db._state.actions[0].status, "DRAFT");
});

test("⛔ two clicks create one extension", async () => {
  const db = makeDb({ actions: [extDraft()] });
  const d = deps(db);
  const [a, b]: any[] = await Promise.all([apply(d), apply(d)]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal(d.injected.filter((i) => i.url === "/pbx/extensions").length, 1);
});

// ─── Turning texting on ──────────────────────────────────────────────────────

function smsDraft(over: any = {}) {
  const params = { scope: "everyone", userIds: [], ...over.params };
  return {
    id: "act-1",
    tenantId: TENANT,
    capabilityId: ENABLE_SMS_CAPABILITY_ID,
    params,
    status: "DRAFT",
    summary: "stored prose",
    requestedBy: "admin-1",
    paramsHash: sha(enableSmsHashInput(TENANT, params)),
    approvalConsumedAt: null,
    createdAt: new Date(),
  };
}

test("⛔ turning texting on never touches smsSendMode", async () => {
  // LIVE belongs to the old campaign path, which reads the `phoneNumber` table
  // and 10DLC approval. Onboarding tenants have no phoneNumber rows at all, so
  // flipping it would break campaign sends and do nothing for texting.
  const db = makeDb({
    actions: [smsDraft()],
    smsNumbers: [{ id: "sms-1", tenantId: TENANT, active: true, phoneE164: "+18452605692", voipmsDid: "8452605692" }],
  });
  const r: any = await apply(deps(db));
  assert.equal(r.ok, true, r.message);
  assert.equal(db._state.tenants[0].smsSendMode, "TEST", "must stay TEST");
  assert.equal(db._state.billingSettings[0].smsBillingEnabled, true, "billing is the switch");
});

test("an unclaimed number belonging to this company is claimed and made the default", async () => {
  const db = makeDb({
    actions: [smsDraft()],
    smsNumbers: [{ id: "sms-free", tenantId: null, active: true, phoneE164: "+18452605692", voipmsDid: "8452605692" }],
    inboundDids: [{ connectTenantId: TENANT, active: true, e164: "+18452605692" }],
  });
  const r: any = await apply(deps(db));
  assert.equal(r.ok, true, r.message);
  const row = db._state.smsNumbers[0];
  assert.equal(row.tenantId, TENANT);
  assert.equal(row.isTenantDefault, true, "isTenantDefault is the real 'text from this number' setting");
});

test("⛔ a number belonging to ANOTHER company is never claimed", async () => {
  const db = makeDb({
    actions: [smsDraft()],
    smsNumbers: [{ id: "sms-theirs", tenantId: OTHER, active: true, phoneE164: "+18452605692" }],
    inboundDids: [{ connectTenantId: TENANT, active: true, e164: "+18452605692" }],
  });
  const r: any = await apply(deps(db));
  assert.equal(r.ok, false, "must refuse rather than hand over another company's texts");
  assert.equal(r.error, "no_sms_number");
  assert.equal(db._state.smsNumbers[0].tenantId, OTHER, "untouched");
});

test("one person gets a personal inbox; everyone gets the shared one", async () => {
  const one = makeDb({
    actions: [smsDraft({ params: { scope: "one_person", userIds: ["u2"] } })],
    smsNumbers: [{ id: "sms-1", tenantId: TENANT, active: true, phoneE164: "+1845", voipmsDid: "845" }],
  });
  one._state.users.push({ id: "u2", tenantId: TENANT, status: "ACTIVE", email: "y@acme.com" });
  assert.equal((await apply(deps(one)) as any).ok, true);
  assert.equal(one._state.smsNumbers[0].assignedUserId, "u2");

  const all = makeDb({
    actions: [smsDraft()],
    smsNumbers: [{ id: "sms-1", tenantId: TENANT, active: true, phoneE164: "+1845", voipmsDid: "845", assignedUserId: "u2" }],
  });
  assert.equal((await apply(deps(all)) as any).ok, true);
  assert.equal(all._state.smsNumbers[0].assignedUserId, null, "no assignment IS the shared inbox");
});

test("texting that is already on is refused rather than billed twice", async () => {
  const db = makeDb({
    actions: [smsDraft()],
    smsNumbers: [{ id: "sms-1", tenantId: TENANT, active: true, phoneE164: "+1845" }],
    billingSettings: [{ tenantId: TENANT, smsBillingEnabled: true, metadata: {} }],
  });
  const r: any = await apply(deps(db));
  assert.equal(r.ok, false);
  assert.equal(r.error, "sms_already_on");
});

test("a carrier that doesn't confirm is reported, not hidden", async () => {
  const db = makeDb({
    actions: [smsDraft()],
    smsNumbers: [{ id: "sms-1", tenantId: TENANT, active: true, phoneE164: "+18452605692", voipmsDid: "8452605692" }],
  });
  const r: any = await apply(deps(db, { enableSmsOnDid: async () => ({ ok: false, detail: "sms_wait_message" }) } as any));
  assert.equal(r.ok, true, "Connect-side is what decides routing, so this still succeeds");
  assert.match(r.message, /carrier didn't confirm/i);
});

test("findTextableNumber prefers a number the company already owns", async () => {
  const db = makeDb({
    smsNumbers: [
      { id: "claimed", tenantId: TENANT, active: true, phoneE164: "+1111", isTenantDefault: true },
      { id: "free", tenantId: null, active: true, phoneE164: "+2222" },
    ],
    inboundDids: [{ connectTenantId: TENANT, active: true, e164: "+2222" }],
  });
  const found = await findTextableNumber(db, TENANT);
  assert.equal(found?.id, "claimed");
  assert.equal(found?.needsClaim, false);
});

// ─── Adding a phone number ───────────────────────────────────────────────────

test("⛔ toll-free never sneaks through the local-number path", async () => {
  // Toll-free is $15 and a different purchase method. A draft carrying one
  // must not be treated as a $10 local number.
  for (const tf of ["8005551234", "8335551234", "8885551234"]) {
    assert.equal(addPhoneNumberCapability.parseParams({ did: tf }), null, `${tf} must be refused`);
  }
  assert.deepEqual(addPhoneNumberCapability.parseParams({ did: "8455551234" }), { did: "8455551234" });
});

test("a number is normalised to ten digits however it is written", () => {
  for (const written of ["+1 (845) 555-1234", "1-845-555-1234", "845.555.1234"]) {
    assert.deepEqual(addPhoneNumberCapability.parseParams({ did: written }), { did: "8455551234" });
  }
  assert.equal(addPhoneNumberCapability.parseParams({ did: "555-1234" }), null, "too short is not a number");
});

test("the number is read back the way a person says it", () => {
  assert.equal(prettyDid("8457231213"), "(845) 723-1213");
});

test("⛔ an account we cannot serve properly is refused, never half-provisioned", async () => {
  // No VoIP.ms subaccount = no way to route the DID. Buying it anyway would
  // leave the customer paying for a number that never rings.
  const db = makeDb();
  db.onboardingSubmission = { findFirst: async () => null };
  db.phoneNumber = { findFirst: async () => null, create: async () => ({}) };
  const refusal = await addPhoneNumberCapability.authorize(deps(db), {
    actor: ADMIN,
    tenantId: TENANT,
    params: { did: "8455551234" },
    action: {},
  });
  assert.ok(refusal, "must refuse");
  assert.equal(refusal!.error, "cannot_self_serve");
  assert.doesNotMatch(refusal!.message, /subaccount|VoIP|PBX/i, "and must not leak our plumbing to a customer");
});

test("⛔ a number already on the platform is refused", async () => {
  const db = makeDb();
  db.onboardingSubmission = { findFirst: async () => ({ voipmsSubaccountEncrypted: "x" }) };
  db.phoneNumber = { findFirst: async () => ({ id: "pn-1", tenantId: OTHER }), create: async () => ({}) };
  const refusal = await addPhoneNumberCapability.authorize(deps(db), {
    actor: ADMIN,
    tenantId: TENANT,
    params: { did: "8455551234" },
    action: {},
  });
  assert.equal(refusal?.error, "number_taken");
});

test("the price line says 'included' when it is their first number", async () => {
  const db = makeDb();
  const d: any = deps(db, {
    billing: {
      snapshot: async () => ({ monthlyTotalCents: 3500 }),
      priceOf: () => ({ unitCents: 0, charged: false, note: "your first number is included" }),
      reconcile: async () => ({ monthlyTotalCents: 3500, deltaCents: 0, repairedManualOverride: false, warning: null }),
      format: (c: number) => `$${(c / 100).toFixed(2)}`,
    },
  } as any);
  const described = await addPhoneNumberCapability.describe(d, {
    actor: ADMIN,
    tenantId: TENANT,
    params: { did: "8455551234" },
  });
  assert.match(described!.summary, /\(845\) 555-1234/);
  assert.match(described!.priceLine!, /included/i);
});

test("⛔ an account whose real numbers aren't billed cannot be priced", async () => {
  // 11 of 29 live tenants have DIDs only in PbxTenantInboundDid, so the plan's
  // per-number line thinks they have NONE. Quoting the next number as "your
  // first, included" to a company with two is a wrong price on a recurring
  // charge; refusing costs them a self-serve number instead.
  const db: any = {
    phoneNumber: { count: async () => 0 },
    pbxTenantInboundDid: { count: async () => 2 },
  };
  assert.equal(await isNumberBillingTrustworthy(db, TENANT), false);
});

test("an account whose numbers ARE billed can be priced", async () => {
  const db: any = {
    phoneNumber: { count: async () => 2 },
    pbxTenantInboundDid: { count: async () => 2 },
  };
  assert.equal(await isNumberBillingTrustworthy(db, TENANT), true);
  // A brand-new account with nothing yet is fine too — nothing to disagree with.
  const fresh: any = { phoneNumber: { count: async () => 0 }, pbxTenantInboundDid: { count: async () => 0 } };
  assert.equal(await isNumberBillingTrustworthy(fresh, TENANT), true);
});

test("⛔ the refusal never names our plumbing to a customer", async () => {
  const db = makeDb();
  db.onboardingSubmission = { findFirst: async () => null };
  db.phoneNumber = { findFirst: async () => null, count: async () => 0, create: async () => ({}) };
  const refusal = await addPhoneNumberCapability.authorize(deps(db), {
    actor: ADMIN,
    tenantId: TENANT,
    params: { did: "8455551234" },
    action: {},
  });
  assert.ok(refusal);
  assert.doesNotMatch(refusal!.message, /phoneNumber|PbxTenant|subaccount|VoIP|table/i);
});
