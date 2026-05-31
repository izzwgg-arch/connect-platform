import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveLeadTimezoneFromLocation,
  buildLeadTimezoneMetaFilter,
  shouldRecomputeLeadTimezone,
  ianaToTimezoneLabel,
  normalizeUsStateAbbrev,
  leadTimezoneBadgeShort,
  leadTimezoneDetailLabel,
  MOUNTAIN_FILTER_IANAS,
  MOUNTAIN_FILTER_LABELS,
} from "./leadTimezoneResolver";

test("resolveLeadTimezoneFromLocation: New York NY → America/New_York", () => {
  const r = resolveLeadTimezoneFromLocation("New York", "NY");
  assert.equal(r.timezoneIana, "America/New_York");
  assert.equal(r.timezoneLabel, "Eastern");
  assert.equal(r.timezoneResolutionStatus, "RESOLVED");
});

test("resolveLeadTimezoneFromLocation: Chicago IL → America/Chicago", () => {
  const r = resolveLeadTimezoneFromLocation("Chicago", "IL");
  assert.equal(r.timezoneIana, "America/Chicago");
  assert.equal(r.timezoneLabel, "Central");
  assert.equal(r.timezoneResolutionStatus, "RESOLVED");
});

test("resolveLeadTimezoneFromLocation: Phoenix AZ → America/Phoenix", () => {
  const r = resolveLeadTimezoneFromLocation("Phoenix", "AZ");
  assert.equal(r.timezoneIana, "America/Phoenix");
  assert.equal(r.timezoneLabel, "Arizona");
  assert.equal(r.timezoneResolutionStatus, "RESOLVED");
});

test("resolveLeadTimezoneFromLocation: Denver CO → America/Denver with Mountain label", () => {
  const r = resolveLeadTimezoneFromLocation("Denver", "CO");
  assert.equal(r.timezoneIana, "America/Denver");
  assert.equal(r.timezoneLabel, "Mountain");
  assert.notEqual(r.timezoneLabel, "Arizona");
});

test("Phoenix badge/display label is distinct from Denver", () => {
  const phoenix = resolveLeadTimezoneFromLocation("Phoenix", "AZ");
  const denver = resolveLeadTimezoneFromLocation("Denver", "CO");
  assert.equal(leadTimezoneBadgeShort(phoenix), "AZ");
  assert.equal(leadTimezoneBadgeShort(denver), "MT");
  assert.equal(leadTimezoneDetailLabel(phoenix), "Arizona (MST)");
  assert.equal(leadTimezoneDetailLabel(denver), "Mountain");
});

test("buildLeadTimezoneMetaFilter: mountain zone includes Phoenix and Denver", () => {
  const f = buildLeadTimezoneMetaFilter({ timezoneZone: "mountain" });
  assert.ok(Array.isArray((f as any).OR));
  const orClauses = (f as any).OR as Array<Record<string, unknown>>;
  const labelClause = orClauses.find((c) => "timezoneLabel" in c) as { timezoneLabel: { in: string[] } };
  const ianaClause = orClauses.find((c) => "timezoneIana" in c) as { timezoneIana: { in: string[] } };
  assert.deepEqual(labelClause.timezoneLabel.in, [...MOUNTAIN_FILTER_LABELS]);
  assert.ok(ianaClause.timezoneIana.in.includes("America/Phoenix"));
  assert.ok(ianaClause.timezoneIana.in.includes("America/Denver"));
  assert.deepEqual(ianaClause.timezoneIana.in, [...MOUNTAIN_FILTER_IANAS]);
});

test("buildLeadTimezoneMetaFilter: mountain matches legacy Phoenix rows labeled Mountain", () => {
  const f = buildLeadTimezoneMetaFilter({ timezoneZone: "mountain" });
  const labelClause = ((f as any).OR as Array<Record<string, unknown>>).find((c) => "timezoneLabel" in c) as {
    timezoneLabel: { in: string[] };
  };
  assert.ok(labelClause.timezoneLabel.in.includes("Mountain"));
  assert.ok(labelClause.timezoneLabel.in.includes("Arizona"));
});

