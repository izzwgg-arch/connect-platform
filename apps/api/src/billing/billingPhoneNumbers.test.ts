import test from "node:test";
import assert from "node:assert/strict";
import { isTollFreePhoneNumber, splitPhoneNumbersByKind } from "./billingPhoneNumbers";

test("isTollFreePhoneNumber: NANP toll-free NPAs", () => {
  assert.equal(isTollFreePhoneNumber("+18005551212"), true);
  assert.equal(isTollFreePhoneNumber("+18885551212"), true);
  assert.equal(isTollFreePhoneNumber("8445551212"), true);
  assert.equal(isTollFreePhoneNumber("+12125551212"), false);
  assert.equal(isTollFreePhoneNumber("+14155551212"), false);
});

test("splitPhoneNumbersByKind: mixed local and toll-free", () => {
  const rows = [
    { id: "a", phoneNumber: "+12125551212" },
    { id: "b", phoneNumber: "+18005551212" },
    { id: "c", phoneNumber: "+18885559999" },
  ];
  const { local, tollFree } = splitPhoneNumbersByKind(rows);
  assert.equal(local.length, 1);
  assert.equal(tollFree.length, 2);
  assert.equal(local[0].id, "a");
});
