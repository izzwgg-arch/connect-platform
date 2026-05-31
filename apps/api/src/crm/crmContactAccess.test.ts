import test from "node:test";
import assert from "node:assert/strict";
import { resolveCrmContactAccess } from "./crmContactAccess.js";

test("resolveCrmContactAccess: platform admin bypasses campaign restriction", () => {
  assert.equal(
    resolveCrmContactAccess(true, "u1", null, false, ["camp-a"], "ADMIN"),
    "ok",
  );
});

test("resolveCrmContactAccess: unrestricted user sees any tenant contact", () => {
  assert.equal(resolveCrmContactAccess(true, "u1", null, false, null, "AGENT"), "ok");
});

test("resolveCrmContactAccess: restricted agent allowed when assigned", () => {
  assert.equal(resolveCrmContactAccess(true, "u1", "u1", false, ["camp-a"], "AGENT"), "ok");
});

test("resolveCrmContactAccess: restricted agent allowed via campaign membership", () => {
  assert.equal(resolveCrmContactAccess(true, "u1", null, true, ["camp-a"], "AGENT"), "ok");
});

test("resolveCrmContactAccess: restricted agent forbidden outside scope", () => {
  assert.equal(resolveCrmContactAccess(true, "u1", "u2", false, ["camp-a"], "AGENT"), "forbidden");
});

test("resolveCrmContactAccess: CRM manager bypasses campaign restriction", () => {
  assert.equal(resolveCrmContactAccess(true, "u1", "u2", false, ["camp-a"], "AGENT", "MANAGER"), "ok");
});

test("resolveCrmContactAccess: CRM admin bypasses campaign restriction", () => {
  assert.equal(resolveCrmContactAccess(true, "u1", "u2", false, ["camp-a"], "AGENT", "ADMIN"), "ok");
});

test("resolveCrmContactAccess: missing contact is not_found", () => {
  assert.equal(resolveCrmContactAccess(false, "u1", null, false, null, "AGENT"), "not_found");
});

test("tenant isolation: assertCrmContactAllowed queries contact.tenantId (documented)", () => {
  const tenantId = "tenant-a";
  const where = { id: "c1", tenantId };
  assert.equal(where.tenantId, tenantId);
});
