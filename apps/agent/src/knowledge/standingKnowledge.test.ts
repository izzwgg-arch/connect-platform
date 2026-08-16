import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadStandingKnowledgeBlock, clearKnowledgeCache } from "./standingKnowledge";

function fakePrisma(rows: Array<{ scope: string; tenantId: string | null; title: string; body: string; internalBody?: string | null }>) {
  const calls: any[] = [];
  return {
    calls,
    agentKnowledgeDoc: {
      findFirst: async ({ where }: any) => {
        calls.push(where);
        const hit = rows.find((r) => r.scope === where.scope && (where.tenantId === undefined ? r.tenantId === null : r.tenantId === where.tenantId));
        return hit ? { ...hit, internalBody: hit.internalBody ?? null, updatedAt: new Date() } : null;
      },
    },
  };
}

beforeEach(() => clearKnowledgeCache());

test("loads the system document and only THIS company's document", async () => {
  const prisma = fakePrisma([
    { scope: "system", tenantId: null, title: "Connect", body: "Calls ring for 15 seconds." },
    { scope: "tenant", tenantId: "t_acme", title: "Acme", body: "Acme has extension 101 only." },
    { scope: "tenant", tenantId: "t_other", title: "Other Co", body: "Other Co owes money." },
  ]);
  const block = await loadStandingKnowledgeBlock({ prisma, tenantId: "t_acme", audience: "customer" });
  assert.ok(block);
  assert.match(block!, /15 seconds/);
  assert.match(block!, /extension 101/);
  assert.doesNotMatch(block!, /Other Co/, "⛔ another company's document must never load");
});

test("⛔ the tenant document is fetched by tenantId, never by name", async () => {
  const prisma = fakePrisma([{ scope: "tenant", tenantId: "t_acme", title: "Acme", body: "x" }]);
  await loadStandingKnowledgeBlock({ prisma, tenantId: "t_acme", audience: "customer" });
  const tenantQuery = prisma.calls.find((c) => c.scope === "tenant");
  assert.deepEqual(tenantQuery, { scope: "tenant", tenantId: "t_acme" });
});

test("staff-only notes are withheld from customers and given to the researcher", async () => {
  const rows = [{ scope: "tenant", tenantId: "t_acme", title: "Acme", body: "Public.", internalBody: "Card declined twice." }];
  const forCustomer = await loadStandingKnowledgeBlock({ prisma: fakePrisma(rows), tenantId: "t_acme", audience: "customer" });
  assert.doesNotMatch(forCustomer!, /declined/);
  clearKnowledgeCache();
  const forStaff = await loadStandingKnowledgeBlock({ prisma: fakePrisma(rows), tenantId: "t_acme", audience: "internal" });
  assert.match(forStaff!, /Card declined twice/);
});

test("no documents at all ⇒ null, so the assistant behaves exactly as before", async () => {
  const block = await loadStandingKnowledgeBlock({ prisma: fakePrisma([]), tenantId: "t_acme", audience: "customer" });
  assert.equal(block, null);
});

test("a database failure never breaks the turn", async () => {
  const prisma = { agentKnowledgeDoc: { findFirst: async () => { throw new Error("relation does not exist"); } } };
  const block = await loadStandingKnowledgeBlock({ prisma, tenantId: "t_acme", audience: "customer" });
  assert.equal(block, null);
});

test("a company with no document still gets the platform document", async () => {
  const prisma = fakePrisma([{ scope: "system", tenantId: null, title: "Connect", body: "Platform facts." }]);
  const block = await loadStandingKnowledgeBlock({ prisma, tenantId: "t_new", audience: "customer" });
  assert.match(block!, /Platform facts/);
});

test("results are cached, so knowledge costs one query per minute, not one per message", async () => {
  const prisma = fakePrisma([{ scope: "system", tenantId: null, title: "Connect", body: "x" }]);
  await loadStandingKnowledgeBlock({ prisma, tenantId: "t_acme", audience: "customer" });
  const afterFirst = prisma.calls.length;
  await loadStandingKnowledgeBlock({ prisma, tenantId: "t_acme", audience: "customer" });
  assert.equal(prisma.calls.length, afterFirst, "second call must be served from cache");
});

test("⛔ the cache is keyed per company — a cached miss for one must not blank another", async () => {
  const prisma = fakePrisma([
    { scope: "system", tenantId: null, title: "Connect", body: "sys" },
    { scope: "tenant", tenantId: "t_b", title: "B", body: "B's own fact" },
  ]);
  const a = await loadStandingKnowledgeBlock({ prisma, tenantId: "t_a", audience: "customer" });
  assert.doesNotMatch(a!, /B's own fact/);
  const b = await loadStandingKnowledgeBlock({ prisma, tenantId: "t_b", audience: "customer" });
  assert.match(b!, /B's own fact/);
});
