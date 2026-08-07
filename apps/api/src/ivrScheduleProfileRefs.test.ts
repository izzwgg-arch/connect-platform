/**
 * PUT /voice/ivr/schedule — validating which menus a schedule may reference.
 *
 * Regression for a live trap on 2026-08-06. The route collected the three
 * per-mode profile ids into a list and compared its LENGTH against the number
 * of rows findMany returned. Point two modes at the SAME menu — the same menu
 * for open hours and closed hours, which is what most small businesses want and
 * the fastest way to get a new customer live — and the list held 2 entries
 * while the query answered with 1 row. The save was rejected as
 * "profile_not_found".
 *
 * That closed a loop with no exit: the schedule could not be saved, so no menu
 * was selected for the current mode, so publish refused with "no menu is
 * selected to play right now", so the customer went back to the schedule. A
 * bare slug on screen was the only explanation offered.
 *
 * The rule under test is small and pure, so it is asserted directly rather than
 * through a Fastify harness — the arithmetic is the whole bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/** The route's check, extracted verbatim in shape (post-fix). */
function referencedProfileIds(schedule: {
  defaultProfileId?: string | null;
  afterHoursProfileId?: string | null;
  holidayProfileId?: string | null;
}): string[] {
  return Array.from(new Set(
    [schedule.defaultProfileId, schedule.afterHoursProfileId, schedule.holidayProfileId]
      .filter((x): x is string => typeof x === "string" && x.length > 0),
  ));
}

/** What the DB would answer for those ids (unique rows, as findMany does). */
function rowsFor(ids: string[], existing: Set<string>): string[] {
  return Array.from(new Set(ids)).filter((id) => existing.has(id));
}

const EXISTS = new Set(["menu-a", "menu-b"]);

test("THE TRAP: one menu serving both open and closed hours is accepted", () => {
  const ids = referencedProfileIds({ defaultProfileId: "menu-a", afterHoursProfileId: "menu-a", holidayProfileId: null });
  assert.deepEqual(ids, ["menu-a"], "the same menu twice must collapse to one id");
  assert.equal(rowsFor(ids, EXISTS).length, ids.length, "counts must match, or the save is refused");
});

test("one menu serving ALL THREE modes is accepted", () => {
  const ids = referencedProfileIds({ defaultProfileId: "menu-a", afterHoursProfileId: "menu-a", holidayProfileId: "menu-a" });
  assert.deepEqual(ids, ["menu-a"]);
  assert.equal(rowsFor(ids, EXISTS).length, ids.length);
});

test("different menus per mode still validate", () => {
  const ids = referencedProfileIds({ defaultProfileId: "menu-a", afterHoursProfileId: "menu-b", holidayProfileId: null });
  assert.deepEqual(ids.sort(), ["menu-a", "menu-b"]);
  assert.equal(rowsFor(ids, EXISTS).length, ids.length);
});

test("a genuinely missing menu is STILL rejected — the guard must keep working", () => {
  const ids = referencedProfileIds({ defaultProfileId: "menu-a", afterHoursProfileId: "deleted-menu", holidayProfileId: null });
  assert.notEqual(rowsFor(ids, EXISTS).length, ids.length, "a schedule pointing at a menu that does not exist must not save");
});

test("a duplicate of a MISSING menu is still rejected, not hidden by the dedupe", () => {
  const ids = referencedProfileIds({ defaultProfileId: "gone", afterHoursProfileId: "gone", holidayProfileId: null });
  assert.deepEqual(ids, ["gone"]);
  assert.notEqual(rowsFor(ids, EXISTS).length, ids.length);
});

test("empty and null slots are not treated as menus", () => {
  assert.deepEqual(referencedProfileIds({ defaultProfileId: null, afterHoursProfileId: "", holidayProfileId: undefined }), []);
});
