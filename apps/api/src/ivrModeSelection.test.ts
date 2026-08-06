/**
 * Locks the 2026-08-05 menu-selection fix: publish must serve the menus the
 * Studio schedule picks, per mode, forever. The live shape that broke:
 * every menu typed business_hours, schedule choosing menus BY ID — the old
 * type-only matcher published an empty menu after hours and the first-created
 * menu during business hours.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCurrentMode, ivrFindActiveProfile, ivrModeToProfileType } from "./ivrModeSelection";

// The exact live shape from the incident: many menus, all business_hours.
const studioProfiles = [
  { id: "first-created-empty", type: "business_hours", name: "New menu" },
  { id: "press-2", type: "business_hours", name: "Press 2" },
  { id: "closed-menu", type: "business_hours", name: "Closed menu" },
  { id: "main-menu", type: "business_hours", name: "main menu" },
];
const studioSchedule = {
  defaultProfileId: "main-menu",
  afterHoursProfileId: "closed-menu",
  holidayProfileId: null,
};

test("business mode picks the schedule's default menu, NOT the first-created profile", () => {
  const p = ivrFindActiveProfile("business", studioProfiles, studioSchedule);
  assert.equal(p?.id, "main-menu");
});

test("afterhours mode picks the schedule's after-hours menu (regression: was null → empty publish)", () => {
  const p = ivrFindActiveProfile("afterhours", studioProfiles, studioSchedule);
  assert.equal(p?.id, "closed-menu");
});

test("afterhours with no after-hours selection falls back to the default menu, never to nothing", () => {
  const p = ivrFindActiveProfile("afterhours", studioProfiles, { ...studioSchedule, afterHoursProfileId: null });
  assert.equal(p?.id, "main-menu");
});

test("holiday falls back holiday → after-hours → default", () => {
  assert.equal(ivrFindActiveProfile("holiday", studioProfiles, studioSchedule)?.id, "closed-menu");
  assert.equal(
    ivrFindActiveProfile("holiday", studioProfiles, { ...studioSchedule, afterHoursProfileId: null })?.id,
    "main-menu",
  );
});

test("a schedule pointing at a deleted menu id falls through instead of crashing", () => {
  const p = ivrFindActiveProfile("business", studioProfiles, { defaultProfileId: "deleted-long-ago" });
  // No id match, no business_hours→schedule fallback id — legacy type match kicks in.
  assert.equal(p?.type, "business_hours");
});

test("legacy tenants (no schedule) still match by profile type", () => {
  const legacy = [
    { id: "a", type: "business_hours" },
    { id: "b", type: "after_hours" },
  ];
  assert.equal(ivrFindActiveProfile("afterhours", legacy, null)?.id, "b");
  assert.equal(ivrFindActiveProfile("business", legacy)?.id, "a");
});

test("override mode: manual_override first, emergency as fallback", () => {
  const profs = [
    { id: "e", type: "emergency" },
    { id: "m", type: "manual_override" },
  ];
  assert.equal(ivrFindActiveProfile("override", profs, studioSchedule)?.id, "m");
  assert.equal(ivrFindActiveProfile("override", [{ id: "e", type: "emergency" }], null)?.id, "e");
});

test("mode → legacy type mapping stays stable", () => {
  assert.equal(ivrModeToProfileType("business"), "business_hours");
  assert.equal(ivrModeToProfileType("afterhours"), "after_hours");
  assert.equal(ivrModeToProfileType("holiday"), "holiday");
  assert.equal(ivrModeToProfileType("override"), "manual_override");
  assert.equal(ivrModeToProfileType("nonsense"), null);
});

// ── computeCurrentMode — pinned instants in America/New_York ────────────────
const nySchedule = {
  timezone: "America/New_York",
  businessHoursRules: [
    { day: 1, open: "09:00", close: "17:00" },
    { day: 2, open: "09:00", close: "17:00" },
    { day: 3, open: "09:00", close: "17:00" },
    { day: 4, open: "09:00", close: "17:00" },
    { day: 5, open: "09:00", close: "17:00" },
  ],
  holidayDates: ["2026-12-25"],
};

test("a Wednesday evening in NY is afterhours (the incident's exact condition)", () => {
  // 2026-08-05 23:30 UTC = 19:30 ET, a Wednesday.
  assert.equal(computeCurrentMode(nySchedule, null, new Date("2026-08-05T23:30:00Z")), "afterhours");
});

test("a Wednesday mid-morning in NY is business", () => {
  // 2026-08-05 14:00 UTC = 10:00 ET.
  assert.equal(computeCurrentMode(nySchedule, null, new Date("2026-08-05T14:00:00Z")), "business");
});

test("open/close boundaries: 09:00 is business, 17:00 is afterhours", () => {
  assert.equal(computeCurrentMode(nySchedule, null, new Date("2026-08-05T13:00:00Z")), "business");   // 09:00 ET
  assert.equal(computeCurrentMode(nySchedule, null, new Date("2026-08-05T21:00:00Z")), "afterhours"); // 17:00 ET
});

test("weekends are afterhours; holidays win over weekday hours", () => {
  assert.equal(computeCurrentMode(nySchedule, null, new Date("2026-08-08T15:00:00Z")), "afterhours"); // Saturday
  assert.equal(computeCurrentMode(nySchedule, null, new Date("2026-12-25T15:00:00Z")), "holiday");    // Christmas, a Friday
});

test("an active override wins; an expired one is ignored", () => {
  const at = new Date("2026-08-05T14:00:00Z");
  assert.equal(computeCurrentMode(nySchedule, { isActive: true, expiresAt: null }, at), "override");
  assert.equal(
    computeCurrentMode(nySchedule, { isActive: true, expiresAt: new Date("2026-08-05T13:00:00Z") }, at),
    "business",
  );
});
