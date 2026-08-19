/**
 * The agent's admin-route authorization boundary.
 *
 * ⛔ The bug these tests lock down: `requireOwner` (`role === "owner"`) admits
 * every TENANT_ADMIN because the agent maps TENANT_ADMIN → admin mode. Several
 * `/agent/admin/*` routes are cross-tenant / platform-global, so admitting a
 * customer's own admin leaked across tenants. `resolveStaffCaller` must admit
 * ONLY SUPER_ADMIN; `resolveAdminCaller` admits admin mode but flags `isStaff`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const SECRET = "admin-auth-test-secret";
process.env.JWT_SECRET = SECRET;

// Imported AFTER JWT_SECRET is set so verifyPortalJwt reads it.
import { resolveAdminCaller, resolveStaffCaller } from "./adminAuth";

function b64url(obj: object | Buffer): string {
  const buf = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function token(payload: object, secret = SECRET): string {
  const h = b64url({ alg: "HS256", typ: "JWT" });
  const p = b64url(payload);
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(sig)}`;
}
function req(role?: string, tenantId = "t1", secret = SECRET) {
  return { headers: { authorization: `Bearer ${token({ sub: "u1", tenantId, role }, secret)}` } };
}

test("SUPER_ADMIN is admin AND staff", () => {
  const c = resolveAdminCaller(req("SUPER_ADMIN", "root"));
  assert.ok(c && c.isStaff, "SUPER_ADMIN must be staff");
  assert.equal(c!.tenantId, "root");
  assert.ok(resolveStaffCaller(req("SUPER_ADMIN", "root")), "resolveStaffCaller admits SUPER_ADMIN");
});

test("⛔ TENANT_ADMIN is admin mode but NOT staff", () => {
  const c = resolveAdminCaller(req("TENANT_ADMIN", "t1"));
  assert.ok(c, "TENANT_ADMIN is admin mode");
  assert.equal(c!.isStaff, false, "⛔ TENANT_ADMIN must NOT be staff");
  assert.equal(c!.tenantId, "t1", "and the tenant is bound from the JWT, not the body");
  assert.equal(resolveStaffCaller(req("TENANT_ADMIN", "t1")), null, "⛔ resolveStaffCaller must REFUSE a tenant admin");
});

test("a plain USER is neither admin nor staff", () => {
  assert.equal(resolveAdminCaller(req("USER", "t1")), null);
  assert.equal(resolveStaffCaller(req("USER", "t1")), null);
});

test("no token, garbage token, and wrong-secret token are all refused", () => {
  assert.equal(resolveAdminCaller({ headers: {} }), null);
  assert.equal(resolveAdminCaller({ headers: { authorization: "Bearer not.a.jwt" } }), null);
  assert.equal(resolveAdminCaller(req("SUPER_ADMIN", "root", "wrong-secret")), null, "a token signed with the wrong secret is refused");
});

test("the tenant comes from the JWT — a caller cannot claim another tenant", () => {
  // Even a valid admin token carries its OWN tenant; there is no body path here.
  const c = resolveAdminCaller(req("TENANT_ADMIN", "my-tenant"));
  assert.equal(c!.tenantId, "my-tenant");
});

// ── SOURCE guards: the defect is always the CALLER, so pin the wiring. Reading
//    a unit of the helper passes straight through a route that forgot to use it.
import fs from "node:fs";
import path from "node:path";
const READ = (p: string) => fs.readFileSync(path.join(__dirname, p), "utf8").replace(/\r\n/g, "\n");
// ⛔ Strip comments before any NEGATIVE match — the doc comments here quote the
// old `requireOwner` on purpose, and a naive `!includes` would match the comment.
const CODE = (p: string) => READ(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("SOURCE: platform-global consoles are STAFF-only, not requireOwner", () => {
  const server = READ("./server.ts");
  // secrets (platform LLM keys), trainer lessons, kb retrieve → resolveStaffCaller
  assert.ok(/\/agent\/admin\/secrets\/status[\s\S]{0,120}resolveStaffCaller/.test(server), "secrets status must be staff-only");
  assert.ok(/resolveStaffCaller\(req\)/.test(server), "server.ts must gate staff routes on resolveStaffCaller");
  assert.ok(/import \{ resolveStaffCaller \} from "\.\/adminAuth"/.test(server), "server.ts must import resolveStaffCaller");

  const actions = READ("./actions/adminRoutes.ts");
  assert.ok(!/requireOwner\(/.test(CODE("./actions/adminRoutes.ts")), "⛔ approvals/activity/incidents must NOT call requireOwner");
  assert.equal((actions.match(/resolveStaffCaller\(req\)/g) || []).length, 3, "all three cross-tenant feeds must be staff-only");
});

test("SOURCE: policy + diag routes bind the tenant to the caller unless staff", () => {
  const policy = READ("./policy/adminRoutes.ts");
  assert.ok(/o\.isStaff \? \{\} : \{ tenantId: o\.tenantId \}/.test(policy), "policies list must scope to the caller's tenant");
  assert.ok(/!o\.isStaff && tenantId !== o\.tenantId/.test(policy), "policy write must refuse a foreign tenantId");
  assert.ok(!/verifyPortalJwt/.test(CODE("./policy/adminRoutes.ts")), "policy routes must go through resolveAdminCaller, not raw verifyPortalJwt");

  const diag = READ("./diag/routes.ts");
  assert.ok(/!caller\.isStaff && body\.data\.tenantId !== caller\.tenantId/.test(diag), "diag must refuse a foreign tenantId for a tenant admin");
});

test("SOURCE: the chat engine gates the staff tool tier on isPlatformStaff, not admin mode", () => {
  const engine = READ("./conversation/engine.ts");
  assert.ok(/isPlatformStaff\(platformRole\)/.test(engine), "toolRoleFor must consult platform-staff, not just role");
  assert.ok(/toolRoleFor\(ctx\.role, ctx\.platformRole\)/.test(engine), "the call site must pass platformRole through");
});
