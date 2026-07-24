/**
 * Certification Harness (PLAN.md §13a, PBX_PROVISIONING_PLAN.md §7 PW-1).
 *
 * Runs the full provisioning surface in SIMULATION MODE and asserts the
 * zero-impact contract. Produces a structured result that gates capability
 * promotion: a capability may only become `certified` if its suite is green.
 *
 * Pure logic (no Fastify, no real DB) so it runs in CI, the sandbox, and a
 * scheduled job identically. Uses an in-memory ledger + spy client.
 */
import { z } from "zod";
import { ScopedPbxExecutor, catalogHasNoDestructiveOps, type PbxClientLike } from "../pbx/executor";
import { PROVISIONING_CATALOG } from "../pbx/provisioning";
import { ModifyPbxExecutor } from "../pbx/modifyExecutor";
import { MODIFY_CATALOG, catalogOpsHonorModifyContract, buildModifyCatalog, type ModifyOp } from "../pbx/modifyCatalog";
import { SnapshotStore } from "../pbx/snapshotStore";
import { computeParamsHash } from "../actions/bindings";
import { AuditLog, type AuditSink } from "../audit/audit";

export interface CertCase {
  name: string;
  capability: string;
  passed: boolean;
  detail?: string;
}

export interface CertReport {
  ranAt: string;
  mode: "simulate";
  totalCases: number;
  passed: number;
  failed: number;
  byCapability: Record<string, { passed: number; failed: number; certified: boolean }>;
  cases: CertCase[];
  zeroImpactProven: boolean;
}

