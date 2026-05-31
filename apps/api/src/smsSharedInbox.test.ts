/**
 * Shared tenant SMS inbox — participant fan-out, send permission, reply access.
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { buildSmsDedupeKey, isSharedTenantSmsInbox } from "@connect/shared";

const state = {
  tenants: new Map<string, { id: string; name: string }>(),
  users: new Map<string, { id: string; tenantId: string; role: string; email: string }>(),
  threads: new Map<string, any>(),
  parts: [] as any[],
  messages: new Map<string, any[]>(),
  smsNumbers: new Map<string, any>(),
  extensions: new Map<string, any>(),
  customRoles: new Map<string, string[]>(),
  snapshot: null as Record<string, string[]> | null,
  participantUpserts: [] as any[],
};

function reset() {
  state.tenants.clear();
  state.users.clear();
  state.threads.clear();
  state.parts = [];
  state.messages.clear();
  state.smsNumbers.clear();
  state.extensions.clear();
  state.customRoles.clear();
  state.snapshot = null;
  state.participantUpserts = [];
}

function seedTenant(id: string, name = id) {
  state.tenants.set(id, { id, name });
}

function seedUser(id: string, tenantId: string, role = "USER", email?: string) {
  state.users.set(id, { id, tenantId, role, email: email || `${id}@t.local` });
}

function seedSmsNumber(input: {
  id: string;
  tenantId: string;
  phoneE164: string;
  assignedUserId?: string | null;
  assignedExtensionId?: string | null;
}) {
  state.smsNumbers.set(input.phoneE164, { active: true, smsCapable: true, mmsCapable: false, isTenantDefault: false, ...input });
}

function seedExtension(id: string, tenantId: string, ownerUserId: string | null, extNumber = "101") {
  state.extensions.set(id, { id, tenantId, ownerUserId, extNumber, status: "ACTIVE" });
}

function addParticipant(threadId: string, userId: string) {
  state.parts.push({ threadId, userId, leftAt: null, participantKey: `u:${userId}` });
}

let allowTenantWideChat = false;
let allowSendSms = true;
let sharedEligibleUserIds: string[] | null = null;

mock.module("./platformRolePermissions", {
  namedExports: {
    hasEffectivePortalPermission: async (_user: any, perm: string) => {
      if (perm === "can_view_tenant_chats") return allowTenantWideChat;
      if (perm === "can_send_sms") return allowSendSms;
      return false;
    },
    jwtRoleToPortalPermissionBucket: (role: string) => {
      const r = String(role || "").toUpperCase();
      if (r === "SUPER_ADMIN") return "SUPER_ADMIN";
      if (["ADMIN", "TENANT_ADMIN", "MESSAGING"].includes(r)) return "TENANT_ADMIN";
      return "END_USER";
    },
    getEffectivePortalPermissionListForBucket: async (bucket: string) => {
      const base = bucket === "TENANT_ADMIN"
        ? ["can_send_sms", "can_view_tenant_chats", "can_view_chat"]
        : allowSendSms
          ? ["can_send_sms", "can_view_chat"]
          : ["can_view_chat"];
      return base;
    },
  },
});

mock.module("./smsInboxParticipants", {
  namedExports: {
    listSharedSmsInboxParticipantUserIds: async (_tenantId: string) => {
      if (sharedEligibleUserIds) return sharedEligibleUserIds;
      return [...state.users.values()].filter((u) => u.tenantId === _tenantId && u.id !== "u_no_sms").map((u) => u.id);
    },
    upsertSmsThreadParticipants: async (input: any) => {
      state.participantUpserts.push(input);
      const userIds = input.inboxOwnerUserId
        ? [input.inboxOwnerUserId]
        : (sharedEligibleUserIds ?? [...state.users.values()].filter((u) => u.tenantId === input.tenantId && u.id !== "u_no_sms").map((u) => u.id));
      const all = [...new Set([...userIds, ...(input.ensureUserIds ?? [])])];
      for (const uid of all) {
        if (!state.parts.some((p) => p.threadId === input.threadId && p.userId === uid)) {
          state.parts.push({ threadId: input.threadId, userId: uid, leftAt: null, participantKey: `u:${uid}` });
        }
      }
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
        findUnique: async () => ({ id: "default", credentialsEncrypted: "x", smsEnabled: true, mmsEnabled: true }),
        update: async () => ({}),
        upsert: async () => ({}),
      },
      user: {
        findMany: async ({ where }: any) =>
          [...state.users.values()].filter((u) => !where.tenantId || u.tenantId === where.tenantId),
        findUnique: async ({ where }: any) => state.users.get(where.id) || null,
        findFirst: async ({ where }: any) => {
          const rows = [...state.users.values()].filter((u) => {
            if (where.id && u.id !== where.id) return false;
            if (where.tenantId && u.tenantId !== where.tenantId) return false;
            return true;
          });
          return rows[0] || null;
        },
      },
      extension: {
        findMany: async ({ where }: any) =>
          [...state.extensions.values()].filter((e) => e.tenantId === where.tenantId && e.status === where.status),
        findFirst: async ({ where }: any) => {
          const e = state.extensions.get(where.id);
          if (!e) return null;
          if (where.tenantId && e.tenantId !== where.tenantId) return null;
          return e;
        },
      },
      tenantSmsNumber: {
        findMany: async () => [...state.smsNumbers.values()],
        findFirst: async ({ where }: any) => {
          for (const row of state.smsNumbers.values()) {
            if (where.id && row.id !== where.id) continue;
            if (where.tenantId && row.tenantId !== where.tenantId) continue;
            if (where.phoneE164 && row.phoneE164 !== where.phoneE164) continue;
            if (where.active === true && !row.active) continue;
            if (where.assignedExtensionId && row.assignedExtensionId !== where.assignedExtensionId) continue;
            if (where.assignedUserId === null && row.assignedUserId != null) continue;
            if (where.assignedExtensionId === null && row.assignedExtensionId != null) continue;
            return row;
          }
          return null;
        },
        findUnique: async ({ where }: any) => state.smsNumbers.get(where.phoneE164) || null,
      },
      connectChatThread: {
        findMany: async ({ where, include }: any) => {
          const rows = [...state.threads.values()].filter((t) => t.tenantId === where.tenantId && t.active !== false);
          return rows.map((t) => ({
            ...t,
            messages: include?.messages ? (state.messages.get(t.id) || []).slice(-1) : undefined,
            participants: include?.participants
              ? state.parts.filter((p) => p.threadId === t.id).map((p) => ({
                  ...p,
                  user: state.users.get(p.userId),
                  extension: null,
                }))
              : undefined,
          }));
        },
        findFirst: async ({ where, select }: any) => {
          let t = where.id ? state.threads.get(where.id) : [...state.threads.values()].find((row) => {
            if (where.tenantId && row.tenantId !== where.tenantId) return false;
            if (where.tenantSmsE164 && row.tenantSmsE164 !== where.tenantSmsE164) return false;
            if (where.externalSmsE164 && row.externalSmsE164 !== where.externalSmsE164) return false;
            return true;
          });
          if (!t) return null;
          if (where.tenantId && t.tenantId !== where.tenantId) return null;
          if (select) {
            const out: any = {};
            for (const k of Object.keys(select)) out[k] = t[k];
            return out;
          }
          return t;
        },
        findUnique: async ({ where }: any) => {
          if (where.dedupeKey) {
            return [...state.threads.values()].find((t) => t.dedupeKey === where.dedupeKey) || null;
          }
          return state.threads.get(where.id) || null;
        },
        create: async ({ data }: any) => {
          const id = data.id || `thr_${state.threads.size + 1}`;
          const row = { id, active: true, ...data };
          state.threads.set(id, row);
          state.messages.set(id, []);
          return row;
        },
        update: async ({ where, data }: any) => {
          const t = state.threads.get(where.id);
          Object.assign(t, data);
          return t;
        },
      },
      connectChatParticipant: {
        findMany: async ({ where, include }: any) => {
          return state.parts.filter((p) => {
            if (where.threadId && p.threadId !== where.threadId) return false;
            if (where.userId && p.userId !== where.userId) return false;
            if (where.leftAt !== undefined && p.leftAt !== where.leftAt) return false;
            if (where.thread?.tenantId) {
              const t = state.threads.get(p.threadId);
              if (!t || t.tenantId !== where.thread.tenantId) return false;
            }
            return true;
          }).map((p) => ({
            ...p,
            user: include?.user ? state.users.get(p.userId) : undefined,
            thread: include?.thread ? state.threads.get(p.threadId) : undefined,
          }));
        },
        findFirst: async ({ where }: any) =>
          state.parts.find((p) =>
            p.threadId === where.threadId &&
            p.userId === where.userId &&
            p.leftAt === where.leftAt &&
            (!where.thread?.tenantId || state.threads.get(p.threadId)?.tenantId === where.thread.tenantId),
          ) || null,
        create: async ({ data }: any) => {
          state.parts.push({ ...data, leftAt: null });
          return data;
        },
        upsert: async () => ({}),
        update: async () => ({}),
      },
      connectChatMessage: {
        findMany: async ({ where }: any) => (state.messages.get(where.threadId) || []),
        findFirst: async () => null,
        create: async ({ data }: any) => {
          const row = { id: `msg_${Math.random()}`, createdAt: new Date(), ...data };
          const list = state.messages.get(data.threadId) || [];
          list.push(row);
          state.messages.set(data.threadId, list);
          return row;
        },
        count: async () => 0,
        delete: async () => ({}),
        update: async () => ({}),
      },
      connectChatMessageAttachment: { findMany: async () => [], findFirst: async () => null, create: async () => ({}) },
      $queryRaw: async () => [],
      smsRoutingLog: { create: async () => ({}) },
      globalVoipMsCredential: { findUnique: async () => null },
      platformRolePermissionSnapshot: { findUnique: async () => null },
      userCustomRole: { findMany: async () => [] },
    },
  },
});

mock.module("@connect/security", {
  namedExports: {
    decryptJson: () => ({ username: "u", password: "p" }),
    encryptJson: (x: unknown) => x,
    hasCredentialsMasterKey: () => true,
  },
});

let registerConnectChatRoutes: any;
async function loadRoutes() {
  ({ registerConnectChatRoutes } = await import("./connectChatRoutes"));
}

function buildApp(user: { sub: string; tenantId: string; role: string }) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => { (req as any).user = user; });
  registerConnectChatRoutes(app, { smsQueue: { add: async () => {} } as any });
  return app;
}

test("shared inbox dedupe uses empty inboxScope", () => {
  const dk = buildSmsDedupeKey("t1", "+15551111111", "+15552222222", "");
  assert.equal(dk, "sms:t1:+15551111111:+15552222222:");
  assert.ok(isSharedTenantSmsInbox(""));
});

test("outbound-first shared tenant SMS fans out eligible participants", async () => {
  await loadRoutes();
  reset();
  allowSendSms = true;
  sharedEligibleUserIds = ["u1", "u2"];
  seedTenant("t1");
  seedUser("u1", "t1");
  seedUser("u2", "t1");
  seedSmsNumber({ id: "n1", tenantId: "t1", phoneE164: "+15551111111" });

  const app = buildApp({ sub: "u1", tenantId: "t1", role: "USER" });
  const res = await app.inject({
    method: "POST",
    url: "/chat/threads",
    payload: { type: "sms", externalPhone: "+15559998888" },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  const thread = state.threads.get(body.threadId);
  assert.equal(thread.smsInboxOwnerUserId, "");
  assert.ok(state.participantUpserts.length >= 1);
  const partUserIds = state.parts.filter((p) => p.threadId === body.threadId).map((p) => p.userId).sort();
  assert.deepEqual(partUserIds, ["u1", "u2"]);
  await app.close();
});

test("personal extension SMS keeps single-owner inboxScope", async () => {
  await loadRoutes();
  reset();
  seedTenant("t1");
  seedUser("u1", "t1");
  seedUser("u2", "t1");
  seedExtension("e1", "t1", "u2");
  seedSmsNumber({ id: "n1", tenantId: "t1", phoneE164: "+15551111111", assignedExtensionId: "e1" });

  const app = buildApp({ sub: "u2", tenantId: "t1", role: "USER" });
  const res = await app.inject({
    method: "POST",
    url: "/chat/threads",
    payload: { type: "sms", externalPhone: "+15559998888" },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  const thread = state.threads.get(body.threadId);
  assert.equal(thread.smsInboxOwnerUserId, "u2");
  const partUserIds = state.parts.filter((p) => p.threadId === body.threadId).map((p) => p.userId);
  assert.deepEqual(partUserIds, ["u2"]);
  await app.close();
});

test("extension without owner falls back to shared tenant inbox", async () => {
  await loadRoutes();
  reset();
  sharedEligibleUserIds = ["u1"];
  seedTenant("t1");
  seedUser("u1", "t1");
  seedExtension("e1", "t1", null);
  seedSmsNumber({ id: "n1", tenantId: "t1", phoneE164: "+15551111111", assignedExtensionId: "e1" });

  const app = buildApp({ sub: "u1", tenantId: "t1", role: "USER" });
  const res = await app.inject({
    method: "POST",
    url: "/chat/threads",
    payload: { type: "sms", externalPhone: "+15559998888" },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(state.threads.get(body.threadId).smsInboxOwnerUserId, "");
  await app.close();
});

test("viewer with send permission can reply to shared inbox without prior participant row", async () => {
  await loadRoutes();
  reset();
  allowTenantWideChat = true;
  allowSendSms = true;
  seedTenant("t1");
  seedUser("u1", "t1");
  seedUser("u2", "t1");
  const threadId = "sms_shared";
  state.threads.set(threadId, {
    id: threadId,
    tenantId: "t1",
    type: "SMS",
    smsInboxOwnerUserId: "",
    tenantSmsE164: "+15551111111",
    externalSmsE164: "+15559998888",
    dedupeKey: "sms:t1:+15551111111:+15559998888:",
    active: true,
  });
  state.messages.set(threadId, []);
  seedSmsNumber({ id: "n1", tenantId: "t1", phoneE164: "+15551111111" });

  const app = buildApp({ sub: "u2", tenantId: "t1", role: "USER" });
  const res = await app.inject({
    method: "POST",
    url: `/chat/threads/${threadId}/messages`,
    payload: { body: "reply" },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(state.parts.some((p) => p.threadId === threadId && p.userId === "u2"));
  await app.close();
});

test("view-only user gets SMS_VIEW_ONLY on shared inbox reply", async () => {
  await loadRoutes();
  reset();
  allowTenantWideChat = true;
  allowSendSms = false;
  seedTenant("t1");
  seedUser("u2", "t1", "READ_ONLY");
  const threadId = "sms_shared2";
  state.threads.set(threadId, {
    id: threadId,
    tenantId: "t1",
    type: "SMS",
    smsInboxOwnerUserId: "",
    tenantSmsE164: "+15551111111",
    externalSmsE164: "+15559998888",
    active: true,
  });
  state.messages.set(threadId, []);

  const app = buildApp({ sub: "u2", tenantId: "t1", role: "READ_ONLY" });
  const res = await app.inject({
    method: "POST",
    url: `/chat/threads/${threadId}/messages`,
    payload: { body: "nope" },
  });
  assert.equal(res.statusCode, 403);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "SMS_VIEW_ONLY");
  await app.close();
});

test("tenant isolation: cannot reply to another tenant shared SMS thread", async () => {
  await loadRoutes();
  reset();
  allowTenantWideChat = true;
  allowSendSms = true;
  seedTenant("t1");
  seedTenant("t2");
  seedUser("u2", "t2");
  const threadId = "sms_t1";
  state.threads.set(threadId, {
    id: threadId,
    tenantId: "t1",
    type: "SMS",
    smsInboxOwnerUserId: "",
    tenantSmsE164: "+15551111111",
    externalSmsE164: "+15559998888",
    active: true,
  });
  state.messages.set(threadId, []);

  const app = buildApp({ sub: "u2", tenantId: "t2", role: "USER" });
  const res = await app.inject({
    method: "POST",
    url: `/chat/threads/${threadId}/messages`,
    payload: { body: "cross" },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("GET threads marks shared vs personal SMS inbox kind", async () => {
  await loadRoutes();
  reset();
  allowTenantWideChat = true;
  seedTenant("t1");
  seedUser("u1", "t1");
  state.threads.set("s1", {
    id: "s1",
    tenantId: "t1",
    type: "SMS",
    smsInboxOwnerUserId: "",
    externalSmsE164: "+1",
    tenantSmsE164: "+2",
    active: true,
    lastMessageAt: new Date(),
    title: "SMS",
  });
  state.threads.set("p1", {
    id: "p1",
    tenantId: "t1",
    type: "SMS",
    smsInboxOwnerUserId: "u1",
    externalSmsE164: "+3",
    tenantSmsE164: "+4",
    active: true,
    lastMessageAt: new Date(),
    title: "SMS",
  });
  state.messages.set("s1", []);
  state.messages.set("p1", []);

  const app = buildApp({ sub: "u1", tenantId: "t1", role: "USER" });
  const res = await app.inject({ method: "GET", url: "/chat/threads" });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  const shared = body.threads.find((t: any) => t.id === "s1");
  const personal = body.threads.find((t: any) => t.id === "p1");
  assert.equal(shared?.smsInboxKind, "shared");
  assert.equal(personal?.smsInboxKind, "personal");
  await app.close();
});
