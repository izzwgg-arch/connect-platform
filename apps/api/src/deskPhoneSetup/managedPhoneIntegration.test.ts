import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { decryptJson } from "@connect/security";
import { RpsSimulator, sip } from "./yealinkRpsSimulator";
import { DisabledRps } from "./yealinkRps";
import { shouldSkipJwtVerification } from "../jwtPublicRouteBypass";

mock.module("@connect/db", { namedExports: { db: {} } });
mock.module("../permissionGates", { namedExports: { userHasActionPermission: async (user: any) => user.role === "ADMIN" } });
const { ManagedPhoneService, YealinkProvider, validPhoneAuthorization } = require("./managedPhoneService");
const { registerManagedPhoneRoutes } = require("./managedPhoneRoutes");
const { registrationEvidence } = require("./managedPhonePbx");
process.env.CREDENTIALS_MASTER_KEY = "ab".repeat(32); // ephemeral test key, never a deployed secret

function memoryDatabase() {
  let rows: any[] = [], audits: any[] = []; let tail = Promise.resolve(); let seq = 0;
  const registrations = new Map<string, any>();
  const matches = (r: any, where: any) => Object.entries(where || {}).every(([k, v]) => r[k] === v);
  const table = {
    findUnique: async ({ where }: any) => rows.find(r => matches(r, where)) || null,
    findFirst: async ({ where }: any) => rows.find(r => matches(r, where)) || null,
    findMany: async ({ where }: any) => rows.filter(r => matches(r, where)),
    create: async ({ data }: any) => {
      assert.ok(!rows.some(r => r.macAddress === data.macAddress), "global unique MAC");
      if (data.replacesId) assert.ok(!rows.some(r => r.replacesId === data.replacesId), "single replacement");
      const row = { id: `device-${++seq}`, configVersion: 1, rpsState: "pending_credentials", lastSeenAt: null,
        lastProvisionedAt: null, servedVersion: null, retiredAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(row); return row;
    },
    update: async ({ where, data }: any) => {
      const row = rows.find(r => matches(r, where)); assert.ok(row);
      for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = typeof v === "object" && v && "increment" in v ? row[k] + (v as any).increment : v;
      return row;
    },
    updateMany: async ({ where, data }: any) => { const found = rows.filter(r => matches(r, where)); found.forEach(r => Object.assign(r, data)); return { count: found.length }; },
  };
  const database: any = { managedDeskPhone: table, pbxEndpointRegistration: { findUnique: async ({ where }: any) => registrations.get(where.endpoint) || null },
    auditLog: { create: async ({ data }: any) => { audits.push(data); return data; } }, $queryRaw: async () => [] };
  database.$transaction = async (fn: any) => {
    const prev = tail; let unlock!: () => void; tail = new Promise<void>(r => { unlock = r; }); await prev;
    const backup = structuredClone(rows), auditBackup = structuredClone(audits);
    try { return await fn(database); } catch (e) { rows = backup; audits = auditBackup; throw e; } finally { unlock(); }
  };
  return { database, rows: () => rows, audits: () => audits, registrations };
}
const actor = { tenantId: "tenant-a", sub: "admin" };
const input = { mac: "805ec0112233", serialNumber: "SN-INT-0001", model: "T53W", extensionId: "extension-101" };
const base = () => "https://app.example.com/api/phone-provisioning/";
async function fixture(live = true) {
  const memory = memoryDatabase(), rps = new RpsSimulator();
  const load = async (tenantId: string, extensionId: string) => {
    if (tenantId !== actor.tenantId || !["extension-101", "extension-102"].includes(extensionId)) throw new (await import("./yealinkRps")).DeviceError("extension_not_found", 404);
    return { ...sip, endpoint: extensionId === "extension-101" ? "T21_101" : "T21_102" };
  };
  const service = new ManagedPhoneService(new YealinkProvider(live ? rps.client() : new DisabledRps()), memory.database, load, base, () => "server");
  return { ...memory, rps, service };
}
test("existing extension → device → config → RPS → check-in → PBX evidence (fakes, no handset claim)", async () => {
  const f = await fixture();
  const result = await f.service.provision(actor, input, "request-1");
  assert.equal(result.rpsState, "assigned"); assert.notEqual(result.registrationState, "online");
  const row = f.rows()[0]; const secrets = decryptJson<any>(row.secretsEncrypted);
  assert.ok(!JSON.stringify(result).includes(secrets.adminPassword));
  const auth = `Basic ${Buffer.from(`${row.macAddress}:${secrets.provisioningPassword}`).toString("base64")}`;
  const config: any = await f.service.configuration(row.macAddress, `${row.macAddress}.cfg`, auth, "download", "192.0.2.1", "Yealink T53W");
  assert.match(config.config, /account.1.password = canonical-secret/);
  assert.equal(row.servedVersion, null, "generation is not delivery");
  await f.service.served(config, "download");
  f.registrations.set(row.endpoint, { endpoint: row.endpoint, tenantId: row.tenantId, extensionId: row.extensionId, status: "REGISTERED", lastEventAt: new Date(), userAgent: "Yealink T53W 80:5e:c0:11:22:33" });
  assert.equal((await f.service.detail(actor, row.id)).registrationState, "online");
  const auditText = JSON.stringify(f.audits());
  for (const secret of [sip.password, secrets.adminPassword, secrets.provisioningPassword]) assert.ok(!auditText.includes(secret));
});
test("same MAC concurrent claims converge; cross-tenant access and claim refuse", async () => {
  const f = await fixture();
  const results = await Promise.all([f.service.provision(actor, input, "a"), f.service.provision(actor, input, "b")]);
  assert.equal(results[0].id, results[1].id); assert.equal(f.rows().length, 1);
  const other = { tenantId: "other", sub: "other" };
  await assert.rejects(f.service.provision(other, input, "c"), /ownership_conflict/);
  await assert.rejects(f.service.detail(other, results[0].id), /device_not_found/);
  await assert.rejects(f.service.update(other, results[0].id, {}, "c"), /device_not_found/);
  await assert.rejects(f.service.release(other, results[0].id, "c"), /device_not_found/);
  await assert.rejects(f.service.retire(other, results[0].id, "c"), /device_not_found/);
});
test("RPS timeout preserves encrypted credentials and retries read back remote success", async () => {
  const f = await fixture(); f.rps.failNext = "timeout_after_add";
  const first = await f.service.provision(actor, input, "a");
  assert.equal(first.rpsState, "failed"); const envelope = f.rows()[0].secretsEncrypted;
  const second = await f.service.provision(actor, input, "b");
  assert.equal(second.rpsState, "assigned"); assert.equal(f.rows()[0].secretsEncrypted, envelope);
  assert.equal(f.rps.calls.filter(c => c === "rps/devices").length, 1);
});
test("disabled RPS records pending credentials and never claims assignment", async () => {
  const f = await fixture(false); const d = await f.service.provision(actor, input, "a");
  assert.equal(d.rpsState, "pending_credentials"); assert.equal(f.rps.calls.length, 0);
  await assert.rejects(f.service.release(actor, d.id, "a"), /credentials_required/);
});
test("unauthorized or mismatched config path never returns credentials", async () => {
  const f = await fixture(); const d = await f.service.provision(actor, input, "a");
  await assert.rejects(f.service.configuration(d.mac, `${d.mac}.cfg`, undefined, "a", "", ""), /authentication_required/);
  assert.equal(validPhoneAuthorization("Basic " + Buffer.from("other:secret").toString("base64"), d.mac, "secret"), false);
  const secret = decryptJson<any>(f.rows()[0].secretsEncrypted);
  const auth = "Basic " + Buffer.from(`${d.mac}:${secret.provisioningPassword}`).toString("base64");
  await assert.rejects(f.service.configuration(d.mac, "805ec0112234.cfg", auth, "a", "", ""), /configuration_not_found/);
});
test("move validates tenant extension; download of old version cannot verify the new one", async () => {
  const f = await fixture(); const d = await f.service.provision(actor, input, "a");
  await assert.rejects(f.service.update(actor, d.id, { extensionId: "foreign" }, "a"), /extension_not_found/);
  await f.service.update(actor, d.id, { extensionId: "extension-102" }, "b");
  await f.service.served({ id: d.id, tenantId: actor.tenantId, version: 1 }, "old");
  const next = await f.service.detail(actor, d.id); assert.equal(next.configVersion, 2); assert.equal(next.servedVersion, null);
  assert.equal(f.rows().length, 1);
});
test("replacement failure preserves old phone; only MAC-specific registration permits completion", async () => {
  const f = await fixture(); const old = await f.service.provision(actor, input, "a");
  const next = await f.service.provision(actor, { ...input, mac: "805ec0112234", replacesId: old.id }, "b");
  await assert.rejects(f.service.completeReplacement(actor, next.id, "c"), /replacement_not_verified/);
  assert.equal(f.rows().find(r => r.id === old.id).retiredAt, null);
  const row = f.rows().find(r => r.id === next.id);
  row.servedVersion = row.configVersion; row.lastProvisionedAt = new Date();
  f.registrations.set(row.endpoint, { endpoint: row.endpoint, tenantId: actor.tenantId, extensionId: row.extensionId, status: "REGISTERED", lastEventAt: new Date(), userAgent: "Yealink T53W 80:5e:c0:11:22:33" });
  await assert.rejects(f.service.completeReplacement(actor, next.id, "c"), /replacement_not_verified/);
  f.registrations.get(row.endpoint).userAgent = "Yealink T53W 80:5e:c0:11:22:34";
  await f.service.completeReplacement(actor, next.id, "d");
  assert.ok(f.rows().find(r => r.id === old.id).retiredAt); assert.ok(!f.rps.devices.has(old.mac));
});
test("attested replacement needs a post-delivery registration; attestation alone never retires the old phone", async () => {
  const f = await fixture(); const old = await f.service.provision(actor, input, "a");
  const next = await f.service.provision(actor, { ...input, mac: "805ec0112234", replacesId: old.id }, "b");
  await assert.rejects(f.service.completeReplacement(actor, next.id, "c", true), /replacement_not_verified/);
  const row = f.rows().find(r => r.id === next.id);
  row.servedVersion = row.configVersion; row.lastProvisionedAt = new Date(Date.now() - 1000);
  f.registrations.set(row.endpoint, { endpoint: row.endpoint, tenantId: actor.tenantId, extensionId: row.extensionId, status: "REGISTERED", lastEventAt: new Date(), userAgent: "Yealink SIP-T53W 96.86.0.100" });
  await assert.rejects(f.service.completeReplacement(actor, next.id, "c"), /replacement_not_verified/, "no MAC and no attestation");
  await f.service.completeReplacement(actor, next.id, "d", true);
  assert.ok(f.rows().find(r => r.id === old.id).retiredAt);
  assert.ok(f.audits().some(a => a.action === "MANAGED_PHONE_REPLACEMENT_COMPLETED" && a.metadata.attestedWorking === true));
});
/* ── claimForOfficeWizard: the office wizard's own front door onto RPS ────────── */

const REDIRECT = "https://loopcom.net/phoneprov/0123456789abcdef/";
const officeInput = { mac: "805ec0334455", serialNumber: "SN-OFFICE-0001", model: "T53W", extensionId: "extension-101" };

async function officeFixture(live = true, tenants: string[] = [actor.tenantId]) {
  const memory = memoryDatabase(), rps = new RpsSimulator();
  const load = async (tenantId: string, extensionId: string) => {
    if (!tenants.includes(tenantId) || !["extension-101", "extension-102"].includes(extensionId))
      throw new (await import("./yealinkRps")).DeviceError("extension_not_found", 404);
    return { ...sip, endpoint: `T${21 + tenants.indexOf(tenantId)}_${extensionId === "extension-101" ? "101" : "102"}` };
  };
  const service = new ManagedPhoneService(new YealinkProvider(live ? rps.client() : new DisabledRps()), memory.database, load, base, () => "server");
  return { ...memory, rps, service };
}

test("claimForOfficeWizard: creates a row and assigns it via RPS at the redirect URL", async () => {
  const f = await officeFixture();
  const result = await f.service.claimForOfficeWizard(actor, { ...officeInput, redirectUrl: REDIRECT }, "office-1");
  assert.equal(result.rpsState, "assigned");
  assert.equal(result.conflict, false);
  const row = f.rows()[0];
  assert.equal(row.tenantId, actor.tenantId);
  assert.equal(row.serialNumber, officeInput.serialNumber);
  assert.equal((row.options as any).source, "office_wizard");
  assert.equal((row.options as any).redirectUrl, REDIRECT);
  const rpsRow = [...f.rps.devices.values()][0];
  assert.equal(rpsRow.uniqueServerUrl, REDIRECT, "RPS was told to redirect to the TENANT'S folder, not this service's own route");
  assert.equal(rpsRow.authName, row.macAddress);
});

test("claimForOfficeWizard: refuses any redirect URL that is not one of our own phoneprov folders", async () => {
  const f = await officeFixture();
  await assert.rejects(f.service.claimForOfficeWizard(actor, { ...officeInput, redirectUrl: "https://evil.example.com/x" }, "a"), /redirect_url_invalid/);
  await assert.rejects(f.service.claimForOfficeWizard(actor, { ...officeInput, redirectUrl: "http://loopcom.net/phoneprov/0123456789abcdef/" }, "b"), /redirect_url_invalid/, "https only");
  await assert.rejects(f.service.claimForOfficeWizard(actor, { ...officeInput, redirectUrl: "https://loopcom.net.evil.com/phoneprov/0123456789abcdef/" }, "c"), /redirect_url_invalid/, "dot-boundary host match only, never a substring");
  await assert.rejects(f.service.claimForOfficeWizard(actor, { ...officeInput, redirectUrl: "https://loopcom.net/phoneprov/0123456789abcdef/?x=1" }, "d"), /redirect_url_invalid/, "no query string");
  await assert.rejects(f.service.claimForOfficeWizard(actor, { ...officeInput, redirectUrl: "https://loopcom.net/some/other/path/" }, "e"), /redirect_url_invalid/, "the exact /phoneprov/<16 hex>/ shape only");
  assert.equal(f.rows().length, 0, "an invalid URL is refused before any row is ever written");
});

test("claimForOfficeWizard: idempotent for the same tenant — no re-write and no extra RPS add when nothing changed", async () => {
  const f = await officeFixture();
  const first = await f.service.claimForOfficeWizard(actor, { ...officeInput, redirectUrl: REDIRECT }, "a");
  const addsAfterFirst = f.rps.calls.filter((c) => c === "rps/devices").length;
  const second = await f.service.claimForOfficeWizard(actor, { ...officeInput, redirectUrl: REDIRECT }, "b");
  assert.equal(second.id, first.id);
  assert.equal(f.rows().length, 1);
  // reconcile() still runs (cheap, idempotent read-back through checkMac/listDevices),
  // but never a second rps/devices ADD for exactly the same claim.
  assert.equal(f.rps.calls.filter((c) => c === "rps/devices").length, addsAfterFirst);
});

test("claimForOfficeWizard: cross-tenant WITH the presence pair rehomes, releases the old RPS assignment, and audits both tenant ids", async () => {
  const f = await officeFixture(true, [actor.tenantId, "tenant-b"]);
  const first = await f.service.claimForOfficeWizard(actor, { ...officeInput, redirectUrl: REDIRECT }, "a");
  assert.equal(first.rpsState, "assigned");
  const otherActor = { tenantId: "tenant-b", sub: "admin-b" };
  const moved = await f.service.claimForOfficeWizard(otherActor, {
    ...officeInput, extensionId: "extension-102", redirectUrl: REDIRECT,
    presence: { discoveredIp: "192.168.1.50", requesterIp: "203.0.113.9" },
  }, "b");
  assert.equal(moved.id, first.id, "macAddress is globally unique — the one row is reused, never a second one");
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].tenantId, "tenant-b");
  assert.equal(moved.rpsState, "assigned");
  assert.equal(moved.conflict, false);
  const audit = f.audits().find((a: any) => a.action === "MANAGED_PHONE_REHOMED_BY_OFFICE_WIZARD");
  assert.ok(audit, "the rehome is audited");
  assert.equal(audit.metadata.fromTenantId, actor.tenantId);
  assert.equal(audit.metadata.toTenantId, "tenant-b");
});

