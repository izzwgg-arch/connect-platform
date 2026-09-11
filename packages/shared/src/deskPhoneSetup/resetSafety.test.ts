/**
 * ⛔ THE FOUR DEVICES ON IZZY'S OWN DESK ARE THE FIXTURES, because they are exactly the
 * mix that makes "reset them all first" dangerous: a Wi-Fi-capable Yealink, two wired
 * desk phones and two analog adapters. Three of the five must never be wiped.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { VENDOR_CATALOG, VENDOR_SLUGS } from "./vendorCatalog.generated";
import { deviceKindFor } from "./deviceKinds";
import {
  decideFactoryReset,
  modelCanUseWifi,
  applyCableAnswer,
  RESET_REFUSED_FALLBACK,
} from "./resetSafety";

test("a wired desk phone may be cleared — otherwise the ladder has no last rung", () => {
  const v = decideFactoryReset({ model: "GXP2170", link: "wired" });
  assert.equal(v.allowed, true);
});

test("a phone that says it is on Wi-Fi is NEVER cleared", () => {
  // ⛔ The unrecoverable one. It forgets the network name and password, comes back on
  // no network, and nothing on earth can reach it again.
  const v = decideFactoryReset({ model: "T53W", link: "wireless" });
  assert.equal(v.allowed, false);
  if (v.allowed) return;
  assert.equal(v.reason, "wireless_forgets_network");
  assert.match(v.customerMessage, /Wi-Fi/);
  assert.ok(!v.ask, "there is nothing to ask — the phone already told us");
});

test("Izzy's own T53W is not cleared on a guess", () => {
  // ⛔ THE CASE THAT MATTERS MOST. His Yealink never said how it was attached, and the
  // W is Yealink's Wi-Fi variant — so a blind reset-everything-first could have made
  // the one phone this whole engagement is about unreachable forever.
  const v = decideFactoryReset({ model: "T53W", link: "unknown" });
  assert.equal(v.allowed, false);
  if (v.allowed) return;
  assert.equal(v.reason, "wireless_capable_unconfirmed");
  assert.ok(v.ask, "a yes/no is the price of not bricking it");
  assert.match(v.ask!.question, /cable/i);
});

test("the one question, answered, is the only thing that upgrades an unknown link", () => {
  const subject = { model: "T53W", link: "unknown" as const };
  assert.equal(decideFactoryReset(applyCableAnswer(subject, true)).allowed, true);
  const no = decideFactoryReset(applyCableAnswer(subject, false));
  assert.equal(no.allowed, false);
  if (!no.allowed) assert.equal(no.reason, "wireless_forgets_network");
});

test("a model with no wireless at all stays hands-off", () => {
  // ⛔ This is what keeps the promise. If every unknown link needed a question, the
  // wizard would ask about every phone in the building and nothing would be automatic.
  for (const model of ["T46G", "T42S", "GXP2170", "GRP2612", "X4U", "SIP-T23G"]) {
    assert.equal(decideFactoryReset({ model, link: "unknown" }).allowed, true, model);
  }
});

test("an analog adapter is never cleared, cable or no cable", () => {
  // ⛔ Both of Izzy's HTs. A reset takes the analog line settings with it, so the
  // customer's ordinary phones and fax go dead until somebody re-enters them.
  for (const link of ["wired", "wireless", "unknown"] as const) {
    for (const model of ["HT801", "HT812", "DAG1000-4S"]) {
      const v = decideFactoryReset({ model, link });
      assert.equal(v.allowed, false, `${model}/${link}`);
      if (!v.allowed) assert.equal(v.reason, "ata_analog_lines", model);
    }
  }
});

test("a cordless base is never cleared — it would unpair every handset", () => {
  for (const model of ["W60B", "W70B", "KX-TGP600"]) {
    const v = decideFactoryReset({ model, link: "wired" });
    assert.equal(v.allowed, false, model);
    if (!v.allowed) assert.equal(v.reason, "cordless_unpairs_handsets", model);
  }
});

test("a door intercom or a ceiling speaker is never cleared", () => {
  for (const model of ["GDS3710", "i16V", "PA2"]) {
    const v = decideFactoryReset({ model, link: "wired" });
    assert.equal(v.allowed, false, model);
    if (!v.allowed) assert.equal(v.reason, "door_or_paging", model);
  }
});

test("a device nobody can name is not cleared", () => {
  const v = decideFactoryReset({ model: "", link: "wired" });
  assert.equal(v.allowed, false);
  if (!v.allowed) assert.equal(v.reason, "model_unknown");
});

test("shape beats link — a wired analog adapter is still an analog adapter", () => {
  // ⛔ Ordering guard. Being on a cable makes a RESET recoverable for the NETWORK; it
  // does nothing for the analog lines, so the shape refusals must come first.
  const v = decideFactoryReset({ model: "HT812", link: "wired" });
  assert.equal(v.allowed, false);
  if (!v.allowed) assert.equal(v.reason, "ata_analog_lines");
});

test("every refusal tells the customer what happens instead, in plain words", () => {
  const refusals = [
    { model: "HT801", link: "wired" as const },
    { model: "W60B", link: "wired" as const },
    { model: "GDS3710", link: "wired" as const },
    { model: "T53W", link: "wireless" as const },
    { model: "T53W", link: "unknown" as const },
    { model: "", link: "wired" as const },
  ];
  for (const s of refusals) {
    const v = decideFactoryReset(s);
    assert.equal(v.allowed, false, s.model);
    if (v.allowed) continue;
    assert.ok(v.customerMessage.length > 20, s.model);
    // ⛔ No jargon, no internal name, no rung number.
    assert.ok(
      !/\b(ata|cordless_base|doorbell|pager|reset_over_lan|rung|NEEDS_ATTENTION|provisioning)\b/i.test(
        v.customerMessage,
      ),
      `${s.model}: ${v.customerMessage}`,
    );
  }
  // And the way through is always the same non-destructive one.
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

test("the fence is swept across all 427 catalogue models and refuses every unsafe shape", () => {
  // ⛔ NOT a hand-picked list. Walking the real catalogue is what catches the model
  // family somebody adds next year — the same discipline vendorCoverage uses.
  let allowed = 0;
  let refusedShape = 0;
  let askedAboutWifi = 0;
  for (const slug of VENDOR_SLUGS) {
    for (const m of VENDOR_CATALOG[slug].models) {
      const v = decideFactoryReset({ model: m.model, link: "unknown" });
      const kind = deviceKindFor(m.model);
      if (kind === "ata" || kind === "cordless_base" || kind === "doorbell" || kind === "pager") {
        assert.equal(v.allowed, false, `${m.model} (${kind}) must be refused`);
        refusedShape += 1;
        continue;
      }
      if (v.allowed) {
        allowed += 1;
        // Anything allowed on an unknown link must be a model that cannot do Wi-Fi.
        assert.equal(modelCanUseWifi(m.model), false, `${m.model} allowed but can do Wi-Fi`);
      } else {
        askedAboutWifi += 1;
      }
    }
  }
  assert.ok(refusedShape > 0, "the catalogue really does contain ATAs and bases");
  assert.ok(allowed > 0, "and it really does contain ordinary wired desk phones");
  assert.ok(askedAboutWifi > 0, "and Wi-Fi-capable models that need the one question");
});
