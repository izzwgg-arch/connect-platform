import assert from "node:assert/strict";
import test from "node:test";

import { decideTempRouteDeletion, type PbxRouteRow } from "./retireTempPbxRoute";

/** Matamim, tenant 104 — the two routes own separate destination rows. */
const MATAMIM: PbxRouteRow[] = [
  { routeId: "237", did: "7244198226", destinationId: 899, description: "Main" },
  { routeId: "241", did: "9293598299", destinationId: 912, description: "Main ported" },
];

/** inii mini, tenant 105 — BOTH routes point at destination row 907. */
const INII_MINI: PbxRouteRow[] = [
  { routeId: "239", did: "8452605692", destinationId: 907, description: "Main" },
  { routeId: "240", did: "6469846023", destinationId: 907, description: "Main ported" },
];

test("Matamim: the leftover route owns its row alone, so it can go", () => {
  const d = decideTempRouteDeletion({
    tempDid: "7244198226",
    portedDid: "9293598299",
    tenantRoutes: MATAMIM,
    allRoutes: MATAMIM,
  });
  assert.equal(d.action, "delete");
  if (d.action !== "delete") return;
  assert.equal(d.routeId, "237");
  assert.equal(d.destinationId, 899);
});

test("inii mini: REFUSES, because deleting it would cascade the live number's row", () => {
  // ⛔ The one that matters. Routes 239 and 240 share destination row 907, so
  // deleting 239 takes 907 with it and 646-984-6023 — their real, live number —
  // stops working. This must never be a delete.
  const d = decideTempRouteDeletion({
    tempDid: "8452605692",
    portedDid: "6469846023",
    tenantRoutes: INII_MINI,
    allRoutes: INII_MINI,
  });
  assert.equal(d.action, "skip");
  if (d.action !== "skip") return;
  assert.match(d.reason, /shares destination row 907/);
  assert.match(d.reason, /240:6469846023/);
  assert.match(d.reason, /own destination row first/);
});

test("a sharer on ANOTHER tenant still blocks the delete", () => {
  // Nothing constrains a destination row to one tenant, so the sharing query is
  // deliberately unscoped. If it were scoped, this case would delete happily.
  const foreign: PbxRouteRow[] = [
    ...MATAMIM,
    { routeId: "999", did: "8455551234", destinationId: 899, description: "someone else" },
  ];
  const d = decideTempRouteDeletion({
    tempDid: "7244198226",
    portedDid: "9293598299",
    tenantRoutes: MATAMIM,
    allRoutes: foreign,
  });
  assert.equal(d.action, "skip");
  if (d.action !== "skip") return;
  assert.match(d.reason, /999:8455551234/);
});

test("never deletes the route carrying the ported number", () => {
  const d = decideTempRouteDeletion({
    tempDid: "9293598299",
    portedDid: "9293598299",
    tenantRoutes: MATAMIM,
    allRoutes: MATAMIM,
  });
  assert.equal(d.action, "skip");
});

test("no leftover route: nothing to do, and that is not an error", () => {
  const d = decideTempRouteDeletion({
    tempDid: "7244198226",
    portedDid: "9293598299",
    tenantRoutes: [MATAMIM[1]],
    allRoutes: [MATAMIM[1]],
  });
  assert.equal(d.action, "skip");
  if (d.action !== "skip") return;
  assert.match(d.reason, /nothing to clean up/);
});

test("no temporary number at all: skips quietly", () => {
  const d = decideTempRouteDeletion({
    tempDid: "",
    portedDid: "9293598299",
    tenantRoutes: MATAMIM,
    allRoutes: MATAMIM,
  });
  assert.equal(d.action, "skip");
});

test("a route with no destination row is refused, not guessed at", () => {
  const rows: PbxRouteRow[] = [
    { routeId: "237", did: "7244198226", destinationId: null, description: "Main" },
    MATAMIM[1],
  ];
  const d = decideTempRouteDeletion({
    tempDid: "7244198226",
    portedDid: "9293598299",
    tenantRoutes: rows,
    allRoutes: rows,
  });
  assert.equal(d.action, "skip");
  if (d.action !== "skip") return;
  assert.match(d.reason, /cannot prove deleting it is safe/);
});

test("two routes on the same temporary number: a person decides", () => {
  const rows: PbxRouteRow[] = [
    { routeId: "237", did: "7244198226", destinationId: 899 },
    { routeId: "238", did: "724-419-8226", destinationId: 900 },
    MATAMIM[1],
  ];
  const d = decideTempRouteDeletion({
    tempDid: "7244198226",
    portedDid: "9293598299",
    tenantRoutes: rows,
    allRoutes: rows,
  });
  assert.equal(d.action, "skip");
  if (d.action !== "skip") return;
  assert.match(d.reason, /2 routes carry/);
});

test("matches numbers by digits, not by formatting", () => {
  const rows: PbxRouteRow[] = [
    { routeId: "237", did: "(724) 419-8226", destinationId: 899 },
    MATAMIM[1],
  ];
  const d = decideTempRouteDeletion({
    tempDid: "7244198226",
    portedDid: "9293598299",
    tenantRoutes: rows,
    allRoutes: rows,
  });
  assert.equal(d.action, "delete");
});
