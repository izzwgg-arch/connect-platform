import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPermissionTools, resolvePermission, permissionParamsHash,
  GRANTABLE_PERMISSIONS, NEVER_GRANTABLE_BY_CHAT, GRANT_CAPABILITY_ID,
} from "./permissionGrant";
import { executeTool, toolsForRole, type ToolContext } from "./toolRegistry";

const OWNER: ToolContext = { tenantId: "t1", role: "internal", clientUserId: "owner-1" };
const CUSTOMER: ToolContext = { tenantId: "t1", role: "customer", clientUserId: "u9" };

function deps() {
  const created: any[] = [];
  const users: any[] = [
    { id: "u2", email: "yehuda@acme.com", firstName: "Yehuda", lastName: "K", tenantId: "t1", status: "ACTIVE" },
    { id: "u7", email: "spy@other.com", firstName: "Spy", lastName: "X", tenantId: "t-other", status: "ACTIVE" },
  ];
  return {
    created,
    prisma: {
      user: {
        findFirst: async ({ where }: any) =>
          users.find((u) => u.email.toLowerCase() === String(where.email.equals).toLowerCase() && u.tenantId === where.tenantId) ?? null,
      },
      agentAction: { create: async ({ data, select }: any) => { created.push(data); return { id: "act-1" }; } },
    },
  };
}

test("⛔ it PREPARES only — a draft action, never an applied grant", async () => {
  const d = deps();
  const r: any = await executeTool(buildPermissionTools(d), "prepare_permission_grant",
    { targetEmail: "yehuda@acme.com", permission: "ivr" }, OWNER);
  assert.equal(r.ok, true);
  assert.equal(r.content.ok, true);
  assert.equal(r.content.requiresPasswordConfirmation, true);
  assert.equal(d.created.length, 1);
  assert.equal(d.created[0].status, "DRAFT", "must never be created already-approved");
  assert.equal(d.created[0].capabilityId, GRANT_CAPABILITY_ID);
  assert.equal(d.created[0].params.permission, "can_manage_ivr_routing");
  assert.equal(d.created[0].riskTier, "high");
});

test("⛔ a customer cannot even see the tool", () => {
  const names = toolsForRole(buildPermissionTools(deps()), "customer").map((t) => t.name);
  assert.deepEqual(names, []);
});

test("⛔ a customer calling it directly is refused and nothing is written", async () => {
  const d = deps();
  const r: any = await executeTool(buildPermissionTools(d), "prepare_permission_grant",
    { targetEmail: "yehuda@acme.com", permission: "ivr" }, CUSTOMER);
  assert.equal(r.ok, false);
  assert.equal(d.created.length, 0);
});

test("⛔ RED TEAM: a target in another tenant is simply not found", async () => {
  const d = deps();
  const r: any = await executeTool(buildPermissionTools(d), "prepare_permission_grant",
    { targetEmail: "spy@other.com", permission: "ivr" }, OWNER);
  assert.equal(r.content.ok, false);
  assert.equal(r.content.error, "user_not_found");
  assert.equal(d.created.length, 0);
});

test("⛔ RED TEAM: an injected tenantId cannot redirect the lookup", async () => {
  const d = deps();
  await executeTool(buildPermissionTools(d), "prepare_permission_grant",
    { targetEmail: "spy@other.com", permission: "ivr", tenantId: "t-other" } as any, OWNER);
  assert.equal(d.created.length, 0, "the verified tenant must win");
});

test("an invented permission is refused, not guessed at", async () => {
  const d = deps();
  for (const bad of ["can_do_anything", "admin", "root", "", "everything"]) {
    const r: any = await executeTool(buildPermissionTools(d), "prepare_permission_grant",
      { targetEmail: "yehuda@acme.com", permission: bad }, OWNER);
    assert.equal(r.content.ok, false, `${bad} must be refused`);
  }
  assert.equal(d.created.length, 0);
});

test("⛔ dangerous permissions are never grantable by chat, even by exact key", async () => {
  const d = deps();
  for (const key of NEVER_GRANTABLE_BY_CHAT) {
    const r: any = await executeTool(buildPermissionTools(d), "prepare_permission_grant",
      { targetEmail: "yehuda@acme.com", permission: key }, OWNER);
    assert.equal(r.content.ok, false, `${key} must not be grantable`);
  }
  assert.equal(d.created.length, 0);
});

test("the deny-list and the allow-list never overlap", () => {
  for (const p of Object.values(GRANTABLE_PERMISSIONS)) {
    assert.ok(!NEVER_GRANTABLE_BY_CHAT.has(p.key), `${p.key} is on both lists`);
  }
});

test("plain speech and the raw key both resolve; junk does not", () => {
  assert.equal(resolvePermission("moh")?.key, "can_manage_moh");
  assert.equal(resolvePermission("can_manage_moh")?.key, "can_manage_moh");
  assert.equal(resolvePermission("  IVR  ")?.key, "can_manage_ivr_routing");
  assert.equal(resolvePermission("can_manage_deploys"), null, "off-list keys must not resolve");
});

test("the approval hash binds tenant, person AND permission", () => {
  const a = permissionParamsHash("t1", "u2", "can_manage_moh");
  assert.notEqual(a, permissionParamsHash("t2", "u2", "can_manage_moh"));
  assert.notEqual(a, permissionParamsHash("t1", "u3", "can_manage_moh"));
  assert.notEqual(a, permissionParamsHash("t1", "u2", "can_manage_ivr_routing"));
  assert.equal(a, permissionParamsHash("t1", "u2", "can_manage_moh"), "must be stable");
});

test("⛔ a conversation with no signed-in person cannot prepare a grant", async () => {
  // Nobody could ever confirm it — a draft here would strand forever.
  const d = deps();
  const r: any = await executeTool(buildPermissionTools(d), "prepare_permission_grant",
    { targetEmail: "yehuda@acme.com", permission: "ivr" },
    { tenantId: "t1", role: "internal", clientUserId: null });
  assert.equal(r.content.ok, false);
  assert.equal(r.content.error, "no_requester");
  assert.equal(d.created.length, 0);
});

test("the draft records who asked, for the audit trail", async () => {
  const d = deps();
  await executeTool(buildPermissionTools(d), "prepare_permission_grant",
    { targetEmail: "yehuda@acme.com", permission: "moh" }, OWNER);
  assert.equal(d.created[0].requestedBy, "owner-1");
  assert.equal(d.created[0].tenantId, "t1");
  assert.match(d.created[0].summary, /Yehuda K.*music on hold/);
});
