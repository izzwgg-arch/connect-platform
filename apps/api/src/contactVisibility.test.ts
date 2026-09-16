/**
 * Private contacts stay private (2026-09-16, Relax Tires: ext 101's 4,250
 * phone-book contacts showed up in ext 102's and 103's apps).
 *
 * Unit tests pin the rule; SOURCE guards pin that every read path uses it —
 * the original defect was a query that simply had no owner filter, which no
 * unit test of a helper can catch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { contactVisibleToUserWhere, isContactVisibleToUser, SHARED_CONTACTS_ONLY_WHERE } from "./contactVisibility";

const root = process.env.PORTAL_GUARD_ROOT
  ? path.resolve(process.env.PORTAL_GUARD_ROOT)
  : path.resolve(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

test("a user sees shared contacts and their own — never a colleague's", () => {
  assert.deepEqual(contactVisibleToUserWhere("u102"), { OR: [{ ownerUserId: null }, { ownerUserId: "u102" }] });
  assert.equal(isContactVisibleToUser({ ownerUserId: null }, "u102"), true);
  assert.equal(isContactVisibleToUser({ ownerUserId: "u102" }, "u102"), true);
  assert.equal(isContactVisibleToUser({ ownerUserId: "u101" }, "u102"), false);
});

test("no known viewer means SHARED ONLY, never everything", () => {
  for (const v of [null, undefined, "", "   "]) {
    assert.deepEqual(contactVisibleToUserWhere(v as any), { ownerUserId: null });
    assert.equal(isContactVisibleToUser({ ownerUserId: "u101" }, v as any), false);
  }
  assert.deepEqual(SHARED_CONTACTS_ONLY_WHERE, { ownerUserId: null });
});

test("GET /contacts ANDs the owner filter so a search OR cannot widen it", () => {
  const src = read("apps/api/src/server.ts");
  const start = src.indexOf('app.get("/contacts", async');
  const body = src.slice(start, src.indexOf('type CreateContactOutcome', start));
  assert.ok(body.includes("AND: [contactVisibleToUserWhere(user.sub)]"), "list must filter by owner");
});

test("every /contacts/:id route and the duplicate/merge checks are owner-scoped", () => {
  const src = read("apps/api/src/server.ts");
  const from = src.indexOf("async function assertNoDuplicateContactPhones");
  const to = src.indexOf('app.get("/customers"', from);
  const block = src.slice(from, to);
  // Every Contact / ContactPhone lookup keyed by tenant in this block carries the viewer.
  const lookups = block.match(/contact\.findFirst\(\{ where: \{ id, tenantId[^}]*\}/g) ?? [];
  assert.ok(lookups.length >= 6, `expected the :id lookups, found ${lookups.length}`);
  for (const l of lookups) assert.ok(l.includes("contactVisibleToUserWhere(user.sub)"), `unscoped: ${l}`);
  assert.match(block, /contact: \{\s*tenantId, active: true, archivedAt: null,[\s\S]{0,120}contactVisibleToUserWhere\(viewerUserId\)/);
  assert.ok(block.includes("contact: { tenantId, active: true, archivedAt: null, ...contactVisibleToUserWhere(viewerUserId) }"), "import merge must be owner-scoped");
  assert.ok(block.includes("ownerUserId: createdBy"), "a new contact must be private to whoever saved it");
});

test("caller-name resolution names a caller only from the rung user's visible contacts", () => {
  const match = read("apps/api/src/crm/inboundCallerMatch.ts");
  assert.ok(/viewerUserId: string \| null,\n\): Promise<TenantContactMatch \| null>/.test(match), "viewer must be a REQUIRED parameter");
  assert.equal((match.match(/\.\.\.contactVisibleToUserWhere\(viewerUserId\)/g) ?? []).length, 2);
  const server = read("apps/api/src/server.ts");
  assert.ok(server.includes('matchTenantContactByPhone(target.tenantId, String(input.fromNumber || ""), target.userId ?? null)'));
  assert.ok(server.includes('matchTenantContactByPhone(tenantPack.tenantId, String(d.fromNumber || ""), ext.ownerUserId)'));
});

test("search, assistant, chat decoration, SMS email, CRM and blasts never read a private contact", () => {
  assert.ok(read("apps/api/src/globalSearchRoutes.ts").includes("AND: [contactVisibleToUserWhere(user.sub)]"));
  assert.ok(read("apps/api/src/agentProvisioning/contactsInfoRoute.ts").includes("AND: [contactVisibleToUserWhere(viewerUserId)]"));
  assert.ok(read("apps/agent/src/tools/contactsTools.ts").includes("ctx.clientUserId ?? null"));
  assert.ok(read("apps/api/src/connectChatRoutes.ts").includes("...contactVisibleToUserWhere(user.sub) }"));
  assert.ok(read("apps/agent/src/notify/smsEmailForwardJob.ts").includes("owners.length === 1"));
  assert.ok(read("apps/worker/src/crmInboundSmsHook.ts").includes("contact: { tenantId, ownerUserId: null }"));
  assert.ok(read("apps/api/src/crm/inboundSmsHook.ts").includes("contact: { tenantId, ownerUserId: null }"));
  assert.ok(read("apps/api/src/crm/crmContactAccess.ts").includes("where: { id: contactId, tenantId: user.tenantId, ownerUserId: null }"));
  assert.equal((read("apps/api/src/crm/importPipeline.ts").match(/contact: \{ tenantId, active: true, ownerUserId: null \}/g) ?? []).length, 2);
  assert.ok(read("apps/api/src/supermarket/specials.ts").includes("active: true, ownerUserId: null }"));
});

test("the migration backfills existing contacts to their creator and leaves CRM contacts shared", () => {
  const sql = read("packages/db/prisma/migrations/20260916200000_contact_owner_private/migration.sql");
  assert.match(sql, /SET "ownerUserId" = c\."createdBy"/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "CrmContactMeta"/);
  const schema = read("packages/db/prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model Contact {"), schema.indexOf("model ContactPhone {"));
  assert.ok(/\n  ownerUserId\s+String\?\n/.test(model));
  assert.ok(!/ownerUser\s+User\?/.test(model), "must NOT be a SetNull FK — a deleted owner would publish the phone book");
});