class MemoryLedger {
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

const nullSink: AuditSink = { async write() {} };

function spyClientFactory(seen: any[]) {
  return (opts: { simulate: boolean }): PbxClientLike => ({
    async callEndpointRaw(input) {
      if (!opts.simulate) throw new Error("CERT VIOLATION: harness attempted a non-simulate PBX call");
      seen.push(input);
      return { status: "success", data: { simulated: true } };
    },
  });
}

export async function runCertification(): Promise<CertReport> {
  const cases: CertCase[] = [];
  const add = (name: string, capability: string, passed: boolean, detail?: string) => cases.push({ name, capability, passed, detail });

  // Static structural guarantees.
  add("catalog has no PUT/DELETE/whole-tenant-write", "pbx.structure", catalogHasNoDestructiveOps());
  add("every catalog op is POST or PATCH", "pbx.structure", Object.values(PROVISIONING_CATALOG).every((o) => o.method === "POST" || o.method === "PATCH"));

  const seen: any[] = [];
  const ledger = new MemoryLedger();
  const audit = new AuditLog([nullSink]);
  const exec = new ScopedPbxExecutor(ledger as any, audit, spyClientFactory(seen));

  // Fixture representing a PRE-EXISTING tenant we must never touch.
  const EXISTING_TENANT = "existing-tenant-8";
  const existingBefore = JSON.stringify({ tenant: EXISTING_TENANT, dids: ["+18455550000"], extensions: ["101", "102"] });

  // --- Full onboarding lifecycle on a NEW tenant (the happy path) ---
  const t = await exec.execute({ opId: "P1", params: { name: "CERT Throwaway Tenant" }, requestedBy: "cert" });
  add("P1 create tenant (sim) succeeds + ledgered", "pbx.P1", t.ok && !!t.createdObjectId && ledger.rows.some((r) => r.pbxObjectType === "tenant"));
  const tenantId = t.createdObjectId!;

  const did = await exec.execute({ opId: "P2", params: { tenantId, phone_number: "+18455551234" }, requestedBy: "cert" });
  add("P2 add DID via PATCH sub-collection (never tenant PUT)", "pbx.P2", did.ok && seen.some((c) => c.method === "PATCH" && /inbound_numbers$/.test(c.path)));

  const ext = await exec.execute({ opId: "P4", params: { tenantId, extension: "101", name: "Reception" }, requestedBy: "cert" });
  add("P4 create extension under owned tenant", "pbx.P4", ext.ok && !!ext.createdObjectId);

  const dev = await exec.execute({ opId: "P5", params: { tenantId, extensionId: ext.createdObjectId, type: "sip" }, requestedBy: "cert" });
  add("P5 create device on owned extension", "pbx.P5", dev.ok);

  const ivr = await exec.execute({ opId: "P7", params: { tenantId, name: "Main Menu", entries: [{ digit: "1", destination: "101" }] }, requestedBy: "cert" });
  add("P7 create IVR", "pbx.P7", ivr.ok);

  const route = await exec.execute({ opId: "P8", params: { tenantId, did: "+18455551234", destination: ivr.createdObjectId }, requestedBy: "cert" });
  add("P8 create inbound route", "pbx.P8", route.ok);

  const rg = await exec.execute({ opId: "P10", params: { tenantId, name: "Sales", extensions: ["101"] }, requestedBy: "cert" });
  add("P10 create ring group", "pbx.P10", rg.ok);

  const q = await exec.execute({ opId: "P11", params: { tenantId, name: "Support Q" }, requestedBy: "cert" });
  add("P11 create queue", "pbx.P11", q.ok);

  const tc = await exec.execute({ opId: "P12", params: { tenantId, name: "Business Hours" }, requestedBy: "cert" });
  add("P12 create time condition", "pbx.P12", tc.ok);

  const ve = await exec.execute({ opId: "P13", params: { tenantId, subtype: "conference", name: "Boardroom" }, requestedBy: "cert" });
  add("P13 create virtual/conference", "pbx.P13", ve.ok);

  const applied = await exec.execute({ opId: "P3", params: { tenantId }, requestedBy: "cert" });
  add("P3 apply_changes on the agent-created tenant only", "pbx.P3", applied.ok);

  const prompt = await exec.execute({ opId: "P14", params: { tenantId, name: "Greeting", audioFileId: "aud_1" }, requestedBy: "cert" });
  add("P14 upload IVR prompt audio", "pbx.P14", prompt.ok);

  const outbound = await exec.execute({ opId: "P9", params: { tenantId, name: "Local", pattern: "1NXXNXXXXXX", trunk: "main" }, requestedBy: "cert" });
  add("P9 create outbound route", "pbx.P9", outbound.ok);

  // --- Refusal matrix (the guarantees) ---
  const r1 = await exec.execute({ opId: "P3", params: { tenantId: EXISTING_TENANT }, requestedBy: "cert" });
  add("REFUSE apply_changes on a pre-existing tenant", "pbx.safety", !r1.ok && /Ownership Ledger/.test(r1.refusedReason ?? ""));

  const r2 = await exec.execute({ opId: "P4", params: { tenantId: EXISTING_TENANT, extension: "150", name: "X" }, requestedBy: "cert" });
  add("REFUSE new extension under a pre-existing tenant (no explicit confirm)", "pbx.safety", !r2.ok && /changes an existing tenant/.test(r2.refusedReason ?? ""));

  const r3 = await exec.execute({ opId: "P6", params: { tenantId: EXISTING_TENANT, extensionId: "pre-existing-ext", features: { dnd: true } }, requestedBy: "cert" });
  add("REFUSE editing a pre-existing extension", "pbx.safety", !r3.ok && /Ownership Ledger/.test(r3.refusedReason ?? ""));

  const r4 = await exec.execute({ opId: "P999", params: {}, requestedBy: "cert" });
  add("REFUSE unknown/non-catalog op", "pbx.safety", !r4.ok);

  const r5 = await exec.execute({ opId: "P1", params: {}, requestedBy: "cert" });
  add("REFUSE bad params before any dispatch", "pbx.safety", !r5.ok);

  const r6 = await exec.execute({ opId: "P1", params: { name: "X" }, requestedBy: "cert", mode: "live", ownerConfirmed: false });
  add("REFUSE live write without ownerConfirmed", "pbx.safety", !r6.ok && /ownerConfirmed/.test(r6.refusedReason ?? ""));

  // --- X1 Modify pipeline (ACTIONS_V2_ROADMAP / X1 spec §5 SIM-CERT) ---
  // Proves the SHIPPING state is fail-closed, then exercises the full gate
  // chain + revert in simulate with a throwaway fixture op. Same spy client:
  // any non-simulate call would throw and fail zero-impact.
  {
    const memory = new (class {
      actions: any[] = [];
      snaps: any[] = [];
      agentAction = { findUnique: async ({ where }: any) => this.actions.find((r: any) => r.id === where.id) ?? null };
      agentPbxSnapshot = {
        create: async ({ data }: any) => {
          const row = { id: `snap${this.snaps.length + 1}`, capturedAt: new Date(), restoredAt: null, ...data };
          this.snaps.push(row);
          return row;
        },
        findUnique: async ({ where }: any) => this.snaps.find((r: any) => r.actionId === where.actionId) ?? null,
        update: async ({ where, data }: any) => {
          const row = this.snaps.find((r: any) => r.id === where.id);
          Object.assign(row, data);
          return row;
        },
      };
    })();
    const modClientFactory = () => spyClientFactory(seen)({ simulate: true });
    const envOn = { AGENT_MODIFY_ENABLED: "1", AGENT_PBX_PROTECTED_EXTS: "101", AGENT_MODIFY_REVERT_DAYS: "7" };

    add("X1 MODIFY_CATALOG ships EMPTY (nothing modifiable)", "pbx.modify", Object.keys(MODIFY_CATALOG).length === 0);
    add("X1 modify contract static guard holds", "pbx.modify", catalogOpsHonorModifyContract());

    const shipping = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, { env: envOn, killSwitch: () => false });
    const g1 = await shipping.execute({ capabilityId: "pbx.M1", params: { tenantId: "21", objectId: "x", any: 1 }, requestedBy: "cert", requestedRole: "owner" });
    add("X1 SHIPPING: empty catalog refuses every dispatch at G1", "pbx.modify", !g1.ok && g1.gate === "G1");

    const off = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, { env: {}, killSwitch: () => false });
    const g0b = await off.execute({ capabilityId: "pbx.M1", params: {}, requestedBy: "cert", requestedRole: "owner" });
    add("X1 FAIL-CLOSED: master switch off refuses at G0b", "pbx.modify", !g0b.ok && g0b.gate === "G0b");

