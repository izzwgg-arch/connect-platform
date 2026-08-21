/**
 * The pasted-address parser. Shared by the portal's chip input and the API's
 * validator, so it is tested once, here.
 */
import assert from "node:assert";
import test from "node:test";
import { MAX_INVITES_PER_MEETING, parseInviteEmails } from "./inviteEmailList";

test("Outlook 'Name <a@b.com>' paste — names are never reported as errors", () => {
  const r = parseInviteEmails("Sara Klein <sara@x.com>, Moshe Berger <moshe@y.com>");
  assert.deepEqual(r.emails, ["sara@x.com", "moshe@y.com"]);
  assert.deepEqual(r.invalid, []);
});

test("multi-label domains are valid (.co.uk, subdomains)", () => {
  // ⛔ Regression guard: the first cut refused every .co.uk address.
  const r = parseInviteEmails("a@y.co.uk, b@mail.corp.example.com");
  assert.deepEqual(r.emails, ["a@y.co.uk", "b@mail.corp.example.com"]);
});

test("commas, semicolons, newlines and tabs all separate", () => {
  const r = parseInviteEmails("one@a.com;two@b.com\nthree@c.com\tfour@d.com , five@e.com");
  assert.equal(r.emails.length, 5);
});

test("case-insensitive dedupe; junk reported; mailto: stripped", () => {
  const r = parseInviteEmails("Moshe@Y.com, moshe@y.com, BAD@@, a@b, mailto:z@q.io");
  assert.deepEqual(r.emails, ["moshe@y.com", "z@q.io"]);
  assert.deepEqual(r.invalid, ["BAD@@", "a@b"]);
});

test("the cap is reported, not silently applied", () => {
  const many = Array.from({ length: MAX_INVITES_PER_MEETING + 3 }, (_, i) => `p${i}@x.com`).join(",");
  const r = parseInviteEmails(many);
  assert.equal(r.emails.length, MAX_INVITES_PER_MEETING);
  assert.equal(r.truncated, true);
});

test("an array is accepted exactly like a pasted string", () => {
  assert.deepEqual(parseInviteEmails(["a@b.com", "c@d.com"]).emails, ["a@b.com", "c@d.com"]);
  assert.deepEqual(parseInviteEmails(null).emails, []);
  assert.deepEqual(parseInviteEmails("").emails, []);
});
