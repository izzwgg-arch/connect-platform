import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBillingEmailJobCreateData,
  canAccessPlatformAdminBillingRoutes,
  canAccessTenantBillingRoutes,
} from "./billingAuth";

test("TENANT_ADMIN can access tenant billing routes", () => {
  assert.equal(canAccessTenantBillingRoutes("TENANT_ADMIN"), true);
});

test("BILLING_ADMIN can access tenant billing routes", () => {
  assert.equal(canAccessTenantBillingRoutes("BILLING_ADMIN"), true);
});

test("BILLING role can access tenant billing routes", () => {
  assert.equal(canAccessTenantBillingRoutes("BILLING"), true);
});

test("ordinary USER cannot access tenant billing routes", () => {
  assert.equal(canAccessTenantBillingRoutes("USER"), false);
  assert.equal(canAccessTenantBillingRoutes("EXTENSION_USER"), false);
  assert.equal(canAccessTenantBillingRoutes(undefined), false);
});

test("platform admin billing matches SUPER_ADMIN-only API gate", () => {
  assert.equal(canAccessPlatformAdminBillingRoutes("SUPER_ADMIN"), true);
  assert.equal(canAccessPlatformAdminBillingRoutes("TENANT_ADMIN"), false);
  assert.equal(canAccessPlatformAdminBillingRoutes("ADMIN"), false);
  assert.equal(canAccessPlatformAdminBillingRoutes(undefined), false);
});

test("queued billing email payload always sets invoiceId=null (EmailJob.invoiceId FK references legacy Invoice table, not BillingInvoice)", () => {
  // EmailJob.invoiceId has a DB FK to the old Invoice table; passing a BillingInvoice ID
  // violates it. The function intentionally forces null to prevent P2003 errors.
  const data = buildBillingEmailJobCreateData({
    tenantId: "t1",
    to: "a@b.com",
    type: "BILLING_INVOICE_READY",
    subject: "s",
    html: "h",
    text: "x",
    invoiceId: "inv_99", // caller passes it but it must not be forwarded to DB
  });
  assert.equal(data.invoiceId, null);
  assert.equal(data.tenantId, "t1");
  assert.equal(data.toEmail, "a@b.com");
});

test("queued billing email payload uses null invoiceId when omitted", () => {
  const data = buildBillingEmailJobCreateData({
    tenantId: "t1",
    to: "a@b.com",
    type: "BILLING_RECEIPT",
    subject: "s",
    html: "h",
    text: "x",
  });
  assert.equal(data.invoiceId, null);
});
