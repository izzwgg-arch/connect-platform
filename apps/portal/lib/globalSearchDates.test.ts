import test from "node:test";
import assert from "node:assert/strict";
import { searchDayRange } from "./globalSearchDates";

test("call search links contain late-evening calls west of UTC", () => {
  assert.deepEqual(searchDayRange("2026-09-15", "America/New_York"), { startDate: "2026-09-14", endDate: "2026-09-15" });
});
test("call links handle eastern timezones, year boundaries and daylight savings", () => {
  assert.deepEqual(searchDayRange("2026-12-31", "Asia/Tokyo"), { startDate: "2026-12-31", endDate: "2027-01-01" });
  assert.deepEqual(searchDayRange("2026-03-08", "America/New_York"), { startDate: "2026-03-07", endDate: "2026-03-08" });
  assert.deepEqual(searchDayRange("2026-09-15", "UTC"), { startDate: "2026-09-15", endDate: "2026-09-15" });
});
test("invalid date links cannot create invalid call filters", () => {
  for (const value of ["", "wrong", "2026-02-31", "2026-13-01"]) assert.equal(searchDayRange(value), null);
});
