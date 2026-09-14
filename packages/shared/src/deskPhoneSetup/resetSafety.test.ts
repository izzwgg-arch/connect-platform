/**
 * ⛔⛔ FACTORY RESET FIRST, ALWAYS — Izzy, 2026-09-11, restated 2026-09-14: "The first
 * thing that happens before connecting any phone to my system is a factory reset."
 *
 * This fence used to refuse analog adapters, cordless bases, door/paging devices and
 * anything that might be on Wi-Fi. Those refusals were removed on his instruction, after
 * the costs were put to him in writing. Ticking a device is the consent. The one refusal
 * left is a device nobody can name — a wipe must at least know what it is wiping.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { VENDOR_CATALOG, VENDOR_SLUGS } from "./vendorCatalog.generated";
import {
  decideFactoryReset,
  modelCanUseWifi,
  applyCableAnswer,
  RESET_REFUSED_FALLBACK,
} from "./resetSafety";

test("every device shape a person can tick is cleared, on every link", () => {
  for (const model of [
    "T46G", "T42S", "GXP2170", "GRP2612", "X4U", "SIP-T23G", // desk phones
    "HT801", "HT812", "DAG1000-4S",                          // analog adapters
    "W60B", "W70B", "KX-TGP600",                              // cordless bases
    "GDS3710", "i16V", "PA2",                                 // door / paging
  ]) {
    for (const link of ["wired", "wireless", "unknown"] as const) {
      assert.equal(decideFactoryReset({ model, link }).allowed, true, `${model}/${link}`);
    }
  }
});

test("Izzy's own T53W is cleared — a Wi-Fi-capable phone is no longer refused", () => {
  for (const link of ["wired", "wireless", "unknown"] as const) {
    assert.equal(decideFactoryReset({ model: "T53W", link }).allowed, true, link);
  }
});

test("the cable question no longer changes the verdict", () => {
  const subject = { model: "T53W", link: "unknown" as const };
  assert.equal(decideFactoryReset(applyCableAnswer(subject, true)).allowed, true);
  assert.equal(decideFactoryReset(applyCableAnswer(subject, false)).allowed, true);
});

test("a device nobody can name is not cleared, and the customer is told in plain words", () => {
  const v = decideFactoryReset({ model: "", link: "wired" });
  assert.equal(v.allowed, false);
  if (v.allowed) return;
  assert.equal(v.reason, "model_unknown");
  assert.ok(v.customerMessage.length > 20);
  assert.ok(
    !/\b(ata|cordless_base|doorbell|pager|reset_over_lan|rung|NEEDS_ATTENTION|provisioning)\b/i.test(v.customerMessage),
    v.customerMessage,
  );
  // and the way through is the same non-destructive one
  assert.equal(RESET_REFUSED_FALLBACK, "set_provisioning");
});

test("modelCanUseWifi reads both spellings of a model name", () => {
  assert.equal(modelCanUseWifi("T53W"), true);
  assert.equal(modelCanUseWifi("SIP-T54W"), true);
  assert.equal(modelCanUseWifi("Yealink T57W".split(" ")[1]), true);
  assert.equal(modelCanUseWifi("WP820"), true);
  assert.equal(modelCanUseWifi("T46G"), false);
  assert.equal(modelCanUseWifi("GXP2170"), false);
  assert.equal(modelCanUseWifi(null), false);
  assert.equal(modelCanUseWifi(""), false);
});

test("the whole catalogue: every named model may be cleared", () => {
  // Walks the real catalogue, not a hand-picked list, so a family added next year is
  // covered by the same rule.
  let checked = 0;
  for (const slug of VENDOR_SLUGS) {
    for (const m of VENDOR_CATALOG[slug].models) {
      if (!String(m.model ?? "").trim()) continue;
      assert.equal(decideFactoryReset({ model: m.model, link: "unknown" }).allowed, true, m.model);
      checked += 1;
    }
  }
  assert.ok(checked > 400, `walked ${checked} models`);
});
