import test from "node:test";
import assert from "node:assert/strict";
import {
  isConnectMohRuntimeClass,
  isNativeMohRuntimeClass,
  isValidMohRuntimeClass,
  normalizeMohRuntimeClass,
} from "@connect/shared";

test("native mohN accepted", () => {
  assert.equal(isValidMohRuntimeClass("moh3"), true);
  assert.equal(isNativeMohRuntimeClass("MOH12"), true);
});

test("connect_* accepted", () => {
  assert.equal(isValidMohRuntimeClass("connect_acme_holiday_jazz"), true);
  assert.equal(isConnectMohRuntimeClass("CONNECT_TENANT_NAME"), true);
});

test("path traversal and unsafe chars rejected", () => {
  assert.equal(isValidMohRuntimeClass("../moh1"), false);
  assert.equal(isValidMohRuntimeClass("moh1/../x"), false);
  assert.equal(isValidMohRuntimeClass("connect_a;b"), false);
  assert.equal(isValidMohRuntimeClass("connect_a b"), false);
  assert.equal(isValidMohRuntimeClass("connect_a-b"), false);
});

test("arbitrary class names rejected", () => {
  assert.equal(isValidMohRuntimeClass("default"), false);
  assert.equal(isValidMohRuntimeClass("custom_class"), false);
});

test("normalizeMohRuntimeClass trims", () => {
  assert.equal(normalizeMohRuntimeClass("  moh2  "), "moh2");
});
