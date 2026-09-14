import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { DisabledRps } from "./yealinkRps";

const url = process.env.MANAGED_PHONE_TEST_DATABASE_URL;
test("real PostgreSQL: migration, advisory-lock claims, unique MAC, rollback and audit atomicity", { skip: !url }, async () => {
  const target = new URL(url!);
  // This test cannot be pointed at a deployed database, even accidentally.
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55439");
  assert.equal(target.username, "managed_phone_test");
  const database = new PrismaClient({ datasources: { db: { url } } });
  mock.module("@connect/db", { namedExports: { db: database } });
  const { ManagedPhoneService, YealinkProvider } = require("./managedPhoneService");
  process.env.CREDENTIALS_MASTER_KEY = "ab".repeat(32);
  try {
    const tenant = await database.tenant.create({ data: { name: "Disposable managed phone test" } });
    const user = await database.user.create({ data: { tenantId: tenant.id, email: `${randomUUID()}@example.invalid`, passwordHash: "test-only", role: "ADMIN" } });
    const extension = await database.extension.create({ data: { tenantId: tenant.id, extNumber: "101", displayName: "Test" } });
    const actor = { tenantId: tenant.id, sub: user.id };
    const mac = "80" + randomUUID().replace(/-/g, "").slice(0, 10);
    const sip = async () => ({ endpoint: "T21_101", username: "T21_101", authName: "T21_101", password: "test-only", server: "example.invalid", port: 5060, transport: "UDP", label: "101", displayName: "Test", blf: [] });
    const service = new ManagedPhoneService(new YealinkProvider(new DisabledRps()), database, sip, () => "https://example.invalid/api/phone-provisioning/", () => "");
    const input = { mac, model: "T53W", extensionId: extension.id };
    const results = await Promise.all([service.provision(actor, input, "one"), service.provision(actor, input, "two")]);
    assert.equal(results[0].id, results[1].id);
    assert.equal(await database.managedDeskPhone.count({ where: { macAddress: mac } }), 1);
    assert.equal(await database.auditLog.count({ where: { entityId: results[0].id, action: "MANAGED_PHONE_CREATED" } }), 1);
    const row = await database.managedDeskPhone.findUniqueOrThrow({ where: { macAddress: mac } });
    await assert.rejects(database.managedDeskPhone.create({ data: { ...row, id: randomUUID() } as any }), /Unique constraint/);
    const mac2 = "80" + randomUUID().replace(/-/g, "").slice(0, 10);
    await assert.rejects(service.provision({ tenantId: tenant.id, sub: "nonexistent-actor" }, { ...input, mac: mac2 }, "rollback"));
    assert.equal(await database.managedDeskPhone.count({ where: { macAddress: mac2 } }), 0, "audit FK failure rolls device creation back");
    assert.equal(await database.deskPhoneSetupPhone.count(), 0, "legacy setup table remains present and unchanged");
    await assert.rejects(database.managedDeskPhone.create({ data: { ...row, id: randomUUID(), macAddress: "invalid" } as any }));
    // Tenant erase must cascade, never be blocked by a managed phone.
    await database.auditLog.deleteMany({ where: { tenantId: tenant.id } });
    await database.user.delete({ where: { id: user.id } });
    await database.tenant.delete({ where: { id: tenant.id } });
    assert.equal(await database.managedDeskPhone.count({ where: { macAddress: mac } }), 0, "tenant delete cascades");
  } finally { await database.$disconnect(); }
});
