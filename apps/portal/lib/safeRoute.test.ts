import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeInternalRoute } from "./safeRoute";

test("isSafeInternalRoute allows real internal paths", () => {
  assert.equal(isSafeInternalRoute("/voicemail"), true);
  assert.equal(isSafeInternalRoute("/crm/contacts/123"), true);
  assert.equal(isSafeInternalRoute("/billing?tab=invoices"), true);
});

test("⛔ isSafeInternalRoute blocks scriptable and off-origin values", () => {
  assert.equal(isSafeInternalRoute("javascript:alert(document.cookie)"), false);
  assert.equal(isSafeInternalRoute("data:text/html,<script>"), false);
  assert.equal(isSafeInternalRoute("//evil.com/x"), false, "protocol-relative off-origin");
  assert.equal(isSafeInternalRoute("/\\evil.com"), false, "backslash off-origin");
  assert.equal(isSafeInternalRoute("https://evil.com"), false);
  assert.equal(isSafeInternalRoute(""), false);
  assert.equal(isSafeInternalRoute(null), false);
  assert.equal(isSafeInternalRoute(undefined), false);
});
