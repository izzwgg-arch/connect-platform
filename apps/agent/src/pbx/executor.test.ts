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

test("FEASIBILITY: live create-extension (helper-only) is refused — API has no such endpoint", async () => {
  const exec = makeExec();
  process.env.AGENT_PBX_LIVE_TENANTS = "21";
  // owned tenant + throwaway ext number (9001, not the protected 101)
  const res = await exec.execute({ opId: "P4", params: { tenantId: "21", extension: "9001", name: "R" }, requestedBy: "owner:izzy", mode: "live", ownerConfirmed: true });
  assert.equal(res.ok, false);
  assert.match(res.refusedReason!, /not available via the VitalPBX API|feasibility=helper/);
  delete process.env.AGENT_PBX_LIVE_TENANTS;
});

test("FEASIBILITY: live create-queue (api) passes feasibility but is fenced to pilot tenants", async () => {
  const exec = makeExec();
  const t = await exec.execute({ opId: "P1", params: { name: "T" }, requestedBy: "owner:izzy" });
  // No pilot allow-list set → live write refused (fail-closed).
  delete process.env.AGENT_PBX_LIVE_TENANTS;
  const fenced = await exec.execute({ opId: "P11", params: { tenantId: t.createdObjectId, name: "Support Q" }, requestedBy: "owner:izzy", mode: "live", ownerConfirmed: true });
  assert.equal(fenced.ok, false);
  assert.match(fenced.refusedReason!, /pilot allow-list|not in the pilot/);
});

test("PILOT FENCE: live write allowed only to allow-listed tenant (T21)", async () => {
  const exec = makeExec();
  // seed an owned tenant with id "21" so ownership passes; simulate mode for setup
  const t = await exec.execute({ opId: "P1", params: { name: "Landau Home" }, requestedBy: "owner:izzy" });
  process.env.AGENT_PBX_LIVE_TENANTS = "21";
  // wrong tenant → refused
  const wrong = await exec.execute({ opId: "P11", params: { tenantId: "8", name: "Q" }, requestedBy: "owner:izzy", mode: "live", ownerConfirmed: true });
  assert.equal(wrong.ok, false);
  assert.match(wrong.refusedReason!, /not in the pilot/);
  // right tenant (21) → passes the fence (queue is api-feasible)
  const right = await exec.execute({ opId: "P11", params: { tenantId: "21", name: "Q" }, requestedBy: "owner:izzy", mode: "live", ownerConfirmed: true });
  assert.equal(right.ok, true);
  delete process.env.AGENT_PBX_LIVE_TENANTS;
});

test("PROTECTED EXTENSION: live create of ext 101 (existing 'Home') is refused", async () => {
  const exec = makeExec();
  process.env.AGENT_PBX_LIVE_TENANTS = "21";
  process.env.AGENT_PBX_PROTECTED_EXTS = "101";
  // P4 create-extension by number — protected-ext gate fires before anything else.
  const res = await exec.execute({ opId: "P4", params: { tenantId: "21", extension: "101", name: "Should Not Happen" }, requestedBy: "owner:izzy", mode: "live", ownerConfirmed: true });
  assert.equal(res.ok, false);
  assert.match(res.refusedReason!, /protected extension/);
  delete process.env.AGENT_PBX_LIVE_TENANTS;
  delete process.env.AGENT_PBX_PROTECTED_EXTS;
});

test("live tenant-create refused unless explicitly enabled", async () => {
  const exec = makeExec();
  delete process.env.AGENT_PBX_LIVE_ALLOW_TENANT_CREATE;
  const res = await exec.execute({ opId: "P1", params: { name: "New Co" }, requestedBy: "owner:izzy", mode: "live", ownerConfirmed: true });
  assert.equal(res.ok, false);
  assert.match(res.refusedReason!, /tenant-create is not enabled/);
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
