import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerGlobalSearchRoutes } from "./globalSearchRoutes";

const grants = (...pages: string[]) => pages.flatMap(page => [`can_view_section_${page.split("_")[0]}`, `can_view_${page}`]);
async function fixture(options: { role?: string; permissions?: string[] | null; hidden?: string[]; authenticated?: boolean; tenantIds?: string[]; rows?: Record<string, any[]>; fail?: string } = {}) {
  const app = Fastify();
  const calls: { model: string; args: any }[] = [];
  const forwarded: { path: string; query: any; headers: any }[] = [];
  const models = ["contact", "extension", "invoice", "user", "tenant", "phoneNumber", "connectChatThread", "connectChatMessage"];
  const db = Object.fromEntries(models.map(model => [model, { findMany: async (args: any) => { calls.push({ model, args }); if (options.fail === model) throw Error("unavailable"); return options.rows?.[model] ?? []; } }]));
  app.addHook("preHandler", async req => { if (options.authenticated !== false) (req as any).user = { sub: "viewer", tenantId: "own", role: options.role || "USER" }; });
  for (const path of ["/calls/history", "/voice/voicemail", "/crm/contacts"]) app.get(path, async req => {
    forwarded.push({ path, query: req.query, headers: req.headers });
    if (path === "/calls/history") return { items: [{ rowId: "call", fromNumber: "123", toNumber: "101", startedAt: "2026-09-14T12:00:00Z" }] };
    if (path === "/voice/voicemail") return { voicemails: [{ id: String((req.query as any).folder), callerId: "123", extension: "101", folder: (req.query as any).folder }] };
    return { rows: [{ id: "crm-contact", displayName: "CRM person", ssn: "NEVER_RETURN", primaryEmail: { email: "person@example.test" } }] };
  });
  registerGlobalSearchRoutes(app, { db: db as any, permissions: async () => options.permissions === undefined ? [] : options.permissions, visibility: async () => ({ hidden: options.hidden || [], ownerOnlyLifted: [] }), tenantIds: async id => options.tenantIds ?? (id ? [id] : []) });
  const search = (url = "/search/global?q=alice", headers: Record<string, string> = {}) => app.inject({ url, headers: { authorization: "Bearer original-session", ...headers } });
  return { app, calls, forwarded, search };
}

