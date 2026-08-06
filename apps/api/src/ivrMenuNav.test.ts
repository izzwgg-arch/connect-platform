/**
 * Pins the submenu-navigation ref rewrites: "Another menu" keys stored as
 * connect-tenant-ivr,<cuid>,1 were dead on the live dialplan (digit-only
 * pattern) — publish must rewrite them to the [connect-menu] engine with the
 * lag-preventing m- exten prefix, and must leave every other ref untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { menuEntryRef, rewriteMenuNavRef, MENU_EXTEN_PREFIX } from "./ivrMenuNav";

test("ivr refs with a cuid exten are rewritten to the submenu engine with the m prefix (hyphen-free — Asterisk strips '-')", () => {
  assert.equal(
    rewriteMenuNavRef("ivr", "connect-tenant-ivr,cmsgpcu3e01jqmg13ax642hk1,1", { inMenuFamily: false }),
    "connect-menu,mcmsgpcu3e01jqmg13ax642hk1,1",
  );
  assert.equal(menuEntryRef("abc123"), `connect-menu,${MENU_EXTEN_PREFIX}abc123,1`);
});

test("the rewrite applies identically inside menu families", () => {
  assert.equal(
    rewriteMenuNavRef("ivr", "connect-tenant-ivr,cmsewyudm02bon013f8svvk56,1", { inMenuFamily: true }),
    "connect-menu,mcmsewyudm02bon013f8svvk56,1",
  );
});

test("ivr refs with digit or s extens are real top-context extens — untouched", () => {
  assert.equal(rewriteMenuNavRef("ivr", "connect-tenant-ivr,s,1", { inMenuFamily: false }), "connect-tenant-ivr,s,1");
  assert.equal(rewriteMenuNavRef("ivr", "connect-tenant-ivr,8457231213,1", { inMenuFamily: false }), "connect-tenant-ivr,8457231213,1");
});

test("recording refs are redirected to the per-menu play-prompt ONLY inside menu families", () => {
  assert.equal(
    rewriteMenuNavRef("announcement", "connect-play-prompt,s,1", { inMenuFamily: true }),
    "connect-menu-play-prompt,s,1",
  );
  assert.equal(
    rewriteMenuNavRef("announcement", "connect-play-prompt,s,1", { inMenuFamily: false }),
    "connect-play-prompt,s,1",
  );
});

test("every other ref passes through byte-identical", () => {
  assert.equal(rewriteMenuNavRef("extension", "T35_cos-all,1101,1", { inMenuFamily: true }), "T35_cos-all,1101,1");
  assert.equal(rewriteMenuNavRef("queue", "T35_ext-queues,900,1", { inMenuFamily: false }), "T35_ext-queues,900,1");
  assert.equal(rewriteMenuNavRef("external_number", "18455551234", { inMenuFamily: true }), "18455551234");
  assert.equal(rewriteMenuNavRef(null, "anything,at,all", { inMenuFamily: false }), "anything,at,all");
  assert.equal(rewriteMenuNavRef("ivr", "", { inMenuFamily: false }), "");
  assert.equal(rewriteMenuNavRef("ivr", null, { inMenuFamily: true }), "");
});
