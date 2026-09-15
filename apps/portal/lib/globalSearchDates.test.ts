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

test("call deep links override the initial Today preset and reset conflicting filters", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../app/(platform)/calls/page.tsx", import.meta.url), "utf8");
  const preset = source.indexOf("}, [datePreset]);");
  const link = source.indexOf("useSearchNavigation(url => {");
  assert.ok(preset >= 0 && link > preset);
  const handler = source.slice(link, source.indexOf("// Build API query", link));
  for (const expected of ['setDatePreset("custom")', 'setActiveTab("all")', 'setDirectionFilter("all")', 'setHasRecording("all")']) assert.ok(handler.includes(expected));
});
