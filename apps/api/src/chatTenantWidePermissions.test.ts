import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

// In-memory state for chat
const state = {
  tenants: new Map<string, { id: string; name: string }>(),
  threads: new Map<string, any>(),
  parts: new Array<any>(),
  messages: new Map<string, any[]>(),
};

function reset() {
  state.tenants.clear();
  state.threads.clear();
  state.parts = [];
  state.messages.clear();
}

function seedTenant(id: string, name = id) {
  state.tenants.set(id, { id, name });
}

function seedThread(id: string, tenantId: string, type: "DM" | "GROUP" | "SMS" | "TENANT_GROUP" = "DM") {
  const thread = { id, tenantId, type, title: null, active: true, lastMessageAt: new Date(), isDefaultTenantGroup: false, tenantSmsE164: null, externalSmsE164: null };
  state.threads.set(id, thread);
  state.messages.set(id, [ { id: `${id}_m1`, threadId: id, createdAt: new Date(), type: "TEXT", body: "hi", senderUserId: null, deletedForEveryoneAt: null, reactions: [], attachments: [] } ]);
}

function addParticipant(threadId: string, userId: string) {
  state.parts.push({ threadId, userId, leftAt: null });
}

// Dynamic permission flag for tests
let allowTenantWideChat = false;

mock.module("./smsInboxParticipants", {
  namedExports: {
    listSharedSmsInboxParticipantUserIds: async () => [],
    upsertSmsThreadParticipants: async () => {},
  },
});

mock.module("./platformRolePermissions", {
  namedExports: {
    hasEffectivePortalPermission: async (_user: any, perm: string) => {
      if (perm === "can_view_tenant_chats") return allowTenantWideChat;
      return false;
    },
  },
});

mock.module("@connect/db", {
  namedExports: {
    db: {
      tenant: {
        findUnique: async ({ where }: any) => state.tenants.get(where.id) || null,
      },
      globalVoipMsConfig: {
        findUnique: async () => null,
        update: async () => ({}),
        upsert: async () => ({}),
      },
      connectChatThread: {
        findMany: async ({ where, include, orderBy, take }: any) => {
          const rows = Array.from(state.threads.values()).filter((t) => t.tenantId === where.tenantId && t.active === where.active);
          rows.sort((a, b) => (b.lastMessageAt as Date).getTime() - (a.lastMessageAt as Date).getTime());
          const sliced = typeof take === "number" ? rows.slice(0, take) : rows;
          return sliced.map((t) => ({
            ...t,
            messages: include?.messages ? state.messages.get(t.id)!.slice(-1) : undefined,
            participants: include?.participants
              ? state.parts.filter((p) => p.threadId === t.id).map((p) => ({ ...p, user: { id: p.userId, email: `${p.userId}@t.local` }, extension: null }))
              : undefined,
          }));
        },
        findFirst: async ({ where, select }: any) => {
          const t = state.threads.get(where.id);
          if (!t) return null;
          if (where.tenantId && t.tenantId !== where.tenantId) return null;
          if (select) {
            const out: any = {};
            for (const k of Object.keys(select)) out[k] = (t as any)[k];
            return out;
          }
          return t;
        },
        findUnique: async ({ where, select }: any) => {
          const t = state.threads.get(where.id);
          if (!t) return null;
          if (select) {
            const out: any = {};
            for (const k of Object.keys(select)) out[k] = (t as any)[k];
            return out;
          }
          return t;
        },
        create: async ({ data }: any) => {
          const id = data.id || data.dedupeKey || `thr_${state.threads.size + 1}`;
          const row = { id, active: true, lastMessageAt: new Date(), isDefaultTenantGroup: false, tenantSmsE164: null, externalSmsE164: null, ...data };
          state.threads.set(id, row);
          state.messages.set(id, []);
          return row;
        },
      },
      connectChatParticipant: {
        findMany: async ({ where, include, orderBy }: any) => {
          const rows = state.parts.filter((p) => (
            (!where.userId || p.userId === where.userId)
            && (!where.leftAt || p.leftAt === where.leftAt)
            && (!where.thread?.tenantId || state.threads.get(p.threadId)?.tenantId === where.thread.tenantId)
            && (!where.thread?.active || state.threads.get(p.threadId)?.active === where.thread.active)
          ));
          rows.sort((a, b) => (state.threads.get(b.threadId)!.lastMessageAt as Date).getTime() - (state.threads.get(a.threadId)!.lastMessageAt as Date).getTime());
          if (include?.thread) {
            return rows.map((p) => ({
              ...p,
              thread: {
                ...state.threads.get(p.threadId)!,
                messages: include.thread.include?.messages ? state.messages.get(p.threadId)!.slice(-1) : undefined,
                participants: include.thread.include?.participants
                  ? state.parts.filter((pp) => pp.threadId === p.threadId).map((pp) => ({ ...pp, user: { id: pp.userId, email: `${pp.userId}@t.local` }, extension: null }))
                  : undefined,
              },
            }));
          }
          if (include?.user) {
            return rows.map((p) => ({ ...p, user: { id: p.userId, email: `${p.userId}@t.local` } }));
          }
          return rows;
        },
        findFirst: async ({ where, select }: any) => {
          const found = state.parts.find((p) => p.threadId === where.threadId && p.userId === where.userId && p.leftAt === where.leftAt && (!where.thread?.tenantId || state.threads.get(p.threadId)?.tenantId === where.thread.tenantId));
          if (!found) return null;
          if (select) {
            const out: any = {};
            for (const k of Object.keys(select)) out[k] = (found as any)[k];
            return out;
          }
          return found;
        },
        upsert: async () => ({}),
        update: async () => ({}),
      },
      connectChatMessage: {
        findMany: async ({ where, include, orderBy, take }: any) => {
          const rows = (state.messages.get(where.threadId) || []).slice();
          rows.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
          const capped = typeof take === "number" ? rows.slice(0, take) : rows;
          return capped.map((m) => ({ ...m, senderUser: { email: "system@t.local" }, attachments: [], replyTo: null }));
        },
        count: async () => 0,
      },
      connectChatMessageAttachment: {
        findMany: async () => [],
      },
      user: {
        findUnique: async () => ({ id: "u1", email: "u1@t.local" }),
        findMany: async () => [],
      },
      tenantSmsNumber: { findMany: async () => [] },
      extension: { findMany: async () => [] },
      globalVoipMsCredential: { findUnique: async () => null },
      $queryRaw: async () => [],
    },
  },
});

