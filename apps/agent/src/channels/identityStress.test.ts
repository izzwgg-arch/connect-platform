/**
 * X2 STRESS (spec §5): concurrency + latency on identity builds and dossier
 * writes — no cross-contamination, no lost updates, bounded output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildIdentityContext } from "./identityContext";
import { DossierService } from "../conversation/dossier";
import { AuditLog, FileAuditSink } from "../audit/audit";

function slow<T extends object>(obj: T, ms: number): T {
  return new Proxy(obj, {
    get(t: any, prop: string) {
      const v = t[prop];
      if (typeof v !== "object" || v === null) return v;
      return new Proxy(v, {
        get(inner: any, fn: string) {
          const f = inner[fn];
          if (typeof f !== "function") return f;
          return async (...args: any[]) => {
            await new Promise((r) => setTimeout(r, ms));
            return f(...args);
          };
        },
      });
    },
  });
}

test("STRESS: 100 concurrent identity builds — every result matches its own user, none bleed", async () => {
  const prisma = {
    tenant: { findUnique: async ({ where }: any) => ({ id: where.id, name: `Tenant ${where.id}` }) },
    user: {
      findUnique: async ({ where }: any) => ({ id: where.id, name: `User ${where.id}`, email: null, role: "USER", status: "ACTIVE", tenantId: `t${where.id.slice(1)}` }),
    },
    extension: { findMany: async ({ where }: any) => [{ extNumber: `1${where.ownerUserId.slice(1)}`, displayName: where.ownerUserId, status: "ACTIVE", pbxLink: null }] },
    phoneNumber: { findMany: async () => [] },
    agentConversation: { findFirst: async () => null, count: async () => 0 },
    agentAction: { count: async () => 0 },
  };
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) => buildIdentityContext(slow(prisma, 2), { tenantId: `t${i}`, clientUserId: `u${i}` })),
  );
  results.forEach((r, i) => {
    assert.ok(r.ok, `build ${i} ok`);
    const c = (r as any).context;
    assert.equal(c.tenant.id, `t${i}`);
    assert.equal(c.user.name, `User u${i}`);
    assert.deepEqual(c.extensions.map((e: any) => e.extNumber), [`1${i}`]);
  });
});

test("STRESS: concurrent sweeps over many closed chats for ONE user — every chat lands exactly once", async () => {
  // In-memory prisma with atomic-ish updateMany (single-threaded JS mimics the
  // DB's conditional update; interleaving happens at every await).
  const state: any = { convs: [] as any[], msgs: [] as any[], dossiers: [] as any[], seq: 0 };
  const prisma: any = {
    agentConversation: {
      findMany: async ({ where, take }: any) => state.convs.filter((c: any) => c.status === where.status && c.dossierRecordedAt === null).slice(0, take),
      update: async ({ where, data }: any) => Object.assign(state.convs.find((c: any) => c.id === where.id), data),
      updateMany: async ({ where, data }: any) => {
        const rows = state.convs.filter((c: any) => c.id === where.id && (where.dossierRecordedAt === undefined || c.dossierRecordedAt === where.dossierRecordedAt));
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      },
    },
    agentMessage: { findMany: async ({ where }: any) => state.msgs.filter((m: any) => m.conversationId === where.conversationId) },
    agentAction: { findMany: async () => [] },
    agentUserDossier: {
      findUnique: async ({ where }: any) => {
        const k = where.tenantId_clientUserId;
        return state.dossiers.find((d: any) => d.tenantId === k.tenantId && d.clientUserId === k.clientUserId) ?? null;
      },
      create: async ({ data }: any) => {
        if (state.dossiers.some((d: any) => d.tenantId === data.tenantId && d.clientUserId === data.clientUserId)) throw new Error("unique");
        const row = { id: `d${++state.seq}`, ...data };
        state.dossiers.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const rows = state.dossiers.filter((d: any) => d.id === where.id && d.rev === where.rev);
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      },
    },
  };
  for (let i = 0; i < 15; i++) {
    const id = `c${i}`;
    state.convs.push({ id, tenantId: "t1", clientUserId: "u1", channel: "chat", language: "en", status: "CLOSED", startedAt: new Date(2026, 5, i + 1), closedAt: new Date(2026, 5, i + 1, 1), dossierRecordedAt: null });
    state.msgs.push({ conversationId: id, role: "user", content: `issue number ${i}`, contentEn: null });
  }
  const dir = await mkdtemp(path.join(tmpdir(), "dstress-"));
  const audit = new AuditLog([new FileAuditSink(dir)]);
  const svc = new DossierService(prisma, audit, null);

  // Three sweepers race over the same queue (multi-instance scenario).
  await Promise.all([svc.sweep(50), svc.sweep(50), svc.sweep(50)]);
  // A conversation may need a later sweep if it lost every CAS — drain fully.
  for (let i = 0; i < 5 && state.convs.some((c: any) => c.dossierRecordedAt === null); i++) await svc.sweep(50);

  const md = state.dossiers[0]?.dossierMd ?? "";
  for (let i = 0; i < 15; i++) {
    const hits = md.split(`issue number ${i}`).length - 1 + (md.match(new RegExp(`issue number ${i}(?!\\d)`, "g"))?.length ?? 0);
    assert.ok(md.includes(`issue number ${i}`), `chat ${i} present`);
  }
  // Exactly once each: count chat blocks (15 ≤ verbatim cap of 20).
  assert.equal((md.match(/## Chat /g) ?? []).length, 15);
  assert.ok(state.convs.every((c: any) => c.dossierRecordedAt), "all conversations marked recorded");
});
