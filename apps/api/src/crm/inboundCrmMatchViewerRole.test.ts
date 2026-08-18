import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decideTrustedViewerRole } from "./inboundCallerMatch";

/**
 * Guard for the fix to §1a of AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md:
 * `POST /internal/telephony/inbound-crm-match` took the caller's ROLE from the
 * request body, and both CRM access checks open with
 * `if (isAdminRole(role)) return true` — so anything holding the internal secret
 * could claim SUPER_ADMIN and read any tenant's CRM contacts by phone number.
 *
 * ⛔ Two halves are tested on purpose. The decision function alone would pass
 * even if the route still handed the body role to the resolver — the defect was
 * a CALLER, so the second half reads the source of both call sites.
 */

// ── Half 1: the decision itself ────────────────────────────────────────────────

test("decideTrustedViewerRole: an unknown userId is refused", () => {
  const d = decideTrustedViewerRole("tenant-a", null);
  assert.equal(d.ok, false);
  assert.equal(d.reason, "user_not_found");
  assert.equal(d.role, undefined);
});

test("decideTrustedViewerRole: a DISABLED user is refused even in their own tenant", () => {
  const d = decideTrustedViewerRole("tenant-a", {
    tenantId: "tenant-a",
    role: "TENANT_ADMIN",
    status: "DISABLED",
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, "user_disabled");
});

test("decideTrustedViewerRole: an ordinary user of the tenant keeps their real role", () => {
  const d = decideTrustedViewerRole("tenant-a", {
    tenantId: "tenant-a",
    role: "USER",
    status: "ACTIVE",
  });
  assert.equal(d.ok, true);
  assert.equal(d.role, "USER");
});

test("decideTrustedViewerRole: an INVITED user is still allowed (matches the login gate, which only blocks DISABLED)", () => {
  const d = decideTrustedViewerRole("tenant-a", {
    tenantId: "tenant-a",
    role: "USER",
    status: "INVITED",
  });
  assert.equal(d.ok, true);
});

test("⛔ decideTrustedViewerRole: a TENANT_ADMIN of another tenant is refused — the whole point of the fix", () => {
  const d = decideTrustedViewerRole("tenant-victim", {
    tenantId: "tenant-attacker",
    role: "TENANT_ADMIN",
    status: "ACTIVE",
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, "tenant_mismatch");
  assert.equal(d.role, undefined);
});

test("⛔ decideTrustedViewerRole: an ADMIN of another tenant is refused too", () => {
  const d = decideTrustedViewerRole("tenant-victim", {
    tenantId: "tenant-attacker",
    role: "ADMIN",
    status: "ACTIVE",
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, "tenant_mismatch");
});

test("decideTrustedViewerRole: a TENANT_ADMIN of their OWN tenant keeps the admin bypass", () => {
  const d = decideTrustedViewerRole("tenant-a", {
    tenantId: "tenant-a",
    role: "TENANT_ADMIN",
    status: "ACTIVE",
  });
  assert.equal(d.ok, true);
  assert.equal(d.role, "TENANT_ADMIN");
});

test("decideTrustedViewerRole: SUPER_ADMIN keeps cross-tenant reach (their telephony feed carries other tenants' calls)", () => {
  const d = decideTrustedViewerRole("tenant-b", {
    tenantId: "tenant-a",
    role: "SUPER_ADMIN",
    status: "ACTIVE",
  });
  assert.equal(d.ok, true);
  assert.equal(d.role, "SUPER_ADMIN");
});

test("decideTrustedViewerRole: a DISABLED SUPER_ADMIN is still refused", () => {
  const d = decideTrustedViewerRole("tenant-b", {
    tenantId: "tenant-a",
    role: "SUPER_ADMIN",
    status: "DISABLED",
  });
  assert.equal(d.ok, false);
});

test("decideTrustedViewerRole: a claimed role in the body cannot appear here — the input has no such field", () => {
  // The signature itself is the guard: there is nowhere to pass a claimed role.
  const identity = { tenantId: "tenant-a", role: "USER", status: "ACTIVE" };
  const d = decideTrustedViewerRole("tenant-a", identity);
  assert.equal(d.role, "USER");
  assert.equal(Object.keys(identity).sort().join(","), "role,status,tenantId");
});

// ── Half 2: the call sites (the defect was a caller) ───────────────────────────

function readSource(relative: string): string {
  return readFileSync(resolve(__dirname, relative), "utf8");
}

/** Source with comments removed, so a doc block explaining the fix cannot fail it. */
function readCode(relative: string): string {
  return readSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("⛔ source: the resolver reads the role from the User row, not from the body", () => {
  const src = readCode("./inboundCallerMatch.ts");
  assert.ok(
    /db\.user\.findUnique\(\{\s*where:\s*\{\s*id:\s*viewer\.userId\s*\}/.test(src),
    "resolveInboundCrmCallerForViewer must look the viewer up in the User table",
  );
  assert.ok(
    src.includes("decideTrustedViewerRole("),
    "the resolver must run the trusted-role decision",
  );
});

test("⛔ source: the resolver never passes viewer.role to a CRM access check", () => {
  const src = readCode("./inboundCallerMatch.ts");
  // The two authorization calls must receive `trustedRole`, never `viewer.role`.
  assert.ok(
    /userHasCrmAccess\(tenantId,\s*viewer\.userId,\s*trustedRole\)/.test(src),
    "userHasCrmAccess must be called with the DB-derived role",
  );
  assert.ok(
    /userCanAccessCrmContact\(\s*tenantId,\s*viewer\.userId,\s*trustedRole,/.test(src),
    "userCanAccessCrmContact must be called with the DB-derived role",
  );
  assert.equal(
    (src.match(/viewer\.role/g) || []).length,
    0,
    "viewer.role must not be read anywhere in the resolver module",
  );
});

test("⛔ source: the route hands only userId to the resolver", () => {
  const src = readCode("./inboundCallerMatchRoutes.ts");
  assert.ok(
    /viewer:\s*\{\s*userId:\s*parsed\.data\.viewer\.userId\s*\}/.test(src),
    "the route must forward userId only — never the parsed viewer object",
  );
  assert.ok(
    !/viewer:\s*parsed\.data\.viewer\s*,/.test(src),
    "the route must not forward the whole parsed viewer (it carries the claimed role)",
  );
});

test("source: the route still ACCEPTS a role field, so a running telephony container is not broken mid-deploy", () => {
  const src = readSource("./inboundCallerMatchRoutes.ts");
  assert.ok(
    /role:\s*z\.string\(\)\.optional\(\)/.test(src),
    "the schema must keep tolerating the field telephony still sends",
  );
});

test("source: the internal door still requires the shared secret", () => {
  const src = readSource("./inboundCallerMatchRoutes.ts");
  assert.ok(
    /if\s*\(!verifyInternalSecret\(req\)\)/.test(src),
    "the secret check must remain the first thing the handler does",
  );
});
