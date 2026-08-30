/**
 * The shared catalog-search rule. The bug it exists to kill: the desk
 * searched name-only with ONE substring, so "golden flow orange juice"
 * returned nothing (Golden Flow is the BRAND) — and the loose SQL that fixes
 * recall needs ranking, or "red" matches "Covered".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogCodePrefix,
  catalogSearchTokens,
  catalogSearchWheres,
  inStockFirst,
  isKnownOutOfStock,
  isStrongMatch,
  rankCatalogRows,
  scoreCatalogRow,
  searchCatalogPool,
  stemToken,
} from "./catalogSearch";

test("tokens drop apostrophes and short words; stems fold plurals", () => {
  assert.deepEqual(catalogSearchTokens("Gold's pads"), ["gold", "pads"]);
  assert.deepEqual(catalogSearchTokens("a of the milk"), ["the", "milk"]);
  assert.equal(stemToken("eggs"), "egg");
  assert.equal(stemToken("tomatoes"), "tomato");
  assert.equal(stemToken("gas"), "gas", "3-letter words keep their s");
});

test("a pure digit string is an item-code lookup, not a token search", () => {
  assert.equal(catalogCodePrefix("727891000352"), "727891000352");
  assert.equal(catalogCodePrefix("  104 "), "104");
  assert.equal(catalogCodePrefix("milk"), null);
  assert.equal(catalogCodePrefix("64 oz"), null);
});

test("wheres are most-specific-first and every token may match NAME or BRAND", () => {
  const w = catalogSearchWheres("golden flow orange");
  // all-AND, then 3 pairs, then 3 singles
  assert.equal(w.length, 7);
  assert.equal(w[0].AND.length, 3, "the first where must AND every token");
  const first = JSON.stringify(w[0]);
  assert.ok(first.includes('"name"') && first.includes('"brand"'), "a token must be able to match the brand — this is the whole bug");
  assert.ok(JSON.stringify(w[1]).includes('"AND"'), "pairs come before singles");
});

test("an empty / wordless phrase yields no wheres (never an unfiltered scan)", () => {
  assert.deepEqual(catalogSearchWheres(""), []);
  assert.deepEqual(catalogSearchWheres("a of"), []);
});

test("REGRESSION: a substring hit must not outrank a whole-word hit — 'red' vs 'Covered'", () => {
  const milkRed = { name: "Milk Red", brand: "Golden Flow", onHand: 5 };
  const covered = { name: "Chocolate Covered Cracker Milk Kp", brand: "Oneg", onHand: 5 };
  assert.ok(scoreCatalogRow(milkRed, "milk red") > scoreCatalogRow(covered, "milk red"));
  assert.equal(isStrongMatch(milkRed, "milk red"), true);
  assert.equal(isStrongMatch(covered, "milk red"), false, "'Covered' contains 'red' only as a substring");
  const ranked = rankCatalogRows([covered, milkRed], "milk red");
  assert.equal(ranked[0], milkRed, "the exact product must lead");
});

test("brand-only matches rank: 'golden flow orange juice' finds Golden Flow OJ", () => {
  const rows = [
    { name: "Orange Juice", brand: "Devash", onHand: 3 },
    { name: "Orange Juice Carton", brand: "Golden Flow", onHand: 2 },
    { name: "Apple Juice", brand: "Golden Flow", onHand: 9 },
  ];
  const ranked = rankCatalogRows(rows, "golden flow orange juice");
  assert.equal(ranked[0].brand, "Golden Flow");
  assert.equal(ranked[0].name, "Orange Juice Carton");
});

test("relevance outranks stock, but stock breaks ties WITHIN a relevance group", () => {
  const exactOut = { name: "Milk Red", brand: "Golden Flow", onHand: 0 };
  const looseIn = { name: "Milk Chocolate Covered", brand: "X", onHand: 50 };
  // ⛔ an out-of-stock EXACT match must still beat an in-stock loose one, or
  // the box buries the item the person just typed
  assert.equal(rankCatalogRows([looseIn, exactOut], "milk red")[0], exactOut);
  const aOut = { name: "Milk Red", brand: "A", onHand: 0 };
  const bIn = { name: "Milk Red", brand: "B", onHand: 4 };
  assert.equal(rankCatalogRows([aOut, bIn], "milk red")[0], bIn, "equal relevance → in stock first");
});

test("⛔ NEGATIVE onHand is register drift = UNKNOWN, never out of stock (Izzy 2026-08-30 — the organic-eggs bug)", () => {
  assert.equal(isKnownOutOfStock({ onHand: 0 }), true, "an exact zero is a real empty shelf");
  assert.equal(isKnownOutOfStock({ onHand: -75 }), false, "the $3.99 eggs at -75 must NOT present as out of stock");
  assert.equal(isKnownOutOfStock({ onHand: null }), false);
  assert.equal(isKnownOutOfStock({}), false);
  assert.equal(isKnownOutOfStock({ onHand: 11 }), false);
  // ranking: a negative-count row must group WITH the stocked rows
  const drifted = { name: "Eggs Large", brand: "Gesheft", onHand: -75, unitPriceCents: 399 };
  const zeroed = { name: "Eggs Large", brand: "Other", onHand: 0, unitPriceCents: 399 };
  assert.equal(rankCatalogRows([zeroed, drifted], "eggs")[0], drifted, "drift beats a true zero");
});

test("cheapest first among equal relevance — plain 'eggs' must surface the $3.99 dozen, never lead with organic", () => {
  const organic = { name: "Eggs Large", brand: "Organic Farm", onHand: 5, unitPriceCents: 899 };
  const cheap = { name: "Eggs Large", brand: "Gesheft", onHand: -75, unitPriceCents: 399 };
  assert.equal(rankCatalogRows([organic, cheap], "eggs")[0], cheap);
});

test("REGRESSION: the word ITSELF beats a word prefix beats a substring — 'eggs' vs 'Eggplant' vs 'Veggie'", () => {
  const eggs = { name: "Eggs Large", brand: "", onHand: -75 };
  const eggplant = { name: "Bella Eggplant", brand: "Golden Taste", onHand: 5 };
  const veggie = { name: "Chips Veggie", brand: "Heaven & Earth", onHand: 14 };
  assert.ok(scoreCatalogRow(eggs, "eggs") > scoreCatalogRow(eggplant, "eggs"), "eggs above eggplant");
  assert.ok(scoreCatalogRow(eggplant, "eggs") > scoreCatalogRow(veggie, "eggs"), "eggplant above a bare substring hit");
  const ranked = rankCatalogRows([veggie, eggplant, eggs], "eggs");
  assert.equal(ranked[0], eggs, "the live 2026-08-30 'eggs' search showed veggie chips and no eggs at all");
});

test("inStockFirst never HIDES a row; null AND negative are shown as ordinary rows, only zero sinks", () => {
  const rows = [{ onHand: -5 }, { onHand: null }, { onHand: 2 }, { onHand: 0 }];
  const out = inStockFirst(rows);
  assert.equal(out.length, 4, "nothing may be dropped");
  assert.deepEqual(out.map((r) => r.onHand), [-5, null, 2, 0], "only the true zero goes last");
});

test("⛔ RECALL: searchCatalogPool collects a big pool per tier — never truncating at a dozen alphabetical rows", async () => {
  // the live 2026-08-30 shape: 175 rows match "bread"; alphabetically the
  // first dozen are bread BAGS and CRUMBS, and "Rye Bread" sorts late. The
  // old per-tier take-12 meant rye bread never left the database.
  const rows: any[] = [];
  for (let i = 0; i < 174; i++) rows.push({ posProductId: `junk${i}`, name: `Bread Bags ${String(i).padStart(3, "0")}`, brand: "Spot", onHand: null, unitPriceCents: 1099 });
  rows.push({ posProductId: "rye", name: "Rye Bread", brand: "Korn's", onHand: 11, unitPriceCents: 479 });
  const takes: number[] = [];
  const db = {
    posCatalogItem: {
      findMany: async ({ take }: any) => {
        takes.push(take);
        return rows.slice(0, take); // name-ascending, rye last — like Postgres
      },
    },
  };
  const pool = await searchCatalogPool(db, "t1", "bread", { posProductId: true });
  assert.ok(takes.every((t) => t >= 100), `every tier must over-fetch (saw takes: ${takes.join(",")})`);
  assert.ok(pool.some((r: any) => r.posProductId === "rye"), "Rye Bread must be IN the pool for ranking to see it");
  const top = rankCatalogRows(pool, "bread").slice(0, 12);
  assert.ok(top.some((r: any) => r.posProductId === "rye"), "and ranking must carry it into the visible dozen");
});

test("SOURCE GUARDS: desk route and brain both search through the shared POOL, and the desk pins taught phrases", async () => {
  const fs = await import("node:fs");
  const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const brain = read("src/supermarket/orderBrain.ts");
  const routes = read("src/supermarket/supermarketRoutes.ts");
  assert.match(brain, /searchCatalogPool\(/, "the brain's candidates must come from the shared pool collector");
  assert.match(brain, /rankCatalogRows\(pool/, "the brain must RANK the pool before cutting to 8 — or the model never sees the real eggs");
  // the block ends where the NEXT route begins — a window that overruns into
  // /supermarket/phrase-teaching would see that route's lesson reads and pass
  // vacuously (caught by the HEAD replay, 2026-08-30)
  const searchStart = routes.indexOf('"/supermarket/catalog/search"');
  const searchBlock = routes.slice(searchStart, routes.indexOf('"/supermarket/phrase-teaching"', searchStart));
  assert.match(searchBlock, /searchCatalogPool\(/, "the desk must collect the pool before ranking");
  assert.ok(!/take:\s*DESK_SEARCH_LIMIT[\s\S]{0,400}rankCatalogRows/.test(searchBlock), "never go back to per-tier take-12 — that is the bread-bags bug");
  assert.match(searchBlock, /supermarketPhraseLesson/, "taught phrases must pin the desk dropdown ('bread' means the rye loaf)");
  assert.match(searchBlock, /phrase:\s*nq/, "lesson pinning must be EXACT-phrase — a 'bread' lesson must not hijack 'bread crumbs'");
  // ⛔ the stock rule is shared: no site may re-derive out-of-stock as <= 0
  const brainStripped = brain.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const routesStripped = routes.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [label, src] of [["orderBrain", brainStripped], ["supermarketRoutes", routesStripped]] as const) {
    assert.ok(!/onHand\s*<=\s*0/.test(src), `${label} must use isKnownOutOfStock — 'onHand <= 0' reads register drift as an empty shelf`);
  }
});

test("SOURCE GUARDS: the brain and the desk share ONE search rule", async () => {
  const fs = await import("node:fs");
  const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const brain = read("src/supermarket/orderBrain.ts");
  const routes = read("src/supermarket/supermarketRoutes.ts");
  assert.match(brain, /from "\.\/catalogSearch"/, "the brain must use the shared rule");
  assert.match(routes, /from "\.\/catalogSearch"/, "the desk route must use the shared rule");
  // ⛔ the exact shape of the bug: one substring against the name only
  const searchBlock = routes.slice(routes.indexOf('"/supermarket/catalog/search"'), routes.indexOf('"/supermarket/catalog/search"') + 2600);
  assert.ok(
    !/name:\s*\{\s*contains:\s*q\b/.test(searchBlock),
    "the desk must never go back to a name-only contains on the whole typed string",
  );
  assert.match(searchBlock, /rankCatalogRows/, "desk results must be ranked or 'red' matches 'Covered'");
  assert.match(searchBlock, /brand: true/, "brand must be selected — the list is unpickable without it");
  assert.match(searchBlock, /sizeText: true/, "size must be selected — five sizes of one product otherwise look identical");
});
