/**
 * The training loop (Izzy 2026-08-27): house rules reach BOTH brain passes,
 * a teach SUPERSEDES the previous correction (and rolls back), and the desk
 * can re-run one draft. Driven against the faithful FakeDb, plus source
 * guards on the wiring — the defect shape here is always a missed call site.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeSupermarketDb } from "./supermarketTestKit";

// ─── rulesPromptBlock ────────────────────────────────────────────────────────

test("rulesPromptBlock: empty → empty string; rules render as bounded bullet lines", async () => {
  const { rulesPromptBlock, MAX_RULES, MAX_RULE_CHARS, MAX_RULES_BLOCK_CHARS } = await import("./agentRules");
  assert.equal(rulesPromptBlock([]), "");
  assert.equal(rulesPromptBlock(["", "   "]), "");
  const block = rulesPromptBlock(["A dozen eggs means a pack of 12 large eggs.", "Red milk = Golden Flow whole milk."]);
  assert.ok(block.includes("STORE RULES"));
  assert.ok(block.includes("- A dozen eggs means a pack of 12 large eggs."));
  assert.ok(block.includes("- Red milk = Golden Flow whole milk."));
  // count cap
  const many = rulesPromptBlock(Array.from({ length: MAX_RULES + 20 }, (_, i) => `rule number ${i}`));
  assert.ok(!many.includes(`rule number ${MAX_RULES}`), "rules past the cap must be dropped");
  // per-rule + total caps
  const long = rulesPromptBlock(["x".repeat(MAX_RULE_CHARS * 3)]);
  assert.ok(long.length < MAX_RULE_CHARS + 120);
  const total = rulesPromptBlock(Array.from({ length: MAX_RULES }, () => "y".repeat(MAX_RULE_CHARS)));
  assert.ok(total.length <= MAX_RULES_BLOCK_CHARS, "the total block must stay under the prompt budget");
});

// ─── edit / rollback ─────────────────────────────────────────────────────────

test("applyRuleEdit keeps the prior wording; rollbackRule restores it (and is itself reversible)", async () => {
  const { applyRuleEdit, rollbackRule, MAX_RULE_HISTORY } = await import("./agentRules");
  const t0 = () => new Date("2026-08-27T12:00:00Z");
  const e1 = applyRuleEdit({ text: "blue milk = 1%", history: [] }, "blue milk = 2%", t0);
  assert.ok(e1);
  assert.equal(e1!.text, "blue milk = 2%");
  assert.equal(e1!.history[0].text, "blue milk = 1%");
  // unchanged / blank edits are refused
  assert.equal(applyRuleEdit({ text: "same", history: [] }, "same"), null);
  assert.equal(applyRuleEdit({ text: "same", history: [] }, "   "), null);
  // rollback restores the old wording and files the rolled-away one
  const r1 = rollbackRule({ text: e1!.text, history: e1!.history }, t0);
  assert.ok(r1);
  assert.equal(r1!.text, "blue milk = 1%");
  assert.equal(r1!.history[0].text, "blue milk = 2%");
  // rollback of the rollback flips back — a clean toggle
  const r2 = rollbackRule({ text: r1!.text, history: r1!.history }, t0);
  assert.equal(r2!.text, "blue milk = 2%");
  // nothing to restore → null
  assert.equal(rollbackRule({ text: "only", history: [] }), null);
  // history is capped
  let rule = { text: "v0", history: [] as any };
  for (let i = 1; i < MAX_RULE_HISTORY + 10; i++) {
    const e = applyRuleEdit(rule, `v${i}`, t0)!;
    rule = { text: e.text, history: e.history };
  }
  assert.ok((rule.history as any[]).length <= MAX_RULE_HISTORY);
});

// ─── the brain reads the rules — BOTH passes ────────────────────────────────

function brainDb() {
  const db = makeSupermarketDb();
  db.seed("tenant", { id: "t1", crmMode: "supermarket" });
  db.seed("posCatalogItem", { tenantId: "t1", posProductId: "p-milk", code: "100", name: "Milk Whole", brand: "Golden Flow", unitPriceCents: 349, onHand: 5 });
  return db;
}

test("runOrderBrain injects active house rules into EXTRACT and RESOLVE, in seed order, skipping inactive", async () => {
  const { runOrderBrain } = await import("./orderBrain");
  const db = brainDb();
  db.seed("supermarketAgentRule", { tenantId: "t1", text: "Red milk means Golden Flow whole milk.", createdAt: new Date("2026-08-27T10:00:00Z") });
  db.seed("supermarketAgentRule", { tenantId: "t1", text: "A dozen eggs is a pack of 12.", createdAt: new Date("2026-08-27T11:00:00Z") });
  db.seed("supermarketAgentRule", { tenantId: "t1", text: "NEVER SHOW THIS", active: false, createdAt: new Date("2026-08-27T09:00:00Z") });
  db.seed("supermarketAgentRule", { tenantId: "other", text: "FOREIGN TENANT RULE", createdAt: new Date("2026-08-27T09:30:00Z") });
  const systems: string[] = [];
  const llm = async (_k: string, _m: string, system: string, _u: string) => {
    systems.push(system);
    if (systems.length === 1) return { isOrder: true, lines: [{ phrase: "red milk", qty: 1, constraints: "" }], remarks: [] };
    return { picks: [{ line: 0, id: "p-milk", qty: 1 }], refused: [] };
  };
  const res = await runOrderBrain({ db, llm: llm as any, keyResolver: (async () => ({ apiKey: "k" })) as any }, "t1", "red milk please");
  assert.ok(res);
  assert.equal(systems.length, 2, "extract AND resolve must both run");
  for (const sys of systems) {
    assert.ok(sys.includes("STORE RULES"), "rules block missing from a pass");
    assert.ok(sys.includes("Red milk means Golden Flow whole milk."));
    assert.ok(sys.includes("A dozen eggs is a pack of 12."));
    assert.ok(!sys.includes("NEVER SHOW THIS"), "an inactive rule leaked into the prompt");
    assert.ok(!sys.includes("FOREIGN TENANT RULE"), "another tenant's rule leaked into the prompt");
  }
  // oldest first — the order the owner built them up in
  assert.ok(systems[0].indexOf("Red milk") < systems[0].indexOf("dozen eggs"));
});

test("runOrderBrain with no rules keeps the system prompts byte-identical (no empty STORE RULES header)", async () => {
  const { runOrderBrain } = await import("./orderBrain");
  const db = brainDb();
  const systems: string[] = [];
  const llm = async (_k: string, _m: string, system: string) => {
    systems.push(system);
    if (systems.length === 1) return { isOrder: true, lines: [{ phrase: "milk", qty: 1, constraints: "" }], remarks: [] };
    return { picks: [{ line: 0, id: "p-milk", qty: 1 }], refused: [] };
  };
  await runOrderBrain({ db, llm: llm as any, keyResolver: (async () => ({ apiKey: "k" })) as any }, "t1", "milk");
  for (const sys of systems) assert.ok(!sys.includes("STORE RULES"));
});

test("a rules read that throws never blocks the draft", async () => {
  const { runOrderBrain } = await import("./orderBrain");
  const db = brainDb();
  (db as any).supermarketAgentRule = { findMany: async () => { throw new Error("no such table"); } };
  const llm = async (_k: string, _m: string, _s: string, _u: string, _t: number) => ({ isOrder: false, reason: "chatter" });
  const res = await runOrderBrain({ db, llm: llm as any, keyResolver: (async () => ({ apiKey: "k" })) as any }, "t1", "hello");
  assert.ok(res, "the brain must survive a failed rules read");
});

// ─── teach supersedes; restore rolls back ────────────────────────────────────

test("teachPhrase supersedes the previous correction; restoreLesson toggles back; loadLessons sees only the active one", async () => {
  const { teachPhrase, restoreLesson, retireLesson } = await import("./phraseTeaching");
  const { loadLessons } = await import("./phraseLessons");
  const db = makeSupermarketDb();
  await teachPhrase(db, "t1", "blue milk", "p-1pct");
  await teachPhrase(db, "t1", "blue milk", "p-2pct"); // the re-correction
  const rows = db.rows("supermarketPhraseLesson");
  const oneP = rows.find((r: any) => r.posProductId === "p-1pct");
  const twoP = rows.find((r: any) => r.posProductId === "p-2pct");
  assert.ok(oneP?.retiredAt, "the replaced lesson must be retired, not left as a rival hint");
  assert.equal(twoP?.retiredAt, null);
  let active = await loadLessons(db, "t1");
  assert.deepEqual(active.map((l) => l.posProductId), ["p-2pct"], "the brain must see ONLY the newest correction");
  // rollback: bring the first one back — the replacement retires
  const ok = await restoreLesson(db, "t1", String(oneP!.id));
  assert.ok(ok);
  active = await loadLessons(db, "t1");
  assert.deepEqual(active.map((l) => l.posProductId), ["p-1pct"]);
  assert.ok(rows.find((r: any) => r.posProductId === "p-2pct")!.retiredAt, "restore must retire the rival, a clean toggle");
  // re-teaching the retired one revives it through the upsert path
  await teachPhrase(db, "t1", "blue milk", "p-2pct");
  active = await loadLessons(db, "t1");
  assert.deepEqual(active.map((l) => l.posProductId), ["p-2pct"]);
  // the ✕ soft-retires; a second ✕ on the same row answers false (404)
  const l2 = rows.find((r: any) => r.posProductId === "p-2pct")!;
  assert.equal(await retireLesson(db, "t1", String(l2.id)), true);
  assert.equal(await retireLesson(db, "t1", String(l2.id)), false);
  // tenant scoping: a foreign-tenant restore touches nothing
  assert.equal(await restoreLesson(db, "other", String(l2.id)), false);
});

test("the rep-fix HARVEST does not supersede — two rep hints may coexist", async () => {
  const { harvestPhraseLessons } = await import("./phraseLessons");
  const db = makeSupermarketDb();
  db.seed("supermarketPhraseLesson", { tenantId: "t1", phrase: "doc sauce", displayPhrase: "Doc's Sauce", posProductId: "p-old" });
  await harvestPhraseLessons(db, "t1", { agentItems: [], agentLines: [{ outcome: "skipped", phrase: "Doc's Sauce" }] }, [
    { posProductId: "p-new", name: "Duck Sauce" },
  ]);
  const rows = db.rows("supermarketPhraseLesson");
  assert.equal(rows.filter((r: any) => r.retiredAt === null).length, 2, "a harvest is a hint, never a verdict");
});

// ─── source guards on the wiring ────────────────────────────────────────────

test("SOURCE GUARDS: rules ride BOTH passes; rerun + rules routes exist; teach queue counts ACTIVE lessons only", async () => {
  const fs = await import("node:fs");
  const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const brain = read("src/supermarket/orderBrain.ts");
  // ⛔ one pass alone leaves half of every rule unenforceable — assert both
  assert.match(brain, /EXTRACT_SYSTEM \+ rulesBlock/, "EXTRACT lost the house rules");
  assert.match(brain, /RESOLVE_SYSTEM \+ rulesBlock/, "RESOLVE lost the house rules");
  const routes = read("src/supermarket/supermarketRoutes.ts");
  for (const r of [
    "/supermarket/drafts/:id/rerun",
    "/supermarket/agent-rules",
    "/supermarket/agent-rules/:id",
    "/supermarket/agent-rules/:id/rollback",
    "/supermarket/agent-rules/:id/active",
    "/supermarket/phrase-teaching/lessons/:id/restore",
  ]) {
    assert.ok(routes.includes(`"${r}"`), `route ${r} registered`);
  }
  // rerun: ownership (404) before permission (403), NEEDS_REVIEW only
  const rerunBlock = routes.slice(routes.indexOf('"/supermarket/drafts/:id/rerun"'), routes.indexOf('"/supermarket/drafts/:id/rerun"') + 1400);
  assert.ok(rerunBlock.indexOf("ownDraft") < rerunBlock.indexOf("SUPERMARKET_MANAGE_KEY"), "ownership must come before permission");
  assert.ok(rerunBlock.includes('"NEEDS_REVIEW"'), "a reviewed draft must never be rewritten");
  // the brain read path must exclude retired lessons
  const lessons = read("src/supermarket/phraseLessons.ts");
  assert.match(lessons, /retiredAt: null/, "loadLessons must exclude retired lessons");
  // the teach queue must not let a RETIRED lesson hide its phrase
  const queueBlock = routes.slice(routes.indexOf('"/supermarket/phrase-teaching"'), routes.indexOf('"/supermarket/phrase-teaching/teach"'));
  assert.match(queueBlock, /activeLessons/, "taughtKeys must come from ACTIVE lessons only");
  // the desk teaches: fix-from-the-box, the ? confirm, and the row swap
  const desk = read("../portal/app/(platform)/orders/OrdersDesk.tsx");
  assert.equal((desk.match(/phrase-teaching\/teach/g) ?? []).length, 3, "the desk must teach from swap + box-fix + confirm");
  assert.match(desk, /drafts\/\$\{encodeURIComponent\(draft\.id\)\}\/rerun/, "the desk lost the re-run button");
  assert.match(desk, /tenantId/, "the voicemail player must carry the tenant switch in the URL");
});
