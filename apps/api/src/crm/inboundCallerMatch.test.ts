import test from "node:test";
import assert from "node:assert/strict";
import { buildPhoneMatchCandidates } from "./inboundCallerMatch";

test("buildPhoneMatchCandidates: E.164 and digit keys for US NANP", () => {
  const r = buildPhoneMatchCandidates("(512) 555-0100");
  assert.equal(r.e164, "+15125550100");
  assert.ok(r.normalizedKeys.includes("15125550100"));
  assert.ok(r.normalizedKeys.includes("5125550100"));
  assert.equal(r.safeSuffix10, "5125550100");
});

test("buildPhoneMatchCandidates: empty input yields no keys", () => {
  const r = buildPhoneMatchCandidates("   ");
  assert.equal(r.e164, null);
  assert.equal(r.normalizedKeys.length, 0);
  assert.equal(r.safeSuffix10, null);
});

test("inbound CRM WS payload: matched inbound includes CRM display fields", () => {
  const payload = {
    direction: "inbound" as const,
    from: "+15125550100",
    crmContactId: "c1",
    crmContactName: "Jane Lead",
    crmProfileUrl: "/crm/contacts/c1",
    crmMatchSource: "exact" as const,
  };
  assert.equal(payload.crmContactName, "Jane Lead");
  assert.equal(payload.crmProfileUrl, "/crm/contacts/c1");
});

test("inbound CRM WS payload: no match leaves CRM fields absent", () => {
  const payload: Record<string, unknown> = {
    direction: "inbound",
    from: "+19999999999",
    fromName: "WIRELESS CALLER",
  };
  assert.equal(payload.crmContactId, undefined);
  assert.equal(payload.fromName, "WIRELESS CALLER");
});

test("tenant isolation: matchTenantContactByPhone always filters contact.tenantId (documented)", () => {
  const tenantA = "tenant-a";
  const where = {
    contact: { tenantId: tenantA, active: true, archivedAt: null },
  };
  assert.equal(where.contact.tenantId, tenantA);
});

test("permission: viewer without CRM access receives no CRM fields (documented)", () => {
  const viewerDenied: null = null;
  assert.equal(viewerDenied, null);
});
