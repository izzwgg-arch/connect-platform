/**
 * Guards for the 2026-08-18 round-2 hardening: audit §6h, §6j, §6l, the
 * login enumeration oracle (audit doc finding J), and ZodError → 400.
 *
 * ⛔ Source guards read the CALL SITES, CRLF-normalised — every one of these
 * defects was a caller, and a unit test of a pure function passes straight
 * through all of them. Each guard was replayed against the pre-change blobs
 * from `git show HEAD:` and confirmed to FAIL there before this shipped
 * ([[source-guards-must-be-replayed-against-head]]).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { shouldSkipJwtVerification } from "./jwtPublicRouteBypass";
import { decideVitalResourceWrite, vitalResourceRowsContainId, SUPER_ONLY_VITAL_WRITE_RESOURCES } from "./pbxResourceOwnership";

const read = (rel: string): string => readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
/** Comments stripped — the doc blocks quote the OLD code, so a negative match on
 *  the raw file fails on correct code. And a whole-file assert.match prints 1.8 MB. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}
function slice(source: string, start: string, end: string): string {
  const s = source.indexOf(start);
  assert.ok(s >= 0, "start marker not found: " + start);
  const e = source.indexOf(end, s + start.length);
  assert.ok(e > s, "end marker not found: " + end);
  return source.slice(s, e);
}

// ─── §6j — combined pay links are public again ────────────────────────────────

test("§6j: pay-multi view/config/pay bypass the JWT like their single-invoice siblings", () => {
  for (const p of [
    "/billing/platform/invoices/pay-multi/tok123",
    "/billing/platform/invoices/pay-multi/tok123/public-config",
    "/billing/platform/invoices/pay-multi/tok123/pay",
    "/api/billing/platform/invoices/pay-multi/tok123",
  ]) {
    assert.equal(shouldSkipJwtVerification(p), true, p);
  }
  // …and the single-invoice ones still do.
  assert.equal(shouldSkipJwtVerification("/billing/platform/invoices/pay/tok/public-config"), true);
});

test("§6j: an ordinary billing route is still gated", () => {
  assert.equal(shouldSkipJwtVerification("/billing/platform/invoices"), false);
  assert.equal(shouldSkipJwtVerification("/billing/platform/invoices/inv_1/retry-payment"), false);
});

// ─── §6l — /chat/a/ bypass is anchored ────────────────────────────────────────

test("§6l: /chat/a/ is public only at the path START, never as a substring", () => {
  assert.equal(shouldSkipJwtVerification("/chat/a/att_1"), true);
  assert.equal(shouldSkipJwtVerification("/api/chat/a/att_1/file.png"), true);
  // A future route that merely CONTAINS the fragment must stay gated.
  assert.equal(shouldSkipJwtVerification("/admin/chat/a/anything"), false);
  assert.equal(shouldSkipJwtVerification("/voice/chat/a/x"), false);
  const src = stripComments(read("jwtPublicRouteBypass.ts"));
  assert.ok(!/path\.includes\("\/chat\/a\/"\)/.test(src), "the substring bypass must be gone from CODE (a comment quotes it)");
});

// ─── §6h — raw VitalPBX writes prove ownership ────────────────────────────────

test("§6h: rows containing the id in any id-shaped field count as owned; nothing else does", () => {
  const rows = [{ extension_id: 101, name: "x" }, { id: "abc" }, { ivrId: "iv-9", nested: { id: "no" } }];
  assert.equal(vitalResourceRowsContainId(rows, "101"), true);
  assert.equal(vitalResourceRowsContainId(rows, "abc"), true);
  assert.equal(vitalResourceRowsContainId(rows, "iv-9"), true);
  assert.equal(vitalResourceRowsContainId(rows, "no"), false, "a nested object never counts");
  assert.equal(vitalResourceRowsContainId(rows, "x"), false, "a non-id field never counts");
  assert.equal(vitalResourceRowsContainId(null, "abc"), false);
  assert.equal(vitalResourceRowsContainId(rows, ""), false);
});

test("§6h: super admins pass; non-supers are refused for tenants/trunks, missing scope, unlisted ids", () => {
  assert.deepEqual(decideVitalResourceWrite({ isSuperAdmin: true, resource: "tenants", id: "9", hasPbxTenantId: false, ownRows: null }), { ok: true });
  for (const r of SUPER_ONLY_VITAL_WRITE_RESOURCES) {
    assert.deepEqual(decideVitalResourceWrite({ isSuperAdmin: false, resource: r, id: "1", hasPbxTenantId: true, ownRows: [{ id: "1" }] }), { ok: false, status: 403, error: "forbidden" });
  }
  assert.deepEqual(decideVitalResourceWrite({ isSuperAdmin: false, resource: "ivr", id: "1", hasPbxTenantId: false, ownRows: [{ id: "1" }] }), { ok: false, status: 403, error: "forbidden" });
  assert.deepEqual(decideVitalResourceWrite({ isSuperAdmin: false, resource: "ivr", id: "1", hasPbxTenantId: true, ownRows: null }), { ok: false, status: 403, error: "forbidden" }, "a list failure is a refusal");
  // A foreign id reads like a missing one.
  assert.deepEqual(decideVitalResourceWrite({ isSuperAdmin: false, resource: "ivr", id: "77", hasPbxTenantId: true, ownRows: [{ ivr_id: 5 }] }), { ok: false, status: 404, error: "not_found" });
  assert.deepEqual(decideVitalResourceWrite({ isSuperAdmin: false, resource: "ivr", id: "5", hasPbxTenantId: true, ownRows: [{ ivr_id: 5 }] }), { ok: true });
});

test("§6h: BOTH write routes consult the ownership decision before touching the PBX", () => {
  const src = read("server.ts");
  const patch = slice(src, 'app.patch("/voice/pbx/resources/:resource/:id"', "vitalUpdateByResource(");
  const del = slice(src, 'app.delete("/voice/pbx/resources/:resource/:id"', "vitalDeleteByResource(");
  assert.match(patch, /decideVitalWriteForCaller\(user, resource, id, link, auth\)/);
  assert.match(del, /decideVitalWriteForCaller\(user, resource, id, link, auth\)/);
});

// ─── §6l — remote-support existence oracle ────────────────────────────────────

test("§6l: the remote-support target lookup is tenant-scoped for non-supers", () => {
  const body = slice(read("remoteSupportRoutes.ts"), 'app.post("/remote-support/sessions"', "const actor = await actorFacts(user)");
  assert.match(body, /db\.user\.findFirst\(/);
  assert.match(body, /\{ id: targetUserId, tenantId: user\.tenantId \}/);
  assert.doesNotMatch(body, /db\.user\.findUnique\(\{\s*where: \{ id: targetUserId \}/);
});

// ─── §6l — delivery scan/session scoping ──────────────────────────────────────

test("§6l: the scan idempotency lookup carries the tenant", () => {
  const body = slice(read("delivery/scanService.ts"), "export async function scanLabel(", "resolveLabelToken(");
  assert.match(body, /where: \{ clientOpId, tenantId: input\.tenantId \}/);
  assert.doesNotMatch(body, /findUnique\(\{\s*where: \{ clientOpId \}/);
});

test("§6l: a tracking session validates the run against tenant + driver", () => {
  const body = slice(read("delivery/locationService.ts"), "export async function startSession(", "driverTrackingSession.updateMany");
  assert.match(body, /db\.deliveryRun\.findFirst\(\{ where: \{ id: runId, tenantId, driverId \}/);
});

// ─── §6l — campaign assignee validated at both writes ─────────────────────────

test("§6l: campaign member add AND patch validate the assignee against the tenant", () => {
  const src = read("crm/campaignRoutes.ts");
  const add = slice(src, "const { contactIds, assignedToUserId } = parsed.data;", "Verify all contacts exist in tenant");
  assert.match(add, /crmUserAccess\.findFirst\(\{\s*where: \{ tenantId, userId: assignedToUserId, enabled: true \}/);
  const patch = slice(src, 'app.patch("/crm/campaigns/:id/members/:memberId"', "crmCampaignMember.update(");
  assert.match(patch, /crmUserAccess\.findFirst\(\{\s*where: \{ tenantId, userId: parsed\.data\.assignedToUserId, enabled: true \}/);
});

// ─── §6l — IVR schedule + announcement scoping ────────────────────────────────

test("§6l: a scheduled menu switch checks the profile belongs to the mapping's tenant", () => {
  const body = slice(read("didSwitchSchedule.ts"), 'app.post("/voice/ivr/numbers/:mappingId/schedule"', "const activateAt = new Date");
  assert.match(body, /ivrRouteProfile\.findFirst\(\{ where: \{ id: body\.data\.profileId, tenantId: mapping\.tenantId \}/);
});

test("§6l: an announcement's promptRef is checked against the tenant's catalog, and server.ts wires the checker", () => {
  const sched = read("didSwitchSchedule.ts");
  assert.match(sched, /deps\.resolveMissingPromptRefs\(tenantId, \[\{ key: "pre_announce", ref: body\.data\.promptRef \}\]\)/);
  const server = read("server.ts");
  assert.ok(/registerDidSwitchScheduleRoutes\(\{ \.\.\.didSwitchDeps, resolveMissingPromptRefs: ivrResolveMissingPromptRefs \}\)/.test(server), "server.ts must pass the catalog checker");
});

test("§6l: the didmap publisher resolves the MOH profile inside the mapping's tenant", () => {
  const src = stripComments(read("server.ts"));
  assert.ok(/mohProfile\.findFirst\(\{ where: \{ id: mapping\.mohProfileId, tenantId: mapping\.tenantId \} \}\)/.test(src), "scoped lookup missing");
  assert.ok(!/mohProfile\.findUnique\(\{ where: \{ id: mapping\.mohProfileId \} \}\)/.test(src), "unscoped lookup still present");
});

// ─── §6l — constant-time compares on the agent doors ──────────────────────────

test("§6l: the two agent info doors compare the shared secret in constant time", () => {
  for (const f of ["agentProvisioning/accountSetupInfoRoute.ts", "agentProvisioning/contactsInfoRoute.ts"]) {
    const src = read(f);
    assert.doesNotMatch(src, /!== secret/, f);
    assert.match(src, /agentMohSecretOk\(req\.headers\["x-agent-internal-secret"\], process\.env\.AGENT_INTERNAL_SECRET\)/, f);
  }
});

// ─── §6l — requireCrmAdmin honours the tenant switch ─────────────────────────

test("§6l: requireCrmAdmin resolves the effective tenant like requireCrmAccess", () => {
  const body = slice(read("crm/guard.ts"), "export async function requireCrmAdmin(", "export async function requireCrmManager(");
  assert.match(body, /withEffectiveCrmTenant\(req, user\)/);
  assert.match(body, /return effectiveUser;/);
});

// ─── finding J — the login oracle ─────────────────────────────────────────────

test("login: the DISABLED check runs only AFTER bcrypt matched (no enumeration oracle)", () => {
  const src = read("server.ts");
  const handler = slice(src, 'app.post("/auth/login"', "issueLoginSession(");
  const bcryptAt = handler.indexOf("bcrypt.compare(input.password, user.passwordHash)");
  const disabledAt = handler.indexOf('status === "DISABLED"');
  assert.ok(bcryptAt > 0 && disabledAt > 0, "both checks must exist");
  assert.ok(bcryptAt < disabledAt, "the password must be checked BEFORE the account status is revealed");
});

// ─── ZodError → 400 ───────────────────────────────────────────────────────────

test("a thrown zod parse becomes 400 validation_error with field paths, never a 500", () => {
  const src = read("server.ts");
  const handler = slice(src, "app.setErrorHandler((error, req, reply) => {", "const status = Number(");
  assert.match(handler, /error instanceof z\.ZodError/);
  assert.match(handler, /status\(400\)/);
  assert.match(handler, /error: "validation_error"/);
  // Only path/code/message — never the raw issue object (which can carry `received`).
  assert.match(handler, /\(\{ path: i\.path\.join\("\."\), code: i\.code, message: i\.message \}\)/);
});
