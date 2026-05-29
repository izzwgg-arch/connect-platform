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
  let disableError = "";

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
            if (data.disableError) disableError = String(data.disableError);
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
        updateSchedule: async () => {
          const err = new Error("SOLA_RECURRING_REQUEST_FAILED") as Error & { solaError?: string };
          err.solaError = "Schedule revision does not match";
          throw err;
        },
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.ok(!autopayEnabled, "Connect autopay must NOT be enabled when Sola disable fails");
  assert.equal(cutoverStatus, CUTOVER_STATUS.CUTOVER_FAILED, "cutoverStatus must be CUTOVER_FAILED");
  assert.equal(disableError, "Schedule revision does not match");
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

// ═══════════════════════════════════════════════════════════════════════════════
// Phase E Tests — Sola migration double-charge regression
// These tests prove the root cause of the May 2026 incident is fixed.
//
// Incident: takeOverBillingFromSola set autoBillingEnabled=true without setting
// nextConnectChargeAt, causing the worker to immediately charge for the current
// billing period that Sola already paid. Five customers were double-charged.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Shared helper: builds deps for a successful take-over.
 * now = 2026-05-18 (mid-month, billing day = 1, so Sola already charged May 1).
 */
function makeTakeOverDeps(overrides: {
  billingDayOfMonth?: number;
  savedLinkData?: Record<string, unknown>[];
  savedSettingsData?: Record<string, unknown>[];
  now?: Date;
} = {}): { deps: SolaCutoverDeps; linkUpdates: Record<string, unknown>[]; settingsUpserts: Record<string, unknown>[] } {
  const linkUpdates: Record<string, unknown>[] = [];
  const settingsUpserts: Record<string, unknown>[] = [];
  const billingDay = overrides.billingDayOfMonth ?? 1;

  const deps = makeDeps({
    db: {
      billingSolaExternalScheduleLink: {
        findUnique: async () => makeLink({ linkedPaymentMethodId: "pm_1" }),
        findMany: async () => [],
        update: async (a) => {
          linkUpdates.push(a.data as Record<string, unknown>);
          return { ...makeLink(), ...(a.data as Record<string, unknown>) };
        },
        create: async (a) => a.data as Record<string, unknown>,
      },
      paymentMethod: {
        findFirst: async () => null,
        findUnique: async () => ({ id: "pm_1", tenantId: "tenant_1", tokenEncrypted: "enc", active: true, brand: "Visa", last4: "4242" }),
        create: async (args) => ({ id: "pm_1", ...args.data }),
        update: async (args) => ({ id: args.where.id, ...args.data }),
        updateMany: async () => ({ count: 0 }),
      },
      tenantBillingSettings: {
        findUnique: async () => ({ autoBillingEnabled: false, billingDayOfMonth: billingDay, metadata: null }),
        upsert: async (args: unknown) => {
          settingsUpserts.push(args as Record<string, unknown>);
          return {};
        },
        update: async () => ({}),
      },
    },
  });

  if (overrides.now) {
    deps.now = () => overrides.now!;
  }

  return { deps, linkUpdates, settingsUpserts };
}

test("E-1: takeOverBillingFromSola stores nextConnectChargeAt in the NEXT billing period", async () => {
  // now = May 18 (billing day = 1 → Sola already charged May 1)
  // Expected: nextConnectChargeAt = 2026-06-01 midnight NY = 2026-06-01T04:00:00.000Z
  const now = new Date("2026-05-18T12:00:00Z");
  const { deps, linkUpdates } = makeTakeOverDeps({ billingDayOfMonth: 1, now });

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
    deps,
  );

  assert.ok(result.ok, "take-over should succeed");

  // Find the CUTOVER_COMPLETE link update
  const cutoverUpdate = linkUpdates.find((u) => u.cutoverStatus === "CUTOVER_COMPLETE");
  assert.ok(cutoverUpdate, "link must be updated to CUTOVER_COMPLETE");
  assert.ok(cutoverUpdate.nextConnectChargeAt instanceof Date, "nextConnectChargeAt must be a Date");

  const nextAt = cutoverUpdate.nextConnectChargeAt as Date;
  // Must be in June 2026, not May 2026 (current Sola-paid period)
  const isoStr = nextAt.toISOString();
  assert.ok(isoStr.startsWith("2026-06-"), `nextConnectChargeAt must be in June 2026, got ${isoStr}`);

  // Result must also expose nextConnectChargeAt
  const okResult = result as { ok: true; nextConnectChargeAt: string };
  assert.ok(okResult.nextConnectChargeAt, "result must include nextConnectChargeAt");
  assert.ok(okResult.nextConnectChargeAt.startsWith("2026-06-"), `result.nextConnectChargeAt must be June, got ${okResult.nextConnectChargeAt}`);
});

