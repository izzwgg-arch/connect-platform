import type { FastifyInstance } from "fastify";
import type { db as database } from "@connect/db";
import { isNavItemHiddenBySetting, type PortalNavVisibility } from "@connect/shared";
import { contactVisibleToUserWhere } from "./contactVisibility.js";

type Viewer = { sub: string; role: string; tenantId?: string | null };
type Result = { id: string; title: string; description: string; kind: "record"; href: string; navId: string };
type Dependencies = {
  db: typeof database;
  permissions: (role: string, userId: string, tenantId?: string | null) => Promise<readonly string[] | null>;
  visibility: () => Promise<PortalNavVisibility>;
  tenantIds: (id: string | null) => Promise<string[] | null>;
};
const viewRoles = new Set(["USER", "EXTENSION_USER", "READ_ONLY", "SUPPORT", "MESSAGING", "BILLING", "MANAGER", "ADMIN", "TENANT_ADMIN", "SUPER_ADMIN"]);
const adminRoles = new Set(["ADMIN", "TENANT_ADMIN", "SUPER_ADMIN"]);
const billingRoles = new Set(["ADMIN", "TENANT_ADMIN", "SUPER_ADMIN", "BILLING", "BILLING_ADMIN"]);
const contains = (value: string) => ({ contains: value, mode: "insensitive" as const });
const text = (value: unknown) => typeof value === "string" ? value : "";
const linkQuery = (path: string, q: string) => `${path}?q=${encodeURIComponent(q)}`;
const record = (navId: string, id: string, title: string, description: string, href: string): Result => ({ id: `${navId}:${id}`, kind: "record", navId, title, description, href });

