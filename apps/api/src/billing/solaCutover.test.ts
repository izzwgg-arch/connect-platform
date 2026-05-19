/**
 * Tests for Sola billing cutover (Phases A, B, C, D).
 *
 * Test cases:
 *  A-1. link-token requires schedule to be MAPPED → 400 schedule_not_mapped
 *  A-2. link-token stores encrypted token but never returns raw token
 *  A-3. link-token does NOT enable autopay
 *  A-4. link-token does NOT disable Sola schedule
 *  A-5. link-token failure on Cardknox → 502, no PaymentMethod created
 *  B-1. readiness returns not-ready when no schedule mapped
 *  B-2. readiness returns doubleChargeRisk when autopay+active schedule present
 *  C-1. take-over disables Sola schedule before enabling Connect autopay
 *  C-2. take-over failure → does NOT enable Connect autopay, status=CUTOVER_FAILED
 *  C-3. take-over requires all three confirm fields
 *  C-4. take-over blocks if Connect autopay already enabled
 *  D-1. worker guard skips charge if active Sola schedule not cut over
 *  D-2. worker guard allows charge if cutover complete
 *  D-3. billingScheduleOverride skipNextPayment consumes flag once and logs
 *  D-4. billingScheduleOverride nextPaymentDate prevents charge before date
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  linkSolaTokenToPaymentMethod,
  getBillingCutoverReadiness,
  takeOverBillingFromSola,
  CUTOVER_STATUS,
  type SolaCutoverDeps,
} from "./solaCutover";

// ─── In-memory DB stub ────────────────────────────────────────────────────────

type MockDb = {
  billingSolaExternalScheduleLink: {
    findUnique: (args: { where: { id: string } }) => Promise<Record<string, unknown> | null>;
    findMany: (args: unknown) => Promise<Record<string, unknown>[]>;
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    create: (args: { data: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  };
  paymentMethod: {
    findFirst: (args: unknown) => Promise<Record<string, unknown> | null>;
    findUnique: (args: { where: { id: string }; select?: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
    create: (args: { data: Record<string, unknown>; select?: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    update: (args: { where: { id: string }; data: Record<string, unknown>; select?: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
  tenant: {
    findUnique: (args: { where: { id: string }; select?: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
  };
  tenantBillingSettings: {
    findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
    upsert: (args: unknown) => Promise<Record<string, unknown>>;
    update: (args: unknown) => Promise<Record<string, unknown>>;
  };
};

function makeDb(overrides: Partial<MockDb> = {}): MockDb {
  return {
    billingSolaExternalScheduleLink: {
      findUnique: async () => null,
      findMany: async () => [],
      update: async (args) => args.data,
      create: async (args) => args.data,
      ...overrides.billingSolaExternalScheduleLink,
    },
    paymentMethod: {
      findFirst: async () => null,
      findUnique: async () => null,
      create: async (args) => ({ id: "pm_new", ...args.data }),
      update: async (args) => ({ id: args.where.id, ...args.data }),
      updateMany: async () => ({ count: 0 }),
      ...overrides.paymentMethod,
    },
    tenant: {
      findUnique: async () => ({ id: "tenant_1" }),
      ...overrides.tenant,
    },
    tenantBillingSettings: {
      findUnique: async () => null,
      upsert: async () => ({}),
      update: async () => ({}),
      ...overrides.tenantBillingSettings,
    },
  };
}

type MockRecurringClient = {
  getPaymentMethodWithToken: (pmId: string) => Promise<{ token: string; issuer: string | null; maskedCardNumber: string | null; exp: string | null; rawRow: Record<string, unknown> }>;
  updateSchedule: (scheduleId: string, update: { isActive: boolean }) => Promise<{ ok: boolean; refNum?: string }>;
};

function makeClient(overrides: Partial<MockRecurringClient> = {}): MockRecurringClient {
  return {
    getPaymentMethodWithToken: async () => ({
      token: "raw_vault_token_abc",
      issuer: "Visa",
      maskedCardNumber: "4xxxxxxxxxxx4242",
      exp: "1228",
      rawRow: {},
    }),
    updateSchedule: async () => ({ ok: true }),
    ...overrides,
  };
}

function makeDeps(overrides: {
  db?: Partial<MockDb>;
  client?: Partial<MockRecurringClient>;
  encryptToken?: (t: string) => string;
  logEvent?: (input: { tenantId: string; type: string; message?: string; metadata?: Record<string, unknown> }) => Promise<void>;
} = {}): SolaCutoverDeps {
  const db = makeDb(overrides.db || {});
  const client = makeClient(overrides.client || {});
  const capturedLogs: Array<{ tenantId: string; type: string; metadata?: Record<string, unknown> }> = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: db as any,
    getRecurringClient: async () => client as unknown as import("@connect/integrations").SolaRecurringClient,
    encryptToken: overrides.encryptToken ?? ((t) => `encrypted:${t}`),
    logEvent: overrides.logEvent ?? (async (input) => { capturedLogs.push(input); }),
    now: () => new Date("2026-05-18T12:00:00Z"),
  };
}

function makeLink(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "link_1",
    tenantId: "tenant_1",
    solaScheduleId: "sola_sched_1",
    solaCustomerId: "sola_cust_1",
    solaPaymentMethodId: "sola_pm_1",
    mappingStatus: "MAPPED",
    isActive: true,
    brand: "Visa",
    last4: "4242",
    expMonth: "12",
    expYear: "28",
    cutoverStatus: null,
    linkedPaymentMethodId: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase A Tests — Token Linking
// ═══════════════════════════════════════════════════════════════════════════════

test("A-1: link-token returns 400 when schedule is not MAPPED", async () => {
  const result = await linkSolaTokenToPaymentMethod({
    linkId: "link_1",
    operatorId: "op_1",
    deps: makeDeps({
      db: {
        billingSolaExternalScheduleLink: {
          findUnique: async () => makeLink({ mappingStatus: "UNMAPPED" }),
          findMany: async () => [],
          update: async (a) => a.data,
          create: async (a) => a.data,
        },
      },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal((result as { ok: false; code: number; error: string }).code, 400);
  assert.equal((result as { ok: false; code: number; error: string }).error, "schedule_not_mapped");
});

test("A-2: link-token stores encrypted token, never raw token in response or logs", async () => {
  let encryptCalled = false;
  let encryptedValue = "";
  let rawTokenInLog = false;
  const logs: Array<Record<string, unknown>> = [];

  const result = await linkSolaTokenToPaymentMethod({
    linkId: "link_1",
    operatorId: "op_1",
    deps: makeDeps({
      db: {
        billingSolaExternalScheduleLink: {
          findUnique: async () => makeLink(),
          findMany: async () => [],
          update: async (a) => ({ ...makeLink(), ...a.data }),
          create: async (a) => a.data,
        },
        paymentMethod: {
          findFirst: async () => null,
          findUnique: async () => null,
          create: async (args) => ({ id: "pm_imported", ...args.data }),
          update: async (args) => ({ id: args.where.id, ...args.data }),
          updateMany: async () => ({ count: 0 }),
        },
      },
      encryptToken: (t) => {
        encryptCalled = true;
        encryptedValue = `encrypted:${t}`;
        return encryptedValue;
      },
      logEvent: async (input) => {
        logs.push(input as unknown as Record<string, unknown>);
        const str = JSON.stringify(input);
        if (str.includes("raw_vault_token_abc")) rawTokenInLog = true;
      },
    }),
  });

  assert.ok(result.ok, "link-token should succeed");
  assert.ok(encryptCalled, "encryptToken must be called");
  assert.ok(!rawTokenInLog, "raw token must NOT appear in any log");
  // Response must not include raw token
  const str = JSON.stringify(result);
  assert.ok(!str.includes("raw_vault_token_abc"), "raw token must NOT appear in response");
  assert.ok(str.includes("pm_imported") || (result as { ok: true; paymentMethodId: string }).paymentMethodId, "should return paymentMethodId");
});

test("A-3: link-token does NOT enable Connect autopay", async () => {
  let autoBillingUpdated = false;

  await linkSolaTokenToPaymentMethod({
    linkId: "link_1",
    operatorId: "op_1",
    deps: makeDeps({
      db: {
        billingSolaExternalScheduleLink: {
          findUnique: async () => makeLink(),
          findMany: async () => [],
          update: async (a) => ({ ...makeLink(), ...a.data }),
          create: async (a) => a.data,
        },
        paymentMethod: {
          findFirst: async () => null,
          findUnique: async () => null,
          create: async (args) => ({ id: "pm_imported", ...args.data }),
          update: async (args) => ({ id: args.where.id, ...args.data }),
          updateMany: async () => ({ count: 0 }),
        },
        tenantBillingSettings: {
          findUnique: async () => null,
          upsert: async (args: unknown) => {
            const a = args as { data?: { update?: Record<string, unknown> }; update?: Record<string, unknown> };
            if (a?.update && "autoBillingEnabled" in (a.update || {})) autoBillingUpdated = true;
            return {};
          },
          update: async () => ({}),
        },
      },
    }),
  });

  assert.ok(!autoBillingUpdated, "link-token must NOT touch autoBillingEnabled");
});

test("A-4: link-token does NOT call updateSchedule on Sola", async () => {
  let updateScheduleCalled = false;

  await linkSolaTokenToPaymentMethod({
    linkId: "link_1",
    operatorId: "op_1",
    deps: makeDeps({
      db: {
        billingSolaExternalScheduleLink: {
          findUnique: async () => makeLink(),
          findMany: async () => [],
          update: async (a) => ({ ...makeLink(), ...a.data }),
          create: async (a) => a.data,
        },
        paymentMethod: {
          findFirst: async () => null,
          findUnique: async () => null,
          create: async (args) => ({ id: "pm_imported", ...args.data }),
          update: async (args) => ({ id: args.where.id, ...args.data }),
          updateMany: async () => ({ count: 0 }),
        },
      },
      client: {
        getPaymentMethodWithToken: async () => ({
          token: "raw_vault_token_abc",
          issuer: "Visa",
          maskedCardNumber: "4xxxxxxxxxxx4242",
          exp: "1228",
          rawRow: {},
        }),
        updateSchedule: async () => {
          updateScheduleCalled = true;
          return { ok: true };
        },
      },
    }),
  });

  assert.ok(!updateScheduleCalled, "link-token must NOT call updateSchedule");
});

test("A-5: link-token returns 502 on Cardknox failure, no PaymentMethod created", async () => {
  let pmCreated = false;

  const result = await linkSolaTokenToPaymentMethod({
    linkId: "link_1",
    operatorId: "op_1",
    deps: makeDeps({
      db: {
        billingSolaExternalScheduleLink: {
          findUnique: async () => makeLink(),
          findMany: async () => [],
          update: async (a) => ({ ...makeLink(), ...a.data }),
          create: async (a) => a.data,
        },
        paymentMethod: {
          findFirst: async () => null,
          findUnique: async () => null,
          create: async () => { pmCreated = true; return { id: "pm_should_not_create" }; },
          update: async (args) => ({ id: args.where.id }),
          updateMany: async () => ({ count: 0 }),
        },
      },
      client: {
        getPaymentMethodWithToken: async () => { throw new Error("SOLA_RECURRING_TOKEN_MISSING"); },
        updateSchedule: async () => ({ ok: true }),
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal((result as { ok: false; code: number }).code, 502);
  assert.ok(!pmCreated, "PaymentMethod must NOT be created on token fetch failure");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase B Tests — Readiness Check
// ═══════════════════════════════════════════════════════════════════════════════

test("B-1: readiness returns not-ready when no schedule mapped", async () => {
  const result = await getBillingCutoverReadiness({
    tenantId: "tenant_1",
    deps: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: makeDb({
        billingSolaExternalScheduleLink: {
          findUnique: async () => null,
          findMany: async () => [],
          update: async (a) => a.data,
          create: async (a) => a.data,
        },
      }) as any,
    },
  });
  assert.equal(result.importedScheduleMapped, false);
  assert.equal(result.readyForCutover, false);
  assert.ok(result.blockers.length > 0);
});

test("B-2: readiness returns doubleChargeRisk when autopay and active non-cutover schedule both present", async () => {
  const result = await getBillingCutoverReadiness({
    tenantId: "tenant_1",
    deps: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: makeDb({
        billingSolaExternalScheduleLink: {
          findUnique: async () => null,
          findMany: async () => [
            { id: "link_1", solaScheduleId: "sola_1", brand: "Visa", last4: "4242", isActive: true, cutoverStatus: null, linkedPaymentMethodId: "pm_1" },
          ],
          update: async (a) => a.data,
          create: async (a) => a.data,
        },
        tenantBillingSettings: {
          findUnique: async () => ({ autoBillingEnabled: true, defaultPaymentMethodId: "pm_1", extensionPriceCents: 3000, metadata: null }),
          upsert: async () => ({}),
          update: async () => ({}),
        },
      }) as any,
    },
  });
  assert.equal(result.doubleChargeRisk, true);
  assert.equal(result.connectAutopayEnabled, true);
  assert.equal(result.oldSolaScheduleActive, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase C Tests — Take Over Billing
// ═══════════════════════════════════════════════════════════════════════════════

test("C-1: take-over disables Sola schedule before enabling Connect autopay", async () => {
  const events: string[] = [];

  const result = await takeOverBillingFromSola(
    {
      tenantId: "tenant_1",
      solaScheduleLinkId: "link_1",
      linkedPaymentMethodId: "pm_1",
      confirmDisableSolaSchedule: true,
      confirmEnableConnectAutopay: true,
      confirmNoImmediateCharge: true,
      operatorId: "op_1",
    },
    makeDeps({
      db: {
        billingSolaExternalScheduleLink: {
          findUnique: async () => makeLink({ linkedPaymentMethodId: "pm_1" }),
          findMany: async () => [],
          update: async (a) => ({ ...makeLink(), ...a.data }),
          create: async (a) => a.data,
        },
        paymentMethod: {
          findFirst: async () => null,
          findUnique: async () => ({ id: "pm_1", tenantId: "tenant_1", tokenEncrypted: "encrypted:token", active: true, brand: "Visa", last4: "4242" }),
          create: async (args) => ({ id: "pm_1", ...args.data }),
          update: async (args) => ({ id: args.where.id, ...args.data }),
          updateMany: async () => ({ count: 0 }),
        },
        tenantBillingSettings: {
          findUnique: async () => ({ autoBillingEnabled: false }),
          upsert: async () => ({}),
          update: async () => ({}),
        },
      },
      client: {
        getPaymentMethodWithToken: async () => ({ token: "raw", issuer: null, maskedCardNumber: null, exp: null, rawRow: {} }),
        updateSchedule: async (scheduleId, update) => {
          events.push(`updateSchedule:${scheduleId}:isActive=${update.isActive}`);
          return { ok: true };
        },
      },
      logEvent: async (input) => { events.push(`log:${input.type}`); },
    }),
  );

  assert.ok(result.ok, "take-over should succeed");
  // Sola disable must happen before autopay enable in the event sequence
  const disableIdx = events.findIndex((e) => e.startsWith("updateSchedule"));
  const autopayIdx = events.findIndex((e) => e.includes("connect_autopay_enabled"));
  assert.ok(disableIdx !== -1, "updateSchedule must be called");
  assert.ok(autopayIdx !== -1, "connect_autopay_enabled must be logged");
  assert.ok(disableIdx < autopayIdx, "Sola schedule must be disabled BEFORE autopay is enabled");
  assert.ok(events.some((e) => e.includes("isActive=false")), "must set IsActive=false");
});

test("C-2: take-over failure does NOT enable Connect autopay, sets CUTOVER_FAILED", async () => {
  let autopayEnabled = false;
  let cutoverStatus = "";

  const result = await takeOverBillingFromSola(
    {
      tenantId: "tenant_1",
      solaScheduleLinkId: "link_1",
      linkedPaymentMethodId: "pm_1",
      confirmDisableSolaSchedule: true,
      confirmEnableConnectAutopay: true,
      confirmNoImmediateCharge: true,
      operatorId: "op_1",
    },
    makeDeps({
      db: {
        billingSolaExternalScheduleLink: {
          findUnique: async () => makeLink({ linkedPaymentMethodId: "pm_1" }),
          findMany: async () => [],
          update: async (a) => {
            const data = a.data as Record<string, unknown>;
            if (data.cutoverStatus) cutoverStatus = String(data.cutoverStatus);
            return { ...makeLink(), ...data };
          },
          create: async (a) => a.data,
        },
        paymentMethod: {
          findFirst: async () => null,
          findUnique: async () => ({ id: "pm_1", tenantId: "tenant_1", tokenEncrypted: "enc", active: true, brand: "Visa", last4: "4242" }),
          create: async (args) => ({ id: "pm_1", ...args.data }),
          update: async (args) => ({ id: args.where.id, ...args.data }),
          updateMany: async () => ({ count: 0 }),
        },
        tenantBillingSettings: {
          findUnique: async () => ({ autoBillingEnabled: false }),
          upsert: async (args: unknown) => {
            const a = args as { update?: Record<string, unknown> };
            if (a?.update && (a.update as Record<string, unknown>)["autoBillingEnabled"] === true) autopayEnabled = true;
            return {};
          },
          update: async () => ({}),
        },
      },
      client: {
        getPaymentMethodWithToken: async () => ({ token: "raw", issuer: null, maskedCardNumber: null, exp: null, rawRow: {} }),
        updateSchedule: async () => { throw new Error("SOLA_API_UNAVAILABLE"); },
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.ok(!autopayEnabled, "Connect autopay must NOT be enabled when Sola disable fails");
  assert.equal(cutoverStatus, CUTOVER_STATUS.CUTOVER_FAILED, "cutoverStatus must be CUTOVER_FAILED");
});

test("C-3: take-over blocks if Connect autopay already enabled", async () => {
  const result = await takeOverBillingFromSola(
    {
      tenantId: "tenant_1",
      solaScheduleLinkId: "link_1",
      linkedPaymentMethodId: "pm_1",
      confirmDisableSolaSchedule: true,
      confirmEnableConnectAutopay: true,
      confirmNoImmediateCharge: true,
      operatorId: "op_1",
    },
    makeDeps({
      db: {
        billingSolaExternalScheduleLink: {
          findUnique: async () => makeLink({ linkedPaymentMethodId: "pm_1" }),
          findMany: async () => [],
          update: async (a) => ({ ...makeLink(), ...a.data }),
          create: async (a) => a.data,
        },
        paymentMethod: {
          findFirst: async () => null,
          findUnique: async () => ({ id: "pm_1", tenantId: "tenant_1", tokenEncrypted: "enc", active: true, brand: "Visa", last4: "4242" }),
          create: async (args) => ({ id: "pm_1", ...args.data }),
          update: async (args) => ({ id: args.where.id, ...args.data }),
          updateMany: async () => ({ count: 0 }),
        },
        tenantBillingSettings: {
          findUnique: async () => ({ autoBillingEnabled: true }), // already enabled
          upsert: async () => ({}),
          update: async () => ({}),
        },
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal((result as { ok: false; code: number; error: string }).error, "connect_autopay_already_enabled");
});

test("C-4: take-over does not create invoice or charge card", async () => {
  let chargeAttempted = false;
  let invoiceCreated = false;

  await takeOverBillingFromSola(
    {
      tenantId: "tenant_1",
      solaScheduleLinkId: "link_1",
      linkedPaymentMethodId: "pm_1",
      confirmDisableSolaSchedule: true,
      confirmEnableConnectAutopay: true,
      confirmNoImmediateCharge: true,
      operatorId: "op_1",
    },
    makeDeps({
      db: {
        billingSolaExternalScheduleLink: {
          findUnique: async () => makeLink({ linkedPaymentMethodId: "pm_1" }),
          findMany: async () => [],
          update: async (a) => ({ ...makeLink(), ...a.data }),
          create: async (a) => {
            const data = a.data as Record<string, unknown>;
            if (String(data.model || "").includes("invoice")) invoiceCreated = true;
            return data;
          },
        },
        paymentMethod: {
          findFirst: async () => null,
          findUnique: async () => ({ id: "pm_1", tenantId: "tenant_1", tokenEncrypted: "enc", active: true, brand: "Visa", last4: "4242" }),
          create: async (args) => ({ id: "pm_1", ...args.data }),
          update: async (args) => ({ id: args.where.id, ...args.data }),
          updateMany: async () => ({ count: 0 }),
        },
        tenantBillingSettings: {
          findUnique: async () => ({ autoBillingEnabled: false }),
          upsert: async () => ({}),
          update: async () => ({}),
        },
      },
      client: {
        getPaymentMethodWithToken: async () => ({ token: "raw", issuer: null, maskedCardNumber: null, exp: null, rawRow: {} }),
        updateSchedule: async () => ({ ok: true }),
      },
      logEvent: async (input) => {
        if ((input.type as string).includes("charge") || (input.type as string).includes("sale")) {
          chargeAttempted = true;
        }
      },
    }),
  );

  assert.ok(!chargeAttempted, "No charge must be attempted during take-over");
  assert.ok(!invoiceCreated, "No invoice must be created during take-over");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase D tests live in the worker but we test the service helpers here
// ═══════════════════════════════════════════════════════════════════════════════

// Validate the CUTOVER_STATUS constant is correct
test("CUTOVER_STATUS constants are correct strings", () => {
  assert.equal(CUTOVER_STATUS.TOKEN_LINKED, "TOKEN_LINKED");
  assert.equal(CUTOVER_STATUS.CUTOVER_COMPLETE, "CUTOVER_COMPLETE");
  assert.equal(CUTOVER_STATUS.CUTOVER_FAILED, "CUTOVER_FAILED");
});