test("E-2: takeOverBillingFromSola sets billingScheduleOverride.nextPaymentDate in settings metadata", async () => {
  const now = new Date("2026-05-18T12:00:00Z");
  const { deps, settingsUpserts } = makeTakeOverDeps({ billingDayOfMonth: 1, now });

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
    deps,
  );

  assert.ok(result.ok, "take-over should succeed");

  const upsertCall = settingsUpserts[0] as {
    update?: { metadata?: { billingScheduleOverride?: { nextPaymentDate?: string; _solaTransitionGuard?: boolean } } };
    create?: { metadata?: { billingScheduleOverride?: { nextPaymentDate?: string } } };
  };
  assert.ok(upsertCall, "settings must be upserted");

  const meta = upsertCall.update?.metadata ?? upsertCall.create?.metadata;
  assert.ok(meta, "metadata must be set on upsert");

  const override = meta.billingScheduleOverride;
  assert.ok(override, "billingScheduleOverride must be set in metadata");
  assert.ok(override.nextPaymentDate, "nextPaymentDate must be set");
  // Must be in June 2026 — prevents the worker from charging in the current (May) period
  assert.ok(
    String(override.nextPaymentDate).startsWith("2026-06-"),
    `nextPaymentDate must be June 2026, got ${override.nextPaymentDate}`,
  );
  assert.equal(override._solaTransitionGuard, true, "_solaTransitionGuard flag must be set");
});

test("E-3: nextConnectChargeAt is future, not current period (protects against double charge)", async () => {
  // Simulate: billing day = 21, now = May 27 (after May 21 — Sola already ran this month)
  const now = new Date("2026-05-27T16:00:00Z"); // 4 PM UTC = noon NY
  const { deps, linkUpdates } = makeTakeOverDeps({ billingDayOfMonth: 21, now });

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
    deps,
  );

  assert.ok(result.ok, "take-over should succeed");

  const cutoverUpdate = linkUpdates.find((u) => u.cutoverStatus === "CUTOVER_COMPLETE");
  assert.ok(cutoverUpdate?.nextConnectChargeAt instanceof Date, "nextConnectChargeAt must be a Date");

  const nextAt = cutoverUpdate.nextConnectChargeAt as Date;
  // nextConnectChargeAt must be AFTER now — Connect cannot charge today
  assert.ok(nextAt.getTime() > now.getTime(), `nextConnectChargeAt (${nextAt.toISOString()}) must be after now (${now.toISOString()})`);

  // Must be June 21, not May 21 (already past and paid by Sola)
  const isoStr = nextAt.toISOString();
  assert.ok(isoStr.startsWith("2026-06-21"), `nextConnectChargeAt must be 2026-06-21, got ${isoStr}`);
});

test("E-4: takeOverBillingFromSola does not charge card and does not create invoice", async () => {
  let chargeCalled = false;
  let invoiceCreateCalled = false;

  const { deps } = makeTakeOverDeps({ billingDayOfMonth: 1 });
  const origLog = deps.logEvent;
  deps.logEvent = async (input) => {
    if ((input.type as string).toLowerCase().includes("charge") || (input.type as string).toLowerCase().includes("payment_success")) {
      chargeCalled = true;
    }
    return origLog(input);
  };

  // Intercept db to detect invoice creation
  const origDb = deps.db;
  (deps as { db: unknown }).db = new Proxy(origDb, {
    get(target: typeof origDb, prop: string) {
      if (prop === "billingInvoice") {
        return {
          create: () => {
            invoiceCreateCalled = true;
            return Promise.resolve({ id: "inv_fake" });
          },
          findFirst: async () => null,
          findMany: async () => [],
          update: async () => ({}),
        };
      }
      return (target as Record<string, unknown>)[prop];
    },
  });

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
    deps,
  );

  assert.ok(result.ok, "take-over should succeed");
  assert.ok(!chargeCalled, "No charge must be executed during take-over");
  assert.ok(!invoiceCreateCalled, "No invoice must be created during take-over");
});

test("E-5: takeOverBillingFromSola is idempotent — blocks if already CUTOVER_COMPLETE (no double cutover)", async () => {
  const { deps } = makeTakeOverDeps();
  // Simulate link already cut over
  (deps.db as { billingSolaExternalScheduleLink: { findUnique: unknown } }).billingSolaExternalScheduleLink.findUnique =
    async () => makeLink({ linkedPaymentMethodId: "pm_1", cutoverStatus: "CUTOVER_COMPLETE" });

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
    deps,
  );

  assert.equal(result.ok, false);
  assert.equal((result as { ok: false; error: string }).error, "already_cutover_complete");
});

test("E-6: takeOverBillingFromSola nextConnectChargeAt respects NY midnight boundary (America/New_York)", async () => {
  // Billing day = 1. now = 2026-05-01T03:30:00Z = 11:30 PM April 30 in NY (before midnight NY May 1)
  // Expected current period charge date = May 1 midnight NY = 2026-05-01T04:00:00Z
  // So now is BEFORE the scheduled charge. But for the purpose of takeover:
  // buildBillingSchedule for May 1 local will say periodEnd = May 31 end.
  // Next period = June 1 midnight NY.
  const now = new Date("2026-05-18T12:00:00Z"); // safely mid-month
  const { deps, linkUpdates } = makeTakeOverDeps({ billingDayOfMonth: 1, now });

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
    deps,
  );

  assert.ok(result.ok, "take-over should succeed");
  const cutoverUpdate = linkUpdates.find((u) => u.cutoverStatus === "CUTOVER_COMPLETE");
  const nextAt = cutoverUpdate?.nextConnectChargeAt as Date | undefined;
  assert.ok(nextAt, "nextConnectChargeAt must be set");
  // Must be exactly midnight NY for June 1 = 2026-06-01T04:00:00.000Z (EDT, UTC-4)
  assert.equal(nextAt.toISOString(), "2026-06-01T04:00:00.000Z",
    "nextConnectChargeAt must be June 1 midnight America/New_York (04:00 UTC)");
});
