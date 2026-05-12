import test from "node:test";
import assert from "node:assert/strict";
import { buildConnectBillingGatewayXInvoice, parseConnectBillingGatewayXInvoice } from "@connect/integrations";

test("parseConnectBillingGatewayXInvoice resolves CONNECT-scoped xInvoice", () => {
  const tenantId = "t1";
  const invoiceId = "inv1";
  const inv = buildConnectBillingGatewayXInvoice(tenantId, invoiceId, "INV-2025-01");
  assert.ok(inv.startsWith(`CONNECT:${tenantId}:${invoiceId}:`));
  const parsed = parseConnectBillingGatewayXInvoice(inv);
  assert.equal(parsed?.tenantId, tenantId);
  assert.equal(parsed?.invoiceId, invoiceId);
});

test("parseConnectBillingGatewayXInvoice returns null for legacy invoice numbers", () => {
  assert.equal(parseConnectBillingGatewayXInvoice("INV-123"), null);
});
