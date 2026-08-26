/**
 * STRESS the money/trust path: the tool executor is where a model's words
 * become a priced order. The adversary here is the MODEL — assume it is
 * actively hostile and will try to: quote its own prices, inject a foreign
 * tenant, order phantom items, replay finalize, overflow quantities, and
 * corrupt the draft with control characters.
 *
 * Invariants held across 10k+ randomized executions:
 *  - the total NEVER reflects a model-supplied price;
 *  - no order is created with an item not in the catalog;
 *  - exactly one draft per call, ever;
 *  - the draft's tenantId is always the session tenant;
 *  - the executor never throws (a thrown tool call would wedge the call).
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { executeVoiceAgentTool } from "./voiceAgentTools";
import { rankCatalogRows, centsToText } from "./voiceAgentCatalog";
import { decideSessionStart } from "./voiceAgentPolicy";

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCatalog(n: number, rand: () => number) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      code: String(1000 + i),
      name: `Item ${i} ${["Milk", "Bread", "Dip", "Eggs", "Soda"][i % 5]}`,
      unitPriceCents: 50 + Math.floor(rand() * 2000),
      posProductId: `p${i}`,
      isActive: rand() > 0.1,
    });
  }
  return rows;
}

function fakeDb(catalog: any[], sessionTenant: string) {
  const drafts: any[] = [];
  const calls: any[] = [{ id: "call_1", tenantId: sessionTenant, sessionUuid: "u-1", callerNumber: "3479780090", draftId: null }];
  return {
    drafts,
    calls,
    posCatalogItem: {
      async findMany(q: any) {
        const codes: string[] | undefined = q?.where?.code?.in;
        const rows = catalog.filter((c) => c.isActive);
        if (codes) return rows.filter((c) => codes.includes(c.code));
        return rows;
      },
    },
    voiceAgentCall: {
      async findUnique(q: any) {
        return calls.find((c) => c.id === q.where.id) ?? null;
      },
      async update(q: any) {
        const c = calls.find((x) => x.id === q.where.id);
        if (c) Object.assign(c, q.data);
        return c;
      },
    },
    supermarketOrderDraft: {
      async create(q: any) {
        if (drafts.some((d) => d.sourceType === q.data.sourceType && d.sourceId === q.data.sourceId && d.tenantId === q.data.tenantId)) {
          const e: any = new Error("dupe");
          e.code = "P2002";
          throw e;
        }
        const row = { id: `d${drafts.length + 1}`, ...q.data };
        drafts.push(row);
        return { id: row.id };
      },
      async findFirst(q: any) {
        return drafts.find((d) => d.sourceType === q.where.sourceType && d.sourceId === q.where.sourceId && d.tenantId === q.where.tenantId) ?? null;
      },
    },
  };
}

describe("STRESS: hostile tool executor (10k randomized finalize attempts)", () => {
  it("model-supplied prices never affect the total; unknown items never sneak in", async () => {
    const rand = mulberry32(555);
    let created = 0;
    let refusedUnknown = 0;
    for (let iter = 0; iter < 10_000; iter++) {
      const catalog = makeCatalog(20, rand);
      const activeCodes = catalog.filter((c) => c.isActive).map((c) => c.code);
      const db = fakeDb(catalog, "tenant_A");

      // Build a hostile item list: mostly real codes, sometimes a phantom, with
      // adversarial model-supplied prices attached.
      const nItems = 1 + Math.floor(rand() * 8);
      const items: any[] = [];
      let hasPhantom = false;
      for (let k = 0; k < nItems; k++) {
        if (rand() < 0.15) {
          items.push({ itemNumber: `99${Math.floor(rand() * 1000)}`, quantity: 1 + Math.floor(rand() * 3), unitPriceCents: 1 });
          hasPhantom = true;
        } else if (activeCodes.length > 0) {
          const code = activeCodes[Math.floor(rand() * activeCodes.length)];
          items.push({
            itemNumber: code,
            quantity: 1 + Math.floor(rand() * 5),
            // Hostile: the model claims a price. Must be ignored.
            unitPriceCents: Math.floor(rand() * 100000),
            price: "$0.01",
          });
        }
      }
      if (items.length === 0) continue;

      const res = await executeVoiceAgentTool({
        db,
        tenantId: "tenant_A",
        callId: "call_1",
        name: "finalize_order",
        argumentsJson: JSON.stringify({ items, comments: "WIC", customerName: "X".repeat(500) }),
      });

      if (hasPhantom) {
        assert.equal(res.ok, false, `iter ${iter}: order with a phantom item must refuse`);
        assert.match(res.output, /unknown_items/);
        assert.equal(db.drafts.length, 0, `iter ${iter}: no draft on refusal`);
        refusedUnknown++;
        continue;
      }

      assert.equal(res.ok, true, `iter ${iter}: valid order should succeed`);
      created++;
      const draft = db.drafts[0];
      assert.equal(draft.tenantId, "tenant_A");
      // Recompute the true total from the CATALOG and compare.
      const wanted = new Map<string, number>();
      for (const it of items) wanted.set(it.itemNumber, Math.min(99, (wanted.get(it.itemNumber) ?? 0) + Math.round(it.quantity)));
      let trueTotal = 0;
      for (const [code, qty] of wanted) {
        const row = catalog.find((c) => c.code === code && c.isActive)!;
        trueTotal += qty * row.unitPriceCents;
      }
      assert.equal(JSON.parse(res.output).totalText, centsToText(trueTotal), `iter ${iter}: total must be catalog-derived`);
      // The draft's stored line prices are the catalog's, never the model's.
      for (const line of draft.items as any[]) {
        const row = catalog.find((c) => c.code === line.code)!;
        assert.equal(line.unitPriceCents, row.unitPriceCents);
      }
      // WIC landed in comments; name was bounded.
      assert.equal(draft.comments, "WIC");
      assert.ok((draft.customerName as string).length <= 120);
    }
    assert.ok(created > 500, `too few successful orders to be meaningful (${created})`);
    assert.ok(refusedUnknown > 100, `too few phantom refusals to be meaningful (${refusedUnknown})`);
  });

  it("finalize replay: 50 concurrent finalizes on one call yield exactly one draft", async () => {
    const catalog = makeCatalog(5, mulberry32(1));
    // Force all active so we have a stable code.
    for (const c of catalog) c.isActive = true;
    const db = fakeDb(catalog, "tenant_A");
    const args = JSON.stringify({ items: [{ itemNumber: catalog[0].code, quantity: 1 }] });
    const runs = await Promise.all(
      Array.from({ length: 50 }, () =>
        executeVoiceAgentTool({ db, tenantId: "tenant_A", callId: "call_1", name: "finalize_order", argumentsJson: args }),
      ),
    );
    assert.ok(runs.every((r) => r.ok), "every concurrent finalize returns ok (created or already-placed)");
    assert.equal(db.drafts.length, 1, "exactly one draft despite 50 concurrent finalizes");
  });

  it("cross-tenant: a call belonging to tenant_A cannot be finalized as tenant_B", async () => {
    const catalog = makeCatalog(5, mulberry32(3));
    for (const c of catalog) c.isActive = true;
    const db = fakeDb(catalog, "tenant_A");
    const res = await executeVoiceAgentTool({
      db,
      tenantId: "tenant_B",
      callId: "call_1",
      name: "finalize_order",
      argumentsJson: JSON.stringify({ items: [{ itemNumber: catalog[0].code, quantity: 1 }] }),
    });
    assert.equal(res.ok, false);
    assert.match(res.output, /call_not_found/);
    assert.equal(db.drafts.length, 0);
  });

  it("the executor never throws on 3000 malformed argument payloads", async () => {
    const rand = mulberry32(777);
    const catalog = makeCatalog(5, mulberry32(9));
    for (const c of catalog) c.isActive = true;
    const garbage = [
      "not json",
      "[]",
      "null",
      "123",
      '{"items":"nope"}',
      '{"items":[null,1,"x"]}',
      '{"items":[{"itemNumber":null,"quantity":"lots"}]}',
      '{"items":[{"itemNumber":"' + "9".repeat(10000) + '","quantity":-5}]}',
      '{"items":[{"itemNumber":"1000","quantity":1e309}]}',
      '{"items":[{"itemNumber":"1000 ","quantity":1}]}',
    ];
    for (let iter = 0; iter < 3000; iter++) {
      const db = fakeDb(catalog, "tenant_A");
      const which = garbage[Math.floor(rand() * garbage.length)];
      const name = rand() < 0.5 ? "finalize_order" : rand() < 0.5 ? "search_items" : "unknown_tool";
      // Must resolve, never reject.
      const res = await executeVoiceAgentTool({ db, tenantId: "tenant_A", callId: "call_1", name, argumentsJson: which });
      assert.ok(res && typeof res.output === "string");
      // A successful finalize from garbage must still be catalog-priced.
      if (name === "finalize_order" && res.ok && db.drafts.length > 0) {
        for (const line of db.drafts[0].items as any[]) {
          const row = catalog.find((c) => c.code === line.code)!;
          assert.equal(line.unitPriceCents, row.unitPriceCents);
        }
      }
    }
  });
});

describe("STRESS: search ranking is stable and injection-proof", () => {
  it("5000 random queries against a 500-item catalog never throw and always return catalog prices", () => {
    const rand = mulberry32(4242);
    const rows = makeCatalog(500, rand);
    for (const c of rows) c.isActive = true;
    const injections = ["'; DROP TABLE", "<script>", " ", "%'", "../../etc", "1000 OR 1=1", ""];
    for (let iter = 0; iter < 5000; iter++) {
      const q =
        rand() < 0.3
          ? injections[Math.floor(rand() * injections.length)]
          : rand() < 0.5
            ? String(1000 + Math.floor(rand() * 600))
            : rows[Math.floor(rand() * rows.length)].name.slice(0, Math.floor(rand() * 20));
      const matches = rankCatalogRows(rows, q);
      assert.ok(matches.length <= 6);
      for (const m of matches) {
        const src = rows.find((r) => r.code === m.itemNumber)!;
        assert.equal(m.unitPriceCents, src.unitPriceCents, "match price must come from the catalog row");
      }
    }
  });
});

describe("STRESS: session-start decision fuzz", () => {
  it("50k random fact combinations always yield a definite allow/deny and clamp bounds", () => {
    const rand = mulberry32(31337);
    for (let iter = 0; iter < 50_000; iter++) {
      const settings =
        rand() < 0.1
          ? null
          : {
              enabled: rand() > 0.2,
              model: "gpt-realtime",
              voice: "cedar",
              greeting: "",
              instructionsExtra: "",
              maxCallSeconds: Math.floor((rand() - 0.5) * 1e9),
              maxConcurrentCalls: Math.floor((rand() - 0.3) * 50),
              monthlyMinuteCap: Math.floor((rand() - 0.2) * 1e7),
            };
      const d = decideSessionStart({
        settings,
        hasOpenAiKey: rand() > 0.3,
        activeCalls: Math.floor(rand() * 100),
        minutesThisMonth: Math.floor(rand() * 1e6),
      });
      if (d.allow) {
        assert.ok(d.maxCallSeconds >= 60 && d.maxCallSeconds <= 3600, `maxCallSeconds out of bounds: ${d.maxCallSeconds}`);
      } else {
        assert.ok(typeof d.reason === "string" && d.reason.length > 0);
      }
    }
  });
});
