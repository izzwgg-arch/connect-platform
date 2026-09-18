import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarNote, holidayNotes, shabbosNote } from "./calendar.js";

test("a Friday evening event in December overlaps Shabbos", () => {
  const start = new Date("2026-12-18T20:00:00-05:00"); // Fri 8pm ET, candle-lighting is ~4:12pm that day
  const end = new Date("2026-12-18T22:00:00-05:00");
  assert.equal(shabbosNote(start, end), "Overlaps Shabbos — check the time");
});

test("a Wednesday morning event gets no Shabbos note", () => {
  const start = new Date("2026-09-16T10:00:00-04:00");
  const end = new Date("2026-09-16T12:00:00-04:00");
  assert.equal(shabbosNote(start, end), null);
});

test("a Friday morning event that ends well before sunset gets the 'ends well before Shabbos' note", () => {
  const start = new Date("2026-09-18T08:00:00-04:00"); // Fri 8am ET
  const end = new Date("2026-09-18T10:00:00-04:00"); // Fri 10am ET, hours before candle-lighting
  assert.equal(shabbosNote(start, end), "Ends well before Shabbos");
});

test("2026-09-21 is Yom Kippur", () => {
  const d = new Date("2026-09-21T10:00:00-04:00");
  assert.equal(holidayNotes(d), "Yom Kippur");
  assert.equal(calendarNote(d, new Date("2026-09-21T12:00:00-04:00")), "Falls on Yom Kippur");
});

test("a plain weekday with no holiday returns no calendar note", () => {
  const d = new Date("2026-09-16T10:00:00-04:00");
  assert.equal(holidayNotes(d), null);
  assert.equal(calendarNote(d, new Date("2026-09-16T12:00:00-04:00")), null);
});

test("a Saturday afternoon event overlaps Shabbos too", () => {
  const start = new Date("2026-09-19T14:00:00-04:00"); // Sat 2pm ET
  const end = new Date("2026-09-19T16:00:00-04:00");
  assert.equal(shabbosNote(start, end), "Overlaps Shabbos — check the time");
});
