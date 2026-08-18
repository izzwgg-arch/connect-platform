/**
 * Guards for the tenant-isolation audit's §6a–§6g scoping fixes (2026-08-18).
 *
 * ⛔ These read the CALL SITES' SOURCE on purpose. Every one of these defects
 * was a CALLER passing the wrong scope — a bare `findUnique({ id })`, a guard
 * that short-circuited itself, a missing `requireCrmAccess`. A unit test of the
 * handler's happy path passes straight through all of them, which is exactly
 * how they survived to be found by an audit rather than by a test.
 *
 * ⛔ Every read normalises CRLF. Izzy's global `core.autocrlf=true` checks
 * several of these files out with CRLF, and a literal "\n}" or ";\n" anchor
 * then matches nothing — a source guard that silently guards nothing, or a red
 * test that reads like a production regression. See
 * [[source-reading-tests-must-normalise-crlf]].
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { canModifySmsNumberRow, canReadSmsNumberRow } from "./smsNumberAdminScope";

const SRC = __dirname;
const read = (rel: string): string =>
  readFileSync(path.join(SRC, rel), "utf8").replace(/\r\n/g, "\n");

/** The source between `startMarker` and the next `endMarker` after it. */
function slice(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, "start marker not found: " + startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, "end marker not found after start: " + endMarker);
  return source.slice(start, end);
}

// ─── §6a / §6b — the pure scope rules ────────────────────────────────────────

test("§6b: an UNASSIGNED number row is not modifiable by a non-super", () => {
  // The whole bug: the old guard read `if (row.tenantId && …)`, so a null
  // tenantId skipped the check and the spare could be claimed.
  assert.equal(
    canModifySmsNumberRow({ isSuper: false, actorTenantId: "tenant-a", rowTenantId: null }),
    false,
  );
  assert.equal(
    canModifySmsNumberRow({ isSuper: false, actorTenantId: "tenant-a", rowTenantId: undefined }),
    false,
  );
});

test("§6b: a non-super may modify only their own tenant's row", () => {
  assert.equal(canModifySmsNumberRow({ isSuper: false, actorTenantId: "a", rowTenantId: "a" }), true);
  assert.equal(canModifySmsNumberRow({ isSuper: false, actorTenantId: "a", rowTenantId: "b" }), false);
});

test("§6a: a foreign or unassigned number is unreadable by a non-super", () => {
  assert.equal(canReadSmsNumberRow({ isSuper: false, actorTenantId: "a", rowTenantId: "b" }), false);
  assert.equal(canReadSmsNumberRow({ isSuper: false, actorTenantId: "a", rowTenantId: null }), false);
  assert.equal(canReadSmsNumberRow({ isSuper: false, actorTenantId: "a", rowTenantId: "a" }), true);
});

test("SUPER_ADMIN keeps the whole platform inventory, deliberately", () => {
  assert.equal(canReadSmsNumberRow({ isSuper: true, actorTenantId: "a", rowTenantId: "b" }), true);
  assert.equal(canModifySmsNumberRow({ isSuper: true, actorTenantId: "a", rowTenantId: null }), true);
});

test("an actor with no tenant is refused rather than matched against null", () => {
  // Guards the inversion that keeps biting this codebase: a falsy scope value
  // must never widen access.
  assert.equal(canReadSmsNumberRow({ isSuper: false, actorTenantId: null, rowTenantId: null }), false);
  assert.equal(canModifySmsNumberRow({ isSuper: false, actorTenantId: "", rowTenantId: null }), false);
});

// ─── §6a / §6b — the call sites ──────────────────────────────────────────────