test("claimForOfficeWizard: cross-tenant WITHOUT the presence pair is a conflict, never a silent move", async () => {
  const f = await officeFixture(true, [actor.tenantId, "tenant-b"]);
  await f.service.claimForOfficeWizard(actor, { ...officeInput, redirectUrl: REDIRECT }, "a");
  const otherActor = { tenantId: "tenant-b", sub: "admin-b" };
  await assert.rejects(
    f.service.claimForOfficeWizard(otherActor, { ...officeInput, extensionId: "extension-102", redirectUrl: REDIRECT }, "b"),
    /device_ownership_conflict/,
  );
  await assert.rejects(
    f.service.claimForOfficeWizard(otherActor, {
      ...officeInput, extensionId: "extension-102", redirectUrl: REDIRECT,
      presence: { discoveredIp: "192.168.1.50", requesterIp: null },
    }, "c"),
    /device_ownership_conflict/,
    "half a presence pair is not a presence pair",
  );
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].tenantId, actor.tenantId, "still the original owner — nothing moved");
  assert.ok(!f.audits().some((a: any) => a.action === "MANAGED_PHONE_REHOMED_BY_OFFICE_WIZARD"));
});

test("claimForOfficeWizard: disabled RPS records pending_credentials, never a false conflict", async () => {
  const f = await officeFixture(false);
  const result = await f.service.claimForOfficeWizard(actor, { ...officeInput, redirectUrl: REDIRECT }, "a");
  assert.equal(result.rpsState, "pending_credentials");
  assert.equal(result.conflict, false);
  assert.equal(f.rps.calls.length, 0);
});

