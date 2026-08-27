/**
 * Teach the Agent — queue aggregation + teach/dismiss behavior + source
 * guards on the wiring (the defect shape here is always a missed call site).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const drafts = (rows: any[]) => rows.map((r, i) => ({ id: `d${i}`, customerName: r.c ?? "CALLER", sourceType: r.s ?? "voicemail", createdAt: r.at ?? new Date(2026, 7, 26, 10, i), agentLines: r.lines }));

test("buildTeachQueue aggregates skipped phrases, newest details win, most-heard first", async () => {
  const { buildTeachQueue } = await import("./phraseTeaching");
  const q = buildTeachQueue(
    drafts([
      { lines: [{ phrase: "Doc's Sauce", outcome: "skipped", reason: "no match", qty: 1 }] },
      { lines: [{ phrase: "docs sauce", outcome: "skipped", reason: "still no match", qty: 2 }], c: "BERKOWITZ" },
      { lines: [{ phrase: "milk", outcome: "in_cart", posProductId: "p1" }] },
      { lines: [{ phrase: "unicorn spread", outcome: "skipped", reason: "nothing close" }] },
    ]),
    new Set(),
    new Set(),
  );
  assert.equal(q.length, 2);
  // "doc sauce" heard 2× sorts first; the NEWER draft's casing/customer wins
  assert.equal(q[0].count, 2);
  assert.equal(q[0].displayPhrase, "docs sauce");
  assert.equal(q[0].lastCustomer, "BERKOWITZ");
  assert.equal(q[1].displayPhrase, "unicorn spread");
});

test("buildTeachQueue hides already-taught and dismissed phrases", async () => {
  const { buildTeachQueue } = await import("./phraseTeaching");
  const { normalizePhrase } = await import("./phraseLessons");
  const q = buildTeachQueue(
    drafts([{ lines: [
      { phrase: "Doc's Sauce", outcome: "skipped" },
      { phrase: "EZ-T-Pines file", outcome: "skipped" },
      { phrase: "unicorn spread", outcome: "skipped" },
    ] }]),
    new Set([normalizePhrase("Doc's Sauce")]),
    new Set([normalizePhrase("EZ-T-Pines file")]),
  );
  assert.equal(q.length, 1);
  assert.equal(q[0].displayPhrase, "unicorn spread");
});

test("teachPhrase upserts source 'taught' and clears any dismissal", async () => {
  const { teachPhrase } = await import("./phraseTeaching");
  const calls: any[] = [];
  const db = {
    supermarketPhraseLesson: {
      upsert: async (a: any) => calls.push(["upsert", a]),
      updateMany: async (a: any) => calls.push(["supersede", a]),
    },
    supermarketPhraseDismissal: { deleteMany: async (a: any) => calls.push(["undismiss", a]) },
  };
  const res = await teachPhrase(db, "t1", "Doc's Sauce", "duck1");
  assert.ok(res);
  assert.equal(calls[0][1].create.source, "taught");
  assert.equal(calls[0][1].create.displayPhrase, "Doc's Sauce");
  assert.equal(calls[0][1].update.source, "taught");
  // a taught lesson comes back from retirement, and every OTHER product's
  // active lesson on the same phrase is superseded (Izzy 2026-08-27)
  assert.equal(calls[0][1].update.retiredAt, null);
  assert.equal(calls[1][0], "supersede");
  assert.deepEqual(calls[1][1].where.posProductId, { not: "duck1" });
  assert.equal(calls[2][0], "undismiss");
});

test("dismiss + undismiss round-trip on the normalized key", async () => {
  const { dismissPhrase, undismissPhrase } = await import("./phraseTeaching");
  const { normalizePhrase } = await import("./phraseLessons");
  const calls: any[] = [];
  const db = { supermarketPhraseDismissal: {
    upsert: async (a: any) => calls.push(["up", a]),
    deleteMany: async (a: any) => calls.push(["del", a]),
  } };
  await dismissPhrase(db, "t1", "charge my EZ-T-Pines file");
  await undismissPhrase(db, "t1", "charge my EZ-T-Pines file");
  assert.equal(calls[0][1].create.phrase, normalizePhrase("charge my EZ-T-Pines file"));
  assert.equal(calls[1][1].where.phrase, calls[0][1].create.phrase);
});

test("SOURCE GUARDS: routes exist, writes are manage-gated, product ownership checked, brain counts timesUsed", async () => {
  const fs = await import("node:fs");
  const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const routes = read("src/supermarket/supermarketRoutes.ts");
  for (const r of ["/supermarket/phrase-teaching", "/supermarket/phrase-teaching/teach", "/supermarket/phrase-teaching/dismiss", "/supermarket/phrase-teaching/lessons/:id"]) {
    assert.ok(routes.includes(`"${r}"`), `route ${r} registered`);
  }
  // teach validates the product belongs to THIS tenant before saving
  const teachBlock = routes.slice(routes.indexOf('"/supermarket/phrase-teaching/teach"'), routes.indexOf('"/supermarket/phrase-teaching/dismiss"'));
  assert.ok(teachBlock.includes("SUPERMARKET_MANAGE_KEY"), "teach is manage-gated");
  assert.ok(teachBlock.includes("posCatalogItem.findFirst"), "teach checks product ownership");
  const brain = read("src/supermarket/orderBrain.ts");
  assert.ok(brain.includes("timesUsed: { increment: 1 }"), "a learned pick bumps the auto-filled gauge");
});