let registerConnectChatRoutes: any;
async function loadRoutes() {
  ({ registerConnectChatRoutes } = await import("./connectChatRoutes"));
}

function buildApp(user: { sub: string; tenantId: string; role: string }) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => { (req as any).user = user; });
  // deps.smsQueue only used for send — not needed for GET tests
  registerConnectChatRoutes(app, { smsQueue: { add: async () => {} } as any });
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("chat: normal user sees only own-participant tenant threads; tenant-wide shows all in-tenant", async () => {
  await loadRoutes();
  reset();
  seedTenant("t1", "Tenant One");
  seedTenant("t2", "Tenant Two");
  seedThread("t1a", "t1", "DM");
  seedThread("t1b", "t1", "GROUP");
  seedThread("t2a", "t2", "DM");
  addParticipant("t1a", "u1"); // user participates in t1a only

  const app = buildApp({ sub: "u1", tenantId: "t1", role: "END_USER" });

  // No tenant-wide permission
  allowTenantWideChat = false;
  const res1 = await app.inject({ method: "GET", url: "/chat/threads" });
  assert.equal(res1.statusCode, 200);
  const body1 = JSON.parse(res1.body);
  const ids1 = body1.threads.map((t: any) => t.id).sort();
  assert.deepEqual(ids1, ["t1a"], "participant-only view should exclude t1b and t2a");

  // Enable tenant-wide
  allowTenantWideChat = true;
  const res2 = await app.inject({ method: "GET", url: "/chat/threads" });
  assert.equal(res2.statusCode, 200);
  const body2 = JSON.parse(res2.body);
  const ids2 = body2.threads.map((t: any) => t.id).sort();
  // Should include both seeded same-tenant threads; may also include default tenant group (tg:t1)
  assert.ok(ids2.includes("t1a") && ids2.includes("t1b"), "tenant-wide should include all same-tenant threads");
  assert.ok(!ids2.includes("t2a"), "tenant-wide should exclude cross-tenant threads");

  await app.close();
});

test("chat: messages require participation unless tenant-wide; cross-tenant blocked", async () => {
  await loadRoutes();
  reset();
  seedTenant("t1", "Tenant One");
  seedTenant("t2", "Tenant Two");
  seedThread("t1a", "t1", "DM");
  seedThread("t1b", "t1", "GROUP");
  seedThread("t2a", "t2", "DM");
  addParticipant("t1a", "u1");

  const app = buildApp({ sub: "u1", tenantId: "t1", role: "END_USER" });

  // No tenant-wide: cannot read t1b (not a participant)
  allowTenantWideChat = false;
  const miss = await app.inject({ method: "GET", url: "/chat/threads/t1b/messages" });
  assert.equal(miss.statusCode, 404);

  // With tenant-wide: can read same-tenant t1b
  allowTenantWideChat = true;
  const ok = await app.inject({ method: "GET", url: "/chat/threads/t1b/messages" });
  assert.equal(ok.statusCode, 200);
  const body = JSON.parse(ok.body);
  assert.ok(Array.isArray(body.messages));

  // Cross-tenant thread remains blocked (not found in effective tenant)
  const cross = await app.inject({ method: "GET", url: "/chat/threads/t2a/messages" });
  assert.equal(cross.statusCode, 404);

  await app.close();
});
