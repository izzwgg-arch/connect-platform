import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DossierService, compact, DOSSIER_KEEP_VERBATIM, DOSSIER_MAX_BYTES } from "./dossier";
import { AuditLog, FileAuditSink } from "../audit/audit";

class FakePrisma {
  convs: any[] = [];
  msgs: any[] = [];
  actions: any[] = [];
  dossiers: any[] = [];
  private seq = 0;
  /** Injectable CAS failure: number of updateMany calls that lose the race. */
  loseRaces = 0;

  agentConversation = {
    findMany: async ({ where, take }: any) =>
      this.convs.filter((c) => c.status === where.status && c.dossierRecordedAt === null).slice(0, take),
    update: async ({ where, data }: any) => {
      const c = this.convs.find((x) => x.id === where.id);
      Object.assign(c, data);
      return c;
    },
    updateMany: async ({ where, data }: any) => {
      const rows = this.convs.filter((c) => c.id === where.id && (where.dossierRecordedAt === undefined || c.dossierRecordedAt === where.dossierRecordedAt));
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
  };
  agentMessage = {
    findMany: async ({ where }: any) => this.msgs.filter((m) => m.conversationId === where.conversationId),
  };
  agentAction = {
    findMany: async ({ where }: any) => this.actions.filter((a) => a.conversationId === where.conversationId),
  };
  agentUserDossier = {
    findUnique: async ({ where }: any) => {
      const k = where.tenantId_clientUserId;
      return this.dossiers.find((d) => d.tenantId === k.tenantId && d.clientUserId === k.clientUserId) ?? null;
    },
    create: async ({ data }: any) => {
      if (this.dossiers.some((d) => d.tenantId === data.tenantId && d.clientUserId === data.clientUserId)) throw new Error("unique violation");
      const row = { id: `d${++this.seq}`, ...data };
      this.dossiers.push(row);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      if (this.loseRaces > 0) {
        this.loseRaces--;
        return { count: 0 };
      }
      const rows = this.dossiers.filter((d) => d.id === where.id && d.rev === where.rev);
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
  };

  addConv(over: Partial<any> = {}) {
    const c = { id: `c${++this.seq}`, tenantId: "t1", clientUserId: "u1", channel: "chat", language: "en", status: "CLOSED", startedAt: new Date("2026-07-20T10:00:00Z"), closedAt: new Date("2026-07-20T11:00:00Z"), dossierRecordedAt: null, ...over };
    this.convs.push(c);
    return c;
  }
}

let prisma: FakePrisma;
let audit: AuditLog;
let svc: DossierService;

beforeEach(async () => {
  prisma = new FakePrisma();
  const dir = await mkdtemp(path.join(tmpdir(), "dossier-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
  svc = new DossierService(prisma as any, audit, null); // no LLM → deterministic fallback
});

test("sweep records a closed chat into the user's dossier (deterministic fallback)", async () => {
  const c = prisma.addConv();
  prisma.msgs.push({ conversationId: c.id, role: "user", content: "my phone is not ringing", contentEn: null });
  prisma.actions.push({ conversationId: c.id, capabilityId: "action.A7.dnd", status: "EXECUTED", summary: "Clear DND on ext 103" });
  const n = await svc.sweep();
  assert.equal(n, 1);
  const md = await svc.load("t1", "u1");
  assert.ok(md);
  assert.match(md!, /## Chat 2026-07-20 \(chat, en\)/);
  assert.match(md!, /my phone is not ringing/);
  assert.match(md!, /Clear DND on ext 103.*EXECUTED/);
  assert.ok(prisma.convs[0].dossierRecordedAt, "conversation marked recorded");
});

test("RECORDING IS UNCONDITIONAL: no history-visibility flag is ever consulted", async () => {
  // Structural proof: the service touches only these models — there is no
  // policy/visibility read anywhere in the dossier path.
  const c = prisma.addConv();
  prisma.msgs.push({ conversationId: c.id, role: "user", content: "hi", contentEn: null });
  await svc.sweep();
  assert.ok(await svc.load("t1", "u1"));
});

test("sweep is idempotent — second run records nothing new", async () => {
  const c = prisma.addConv();
  prisma.msgs.push({ conversationId: c.id, role: "user", content: "hello", contentEn: null });
  assert.equal(await svc.sweep(), 1);
  assert.equal(await svc.sweep(), 0);
  assert.equal((await svc.load("t1", "u1"))!.match(/## Chat/g)!.length, 1);
});

test("unknown-user conversation stays permanently recorded but produces no dossier", async () => {
  prisma.addConv({ clientUserId: null });
  assert.equal(await svc.sweep(), 1);
  assert.ok(prisma.convs[0].dossierRecordedAt);
  assert.equal(prisma.dossiers.length, 0);
});

test("multiple chats append; Yiddish mirror text preferred for the summary", async () => {
  const c1 = prisma.addConv();
  prisma.msgs.push({ conversationId: c1.id, role: "user", content: "מײַן טעלעפון", contentEn: "my phone is broken" });
  await svc.sweep();
  const c2 = prisma.addConv({ closedAt: new Date("2026-07-21T09:00:00Z") });
  prisma.msgs.push({ conversationId: c2.id, role: "user", content: "voicemail full", contentEn: null });
  await svc.sweep();
  const md = await svc.load("t1", "u1");
  assert.match(md!, /my phone is broken/); // English mirror used, not raw Yiddish
  assert.equal(md!.match(/## Chat/g)!.length, 2);
});

test("CAS race: lost update retries once and succeeds; exhausted retries leave conv for next sweep", async () => {
  const c1 = prisma.addConv();
  prisma.msgs.push({ conversationId: c1.id, role: "user", content: "a", contentEn: null });
  await svc.sweep();
  const c2 = prisma.addConv();
  prisma.msgs.push({ conversationId: c2.id, role: "user", content: "b", contentEn: null });
  prisma.loseRaces = 1; // first attempt loses, retry wins
  assert.equal(await svc.sweep(), 1);
  assert.equal((await svc.load("t1", "u1"))!.match(/## Chat/g)!.length, 2);

  const c3 = prisma.addConv();
  prisma.msgs.push({ conversationId: c3.id, role: "user", content: "c", contentEn: null });
  prisma.loseRaces = 2; // both dossier-CAS attempts lose → claim released
  assert.equal(await svc.sweep(), 0); // nothing recorded this round...
  assert.equal(prisma.convs.find((x) => x.id === c3.id)!.dossierRecordedAt, null); // ...claim released
  prisma.loseRaces = 0;
  assert.equal(await svc.sweep(), 1); // next sweep picks it up
});

test("compaction: beyond the verbatim cap, oldest chats collapse into the digest", () => {
  const blocks = Array.from({ length: DOSSIER_KEEP_VERBATIM + 5 }, (_, i) => `## Chat 2026-06-${String(i + 1).padStart(2, "0")} (chat)\n- Asked: issue number ${i}`);
  const md = compact(blocks.join("\n\n"));
  assert.equal(md.match(/## Chat /g)!.length, DOSSIER_KEEP_VERBATIM);
  assert.match(md, /## Older chats \(digest\)/);
  assert.match(md, /- 2026-06-01 \(chat\): Asked: issue number 0/);
});

test("compaction: hard byte cap holds even for huge dossiers", () => {
  const blocks = Array.from({ length: 60 }, (_, i) => `## Chat 2026-05-${String((i % 28) + 1).padStart(2, "0")} (chat)\n- Asked: ${"x".repeat(400)} #${i}`);
  const md = compact(blocks.join("\n\n"));
  assert.ok(Buffer.byteLength(md, "utf8") <= DOSSIER_MAX_BYTES, `size ${Buffer.byteLength(md, "utf8")} > cap`);
  assert.ok(md.includes("## Chat"), "most recent chats survive");
});

test("compaction preserves a facts preamble", () => {
  const md = compact(`# Facts\n- Office: Brooklyn\n\n## Chat 2026-07-01 (chat)\n- Asked: hi`);
  assert.match(md, /^# Facts\n- Office: Brooklyn/);
  assert.match(md, /## Chat 2026-07-01/);
});
