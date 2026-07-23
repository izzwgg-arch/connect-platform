import { test } from "node:test";
import assert from "node:assert/strict";
import { TranslationCache } from "./translationCache";

function fakePrisma() {
  const rows = new Map<string, any>();
  let seq = 0;
  return {
    rows,
    agentTranslation: {
      findUnique: async ({ where }: any) => rows.get(`${where.action_srcHash.action}|${where.action_srcHash.srcHash}`) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const k = `${where.action_srcHash.action}|${where.action_srcHash.srcHash}`;
        const existing = rows.get(k);
        const row = existing ? { ...existing, ...update } : { id: `t${++seq}`, ...create };
        rows.set(k, row);
        return row;
      },
      update: async ({ where, data }: any) => {
        for (const [k, v] of rows) if (v.id === where.id) { rows.set(k, { ...v, hits: (v.hits ?? 0) + (data.hits?.increment ?? 0) }); return rows.get(k); }
        return null;
      },
      findMany: async () => [...rows.values()].map((r) => ({ action: r.action, srcHash: r.srcHash, outText: r.outText, pinned: r.pinned, hits: r.hits })),
    },
  };
}

test("miss then set then hit (in-memory, 0 further DB reads)", async () => {
  const prisma = fakePrisma();
  const c = new TranslationCache(prisma as any);
  assert.equal(await c.get("translate-yiddish", "Hello there"), null);
  await c.set("translate-yiddish", "Hello there", "שלום");
  assert.equal(await c.get("translate-yiddish", "Hello there"), "שלום");
  assert.equal(c.stats().hits, 1);
});

test("normalization: whitespace/case-insensitive-ish key sharing", async () => {
  const prisma = fakePrisma();
  const c = new TranslationCache(prisma as any);
  await c.set("translate-yiddish", "Good   morning", "גוט מארגן");
  assert.equal(await c.get("translate-yiddish", "Good morning"), "גוט מארגן"); // collapsed whitespace hits
});

test("action-scoped: same text different action = different slot", async () => {
  const prisma = fakePrisma();
  const c = new TranslationCache(prisma as any);
  await c.set("translate-yiddish", "hi", "YID");
  assert.equal(await c.get("translate-english", "hi"), null);
});

test("persists to DB so a fresh instance (restart) still hits via warmFromDb", async () => {
  const prisma = fakePrisma();
  const c1 = new TranslationCache(prisma as any);
  await c1.set("translate-yiddish", "One moment", "איין מאמענט", true);
  const c2 = new TranslationCache(prisma as any); // simulates restart: empty mem
  const warmed = await c2.warmFromDb();
  assert.ok(warmed >= 1);
  assert.equal(await c2.get("translate-yiddish", "One moment"), "איין מאמענט");
});

test("empty string short-circuits to empty (no crash)", async () => {
  const prisma = fakePrisma();
  const c = new TranslationCache(prisma as any);
  assert.equal(await c.get("translate-yiddish", "   "), "");
});
