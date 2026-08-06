import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTools, toolsForRole, executeTool, stripForbiddenArgs,
  type ToolContext, type ToolSpec,
} from "./toolRegistry";

/** Records what tenantId each ReadTools call actually received. */
function spyDeps() {
  const seen: Array<{ fn: string; tenantId: string; ext?: string; hours?: number }> = [];
  const readTools: any = {
    extensionStatus: async (tenantId: string, ext?: string) => {
      seen.push({ fn: "extensionStatus", tenantId, ext });
      return [{ extension: ext ?? "101", registered: true, status: "REGISTERED" }];
    },
    cdrHistory: async (tenantId: string, ext?: string, hours?: number) => {
      seen.push({ fn: "cdrHistory", tenantId, ext, hours });
      return { totalCalls: 1 };
    },
  };
  const prisma: any = {
    callQualityHourly: {
      findMany: async ({ where }: any) => {
        seen.push({ fn: "callQualityHourly", tenantId: where.tenantId });
        return [{ avgLossPct: 0.4 }];
      },
    },
  };
  return { deps: { readTools, prisma }, seen };
}

const CUSTOMER: ToolContext = { tenantId: "T-REAL", role: "customer", clientUserId: "u1" };
const INTERNAL: ToolContext = { tenantId: "T-REAL", role: "internal" };

test("no tool schema exposes a tenant argument to the model", () => {
  const { deps } = spyDeps();
  for (const t of buildTools(deps)) {
    const keys = Object.keys(t.parameters.properties).map((k) => k.toLowerCase());
    for (const k of keys) {
      assert.ok(!k.includes("tenant"), `${t.name} exposes a tenant arg: ${k}`);
      assert.ok(!k.includes("company"), `${t.name} exposes a company arg: ${k}`);
    }
    assert.equal(t.parameters.additionalProperties, false, `${t.name} must not allow extra properties`);
  }
});

test("⛔ RED TEAM: a model-supplied tenantId is dropped; the verified tenant is used", async () => {
  const { deps, seen } = spyDeps();
  const tools = buildTools(deps);
  const r = await executeTool(
    tools,
    "extension_status",
    { extension: "101", tenantId: "T-VICTIM", tenant_id: "T-VICTIM", companyId: "T-VICTIM" },
    CUSTOMER,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [{ fn: "extensionStatus", tenantId: "T-REAL", ext: "101" }]);
  assert.deepEqual(r.droppedArgs.sort(), ["companyId", "tenantId", "tenant_id"]);
});

test("⛔ RED TEAM: the tenant leak is blocked on every tool, not just the first", async () => {
  const { deps, seen } = spyDeps();
  const tools = buildTools(deps);
  await executeTool(tools, "call_history", { tenantId: "T-VICTIM", extension: "102" }, CUSTOMER);
  await executeTool(tools, "call_quality", { tenantId: "T-VICTIM" }, INTERNAL);
  assert.ok(seen.every((s) => s.tenantId === "T-REAL"), `leaked: ${JSON.stringify(seen)}`);
});

test("stripForbiddenArgs catches casing and separator variants", () => {
  const { clean, dropped } = stripForbiddenArgs({
    TenantID: "x", "tenant-id": "x", TENANT_ID: "x", userId: "x", extension: "101",
  });
  assert.deepEqual(clean, { extension: "101" });
  assert.equal(dropped.length, 4);
});

test("role gating: customers never see internal tools", () => {
  const { deps } = spyDeps();
  const all = buildTools(deps);
  const forCustomer = toolsForRole(all, "customer").map((t) => t.name);
  assert.ok(!forCustomer.includes("call_quality"));
  assert.ok(forCustomer.includes("extension_status"));
  assert.ok(toolsForRole(all, "internal").map((t) => t.name).includes("call_quality"));
});

test("⛔ RED TEAM: a customer calling an internal tool is refused, not executed", async () => {
  const { deps, seen } = spyDeps();
  const r = await executeTool(buildTools(deps), "call_quality", {}, CUSTOMER);
  assert.equal(r.ok, false);
  assert.match(String((r.content as any).error), /Unknown or unavailable tool/);
  assert.equal(seen.length, 0, "the tool body must never run for a disallowed role");
});

test("unknown tool names are refused as a result, not thrown", async () => {
  const { deps } = spyDeps();
  const r = await executeTool(buildTools(deps), "delete_everything", {}, INTERNAL);
  assert.equal(r.ok, false);
  assert.match(String((r.content as any).error), /Unknown or unavailable tool/);
});

test("a throwing tool becomes an error result so the loop can continue", async () => {
  const boom: ToolSpec[] = [{
    name: "boom", description: "d", minRole: "internal",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    run: async () => { throw new Error("db down"); },
  }];
  const r = await executeTool(boom, "boom", {}, INTERNAL);
  assert.equal(r.ok, false);
  assert.match(String((r.content as any).error), /db down/);
});

test("model-supplied arguments are sanitised, not passed through raw", async () => {
  const { deps, seen } = spyDeps();
  const tools = buildTools(deps);
  // Junk extension is dropped to undefined; absurd window is clamped.
  await executeTool(tools, "call_history", { extension: "'; DROP TABLE users;--", windowHours: 999999 }, CUSTOMER);
  assert.equal(seen[0].ext, undefined);
  assert.equal(seen[0].hours, 24 * 30);
});
