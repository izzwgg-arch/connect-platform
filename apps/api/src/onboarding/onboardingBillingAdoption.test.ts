// Unit tests for the sign-up billing adoption helper — the shared piece the
// orchestrator's race-repair and the backfill script both rely on.

import test from "node:test";
import assert from "node:assert/strict";
import { adoptOnboardingBilling, deleteTenantIfEmpty } from "./onboardingBillingAdoption";

function makeWorld() {
  const world = {
    invoices: [] as any[],
    lineItems: [] as any[],
    paymentMethods: [] as any[],
    transactions: [] as any[],
    chargeOps: [] as any[],
    eventLogs: [] as any[],
    settings: new Map<string, any>(),
    users: [] as any[],
    extensions: [] as any[],
    links: [] as any[],
    tenants: new Map<string, any>(),
  };
  const updateManyByTenant = (rows: any[]) => async ({ where, data }: any) => {
    const hits = rows.filter((r) => r.tenantId === where.tenantId);
    for (const r of hits) Object.assign(r, data);
    return { count: hits.length };
  };
  const countByTenant = (rows: any[]) => async ({ where }: any) =>
    rows.filter((r) => r.tenantId === where.tenantId).length;
  const dbc = {
    billingInvoice: { updateMany: updateManyByTenant(world.invoices), count: countByTenant(world.invoices) },
    billingInvoiceLineItem: { updateMany: updateManyByTenant(world.lineItems) },
    paymentMethod: { updateMany: updateManyByTenant(world.paymentMethods), count: countByTenant(world.paymentMethods) },
    paymentTransaction: { updateMany: updateManyByTenant(world.transactions) },
    billingChargeOperation: { updateMany: updateManyByTenant(world.chargeOps) },
    billingEventLog: { updateMany: updateManyByTenant(world.eventLogs) },
    tenantBillingSettings: {
      findUnique: async ({ where }: any) => world.settings.get(where.tenantId) || null,
      update: async ({ where, data }: any) => {
        const s = world.settings.get(where.tenantId);
        if (!s) throw new Error("settings_not_found");
        Object.assign(s, data);
        return s;
      },
      upsert: async ({ where, create, update }: any) => {
        const s = world.settings.get(where.tenantId);
        if (s) {
          Object.assign(s, update);
          return s;
        }
        const created = { tenantId: where.tenantId, ...create };
        world.settings.set(where.tenantId, created);
        return created;
      },
    },
    user: { count: countByTenant(world.users) },
    extension: { count: countByTenant(world.extensions) },
    tenantPbxLink: { findFirst: async ({ where }: any) => world.links.find((l) => l.tenantId === where.tenantId) || null },
    tenant: {
      delete: async ({ where }: any) => {
        if (!world.tenants.has(where.id)) throw new Error("tenant_not_found");
        world.tenants.delete(where.id);
        return { id: where.id };
      },
    },
  };
  return { world, dbc };
}

test("moves invoice, line items, card, transactions and carries autopay + default card + billing email", async () => {
  const { world, dbc } = makeWorld();
  world.invoices.push({ id: "inv1", tenantId: "orphan" });
  world.lineItems.push({ id: "li1", tenantId: "orphan" }, { id: "li2", tenantId: "orphan" });
  world.paymentMethods.push({ id: "pm1", tenantId: "orphan" });
  world.transactions.push({ id: "tx1", tenantId: "orphan" });
  world.settings.set("orphan", { tenantId: "orphan", autoBillingEnabled: true, defaultPaymentMethodId: "pm1", billingEmail: "o@x.com" });

  const s = await adoptOnboardingBilling(dbc, "orphan", "live");

  assert.equal(s.invoicesMoved, 1);
  assert.equal(s.lineItemsMoved, 2);
  assert.equal(s.paymentMethodsMoved, 1);
  assert.equal(s.transactionsMoved, 1);
  assert.equal(world.invoices[0].tenantId, "live");
  assert.equal(world.paymentMethods[0].tenantId, "live");
  const live = world.settings.get("live");
  assert.equal(live.autoBillingEnabled, true);
  assert.equal(live.defaultPaymentMethodId, "pm1");
  assert.equal(live.billingEmail, "o@x.com");
  // The orphan must never try to bill again:
  const orphan = world.settings.get("orphan");
  assert.equal(orphan.autoBillingEnabled, false);
  assert.equal(orphan.defaultPaymentMethodId, null);
});

test("never clobbers settings an operator already put on the live tenant", async () => {
  const { world, dbc } = makeWorld();
  world.paymentMethods.push({ id: "pm_orphan", tenantId: "orphan" });
  world.settings.set("orphan", { tenantId: "orphan", autoBillingEnabled: true, defaultPaymentMethodId: "pm_orphan", billingEmail: "o@x.com" });
  world.settings.set("live", { tenantId: "live", autoBillingEnabled: true, defaultPaymentMethodId: "pm_live", billingEmail: "live@x.com" });

  await adoptOnboardingBilling(dbc, "orphan", "live");

  const live = world.settings.get("live");
  assert.equal(live.defaultPaymentMethodId, "pm_live");
  assert.equal(live.billingEmail, "live@x.com");
});

test("same or missing tenant ids are a no-op", async () => {
  const { world, dbc } = makeWorld();
  world.invoices.push({ id: "inv1", tenantId: "t1" });
  const same = await adoptOnboardingBilling(dbc, "t1", "t1");
  assert.equal(same.invoicesMoved, 0);
  const missing = await adoptOnboardingBilling(dbc, "", "t1");
  assert.equal(missing.invoicesMoved, 0);
  assert.equal(world.invoices[0].tenantId, "t1");
});

test("deleteTenantIfEmpty refuses while anything is still attached, deletes once clean", async () => {
  const { world, dbc } = makeWorld();
  world.tenants.set("orphan", { id: "orphan" });
  world.invoices.push({ id: "inv1", tenantId: "orphan" });

  const refused = await deleteTenantIfEmpty(dbc, "orphan");
  assert.equal(refused.deleted, false);
  assert.match(String(refused.reason), /invoice/);
  assert.ok(world.tenants.has("orphan"));

  world.invoices[0].tenantId = "live";
  const done = await deleteTenantIfEmpty(dbc, "orphan");
  assert.equal(done.deleted, true);
  assert.ok(!world.tenants.has("orphan"));
});
