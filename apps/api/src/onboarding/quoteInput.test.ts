import test from "node:test";
import assert from "node:assert/strict";

import { quoteInputForSubmission } from "./quoteInput";

test("post-submit: requestedExtensions rows + smsEnabled column win", () => {
  const input = quoteInputForSubmission({
    requestedExtensions: [{}, {}, {}],
    smsEnabled: true,
    // Stale draft answers must NOT override what was actually submitted.
    answers: { extensions: [{ displayName: "Old", extNumber: "101" }], addons: { smsEnabled: false } },
  });
  assert.deepEqual(input, { extensions: 3, phoneNumbers: 1, smsEnabled: true });
});

test("pre-submit: falls back to autosaved answers, counting only rows submit would keep", () => {
  const input = quoteInputForSubmission({
    requestedExtensions: [],
    smsEnabled: false, // the column defaults to false until submit stamps it
    answers: {
      extensions: [
        { displayName: "Jane", extNumber: "101" },
        { displayName: "Bob", extNumber: "102" },
        { displayName: "", extNumber: "103" },     // no name → submit drops it
        { displayName: "Half Row", extNumber: "" }, // no number → submit drops it
      ],
      addons: { smsEnabled: true },
    },
  });
  assert.deepEqual(input, { extensions: 2, phoneNumbers: 1, smsEnabled: true });
});

test("pre-submit with no addons answer: smsEnabled column is the fallback", () => {
  const input = quoteInputForSubmission({
    requestedExtensions: null,
    smsEnabled: false,
    answers: { extensions: [{ displayName: "Jane", extNumber: "101" }] },
  });
  assert.equal(input.smsEnabled, false);
});

test("extra numbers from answers.phone.extraNumbers, garbage ignored", () => {
  assert.equal(quoteInputForSubmission({ answers: { phone: { extraNumbers: 2 } } }).phoneNumbers, 3);
  assert.equal(quoteInputForSubmission({ answers: { phone: { extraNumbers: "nope" } } }).phoneNumbers, 1);
  assert.equal(quoteInputForSubmission({ answers: { phone: { extraNumbers: -4 } } }).phoneNumbers, 1);
  assert.equal(quoteInputForSubmission({}).phoneNumbers, 1);
});

test("empty submission quotes zero extensions rather than throwing", () => {
  const input = quoteInputForSubmission({ requestedExtensions: null, answers: null });
  assert.deepEqual(input, { extensions: 0, phoneNumbers: 1, smsEnabled: false });
});
