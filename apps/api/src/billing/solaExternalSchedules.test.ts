import test from "node:test";
import assert from "node:assert/strict";
import { redactSolaRecurringPayload } from "@connect/integrations";
import {
  last4FromMaskedCard,
  mapSolaExternalSchedule,
  parseSolaCardExpiry,
  parseSolaScheduleRow,
  suggestTenantMatch,
  syncSolaExternalSchedules,
  type SolaExternalScheduleDeps,
} from "./solaExternalSchedules";

test("redactSolaRecurringPayload: redacts Token and card fields", () => {
  const safe = redactSolaRecurringPayload({
    ScheduleId: "c1_s1",
    Token: "secret_vault_token",
    MaskedCardNumber: "4xxxxxxxxxxx1111",
    xSUT: "sut_value",
  });
  assert.equal(safe.Token, "[REDACTED]");
  assert.equal(safe.xSUT, "[REDACTED]");
  assert.equal(safe.MaskedCardNumber, "4xxxxxxxxxxx1111");
  assert.equal(safe.ScheduleId, "c1_s1");
});

test("parseSolaCardExpiry: parses MMYY", () => {
  assert.deepEqual(parseSolaCardExpiry("1228"), { expMonth: "12", expYear: "28" });
});

test("last4FromMaskedCard: last four digits", () => {
  assert.equal(last4FromMaskedCard("4xxxxxxxxxxx4242"), "4242");
});

test("parseSolaScheduleRow: amount and masked metadata without token in rawSafeJson", () => {
  const parsed = parseSolaScheduleRow(
    {
      ScheduleId: "c1_s1",
      CustomerId: "c1",
      PaymentMethodId: "c1_pm1",
      Amount: 49.99,
      IntervalType: "month",
      IntervalCount: 1,
      IsActive: true,
      Email: "bill@acme.com",
      BillCompany: "Acme LLC",
    },
    { Issuer: "Visa", MaskedCardNumber: "4xxxxxxxxxxx1111", Exp: "1228", Token: "must_not_persist" },
  );
  assert.equal(parsed.amountCents, 4999);
  assert.equal(parsed.last4, "1111");
  assert.equal(parsed.brand, "Visa");
  assert.equal(parsed.customerEmail, "bill@acme.com");
  const pm = (parsed.rawSafeJson as Record<string, unknown>).paymentMethod as Record<string, unknown>;
  assert.equal(pm.Token, "[REDACTED]");
});

test("suggestTenantMatch: exact billing email", () => {
  const match = suggestTenantMatch(
    { customerEmail: "bill@acme.com", customerName: "Acme", companyName: "Acme LLC" },
    [
      { id: "t1", name: "Acme Voice", billingEmail: "bill@acme.com" },
      { id: "t2", name: "Other Co", billingEmail: "other@x.com" },
    ],
  );
  assert.equal(match.confidence, "exact_email");
  assert.equal(match.tenantId, "t1");
});

test("suggestTenantMatch: multiple email hits yields no confident match", () => {
  const match = suggestTenantMatch(
    { customerEmail: "shared@x.com", customerName: null, companyName: null },
    [
      { id: "t1", name: "A", billingEmail: "shared@x.com" },
      { id: "t2", name: "B", billingEmail: "shared@x.com" },
    ],
  );
  assert.equal(match.confidence, "none");
  assert.match(match.reason, /Multiple tenants/);
});

test("syncSolaExternalSchedules: upserts without creating PaymentMethod", async () => {
  const store: Record<string, unknown>[] = [];
  let pmCreateCalls = 0;

  const deps: SolaExternalScheduleDeps = {
    db: {
      billingSolaExternalScheduleLink: {
        findUnique: async ({ where }: { where: { solaScheduleId: string } }) =>
          store.find((r) => r.solaScheduleId === where.solaScheduleId) || null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `link_${store.length + 1}`, ...data };
          store.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const idx = store.findIndex((r) => r.id === where.id);
          store[idx] = { ...store[idx], ...data };
          return store[idx];
        },
        groupBy: async () => [{ mappingStatus: "UNMAPPED", _count: { _all: store.length } }],
      },
      tenant: { findFirst: async () => ({ id: "t_probe" }) },
      paymentMethod: {
        create: async () => {
          pmCreateCalls += 1;
          return {};
        },
      },
    } as unknown as SolaExternalScheduleDeps["db"],
    getRecurringClient: async () => ({
      listSchedules: async () => ({
        items: [
          {
            ScheduleId: "c1_s1",
            CustomerId: "c1",
            PaymentMethodId: "c1_pm1",
            Amount: 10,
            IntervalType: "month",
            IntervalCount: 1,
            IsActive: true,
            Email: "a@b.com",
            BillFirstName: "A",
            BillLastName: "B",
          },
        ],
        nextToken: undefined,
      }),
      getSchedule: async () => ({}),
      getPaymentMethodMasked: async () => ({
        Issuer: "Visa",
        MaskedCardNumber: "4xxxxxxxxxxx4242",
        Exp: "1228",
        Token: "vault_token",
      }),
      }) as unknown as import("@connect/integrations").SolaRecurringClient,
    loadTenants: async () => [{ id: "t1", name: "Tenant One", billingEmail: "a@b.com" }],
    logPlatformEvent: async () => {},
    logTenantEvent: async () => {},
    now: () => new Date("2026-05-17T12:00:00.000Z"),
  };

  const result = await syncSolaExternalSchedules({ operatorId: "op1", deps });
  assert.equal(result.scanned, 1);
  assert.equal(result.created, 1);
  assert.equal(pmCreateCalls, 0);
  assert.equal((store[0] as Record<string, unknown>).suggestedTenantId, "t1");
  assert.equal((store[0] as Record<string, unknown>).mappingStatus, "UNMAPPED");
  const raw = (store[0] as Record<string, unknown>).rawSafeJson as Record<string, unknown>;
  const pm = raw.paymentMethod as Record<string, unknown>;
  assert.equal(pm.Token, "[REDACTED]");
});

test("mapSolaExternalSchedule: sets tenant and status only", async () => {
  const row = {
    id: "link1",
    solaScheduleId: "c1_s1",
    solaCustomerId: "c1",
    mappingStatus: "UNMAPPED",
    tenantId: null,
  };
  let pmCreateCalls = 0;

  const deps: SolaExternalScheduleDeps = {
    db: {
      billingSolaExternalScheduleLink: {
        findUnique: async () => row,
        update: async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data }),
      },
      tenant: { findUnique: async () => ({ id: "t1" }) },
      paymentMethod: {
        create: async () => {
          pmCreateCalls += 1;
          return {};
        },
      },
    } as unknown as SolaExternalScheduleDeps["db"],
    getRecurringClient: async () => ({} as never),
    loadTenants: async () => [],
    logPlatformEvent: async () => {},
    logTenantEvent: async () => {},
  };

  const result = await mapSolaExternalSchedule({ linkId: "link1", tenantId: "t1", operatorId: "op1", deps });
  assert.equal(result.ok, true);
  assert.equal(pmCreateCalls, 0);
  if (result.ok) {
    assert.equal((result.link as Record<string, unknown>).tenantId, "t1");
    assert.equal((result.link as Record<string, unknown>).mappingStatus, "MAPPED");
  }
});
