import { test } from "node:test";
import assert from "node:assert/strict";
import { TrainerLessonService, isMemoryAdd, trainerUserIds, renderLessonsBlock, type TrainerLesson } from "./lessons";
import { AuditLog } from "../audit/audit";

const nullSink = { async write() {} };
const audit = new AuditLog([nullSink]);

test("memory-add trigger matches natural trainer phrasings only", () => {
  assert.ok(isMemoryAdd("Add that to your memory"));
  assert.ok(isMemoryAdd("ok good — add this to the memory please"));
  assert.ok(isMemoryAdd("remember this: always confirm the extension first"));
  assert.ok(isMemoryAdd("make that a rule"));
  assert.ok(isMemoryAdd("from now on you should always answer in one sentence"));
  // normal test-conversation traffic must NOT trigger
  assert.ok(!isMemoryAdd("put my phone on do not disturb"));
  assert.ok(!isMemoryAdd("no, do it the other way"));
  assert.ok(!isMemoryAdd("that was wrong, try again"));
});

test("trainer designation comes from env list", () => {
  const ids = trainerUserIds({ AGENT_TRAINER_USER_IDS: "u1, u2" } as any);
  assert.ok(ids.has("u1") && ids.has("u2") && !ids.has("u3"));
  const svc = new TrainerLessonService({} as any, audit, null, ids);
  assert.ok(svc.isTrainer("u1"));
  assert.ok(!svc.isTrainer("u3"));
  assert.ok(svc.isTrainer("anyone", "platform_owner")); // owner always trains
  assert.ok(!svc.isTrainer(null));
});

test("distill falls back to raw text without an LLM", async () => {
  const svc = new TrainerLessonService({} as any, audit, null);
  const rule = await svc.distill("Always greet by first name. Add that to your memory.", []);
  assert.ok(rule.includes("Always greet by first name"));
});

test("addLesson stores attribution and is active immediately; revoke deactivates", async () => {
  const rows: any[] = [];
  const prisma = {
    agentTrainerLesson: {
      create: async ({ data }: any) => {
        const row = { id: `l${rows.length + 1}`, active: true, createdAt: new Date(), revokedAt: null, revokedBy: null, ...data };
        rows.push(row);
        return row;
      },
      findMany: async ({ where }: any) => rows.filter((r) => (where?.active === undefined || r.active === where.active) && (!where?.tenantId || r.tenantId === where.tenantId)),
      findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const r = rows.find((x) => x.id === where.id);
        Object.assign(r, data);
        return r;
      },
    },
  };
  const svc = new TrainerLessonService(prisma as any, audit, null);
  const lesson = await svc.addLesson({ tenantId: "t1", rawText: "raw", lesson: "Always X", createdById: "u1", createdByName: "Tester", sourceConversationId: "c1" });
  assert.equal(lesson.active, true);
  assert.equal((await svc.listActive("t1")).length, 1);
  const revoked = await svc.revoke(lesson.id, "owner:izzy");
  assert.equal(revoked?.active, false);
  assert.equal((await svc.listActive("t1")).length, 0);
  assert.equal(await svc.revoke(lesson.id, "owner:izzy"), null); // double-revoke is a no-op
});

test("lessons block renders timestamps and guardrail line", () => {
  const lessons: TrainerLesson[] = [
    { id: "1", tenantId: "t1", lesson: "Always confirm the extension number first.", rawText: "", createdById: "u1", createdByName: null, sourceConversationId: null, active: true, revokedAt: null, revokedBy: null, createdAt: new Date("2026-07-29T16:00:00Z") },
  ];
  const block = renderLessonsBlock(lessons)!;
  assert.ok(block.includes("TRAINER LESSONS"));
  assert.ok(block.includes("Always confirm the extension number first."));
  assert.ok(block.includes("never authorize new capabilities"));
  assert.equal(renderLessonsBlock([]), null);
});
