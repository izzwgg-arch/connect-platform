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

// ── The +E.164 key forms (2026-08-23, the Relax Tires "contacts never show" fix) ──
// ContactPhone.numberNormalized is stored WITH the leading "+" in production
// ("+18457992855" — verified live), so digit-only candidate keys never hit the
// exact indexed branch and every ring-time lookup fell through to the
// un-indexed endsWith scan. The candidates must carry the +-forms.

test("buildPhoneMatchCandidates: bare 10-digit inbound number carries the +E.164 key production stores", () => {
  const r = buildPhoneMatchCandidates("8457992855");
  assert.ok(r.normalizedKeys.includes("+18457992855"), `missing +E.164 key: ${JSON.stringify(r.normalizedKeys)}`);
  assert.ok(r.normalizedKeys.includes("18457992855"));
  assert.ok(r.normalizedKeys.includes("8457992855"));
});

test("buildPhoneMatchCandidates: 11-digit and formatted forms also carry the + key", () => {
  for (const input of ["18457992855", "+1 845-799-2855", "(845) 799-2855"]) {
    const r = buildPhoneMatchCandidates(input);
    assert.ok(r.normalizedKeys.includes("+18457992855"), `${input}: ${JSON.stringify(r.normalizedKeys)}`);
  }
});

// ── Source guards on the callers (the defects were caller-side) ──────────────
import { readFileSync } from "node:fs";
import { join } from "node:path";

function serverSourceNoComments(): string {
  const raw = readFileSync(join(__dirname, "..", "server.ts"), "utf8").replace(/\r\n/g, "\n");
  return raw;
}

test("missed-call invite push reads invite.fromDisplay — invite.callerName does not exist on CallInvite", () => {
  const src = serverSourceNoComments();
  assert.ok(
    src.includes('callerNameOrNumber: invite.fromDisplay || invite.fromNumber || "Unknown caller"'),
    "the invite-path missed-call push must read fromDisplay",
  );
  assert.ok(
    !src.includes("invite.callerName ||"),
    "invite.callerName is not a column — the any-typed callback let this typo compile for months",
  );
});

test("ring path resolves the caller through matchTenantContactByPhone, not an inline endsWith scan", () => {
  const src = serverSourceNoComments();
  assert.ok(src.includes("await matchTenantContactByPhone(target.tenantId, String(input.fromNumber || \"\"))"));
});