/** Federated read-only search. Each provider must enforce both page access and its data scope. */
export function registerGlobalSearchRoutes(app: FastifyInstance, deps: Dependencies) {
  app.get("/search/global", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const user = req.user as Viewer;
    if (!user?.sub) return reply.code(401).send({ error: "unauthorized" });
    const query = req.query as { q?: unknown; scope?: unknown };
    const q = text(query.q).trim().slice(0, 120);
    if (q.length < 2) return { results: [] };
    const permissions = await deps.permissions(user.role, user.sub, user.tenantId);
    // Resolver failure must never fall back to a broader built-in role.
    if (!permissions) return reply.code(503).send({ error: "search_permissions_unavailable" });
    const keys = new Set(permissions);
    const visibility = await deps.visibility();
    const allowed = (navId: string, permission: string, section = navId.split(".")[0]) => keys.has(`can_view_section_${section}`) && keys.has(permission) && !isNavItemHiddenBySetting(navId, visibility);
    const superAdmin = user.role === "SUPER_ADMIN";
    const global = superAdmin && query.scope === "GLOBAL";
    const header = text(req.headers["x-tenant-context"]);
    const selected = superAdmin && !global && header && header !== "global" ? header : user.tenantId;
    const tenantIds = global ? null : selected ? await deps.tenantIds(selected) : [];
    // Empty / unresolved scope is no access, never a global query.
    if (!global && !tenantIds?.length) return { results: [] };
    const tenantId = tenantIds?.find(id => !id.startsWith("vpbx:") && !id.startsWith("local:"));
    const scope = global ? {} : { tenantId: { in: tenantIds! } };
    const jobs: { name: string; run: () => Promise<Result[]> }[] = [];
    const add = (name: string, enabled: boolean, run: () => Promise<Result[]>) => { if (enabled) jobs.push({ name, run }); };
    const db = deps.db;
    const canView = viewRoles.has(user.role);
    const contacts = !global && Boolean(tenantId) && allowed("workspace.contacts", "can_view_workspace_contacts") && canView;
    add("Contacts", contacts, async () => (await db.contact.findMany({
      // ⛔ A colleague's private phone book never shows in search (contactVisibility.ts).
      where: { ...scope, active: true, archivedAt: null, AND: [contactVisibleToUserWhere(user.sub)], OR: [{ displayName: contains(q) }, { firstName: contains(q) }, { lastName: contains(q) }, { company: contains(q) }, { phones: { some: { OR: [{ numberRaw: contains(q) }, { numberNormalized: contains(q.replace(/[^+\d]/g, "") || q) }] } } }, { emails: { some: { email: contains(q) } } }] },
      select: { id: true, displayName: true, company: true, phones: { take: 1, orderBy: { isPrimary: "desc" }, select: { numberRaw: true } }, emails: { take: 1, orderBy: { isPrimary: "desc" }, select: { email: true } } }, take: 8, orderBy: { displayName: "asc" },
    })).map(r => record("workspace.contacts", r.id, r.displayName || r.phones[0]?.numberRaw || "Contact", ["Contact", r.company, r.phones[0]?.numberRaw, r.emails[0]?.email].filter(Boolean).join(" · "), linkQuery("/contacts", r.displayName || q))));
    const team = !global && Boolean(tenantId) && allowed("workspace.team", "can_view_workspace_team_directory") && canView;
    add("Extensions", team || contacts, async () => (await db.extension.findMany({
      where: { ...scope, status: "ACTIVE", OR: [{ extNumber: contains(q) }, { displayName: contains(q) }] },
      select: { id: true, extNumber: true, displayName: true }, take: 8, orderBy: { extNumber: "asc" },
    })).map(r => record(team ? "workspace.team" : "workspace.contacts", r.id, r.displayName || `Extension ${r.extNumber}`, `Extension · ${r.extNumber}`, linkQuery(team ? "/team" : "/contacts", r.extNumber))));
    // Legacy invoice endpoints scope to the JWT tenant even for platform staff.
    add("Invoices", Boolean(user.tenantId) && (!superAdmin || (!global && Boolean(tenantIds?.includes(user.tenantId!)))) && billingRoles.has(user.role) && allowed("billing.overview", "can_view_billing_overview") && keys.has("can_view_billing_invoices"), async () => (await db.invoice.findMany({
      where: { tenantId: user.tenantId!, OR: [{ id: contains(q) }, { customerEmail: contains(q) }, { customerPhone: contains(q) }, { providerInvoiceRef: contains(q) }] },
      select: { id: true, customerEmail: true, status: true, providerInvoiceRef: true }, take: 8, orderBy: { createdAt: "desc" },
    })).map(r => record("billing.overview", r.id, `Invoice ${r.providerInvoiceRef || r.id}`, [r.status, r.customerEmail].filter(Boolean).join(" · "), `/billing/invoices/${encodeURIComponent(r.id)}`)));
    add("Users", adminRoles.has(user.role) && allowed("admin.users", "can_view_admin_users"), async () => (await db.user.findMany({
      where: { ...scope, ...(global ? { tenant: { kind: "CUSTOMER", isApproved: true } } : {}), OR: [{ displayName: contains(q) }, { firstName: contains(q) }, { lastName: contains(q) }, { email: contains(q) }] },
      select: { id: true, displayName: true, firstName: true, lastName: true, email: true }, take: 8, orderBy: { email: "asc" },
    })).map(r => record("admin.users", r.id, r.displayName || [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email, `User · ${r.email}`, linkQuery("/admin/users", r.email))));
    add("Companies", adminRoles.has(user.role) && allowed("admin.tenants", "can_view_admin_tenants"), async () => (await db.tenant.findMany({
      where: { ...(!global ? { id: { in: tenantIds! } } : {}), name: contains(q) }, select: { id: true, name: true }, take: 8, orderBy: { name: "asc" },
    })).map(r => record("admin.tenants", r.id, r.name, "Company", linkQuery("/admin/tenants", r.name))));
    add("Phone numbers", superAdmin && allowed("admin.phone_numbers", "can_view_admin_phone_numbers"), async () => (await db.phoneNumber.findMany({
      where: { ...scope, OR: [{ phoneNumber: contains(q) }, { friendlyName: contains(q) }] },
      select: { id: true, phoneNumber: true, friendlyName: true }, take: 8, orderBy: { phoneNumber: "asc" },
    })).map(r => record("admin.phone_numbers", r.id, r.phoneNumber, `Phone number · ${r.friendlyName || ""}`, linkQuery("/admin/phone-numbers", r.phoneNumber))));
    // Chat supports one selected tenant; never aggregate private conversations across companies.
    const chatScope = { tenantId: tenantId || "", active: true, ...(!keys.has("can_view_tenant_chats") ? { participants: { some: { userId: user.sub, leftAt: null, archivedForUser: false } } } : {}) };
    add("Conversations", Boolean(tenantId) && allowed("workspace.chat", "can_view_workspace_chat"), async () => (await db.connectChatThread.findMany({
      where: { ...chatScope, OR: [{ title: contains(q) }, { externalSmsE164: contains(q) }, { participants: { some: { leftAt: null, user: { OR: [{ displayName: contains(q) }, { email: contains(q) }] } } } }] },
      select: { id: true, title: true, externalSmsE164: true }, take: 8, orderBy: { lastMessageAt: "desc" },
    })).map(r => record("workspace.chat", r.id, r.title || r.externalSmsE164 || "Conversation", "Chat · Conversation", `/chat?threadId=${encodeURIComponent(r.id)}`)));
    add("Messages", Boolean(tenantId) && allowed("workspace.chat", "can_view_workspace_chat"), async () => (await db.connectChatMessage.findMany({
      where: { tenantId: tenantId!, deletedForEveryoneAt: null, thread: chatScope, body: contains(q) },
      select: { id: true, body: true, threadId: true, deletedForUserIds: true, thread: { select: { title: true, externalSmsE164: true } } }, take: 24, orderBy: { createdAt: "desc" },
    })).filter(r => !Array.isArray(r.deletedForUserIds) || !r.deletedForUserIds.includes(user.sub)).slice(0, 8)
      .map(r => record("workspace.chat", r.id, r.thread.title || r.thread.externalSmsE164 || "Chat message", r.body.slice(0, 180), `/chat?threadId=${encodeURIComponent(r.threadId)}`)));

    // Re-enter existing read handlers with the original JWT: mailbox ownership,
    // linked SIP call scope and CRM campaign assignments remain authoritative.
    // Only these fixed GET paths are callable; no caller-supplied URL or method.
    const read = async (path: string, params: Record<string, string>): Promise<any> => {
      const headers: Record<string, string> = {};
      if (req.headers.authorization) headers.authorization = req.headers.authorization;
      if (tenantId) headers["x-tenant-context"] = tenantId;
      const response = await app.inject({ method: "GET", url: `${path}?${new URLSearchParams(params)}`, headers });
      if (response.statusCode === 401 || response.statusCode === 403) return {};
      if (response.statusCode !== 200) throw new Error(`search_source_${response.statusCode}`);
      return response.json();
    };
    add("Call history", canView && allowed("workspace.calls", "can_view_workspace_call_history"), async () => {
      const data = await read("/calls/history", { search: q, searchOnly: "1", pageSize: "10", startDate: "2000-01-01T00:00:00.000Z", ...(selected && !global ? { tenantId: selected } : {}) });
      return (data.items ?? []).slice(0, 8).map((r: any) => record("workspace.calls", text(r.rowId) || text(r.callId), text(r.fromName) || text(r.fromNumber) || "Call", `Call · ${text(r.fromNumber)} → ${text(r.toNumber)} · ${text(r.startedAt).slice(0, 10)}`, `/calls?${new URLSearchParams({ q, date: text(r.startedAt).slice(0, 10) })}`));
    });
    add("Voicemail", Boolean(selected) && !global && canView && allowed("workspace.voicemail", "can_view_workspace_voicemail"), async () => {
      const folders = await Promise.all(["inbox", "old", "urgent"].map(folder => read("/voice/voicemail", { q, folder, tenantId: selected!, pageSize: "5" })));
      return folders.flatMap(data => (data.voicemails ?? []).map((r: any) => record("workspace.voicemail", text(r.id), text(r.callerName) || text(r.callerId) || "Voicemail", `Voicemail · ${text(r.callerId)} · Ext ${text(r.extension)} · ${text(r.receivedAt).slice(0, 10)}`, `/voicemail?${new URLSearchParams({ q, folder: text(r.folder) })}`))).slice(0, 8);
    });
    add("CRM contacts", Boolean(tenantId) && allowed("crm.contacts", "can_view_crm_contacts"), async () => {
      const data = await read("/crm/contacts", { q, limit: "8", page: "0" });
      return (data.rows ?? []).map((r: any) => record("crm.contacts", text(r.id), text(r.displayName) || "CRM contact", ["CRM contact", text(r.company), text(r.primaryPhone?.numberRaw), text(r.primaryEmail?.email)].filter(Boolean).join(" · "), `/crm/contacts/${encodeURIComponent(text(r.id))}`));
    });
    const settled = await Promise.allSettled(jobs.map(job => job.run()));
    const results: Result[] = [];
    const unavailable: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") results.push(...result.value);
      else { unavailable.push(jobs[index]!.name); app.log.warn({ source: jobs[index]!.name }, "[global-search] source unavailable"); }
    });
    return { results, unavailable };
  });
}
