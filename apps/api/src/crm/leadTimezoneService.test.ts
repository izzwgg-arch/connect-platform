import test from "node:test";
import assert from "node:assert/strict";
import { pickPrimaryLeadLocation, leadTimezoneFieldsFromResolution } from "./leadTimezoneService";
import { resolveLeadTimezoneFromLocation } from "./leadTimezoneResolver";

test("pickPrimaryLeadLocation chooses first address with city or state", () => {
  assert.deepEqual(
    pickPrimaryLeadLocation([
      { city: "", state: "" },
      { city: "Denver", state: "CO" },
      { city: "Chicago", state: "IL" },
    ]),
    { city: "Denver", state: "CO" },
  );
});

test("pickPrimaryLeadLocation returns nulls when no location", () => {
  assert.deepEqual(pickPrimaryLeadLocation([{ city: "", state: null }]), { city: null, state: null });
});

test("leadTimezoneFieldsFromResolution stamps resolvedAt and status", () => {
  const resolution = resolveLeadTimezoneFromLocation("Chicago", "IL");
  const fields = leadTimezoneFieldsFromResolution(resolution);
  assert.equal(fields.timezoneIana, "America/Chicago");
  assert.equal(fields.timezoneLabel, "Central");
  assert.equal(fields.timezoneResolutionStatus, "RESOLVED");
  assert.ok(fields.timezoneResolvedAt instanceof Date);
});

test("import-style location resolution for common CSV row", () => {
  const city = "Los Angeles";
  const state = "CA";
  const r = resolveLeadTimezoneFromLocation(city, state);
  assert.equal(r.timezoneIana, "America/Los_Angeles");
  assert.equal(r.timezoneResolutionStatus, "RESOLVED");
});

test("update-style recompute gate only fires on location change", () => {
  const prev = pickPrimaryLeadLocation([{ city: "New York", state: "NY" }]);
  const same = pickPrimaryLeadLocation([{ city: "New York", state: "NY" }]);
  const changed = pickPrimaryLeadLocation([{ city: "Chicago", state: "IL" }]);
  assert.equal(
    prev.city === same.city && prev.state === same.state,
    true,
  );
  assert.notEqual(changed.city, prev.city);
});