test("§6a: routing-preview consults canReadSmsNumberRow before answering", () => {
  const body = slice(
    read("connectChatRoutes.ts"),
    'app.get("/admin/apps/voip-ms/routing-preview"',
    "inboundRoutesTo:",
  );
  assert.match(body, /canReadSmsNumberRow\(/);
  // …and the refusal must be indistinguishable from "no such number".
  assert.match(body, /return \{ found: false, normalized: n\.e164 \};/);
});

test("§6b: the numbers PATCH no longer short-circuits its guard on a null tenantId", () => {
  const body = slice(
    read("connectChatRoutes.ts"),
    'app.patch("/admin/apps/voip-ms/numbers/:id"',
    "NOT_YOUR_TENANT",
  );
  assert.match(body, /canModifySmsNumberRow\(/);
  assert.doesNotMatch(body, /row\.tenantId && row\.tenantId !== effTenant/);
});

// ─── §6c — grantability is re-checked where permissions REACH a user ─────────

test("§6c: assigning custom roles re-checks grantability, not just tenant ownership", () => {
  const body = slice(
    read("customRoleRoutes.ts"),
    'app.put("/admin/users/:userId/custom-roles"',
    "invalidateAllPortalPermissions()",
  );
  assert.match(body, /ungrantablePermissionsFor\(/);
  assert.match(body, /ungrantable_permissions/);
  // It cannot check what it did not fetch.
  assert.match(body, /select: \{ id: true, permissions: true \}/);
});

test("§6c: duplicating a role re-checks grantability before copying its permissions", () => {
  const body = slice(
    read("customRoleRoutes.ts"),
    'app.post("/admin/custom-roles/:id/duplicate"',
    "permissions: source.permissions",
  );
  assert.match(body, /ungrantablePermissionsFor\(/);
});

test("§6c: the header no longer claims permissions are additive", () => {
  const src = read("customRoleRoutes.ts");
  // Custom roles are AUTHORITATIVE — the old sentence was a live trap for
  // anyone building a role as "just the extras".
  assert.doesNotMatch(src, /Permissions are additive only/);
  assert.match(src, /AUTHORITATIVE/);
});

// ─── §6d — an unattributed recording is refused ──────────────────────────────

test("§6d: a CDR with no tenantId is refused for non-super-admins", () => {
  const body = slice(read("server.ts"), "let viaLinkedSipScope = false;", "let allowTenantWide = false;");
  // The `if (rec.tenantId)` block must now have an else that refuses, rather
  // than falling through to the extension carve-out — which passes when
  // rec.extension is null, true of every inbound call.
  assert.match(body, /\} else \{/);
  const elseBranch = body.slice(body.lastIndexOf("} else {"));
  assert.match(elseBranch, /reply\.code\(403\)\.send\(\{ error: "forbidden" \}\); return;/);
});

// ─── §6e — the voicemail-drop stream is dual-gated ───────────────────────────

test("§6e: the voicemail-drop stream authenticates AND scopes to the tenant", () => {
  const body = slice(
    read("crm/voicemailDropRoutes.ts"),
    'app.get("/crm/voicemail-drops/:id/stream"',
    "readCrmVoicemailDropAudio",
  );
  assert.match(body, /requireCrmAccess\(req, reply\)/);
  assert.match(body, /where: \{ id, tenantId: user\.tenantId \}/);
  // The signature stays — this is a dual gate, not a replacement.
  assert.match(body, /verifySignedCrmVoicemailDropUrl\(/);
});

test("§6e: no route in the voicemail-drop file fetches a drop by bare id", () => {
  const src = read("crm/voicemailDropRoutes.ts");
  // ⛔ This assertion was written as `{ where: { id } }` first and matched
  // NOTHING against the pre-change file, which really reads
  // `findFirst({ where: { id }, select: …)`. It passed on HEAD — i.e. it was a
  // guard guarding nothing. Anchor on what the code actually says.
  assert.doesNotMatch(src, /findFirst\(\{ where: \{ id \}\s*[,}]/);
});

// ─── §6f — retry-payment resolves the card inside the invoice's tenant ───────

test("§6f: retry-payment scopes the payment method to the invoice's tenant", () => {
  const body = slice(
    read("billing/routes.ts"),
    'app.post("/admin/billing/invoices/:id/retry-payment"',
    "payment_method_required",
  );
  assert.match(body, /tenantId: invoice\.tenantId/);
  assert.match(body, /active: true/);
  assert.doesNotMatch(body, /paymentMethod\.findUnique\(\{ where: \{ id: methodId \} \}\)/);
});

// ─── §6g — delivery driver creation validates both caller-supplied ids ───────

test("§6g: createDriver validates the user and the stores against the tenant", () => {
  const body = slice(
    read("delivery/dispatchService.ts"),
    "export async function createDriver(",
    "db.driverProfile.upsert(",
  );
  assert.match(body, /db\.user\.findFirst\(\{ where: \{ id: userId, tenantId \}/);
  assert.match(body, /db\.deliveryStore\.findMany\(/);
  assert.match(body, /driver_user_not_in_tenant/);
  assert.match(body, /store_not_in_tenant/);
});

test("§6g: a cross-tenant id answers 400, not an unhandled 500", () => {
  const body = slice(
    read("delivery/dispatchRoutes.ts"),
    'app.post("/delivery/drivers"',
    'app.post("/delivery/drivers/:id/deactivate"',
  );
  assert.match(body, /DeliveryValidationError/);
  assert.match(body, /status\(400\)/);
});

test("§6g: driverNameMap resolves names within the tenant only", () => {
  const body = slice(
    read("delivery/orderService.ts"),
    "export async function driverNameMap(",
    "return new Map(profiles",
  );
  const usersQuery = body.slice(body.indexOf("db.user.findMany("));
  assert.match(usersQuery, /tenantId/);
});
