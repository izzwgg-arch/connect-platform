// The prices a new customer is quoted at sign-up and charged on their first
// invoice. Money bugs are the ones customers remember, so every number Izzy
// specified on 2026-08-04 is asserted literally here — if someone changes a
// price, they have to change a test that spells out the promise.
import test from "node:test";
import assert from "node:assert/strict";
import { ONBOARDING_PRICES, quoteOnboarding, formatCents, describeQuote } from "./onboardingPricing";

test("the agreed prices, exactly as stated", () => {
  assert.equal(ONBOARDING_PRICES.extensionMonthlyCents, 2500);          // $25 before tax
  assert.equal(ONBOARDING_PRICES.extensionMonthlyWithTaxCents, 3000);   // $30 all-in
  assert.equal(ONBOARDING_PRICES.e911MonthlyCents, 300);               // $3
  assert.equal(ONBOARDING_PRICES.smsMonthlyCents, 1000);               // $10
  assert.equal(ONBOARDING_PRICES.additionalNumberMonthlyCents, 1000);  // $10
  assert.equal(ONBOARDING_PRICES.telecomFeesMonthlyCents, 200);        // $2 flat fees
});

test("the floor Izzy set: one person, one number = exactly $35", () => {
  const q = quoteOnboarding({ extensions: 1, phoneNumbers: 1, smsEnabled: false });
  // $30 line + $3 E911 + $2 telecom & regulatory fees.
  assert.equal(q.monthlyTotalCents, 3500);
  assert.equal(describeQuote(q), "$35.00 a month, including tax.");
  const fees = q.lines.find((l) => l.key === "telecom_fees")!;
  assert.equal(fees.totalCents, 200);
});

test("a typical small business: 3 people, one number, no texting", () => {
  const q = quoteOnboarding({ extensions: 3, phoneNumbers: 1, smsEnabled: false });
  // 3 × $30 = $90, plus $3 E911 on the one number, plus $2 flat fees.
  assert.equal(q.monthlyTotalCents, 9500);
  assert.equal(describeQuote(q), "$95.00 a month, including tax.");
});

test("the first phone number is included; only extras are charged", () => {
  const one = quoteOnboarding({ extensions: 1, phoneNumbers: 1, smsEnabled: false });
  assert.equal(one.lines.some((l) => l.key === "additional_numbers"), false);

  const three = quoteOnboarding({ extensions: 1, phoneNumbers: 3, smsEnabled: false });
  const extra = three.lines.find((l) => l.key === "additional_numbers")!;
  assert.equal(extra.quantity, 2);          // 3 numbers = 2 extras
  assert.equal(extra.totalCents, 2000);     // 2 × $10
});

test("E911 is per phone number, not per extension", () => {
  // 10 people sharing one number still pay E911 once.
  const q = quoteOnboarding({ extensions: 10, phoneNumbers: 1, smsEnabled: false });
  assert.equal(q.lines.find((l) => l.key === "e911")!.totalCents, 300);
});

test("texting is a flat $10 however many people or numbers", () => {
  const small = quoteOnboarding({ extensions: 1, phoneNumbers: 1, smsEnabled: true });
  const big = quoteOnboarding({ extensions: 40, phoneNumbers: 5, smsEnabled: true });
  assert.equal(small.lines.find((l) => l.key === "sms")!.totalCents, 1000);
  assert.equal(big.lines.find((l) => l.key === "sms")!.totalCents, 1000);
});

test("everything at once adds up", () => {
  // 5 people, 2 numbers, texting on.
  const q = quoteOnboarding({ extensions: 5, phoneNumbers: 2, smsEnabled: true });
  //  5 × $30 = $150
  //  2 × $3  =   $6   (E911 on both numbers)
  //  1 × $10 =  $10   (the second number)
  //  1 × $10 =  $10   (texting)
  //  1 × $2  =   $2   (telecom & regulatory fees, flat)
  assert.equal(q.monthlyTotalCents, 15000 + 600 + 1000 + 1000 + 200);
  assert.equal(q.monthlyTotalCents, 17800);
});

test("an empty quote charges nothing rather than inventing a minimum", () => {
  const q = quoteOnboarding({ extensions: 0, phoneNumbers: 0, smsEnabled: false });
  assert.deepEqual(q.lines, []);
  assert.equal(q.monthlyTotalCents, 0);
  assert.equal(describeQuote(q), "Nothing to pay yet.");
});

test("nonsense input can't produce a negative bill", () => {
  const q = quoteOnboarding({ extensions: -5, phoneNumbers: -2, smsEnabled: false });
  assert.equal(q.monthlyTotalCents, 0);
  // A negative number count must not become a negative "extra numbers" credit.
  assert.equal(q.lines.some((l) => l.totalCents < 0), false);
});

test("fractional counts are floored, never rounded up into a bigger bill", () => {
  const q = quoteOnboarding({ extensions: 2.9, phoneNumbers: 1.9, smsEnabled: false });
  assert.equal(q.lines.find((l) => l.key === "extensions")!.quantity, 2);
  assert.equal(q.lines.find((l) => l.key === "e911")!.quantity, 1);
});

test("money formatting keeps its cents", () => {
  assert.equal(formatCents(3000), "$30.00");
  assert.equal(formatCents(9300), "$93.00");
  assert.equal(formatCents(305), "$3.05");
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(-500), "-$5.00");
});

test("one line reads naturally in the singular", () => {
  const q = quoteOnboarding({ extensions: 1, phoneNumbers: 1, smsEnabled: false });
  assert.equal(q.lines.find((l) => l.key === "extensions")!.label, "Phone line");
  const many = quoteOnboarding({ extensions: 2, phoneNumbers: 1, smsEnabled: false });
  assert.equal(many.lines.find((l) => l.key === "extensions")!.label, "Phone lines");
});
