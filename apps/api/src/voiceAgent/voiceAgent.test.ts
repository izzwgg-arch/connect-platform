/**
 * Voice-agent api-side tests: the pure policy/pricing layers plus the tool
 * executor against a fake db. The invariants that carry money or trust:
 *  - refusals fail toward the human fallback (uncertain input refuses);
 *  - the model can NEVER set a price — finalize prices come from the catalog;
 *  - one order per call, even under a finalize race;
 *  - an order with an unknown item is refused whole, never silently trimmed.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildInstructions,
  decideSessionStart,
  sanitizeToolLog,
  sanitizeTranscript,
} from "./voiceAgentPolicy";
import { centsToText, rankCatalogRows } from "./voiceAgentCatalog";
import { executeVoiceAgentTool } from "./voiceAgentTools";

const SETTINGS = {
  enabled: true,
  model: "gpt-realtime",
  voice: "cedar",
  greeting: "",
  instructionsExtra: "",
  maxCallSeconds: 600,
  maxConcurrentCalls: 4,
  monthlyMinuteCap: 3000,
};

describe("decideSessionStart", () => {
  it("allows a configured tenant under its caps", () => {
    const d = decideSessionStart({ settings: SETTINGS, hasOpenAiKey: true, activeCalls: 0, minutesThisMonth: 10 });
    assert.deepEqual(d, { allow: true, maxCallSeconds: 600 });
  });

  it("refuses: no settings, disabled, no key, concurrency, minute cap", () => {
    const base = { settings: SETTINGS, hasOpenAiKey: true, activeCalls: 0, minutesThisMonth: 0 };
    assert.equal((decideSessionStart({ ...base, settings: null }) as { reason: string }).reason, "no_settings");
    assert.equal(
      (decideSessionStart({ ...base, settings: { ...SETTINGS, enabled: false } }) as { reason: string }).reason,
      "disabled",
    );
    assert.equal((decideSessionStart({ ...base, hasOpenAiKey: false }) as { reason: string }).reason, "no_openai_key");
    assert.equal((decideSessionStart({ ...base, activeCalls: 4 }) as { reason: string }).reason, "concurrency_cap");
    assert.equal(
      (decideSessionStart({ ...base, minutesThisMonth: 3000 }) as { reason: string }).reason,
      "monthly_minute_cap",
    );
  });

  it("a zero minute cap means uncapped", () => {
    const d = decideSessionStart({
      settings: { ...SETTINGS, monthlyMinuteCap: 0 },
      hasOpenAiKey: true,
      activeCalls: 0,
      minutesThisMonth: 999_999,
    });
    assert.equal(d.allow, true);
  });

  it("clamps a hostile maxCallSeconds into [60, 3600]", () => {
    const d = decideSessionStart({
      settings: { ...SETTINGS, maxCallSeconds: 10_000_000 },
      hasOpenAiKey: true,
      activeCalls: 0,
      minutesThisMonth: 0,
    });
    assert.deepEqual(d, { allow: true, maxCallSeconds: 3600 });
  });
});

describe("buildInstructions", () => {
  it("carries the load-bearing rules: no invented prices, WIC→comments, transfer, no payments", () => {
    const s = buildInstructions({ storeName: "Gesheft Kosher", callerNumber: "3479780090" });
    assert.match(s, /Gesheft Kosher/);
    assert.match(s, /NEVER invent, estimate, or negotiate a price/);
    assert.match(s, /WIC/);
    assert.match(s, /reason 'transfer'/);
    assert.match(s, /Never take card numbers/);
    assert.match(s, /Yiddish/);
    assert.match(s, /3479780090/);
  });
});

describe("sanitizers", () => {
  it("bound hostile transcript/tool payloads", () => {
    const big = Array.from({ length: 1000 }, (_, i) => ({ role: "assistant", text: "x".repeat(5000) + i }));
    const t = sanitizeTranscript(big);
    assert.equal(t.length, 400);
    assert.ok(t[0].text.length <= 2000);
    assert.deepEqual(sanitizeTranscript("garbage"), []);
    assert.deepEqual(sanitizeToolLog([{ name: "", argumentsJson: "x" }]), []);
  });
});

describe("rankCatalogRows", () => {
  const rows = [
    { code: "4512", name: "Golden Flow Eggs Dozen", unitPriceCents: 389, posProductId: "p1", isActive: true },
    { code: "45128", name: "Egg Noodles Wide", unitPriceCents: 249, posProductId: "p2", isActive: true },
    { code: "7801", name: "Tomato Dip Large", unitPriceCents: 599, posProductId: "p3", isActive: true },
    { code: "7802", name: "Tomato Dip Small", unitPriceCents: 349, posProductId: "p4", isActive: true },
    { code: "9999", name: "Inactive Thing", unitPriceCents: 100, posProductId: "p5", isActive: false },
  ];

  it("exact code wins over prefix code", () => {
    const m = rankCatalogRows(rows, "4512");
    assert.equal(m[0].itemNumber, "4512");
    assert.equal(m[1].itemNumber, "45128");
  });

  it("name tokens match with prefix tolerance", () => {
    const m = rankCatalogRows(rows, "tomato dip");
    assert.equal(m.length, 2);
    assert.ok(m.every((x) => /Tomato Dip/.test(x.name)));
  });

  it("inactive rows never surface; prices format as dollars", () => {
    assert.equal(rankCatalogRows(rows, "inactive thing").length, 0);
    assert.equal(centsToText(389), "$3.89");
    assert.equal(centsToText(10000), "$100.00");
  });
});

// ── tool executor against a fake db ─────────────────────────────────────────

function fakeDb() {
  const catalog = [
    { code: "4512", name: "Golden Flow Eggs Dozen", unitPriceCents: 389, posProductId: "p1", isActive: true },
    { code: "7801", name: "Tomato Dip Large", unitPriceCents: 599, posProductId: "p3", isActive: true },
  ];
  const drafts: Array<Record<string, unknown>> = [];
  const calls: Array<Record<string, unknown>> = [
    { id: "call_1", tenantId: "tenant_A", sessionUuid: "u-1", callerNumber: "3479780090", draftId: null },
  ];
  return {
    catalog,
    drafts,
    calls,
    posCatalogItem: {
      async findMany(q: any) {
        const codes: string[] | undefined = q?.where?.code?.in;
        if (codes) return catalog.filter((c) => codes.includes(c.code));
        return catalog;
      },
    },
    voiceAgentCall: {
      async findUnique(q: any) {
        return calls.find((c) => c["id"] === q.where.id) ?? null;
      },
      async update(q: any) {
        const row = calls.find((c) => c["id"] === q.where.id);
        if (row) Object.assign(row, q.data);
        return row;
      },
    },
    supermarketOrderDraft: {
      async create(q: any) {
        const dupe = drafts.find(
          (d) => d["tenantId"] === q.data.tenantId && d["sourceType"] === q.data.sourceType && d["sourceId"] === q.data.sourceId,
        );
        if (dupe) {
          const err: any = new Error("unique");
          err.code = "P2002";
          throw err;
        }
        const row = { id: `draft_${drafts.length + 1}`, ...q.data };
        drafts.push(row);
        return { id: row.id };
      },
      async findFirst(q: any) {
        return (
          drafts.find(
            (d) =>
              d["tenantId"] === q.where.tenantId &&
              d["sourceType"] === q.where.sourceType &&
              d["sourceId"] === q.where.sourceId,
          ) ?? null
        );
      },
    },
  };
}

describe("executeVoiceAgentTool", () => {
  it("search_items returns matches with catalog prices only", async () => {
    const db = fakeDb();
    const res = await executeVoiceAgentTool({
      db,
      tenantId: "tenant_A",
      callId: "call_1",
      name: "search_items",
      argumentsJson: JSON.stringify({ query: "4512" }),
    });
    assert.equal(res.ok, true);
    const out = JSON.parse(res.output);
    assert.equal(out.matches[0].itemNumber, "4512");
    assert.equal(out.matches[0].price, "$3.89");
  });

  it("finalize prices come from the CATALOG — model-supplied prices are ignored", async () => {
    const db = fakeDb();
    const res = await executeVoiceAgentTool({
      db,
      tenantId: "tenant_A",
      callId: "call_1",
      name: "finalize_order",
      argumentsJson: JSON.stringify({
        items: [
          { itemNumber: "4512", quantity: 2, unitPriceCents: 1 },
          { itemNumber: "7801", quantity: 1, price: "$0.01" },
        ],
        comments: "Paying with WIC",
      }),
    });
    assert.equal(res.ok, true);
    const out = JSON.parse(res.output);
    // 2×389 + 599 = 1377 — the model's $0.01 fantasies changed nothing.
    assert.equal(out.totalText, "$13.77");
    const draft = db.drafts[0];
    assert.equal(draft["sourceType"], "voice_call");
    assert.equal(draft["sourceId"], "u-1");
    assert.equal(draft["comments"], "Paying with WIC");
    assert.equal(draft["status"], "NEEDS_REVIEW");
    const items = draft["items"] as Array<{ unitPriceCents: number }>;
    assert.equal(items[0].unitPriceCents, 389);
    // The AI's guess is frozen as training data.
    assert.deepEqual(draft["agentItems"], draft["items"]);
  });

  it("an unknown item refuses the WHOLE order — nothing is silently dropped", async () => {
    const db = fakeDb();
    const res = await executeVoiceAgentTool({
      db,
      tenantId: "tenant_A",
      callId: "call_1",
      name: "finalize_order",
      argumentsJson: JSON.stringify({ items: [{ itemNumber: "4512", quantity: 1 }, { itemNumber: "0000", quantity: 1 }] }),
    });
    assert.equal(res.ok, false);
    assert.match(res.output, /unknown_items/);
    assert.equal(db.drafts.length, 0);
  });

  it("one order per call: a second finalize reports the existing order", async () => {
    const db = fakeDb();
    const args = JSON.stringify({ items: [{ itemNumber: "4512", quantity: 1 }] });
    const first = await executeVoiceAgentTool({ db, tenantId: "tenant_A", callId: "call_1", name: "finalize_order", argumentsJson: args });
    assert.equal(first.ok, true);
    const second = await executeVoiceAgentTool({ db, tenantId: "tenant_A", callId: "call_1", name: "finalize_order", argumentsJson: args });
    assert.equal(second.ok, true);
    assert.match(second.output, /already placed/);
    assert.equal(db.drafts.length, 1);
  });

  it("a call from another tenant cannot finalize against this tenant", async () => {
    const db = fakeDb();
    const res = await executeVoiceAgentTool({
      db,
      tenantId: "tenant_B",
      callId: "call_1",
      name: "finalize_order",
      argumentsJson: JSON.stringify({ items: [{ itemNumber: "4512", quantity: 1 }] }),
    });
    assert.equal(res.ok, false);
    assert.match(res.output, /call_not_found/);
  });

  it("quantities are clamped and duplicates collapsed", async () => {
    const db = fakeDb();
    const res = await executeVoiceAgentTool({
      db,
      tenantId: "tenant_A",
      callId: "call_1",
      name: "finalize_order",
      argumentsJson: JSON.stringify({
        items: [
          { itemNumber: "4512", quantity: 500 },
          { itemNumber: "4512", quantity: 3 },
        ],
      }),
    });
    assert.equal(res.ok, true);
    const items = db.drafts[0]["items"] as Array<{ qty: number }>;
    assert.equal(items.length, 1);
    assert.equal(items[0].qty, 99);
  });

  it("garbage arguments refuse without touching the db", async () => {
    const db = fakeDb();
    const res = await executeVoiceAgentTool({ db, tenantId: "t", callId: "c", name: "finalize_order", argumentsJson: "not json{" });
    assert.equal(res.ok, false);
    assert.equal(db.drafts.length, 0);
  });
});

describe("source guards", () => {
  const read = (f: string) =>
    readFileSync(path.join(__dirname, f), "utf8")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");

  it("⛔ no platform-key fallback: the module never reads an OPENAI env var", () => {
    for (const f of ["voiceAgentRoutes.ts", "voiceAgentTools.ts", "voiceAgentPolicy.ts", "voiceAgentCatalog.ts"]) {
      const src = read(f);
      assert.ok(!/process\.env\.OPENAI/i.test(src), `${f} must not read an OPENAI env var`);
    }
    // And the key must come from the shared tenant vault.
    assert.ok(read("voiceAgentRoutes.ts").includes('resolveIntegrationKey(db, tenantId, "OPENAI")'));
  });

  it("⛔ the POS is never called from the voice agent (submit stays human-gated)", () => {
    for (const f of ["voiceAgentRoutes.ts", "voiceAgentTools.ts"]) {
      const src = read(f);
      for (const forbidden of ["posClientForTenant", "approveAndSubmitDraft", "posWithLogic", "PosWithLogicClient"]) {
        assert.ok(!src.includes(forbidden), `${f} must not reference ${forbidden}`);
      }
    }
  });

  it("all three internal doors check the internal secret", () => {
    const src = read("voiceAgentRoutes.ts");
    const doors = ["/internal/voice-agent/session-start", "/internal/voice-agent/tool", "/internal/voice-agent/session-end"];
    for (const d of doors) assert.ok(src.includes(`"${d}"`), `door ${d} registered`);
    // Each internal handler opens with the guard call.
    const guardCount = (src.match(/if \(!guard\(req, reply\)\) return reply;/g) ?? []).length;
    assert.ok(guardCount >= 3, `every internal door guards the secret (found ${guardCount})`);
  });
});
