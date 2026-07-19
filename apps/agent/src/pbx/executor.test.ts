import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScopedPbxExecutor, catalogHasNoDestructiveOps, type PbxClientLike } from "./executor";
import { PROVISIONING_CATALOG } from "./provisioning";
import { AuditLog, FileAuditSink } from "../audit/audit";

/** In-memory Prisma stand-in for agentPbxObject. */
class FakePrisma {
  rows: any[] = [];
  agentPbxObject = {
    create: async ({ data }: any) => {
      const row = { id: `led${this.rows.length + 1}`, ...data };
      this.rows.push(row);
      return row;
    },
    findFirst: async ({ where }: any) =>
      this.rows.find(
        (r) => r.pbxObjectType === where.pbxObjectType && r.pbxObjectId === where.pbxObjectId && r.state === where.state && r.simulated === where.simulated,
      ) ?? null,
  };
}

/** Records every call it receives so tests can assert what was dispatched. */
class SpyClient implements PbxClientLike {
  calls: any[] = [];
  constructor(private simulate: boolean) {}
  async callEndpointRaw(input: any) {
    this.calls.push(input);
    if (this.simulate) return { status: "success", data: { simulated: true } };
    return { status: "success", data: { id: `real_${Date.now()}` } };
  }
}

let prisma: FakePrisma;
let audit: AuditLog;
let lastClient: SpyClient | null;

beforeEach(async () => {
  prisma = new FakePrisma();
  const dir = await mkdtemp(path.join(tmpdir(), "pbx-exec-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
  lastClient = null;
});

function makeExec() {
  return new ScopedPbxExecutor(prisma as any, audit, (opts) => {
    lastClient = new SpyClient(opts.simulate);
    return lastClient;
  });
}

test("STATIC GUARD: catalog contains no PUT/DELETE/whole-tenant-write", () => {
  assert.equal(catalogHasNoDestructiveOps(), true);
});

test("STATIC GUARD: every catalog op is POST or PATCH only", () => {
  for (const op of Object.values(PROVISIONING_CATALOG)) {
    assert.ok(op.method === "POST" || op.method === "PATCH", `${op.id} method ${op.method}`);
  }
});

test("create tenant (sim) writes ledger, never contacts PBX for real", async () => {
  const exec = makeExec();
  const res = await exec.execute({ opId: "P1", params: { name: "Throwaway Test Tenant" }, requestedBy: "owner:izzy" });
  assert.equal(res.ok, true);
  assert.equal(res.mode, "simulate");
  assert.ok(res.createdObjectId?.startsWith("sim_tenant_"));
  assert.equal(prisma.rows.length, 1);
  assert.equal(prisma.rows[0].simulated, true);
  assert.equal(lastClient?.calls.length, 1);
});

test("unknown op is refused", async () => {
  const exec = makeExec();
  const res = await exec.execute({ opId: "P999", params: {}, requestedBy: "owner:izzy" });
  assert.equal(res.ok, false);
  assert.match(res.refusedReason!, /not dispatchable/);
});

test("apply_changes REFUSED for a tenant not in the ledger (pre-existing)", async () => {
  const exec = makeExec();
  const res = await exec.execute({ opId: "P3", params: { tenantId: "existing-tenant-8" }, requestedBy: "owner:izzy" });
  assert.equal(res.ok, false);
  assert.match(res.refusedReason!, /not in the Ownership Ledger/);
});

test("apply_changes ALLOWED only after the agent created that tenant", async () => {
  const exec = makeExec();
  const created = await exec.execute({ opId: "P1", params: { name: "Fresh Tenant" }, requestedBy: "owner:izzy" });
  const tenantId = created.createdObjectId!;
  const res = await exec.execute({ opId: "P3", params: { tenantId }, requestedBy: "owner:izzy" });
  assert.equal(res.ok, true);
});

test("extension_features REFUSED on a pre-existing extension", async () => {
  const exec = makeExec();
  const res = await exec.execute({ opId: "P6", params: { tenantId: "t", extensionId: "pre-existing-ext", features: { dnd: true } }, requestedBy: "owner:izzy" });
  assert.equal(res.ok, false);
  assert.match(res.refusedReason!, /not in the Ownership Ledger/);
});

test("creating a child object under a PRE-EXISTING tenant is refused without explicit confirm", async () => {
  const exec = makeExec();
  const res = await exec.execute({ opId: "P4", params: { tenantId: "existing-tenant-8", extension: "150", name: "New Hire" }, requestedBy: "owner:izzy" });
  assert.equal(res.ok, false);
  assert.match(res.refusedReason!, /changes an existing tenant/);
});

test("child object under a pre-existing tenant allowed WITH explicit ownerConfirmed", async () => {
  const exec = makeExec();
  const res = await exec.execute({ opId: "P4", params: { tenantId: "existing-tenant-8", extension: "150", name: "New Hire" }, requestedBy: "owner:izzy", ownerConfirmed: true });
  assert.equal(res.ok, true);
});

test("live mode requires ownerConfirmed", async () => {
  const exec = makeExec();
  const res = await exec.execute({ opId: "P1", params: { name: "X" }, requestedBy: "owner:izzy", mode: "live", ownerConfirmed: false });
  assert.equal(res.ok, false);
  assert.match(res.refusedReason!, /ownerConfirmed/);
});

test("bad params refused before any dispatch", async () => {
  const exec = makeExec();
  const res = await exec.execute({ opId: "P4", params: { tenantId: "t" /* missing extension+name */ }, requestedBy: "owner:izzy" });
  assert.equal(res.ok, false);
  assert.match(res.refusedReason!, /Invalid params/);
  assert.equal(lastClient, null); // never constructed a client
});

test("inbound DID add uses PATCH sub-collection, never a tenant PUT", async () => {
  const exec = makeExec();
  // must be an owned tenant first
  const t = await exec.execute({ opId: "P1", params: { name: "T" }, requestedBy: "owner:izzy" });
  const res = await exec.execute({ opId: "P2", params: { tenantId: t.createdObjectId, phone_number: "+18455551212" }, requestedBy: "owner:izzy" });
  assert.equal(res.ok, true);
  const call = lastClient!.calls[0];
  assert.equal(call.method, "PATCH");
  assert.match(call.path, /inbound_numbers$/);
});
