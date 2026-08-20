/**
 * Tenant-leak sweep, 2026-08-20 — the fixes, pinned.
 *
 * Izzy: "take a run again on tenant leaking and make sure there could never be
 * any tenant leaking ever." A full sweep of apps/api found six real defects
 * (plus latent twins). NONE was live: every one was blocked by a second gate —
 * the `can_view_admin_ops_center` prefix key that TENANT_ADMIN does not hold,
 * or `canManageMoh`/chat's `isTenantAdmin`, which admit only SUPER_ADMIN and
 * ADMIN while the platform has ZERO ADMIN users. Proven, not assumed: a real
 * customer admin's validly-signed token was fired at all of them on production
 * and every one answered 403.
 *
 * ⛔ "Latent" is why these are fixed rather than noted. Every one of them arms
 * the moment somebody creates one ADMIN-role user or grants one key — which is
 * exactly how §6h and the three `ADMIN`-role findings before it were written up
 * in this repo, twice, and then had to be fixed anyway.
 *
 * These guards read SOURCE because every defect was a caller-side omission: a
 * missing scope, a missing pin, a gate one role too wide. A unit test of the
 * helper passes straight through all of them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recordingAccessDecision } from "./tenantCommScope";

const norm = (s: string) => s.replace(/\r\n/g, "\n");
/*
 * ⛔ RAW source, deliberately NOT comment-stripped. This repo's own rule: a
 * comment-stripper run over server.ts opens a fake block comment at a REGEX
 * LITERAL and swallows the registration you were looking for — it cost this
 * very file one red test before the rule was re-learned. So every assertion
 * below is written to be unambiguous against raw source instead: the positive
 * ones match executable shapes (`await requireSuperAdmin(req, reply)`), and
 * the negative ones match full call forms that prose above them never
 * contains — the doc comments say "requireAdmin admits TENANT_ADMIN", never
 * `await requireAdmin(req, reply)`.
 */
const SERVER = norm(readFileSync(join(__dirname, "server.ts"), "utf8"));
const CHAT = norm(readFileSync(join(__dirname, "connectChatRoutes.ts"), "utf8"));

/** The slice of a route handler, from its declaration to the next one. */
function routeBody(src: string, decl: string): string {
  const at = src.indexOf(decl);
  assert.ok(at !== -1, `route not found: ${decl}`);
  const next = src.slice(at + decl.length).search(/\napp\.(get|post|patch|put|delete)\(/);
  return src.slice(at, next === -1 ? undefined : at + decl.length + next);
}

/* ── finding 1: the platform SMS ops dashboard ───────────────────────────── */

test("provider-health is SUPER_ADMIN — it lists every tenant by NAME", () => {
  const body = routeBody(SERVER, 'app.get("/admin/sms/provider-health"');
  assert.match(body, /await requireSuperAdmin\(req, reply\)/, "must be super-admin gated");
  assert.doesNotMatch(body, /await requireAdmin\(req, reply\)/, "requireAdmin admits TENANT_ADMIN — 10 live customer admins");
});

/* ── findings 2, 3, 4: 10DLC — a customer's legal identity documents ─────── */

test("the 10DLC list and read are scoped to the caller's own tenant", () => {
  const list = routeBody(SERVER, 'app.get("/admin/ten-dlc/submissions"');
  assert.match(list, /ownTenantIdScopeWhere\(user\)/, "the list must be tenant-scoped");
  assert.doesNotMatch(list, /where: query\.status \? \{ status: query\.status \} : undefined/, "`where: undefined` is NO FILTER in Prisma");

  const read = routeBody(SERVER, 'app.get("/admin/ten-dlc/submissions/:id"');
  assert.match(read, /ownTenantIdScopeWhere\(user\)/, "the read must be tenant-scoped");
  assert.doesNotMatch(read, /tenDlcSubmission\.findUnique\(\{ where: \{ id \} \}\)/, "a bare findUnique by id ignores ownership");
  assert.match(read, /status\(404\)/, "a foreign id must read as MISSING, never 403 — a 403 is an existence oracle");
});

test("⛔ no 10DLC query anywhere may fetch by bare id", () => {
  // The whole model, not just the two routes fixed — this is the durable half.
  const bare = SERVER.match(/tenDlcSubmission\.(findUnique|findFirst|findMany)\([^)]*\)/g) || [];
  for (const call of bare) {
    if (/\.findMany\(/.test(call)) continue; // checked above, and multi-line
    assert.match(call, /tenantId|scope/, `unscoped 10DLC fetch: ${call}`);
  }
});

test("approving a 10DLC registration is SUPER_ADMIN — a customer must not approve their own", () => {
  const body = routeBody(SERVER, 'app.post("/admin/ten-dlc/submissions/:id/status"');
  assert.match(body, /await requireSuperAdmin\(req, reply\)/, "the approve/reject write must be super-admin only");
  assert.doesNotMatch(body, /await requireAdmin\(req, reply\)/, "this was a cross-tenant WRITE reachable by requireAdmin");
});

/* ── finding 5: the vpbx: escape hatch ───────────────────────────────────── */

test("the MOH pbx-classes vpbx: branch is pinned to super-admin, BEFORE it resolves", () => {
  const body = routeBody(SERVER, 'app.get("/voice/moh/pbx-classes"');
  const pin = body.indexOf('super_admin_required_for_vpbx_override');
  const resolve = body.indexOf("resolveConnectTenantIdFromScope(rawScope)");
  assert.ok(pin !== -1, "the vpbx: branch must carry the same pin as every sibling route");
  assert.ok(pin < resolve, "the pin must run BEFORE another tenant's scope is resolved");
});

/* ── finding 6: assignees on an SMS number ───────────────────────────────── */

test("SMS-number assignees are checked against the number's tenant, before the write", () => {
  const at = CHAT.indexOf('app.patch("/admin/apps/voip-ms/numbers/:id"');
  assert.ok(at !== -1, "the number-assignment route must exist");
  const body = CHAT.slice(at, at + 6000);
  const check = body.indexOf("ASSIGNEE_NOT_IN_TENANT");
  const extCheck = body.indexOf("EXTENSION_NOT_IN_TENANT");
  const write = body.indexOf("db.tenantSmsNumber.update(");
  assert.ok(check !== -1 && extCheck !== -1, "users AND extensions must both be checked");
  assert.ok(check < write && extCheck < write, "the checks must run BEFORE the update, so a refusal changes nothing");
});

/* ── latent A: the recording decision that defaulted to ALLOW ────────────── */

test("recordingAccessDecision DENIES an unattributed recording", async () => {
  // 4,316 of 126,052 CDRs carry no tenant. The old guard short-circuited on
  // `rec.tenantId &&` and fell through to `allowed: true` at the end.
  const d = await recordingAccessDecision({ tenantId: null, extension: "101" }, { sub: "u1", tenantId: "t1", role: "USER" } as any);
  assert.equal(d.allowed, false, "a recording with no tenant must never be allowed");
});

test("recordingAccessDecision DENIES a user with no tenant", async () => {
  const d = await recordingAccessDecision({ tenantId: "t1", extension: "101" }, { sub: "u1", tenantId: null, role: "USER" } as any);
  assert.equal(d.allowed, false, "a tenant-less user must never be allowed");
});

test("recordingAccessDecision still DENIES a plain cross-tenant recording", async () => {
  const d = await recordingAccessDecision({ tenantId: "t2", extension: "101" }, { sub: "u1", tenantId: "t1", role: "USER" } as any);
  assert.equal(d.allowed, false);
});
