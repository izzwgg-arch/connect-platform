import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, type TenantPolicy } from "./policy";
import type { Capability } from "../manifest/manifest";

const forwardAction: Capability = {
  id: "action.A1.temp_forward",
  kind: "action",
  roles: ["owner", "customer"],
  title: "Temporary call forwarding",
  status: "certified",
  defaultLimits: { maxDurationHours: 24, maxPerDay: 3 },
};

const readStatus: Capability = {
  id: "read.extension_status",
  kind: "read",
  roles: ["owner", "customer"],
  title: "Extension status",
  status: "certified",
};

const ownerOnly: Capability = {
  id: "action.A3.ivr_switch",
  kind: "action",
  roles: ["owner"],
  title: "IVR switch",
  status: "certified",
};

const policy: TenantPolicy = {
  tenantId: "t1",
  version: 1,
  updatedBy: "izzy",
  historyVisible: true,
  channels: ["chat"],
  grants: {
    "action.A1.temp_forward": {
      mode: "allowed",
      limits: { maxDurationHours: 24, maxPerDay: 3 },
      protectedExtensions: ["100"],
    },
  },
};

test("customer cannot act cross-tenant, ever", () => {
  const d = evaluate(readStatus, { role: "customer", tenantId: "t1", targetTenantId: "t2" }, policy);
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "CROSS_TENANT");
});

test("owner has full access without second approval loop", () => {
  const d = evaluate(ownerOnly, { role: "owner", tenantId: "owner", targetTenantId: "t1" }, null);
  assert.deepEqual(d, { ok: true, requiresApproval: false });
});

test("customer action within limits requires approval", () => {
  const d = evaluate(forwardAction, { role: "customer", tenantId: "t1", targetTenantId: "t1" }, policy, { requestedDurationHours: 12 });
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(d.requiresApproval, true);
});

test("duration limit enforced", () => {
  const d = evaluate(forwardAction, { role: "customer", tenantId: "t1", targetTenantId: "t1" }, policy, { requestedDurationHours: 48 });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "LIMIT_EXCEEDED");
});

test("per-day limit enforced", () => {
  const d = evaluate(
    forwardAction,
    { role: "customer", tenantId: "t1", targetTenantId: "t1", usageToday: { "action.A1.temp_forward": 3 } },
    policy,
    { requestedDurationHours: 1 },
  );
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "LIMIT_EXCEEDED");
});

test("protected extension blocked", () => {
  const d = evaluate(forwardAction, { role: "customer", tenantId: "t1", targetTenantId: "t1" }, policy, { targetExtension: "100", requestedDurationHours: 1 });
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "PROTECTED_EXTENSION");
});

test("owner-only capability denied to customer by role", () => {
  const d = evaluate(ownerOnly, { role: "customer", tenantId: "t1", targetTenantId: "t1" }, policy);
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "ROLE_NOT_PERMITTED");
});

test("ungranted action falls back to blocked for customers", () => {
  const ungranted: Capability = { ...forwardAction, id: "action.A2.forward_set_clear", defaultLimits: undefined };
  const d = evaluate(ungranted, { role: "customer", tenantId: "t1", targetTenantId: "t1" }, policy);
  assert.equal(d.ok, false);
  if (!d.ok) assert.equal(d.code, "CAPABILITY_NOT_GRANTED");
});

test("reads default-allowed within own tenant", () => {
  const d = evaluate(readStatus, { role: "customer", tenantId: "t1", targetTenantId: "t1" }, policy);
  assert.equal(d.ok, true);
  if (d.ok) assert.equal(d.requiresApproval, false);
});
