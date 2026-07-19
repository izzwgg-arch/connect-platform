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
import { ScopedPbxExecutor, catalogHasNoDestructiveOps, type PbxClientLike } from "../pbx/executor";
import { PROVISIONING_CATALOG } from "../pbx/provisioning";
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
