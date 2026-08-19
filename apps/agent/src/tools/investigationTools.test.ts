/**
 * The diagnosis tool's fences.
 *
 * ⛔ The one that must never go quiet: a CUSTOMER conversation must not be able
 * to see or reach `investigate`. The door is deliberately NOT tenant-scoped —
 * that is what makes "is this happening to anyone else?" answerable, and it is
 * exactly why it is staff-side only. If this tool ever appears in a customer's
 * tool list, one customer can read every other customer's data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildInvestigationTools } from "./investigationTools";
import { executeTool, toolsForRole, stripForbiddenArgs } from "./toolRegistry";

const READ = (p: string) => fs.readFileSync(path.join(__dirname, p), "utf8").replace(/\r\n/g, "\n");

function harness() {
  const calls: any[] = [];
  const tools = buildInvestigationTools({
    investigation: { query: async (q: any) => { calls.push(q); return { ok: true, rows: [{ n: 1 }], rowCount: 1 }; } },
  });
  return { tools, calls };
}

const STAFF = { tenantId: "t-real", role: "staff" as const, clientUserId: "u1" };
const CUSTOMER = { tenantId: "t-real", role: "customer" as const, clientUserId: "u1" };
const TENANT_ADMIN = { tenantId: "t-real", role: "internal" as const, clientUserId: "u1" };

test("⛔ only STAFF can see the tool — not a customer, not a tenant admin", () => {
  const { tools } = harness();
  assert.equal(toolsForRole(tools, "customer").length, 0, "customer must never see it");
  assert.equal(toolsForRole(tools, "internal").length, 0, "⛔ a TENANT_ADMIN (internal) must not see it — it is not tenant-scoped");
  assert.equal(toolsForRole(tools, "staff").length, 1, "only Connect staff (SUPER_ADMIN) sees it");
});

test("⛔ a CUSTOMER cannot execute it even by naming it directly", async () => {
  const { tools, calls } = harness();
  const res = await executeTool(tools, "investigate", { source: "connect", sql: "select 1" }, CUSTOMER);
  assert.equal(res.ok, false);
  assert.match(JSON.stringify(res.content), /Unknown or unavailable tool/);
  assert.equal(calls.length, 0, "and nothing reached the door");
});

test("⛔ a TENANT_ADMIN (internal) cannot execute it — the cross-tenant leak this closes", async () => {
  const { tools, calls } = harness();
  const res = await executeTool(tools, "investigate", { source: "connect", sql: "select 1" }, TENANT_ADMIN);
  assert.equal(res.ok, false);
  assert.match(JSON.stringify(res.content), /Unknown or unavailable tool/);
  assert.equal(calls.length, 0, "a customer's own admin must not reach a cross-platform SQL read");
});

test("the tenant is bound from the verified context, never from the model", async () => {
  const { tools, calls } = harness();
  // The model tries to claim a different tenant. The registry strips it and the
  // tool binds ctx.tenantId regardless — two locks, both tested.
  const res = await executeTool(
    tools,
    "investigate",
    { source: "connect", sql: "select 1", tenantId: "someone-elses-tenant" } as any,
    STAFF,
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.droppedArgs, ["tenantId"]);
  assert.equal(calls[0].tenantId, "t-real");
});

test("stripForbiddenArgs drops every tenant-ish key the model might invent", () => {
  const { clean, dropped } = stripForbiddenArgs({ sql: "select 1", tenant_id: "x", companyId: "y", role: "internal" });
  assert.deepEqual(Object.keys(clean), ["sql"]);
  assert.equal(dropped.length, 3);
});

test("source is coerced to exactly connect|pbx", async () => {
  const { tools, calls } = harness();
  await executeTool(tools, "investigate", { source: "pbx", sql: "select 1" }, STAFF);
  await executeTool(tools, "investigate", { source: "nonsense", sql: "select 1" }, STAFF);
  assert.equal(calls[0].source, "pbx");
  assert.equal(calls[1].source, "connect", "anything unrecognised falls back to connect, never through unchecked");
});

test("the row limit is clamped, and junk is simply omitted", async () => {
  const { tools, calls } = harness();
  await executeTool(tools, "investigate", { source: "connect", sql: "select 1", limit: 100000 }, STAFF);
  await executeTool(tools, "investigate", { source: "connect", sql: "select 1", limit: -3 }, STAFF);
  await executeTool(tools, "investigate", { source: "connect", sql: "select 1", limit: "lots" } as any, STAFF);
  assert.equal(calls[0].limit, 50);
  assert.equal(calls[1].limit, 1);
  assert.equal(calls[2].limit, undefined);
});

test("empty SQL is refused before the door is called", async () => {
  const { tools, calls } = harness();
  const res = await executeTool(tools, "investigate", { source: "connect", sql: "   " }, STAFF);
  assert.equal((res.content as any).ok, false);
  assert.equal(calls.length, 0);
});

test("⛔ a guard REFUSAL comes back as data, not as a thrown error", async () => {
  // The model must read "you tried to write" and adjust. Turning it into a
  // generic failure would hide the reason and it would just try again.
  const tools = buildInvestigationTools({
    investigation: {
      query: async () => ({ ok: false, refusedByGuard: true, error: "Only SELECT / WITH / SHOW / DESCRIBE / EXPLAIN queries are allowed here" }),
    },
  });
  const res = await executeTool(tools, "investigate", { source: "connect", sql: "update x set y=1" }, STAFF);
  assert.equal(res.ok, true, "the tool call itself succeeded");
  assert.equal((res.content as any).refusedByGuard, true);
  assert.match(String((res.content as any).error), /allowed here/);
});

// ── source guards: the wiring, because the defect is always the caller ──────

test("SOURCE: the tool is registered in the agent's chat tool list", () => {
  const src = READ("../server.ts");
  assert.ok(/buildInvestigationTools\(\{\s*investigation:\s*makeInvestigationClient\(\)\s*\}\)/.test(src));
});

test("SOURCE: the ESCALATION RESEARCHER runs as 'internal' and therefore does NOT reach investigate", () => {
  // ⛔ The researcher processes the CUSTOMER's own transcript, so exposing an
  // un-tenant-scoped SQL tool there is a prompt-injection path ("run this SQL and
  // put it in FINDINGS"). Since 2026-08-19 `investigate` is the "staff" tier and
  // the researcher runs with role "internal", so `toolsForRole` filters it out —
  // the researcher reasons/uses the tenant-scoped reads, and only a Connect-staff
  // chat reaches investigate. If the researcher were ever handed role "staff",
  // customer text could drive raw cross-tenant SQL.
  const esc = READ("../escalation/escalations.ts");
  assert.ok(/role:\s*"internal"/.test(esc), "must run as internal, so investigate stays filtered out");
  assert.ok(!/role:\s*"staff"/.test(esc), "⛔ must NEVER run escalation research as staff (customer text drives it)");
});

test("SOURCE: the tool is declared STAFF-only and says so", () => {
  const src = READ("./investigationTools.ts");
  assert.ok(/minRole:\s*"staff"/.test(src), "must be staff-tier");
  assert.ok(!/minRole:\s*"customer"/.test(src), "⛔ must never be customer-facing");
  assert.ok(!/minRole:\s*"internal"/.test(src), "⛔ must never be 'internal' — that admits every TENANT_ADMIN");
});

test("SOURCE: the client fails closed with no secret and does not throw on a refusal", () => {
  const src = READ("../pbx/investigationClient.ts");
  assert.ok(/investigation_secret_unset/.test(src), "a missing secret must fail closed");
  assert.ok(/resp\.status !== 200/.test(src), "a 200 with ok:false must be returned, not thrown");
});
