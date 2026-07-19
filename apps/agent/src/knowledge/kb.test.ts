import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, scoreOverlap, KnowledgeBase, type KbArticle } from "./kb";
import { AuditLog } from "../audit/audit";

const nullSink = { async write() {} };
const audit = new AuditLog([nullSink]);

const article: KbArticle = { id: "1", tenantId: null, title: "One-way audio — SIP ALG", problem: "callers cannot hear us one way audio", cause: "router SIP ALG mangles RTP", fix: "disable SIP ALG", approved: true };

test("tokenize drops stopwords and short tokens", () => {
  assert.deepEqual(tokenize("my phone is not ringing"), ["phone", "ringing"]);
});

test("overlap scoring ranks relevant article high", () => {
  assert.ok(scoreOverlap("one way audio problem", article) > 0.4);
  assert.equal(scoreOverlap("billing invoice question", article), 0);
});

test("retrieve returns only approved, ranked, tenant-scoped", async () => {
  const rows: KbArticle[] = [
    article,
    { id: "2", tenantId: "t1", title: "Voicemail full", problem: "voicemail box full cannot leave message", cause: "quota", fix: "clear", approved: true },
    { id: "3", tenantId: "t1", title: "Draft", problem: "one way audio", cause: "x", fix: "y", approved: false },
  ];
  const prisma = { agentKbArticle: { findMany: async ({ where }: any) => rows.filter((r) => r.approved === where.approved && (r.tenantId === null || r.tenantId === "t1")) } };
  const kb = new KnowledgeBase(prisma as any, audit);
  const res = await kb.retrieve("one way audio issue", "t1");
  assert.ok(res.length >= 1);
  assert.equal(res[0].id, "1"); // best match, approved
  assert.ok(!res.some((r) => r.id === "3")); // unapproved excluded
});

test("draft is created unapproved", async () => {
  let created: any = null;
  const prisma = { agentKbArticle: { create: async ({ data }: any) => { created = { id: "n1", ...data }; return created; } } };
  const kb = new KnowledgeBase(prisma as any, audit);
  const a = await kb.draftFromResolution({ tenantId: "t1", problem: "p", cause: "c", fix: "f" });
  assert.equal(a.approved, false);
});