test("resolveLeadTimezoneFromLocation: missing city/state → MISSING_LOCATION", () => {
  const r = resolveLeadTimezoneFromLocation("", "");
  assert.equal(r.timezoneResolutionStatus, "MISSING_LOCATION");
  assert.equal(r.timezoneIana, null);
});

test("resolveLeadTimezoneFromLocation: ambiguous city without state → NEEDS_REVIEW", () => {
  const r = resolveLeadTimezoneFromLocation("Springfield", "");
  assert.equal(r.timezoneResolutionStatus, "NEEDS_REVIEW");
});

test("resolveLeadTimezoneFromLocation: state-only uses fallback with NEEDS_REVIEW", () => {
  const r = resolveLeadTimezoneFromLocation(null, "TX");
  assert.equal(r.timezoneIana, "America/Chicago");
  assert.equal(r.timezoneResolutionStatus, "NEEDS_REVIEW");
});

test("normalizeUsStateAbbrev maps full state names", () => {
  assert.equal(normalizeUsStateAbbrev("New York"), "NY");
  assert.equal(normalizeUsStateAbbrev("ny"), "NY");
});

test("shouldRecomputeLeadTimezone detects city/state changes only", () => {
  assert.equal(shouldRecomputeLeadTimezone("Austin", "TX", "Austin", "TX"), false);
  assert.equal(shouldRecomputeLeadTimezone("Austin", "TX", "Dallas", "TX"), true);
  assert.equal(shouldRecomputeLeadTimezone("Austin", "TX", "Austin", "OK"), true);
});

test("ianaToTimezoneLabel maps common US zones", () => {
  assert.equal(ianaToTimezoneLabel("America/New_York"), "Eastern");
  assert.equal(ianaToTimezoneLabel("America/Chicago"), "Central");
  assert.equal(ianaToTimezoneLabel("America/Phoenix"), "Arizona");
  assert.equal(ianaToTimezoneLabel("America/Denver"), "Mountain");
  assert.equal(ianaToTimezoneLabel("Europe/London"), "Other");
});

test("buildLeadTimezoneMetaFilter: eastern zone", () => {
  assert.deepEqual(buildLeadTimezoneMetaFilter({ timezoneZone: "eastern" }), {
    timezoneLabel: "Eastern",
  });
});

test("resolveLeadTimezoneFromLocation: Los Angeles CA → America/Los_Angeles", () => {
  const r = resolveLeadTimezoneFromLocation("Los Angeles", "CA");
  assert.equal(r.timezoneIana, "America/Los_Angeles");
  assert.equal(r.timezoneLabel, "Pacific");
  assert.equal(r.timezoneResolutionStatus, "RESOLVED");
});

test("buildLeadTimezoneMetaFilter: other/needs review bucket", () => {
  const f = buildLeadTimezoneMetaFilter({ timezoneZone: "other" });
  assert.ok(Array.isArray((f as any).OR));
  assert.equal((f as any).OR.length, 4);
});

test("buildLeadTimezoneMetaFilter: timezoneIana exact match", () => {
  assert.deepEqual(buildLeadTimezoneMetaFilter({ timezoneIana: "America/Denver" }), {
    timezoneIana: "America/Denver",
  });
});

test("buildLeadTimezoneMetaFilter: empty input returns undefined", () => {
  assert.equal(buildLeadTimezoneMetaFilter({}), undefined);
});

test("buildLeadTimezoneMetaFilter is tenant-agnostic (caller adds tenantId)", () => {
  const f = buildLeadTimezoneMetaFilter({ timezoneZone: "pacific" });
  assert.deepEqual(f, { timezoneLabel: "Pacific" });
  assert.equal(Object.hasOwn(f ?? {}, "tenantId"), false);
});