test("claimForOfficeWizard: a MAC already claimed by ANOTHER RPS account (Izzy's T42S, 800004) surfaces as a recorded conflict, never a throw", async () => {
  const f = await officeFixture();
  f.rps.foreign.add(officeInput.mac);
  const result = await f.service.claimForOfficeWizard(actor, { ...officeInput, redirectUrl: REDIRECT }, "a");
  assert.equal(result.rpsState, "conflict");
  assert.equal(result.conflict, true);
  assert.equal(result.lastError, "rps_ownership_conflict");
  // The row is still bookkept — the maker refused, not us.
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].tenantId, actor.tenantId);
});

test("handset source IP is the LAST X-Forwarded-For entry, never a spoofed first one", () => {
  const { handsetSourceIp } = require("./managedPhoneRoutes");
  assert.equal(handsetSourceIp({ headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" }, ip: "172.19.0.1" }), "203.0.113.9");
  assert.equal(handsetSourceIp({ headers: {}, ip: "172.19.0.1" }), "172.19.0.1");
  assert.equal(handsetSourceIp({ headers: { "x-forwarded-for": "<script>" }, ip: "" }), "");
});
test("PBX stale, wrong-tenant, app endpoint and model-only evidence never mean online", () => {
  const d = { tenantId: "t", extensionId: "e", endpoint: "T21_101", macAddress: input.mac, configVersion: 1, servedVersion: 1, lastProvisionedAt: new Date(1) };
  const row = { tenantId: "t", extensionId: "e", endpoint: "T21_101", status: "REGISTERED", lastEventAt: new Date(), userAgent: "Yealink T53W" };
  assert.notEqual(registrationEvidence(d, row), "online");
  for (const bad of [{ ...row, tenantId: "other" }, { ...row, isWebrtcDevice: true }, { ...row, lastEventAt: new Date(0) }]) assert.notEqual(registrationEvidence(d, bad), "online");
});
test("real Fastify route path: authorization, tenant body injection, file gate and delivery tracking", async () => {
  const f = await fixture(); const app = Fastify();
  app.addHook("preHandler", async (req: any, reply) => {
    if (!shouldSkipJwtVerification(req.url)) {
      if (!req.headers.authorization) return reply.code(401).send({ error: "unauthorized" });
      req.user = { ...actor, role: req.headers.authorization === "Bearer admin" ? "ADMIN" : "USER" };
    }
  });
  await registerManagedPhoneRoutes(app, f.service);
  try {
    assert.equal((await app.inject({ method: "GET", url: "/desk-phones/managed" })).statusCode, 401);
    const headers = { authorization: "Bearer admin" };
    assert.equal((await app.inject({ method: "POST", url: "/desk-phones/managed", headers, payload: { ...input, tenantId: "other" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/desk-phones/managed", headers: { authorization: "Bearer user" }, payload: input })).statusCode, 403);
    const created = await app.inject({ method: "POST", url: "/desk-phones/managed", headers, payload: input });
    assert.equal(created.statusCode, 200, created.body);
    const url = `/phone-provisioning/${input.mac}/${input.mac}.cfg`;
    assert.equal((await app.inject({ url, headers: { "x-forwarded-proto": "https" } })).statusCode, 401);
    const secret = decryptJson<any>(f.rows()[0].secretsEncrypted);
    const cfg = await app.inject({ url, headers: { "x-forwarded-proto": "https", authorization: "Basic " + Buffer.from(`${input.mac}:${secret.provisioningPassword}`).toString("base64") } });
    assert.equal(cfg.statusCode, 200, cfg.body); assert.match(cfg.headers["cache-control"] as string, /no-store/);
    assert.match(cfg.body, /canonical-secret/);
  } finally { await app.close(); }
});
test("JWT exception is restricted to handset filenames, never management routes", () => {
  assert.equal(shouldSkipJwtVerification(`/api/phone-provisioning/${input.mac}/${input.mac}.cfg`), true);
  for (const path of ["/desk-phones/managed", "/api/desk-phones/managed", `/phone-provisioning/${input.mac}/../../admin`, `/x/phone-provisioning/${input.mac}/${input.mac}.cfg`]) assert.equal(shouldSkipJwtVerification(path), false);
});
