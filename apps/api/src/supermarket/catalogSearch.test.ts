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
  isStrongMatch,
  rankCatalogRows,
  scoreCatalogRow,
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
  const exactOut = { name: "Milk Red", brand: "Golden Flow", onHand: -20 };
  const looseIn = { name: "Milk Chocolate Covered", brand: "X", onHand: 50 };
  // ⛔ an out-of-stock EXACT match must still beat an in-stock loose one, or
  // the box buries the item the person just typed
  assert.equal(rankCatalogRows([looseIn, exactOut], "milk red")[0], exactOut);
  const aOut = { name: "Milk Red", brand: "A", onHand: -1 };
  const bIn = { name: "Milk Red", brand: "B", onHand: 4 };
  assert.equal(rankCatalogRows([aOut, bIn], "milk red")[0], bIn, "equal relevance → in stock first");
});

test("inStockFirst never HIDES an out-of-stock row and treats null as shown", () => {
  const rows = [{ onHand: -5 }, { onHand: null }, { onHand: 2 }, { onHand: 0 }];
  const out = inStockFirst(rows);
  assert.equal(out.length, 4, "nothing may be dropped");
  assert.equal(out[0].onHand, null);
  assert.equal(out[1].onHand, 2);
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
