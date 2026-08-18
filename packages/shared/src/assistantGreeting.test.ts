import test from "node:test";
import assert from "node:assert/strict";
import { assistantGreetingLine, greetingName, timeGreeting } from "./assistantGreeting";

test("an email address is never greeted as a name", () => {
  // useAppContext falls back to the email when no display name is set, so this
  // is the common case for a brand-new account — not an edge case.
  assert.equal(greetingName("izzy@gmail.com"), null);
  assert.equal(greetingName("  joel.landau@example.co.uk "), null);
  assert.equal(assistantGreetingLine("izzy@gmail.com", new Date("2026-08-17T15:00:00")), "Good afternoon.");
});

test("the placeholder identity is not a name either", () => {
  assert.equal(greetingName("User"), null);
  assert.equal(greetingName("user"), null);
  assert.equal(greetingName(""), null);
  assert.equal(greetingName(null), null);
  assert.equal(greetingName(undefined), null);
});

test("only the first name is used", () => {
  assert.equal(greetingName("Joel Landau"), "Joel");
  assert.equal(greetingName("  Sender   Weiss  "), "Sender");
});

test("names outside the Latin alphabet survive", () => {
  assert.equal(greetingName("יואל לנדאו"), "יואל");
  assert.equal(greetingName("Ávila Pérez"), "Ávila");
  assert.equal(greetingName("O'Brien"), "O'Brien");
  assert.equal(greetingName("Anne-Marie Dubois"), "Anne-Marie");
});

test("a name that is really punctuation is refused rather than rendered", () => {
  assert.equal(greetingName("."), null);
  assert.equal(greetingName("!!!"), null);
  assert.equal(greetingName("A"), null, "one letter reads as an initial, not a name");
  assert.equal(greetingName("Bartholomewlongnameindeedyes"), null, "too long to sit in a greeting");
});

test("the time of day comes from the given clock", () => {
  assert.equal(timeGreeting(new Date("2026-08-17T08:30:00")), "Good morning");
  assert.equal(timeGreeting(new Date("2026-08-17T11:59:00")), "Good morning");
  assert.equal(timeGreeting(new Date("2026-08-17T12:00:00")), "Good afternoon");
  assert.equal(timeGreeting(new Date("2026-08-17T17:59:00")), "Good afternoon");
  assert.equal(timeGreeting(new Date("2026-08-17T18:00:00")), "Good evening");
  assert.equal(timeGreeting(new Date("2026-08-17T23:59:00")), "Good evening");
});

test("the full line is assembled in one place", () => {
  assert.equal(assistantGreetingLine("Joel Landau", new Date("2026-08-17T09:00:00")), "Good morning, Joel.");
  assert.equal(assistantGreetingLine(null, new Date("2026-08-17T20:00:00")), "Good evening.");
});