test("authentication is required and short/invalid input makes no database calls", async () => {
  const f = await fixture({ authenticated: false });
  assert.equal((await f.search()).statusCode, 401); await f.app.close();
  const g = await fixture({ permissions: grants("workspace_contacts") });
  for (const url of ["/search/global", "/search/global?q=a", "/search/global?q=%20%20", "/search/global?q[x]=bad"]) assert.deepEqual((await g.search(url)).json().results, []);
  assert.equal(g.calls.length, 0); await g.app.close();
});
test("no grants means no record providers, even for a built-in administrator", async () => {
  for (const role of ["USER", "ADMIN", "SUPER_ADMIN"]) {
    const f = await fixture({ role }); assert.deepEqual((await f.search()).json().results, []); assert.equal(f.calls.length, 0); assert.equal(f.forwarded.length, 0); await f.app.close();
  }
});
test("custom grants require the section and page; hidden pages stay excluded", async () => {
  for (const options of [{ permissions: ["can_view_workspace_contacts"] }, { permissions: ["can_view_section_workspace"] }, { permissions: grants("workspace_contacts"), hidden: ["workspace.contacts"] }]) {
    const f = await fixture(options); await f.search(); assert.equal(f.calls.length, 0); await f.app.close();
  }
});
test("regular users cannot spoof tenant or request global records", async () => {
  const f = await fixture({ permissions: grants("workspace_contacts"), rows: { contact: [{ id: "c", displayName: "Alice", company: "Acme", phones: [], emails: [] }] } });
  const response = await f.search("/search/global?q=alice&scope=GLOBAL&tenantId=other", { "x-tenant-context": "other" });
  assert.equal(response.statusCode, 200); assert.deepEqual(f.calls.map(c => c.model), ["contact", "extension"]);
  for (const call of f.calls) assert.deepEqual(call.args.where.tenantId, { in: ["own"] });
  assert.equal(response.headers["cache-control"], "private, no-store"); assert.equal(response.json().results[0].href, "/contacts?q=Alice"); await f.app.close();
});
test("selected platform tenant resolves aliases, while missing tenant scope fails closed", async () => {
  const f = await fixture({ role: "SUPER_ADMIN", permissions: grants("workspace_contacts"), tenantIds: ["vpbx:acme", "acme"] });
  await f.search(undefined, { "x-tenant-context": "vpbx:acme" }); assert.deepEqual(f.calls[0]?.args.where.tenantId, { in: ["vpbx:acme", "acme"] }); await f.app.close();
  const g = await fixture({ role: "SUPER_ADMIN", permissions: grants("workspace_contacts"), tenantIds: [] }); await g.search(); assert.equal(g.calls.length, 0); await g.app.close();
});
test("permission resolver failure never falls back to role defaults", async () => {
  const f = await fixture({ role: "SUPER_ADMIN", permissions: null }); assert.equal((await f.search()).statusCode, 503); assert.equal(f.calls.length, 0); await f.app.close();
});
test("existing call, mailbox and CRM read handlers receive the original auth and narrowed tenant", async () => {
  const f = await fixture({ permissions: grants("workspace_call_history", "workspace_voicemail", "crm_contacts") });
  const data = (await f.search()).json(); assert.equal(f.forwarded.length, 5);
  for (const call of f.forwarded) assert.equal(call.headers.authorization, "Bearer original-session");
  assert.equal(f.forwarded.find(c => c.path === "/calls/history")?.query.searchOnly, "1");
  assert.deepEqual(f.forwarded.filter(c => c.path === "/voice/voicemail").map(c => c.query.folder).sort(), ["inbox", "old", "urgent"]);
  for (const call of f.forwarded.filter(c => c.path === "/voice/voicemail")) { assert.equal(call.query.tenantId, "own"); assert.equal(call.query.q, "alice"); assert.equal(call.query.pageSize, "5"); }
  assert(!JSON.stringify(data).includes("NEVER_RETURN")); assert(data.results.some((r: any) => r.href === "/crm/contacts/crm-contact")); await f.app.close();
});
test("global platform search does not aggregate private mailboxes or chats", async () => {
  const f = await fixture({ role: "SUPER_ADMIN", permissions: grants("workspace_voicemail", "workspace_chat", "workspace_contacts", "workspace_team_directory", "crm_contacts", "admin_tenants") });
  await f.search("/search/global?q=acme&scope=GLOBAL"); assert.deepEqual(f.calls.map(c => c.model), ["tenant"]); assert.equal(f.forwarded.length, 0); await f.app.close();
});
test("private chat queries require active membership and exclude individually deleted messages", async () => {
  const f = await fixture({ permissions: grants("workspace_chat"), rows: { connectChatMessage: [
    { id: "hidden", body: "secret", threadId: "t", deletedForUserIds: ["viewer"], thread: { title: "Chat" } },
    { id: "visible", body: "hello", threadId: "t", deletedForUserIds: null, thread: { title: "Chat" } },
  ] } });
  const data = (await f.search()).json(); assert.equal(data.results.length, 1); assert.equal(data.results[0].description, "hello");
  const message = f.calls.find(c => c.model === "connectChatMessage")!;
  assert.deepEqual(message.args.where.thread.participants, { some: { userId: "viewer", leftAt: null, archivedForUser: false } });
  assert.equal(message.args.where.deletedForEveryoneAt, null); assert.equal(message.args.where.tenantId, "own"); await f.app.close();
});
test("tenant chat capability changes membership scope, never tenant scope", async () => {
  const f = await fixture({ permissions: [...grants("workspace_chat"), "can_view_tenant_chats"] }); await f.search();
  const message = f.calls.find(c => c.model === "connectChatMessage")!; assert.equal(message.args.where.thread.participants, undefined); assert.equal(message.args.where.thread.tenantId, "own"); await f.app.close();
});
test("source failures return successful partial results without leaking error details", async () => {
  const f = await fixture({ permissions: grants("workspace_contacts"), fail: "contact", rows: { extension: [{ id: "ext", extNumber: "101", displayName: "Alice" }] } });
  const response = await f.search(); assert.equal(response.statusCode, 200); assert.deepEqual(response.json().unavailable, ["Contacts"]); assert.equal(response.json().results.length, 1); await f.app.close();
});
test("invoices require both their own permission and billing role and never widen the legacy tenant scope", async () => {
  for (const options of [{ role: "USER", permissions: [...grants("billing_overview"), "can_view_billing_invoices"] }, { role: "ADMIN", permissions: grants("billing_overview") }]) {
    const f = await fixture(options); await f.search(); assert.equal(f.calls.length, 0); await f.app.close();
  }
  const f = await fixture({ role: "ADMIN", permissions: [...grants("billing_overview"), "can_view_billing_invoices"] }); await f.search(); assert.equal(f.calls[0]?.args.where.tenantId, "own"); assert.equal(f.calls[0]?.args.select.payToken, undefined); await f.app.close();
});
test("metadata projections are explicit and bounded", async () => {
  const f = await fixture({ role: "SUPER_ADMIN", permissions: [...grants("workspace_contacts", "workspace_team_directory", "workspace_chat", "admin_users", "admin_tenants", "admin_phone_numbers", "billing_overview"), "can_view_billing_invoices"] }); await f.search();
  for (const call of f.calls) { assert(call.args.select); assert(call.args.take <= 24); assert.equal(call.args.include, undefined); const fields = JSON.stringify(call.args.select); assert(!/password|secret|payToken|providerMetadata|sipPassword/i.test(fields)); }
  await f.app.close();
});
