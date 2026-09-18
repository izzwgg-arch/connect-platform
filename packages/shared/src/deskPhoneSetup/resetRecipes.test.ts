import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GENERIC_RESET_RECIPE, RESET_RECIPES, resetRecipeFor, resetRecipeIsCertain } from "./resetRecipes";
import { VENDOR_CATALOG } from "./vendorCatalog.generated";

describe("resetRecipeFor — the person's factory-reset steps per model family", () => {
  it("a Yealink T-series (Izzy's T42S) is the PROVEN hold-OK recipe", () => {
    const r = resetRecipeFor("Yealink", "SIP-T42S");
    assert.equal(r.family, "yealink_t_series");
    assert.equal(r.confidence, "proven");
    assert.equal(r.holdSeconds, 10);
    assert.equal(r.illustration, "hold_ok");
    assert.ok(r.steps.some((s) => /Reset to factory settings\?/.test(s)));
  });

  it("a Yealink DECT base is NOT told to hold OK", () => {
    assert.equal(resetRecipeFor("yealink", "W60B").family, "yealink_dect_base");
    assert.equal(resetRecipeFor("yealink", "W70B").family, "yealink_dect_base");
    assert.equal(resetRecipeFor("yealink", null).family, "yealink_t_series", "no model → the maker's commonest family");
  });

  it("a Grandstream GXP2170 gets the menu path; an HT adapter gets the pinhole", () => {
    assert.equal(resetRecipeFor("Grandstream", "GXP2170").family, "grandstream_gxp_grp");
    assert.equal(resetRecipeFor("grandstream", "GRP2604").family, "grandstream_gxp_grp");
    assert.equal(resetRecipeFor("grandstream", "HT814").illustration, "pinhole");
  });

  it("an unknown maker or a vendor string we cannot place gets the generic card, never a wrong recipe", () => {
    assert.equal(resetRecipeFor(null, null), GENERIC_RESET_RECIPE);
    assert.equal(resetRecipeFor("Panasonic", "KX-HDV230"), GENERIC_RESET_RECIPE);
    assert.equal(resetRecipeFor("garbage", "x"), GENERIC_RESET_RECIPE);
  });

  it("every catalogue vendor resolves to SOME recipe and never throws", () => {
    for (const vendor of Object.keys(VENDOR_CATALOG)) {
      for (const m of (VENDOR_CATALOG as any)[vendor].models.slice(0, 40)) {
        const r = resetRecipeFor(vendor, m.model);
        assert.ok(r.steps.length >= 3, `${vendor} ${m.model}`);
      }
    }
  });

  it("⛔ honesty: only proven/documented recipes are 'certain'; every inferred recipe names its caveat", () => {
    for (const r of RESET_RECIPES) {
      if (r.confidence === "inferred") {
        assert.equal(resetRecipeIsCertain(r), false, r.family);
        assert.ok(r.ifItLooksDifferent.length > 20, r.family);
      }
      // A recipe that needs a password states the MAKER'S factory value, never something that looks customer-set.
      if (r.factoryPassword) assert.ok(/^(0000|456|123|admin)$/.test(r.factoryPassword), r.family);
      // The last step always tells the person the phone restarts by itself and they are done.
      assert.ok(/restarts on its own|restarts|takes over from here/i.test(r.steps[r.steps.length - 1]), r.family);
      // Customer words only: no technician vocabulary leaks onto the screen.
      for (const s of r.steps) assert.ok(!/provision|P\d{2,3}\b|LCD|firmware|SIP/i.test(s), `${r.family}: ${s}`);
    }
  });

  it("family ids are unique and every family has an illustration the library knows", () => {
    const ids = RESET_RECIPES.map((r) => r.family);
    assert.equal(new Set(ids).size, ids.length);
    for (const r of RESET_RECIPES) assert.ok(["hold_ok", "menu_path", "menu_password", "pinhole", "generic"].includes(r.illustration));
  });
});
