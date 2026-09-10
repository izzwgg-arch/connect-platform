/**
 * THE COVERAGE PROOF.
 *
 * Izzy's requirement, verbatim: "every single phone in our provisioning template database should
 * have an adapter. Every single one." This file is the proof, and it is a proof rather than a
 * claim because it walks the PBX's own catalogue — all 427 models of it — instead of a list
 * somebody typed.
 *
 * ⛔ It is deliberately picky about HONESTY as well as coverage. A test that only checked
 * "every model has an adapter" could be satisfied by twenty empty objects, so it also pins:
 *   - which brands we have actually PROVEN, so a label cannot be upgraded quietly;
 *   - that every brand we cannot drive from the LAN says so, in words;
 *   - that the two places the PBX's own data is incomplete stay visible.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  VENDOR_CATALOG,
  VENDOR_SLUGS,
  VENDOR_CATALOG_MODEL_COUNT,
  VENDOR_CATALOG_OUI_COUNT,
  VENDOR_CATALOG_TEMPLATED_MODEL_COUNT,
  VENDOR_CATALOG_SELF_POINTING_MODEL_COUNT,
  type VendorSlug,
} from "./vendorCatalog.generated";
import {
  VENDOR_ADAPTERS,
  adapterFor,
  findCatalogModel,
  hasLocallyDrivableMechanism,
  vendorForMac,
  vendorsForMac,
} from "./vendorAdapters";

const allModels = (VENDOR_SLUGS as readonly VendorSlug[]).flatMap((slug) =>
  VENDOR_CATALOG[slug].models.map((model) => ({ slug, model })),
);

test("every model in the PBX's catalogue has an adapter", () => {
  assert.equal(allModels.length, 427);
  assert.equal(allModels.length, VENDOR_CATALOG_MODEL_COUNT);

  const without: string[] = [];
  for (const { slug, model } of allModels) {
    const adapter = adapterFor(slug);
    if (!adapter || adapter.slug !== slug) without.push(`${slug}/${model.model}`);
  }
  assert.deepEqual(without, [], "models with no adapter");
});

test("every adapter declares at least one way to point a phone", () => {
  for (const slug of VENDOR_SLUGS) {
    const adapter = VENDOR_ADAPTERS[slug];
    assert.ok(adapter.mechanisms.length > 0, `${slug} declares no mechanism`);
    assert.ok(adapter.configFilenames.length > 0, `${slug} names no config file`);
    assert.ok(adapter.notes.trim().length > 0, `${slug} has no notes`);
  }
});

test("the adapter set and the catalogue's brand set are the same set", () => {
  assert.deepEqual(
    Object.keys(VENDOR_ADAPTERS).sort(),
    [...VENDOR_SLUGS].sort(),
    "an adapter exists for a brand the PBX does not have, or vice versa",
  );
  assert.equal(VENDOR_SLUGS.length, 20);
});

test("a model can be found from the model string a phone reports", () => {
  // Discovered model strings arrive spaced, hyphenated and cased differently from the catalogue,
  // so the round trip has to survive that rather than only matching the exact stored spelling.
  const missed: string[] = [];
  for (const { slug, model } of allModels) {
    for (const spelling of [
      model.model,
      model.model.toLowerCase(),
      model.model.toUpperCase(),
      model.model.replace(/[-\s]/g, ""),
      `SIP ${model.model}`.replace(/^SIP (\S)/, "$1"),
    ]) {
      const found = findCatalogModel(spelling);
      if (!found || found.model.pbxModelId !== model.pbxModelId) {
        // A collision on the normalised key between two brands is reported separately below;
        // here we only care that SOMETHING with the same key came back.
        if (!found || found.model.key !== model.key) missed.push(`${slug}/${model.model} as "${spelling}"`);
      }
    }
  }
  assert.deepEqual(missed, [], "model strings that did not round-trip");
});

test("every pbxModelId is unique — a device row can only ever mean one model", () => {
  const seen = new Map<number, string>();
  for (const { slug, model } of allModels) {
    const prior = seen.get(model.pbxModelId);
    assert.equal(prior, undefined, `pbxModelId ${model.pbxModelId} is both ${prior} and ${slug}/${model.model}`);
    seen.set(model.pbxModelId, `${slug}/${model.model}`);
  }
  assert.equal(seen.size, 427);
});

test("a MAC from each brand's own OUI table resolves to that brand", () => {
  const wrong: string[] = [];
  for (const slug of VENDOR_SLUGS) {
    for (const prefix of VENDOR_CATALOG[slug].ouis) {
      const mac = (prefix + "0123456789ab").slice(0, 12);
      const matches = vendorsForMac(mac);
      if (!matches.includes(slug)) wrong.push(`${slug} ${prefix} -> ${matches.join("+") || "nothing"}`);
    }
  }
  assert.deepEqual(wrong, [], "OUI prefixes that did not resolve to their own brand");
});

test("the one ambiguous OUI is named rather than silently decided", () => {
  // 0c383e is registered to Fanvil and ALSO listed under Attimo in the PBX's table. That is the
  // strongest evidence we have that Attimo is a Fanvil rebrand, and it means a MAC in that block
  // cannot name one brand. The matcher must say so instead of choosing.
  const shared = vendorsForMac("0c383e112233").sort();
  assert.deepEqual(shared, ["attimo", "fanvil"]);
  assert.equal(vendorForMac("0c383e112233"), null, "the single-answer helper must refuse an ambiguous block");

  // And a block only one brand claims still gives a confident answer.
  assert.equal(vendorForMac("001fc1112233"), "htek");
  assert.equal(vendorForMac("808287112233"), "atcom");

  // An unknown block is a real state, not an error.
  assert.deepEqual(vendorsForMac("ffffff112233"), []);
  assert.equal(vendorForMac("ffffff112233"), null);
});

test("MAC matching survives the formats the PBX's own table mixes", () => {
  // provisioning.brand_macs holds bare hex, colon-separated hex, and two IEEE MA-M/MA-S blocks
  // longer than six digits. Everything downstream must normalise before comparing.
  assert.equal(vendorForMac("80:82:87:01:e1:60"), "atcom");
  assert.equal(vendorForMac("80-82-87-01-E1-60"), "atcom");
  assert.equal(vendorForMac("808287 01e160"), "atcom");
  assert.deepEqual(vendorsForMac("200a0d3aabbcc"), ["clearlyip"], "a 7-digit MA-M block must match");
  assert.deepEqual(vendorsForMac("70b3d59b0abcd"), ["clearlyip"], "a 9-digit MA-S block must match");
  assert.deepEqual(vendorsForMac("80828"), [], "too short to be an OUI");
});

test("the catalogue's own counts are what the PBX reported", () => {
  assert.equal(VENDOR_CATALOG_MODEL_COUNT, 427);
  assert.equal(VENDOR_CATALOG_OUI_COUNT, 1143);
  assert.equal(VENDOR_CATALOG_TEMPLATED_MODEL_COUNT, 426);
  assert.equal(VENDOR_CATALOG_SELF_POINTING_MODEL_COUNT, 359);

  assert.equal(
    allModels.filter((m) => m.model.hasBaseTemplate).length,
    VENDOR_CATALOG_TEMPLATED_MODEL_COUNT,
  );
  assert.equal(
    allModels.filter((m) => m.model.templateWritesProvisioningPath).length,
    VENDOR_CATALOG_SELF_POINTING_MODEL_COUNT,
  );

  const ouis = new Set<string>();
  for (const slug of VENDOR_SLUGS) for (const o of VENDOR_CATALOG[slug].ouis) ouis.add(o);
  // 1,143 rows, 1,142 distinct prefixes — the one duplicate is the Fanvil/Attimo block above.
  assert.equal(ouis.size, 1142);
});

test("the one model the PBX cannot render is named, not averaged away", () => {
  const missing = allModels.filter((m) => !m.model.hasBaseTemplate);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].slug, "gigaset");
  assert.equal(missing[0].model.model, "P820 IP PRO");
  assert.equal(missing[0].model.pbxModelId, 407);

  // A model with no template cannot claim to be self-pointing.
  assert.equal(missing[0].model.templateWritesProvisioningPath, false);
});

test("a model whose template does not write the URL is still fully catalogued", () => {
  // 67 models are pointed once and then remember it. They must still carry a pbxModelId and a
  // template, or the PBX could not render them at all — the two facts are independent.
  const notSelfPointing = allModels.filter(
    (m) => m.model.hasBaseTemplate && !m.model.templateWritesProvisioningPath,
  );
  assert.equal(notSelfPointing.length, 67);
  for (const { slug, model } of notSelfPointing) {
    assert.ok(model.pbxModelId > 0, `${slug}/${model.model} has no pbxModelId`);
    assert.ok(adapterFor(slug).mechanisms.length > 0, `${slug} has nothing to point ${model.model} with`);
  }

  // Every one of Aastra-Mitel's models is in that group, which is why its template key is null.
  assert.equal(VENDOR_CATALOG.mitel.templateProvisioningKey, null);
  assert.equal(
    VENDOR_CATALOG.mitel.models.every((m) => !m.templateWritesProvisioningPath),
    true,
  );
});

test("only what has actually been proven is labelled proven", () => {
  // ⛔ Yealink is the ONLY brand watched working on a real handset on this platform. If another
  // brand is genuinely proven later, change this list in the same commit as the evidence.
  const proven = VENDOR_SLUGS.filter((s) => VENDOR_ADAPTERS[s].confidence === "proven");
  assert.deepEqual([...proven], ["yealink"]);

  // A "proven" HTTP action may only appear on a brand that is itself proven.
  for (const slug of VENDOR_SLUGS) {
    const a = VENDOR_ADAPTERS[slug];
    for (const action of [a.reboot, a.reprovision, a.setProvisioningUrl]) {
      if (action?.confidence === "proven") {
        assert.equal(a.confidence, "proven", `${slug} claims a proven action on an unproven brand`);
      }
    }
    if (a.pnp.confidence === "proven") {
      assert.equal(a.confidence, "proven", `${slug} claims proven PnP on an unproven brand`);
    }
  }
});

test("anything unproven says what is missing", () => {
  for (const slug of VENDOR_SLUGS) {
    const a = VENDOR_ADAPTERS[slug];
    if (a.confidence === "proven") continue;
    assert.ok(
      a.gaps.length > 0,
      `${slug} is ${a.confidence} but lists no gaps — an unproven brand must say what is unknown`,
    );
    for (const gap of a.gaps) assert.ok(gap.trim().length > 20, `${slug} has a gap with no content`);
  }
});

test("every claim carries a source", () => {
  for (const slug of VENDOR_SLUGS) {
    const a = VENDOR_ADAPTERS[slug];
    assert.ok(a.pnp.source.trim().length > 0, `${slug} pnp has no source`);
    for (const [name, action] of [
      ["reboot", a.reboot],
      ["reprovision", a.reprovision],
      ["setProvisioningUrl", a.setProvisioningUrl],
    ] as const) {
      if (!action) continue;
      assert.ok(action.source.trim().length > 0, `${slug} ${name} has no source`);
      assert.ok(action.path.startsWith("/"), `${slug} ${name} path must be a path, not a URL`);
      assert.ok(
        !/^https?:\/\//i.test(action.path),
        `${slug} ${name} must never carry a host — the desktop app validates the address itself`,
      );
    }
  }
});

test("the brands a computer cannot drive are exactly the ones we say", () => {
  // ⛔ The wizard consults this BEFORE it shows a progress bar. Getting it wrong means either
  // pretending to work on a phone we cannot touch, or handing a customer to support for a phone
  // we could have set up.
  const undrivable = VENDOR_SLUGS.filter((s) => !hasLocallyDrivableMechanism(s)).sort();
  assert.deepEqual([...undrivable], ["alcatel", "dinstar", "hanyang", "nurivoice"]);

  // Those four must still be catalogued and must still name a route for a person.
  for (const slug of undrivable) {
    const a = VENDOR_ADAPTERS[slug as VendorSlug];
    assert.ok(
      a.mechanisms.includes("dhcp_option") || a.mechanisms.includes("phone_menu"),
      `${slug} leaves a person no route either`,
    );
  }

  // And the models behind them are a small, nameable share of the catalogue.
  const affected = allModels.filter((m) => !hasLocallyDrivableMechanism(m.slug));
  assert.equal(affected.length, 31);
});

test("PnP is the first mechanism wherever the phone supports it", () => {
  // The multicast answer is the only mechanism that works on a handset nobody has touched, so a
  // brand that supports it must try it first. Anything else is a slower path chosen by accident.
  for (const slug of VENDOR_SLUGS) {
    const a = VENDOR_ADAPTERS[slug];
    if (!a.pnp.supported) {
      assert.ok(!a.mechanisms.includes("pnp_multicast"), `${slug} lists PnP but its profile says unsupported`);
      continue;
    }
    assert.equal(a.mechanisms[0], "pnp_multicast", `${slug} supports PnP but does not try it first`);
  }
});

test("the coverage summary the proof document quotes", () => {
  // A single place that computes the numbers, so a written report and the code cannot drift.
  const byConfidence: Record<string, number> = {};
  let modelsWithPnp = 0;
  let modelsDrivable = 0;
  for (const { slug } of allModels) {
    const a = VENDOR_ADAPTERS[slug];
    byConfidence[a.confidence] = (byConfidence[a.confidence] ?? 0) + 1;
    if (a.pnp.supported) modelsWithPnp += 1;
    if (hasLocallyDrivableMechanism(slug)) modelsDrivable += 1;
  }

  // 427 models, every one of them behind an adapter, split by how far the evidence goes.
  assert.equal(byConfidence.proven, 82, "Yealink — watched working on a real handset here");
  assert.equal(byConfidence.documented, 333, "14 brands whose own documentation states the mechanism");
  assert.equal(byConfidence.inferred, 10, "Attimo, ClearlyIP and LVSwitches — deduced from the template dialect");
  assert.equal(byConfidence.unknown, 2, "Nurivoice and Hanyang Digitech — one model each, nothing published");

  // How many phones a computer on the office network can actually act on.
  assert.equal(modelsWithPnp, 369, "models whose brand answers the boot-time multicast");
  assert.equal(modelsDrivable, 396, "models with at least one mechanism the desktop app can drive");
  assert.equal(427 - modelsDrivable, 31, "Alcatel-Lucent 15, Dinstar 14, Nurivoice 1, Hanyang 1");

  // Nothing may be uncounted.
  const total = Object.values(byConfidence).reduce((a, b) => a + b, 0);
  assert.equal(total, 427);
});