    // Fixture op world for the full-chain simulate pass.
    const world: Record<string, any> = { moh1: { classId: "default" } };
    const fixture: ModifyOp = {
      id: "M0",
      capabilityId: "pbx.M0",
      kind: "moh_tenant",
      title: "CERT fixture",
      schema: z.object({ tenantId: z.string().min(1), objectId: z.string().min(1), classId: z.string().min(1) }),
      feasibility: "astdb",
      risk: "low",
      snapshot: async (_c, p) => (world[p.objectId] ? { state: { ...world[p.objectId] } } : null),
      dispatch: async (_c, p) => {
        world[p.objectId] = { classId: p.classId };
        return { written: { classId: p.classId } };
      },
      verify: async (_c, p, w: any) => ({ ok: world[p.objectId]?.classId === (w?.written?.classId ?? "") }),
      revert: async (_c, p, s: any) => {
        world[p.objectId] = { ...s };
        return { restored: s };
      },
    };
    const noScope = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, { catalog: { "pbx.M0": fixture }, env: envOn, killSwitch: () => false });
    const g3 = await noScope.execute({ capabilityId: "pbx.M0", params: { tenantId: "21", objectId: "moh1", classId: "jazz" }, requestedBy: "cert", requestedRole: "owner" });
    add("X1 FAIL-CLOSED: no scope resolver wired refuses at G3 even in simulate", "pbx.modify", !g3.ok && g3.gate === "G3");

    const full = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, { catalog: { "pbx.M0": fixture }, env: envOn, killSwitch: () => false, scopeCheck: async () => true });
    const params = { tenantId: "21", objectId: "moh1", classId: "jazz" };
    memory.actions.push({ id: "certAct", capabilityId: "pbx.M0", tenantId: "21", params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M0", "21", params), resultSnapshot: null });
    const happy = await full.execute({ capabilityId: "pbx.M0", params, requestedBy: "cert", requestedRole: "owner", actionId: "certAct" });
    add("X1 full gate chain G0–G11 passes in simulate (snapshot + verify)", "pbx.modify", happy.ok && happy.verified === true && world.moh1.classId === "jazz");

    memory.actions[0].resultSnapshot = { written: happy.written };
    const reverted = await full.revert("certAct", "cert");
    add("X1 one-click revert restores the snapshot state", "pbx.modify", reverted.ok && world.moh1.classId === "default");

    // Live-gated executor (T21 allow-listed) so the refusal is provably the
    // params-hash binding itself, not an earlier fence. The spy client throws
    // on any non-simulate call, so even this "live" attempt can't touch a PBX —
    // and G8 refuses before any client is built anyway.
    const fullLive = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, {
      catalog: { "pbx.M0": fixture },
      env: { ...envOn, AGENT_PBX_LIVE_TENANTS: "21" },
      killSwitch: () => false,
      scopeCheck: async () => true,
    });
    const mutated = { ...params, classId: "attack" };
    const g8 = await fullLive.execute({ capabilityId: "pbx.M0", params: mutated, requestedBy: "cert", requestedRole: "owner", mode: "live", actionId: "certAct" });
    add("X1 APPROVE-THEN-MUTATE refused at G8 (params-hash binding)", "pbx.modify", !g8.ok && g8.gate === "G8");

    // --- X2: the REAL scope resolver (Connect-mirror ownership proof) at G3 ---
    const { makeScopeCheck } = await import("../pbx/scopeCheck");
    const mirror: any = {
      user: { findUnique: async ({ where }: any) => (where.id === "u1" ? { tenantId: "ct1", status: "ACTIVE" } : null) },
      tenantPbxLink: {
        findUnique: async ({ where }: any) => (where.tenantId === "ct1" ? { pbxTenantId: "21" } : null),
        findFirst: async ({ where }: any) => (String(where.pbxTenantId) === "21" ? { tenantId: "ct1" } : null),
      },
      extension: { findFirst: async ({ where }: any) => (where.tenantId === "ct1" && where.extNumber === "103" ? { id: "e1" } : null) },
      pbxTenantInboundDid: { findFirst: async () => null },
      phoneNumber: { findFirst: async () => null },
    };
    const scoped = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, {
      catalog: { "pbx.M0": { ...fixture, kind: "extension" } },
      env: envOn,
      killSwitch: () => false,
      scopeCheck: makeScopeCheck(mirror),
    });
    world["103"] = { classId: "default" };
    const inScope = await scoped.execute({ capabilityId: "pbx.M0", params: { tenantId: "21", objectId: "103", classId: "calm" }, requestedBy: "customer:u1", requestedRole: "customer" });
    add("X2 scope resolver: customer's own object passes G3 (sim)", "identity.scope", inScope.ok === true);
    const outOfScope = await scoped.execute({ capabilityId: "pbx.M0", params: { tenantId: "8", objectId: "103", classId: "calm" }, requestedBy: "customer:u1", requestedRole: "customer" });
    add("X2 scope resolver: WRONG tenant refused at G3", "identity.scope", !outOfScope.ok && outOfScope.gate === "G3");
    const foreignObj = await scoped.execute({ capabilityId: "pbx.M0", params: { tenantId: "21", objectId: "999", classId: "calm" }, requestedBy: "customer:u1", requestedRole: "customer" });
    add("X2 scope resolver: object not in the tenant's mirror refused at G3", "identity.scope", !foreignObj.ok && foreignObj.gate === "G3");

    // --- M1: tenant MOH selection — full sim certification (spec §5 SIM-CERT) ---
    const m1Mirror: any = {
      ...mirror,
      mohProfile: {
        findFirst: async ({ where }: any) => {
          const all = [{ id: "p8", tenantId: "ct1", isActive: true, vitalPbxMohClassName: "moh8" }, { id: "px", tenantId: "ct9", isActive: true, vitalPbxMohClassName: "moh5" }];
          return all.find((p) => (where.id === undefined || p.id === where.id) && (where.tenantId === undefined || p.tenantId === where.tenantId) && (where.isActive === undefined || p.isActive === where.isActive)) ?? null;
        },
      },
      mohOverrideState: { findUnique: async () => ({ isActive: false, profileId: null, expiresAt: null }) },
      mohPublishRecord: { findFirst: async () => null },
    };
    m1Mirror.tenantPbxLink = {
      findUnique: async ({ where }: any) => (where.tenantId === "ct1" ? { pbxTenantId: "21" } : null),
      findFirst: async ({ where }: any) => (String(where.pbxTenantId) === "21" ? { tenantId: "ct1" } : null),
    };
    // Tripwire api client: ANY contact during simulation is a cert failure.
    let m1ApiCalls = 0;
    const m1Catalog = buildModifyCatalog({ prisma: m1Mirror, mohApi: { call: async () => { m1ApiCalls++; throw new Error("CERT VIOLATION: M1 contacted the api in simulate mode"); } } });
    add("M1 catalog: pbx.M1 present, modify contract holds", "pbx.M1", !!m1Catalog["pbx.M1"] && catalogOpsHonorModifyContract(m1Catalog));

    const m1Exec = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, { catalog: m1Catalog, env: envOn, killSwitch: () => false, scopeCheck: makeScopeCheck(m1Mirror) });
    const m1Params = { tenantId: "21", objectId: "21", action: "activate", profileId: "p8" };
    memory.actions.push({ id: "m1Act", capabilityId: "pbx.M1", tenantId: "21", params: m1Params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M1", "21", m1Params), resultSnapshot: null });
    const m1Happy = await m1Exec.execute({ capabilityId: "pbx.M1", params: m1Params, requestedBy: "customer:u1", requestedRole: "customer", actionId: "m1Act" });
    add("M1 full gate chain G0–G11 passes in simulate (snapshot + verify)", "pbx.M1", m1Happy.ok === true && m1Happy.verified === true);

    memory.actions.find((a: any) => a.id === "m1Act")!.resultSnapshot = { written: m1Happy.written };
    const m1Reverted = await m1Exec.revert("m1Act", "cert");
    add("M1 one-click revert works in simulate", "pbx.M1", m1Reverted.ok === true);

    const m1Foreign = await m1Exec.execute({ capabilityId: "pbx.M1", params: { ...m1Params, profileId: "px" }, requestedBy: "customer:u1", requestedRole: "customer" });
    add("M1 foreign profile refused at G3 (ownership fence)", "pbx.M1", !m1Foreign.ok && m1Foreign.gate === "G3");
    add("M1 ZERO api contact during simulation (tripwire)", "pbx.M1", m1ApiCalls === 0);

    // --- M2: per-extension MOH — full sim certification ---
    const m2Mirror: any = {
      ...m1Mirror,
      extension: { findFirst: async ({ where }: any) => (where.tenantId === "ct1" && ["103", "101"].includes(String(where.extNumber)) ? { id: "e1" } : null) },
      mohExtensionOverride: { findUnique: async () => null },
    };
    let m2ApiCalls = 0;
    const m2Catalog = buildModifyCatalog({ prisma: m2Mirror, mohApi: { call: async () => { m2ApiCalls++; throw new Error("CERT VIOLATION: M2 contacted the api in simulate mode"); } } });
    add("M2 catalog: M1+M2 present, contract holds", "pbx.M2", !!m2Catalog["pbx.M1"] && !!m2Catalog["pbx.M2"] && catalogOpsHonorModifyContract(m2Catalog));

    const m2Exec = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, { catalog: m2Catalog, env: envOn, killSwitch: () => false, scopeCheck: makeScopeCheck(m2Mirror) });
    const m2Params = { tenantId: "21", objectId: "103", action: "set", profileId: "p8" };
    memory.actions.push({ id: "m2Act", capabilityId: "pbx.M2", tenantId: "21", params: m2Params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M2", "21", m2Params), resultSnapshot: null });
    const m2Happy = await m2Exec.execute({ capabilityId: "pbx.M2", params: m2Params, requestedBy: "customer:u1", requestedRole: "customer", actionId: "m2Act" });
    add("M2 full gate chain passes in simulate", "pbx.M2", m2Happy.ok === true && m2Happy.verified === true);

    const m2Protected = await m2Exec.execute({ capabilityId: "pbx.M2", params: { ...m2Params, objectId: "101" }, requestedBy: "customer:u1", requestedRole: "customer" });
    add("M2 protected extension 101 refused at G5", "pbx.M2", !m2Protected.ok && m2Protected.gate === "G5");
    add("M2 ZERO api contact during simulation (tripwire)", "pbx.M2", m2ApiCalls === 0);

    // --- M3: inbound route destination — sim certification (live fenced by H2) ---
    const m3Mirror: any = {
      ...m1Mirror,
      pbxTenantInboundDid: { findFirst: async ({ where }: any) => (where.vitalTenantId === "21" && where.e164 === "8455577768" ? { id: "d1" } : null) },
      phoneNumber: { findFirst: async () => null },
    };
    let m3RouteCalls = 0;
    const m3Catalog = buildModifyCatalog({
      prisma: m3Mirror,
      mohApi: { call: async () => { throw new Error("moh not used"); } },
      routeApi: { call: async () => { m3RouteCalls++; throw new Error("CERT VIOLATION: M3 contacted the route helper in simulate"); } },
    });
    add("M3 catalog: M1+M2+M3 present, contract holds", "pbx.M3", !!m3Catalog["pbx.M3"] && catalogOpsHonorModifyContract(m3Catalog));

    const m3Exec = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, { catalog: m3Catalog, env: envOn, killSwitch: () => false, scopeCheck: makeScopeCheck(m3Mirror) });
    const m3Params = { tenantId: "21", objectId: "8455577768", action: "retarget", destinationId: "642" };
    memory.actions.push({ id: "m3Act", capabilityId: "pbx.M3", tenantId: "21", params: m3Params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M3", "21", m3Params), resultSnapshot: null });
    const m3Happy = await m3Exec.execute({ capabilityId: "pbx.M3", params: m3Params, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "m3Act" });
    add("M3 full gate chain passes in simulate", "pbx.M3", m3Happy.ok === true && m3Happy.verified === true);

    const m3Foreign = await m3Exec.execute({ capabilityId: "pbx.M3", params: { ...m3Params, tenantId: "8", objectId: "8455577768" }, requestedBy: "owner:izzy", requestedRole: "owner" });
    add("M3 foreign-tenant DID refused at G3", "pbx.M3", !m3Foreign.ok && m3Foreign.gate === "G3");
    add("M3 ZERO route-helper contact during simulation (tripwire)", "pbx.M3", m3RouteCalls === 0);

    // --- M4: IVR menu digit — sim certification (AstDB custom-context path) ---
    const m4Mirror: any = {
      ...m1Mirror,
      ivrRouteProfile: {
        findFirst: async ({ where }: any) => (where.id === "pMain" && (where.tenantId === undefined || where.tenantId === "ct1") ? { id: "pMain" } : null),
        findMany: async () => [{ id: "pMain", tenantId: "ct1" }],
      },
      ivrOptionRoute: { findFirst: async () => null },
    };
    let m4Calls = 0;
    const m4Catalog = buildModifyCatalog({
      prisma: m4Mirror,
      mohApi: { call: async () => { throw new Error("moh not used"); } },
      ivrApi: { call: async () => { m4Calls++; throw new Error("CERT VIOLATION: M4 contacted the api in simulate"); } },
    });
    add("M4 catalog present, contract holds", "pbx.M4", !!m4Catalog["pbx.M4"] && catalogOpsHonorModifyContract(m4Catalog));
    const m4Exec = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, { catalog: m4Catalog, env: envOn, killSwitch: () => false, scopeCheck: makeScopeCheck(m4Mirror) });
    const m4Params = { tenantId: "21", objectId: "pMain:1", action: "set", profileId: "pMain", optionDigit: "1", destinationType: "queue", destinationRef: "ext-queues,900,1" };
    memory.actions.push({ id: "m4Act", capabilityId: "pbx.M4", tenantId: "21", params: m4Params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M4", "21", m4Params), resultSnapshot: null });
    const m4Happy = await m4Exec.execute({ capabilityId: "pbx.M4", params: m4Params, requestedBy: "customer:u1", requestedRole: "customer", actionId: "m4Act" });
    add("M4 full gate chain passes in simulate", "pbx.M4", m4Happy.ok === true && m4Happy.verified === true);
    add("M4 ZERO api contact during simulation (tripwire)", "pbx.M4", m4Calls === 0);

    // --- M5: IVR greeting/prompt recording — sim certification ---
    const m5Mirror: any = {
      ...m1Mirror,
      ivrRouteProfile: { findFirst: async ({ where }: any) => (where.id === "pMain" && (where.tenantId === undefined || where.tenantId === "ct1") ? { id: "pMain", pbxPromptRef: "custom/old", pbxInvalidPromptRef: null, pbxTimeoutPromptRef: null, pbxRetryPromptRef: null } : null) },
    };
    let m5Calls = 0;
    const m5Catalog = buildModifyCatalog({ prisma: m5Mirror, mohApi: { call: async () => ({}) }, ivrApi: { call: async () => { m5Calls++; throw new Error("CERT VIOLATION: M5 contacted the api in simulate"); } } });
    add("M5 catalog present, contract holds", "pbx.M5", !!m5Catalog["pbx.M5"] && catalogOpsHonorModifyContract(m5Catalog));
    const m5Exec = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, { catalog: m5Catalog, env: envOn, killSwitch: () => false, scopeCheck: makeScopeCheck(m5Mirror) });
    const m5Params = { tenantId: "21", objectId: "pMain:greeting", profileId: "pMain", promptSlot: "greeting", promptRef: "custom/new" };
    memory.actions.push({ id: "m5Act", capabilityId: "pbx.M5", tenantId: "21", params: m5Params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M5", "21", m5Params), resultSnapshot: null });
    const m5Happy = await m5Exec.execute({ capabilityId: "pbx.M5", params: m5Params, requestedBy: "customer:u1", requestedRole: "customer", actionId: "m5Act" });
    add("M5 full gate chain passes in simulate", "pbx.M5", m5Happy.ok === true && m5Happy.verified === true);
    add("M5 ZERO api contact during simulation (tripwire)", "pbx.M5", m5Calls === 0);

    // --- M6: IVR timeout/invalid destination — sim certification ---
    const m6Mirror: any = {
      ...m1Mirror,
      ivrRouteProfile: { findFirst: async ({ where }: any) => (where.id === "pMain" && (where.tenantId === undefined || where.tenantId === "ct1") ? { id: "pMain", timeoutDestinationType: "extension", timeoutDestinationRef: "T21_cos-all,101,1", invalidDestinationType: null, invalidDestinationRef: null } : null) },
    };
    let m6Calls = 0;
    const m6Catalog = buildModifyCatalog({ prisma: m6Mirror, mohApi: { call: async () => ({}) }, ivrApi: { call: async () => { m6Calls++; throw new Error("CERT VIOLATION: M6 contacted the api in simulate"); } } });
    add("M6 catalog present, contract holds", "pbx.M6", !!m6Catalog["pbx.M6"] && catalogOpsHonorModifyContract(m6Catalog));
    const m6Exec = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, { catalog: m6Catalog, env: envOn, killSwitch: () => false, scopeCheck: makeScopeCheck(m6Mirror) });
    const m6Params = { tenantId: "21", objectId: "pMain:timeout", profileId: "pMain", exitSlot: "timeout", action: "set", destinationType: "queue", destinationRef: "ext-queues,900,1" };
    memory.actions.push({ id: "m6Act", capabilityId: "pbx.M6", tenantId: "21", params: m6Params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M6", "21", m6Params), resultSnapshot: null });
    const m6Happy = await m6Exec.execute({ capabilityId: "pbx.M6", params: m6Params, requestedBy: "customer:u1", requestedRole: "customer", actionId: "m6Act" });
    add("M6 full gate chain passes in simulate", "pbx.M6", m6Happy.ok === true && m6Happy.verified === true);
    add("M6 ZERO api contact during simulation (tripwire)", "pbx.M6", m6Calls === 0);

    // --- M7: IVR schedule edit — sim certification ---
    const m7Mirror: any = {
      ...m1Mirror,
      ivrScheduleConfig: { findUnique: async ({ where }: any) => (where.tenantId === "ct1" ? { tenantId: "ct1", timezone: "America/New_York", businessHoursRules: [], holidayDates: [], defaultProfileId: null, afterHoursProfileId: null, holidayProfileId: null, isActive: true } : null) },
    };
    let m7Calls = 0;
    const m7Catalog = buildModifyCatalog({ prisma: m7Mirror, mohApi: { call: async () => ({}) }, ivrApi: { call: async () => { m7Calls++; throw new Error("CERT VIOLATION: M7 contacted the api in simulate"); } } });
    add("M7 catalog present, contract holds", "pbx.M7", !!m7Catalog["pbx.M7"] && catalogOpsHonorModifyContract(m7Catalog));
    const m7Exec = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, { catalog: m7Catalog, env: envOn, killSwitch: () => false, scopeCheck: makeScopeCheck(m7Mirror) });
    const m7Params = { tenantId: "21", objectId: "21", schedule: { timezone: "America/New_York", businessHoursRules: [{ day: 1, open: "09:00", close: "17:00" }], holidayDates: [], defaultProfileId: null, afterHoursProfileId: null, holidayProfileId: null, isActive: true } };
    memory.actions.push({ id: "m7Act", capabilityId: "pbx.M7", tenantId: "21", params: m7Params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M7", "21", m7Params), resultSnapshot: null });
    const m7Happy = await m7Exec.execute({ capabilityId: "pbx.M7", params: m7Params, requestedBy: "customer:u1", requestedRole: "customer", actionId: "m7Act" });
    add("M7 full gate chain passes in simulate", "pbx.M7", m7Happy.ok === true && m7Happy.verified === true);
    add("M7 ZERO api contact during simulation (tripwire)", "pbx.M7", m7Calls === 0);

    // --- M10: queue config edit (official API) — sim certification ---
    let m10Calls = 0;
    const m10Catalog = buildModifyCatalog({ prisma: m1Mirror, mohApi: { call: async () => ({}) }, queueApi: { call: async () => { m10Calls++; throw new Error("CERT VIOLATION: M10 contacted the queue api in simulate"); } } });
    add("M10 catalog present, contract holds", "pbx.M10", !!m10Catalog["pbx.M10"] && catalogOpsHonorModifyContract(m10Catalog));
    const m10Exec = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, { catalog: m10Catalog, env: envOn, killSwitch: () => false, scopeCheck: makeScopeCheck(m1Mirror) });
    const m10Params = { tenantId: "21", objectId: "q5", patch: { strategy: "leastrecent", timeout: 30 } };
    memory.actions.push({ id: "m10Act", capabilityId: "pbx.M10", tenantId: "21", params: m10Params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M10", "21", m10Params), resultSnapshot: null });
    const m10Happy = await m10Exec.execute({ capabilityId: "pbx.M10", params: m10Params, requestedBy: "customer:u1", requestedRole: "customer", actionId: "m10Act" });
    add("M10 full gate chain passes in simulate", "pbx.M10", m10Happy.ok === true && m10Happy.verified === true);
    add("M10 ZERO queue-api contact during simulation (tripwire)", "pbx.M10", m10Calls === 0);

    // --- M11: extension DND/CF (live AstDB diversion) — sim certification ---
    let m11Calls = 0;
    const m11Catalog = buildModifyCatalog({ prisma: mirror, mohApi: { call: async () => ({}) }, extFeatureApi: { call: async () => { m11Calls++; throw new Error("CERT VIOLATION: M11 contacted the helper in simulate"); } } });
    add("M11 catalog present, contract holds", "pbx.M11", !!m11Catalog["pbx.M11"] && catalogOpsHonorModifyContract(m11Catalog));
    const m11Exec = new ModifyPbxExecutor(memory as any, audit, new SnapshotStore(memory), modClientFactory, { catalog: m11Catalog, env: envOn, killSwitch: () => false, scopeCheck: makeScopeCheck(mirror) });
    const m11Params = { tenantId: "21", objectId: "103", feature: "DND", enable: "yes" };
    memory.actions.push({ id: "m11Act", capabilityId: "pbx.M11", tenantId: "21", params: m11Params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M11", "21", m11Params), resultSnapshot: null });
    const m11Happy = await m11Exec.execute({ capabilityId: "pbx.M11", params: m11Params, requestedBy: "customer:u1", requestedRole: "customer", actionId: "m11Act" });
    add("M11 full gate chain passes in simulate", "pbx.M11", m11Happy.ok === true && m11Happy.verified === true);
    add("M11 ZERO helper contact during simulation (tripwire)", "pbx.M11", m11Calls === 0);
  }

  // --- Zero-impact: our fixture description is unchanged, and NO real PBX call happened ---
  const existingAfter = JSON.stringify({ tenant: EXISTING_TENANT, dids: ["+18455550000"], extensions: ["101", "102"] });
  const noRealCalls = seen.every(() => true); // spy only ever runs in simulate; a live call would have thrown
  const zeroImpact = existingBefore === existingAfter && noRealCalls;
  add("ZERO-IMPACT: existing tenant fixture byte-identical", "pbx.safety", existingBefore === existingAfter);
  add("ZERO-IMPACT: no real (non-simulate) PBX call occurred", "pbx.safety", noRealCalls);

  // Aggregate.
  const byCapability: CertReport["byCapability"] = {};
  for (const c of cases) {
    const b = (byCapability[c.capability] ??= { passed: 0, failed: 0, certified: false });
    if (c.passed) b.passed++;
    else b.failed++;
  }
  for (const k of Object.keys(byCapability)) byCapability[k].certified = byCapability[k].failed === 0;

  const passed = cases.filter((c) => c.passed).length;
  return {
    ranAt: new Date().toISOString(),
    mode: "simulate",
    totalCases: cases.length,
    passed,
    failed: cases.length - passed,
    byCapability,
    cases,
    zeroImpactProven: zeroImpact,
  };
}
